import http from 'node:http';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import {
  MAX_VERSIONS,
  attachVersions,
  dropVersions,
  flatKeysToStore,
  mergeFlatIntoStore,
  num0,
  ownerOfKey,
  pruneVersions,
  splitVersions,
  str,
  sanitizeBenchmarks,
  sanitizeCards,
  sanitizeConstraints,
  sanitizeGacha,
  sanitizeVersions,
  storeToFlat,
  versionsCountMap,
} from './server-lib/schema.js';
import { applyPatches, applyPull, fingerprint, fnv, mergeForeignMeta, norm, orphanedBookRoots, parseFile, plan, renderBook } from './server-lib/obsidian.js';

// 服务端用到 Object.hasOwn / ||= / structuredClone 等能力，老版本 Node 上会以
// 一句看不懂的 SyntaxError 崩掉；双击 bat 的人是作者本人而不是开发者，先把话说清楚。
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 18) {
  console.error(`需要 Node.js 18 或更新版本（当前 ${process.versions.node}）。请到 https://nodejs.org 安装后再双击「启动拍案.bat」。`);
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4321;
// 数据目录：默认 ./data，可用环境变量 DATA_DIR 指到同步盘等任意位置
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const DIST_DIR = path.resolve(__dirname, 'dist');

const DEFAULTS = {
  'ideas.json': [],
  'projects.json': [],
  // 历史版本快照的侧车存储：正文与快照分文件，自动保存的热路径才不必反复重写快照全文
  'versions.json': {},
  'stats.json': { daily: {}, reflection: '' },
  'ai.json': { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', protocol: 'openai', apiKey: '', rules: [], memoryExtract: true, gateDraft: true, judgeOnly: false },
  'obsidian.json': { vaultPath: '', folder: '创作工作台' },
  // Obsidian 双向同步的祖先记录：每本书记「上次我方写入 / 库里确认的指纹」，
  // 靠它判断该推、该拉还是算冲突。删了这个文件最坏也只是下一趟多问一次，不会丢内容。
  'obsidian-sync.json': {},
  'chat.json': { sessions: [] },
  // 拆文对标：只存每章的节奏统计，原文留在作者自己的库里，避免把包体问题再买一遍
  'benchmarks.json': [],
  // 卡池抽卡：账本与用户自建卡（都很小，跟着自动保存一起落盘）
  'gacha.json': { pulls: 0, sincePity: 0, ink: 0, usedWords: 0, hand: [], bonusPulls: 0, owned: {}, applied: {}, lit: {} },
  'cards.json': { version: 1, custom: [], off: [] },
  // 通用偏好（点 X 行为等）：主进程读它决定关闭按钮的语义
  'app.json': { closeToTray: true },
};

// 请求体上限。中文正文 UTF-8 每字占 3 字节，整包保存按百万字长篇留出余量；
// 超限必须回 413 并带原因——曾经的做法是直接掐断连接，前端只能看到 "Failed to fetch"。
const MAX_BODY_MB = Number(process.env.WB_MAX_BODY_MB) || 96;
const MAX_BODY = MAX_BODY_MB * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  for (const [name, value] of Object.entries(DEFAULTS)) {
    const file = path.join(DATA_DIR, path.basename(name));
    if (!existsSync(file)) {
      await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf-8');
    }
  }
}

// 旧数据的快照一直埋在 projects.json 里；首次启动搬到 versions.json。
// 只在确实发现嵌入快照时才改写文件，且调用点在当日自动备份之后——备份就是回滚点。
async function migrateVersions() {
  const raw = await fs.readFile(resolveDataFile('projects.json'), 'utf-8').catch(() => null);
  if (!raw || !raw.includes('"versions"')) return;
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    return; // 解析失败自有 readJson 报警，不在这里重复处理
  }
  const { bare, store } = splitVersions(Array.isArray(list) ? list : []);
  if (!Object.keys(store).length) return;
  const sidecar = sanitizeVersions(await readJson('versions.json'));
  await writeJson('versions.json', { ...sanitizeVersions(store), ...sidecar });
  await writeJson('projects.json', bare);
  console.log(`历史版本快照已搬到 versions.json（${Object.keys(store).length} 部作品）`);
}

// 文件名只允许 DEFAULTS 中登记的白名单键，杜绝路径穿越
function resolveDataFile(name) {
  if (typeof name !== 'string' || !Object.hasOwn(DEFAULTS, name)) {
    throw new Error(`非法数据文件名: ${name}`);
  }
  const file = path.resolve(DATA_DIR, path.basename(name));
  if (file !== path.resolve(DATA_DIR) && !file.startsWith(path.resolve(DATA_DIR) + path.sep)) {
    throw new Error(`非法数据路径: ${name}`);
  }
  return file;
}

// 读盘异常先记下来，随首个响应带给界面（同一文件只报一次，不刷屏）
const dataWarnings = [];
const warnedFiles = new Set();

function noteDataProblem(name, msg) {
  if (warnedFiles.has(name)) return; // 同一进程只报一次，免得每个请求刷一条
  warnedFiles.add(name);
  console.error('数据异常：' + msg);
  dataWarnings.push(msg);
}

async function readJson(name) {
  const file = resolveDataFile(name);
  let text = null;
  for (let attempt = 0; ; attempt++) {
    try {
      text = await fs.readFile(file, 'utf-8');
      break;
    } catch (err) {
      // 文件不存在是正常初始状态（新数据目录还没落过盘）
      if (err.code === 'ENOENT') return structuredClone(DEFAULTS[name]);
      // 被杀软/同步盘临时占用时重试一次，仍失败才算异常
      if (attempt === 0 && (err.code === 'EBUSY' || err.code === 'EPERM')) {
        await new Promise((r) => setTimeout(r, 60));
        continue;
      }
      noteDataProblem(name, `读取 ${name} 失败（${err.code || err.message}），本次以空数据继续，请检查数据目录是否可访问`);
      return structuredClone(DEFAULTS[name]);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    // 解析失败＝文件被写坏或手工改坏了：先把原件复制一份留着，再退回默认值（绝不覆盖原件）
    if (!warnedFiles.has(name)) {
      const kept = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
      await fs.copyFile(file, kept).catch(() => {});
      noteDataProblem(name, `${name} 不是合法 JSON，原件已另存为 ${path.basename(kept)}（可从「设置 → 从备份恢复」找回）`);
    }
    return structuredClone(DEFAULTS[name]);
  }
}

// 同一文件的写入串行排队：Ctrl+S 撞上在飞的自动保存、或两个窗口同时写，
// 都可能让两次 writeFile 交错。临时文件名带序号，改名前互不影响。
const writeQueue = new Map();
let tmpSeq = 0;

function writeJson(name, value) {
  const file = resolveDataFile(name);
  const prev = writeQueue.get(file) || Promise.resolve();
  const next = prev.then(() => writeAtomic(file, value), () => writeAtomic(file, value));
  writeQueue.set(file, next);
  next.then(() => {
    if (writeQueue.get(file) === next) writeQueue.delete(file);
  });
  return next;
}

async function writeAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

function tooLargeBody(bytes) {
  return new Error(
    `本次数据约 ${(bytes / 1048576).toFixed(1)} MB，超过 ${(MAX_BODY_MB).toFixed(0)} MB 上限。` +
      '请到「设置 → 导出全部数据备份」留档，再删掉不要的作品或历史版本。',
  );
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // 分块传输没有 Content-Length 时走这里：只记账，响应交给外层统一发
        const err = tooLargeBody(size);
        err.status = 413;
        chunks.length = 0;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'));
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ---------- 历史版本快照的侧车存储 ----------

// versions.json 可以涨到几十 MB：解析结果按 mtime 缓存在进程里。写入都经过本机服务，
// 缓存随写更新；万一有别的进程改了文件，mtime 对不上会重新读。
let versionsCache = { mtime: -1, store: {} };
async function versionsMtime() {
  try {
    return (await fs.stat(path.join(DATA_DIR, 'versions.json'))).mtimeMs;
  } catch {
    return -1;
  }
}
async function getVersionsStore() {
  const m = await versionsMtime();
  if (m !== versionsCache.mtime) versionsCache = { mtime: m, store: sanitizeVersions(await readJson('versions.json')) };
  return versionsCache.store;
}
async function putVersionsStore(store) {
  const clean = sanitizeVersions(store);
  await writeJson('versions.json', clean);
  versionsCache = { mtime: await versionsMtime(), store: clean };
  return clean;
}


function extractUpstreamError(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message || parsed?.message || text.slice(0, 300);
  } catch {
    return text.slice(0, 300) || '上游服务无响应内容';
  }
}

function aiChatUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, '') + '/chat/completions';
}

