// 稳定性压测：起真实 Electron + 隔离数据目录，先塞「120 章长书 + 3 万字单篇 + 200 条灵感」，
// 再让驱动在真实窗口里反复横跳：视图往返 / 随机切章 / 打字洪峰 / 浮层开关，全程量时延、
// 数 DOM、盯未捕获异常。任何一项破预算或冒出错误就红——「感觉像浏览器套壳」要用数字说话。
// 用法：npm run build && npm run test:stability
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleDrive } from './ui-drive-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const drivePath = path.join(root, 'tests', 'stability-drive.js');

if (!existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('缺少 dist/index.html，请先执行 npm run build');
  process.exit(1);
}

const electronDir = path.join(root, 'node_modules', 'electron');
const binName = readFileSync(path.join(electronDir, 'path.txt'), 'utf-8').trim();
const electronBin = path.join(electronDir, 'dist', binName);
const dataDir = mkdtempSync(path.join(tmpdir(), 'wb-stab-'));

// ---------- 种子数据：够大才有代表性 ----------

const CHAPTERS = 120;
const chapterBody = (c) =>
  Array.from({ length: 12 }, (_, k) => `第${c}章第${k}段：雾从缆桩间漫上来，潮声与灯影交错，林越数着自己的脚印，把名字写在被水泡涨的纸片上。`).join('\n');
const now = new Date().toISOString();
const mk = (id, title, body) => ({
  id,
  title,
  content: body,
  summary: '',
  volume: '',
  beats: '',
  createdAt: now,
  updatedAt: now,
});
const bigBook = {
  id: 'stab1',
  title: '压测长书',
  type: '小说',
  status: '写作中',
  deadline: '',
  target: 0,
  notes: '',
  draft: '',
  linkedIdeaIds: [],
  mode: 'chapters',
  chapters: Array.from({ length: CHAPTERS }, (_, i) => mk(`sc${i + 1}`, `压测第${i + 1}章`, chapterBody(i + 1))),
  characters: [],
  worldItems: [],
  marks: [],
  createdAt: now,
  updatedAt: now,
};
const longDraft = Array.from({ length: 300 }, (_, i) => `第${i + 1}段：单篇压测用的长正文，句子越平凡越好，只要字数够多。`).join('\n');
const single = {
  id: 'stab2',
  title: '压测单篇',
  type: '文章',
  status: '写作中',
  deadline: '',
  target: 0,
  notes: '',
  draft: longDraft,
  linkedIdeaIds: [],
  mode: 'single',
  chapters: [],
  characters: [],
  worldItems: [],
  marks: [],
  createdAt: now,
  updatedAt: now,
};
const ideas = Array.from({ length: 200 }, (_, i) => ({
  id: `si${i + 1}`,
  content: `压测灵感第${i + 1}条：码头、雾、守时的疯子。`,
  kind: '素材',
  tags: ['压测'],
  pinned: false,
  createdAt: now,
}));

mkdirSync(dataDir, { recursive: true });
writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([bigBook, single], null, 2), 'utf-8');
writeFileSync(path.join(dataDir, 'ideas.json'), JSON.stringify(ideas, null, 2), 'utf-8');

const driveScript = bundleDrive(dataDir, drivePath);

const child = spawn(electronBin, [root, '--smoke-test', '--no-sandbox'], {
  cwd: root,
  env: { ...process.env, WB_DATA_DIR: dataDir, WB_SMOKE_SCRIPT: driveScript },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));

const timer = setTimeout(() => {
  console.error('✗ 稳定性压测超时（300s）\n--- 输出 ---\n' + out.slice(-2500));
  child.kill();
  setTimeout(() => process.exit(1), 500);
}, 300000);

function finish(code, message) {
  clearTimeout(timer);
  rmSync(dataDir, { recursive: true, force: true });
  console.log(message);
  process.exit(code);
}

child.on('exit', (code) => {
  const ok = code === 0 && out.includes('[smoke] OK');
  if (!ok) {
    return finish(1, `✗ 稳定性压测失败（退出码 ${code}）\n--- 输出摘录 ---\n${out.slice(-3000)}`);
  }
  const line = out.split('\n').find((l) => l.includes('[smoke] OK')) || '';
  finish(0, `✓ 稳定性压测通过\n  ${line.replace('[smoke] OK', '').trim()}\n  （数据目录已清理，未触碰真实数据）`);
});
