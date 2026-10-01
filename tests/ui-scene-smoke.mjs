// 场景板的真实窗口冒烟：起 Electron（隐藏窗口 + 隔离数据目录），注入 tests/ui-scene-drive.js，
// 让它真拖一次、真搬一次、真退回一次，再从盘上核对两章正文。
// 切块本身的判据在 tests/scenes.test.ts（纯函数，15 种形状逐字节往返），这条只管界面接缝。
// 用法：npm run build && node tests/ui-scene-smoke.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleDrive } from './ui-drive-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const drivePath = path.join(root, 'tests', 'ui-scene-drive.js');

if (!existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('缺少 dist/index.html，请先执行 npm run build');
  process.exit(1);
}
const electronDir = path.join(root, 'node_modules', 'electron');
const electronBin = path.join(electronDir, 'dist', readFileSync(path.join(electronDir, 'path.txt'), 'utf-8').trim());

const dataDir = mkdtempSync(path.join(tmpdir(), 'wb-scene-'));
const driveScript = bundleDrive(dataDir, drivePath); // 公共助手 + 驱动，拼好写进隔离目录
const now = new Date().toISOString();
const ch = (id, title, content) => ({
  id,
  title,
  content,
  volume: '第一卷',
  beats: '',
  summary: '',
  cast: '',
  places: '',
  hooks: '',
  createdAt: now,
  updatedAt: now,
});
// 三块各是「一行标题 + 一行正文」：卡片摘录取首行，断言才写得出准确文字
const c1 = '缆桩\n雾还没散，他蹲在第七根缆桩边。\n\n灯塔\n灯灭了整夜。\n\n桥洞\n桥洞下面有人吹口哨。';
const project = {
  id: 'sc1',
  title: '雾港',
  type: '玄幻',
  status: '写作中',
  deadline: '',
  notes: '',
  draft: '',
  linkedIdeaIds: [],
  mode: 'chapters',
  chapters: [
    ch('c1', '第七根缆桩', c1),
    ch('c2', '雾钟', '雾钟挂在梁上。'),
    ch('c3', '空章', ''),
    // 单换行分段的一篇：切不出多块时要退到段粒度，并把这件事说出来
    ch('c4', '段粒度', '甲站在门口。\n乙在身后说话。\n丙没有回头。'),
  ],
  characters: [],
  worldItems: [],
  marks: [],
  createdAt: now,
  updatedAt: now,
};
writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project], null, 2), 'utf-8');

let child = null;
let failed = false;
const kill = () => {
  if (child && child.exitCode === null) child.kill('SIGINT');
};
process.on('exit', kill);
process.on('SIGINT', () => {
  kill();
  process.exit(130);
});

try {
  const out = await new Promise((resolve, reject) => {
    child = spawn(electronBin, [root, '--smoke-test', '--no-sandbox'], {
      cwd: root,
      env: { ...process.env, WB_DATA_DIR: dataDir, WB_SMOKE_SCRIPT: driveScript },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    child.stdout.on('data', (d) => (buf += d));
    child.stderr.on('data', (d) => (buf += d));
    const killer = setTimeout(() => {
      child.kill('SIGINT');
      reject(new Error('场景板冒烟超时（120s）\n' + buf.slice(-2000)));
    }, 120000);
    child.on('exit', (code) => {
      clearTimeout(killer);
      if (code === 0) resolve(buf);
      else reject(new Error('渲染进程冒烟失败（退出码 ' + code + '）\n' + buf.slice(-2000)));
    });
  });
  const ok = out.split('\n').filter((l) => l.includes('[smoke]')).join('\n');
  console.log('✓ 场景板真实窗口冒烟通过\n' + ok.split('\n').map((l) => '  ' + l.trim()).join('\n'));
  const here = JSON.parse(readFileSync(path.join(dataDir, 'projects.json'), 'utf-8'))[0].chapters;
  const c1now = here.find((x) => x.id === 'c1').content;
  const c2now = here.find((x) => x.id === 'c2').content;
  if (/桥洞/.test(c2now)) throw new Error('退回没把别章那块取回来：' + JSON.stringify(c2now));
  if ((c1now.match(/桥洞/g) || []).length !== 2) throw new Error('退回后本章的桥洞块不完整：' + JSON.stringify(c1now));
  if (!c1now.startsWith('灯塔')) throw new Error('退回把重排也丢了：' + JSON.stringify(c1now));
  console.log('  落库核对：桥洞块回到本章、别章干净、重排结果还在');
} catch (err) {
  failed = true;
  console.error('✗ ' + String((err && err.message) || err));
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log('✓ 场景板冒烟通过（数据目录已清理，未触碰真实数据）');