// ---------- AI 协议适配 ----------
// openai：标准 /chat/completions（绝大多数云厂商与本地推理服务）
// anthropic：Claude 原生 /v1/messages（Anthropic 官方、百度千帆与 MiniMax 的 Anthropic 通道、one-api 等）
// ollama：对话走 OpenAI 兼容层，模型列表回退原生 /api/tags
function resolveProtocol(ai) {
  if (ai.protocol === 'anthropic' || ai.protocol === 'ollama' || ai.protocol === 'openai') return ai.protocol;
  const base = String(ai.baseUrl || '').toLowerCase();
  if (base.includes('anthropic')) return 'anthropic';
  if (base.includes(':11434')) return 'ollama';
  return 'openai';
}

function anthropicHeaders(ai) {
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (ai.apiKey) headers['x-api-key'] = ai.apiKey;
  return headers;
}

// OpenAI messages → Anthropic system + messages（system 并入顶层字段，且首条必须是 user）
function toAnthropicBody(ai, messages, stream, temperature, maxTokens) {
  const systemParts = [];
  const rest = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m.content !== 'string' || !m.content.trim()) continue;
    if (m.role === 'system') systemParts.push(m.content.trim());
    else if (m.role === 'user' || m.role === 'assistant') rest.push({ role: m.role, content: m.content });
  }
  while (rest.length && rest[0].role !== 'user') rest.shift();
  const body = { model: ai.model, max_tokens: maxTokens || 4096, messages: rest, stream: Boolean(stream) };
  if (systemParts.length) {
    const fullSystem = systemParts.join('\n\n');
    // 当 System Prompt 较长（通常超过约 800 字符/1024 Token 阈值）时，自动打上 Ephemeral Cache 标记
    if (fullSystem.length >= 800) {
      body.system = [
        {
          type: 'text',
          text: fullSystem,
          cache_control: { type: 'ephemeral' },
        },
      ];
    } else {
      body.system = fullSystem;
    }
  }
  if (typeof temperature === 'number') body.temperature = temperature;
  return body;
}

// 把 Anthropic 的 SSE 事件流转成前端已支持的 OpenAI delta 格式
async function pipeAnthropicAsOpenAI(upstream, res, controller) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const decoder = new TextDecoder();
  let buf = '';
  let stopped = false;
  // 记录 Anthropic 用量，流结束时合成一条 OpenAI 形状的 usage 块（前端据此显示缓存命中率）
  let sawStart = false;
  let aIn = 0;
  let aCr = 0; // cache_read_input_tokens：命中缓存的输入
  let aCc = 0; // cache_creation_input_tokens：写入缓存的输入
  let aOut = 0;
  const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || stopped || controller.signal.aborted) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0 && !stopped) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let ev;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          write({ choices: [{ delta: { content: ev.delta.text } }] });
        } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
          // 兼容 Claude 3.7 Thinking 思考流
          write({ choices: [{ delta: { content: ev.delta.thinking } }] });
        } else if (ev.type === 'message_start' && ev.message?.usage) {
          sawStart = true;
          aIn = ev.message.usage.input_tokens || 0;
          aCr = ev.message.usage.cache_read_input_tokens || 0;
          aCc = ev.message.usage.cache_creation_input_tokens || 0;
        } else if (ev.type === 'message_delta' && ev.usage?.output_tokens) {
          aOut = ev.usage.output_tokens;
        } else if (ev.type === 'error') {
          write({ choices: [{ delta: { content: `\n\n[上游错误] ${ev.error?.message || '未知错误'}` } }] });
        } else if (ev.type === 'message_stop') {
          stopped = true;
        }
      }
    }
  } catch {
    // 客户端中止或上游断开：直接收尾
  } finally {
    reader.releaseLock?.();
  }
  if (sawStart) {
    write({ choices: [], usage: { prompt_tokens: aIn + aCr + aCc, prompt_cache_hit_tokens: aCr, completion_tokens: aOut } });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

// ========== Ollama 原生协议（qwen3 等 thinking 模型适配）==========
// Ollama 的 OpenAI 兼容层会忽略 think 参数，导致 qwen3 默认开启思考：
// token 全耗在推理上（实测同任务慢 ~30 倍）。改走原生 /api/chat 并显式 think:false。
function ollamaNativeChatUrl(baseUrl) {
  try {
    return new URL(baseUrl).origin + '/api/chat';
  } catch {
    return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') + '/api/chat';
  }
}
// Ollama 原生 SSE（逐块 {message:{content}}）→ OpenAI 形状（choices[].delta.content），流尾合成 usage
async function pipeOllamaAsOpenAI(upstream, res, controller) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const decoder = new TextDecoder();
  let buf = '';
  let stopped = false;
  let pIn = 0;
  let pOut = 0;
  const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || stopped || controller.signal.aborted) break;
      buf += decoder.decode(value, { stream: true });
      // SSE 行分隔兼容 \n / \r\n / \r（Ollama Windows 版原生流用 \r 分帧）
      let cut = -1;
      for (let ci = 0; ci < buf.length; ci++) {
        if (buf[ci] === '\n' || buf[ci] === '\r') { cut = ci; break; }
      }
      while (cut >= 0 && !stopped) {
        const line = buf.slice(0, cut).trim();
        buf = buf.slice(cut + 1);
        cut = -1;
        for (let ci = 0; ci < buf.length; ci++) {
          if (buf[ci] === '\n' || buf[ci] === '\r') { cut = ci; break; }
        }
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.error) {
          write({ choices: [{ delta: { content: `\n\n[上游错误] ${typeof ev.error === 'string' ? ev.error : ev.error?.message || '未知错误'}` } }] });
        } else if (ev.done) {
          if (typeof ev.prompt_eval_count === 'number') pIn = ev.prompt_eval_count;
          if (typeof ev.eval_count === 'number') pOut = ev.eval_count;
          stopped = true;
        } else if (ev.message?.content) {
          write({ choices: [{ delta: { content: ev.message.content } }] });
        }
      }
    }
  } catch {
    // 客户端中止或上游断开：直接收尾
  } finally {
    reader.releaseLock?.();
  }
  if (pIn || pOut) {
    write({ choices: [], usage: { prompt_tokens: pIn, prompt_cache_hit_tokens: 0, completion_tokens: pOut } });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}


// ---------- Obsidian 知识库 ----------
// 任何对库内文件的访问都必须落在这个边界之内
function resolveInsideVault(cfg, rel) {
  const root = path.resolve(cfg.vaultPath);
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

function sanitizeFolder(folder) {
  return String(folder || '')
    .split(/[\\/]+/)
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/');
}

async function listVaultNotes(cfg, query) {
  const root = path.resolve(cfg.vaultPath);
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  const q = query.toLowerCase();
  const rels = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const dir = entry.parentPath ?? entry.path ?? root;
    const rel = path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/');
    if (rel.split('/').some((seg) => seg.startsWith('.'))) continue; // 跳过 .obsidian 等隐藏目录
    if (q && !entry.name.toLowerCase().includes(q)) continue;
    rels.push(rel);
  }
  // 截断之前先按路径把「大概是我方导出」的排到最后：mtime 最新的一批正是刚同步出去的镜像，
  // 若按 readdir 顺序截，它们会把真素材挤出窗口。判身份仍然只认 wb-id，不靠路径猜。
  const pre = sanitizeFolder(cfg.folder);
  const mine = (rel) => (pre && rel.startsWith(pre + '/') ? 1 : 0);
  rels.sort((a, b) => mine(a) - mine(b) || a.localeCompare(b, 'zh-Hans-CN'));
  const picked = rels.slice(0, VAULT_SCAN_CAP);
  const warning =
    rels.length > VAULT_SCAN_CAP
      ? `库里匹配到 ${rels.length} 篇，只扫前 ${VAULT_SCAN_CAP} 篇（再缩小一下搜索词）`
      : '';
  const notes = await Promise.all(
    picked.map(async (rel) => {
      const st = await fs.stat(path.join(root, rel));
      return { path: rel, name: path.basename(rel), mtime: st.mtimeMs, bytes: st.size, wb: await isSyncArtifact(path.join(root, rel)) };
    }),
  );
  // 工作台自己同步出去的文件是镜像，不是素材：它们刚被写盘、mtime 最新，
  // 不沉下去就会顶在列表最前面，看着像「刚写的笔记」，导入回去其实是在复制自己的导出
  notes.sort((a, b) => Number(a.wb) - Number(b.wb) || b.mtime - a.mtime);
  return { notes: notes.slice(0, 200), warning };
}

