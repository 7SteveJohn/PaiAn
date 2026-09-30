// Obsidian 双向同步的真实窗口冒烟：先在进程外用真实 HTTP 把树推出去、再按 Obsidian 的存盘方式改库，
// 然后起 Electron 走作者那条路——同步按钮 → 拉回 → 冲突面板点边 → 全部同步。
// 判定层与接口层的断言在 tests/obsidian-sync.test.ts 与 tests/api-smoke.mjs；这条专门盯客户端接线。
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { bundleDrive } from './ui-drive-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const drivePath = path.join(root, 'tests', 'ui-obsidian-drive.js');
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', readFileSync(path.join(root, 'node_modules/electron/path.txt'), 'utf-8').trim());

if (!existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('缺少 dist/index.html，请先执行 npm run build');
  process.exit(1);
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });

const wait = async (fn, ms, label) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('等待超时：' + label);
    await new Promise((r) => setTimeout(r, 200));
  }
};

const dataDir = mkdtempSync(path.join(tmpdir(), 'wb-ob-'));
// 「读剪贴板」那条要真读系统剪贴板：先备份用户自己的剪贴板、塞一段进去，跑完还原（见 finally）。
// 走 Electron 自己的 clipboard 模块而不是 PowerShell——本机 PowerShell 被安全策略拦着（status≠0）。
const CLIP_MARK = '剪贴板冒烟标记';
const clipTool = path.join(dataDir, 'clip-tool.cjs');
writeFileSync(
  clipTool,
  [
    "const { app, clipboard } = require('electron');",
    'app.whenReady().then(async () => {',
    '  const text = process.argv[3] ?? "";',
    "  if (process.argv[2] === 'read') process.stdout.write(await clipboard.readText());",
    '  else await clipboard.writeText(text);',
    '  await new Promise((r) => setTimeout(r, 60)); // 让 stdout 落盘再退：Electron 44 的 clipboard 是异步的，写没落地就被 app.exit 带走',
    '  app.exit(0);',
    '});',
  ].join('\n'),
  'utf-8',
);
// 跑 Electron 一律用异步 spawn：本机 spawnSync 起 electron.exe 会 EBUSY（同一份命令从 bash 直跑却没事），
// 结果就是「种子有时有、有时没有」这种看天吃饭的假红。
// 另加 8 秒兜底：clipboard 是异步 API，万一读不回来卡住，这段前置会把整条冒烟拖死（此时全局超时还没架起来）
const runClip = (mode, text) =>
  new Promise((resolve) => {
    const c = spawn(electronBin, [clipTool, mode, text ?? ''], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ out });
    };
    const timer = setTimeout(() => {
      c.kill();
      fin();
    }, 8000);
    c.stdout.on('data', (d) => (out += d));
    c.on('exit', fin);
    c.on('error', fin);
  });
const clipBackup = (await runClip('read')).out;
// 写进去要读回来确认：只写不读分不清「写成功」和「没落地」
const SEED_CLIP = `${CLIP_MARK}\n第1章 从剪贴板来：这段是冒烟脚本塞进去的。\n正文一行。`;
let clipMark = '';
for (let i = 0; i < 2 && !clipMark; i++) {
  await runClip('write', SEED_CLIP);
  if ((await runClip('read')).out.includes(CLIP_MARK)) clipMark = CLIP_MARK;
}
if (!clipMark) console.log('  （剪贴板通道不通，「读剪贴板」这条退成软断言）');
const driveScript = bundleDrive(dataDir, drivePath, `const CLIP_MARK = ${JSON.stringify(clipMark)};`); // 公共助手 + 驱动，拼好写进隔离目录
const vault = path.join(dataDir, 'vault');
const now = new Date().toISOString();
const mk = (id, title, content) => ({ id, title, content, volume: '第一卷', beats: '要点：' + title, cast: '林越、阿禾', createdAt: now, updatedAt: now });
const book = {
  id: 'ob1',
  title: '雾港',
  type: '玄幻',
  status: '写作中',
  deadline: '',
  notes: '一座终年被雾锁住的港口城。',
  draft: '',
  linkedIdeaIds: [],
  mode: 'chapters',
  chapters: [mk('c1', '到港', '林越蹲在第七根缆桩边。'), mk('c2', '黑车', '岑九站在灯塔下。'), mk('c3', '起雾', '')],
  characters: [
    { id: 'k1', name: '林越', state: '握着半枚铜印', log: [], relations: [{ with: '阿禾', note: '欠她一条命' }], power: '筑基' },
    { id: 'k2', name: '阿禾', state: '不知师父死讯', log: [], relations: [] },
  ],
  worldItems: [
    { id: 'w1', name: '末法九境', kind: '力量体系', content: '炼气 → 筑基 → 金丹 → 元婴' },
    { id: 'w2', name: '雾钟', kind: '地点', content: '雾起时自己会响。' },
  ],
  marks: [],
  createdAt: now,
  updatedAt: now,
};

