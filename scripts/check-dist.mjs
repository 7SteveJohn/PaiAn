// 打包产物冒烟：以 --smoke-test 启动 release 下的解包版 exe，等它自检退出。
// 用途：npm run dist 之后自动确认「打出来的桌面版能起服务、能挂载界面」。
// 用法：node scripts/check-dist.mjs [目录]   （默认 release/win-unpacked）
import { spawn } from 'node:child_process';
import { readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 打包常因旧 app.asar 被第三方进程占用而换输出目录，这里自动挑最近产出的那一份
function pickDir() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  const cands = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^release\d*$/.test(d.name))
    .map((d) => path.join(root, d.name, 'win-unpacked'))
    .filter((p) => existsSync(p) && readdirSync(p).some((f) => f.toLowerCase().endsWith('.exe')))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  return cands[cands.length - 1] || path.join(root, 'release', 'win-unpacked');
}

const dir = pickDir();

if (!existsSync(dir)) {
  console.error(`找不到解包目录：${dir}\n请先执行 npm run dist（或给脚本传目录：node scripts/check-dist.mjs release2/win-unpacked）`);
  process.exit(1);
}
const exe = readdirSync(dir).find((f) => f.toLowerCase().endsWith('.exe') && !/^unins/i.test(f));
if (!exe) {
  console.error(`目录内未找到主 exe：${dir}`);
  process.exit(1);
}
const target = path.join(dir, exe);
// --no-sandbox：CI / 受限/远程会话里 GPU 进程起不来会直接 FATAL，加上它不影响正常桌面
console.log(`冒烟启动：${target} --smoke-test`);

const child = spawn(target, ['--smoke-test', '--no-sandbox'], { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));

const timeout = setTimeout(() => {
  console.error('✗ 超时（40s）未退出。若目标是旧版本安装包，它不认识 --smoke-test 会正常开窗——请用重新打包的产物验证。');
  console.error('--- 输出摘录 ---\n' + out.slice(-1500));
  child.kill();
  process.exit(1);
}, 40000);

child.on('exit', (code) => {
  clearTimeout(timeout);
  const ok = code === 0 && out.includes('[smoke] OK');
  if (ok) {
    console.log('✓ 桌面版自检通过：' + out.split('[smoke] OK')[1].split('\n')[0].trim());
    process.exit(0);
  }
  console.error(`✗ 桌面版自检失败（退出码 ${code}）`);
  console.error('--- 输出摘录 ---\n' + (out.slice(-1500) || '（无输出）'));
  process.exit(1);
});