/** 读文件头几 KB 认属性区：带 wb-id 的就是我方同步产物 */
async function isSyncArtifact(file, cap = 8192) {
  let fh = null;
  try {
    fh = await fs.open(file, 'r');
    const buf = Buffer.alloc(cap);
    const { bytesRead } = await fh.read(buf, 0, cap, 0);
    return /^wb-id[ \t]*:/m.test(buf.toString('utf-8', 0, bytesRead));
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

// ---------- Obsidian 双向同步 ----------
// 一物一文件：书名做目录，章节 / 人物卡 / 设定卡各一个文件，外加一张索引页。
// 判定逻辑全在 server-lib/obsidian.js（纯函数、可断言），这里只做磁盘读写。

const VAULT_FILE_CAP = 4000; // 一本书最多读这么多文件，异常目录不该拖死请求
const VAULT_SCAN_CAP = 800; // 导入列表一次最多扫这么多匹配文件
const NOTE_READ_CAP = 4 * 1024 * 1024; // 单篇笔记超过 4MB 不整篇读进内存

/** 读库里某本书目录下的全部 .md：相对 vault 根的路径 → 内容 */
async function readBookTree(cfg, rootRel) {
  const out = {};
  const base = resolveInsideVault(cfg, rootRel);
  if (!base) throw new Error('同步路径越界');
  const st = await fs.stat(base).catch(() => null);
  if (!st || !st.isDirectory()) return out;
  const stack = [base];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue; // .obsidian 等
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!e.name.toLowerCase().endsWith('.md')) continue;
      const s = await fs.stat(full).catch(() => null);
      if (!s || s.size > 2 * 1024 * 1024) continue;
      const rel = path.relative(path.resolve(cfg.vaultPath), full).split(path.sep).join('/');
      out[rel] = await fs.readFile(full, 'utf-8');
      if (Object.keys(out).length >= VAULT_FILE_CAP) return out;
    }
  }
  return out;
}

async function writeVaultFile(cfg, rel, text) {
  const target = resolveInsideVault(cfg, rel);
  if (!target) throw new Error('同步路径越界');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text, 'utf-8');
}

/**
 * 回收一本书在库里的整棵镜像（彻底删除该书时用）：
 * 只删带我方 wb 标记的文件，别人的笔记一个字节不碰；
 * 删完自底向上把空目录也收掉——目录里还有别人的东西时 rmdir 失败，留着就是了。
 * 返回删掉的文件数。
 */
async function purgeVaultBook(cfg, bookRoot) {
  const pre = sanitizeFolder(cfg.folder);
  const top = resolveInsideVault(cfg, pre ? `${pre}/${bookRoot}` : bookRoot);
  if (!top) throw new Error('同步路径越界');
  let removed = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录本来就不在：视为已回收
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
        await fs.rmdir(full).catch(() => {}); // 非空说明还有别人的文件，留着
        continue;
      }
      if (!e.name.toLowerCase().endsWith('.md')) continue;
      const text = await fs.readFile(full, 'utf-8').catch(() => '');
      if (!parseFile(text).wb) continue;
      await fs.rm(full, { force: true });
      removed += 1;
    }
  }
  await walk(top);
  await fs.rmdir(top).catch(() => {});
  return removed;
}

/**
 * 一本书的一次双向同步。resolve 是人工判定结果 { 路径: 'app' | 'vault' }：
 * 冲突项没判定就既不动文件也不动数据，下次再来还是冲突——绝不静默偏向任何一边。
 */
async function syncBook(cfg, project, ideas, resolve = {}) {
  const first = renderBook(project, ideas);
  // 纯函数层只认「书名/…」，库里还要套一层设置里的子文件夹，前缀在这里接上。
  // 状态表与判定都用书名相对路径，改文件夹设置不会让已同步的记录失效。
  const pre = sanitizeFolder(cfg.folder);
  const wrap = (rel) => (pre ? `${pre}/${rel}` : rel);
  const unwrap = (rel) => (pre && rel.startsWith(pre + '/') ? rel.slice(pre.length + 1) : pre ? null : rel);
  const diskFull = await readBookTree(cfg, wrap(first.root));
  const disk = {};
  for (const [rel, text] of Object.entries(diskFull)) {
    const key = unwrap(rel);
    if (key) disk[key] = text;
  }
  // 库里已有的批注按实体 id 收集，重新渲染时贴回文件末尾（章节改名也不会丢批注）
  const notesById = {};
  for (const text of Object.values(disk)) {
    const parsed = parseFile(text);
    if (parsed.wb && parsed.notes.trim()) notesById[parsed.meta['wb-id']] = parsed.notes;
  }
  const rendered = Object.keys(notesById).length ? renderBook(project, ideas, notesById) : first;

  const store = await readJson('obsidian-sync.json');
  const prev = store[first.root]?.files ?? {};
  const plan0 = plan({ rendered: rendered.files, disk, state: prev });

  const pushed = [];
  const pulled = [];
  const conflicts = [];
  const pruned = [];
  const next = plan0.next;

  for (const rel of plan0.push) {
    // 推的时候保住他在库里加的其它属性：我们只负责自己那几个键
    await writeVaultFile(cfg, wrap(rel), mergeForeignMeta(rendered.files[rel].text, disk[rel]));
    pushed.push(rel);
  }
  for (const rel of plan0.prune) {
    const target = resolveInsideVault(cfg, wrap(rel));
    if (target) await fs.rm(target, { force: true });
    pruned.push(rel);
    delete next[rel];
  }

  const pullList = [...plan0.pull];
  for (const c of plan0.conflict) {
    const side = resolve[c.rel];
    if (side === 'app') {
      await writeVaultFile(cfg, wrap(c.rel), mergeForeignMeta(rendered.files[c.rel].text, disk[c.rel]));
      pushed.push(c.rel);
      next[c.rel] = { id: c.id, kind: c.kind, v: 2, hash: fingerprint(rendered.files[c.rel].text) };
    } else if (side === 'vault' && disk[c.rel] !== undefined) {
      const parsed = parseFile(disk[c.rel]);
      pullList.push({ rel: c.rel, id: parsed.meta['wb-id'] ?? c.id, kind: parsed.meta['wb-kind'] ?? c.kind, prose: parsed.prose, notes: parsed.notes });
      next[c.rel] = { id: c.id, kind: c.kind, v: 2, hash: fingerprint(disk[c.rel]) };
    } else {
      conflicts.push({ rel: c.rel, id: c.id, kind: c.kind, ours: norm(c.ours).slice(0, 500), theirs: norm(c.theirs).slice(0, 500) });
    }
  }
  for (const p of plan0.pull) next[p.rel] = { ...(next[p.rel] ?? {}), id: p.id, kind: p.kind, v: 2, hash: fingerprint(disk[p.rel]) };

  const { patches, skipped } = applyPull(pullList);
  const nextProject = patches.length ? applyPatches(project, patches) : null;
  for (const p of pullList) pulled.push(p.rel);

  // 祖先表只在真的有事可记时才重写：自动同步开着时空转那一趟每 12 秒来一回，
  // 什么都不挪就不该为「记一个时间戳」把几十 KB 的状态表重写一遍（syncedAt 因此是「上一次真的动了」）
  const canon = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
  const prevEntry = store[first.root];
  if (!prevEntry || canon(prevEntry.files ?? {}) !== canon(next)) {
    store[first.root] = { files: next, book: project.title, projectId: project.id, syncedAt: new Date().toISOString() };
    await writeJson('obsidian-sync.json', store);
  }
  return { root: first.root, pushed, pulled, conflicts, pruned, skipped, nextProject };
}