let failures = 0;
const say = (msg, ok = true) => {
  console.log((ok ? '  ✓ ' : '  ✗ ') + msg);
  if (!ok) failures++;
};
const check = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// Obsidian 属性视图保存后的样子：值不带引号、数组写成块式列表、键序倒过来
const rewriteObsidian = (text) => {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return text;
  const groups = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv && kv[2].trim().startsWith('[')) groups.push([kv[1] + ':', ...JSON.parse(kv[2].trim()).map((i) => '  - ' + i)]);
    else if (kv) groups.push([kv[1] + ': ' + kv[2].trim().replace(/^"(.*)"$/, '$1')]);
    else if (groups.length && /^\s+-\s/.test(line)) groups[groups.length - 1].push(line);
    else groups.push([line]);
  }
  groups.reverse();
  return '---\n' + groups.flat().join('\n') + '\n---' + text.slice(m[0].length);
};

try {
  mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  // 再来一本单篇草稿：它没有章，导入新章会把它的 draft 挤出界面且切不回去
  const single = {
    id: 'ob2',
    title: '短篇',
    type: '玄幻',
    status: '写作中',
    deadline: '',
    notes: '',
    draft: '一篇还没分章的短稿，就这样被看见。',
    linkedIdeaIds: [],
    mode: 'single',
    chapters: [],
    characters: [],
    worldItems: [],
    marks: [],
    createdAt: now,
    updatedAt: now,
  };
  writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([book, single], null, 2), 'utf-8');
  // 库里的一篇原创笔记：带 Obsidian 属性区，导入时只该带走正文
  mkdirSync(path.join(vault, '素材'), { recursive: true });
  const vaultNote = path.join(vault, '素材', '码头听来的.md');
  writeFileSync(
    vaultNote,
    '---\ntags:\n  - 场景\ncssclasses: wide\n---\n\n有人在第七根缆桩边等一条不会来的船，等了十一年。\n\n他管那叫守时。\n',
    'utf-8',
  );
  // 一份「卷 + 资料区」结构的大纲：拆章拆出 2 行，其中「核心设定」不是章，要走「转设定」
  const outlineNote = path.join(vault, '素材', '晚星大纲.md');
  writeFileSync(
    outlineNote,
    '## 卷零《旧厂区》\n厂区的要点。\n## 卷一《进城》\n进城的要点。\n## 核心设定\n潮汐历、雾钟、铜印。\n',
    'utf-8',
  );
  const foreign = path.join(vault, '别人的笔记.md');
  writeFileSync(foreign, '这行不属于本工具，同步不许碰它。\n', 'utf-8');

  // ---- 阶段一：进程外起一个 server，把库配置好并推一次树 ----
  const port = await freePort();
  const srv = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  await wait(async () => {
    try {
      const r = await fetch(base + '/api/data');
      return r.ok;
    } catch {
      return false;
    }
  }, 15000, '阶段一的服务没起来');
  const put = async (p, body) => (await fetch(base + p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

  await put('/api/obsidian/config', { vaultPath: vault, folder: '工作台' });
  const s1 = await post('/api/obsidian/sync', { projectId: 'ob1' });
  check(s1.pushed.length >= 6, `第一趟该把树推出去，实际推了 ${s1.pushed.length}`);
  say(`阶段一：推出 ${s1.pushed.length} 个文件`, true);
  const tree = readdirSync(path.join(vault, '工作台', '雾港'), { recursive: true }).filter((f) => String(f).endsWith('.md'));
  check(tree.some((f) => String(f).includes('第1章 到港.md')), '章节文件没建出来：' + tree.join(', '));

  // Obsidian 那边动一次：改属性写法 + 加别名 + 追加正文
  const chap1 = path.join(vault, '工作台', '雾港', '章节', '第1章 到港.md');
  const before = readFileSync(chap1, 'utf-8');
  const theirs = rewriteObsidian(before)
    .replace(/^---\n/, '---\naliases:\n  - 老码头\n')
    .replace(/缆桩边。/, '缆桩边，船没有来。');
  check(theirs !== before && theirs.includes('- 老码头') && theirs.includes('船没有来'), '阶段一的库侧改动没造出来');
  writeFileSync(chap1, theirs, 'utf-8');
  // 只改写法、内容没变的那一篇：不该在任何一趟里被牵连
  const chap2 = path.join(vault, '工作台', '雾港', '章节', '第2章 黑车.md');
  writeFileSync(chap2, rewriteObsidian(readFileSync(chap2, 'utf-8')), 'utf-8');
  srv.kill();
  await new Promise((r) => setTimeout(r, 400));
  say('阶段一：库里改了正文、加了别名、另一篇只换写法', true);

  // ---- 阶段二：真实窗口里走作者的同步流程 ----
  // ⑤ 的冲突分支要在「跑起来之后」从进程外改库一次，还要与界面里的改动撞上。
  // 握手方式：界面在第一章正文里打一个标记（800ms 防抖会落进 projects.json），
  // 这里一看到标记就去改第二章的库内文件——两边都改了同一时刻之前的祖先，自动那一趟必然判成冲突。
  const MARK = '自动同步撞车标记';
  const handshake = (async () => {
    // 预算从「界面开始这一步」算起：它前面还有七步，标记要到第九十秒前后才打得上
    const t0 = Date.now();
    for (;;) {
      let hit = false;
      try {
        const ps = JSON.parse(readFileSync(path.join(dataDir, 'projects.json'), 'utf-8'));
        hit = ps.some((p) => (p.chapters || []).some((c) => String(c.content).includes(MARK))); // 别按数组下标认书：夹具里不止一本
      } catch {
        /* 还没落盘 */
      }
      if (hit) break;
      if (Date.now() - t0 > 200000) throw new Error('等界面的撞车标记超时（200s）：前面那些步骤跑完都没打到标记，⑤ 的冲突那段没法判');
      await new Promise((r) => setTimeout(r, 120));
    }
    const theirs = readFileSync(chap2, 'utf-8') + '\n\n库里这一句是撞车时加的。\n';
    writeFileSync(chap2, theirs, 'utf-8');
    return { at: Date.now() - t0, bytes: statSync(chap2).size };
  })();

  handshake.catch(() => {}); // 界面如果半路失败，这里不该用一个「等标记超时」盖住真正的原因
  const child = spawn(electronBin, [root, '--smoke-test', '--no-sandbox'], {
    cwd: root,
    env: { ...process.env, WB_DATA_DIR: dataDir, WB_SMOKE_SCRIPT: driveScript },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const killer = setTimeout(() => {
    console.error('✗ Obsidian 冒烟超时（300s）\n--- 输出 ---\n' + out.slice(-2500));
    child.kill();
    process.exit(1);
  }, 300000);
  await new Promise((r) => child.on('exit', r));
  clearTimeout(killer);
  const hand = await handshake.catch((e) => ({ error: String((e && e.message) || e) }));
  const line = (out.split('\n').find((l) => l.includes('[smoke] OK')) || '').trim();
  // 两半都可能失败：进程外的错别把界面那半的输出盖掉，否则永远只看得到先抛的那个
  if (hand.error) console.log('  （进程外那一半：' + hand.error + '）');
  check(child.exitCode === 0 && line, `渲染进程冒烟失败（退出码 ${child.exitCode}）\n${out.slice(-2500)}`);
  say('阶段二：' + line.replace('[smoke] OK', '').trim(), true);

  // ---- 阶段三：库里的东西到底变成什么样了 ----
  const now1 = readFileSync(chap1, 'utf-8');
  check(now1.includes('- 老码头'), `作者加的别名被同步吃掉了：${now1.slice(0, 240)}`);
  check(now1.includes('船没有来'), '库里的正文被覆盖，作者白改了');
  check(readFileSync(foreign, 'utf-8').includes('不属于本工具'), '别人的笔记被动了');
  check(
    readFileSync(vaultNote, 'utf-8') === '---\ntags:\n  - 场景\ncssclasses: wide\n---\n\n有人在第七根缆桩边等一条不会来的船，等了十一年。\n\n他管那叫守时。\n',
    '被导入的那篇笔记被动过：导入只该读，不该写',
  );
  const store = JSON.parse(readFileSync(path.join(dataDir, 'obsidian-sync.json'), 'utf-8'));
  const entries = Object.values(store)[0].files;
  check(Object.values(entries).every((v) => v.v === 2), `祖先记录该都升级成正文指纹：${JSON.stringify(Object.values(entries).slice(0, 2))}`);
  // 来源路径要真的落在盘上，不是只在 DOM 里亮一下
  const ideas = JSON.parse(readFileSync(path.join(dataDir, 'ideas.json'), 'utf-8'));
  const imp = ideas.find((i) => i.src);
  check(imp && imp.src === '素材/码头听来的.md', `灵感卡没记下来源：${JSON.stringify(ideas)}`);
  check(!/tags:|cssclasses/.test(imp.content), `属性区跟着导进来了：${imp.content.slice(0, 60)}`);
  // ④ 的落点要真的在盘上，不只是渲染进程里读得到
  const projects = JSON.parse(readFileSync(path.join(dataDir, 'projects.json'), 'utf-8'));
  const card = (projects[0].worldItems || []).find((w) => w.name === '码头传闻');
  const outlineCard = (projects[0].worldItems || []).find((w) => w.name === '核心设定');
  check(outlineCard && /潮汐历/.test(outlineCard.content || ''), `「转设定」的行没落成设定卡：${JSON.stringify((projects[0].worldItems || []).map((w) => w.name))}`);
  check(!(projects[0].chapters || []).some((x) => /核心设定/.test(x.title || '')), '资料区标题还是进了章');
  check(card && /守时/.test(card.content || ''), `设定卡没落到盘上：${JSON.stringify((projects[0].worldItems || []).map((w) => w.name))}`);
  check(card.kind === '设定', '设定卡类型不对：' + card.kind);
  check(!/tags:|cssclasses/.test(card.content), '属性区跟着导进了卡');
  const beats = projects[0].chapters[0].beats || '';
  check(beats.includes('〔导入·码头听来的〕'), `章要点没并进那一章：${JSON.stringify(beats).slice(0, 80)}`);
  check(!/\n\n/.test(beats), '并进要点的笔记该压成一行');
  check(/^要点：到港/.test(beats) || beats.split('\n').length === 2, `并进时把原有要点弄丢了：${JSON.stringify(beats).slice(0, 120)}`);
  const byId = Object.fromEntries(projects.map((p) => [p.id, p]));
  const 新章 = (byId.ob1.chapters || []).find((x) => /他管那叫守时/.test(x.content || ''));
  check(新章, `追加的新章没落到盘上：${JSON.stringify((byId.ob1.chapters || []).map((c) => c.title))}`);
  check(!/tags:|cssclasses/.test(新章.content), '新章里混进了属性区');
  // 单篇草稿：追加落点把内容拼成一段接在正文末尾，mode 与章结构都不许动
  check((byId.ob2.chapters || []).length === 0 && byId.ob2.mode === 'single', '单篇那本书的结构被动了');
  check(/^一篇还没分章的短稿，就这样被看见。/.test(byId.ob2.draft || '') && /他管那叫守时/.test(byId.ob2.draft || ''), '单篇草稿没接到正文末尾：' + JSON.stringify(byId.ob2.draft));
  // 新建作品落点：书名取自文件名，一整篇无章名 → 单篇草稿
  const 新书 = projects.find((p) => p.title === '码头听来的');
  check(新书 && /他管那叫守时/.test(新书.draft || ''), `新建的作品没落到盘上：${JSON.stringify(projects.map((p) => p.title))}`);
  check((新书.chapters || []).length === 0, '一整篇没有章名的内容该走单篇草稿');
  // ⑤ 自动同步：界面报了一句「自动同步 → 库内」，就得真的在库里的文件上看得见
  check(now1.includes('自动同步该把这句推出去'), `自动同步没把新写的句子推进库：${now1.slice(-160)}`);
  check(now1.includes('- 老码头'), '自动同步把他在库里加的别名冲掉了');
  say('阶段三：别名保住、库里正文没被覆盖、别人笔记未动、来源已落盘、祖先表已升级、导入的卡与要点都在盘上、单篇草稿按新口径接进正文', true);
} catch (err) {
  say(String((err && err.message) || err), false);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
  if (clipMark) await runClip('write', clipBackup); // 把用户原来的剪贴板还回去（只还原文本格式）
}

if (failures) {
  console.error(`✗ Obsidian 冒烟失败（${failures} 项）`);
  process.exit(1);
}
console.log(`✓ Obsidian 双向同步的真实窗口冒烟通过（数据目录 ${dataDir} 已清理，未触碰真实数据）`);
