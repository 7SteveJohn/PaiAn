// UI 主路径冒烟：起真实 Electron（隐藏窗口 + 隔离数据目录），注入 tests/ui-drive.js，
// 让它真实点击一遍「新建作品 → 写章 → 自动保存 → 校验落库」。
// 用法：npm run build && npm run test:ui
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleDrive } from './ui-drive-bundle.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const drivePath = path.join(root, 'tests', 'ui-drive.js');

if (!existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('缺少 dist/index.html，请先执行 npm run build');
  process.exit(1);
}

// electron 包不在普通 Node 里 require，直接按官方结构拼可执行文件路径
const electronDir = path.join(root, 'node_modules', 'electron');
const binName = readFileSync(path.join(electronDir, 'path.txt'), 'utf-8').trim();
const electronBin = path.join(electronDir, 'dist', binName);
const dataDir = mkdtempSync(path.join(tmpdir(), 'wb-ui-'));
const driveScript = bundleDrive(dataDir, drivePath); // 公共助手 + 驱动，拼好写进隔离目录

const child = spawn(electronBin, [root, '--smoke-test', '--no-sandbox'], {
  cwd: root,
  env: { ...process.env, WB_DATA_DIR: dataDir, WB_SMOKE_SCRIPT: driveScript },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));

const timer = setTimeout(() => {
  console.error('✗ UI 冒烟超时（90s）\n--- 输出 ---\n' + out.slice(-2000));
  child.kill();
  setTimeout(() => process.exit(1), 500);
}, 90000);

function finish(code, message) {
  clearTimeout(timer);
  rmSync(dataDir, { recursive: true, force: true });
  console.log(message);
  process.exit(code);
}

child.on('exit', (code) => {
  const ok = code === 0 && out.includes('[smoke] OK');
  if (!ok) {
    return finish(1, `✗ UI 冒烟失败（退出码 ${code}）\n--- 输出摘录 ---\n${out.slice(-2500)}`);
  }
  const line = out.split('\n').find((l) => l.includes('[smoke] OK')) || '';
  const trace = line.includes('UI 主路径') ? line.split('UI 主路径：')[1].trim() : '';
  finish(0, `✓ UI 主路径冒烟通过\n  ${trace || line.trim()}\n  （数据目录 ${dataDir} 已清理，未触碰真实数据）`);
});