async function handleObsidianApi(req, res, pathname) {
  const cfg = await readJson('obsidian.json');

  if (req.method === 'PUT' && pathname === '/api/obsidian/config') {
    const body = await readBody(req);
    const vaultPath = typeof body.vaultPath === 'string' ? body.vaultPath.trim() : '';
    const folder = sanitizeFolder(typeof body.folder === 'string' ? body.folder : cfg.folder);
    if (!vaultPath) return sendJson(res, 400, { error: '库路径不能为空' });
    const st = await fs.stat(vaultPath).catch(() => null);
    if (!st || !st.isDirectory()) return sendJson(res, 400, { error: `目录不存在：${vaultPath}` });
    cfg.vaultPath = path.resolve(vaultPath);
    cfg.folder = folder;
    cfg.autoSync = body.autoSync === true; // 只认严格的 true：缺字段、字符串、1 都算关
    await writeJson('obsidian.json', cfg);
    return sendJson(res, 200, { ok: true, obsidian: cfg });
  }

  if (req.method === 'GET' && pathname === '/api/obsidian/status') {
    // 这里刻意不扫库：status 会被设置页轮询，而整库 readdir + 逐篇 stat 只服务一个没人读的计数。
    const store = await readJson('obsidian-sync.json');
    const books = Object.entries(store).map(([root, v]) => ({
      root,
      book: v?.book ?? root,
      projectId: v?.projectId ?? '',
      syncedAt: v?.syncedAt ?? '',
      files: Object.keys(v?.files ?? {}).length,
    }));
    return sendJson(res, 200, { configured: Boolean(cfg.vaultPath), obsidian: cfg, books });
  }

  if (!cfg.vaultPath) {
    return sendJson(res, 400, { error: '尚未配置 Obsidian 库路径，请到「设置」填写' });
  }

  if (req.method === 'GET' && pathname === '/api/obsidian/notes') {
    const q = new URL(req.url, 'http://localhost').searchParams.get('q') || '';
    try {
      const { notes, warning } = await listVaultNotes(cfg, q);
      return sendJson(res, 200, { notes, warning });
    } catch (err) {
      return sendJson(res, 500, { error: `读取库失败：${err?.message || err}` });
    }
  }

  if (req.method === 'GET' && pathname === '/api/obsidian/note') {
    const rel = new URL(req.url, 'http://localhost').searchParams.get('path') || '';
    if (!rel.toLowerCase().endsWith('.md')) {
      return sendJson(res, 400, { error: '只能读取 Markdown 笔记' });
    }
    const target = resolveInsideVault(cfg, rel);
    if (!target) return sendJson(res, 403, { error: '路径越界' });
    try {
      const st = await fs.stat(target);
      if (st.size > NOTE_READ_CAP) {
        return sendJson(res, 413, { error: `这篇有 ${(st.size / 1048576).toFixed(1)}MB，超过单篇 ${(NOTE_READ_CAP / 1048576).toFixed(0)}MB 上限，不整篇读进来` });
      }
      return sendJson(res, 200, { content: await fs.readFile(target, 'utf-8'), bytes: st.size, wb: await isSyncArtifact(target) });
    } catch {
      return sendJson(res, 404, { error: '笔记不存在' });
    }
  }

  if (req.method === 'POST' && pathname === '/api/obsidian/sync') {
    const body = await readBody(req);
    const projects = await readJson('projects.json');
    const project = projects.find((p) => p.id === body.projectId);
    if (!project) return sendJson(res, 400, { error: '项目不存在' });
    try {
      const ideas = await readJson('ideas.json');
      const r = await syncBook(cfg, project, ideas, body.resolve && typeof body.resolve === 'object' ? body.resolve : {});
      // 拉回来的改动不在这儿写 projects.json：交回给界面走它自己的保存路径，
      // 免得服务端和 800ms 防抖自动保存抢同一个文件。
      return sendJson(res, 200, { ok: true, ...r });
    } catch (err) {
      return sendJson(res, 400, { error: err?.message || '同步失败' });
    }
  }

  if (req.method === 'POST' && pathname === '/api/obsidian/sync-all') {
    const projects = (await readJson('projects.json')).filter((p) => !p.deletedAt);
    const ideas = await readJson('ideas.json');
    const now = new Date().toISOString();
    const books = [];
    const errors = [];
    let pushed = 0;
    let pulled = 0;
    let conflicts = 0;
    for (const p of projects) {
      try {
        const r = await syncBook(cfg, p, ideas, {});
        pushed += r.pushed.length;
        pulled += r.pulled.length;
        conflicts += r.conflicts.length;
        books.push({ projectId: p.id, title: p.title, root: r.root, pushed: r.pushed.length, pulled: r.pulled.length, conflicts: r.conflicts, nextProject: r.nextProject });
      } catch (err) {
        errors.push(`${p.title || '未命名'}：${err?.message || err}`);
      }
    }
    return sendJson(res, 200, { ok: errors.length === 0, count: books.length, pushed, pulled, conflicts, books, errors });
  }

  // 彻底删除一本书时回收它在库里的镜像。root 一律用状态表/状态接口里给的那个
  // （slug 后书名），不含路径分隔符——越界企图直接挡掉，这是删文件的接口，必须白名单式地收。
  if (req.method === 'POST' && pathname === '/api/obsidian/purge-book') {
    const body = await readBody(req);
    const root = typeof body.root === 'string' ? body.root.trim() : '';
    if (!root || /[\\/]/.test(root)) return sendJson(res, 400, { error: 'root 必须是不含路径分隔符的书名目录' });
    if (!cfg.vaultPath) return sendJson(res, 400, { error: '还没配置 Obsidian 库路径' });
    try {
      const removed = await purgeVaultBook(cfg, root);
      const store = await readJson('obsidian-sync.json');
      delete store[root];
      await writeJson('obsidian-sync.json', store);
      return sendJson(res, 200, { ok: true, removed });
    } catch (err) {
      return sendJson(res, 400, { error: err?.message || '回收失败' });
    }
  }

  sendJson(res, 404, { error: '接口不存在' });
}

