// 新功能（AI 工坊 OOC/钩子 + 体检四页签 + 冲刺 + 选中即查）的真实窗口冒烟：
// 起一个本地 mock 大模型（OpenAI SSE 协议的罐头回话），把「点动作 → 服务端转发 → 流式回执渲染」
// 全链路跑通；mock 收到的提示词落盘，冒烟侧核对「人物卡与正文真的送进去了」。
// 提示词拼装本身的判据在 tests/ai-prompt.test.ts，这条只管界面接缝与转发链路。
// 用法：npm run build && node tests/ui-feature-smoke.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { bundleDrive } from './ui-drive-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const drivePath = path.join(root, 'tests', 'ui-feature-drive.js');

if (!existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('缺少 dist/index.html，请先执行 npm run build');
  process.exit(1);
}
const electronDir = path.join(root, 'node_modules', 'electron');
const electronBin = path.join(electronDir, 'dist', readFileSync(path.join(electronDir, 'path.txt'), 'utf-8').trim());

const dataDir = mkdtempSync(path.join(tmpdir(), 'wb-feat-'));

// ---------- mock 大模型：按请求里的关键词回罐头话，把请求体落盘供冒烟侧核对 ----------
let captured = 0;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    captured += 1;
    writeFileSync(path.join(dataDir, `mock-${captured}.json`), JSON.stringify({ url: req.url, body }, null, 2), 'utf-8');
    const text = body.includes('钩子')
      ? 'MOCK-HOOK-评级：开头——弱，理由：还没有立起悬念。结尾——强，理由：以「灯塔亮了」收束，钩子留住。'
      : 'MOCK-OOC-结论：第 2 句台词「今日天气不错」与「老烟」的干练口吻不符，太文绉绉。其余台词对味。';
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const mockPort = mock.address().port;

// ---------- 种子数据：ai.json 指向 mock；一本书两章（含口头禅、禁用词、人物卡） ----------
const now = new Date().toISOString();
writeFileSync(
  path.join(dataDir, 'ai.json'),
  JSON.stringify({ provider: 'custom', baseUrl: `http://127.0.0.1:${mockPort}/v1`, model: 'mock-1', protocol: 'openai', apiKey: 'sk-mock', rules: [], memoryExtract: false, gateDraft: false, judgeOnly: false }, null, 2),
  'utf-8',
);
const ch = (id, title, content) => ({
  id,
  title,
  content,
  volume: '第一卷',
  beats: '',
  summary: '',
  cast: id === 'c1' ? '老烟' : '',
  places: '',
  hooks: '',
  createdAt: now,
  updatedAt: now,
});
// 「码头」四次、前后字都换着来（口头禅的极大性判得出来）；「瞬间」两处喂禁用词
const c1 =
  '雾还没散，老烟蹲在码头边上。\n他数着码头的缆桩，数到第七根就停了。\n「今日天气不错。」老烟说。\n瞬间，灯塔亮了。\n又一瞬间，雾散了。码头的方向传来汽笛。';
const project = {
  id: 'ft1',
  title: '雾港',
  type: '玄幻',
  status: '写作中',
  deadline: '',
  notes: '',
  draft: '',
  linkedIdeaIds: [],
  mode: 'chapters',
  chapters: [ch('c1', '第七根缆桩', c1), ch('c2', '雾钟', '雾钟挂在梁上。')],
  characters: [{ id: 'pc1', name: '老烟', state: '戒了三天的烟', log: [], relations: [], bio: '' }],
  worldItems: [],
  marks: [],
  game: { forbidden: ['瞬间'] },
  createdAt: now,
  updatedAt: now,
};
writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project], null, 2), 'utf-8');

const driveScript = bundleDrive(dataDir, drivePath);

let child = null;
let failed = false;
const kill = () => {
  if (child && child.exitCode === null) child.kill('SIGINT');
};
process.on('exit', () => {
  kill();
  mock.close();
});
process.on('SIGINT', () => {
  kill();
  mock.close();
  process.exit(130);
});

let childOut = '';
try {
  const out = await new Promise((resolve, reject) => {
    child = spawn(electronBin, [root, '--smoke-test', '--no-sandbox'], {
      cwd: root,
      env: { ...process.env, WB_DATA_DIR: dataDir, WB_SMOKE_SCRIPT: driveScript },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      childOut = buf;
    });
    child.stderr.on('data', (d) => {
      buf += d;
      childOut = buf;
    });
    const killer = setTimeout(() => {
      child.kill('SIGINT');
      reject(new Error('新功能冒烟超时（150s）\n' + buf.slice(-2000)));
    }, 150000);
    child.on('exit', (code) => {
      clearTimeout(killer);
      if (code === 0) resolve(buf);
      else reject(new Error('渲染进程冒烟失败（退出码 ' + code + '）\n' + buf.slice(-2600)));
    });
  });
  const ok = out.split('\n').filter((l) => l.includes('[smoke]')).join('\n');
  console.log('✓ 新功能真实窗口冒烟通过\n' + ok.split('\n').map((l) => '  ' + l.trim()).join('\n'));

  // ---------- 盘上核对：mock 收到的提示词 + 冲刺成绩落库 ----------
  if (captured < 2) throw new Error(`mock 只收到 ${captured} 次请求，OOC/钩子没都发出去`);
  const oocReq = readFileSync(path.join(dataDir, 'mock-1.json'), 'utf-8');
  const hookReq = readFileSync(path.join(dataDir, 'mock-2.json'), 'utf-8');
  if (!oocReq.includes('雾还没散')) throw new Error('OOC 的提示词里没有本章正文');
  if (!oocReq.includes('老烟')) throw new Error('OOC 的提示词里没有人物卡（cast 名单没带出人物）');
  if (!oocReq.includes('像本人')) throw new Error('OOC 的提示词丢了判据描述');
  if (!hookReq.includes('【开头】') || !hookReq.includes('【结尾】')) throw new Error('钩子体检的提示词没有头尾两截');
  if (hookReq.includes('雾钟挂在梁上')) throw new Error('钩子体检把第二章也送进去了？只该送当前章');
  const stats = JSON.parse(readFileSync(path.join(dataDir, 'stats.json'), 'utf-8'));
  if (!Array.isArray(stats.sprints) || stats.sprints.length !== 1) throw new Error('冲刺成绩没落库：' + JSON.stringify(stats.sprints ?? null));
  if (stats.sprints[0].minutes < 1) throw new Error('冲刺时长取整不对：' + JSON.stringify(stats.sprints[0]));
  console.log(`  盘上核对：mock 收到 ${captured} 条提示词（OOC 带人物卡与正文、钩子只带头尾）、冲刺成绩 ${stats.sprints.length} 条已入 stats.json`);
} catch (err) {
  failed = true;
  console.error('✗ ' + String((err && err.message) || err));
  if (!(err && err.message || '').includes('退出码')) {
    const trace = (childOut || '').split('\n').filter((l) => l.includes('[smoke]'));
    if (trace.length) console.error('已完成的步骤：\n' + trace.map((l) => '  ' + l.trim()).join('\n'));
  }
} finally {
  kill();
  mock.close();
  rmSync(dataDir, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log('✓ 新功能冒烟通过（数据目录已清理，未触碰真实数据）');
