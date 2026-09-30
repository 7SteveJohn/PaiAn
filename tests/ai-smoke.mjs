// AI 链路冒烟：起一个「假上游」模拟 OpenAI / Ollama 原生 / Anthropic 三种协议，
// 让真正的 server.js 去连它，断言 SSE 分帧、think 关闭、usage 合成、缓存标记与失败降级。
// 不依赖 Ollama 是否运行、不消耗任何 token、不碰外部网络。
// 用法：npm run test:ai
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverJs = path.join(root, 'server.js');

// ---------- 工具 ----------
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg} —— 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------- 假上游 ----------
function startMockUpstream() {
  const state = {
    requests: [],       // 每次上游收到的请求：{ path, body }
    strict400: false,   // 开启后：带 stream_options 的 OpenAI 请求首次返回 400（模拟不兼容端点）
    always500: false,   // 开启后：OpenAI 端点一律 500
    cutHalf: false,     // 开启后：Ollama 流发一半就提前 end（模拟上游提前结束）
    cutRst: false,      // 开启后：Ollama 流发一块就 RST 掉线（模拟上游崩溃）
  };
  // 非流式通道的统一回复：模拟一次"记忆抽取"返回的结构化 JSON 文本
  const EXTRACT_JSON = '{"memories":[{"name":"林越","isNew":true,"changeNote":"本章登场"}]}';
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw || '{}'); } catch { body = null; }
      const pathname = new URL(req.url, 'http://x').pathname;
      state.requests.push({ path: pathname, body });

      // OpenAI 兼容端点
      if (req.method === 'POST' && pathname === '/chat/completions') {
        if (state.always500) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: '上游炸了' } }));
          return;
        }
        if (state.strict400 && body?.stream_options) {
          state.strict400 = false; // 只拒绝一次，下一次应成功
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'unsupported: stream_options' } }));
          return;
        }
        if (body?.stream === false) {
          // 非流式：记忆抽取等结构化任务
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: EXTRACT_JSON } }] }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '雾' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '港' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 120, prompt_cache_hit_tokens: 96, completion_tokens: 2 } }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // Ollama 原生端点（故意用 \r 分帧，复刻 Windows 版 Ollama 的真实行为）
      if (req.method === 'POST' && pathname === '/api/chat') {
        if (body?.stream === false) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: { role: 'assistant', content: EXTRACT_JSON }, done: true }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ model: body?.model, message: { role: 'assistant', content: '夜' } }) + '\r');
        if (state.cutHalf) {
          state.cutHalf = false;
          res.end(); // 上游提前结束：不发 done，正文只给一半
          return;
        }
        if (state.cutRst) {
          state.cutRst = false;
          res.end();
          setTimeout(() => res.socket?.destroy(), 10); // 响应后立即 RST
          return;
        }
        res.write(JSON.stringify({ message: { content: '航' } }) + '\r');
        res.write(JSON.stringify({ done: true, prompt_eval_count: 210, eval_count: 33 }) + '\r');
        res.end();
        return;
      }

      // Anthropic 原生端点
      if (req.method === 'POST' && pathname === '/messages') {
        if (body?.stream === false) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ content: [{ type: 'text', text: EXTRACT_JSON }], usage: { input_tokens: 10, output_tokens: 5 } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 0 } } }) + '\n\n');
        res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '潮' } }) + '\n\n');
        res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '声' } }) + '\n\n');
        res.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 7 } }) + '\n\n');
        res.write('event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n');
        res.end();
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '未知上游路径' } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', async () => {
      resolve({ port: server.address().port, state, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// ---------- SSE 消费 ----------
async function callChat(base, body, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let status = 0;
  let raw = '';
  try {
    const res = await fetch(base + '/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    status = res.status;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream')) {
      const j = await res.json().catch(() => ({}));
      return { status, raw: '', events: [], json: j, aborted: false };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
    }
  } catch (err) {
    // 上游被 destroy 时会走到这里（客户端看到流中断），属预期分支
  } finally {
    clearTimeout(timer);
  }
  const events = raw
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .filter(Boolean)
    .map((s) => (s === '[DONE]' ? '[DONE]' : safeParse(s)));
  return { status, raw, events };
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
function textOf(events) {
  return events
    .map((e) => e && e !== '[DONE]' ? (e.choices?.[0]?.delta?.content || '') : '')
    .join('');
}

// 非流式通道调用：整段请求，整段返回 { ok, text }
async function callText(base, messages) {
  const res = await fetch(base + '/api/ai/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
function usageOf(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e !== '[DONE]' && e.usage) return e.usage;
  }
  return null;
}

// ---------- 用例 ----------
let failures = 0;
const steps = [];
function step(name, fn) { steps.push({ name, fn }); }

step('Ollama 原生：think:false 生效，正文流式透出（含 \\r 分帧）', async (ctx) => {
  await ctx.configure({ provider: 'mock', baseUrl: ctx.mockUrl, model: 'qwen3:8b', protocol: 'ollama' });
  ctx.mock.state.requests.length = 0;
  const r = await callChat(ctx.base, { messages: [{ role: 'user', content: '写一段' }], temperature: 0.7 });
  const req = ctx.mock.state.requests.find((x) => x.path === '/api/chat');
  assert(req, '未调用 Ollama 原生端点 /api/chat');
  assertEq(req.body.think, false, '必须显式 think:false（否则 qwen3 会开思考，慢 ~30 倍）');
  assertEq(req.body.stream, true, '应流式');
  assertEq(req.body.model, 'qwen3:8b', 'model 透传');
  assertEq(req.body.options?.temperature, 0.7, 'temperature 走 options');
  assert(r.events.includes('[DONE]'), '应以 [DONE] 收尾');
  assertEq(textOf(r.events), '夜航', '上游用 \\r 分帧时仍应拼出完整正文');
  const u = usageOf(r.events);
  assertEq(u?.prompt_tokens, 210, 'usage.prompt_tokens 取自 prompt_eval_count');
  assertEq(u?.completion_tokens, 33, 'usage.completion_tokens 取自 eval_count');
});

step('OpenAI 兼容：请求带 stream_options，输出与 usage 原样透传', async (ctx) => {
  await ctx.configure({ provider: 'mock', baseUrl: ctx.mockUrl, model: 'gpt-mock', protocol: 'openai' });
  ctx.mock.state.requests.length = 0;
  const r = await callChat(ctx.base, { messages: [{ role: 'user', content: '写一段' }] });
  const req = ctx.mock.state.requests.find((x) => x.path === '/chat/completions');
  assert(req, '未调用 /chat/completions');
  assert(req.body.stream_options?.include_usage, '应请求 usage 统计');
  assertEq(textOf(r.events), '雾港', '正文透传');
  assertEq(usageOf(r.events)?.prompt_cache_hit_tokens, 96, '上游 usage 透传（前端据此显示命中率）');
});

step('不兼容端点返回 400 时自动去掉 stream_options 重试', async (ctx) => {
  await ctx.configure({ provider: 'mock', baseUrl: ctx.mockUrl, model: 'gpt-mock', protocol: 'openai' });
  ctx.mock.state.requests.length = 0;
  ctx.mock.state.strict400 = true;
  const r = await callChat(ctx.base, { messages: [{ role: 'user', content: '写一段' }] });
  const hits = ctx.mock.state.requests.filter((x) => x.path === '/chat/completions');
  assertEq(hits.length, 2, '应重试一次');
  assert(hits[0].body.stream_options, '首次带 stream_options');
  assertEq(hits[1].body.stream_options, undefined, '重试应去掉 stream_options');
  assertEq(textOf(r.events), '雾港', '重试后仍能正常出正文');
});

step('Anthropic：事件流转成 OpenAI 形状，usage 含缓存命中', async (ctx) => {
  await ctx.configure({ provider: 'mock', baseUrl: ctx.mockUrl, model: 'claude-mock', protocol: 'anthropic' });
  ctx.mock.state.requests.length = 0;
  const longSystem = '你是一位网文作家。' + '保持中文口语化，避免翻译腔。'.repeat(60); // >800 字符触发缓存标记
  const r = await callChat(ctx.base, {
    messages: [
      { role: 'system', content: longSystem },
      { role: 'user', content: '写一段' },
    ],
  });
  const req = ctx.mock.state.requests.find((x) => x.path === '/messages');
  assert(req, '未调用 Anthropic /messages');
  assert(Array.isArray(req.body.system) && req.body.system[0]?.cache_control?.type === 'ephemeral',
    '长 system（≥800 字符）应带 ephemeral 缓存标记');
  assertEq(textOf(r.events), '潮声', 'content_block_delta 应转成 delta.content');
  const u = usageOf(r.events);
  assertEq(u?.prompt_cache_hit_tokens, 900, '缓存命中 token 应合成进 usage');
  assertEq(u?.completion_tokens, 7, '输出 token 合成');
  assertEq(u?.prompt_tokens, 940, 'prompt_tokens = input + cache_read + cache_creation');
  assert(r.events.includes('[DONE]'), '应以 [DONE] 收尾');
});

step('上游 500：返回错误 JSON，不挂起不静默', async (ctx) => {
  await ctx.configure({ provider: 'mock', baseUrl: ctx.mockUrl, model: 'gpt-mock', protocol: 'openai' });
  ctx.mock.state.always500 = true;
  try {
    const r = await callChat(ctx.base, { messages: [{ role: 'user', content: '写一段' }] });
    assertEq(r.status, 500, '应透传上游状态码');
    assert(/上游炸了/.test(r.json?.error || ''), `错误信息应带上游原文，实际：${JSON.stringify(r.json)}`);
  } finally {
    ctx.mock.state.always500 = false; // 复位，避免污染后续用例
  }
});

step('上游连不上：502 明确报错', async (ctx) => {
  await ctx.configure({ provider: 'mock', baseUrl: 'http://127.0.0.1:1', model: 'gpt-mock', protocol: 'openai' });
  const r = await callChat(ctx.base, { messages: [{ role: 'user', content: '写一段' }] });
  assertEq(r.status, 502, '应返回 502');
  assert(/无法连接/.test(r.json?.error || ''), '应提示无法连接');
});

step('上游提前结束：只出部分正文，仍以 [DONE] 收尾', async (ctx) => {
  await ctx.configure({ provider: 'mock', baseUrl: ctx.mockUrl, model: 'qwen3:8b', protocol: 'ollama' });
  ctx.mock.state.cutHalf = true;
  const r = await callChat(ctx.base, { messages: [{ role: 'user', content: '写一段' }] });
  const text = textOf(r.events);
  assert(text.includes('夜'), `应拿到已生成的部分正文，实际：${JSON.stringify(text)}`);
  assert(!text.includes('航'), '不应凭空补出后半段');
  assert(r.events.includes('[DONE]'), '仍应以 [DONE] 收尾（前端据此结束流式状态）');
});

step('上游硬掉线（RST）：不崩，本地服务仍健康', async (ctx) => {
  await ctx.configure({ provider: 'mock', baseUrl: ctx.mockUrl, model: 'qwen3:8b', protocol: 'ollama' });
  ctx.mock.state.cutRst = true;
  await callChat(ctx.base, { messages: [{ role: 'user', content: '写一段' }] });
  const alive = await fetch(ctx.base + '/api/data');
  assertEq(alive.status, 200, '掉线后本地服务仍应健康');
  const again = await callChat(ctx.base, { messages: [{ role: 'user', content: '再来一段' }] });
  assertEq(textOf(again.events), '夜航', '掉线后下一次请求应正常');
});

step('未配置 AI（地址为空）：400 提示去设置页', async (ctx) => {
  writeFileSync(path.join(ctx.dataDir, 'ai.json'), JSON.stringify({ provider: '', baseUrl: '', model: '', protocol: 'openai', apiKey: '', rules: [] }, null, 2));
  const r = await callChat(ctx.base, { messages: [{ role: 'user', content: '写一段' }] });
  assertEq(r.status, 400, '应 400');
  assert(/尚未配置/.test(r.json?.error || ''), '应提示尚未配置');
});

step('messages 非法：400 拒绝', async (ctx) => {
  await ctx.configure({ provider: 'mock', baseUrl: ctx.mockUrl, model: 'gpt-mock', protocol: 'openai' });
  for (const bad of [{}, { messages: [] }, { messages: 'x' }]) {
    const r = await callChat(ctx.base, bad);
    assertEq(r.status, 400, `应 400：${JSON.stringify(bad)}`);
  }
});

step('非流式通道 /api/ai/text：三种协议整段返回可解析抽取文本', async (ctx) => {
  for (const [protocol, model] of [['ollama', 'qwen3:8b'], ['openai', 'gpt-mock'], ['anthropic', 'claude-mock']]) {
    await ctx.configure({ provider: 'mock', baseUrl: ctx.mockUrl, model, protocol });
    ctx.mock.state.requests.length = 0; // 只观察本次请求
    const r = await callText(ctx.base, [{ role: 'user', content: '抽取本章记忆' }]);
    assertEq(r.status, 200, `${protocol} 应 200，实际 body=${JSON.stringify(r.json)}`);
    assertEq(r.json?.ok, true, `${protocol} ok 应为 true`);
    assert(typeof r.json?.text === 'string' && r.json.text.includes('memories'), `${protocol} 应整段返回抽取 JSON`);
    const nreq = ctx.mock.state.requests.find((x) => x.path === '/api/chat' || x.path === '/chat/completions' || x.path === '/messages');
    assert(nreq, `${protocol} 应有对应上游请求`);
    assertEq(nreq.body.stream, false, `${protocol} 上游请求 stream 应为 false`);
  }
});

step('非流式上游 500：ok:false 且透传错误原文', async (ctx) => {
  await ctx.configure({ provider: 'mock', baseUrl: ctx.mockUrl, model: 'gpt-mock', protocol: 'openai' });
  ctx.mock.state.always500 = true;
  const r = await callText(ctx.base, [{ role: 'user', content: 'x' }]);
  ctx.mock.state.always500 = false;
  assertEq(r.json?.ok, false, 'ok 应为 false');
  assert(/上游炸了/.test(r.json?.error || ''), '应透传上游错误');
});

step('非流式入参非法：400 拒绝', async (ctx) => {
  await ctx.configure({ provider: 'mock', baseUrl: ctx.mockUrl, model: 'gpt-mock', protocol: 'openai' });
  for (const bad of [{}, { messages: [] }, { messages: 'x' }, { messages: [{ role: 'nope', content: 'y' }] }]) {
    const r = await fetch(ctx.base + '/api/ai/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bad),
    });
    assertEq(r.status, 400, `应 400：${JSON.stringify(bad)}`);
  }
});

// ---------- 主流程 ----------
async function main() {
  const mock = await startMockUpstream();
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), 'wb-ai-'));
  const child = spawn(process.execPath, [serverJs], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const base = `http://127.0.0.1:${port}`;
  const mockUrl = `http://127.0.0.1:${mock.port}`;

  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      try { ready = (await fetch(base + '/api/data')).ok; } catch { await sleep(150); }
    }
    if (!ready) throw new Error('server 启动超时\n' + out.slice(-1500));

    const ctx = {
      base, mock, mockUrl, dataDir,
      serverOut: () => out.slice(-2000),
      configure: (cfg) => fetch(base + '/api/ai-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      }).then((r) => r.json()),
    };

    console.log('AI 链路冒烟（假上游，真 server.js；不连外部模型）：');
    for (const { name, fn } of steps) {
      try {
        await fn(ctx);
        console.log('  ✓ ' + name);
      } catch (err) {
        failures += 1;
        console.error('  ✗ ' + name + '\n      ' + (err?.message || err));
        console.error('      [server 输出] ' + ctx.serverOut().replace(/\n/g, '\n      '));
      }
    }
  } finally {
    child.kill();
    await new Promise((r) => child.once('exit', r));
    await mock.close();
    rmSync(dataDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\nAI 冒烟失败：${failures} 项未通过`);
    process.exit(1);
  }
  console.log('\nAI 冒烟全部通过。');
}

main().catch((err) => {
  console.error('AI 冒烟执行异常:', err?.message || err);
  process.exit(1);
});