async function handleAiChat(req, res, body) {
  const ai = await readJson('ai.json');
  // 本地服务（如 Ollama）无需 API Key，只要求地址与模型已配置
  if (!ai.baseUrl || !ai.model) {
    sendJson(res, 400, { error: '尚未配置 AI 接口，请到「设置」完成配置' });
    return;
  }
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    sendJson(res, 400, { error: 'messages 不能为空' });
    return;
  }

  const controller = new AbortController();
  req.on('close', () => controller.abort());
  const proto = resolveProtocol(ai);
  let upstream;
  try {
    if (proto === 'anthropic') {
      upstream = await fetch(ai.baseUrl.replace(/\/+$/, '') + '/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: anthropicHeaders(ai),
        body: JSON.stringify(toAnthropicBody(ai, messages, true, body?.temperature)),
      });
    } else if (proto === 'ollama') {
      // 原生协议：think:false 关掉 qwen3 的思考模式，正文直接生成，快 ~30 倍
      const payload = { model: ai.model, messages, stream: true, think: false };
      if (typeof body?.temperature === 'number') payload.options = { temperature: body.temperature };
      upstream = await fetch(ollamaNativeChatUrl(ai.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      const headers = { 'Content-Type': 'application/json' };
      if (ai.apiKey) headers.Authorization = `Bearer ${ai.apiKey}`;
      // 请求用量统计（含缓存命中 tokens）；个别兼容端点不认识该参数会 400，此时去掉重试一次
      const payload = { model: ai.model, messages, stream: true, stream_options: { include_usage: true } };
      if (typeof body?.temperature === 'number') payload.temperature = body.temperature;
      const doFetch = () =>
        fetch(aiChatUrl(ai.baseUrl), {
          method: 'POST',
          signal: controller.signal,
          headers,
          body: JSON.stringify(payload),
        });
      upstream = await doFetch();
      if (!upstream.ok && upstream.status === 400) {
        delete payload.stream_options;
        upstream = await doFetch();
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      sendJson(res, 502, { error: `无法连接 ${ai.baseUrl}：${err?.message || err}` });
    }
    return;
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    sendJson(res, upstream.status, { error: extractUpstreamError(text) });
    return;
  }

  if (proto === 'anthropic') {
    await pipeAnthropicAsOpenAI(upstream, res, controller);
    return;
  }
  if (proto === 'ollama') {
    await pipeOllamaAsOpenAI(upstream, res, controller);
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  Readable.fromWeb(upstream.body)
    .on('error', () => res.end()) // 客户端中止或上游中断时直接收尾
    .pipe(res);
}

// 非流式文本通道：整段请求、整段返回（供记忆抽取等需要稳定 JSON 的结构化任务用）。
async function askUpstreamText(messages, temperature) {
  const ai = await readJson('ai.json');
  if (!ai.baseUrl || !ai.model) throw Object.assign(new Error('尚未配置 AI 接口，请到「设置」完成配置'), { status: 400 });
  const proto = resolveProtocol(ai);
  let upstream;
  try {
    if (proto === 'anthropic') {
      upstream = await fetch(ai.baseUrl.replace(/\/+$/, '') + '/messages', {
        method: 'POST',
        headers: anthropicHeaders(ai),
        body: JSON.stringify(toAnthropicBody(ai, messages, false, temperature)),
      });
    } else if (proto === 'ollama') {
      const payload = { model: ai.model, messages, stream: false, think: false };
      if (typeof temperature === 'number') payload.options = { temperature };
      upstream = await fetch(ollamaNativeChatUrl(ai.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      const headers = { 'Content-Type': 'application/json' };
      if (ai.apiKey) headers.Authorization = `Bearer ${ai.apiKey}`;
      const payload = { model: ai.model, messages, stream: false };
      if (typeof temperature === 'number') payload.temperature = temperature;
      upstream = await fetch(aiChatUrl(ai.baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
    }
  } catch (err) {
    throw Object.assign(new Error(`无法连接 ${ai.baseUrl}：${err?.message || err}`), { status: 502 });
  }
  const text = await upstream.text().catch(() => '');
  if (!upstream.ok) throw Object.assign(new Error(extractUpstreamError(text)), { status: upstream.status });
  try {
    const json = JSON.parse(text);
    if (proto === 'anthropic') return json?.content?.[0]?.text ?? '';
    if (proto === 'ollama') return json?.message?.content ?? '';
    return json?.choices?.[0]?.message?.content ?? '';
  } catch {
    throw Object.assign(new Error('上游返回了无法解析的内容'), { status: 502 });
  }
}

// 整包保存模型唯一的真实丢数据路径：开着两个标签页（或两个窗口），从较旧状态出发的那次
// 写入会静默盖掉较新的内容。桌面版有单实例锁，网页模式没有——这里做一次廉价识别：
// 只比内存里「上次写入的最大 updatedAt」，不额外读盘，命中时在响应里带 stale 让界面提醒。
let lastProjectsStamp = '';
let lastSeenIds = []; // 上次整包写入的作品 id 集合：回收站「永久删除」会让时间戳倒退（删的书常带最新 updatedAt），这种只减不增是故意的
const maxUpdatedAt = (projects) =>
  (Array.isArray(projects) ? projects : []).reduce((m, p) => (p && typeof p.updatedAt === 'string' && p.updatedAt > m ? p.updatedAt : m), '');

// 本机接口只给这台机器上的工作台自己用。绑 127.0.0.1 挡住了局域网，但挡不住浏览器：
// 任何网页都能对你的 127.0.0.1 发「简单请求」，那正好绕过 CORS 预检——实测带
// Origin: http://evil.example 的 text/plain PUT /api/data 会直接落库，跨站写之外还能把
// /api/ai/chat 当免费代理烧你的 token。所以同源要自己认：
//   Host 必须是我们自己（顺手把 DNS rebinding 也堵住，否则连响应都读得走）；
//   带 Origin 就必须同源（浏览器对非 GET 一律附 Origin，表单提交也附）；
//   带请求体就必须是 application/json（这个类型跨源必经预检，而预检在这儿拿不到放行）。
const LOCAL_HOST_RE = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
const LOCAL_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

function localOnly(req) {
  if (!LOCAL_HOST_RE.test(String(req.headers.host || '').trim())) {
    return { status: 403, reason: '只能按 127.0.0.1 或 localhost 访问本机接口' };
  }
  const origin = req.headers.origin;
  if (origin && !LOCAL_ORIGIN_RE.test(String(origin))) {
    return { status: 403, reason: '不允许跨源调用本机接口' };
  }
  const hasBody = Number(req.headers['content-length']) > 0 || String(req.headers['transfer-encoding'] || '').toLowerCase().includes('chunked');
  if (hasBody && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
    return { status: 415, reason: '请求体必须声明 application/json' };
  }
  return null;
}

async function handleApi(req, res, pathname) {
  const gate = localOnly(req);
  if (gate) {
    sendJson(res, gate.status, { error: gate.reason });
    req.resume(); // 被拒的请求体也得排空，否则客户端只看见连接被掐
    return;
  }

  if (pathname.startsWith('/api/obsidian/')) {
    await handleObsidianApi(req, res, pathname);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/data') {
    const [ideas, projectsRaw, stats, ai, obsidian, gacha, cards] = await Promise.all([
      readJson('ideas.json'),
      readJson('projects.json'),
      readJson('stats.json'),
      readJson('ai.json'),
      readJson('obsidian.json'),
      readJson('gacha.json'),
      readJson('cards.json'),
    ]);
    sendJson(res, 200, {
      ideas,
      projects: dropVersions(projectsRaw),
      // 快照不进首屏：只回每条 key 有几份，正文按需读（GET /api/versions）
      versionCounts: versionsCountMap(await getVersionsStore()),
      stats,
      gacha: sanitizeGacha(gacha),
      cards: sanitizeCards(cards),
      dataDir: DATA_DIR,
      warnings: dataWarnings.slice(),
      ai: { provider: ai.provider, baseUrl: ai.baseUrl, model: ai.model, protocol: resolveProtocol(ai), hasKey: Boolean(ai.apiKey), ready: Boolean(ai.baseUrl && ai.model), rules: ai.rules ?? [], memoryExtract: ai.memoryExtract !== false, gateDraft: ai.gateDraft !== false, judgeOnly: ai.judgeOnly === true },
      obsidian,
    });
    return;
  }

  if (req.method === 'PUT' && pathname === '/api/data') {
    const body = await readBody(req);
    let stale = false;
    if (body.ideas !== undefined) {
      if (!Array.isArray(body.ideas)) return sendJson(res, 400, { error: 'ideas 必须是数组' });
      await writeJson('ideas.json', body.ideas);
    }
    if (body.projects !== undefined) {
      if (!Array.isArray(body.projects)) return sendJson(res, 400, { error: 'projects 必须是数组' });
      const incoming = maxUpdatedAt(body.projects);
      const incomingIds = (Array.isArray(body.projects) ? body.projects : []).map((x) => x?.id).filter(Boolean);
      // id 集合只减不增 = 永久删除的故意写入，不算被盖写
      const purgeOnly = lastSeenIds.length > 0 && incomingIds.length < lastSeenIds.length && incomingIds.every((id) => lastSeenIds.includes(id));
      stale = Boolean(lastProjectsStamp && incoming && incoming < lastProjectsStamp && !purgeOnly);
      if (stale) console.warn(`检测到较旧的整包写入（${incoming} < 上次的 ${lastProjectsStamp}）：可能是另一个标签页盖掉了新改动`);
      // 快照不进 projects.json：正常客户端已在发送前剥掉，这里兜住直接整包 PUT 的调用方
      const { bare, store } = splitVersions(body.projects);
      await writeJson('projects.json', bare);
      const current = await getVersionsStore();
      const merged = Object.keys(store).length ? { ...current, ...sanitizeVersions(store) } : current;
      // 整包写入代表作品/章节清单就是最新事实：删掉的书与章不该继续背着快照。
      // 只数 key 不比内容——几十 MB 的文件不该每次自动保存都重 stringify 一遍
      const kept = pruneVersions(merged, bare);
      const keyCount = (s) => Object.keys(storeToFlat(s)).length;
      if (Object.keys(store).length || keyCount(kept) !== keyCount(merged)) await putVersionsStore(kept);
      if (incoming) lastProjectsStamp = incoming;
      lastSeenIds = incomingIds;
      // 彻底删除的书（软删的还在数组里，不算孤儿）：同步状态表里的条目跟着删，
      // 不然 /api/obsidian/status 会永远列着一本不存在的书。库内文件的回收是显式动作
      // （POST /api/obsidian/purge-book，前端确认过才调），这里绝不静默删库。
      const syncStore = await readJson('obsidian-sync.json');
      const orphans = orphanedBookRoots(syncStore, bare);
      if (orphans.length) {
        for (const root of orphans) delete syncStore[root];
        await writeJson('obsidian-sync.json', syncStore);
      }
    }
    if (body.stats !== undefined) {
      if (typeof body.stats !== 'object' || body.stats === null || Array.isArray(body.stats)) {
        return sendJson(res, 400, { error: 'stats 必须是对象' });
      }
      await writeJson('stats.json', body.stats);
    }
    if (body.gacha !== undefined) await writeJson('gacha.json', sanitizeGacha(body.gacha));
    if (body.cards !== undefined) await writeJson('cards.json', sanitizeCards(body.cards));
    sendJson(res, 200, stale ? { ok: true, stale: true } : { ok: true });
    return;
  }

  // 快照按 key 增量写：{ versions: { "<pid>"|"pid::cid": [快照…] }, mode: 'merge'|'replace' }
  // 空数组表示删掉这条 key。默认 merge——整表覆盖只留给「从备份恢复」那一条路。
  // 单章正文快路径：打字场景只改一章时，就地合并进 projects.json——
  // 不动 updatedAt、不碰快照与同步状态表（那些仍由整包 /api/data 负责）。
  if (req.method === 'PUT' && pathname === '/api/chapter') {
    const body = await readBody(req);
    const projectId = typeof body?.projectId === 'string' ? body.projectId : '';
    const chapterId = typeof body?.chapterId === 'string' ? body.chapterId : '';
    if (!projectId || !chapterId) return sendJson(res, 400, { error: 'projectId / chapterId 必填' });
    if (typeof body?.content !== 'string') return sendJson(res, 400, { error: 'content 必须是字符串' });
    const projects = await readJson('projects.json');
    const p = (Array.isArray(projects) ? projects : []).find((x) => x?.id === projectId);
    if (!p) return sendJson(res, 404, { error: '作品不存在（可能刚被删掉）' });
    const c = (p.chapters ?? []).find((x) => x?.id === chapterId);
    if (!c) return sendJson(res, 404, { error: '章不存在（可能刚被删掉）' });
    if (c.content === body.content) return sendJson(res, 200, { ok: true, same: true });
    c.content = body.content;
    await writeJson('projects.json', projects);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'PUT' && pathname === '/api/versions') {
    const body = await readBody(req);
    const flat = body?.versions && typeof body.versions === 'object' ? body.versions : {};
    if (body?.mode === 'replace') await putVersionsStore(flatKeysToStore(flat));
    else await putVersionsStore(mergeFlatIntoStore(await getVersionsStore(), flat));
    const counts = versionsCountMap(await getVersionsStore());
    return sendJson(res, 200, { ok: true, written: Object.keys(flat).length, versionCounts: counts });
  }

  // 懒读快照：不带 project 时回整表（备份/排障用），带了就只回那一本
  if (req.method === 'GET' && pathname === '/api/versions') {
    const want = new URL(req.url, 'http://localhost').searchParams.get('project');
    const flat = storeToFlat(await getVersionsStore());
    if (!want) return sendJson(res, 200, { versions: flat });
    const picked = {};
    for (const [k, v] of Object.entries(flat)) if (ownerOfKey(k) === want) picked[k] = v;
    return sendJson(res, 200, { versions: picked });
  }

  // 整包备份（含快照）由服务端拼装：客户端内存里已经没有快照了，不能再让它凑。
  // 范围就是「全部」：AI 对话与拆文对标也算作者资产，漏掉它们换台机器就找不回来了。
  // ai.json 里的 apiKey 刻意不带出去（备份文件常常就躺在下载目录里），恢复时原样保留本机已有的 Key。
  if (req.method === 'GET' && pathname === '/api/export') {
    const [ideas, projectsRaw, stats, gacha, cards, chat, benchmarks, ai] = await Promise.all([
      readJson('ideas.json'),
      readJson('projects.json'),
      readJson('stats.json'),
      readJson('gacha.json'),
      readJson('cards.json'),
      readJson('chat.json'),
      readJson('benchmarks.json'),
      readJson('ai.json'),
    ]);
    const payload = JSON.stringify({
      schema: 2,
      exportedAt: new Date().toISOString(),
      ideas,
      projects: attachVersions(projectsRaw, await getVersionsStore()),
      stats,
      gacha: sanitizeGacha(gacha),
      cards: sanitizeCards(cards),
      chat: { sessions: Array.isArray(chat?.sessions) ? chat.sessions : [] },
      benchmarks: sanitizeBenchmarks(Array.isArray(benchmarks) ? benchmarks : []),
      ai: stripApiKey(ai),
    });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="workbench-backup-${new Date().toISOString().slice(0, 10)}.json"`,
    });
    res.end(payload);
    return;
  }

  // 自动备份列出来：数据目录 backups/<日期>/ 是「每个文件一份」，界面上必须能挑一个日期恢复，
  // 不然自动备份只是躺在磁盘上，出事那天没人用得上
  // 通用偏好：目前只有「点关闭按钮最小化到托盘还是退出」；主进程关闭时直接读 app.json
  if (req.method === 'GET' && pathname === '/api/app-settings') {
    return sendJson(res, 200, await readJson('app.json'));
  }

  if (req.method === 'PUT' && pathname === '/api/app-settings') {
    const body = await readBody(req);
    const cur = await readJson('app.json');
    cur.closeToTray = body?.closeToTray !== false;
    await writeJson('app.json', cur);
    return sendJson(res, 200, cur);
  }

  // 提示词开放：data/prompts/<key>.md 存在就覆盖内置 system 身份句；写入空文本＝删文件恢复默认
  const PROMPT_KEYS = ['advisor', 'advisor-judge', 'draft', 'chat'];
  if (req.method === 'GET' && pathname === '/api/prompts') {
    const dir = path.join(DATA_DIR, 'prompts');
    const overrides = {};
    for (const key of PROMPT_KEYS) {
      const text = await fs.readFile(path.join(dir, `${key}.md`), 'utf-8').catch(() => null);
      if (typeof text === 'string' && text.trim()) overrides[key] = text;
    }
    return sendJson(res, 200, { overrides });
  }

  if (req.method === 'PUT' && pathname === '/api/prompts') {
    const body = await readBody(req);
    const key = body?.key;
    if (typeof key !== 'string' || !/^[a-z-]+$/.test(key) || !PROMPT_KEYS.includes(key)) {
      return sendJson(res, 400, { error: '非法的提示词标识' });
    }
    const text = typeof body?.text === 'string' ? body.text : '';
    const dir = path.join(DATA_DIR, 'prompts');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${key}.md`);
    if (!text.trim()) {
      await fs.rm(file, { force: true });
    } else {
      await fs.writeFile(file, text, 'utf-8');
    }
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/backups') {
    const root = path.join(DATA_DIR, 'backups');
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const list = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(root, e.name);
      const st = await fs.stat(full).catch(() => null);
      if (!st) continue;
      const files = await fs.readdir(full).catch(() => []);
      if (!files.includes('projects.json')) continue; // 备份没写完/不完整的不给恢复
      const sizes = await Promise.all(files.map((f) => fs.stat(path.join(full, f)).then((s) => s.size).catch(() => 0)));
      list.push({ day: e.name, at: st.mtime.toISOString(), files: files.length, bytes: sizes.reduce((a, b) => a + b, 0) });
    }
    list.sort((a, b) => (a.day < b.day ? 1 : -1));
    return sendJson(res, 200, { backups: list });
  }

  // 从某天的自动备份取出整包（形状与 /api/export 一致，客户端复用同一条恢复路径）
  if (req.method === 'POST' && pathname === '/api/restore-backup') {
    const body = await readBody(req);
    const day = typeof body?.day === 'string' ? body.day : '';
    // 只认日期目录名：别让 ../ 之类的东西跑出 backups/
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return sendJson(res, 400, { error: '备份日期不合法' });
    const dir = path.join(DATA_DIR, 'backups', day);
    if (!existsSync(path.join(dir, 'projects.json'))) return sendJson(res, 404, { error: `没找到 ${day} 的备份` });
    const pick = async (name, fallback) => {
      try {
        return JSON.parse(await fs.readFile(path.join(dir, name), 'utf-8'));
      } catch {
        return fallback;
      }
    };
    const projectsRaw = await pick('projects.json', []);
    if (!Array.isArray(projectsRaw)) return sendJson(res, 400, { error: '这份备份的 projects.json 不是数组，可能写坏了' });
    const [stats, gacha, cards, chat, benchmarks, ai] = await Promise.all([
      pick('stats.json', DEFAULTS['stats.json']),
      pick('gacha.json', DEFAULTS['gacha.json']),
      pick('cards.json', DEFAULTS['cards.json']),
      pick('chat.json', DEFAULTS['chat.json']),
      pick('benchmarks.json', []),
      pick('ai.json', null),
    ]);
    return sendJson(res, 200, {
      schema: 2,
      exportedAt: new Date(`${day}T00:00:00`).toISOString(),
      ideas: await pick('ideas.json', []),
      projects: attachVersions(projectsRaw, sanitizeVersions(await pick('versions.json', {}))),
      stats,
      gacha: sanitizeGacha(gacha),
      cards: sanitizeCards(cards),
      chat: { sessions: Array.isArray(chat?.sessions) ? chat.sessions : [] },
      benchmarks: sanitizeBenchmarks(Array.isArray(benchmarks) ? benchmarks : []),
      ai: stripApiKey(ai),
    });
  }

  if (req.method === 'PUT' && pathname === '/api/ai-config') {
    const body = await readBody(req);
    const ai = await readJson('ai.json');
    if (typeof body.provider === 'string' && body.provider.trim()) ai.provider = body.provider.trim();
    if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) ai.baseUrl = body.baseUrl.trim();
    if (typeof body.model === 'string' && body.model.trim()) ai.model = body.model.trim();
    if (body.protocol === 'openai' || body.protocol === 'anthropic' || body.protocol === 'ollama') ai.protocol = body.protocol;
    if (typeof body.apiKey === 'string') ai.apiKey = body.apiKey.trim();
    if (Array.isArray(body.rules)) {
      ai.rules = body.rules
        .filter((r) => r && typeof r.content === 'string')
        .map((r) => ({
          name: typeof r.name === 'string' ? r.name.slice(0, 30) : '未命名规则',
          content: String(r.content).slice(0, 2000),
          on: Boolean(r.on),
        }));
    }
    if (typeof body.memoryExtract === 'boolean') ai.memoryExtract = body.memoryExtract;
    if (typeof body.gateDraft === 'boolean') ai.gateDraft = body.gateDraft;
    if (typeof body.judgeOnly === 'boolean') ai.judgeOnly = body.judgeOnly;
    await writeJson('ai.json', ai);
    sendJson(res, 200, {
      ok: true,
      ai: {
        provider: ai.provider,
        baseUrl: ai.baseUrl,
        model: ai.model,
        protocol: resolveProtocol(ai),
        hasKey: Boolean(ai.apiKey),
        ready: Boolean(ai.baseUrl && ai.model),
        rules: ai.rules ?? [],
        memoryExtract: ai.memoryExtract !== false,
        gateDraft: ai.gateDraft !== false,
        judgeOnly: ai.judgeOnly === true,
      },
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/ai/models') {
    const body = await readBody(req).catch(() => ({}));
    const saved = await readJson('ai.json');
    // 允许用「表单里正在编辑」的值查模型：看一眼列表不该顺手把没确认的配置写进盘里
    const ai = {
      ...saved,
      ...(typeof body?.baseUrl === 'string' && body.baseUrl.trim() ? { baseUrl: body.baseUrl.trim() } : {}),
      ...(typeof body?.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
      ...(body?.protocol === 'openai' || body?.protocol === 'anthropic' || body?.protocol === 'ollama' ? { protocol: body.protocol } : {}),
    };
    if (!ai.baseUrl) return sendJson(res, 200, { ok: false, message: '请先填写接口地址' });
    const base = ai.baseUrl.replace(/\/+$/, '');
    const proto = resolveProtocol(ai);
    const headers = {};
    if (proto === 'anthropic') Object.assign(headers, anthropicHeaders(ai));
    else if (ai.apiKey) headers.Authorization = `Bearer ${ai.apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      let r = await fetch(base + '/models', { headers, signal: controller.signal });
      // Ollama 兜底：其原生接口为 /api/tags
      if (!r.ok && proto === 'ollama') {
        r = await fetch(new URL(base).origin + '/api/tags', { signal: controller.signal });
      }
      const text = await r.text();
      if (!r.ok) {
        return sendJson(res, 200, { ok: false, message: extractUpstreamError(text) });
      }
      let ids = [];
      try {
        const j = JSON.parse(text);
        if (Array.isArray(j?.data)) ids = j.data.map((m) => m?.id).filter(Boolean);
        else if (Array.isArray(j?.models)) ids = j.models.map((m) => m?.name || m?.model).filter(Boolean);
      } catch {
        ids = [];
      }
      sendJson(res, 200, { ok: true, models: [...new Set(ids)].sort() });
    } catch (err) {
      const message =
        proto === 'ollama'
          ? '无法连接 Ollama，请确认它正在运行（命令行执行 ollama serve，或打开 Ollama 应用）'
          : `获取模型列表失败：${err?.message || err}`;
      sendJson(res, 200, { ok: false, message });
    } finally {
      clearTimeout(timer);
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/ai/test') {
    const ai = await readJson('ai.json');
    if (!ai.baseUrl || !ai.model) return sendJson(res, 200, { ok: false, message: '请先填写接口地址与模型名称' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const proto = resolveProtocol(ai);
    try {
      let reply = '';
      if (proto === 'anthropic') {
        const upstream = await fetch(ai.baseUrl.replace(/\/+$/, '') + '/messages', {
          method: 'POST',
          signal: controller.signal,
          headers: anthropicHeaders(ai),
          body: JSON.stringify({
            model: ai.model,
            max_tokens: 20,
            messages: [{ role: 'user', content: '请原样回复四个字：连接成功' }],
          }),
        });
        const text = await upstream.text();
        if (!upstream.ok) {
          sendJson(res, 200, { ok: false, message: extractUpstreamError(text) });
          return;
        }
        try {
          reply = (JSON.parse(text)?.content || []).map((b) => b?.text || '').join('');
        } catch {
          reply = '';
        }
      } else {
        const headers = { 'Content-Type': 'application/json' };
        if (ai.apiKey) headers.Authorization = `Bearer ${ai.apiKey}`;
        const upstream = await fetch(aiChatUrl(ai.baseUrl), {
          method: 'POST',
          signal: controller.signal,
          headers,
          body: JSON.stringify({
            model: ai.model,
            messages: [{ role: 'user', content: '请原样回复四个字：连接成功' }],
            stream: false,
            max_tokens: 20,
          }),
        });
        const text = await upstream.text();
        if (!upstream.ok) {
          sendJson(res, 200, { ok: false, message: extractUpstreamError(text) });
          return;
        }
        try {
          reply = JSON.parse(text)?.choices?.[0]?.message?.content || '';
        } catch {
          reply = '';
        }
      }
      sendJson(res, 200, { ok: true, message: reply || '连接成功（模型未返回内容）' });
    } catch (err) {
      sendJson(res, 200, { ok: false, message: `连接失败：${err?.message || err}` });
    } finally {
      clearTimeout(timer);
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/ai/chat') {
    const body = await readBody(req);
    await handleAiChat(req, res, body);
    return;
  }

  // 非流式文本（记忆抽取等结构化任务）：消息由前端组好，这里只负责转发并整段返回
  if (req.method === 'POST' && pathname === '/api/ai/text') {
    const body = await readBody(req);
    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return sendJson(res, 400, { error: 'messages 不能为空' });
    }
    const validRole = (m) => m && typeof m.content === 'string' && (m.role === 'system' || m.role === 'user' || m.role === 'assistant');
    if (!messages.every(validRole)) {
      return sendJson(res, 400, { error: 'messages 含非法条目' });
    }
    try {
      const text = await askUpstreamText(messages, typeof body?.temperature === 'number' ? body.temperature : undefined);
      return sendJson(res, 200, { ok: true, text });
    } catch (err) {
      const status = err?.status || 500;
      return sendJson(res, status, { ok: false, error: err?.message || '抽取失败' });
    }
  }

  // 拆文对标：只回统计，体积按章数线性但每章只有几个数字
  if (pathname === '/api/benchmarks') {
    if (req.method === 'GET') return sendJson(res, 200, { books: sanitizeBenchmarks(await readJson('benchmarks.json')) });
    if (req.method === 'PUT') {
      const body = await readBody(req);
      await writeJson('benchmarks.json', sanitizeBenchmarks(body?.books));
      return sendJson(res, 200, { ok: true });
    }
  }

  // AI 对话会话持久化
  if (pathname === '/api/chat') {
    if (req.method === 'GET') {
      return sendJson(res, 200, await readJson('chat.json'));
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (!Array.isArray(body?.sessions)) return sendJson(res, 400, { error: 'sessions 必须是数组' });
      await writeJson('chat.json', { sessions: body.sessions });
      return sendJson(res, 200, { ok: true });
    }
  }

  // 在资源管理器中打开数据目录（仅本机使用）
  if (req.method === 'POST' && pathname === '/api/open-folder') {
    const child = spawn('explorer', [DATA_DIR], { detached: true, stdio: 'ignore' });
    child.unref();
    return sendJson(res, 200, { ok: true, path: DATA_DIR });
  }

  sendJson(res, 404, { error: '接口不存在' });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(DIST_DIR, rel);
  if (target !== DIST_DIR && !target.startsWith(DIST_DIR + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  let filePath = target;
  if (!existsSync(filePath) || filePath === DIST_DIR) {
    // 单页应用未知路径回退首页，但带后缀的静态资源不能回退：
    // 把缺失的 /assets/xxx.js 变成 200 text/html，浏览器只会报 MIME 错误、整页白屏且无从诊断
    if (path.extname(rel)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('资源不存在');
      return;
    }
    filePath = path.join(DIST_DIR, 'index.html');
  }
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath)
    .then((content) => {
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(content);
    })
    .catch(() => {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('请先执行 npm run build 构建前端页面');
    });
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

const server = http.createServer(async (req, res) => {
  // 解码必须在 try 里：这行原先裸在外面，一个 GET /% 抛 URIError 就把整个进程带走（实测 Node 24 直接退出）
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('请求路径不合法');
    req.resume();
    return;
  }
  try {
    if (pathname.startsWith('/api/')) {
      // 超限的请求体先看 Content-Length 直接拒掉：等收完再拒，客户端往往只看到连接被掐
      if (BODY_METHODS.has(req.method) && Number(req.headers['content-length']) > MAX_BODY) {
        res.setHeader('Connection', 'close');
        sendJson(res, 413, { error: tooLargeBody(Number(req.headers['content-length'])).message });
        req.resume(); // 排空剩余请求体，让响应能正常送达
        return;
      }
      await handleApi(req, res, pathname);
    } else {
      serveStatic(res, pathname);
    }
  } catch (err) {
    if (res.headersSent) return;
    if (err?.status === 413) res.setHeader('Connection', 'close');
    sendJson(res, err?.status || 500, { error: err?.message || '服务器内部错误' });
    req.resume();
  }
});

/** 备份文件里不带 API Key：备份常常就躺在下载目录里；恢复时「没带 Key」= 本机已有的 Key 原样保留 */
function stripApiKey(ai) {
  if (!ai || typeof ai !== 'object') return null;
  const out = { ...ai };
  delete out.apiKey;
  return out;
}

// 每日自动备份：把数据文件复制到 data/backups/<日期>/，保留最近 7 天
let lastBackupDay = '';

async function backupData() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  if (day === lastBackupDay) return;
  lastBackupDay = day;
  const dir = path.join(DATA_DIR, 'backups', day);
  // 当天已备份过就不再覆盖：保留当天首次启动时的快照，否则中途重启会把已损坏/误删的数据写进唯一备份
  if (existsSync(path.join(dir, 'projects.json'))) return;
  await fs.mkdir(dir, { recursive: true });
  for (const name of Object.keys(DEFAULTS)) {
    await fs.copyFile(path.join(DATA_DIR, name), path.join(dir, name)).catch(() => {});
  }
  const backupsRoot = path.join(DATA_DIR, 'backups');
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  const entries = await fs.readdir(backupsRoot, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(backupsRoot, e.name);
    const st = await fs.stat(full).catch(() => null);
    if (st && st.mtimeMs < cutoff) await fs.rm(full, { recursive: true, force: true }).catch(() => {});
  }
  console.log(`已备份数据到 ${dir}`);
}

/**
 * 一次性迁移：同步状态表的老条目没有 projectId（9-30 之前同步的），按书名回填。
 * 同名书多本时跳过（歧义不可猜）；回填后回收站「连库一起删」就能按 id 精确认领。
 */
async function migrateSyncStore() {
  const store = await readJson('obsidian-sync.json');
  const projects = await readJson('projects.json');
  let changed = 0;
  for (const entry of Object.values(store ?? {})) {
    if (!entry || entry.projectId || typeof entry.book !== 'string') continue;
    const matches = projects.filter((x) => x?.title === entry.book);
    if (matches.length === 1) {
      entry.projectId = matches[0].id;
      changed++;
    }
  }
  if (changed) await writeJson('obsidian-sync.json', store);
  return changed;
}

ensureDataDir()
  .then(async () => {
    await backupData();
    // 快照搬迁只是体积优化，失败不该挡住开机：正文与嵌入快照仍在原文件里，下次启动再试
    await migrateVersions().catch((err) => console.error('历史快照搬迁未完成（不影响使用）:', err?.message || err));
    const n = await migrateSyncStore().catch(() => -1);
    if (n > 0) console.log(`同步状态表迁移：${n} 条老记录已按书名补上 projectId`);
    setInterval(() => backupData().catch(() => {}), 3600 * 1000);
    server.listen(PORT, '127.0.0.1', () => {
      console.log('');
      console.log('  创作工作台已启动');
      console.log(`  本地地址: http://127.0.0.1:${PORT}`);
      console.log(`  数据目录: ${DATA_DIR}`);
      console.log('  按 Ctrl+C 停止服务');
      console.log('');
    });
  })
  .catch((err) => {
    console.error('初始化数据目录失败:', err);
    process.exit(1);
  });

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用（工作台可能已经在运行）。直接打开 http://127.0.0.1:${PORT} 即可。`);
    process.exit(1);
  }
  console.error('服务器错误:', err);
});
