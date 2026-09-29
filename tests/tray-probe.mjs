// 关闭保护探测：验证「点窗口 X = 最小化到托盘，而不是退出进程」。
// 启动真实 electron（隔离数据目录），主进程 WB_TRAY_PROBE 模式下 1.5s 后自动触发 win.close()，
// 若关闭被正确拦截成 hide：进程存活、窗口不可见 → 打印 [tray-probe] OK 退出 0。
// 若保护被改坏（直接关闭）：窗口销毁 → 进程按 window-all-closed 退出 → 无 OK / 退出码异常 → 失败。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// electron 包不在普通 Node 里 require，直接按官方结构拼可执行文件路径
const electronDir = path.join(root, 'node_modules', 'electron');
const binName = readFileSync(path.join(electronDir, 'path.txt'), 'utf-8').trim();
const electronBin = path.join(electronDir, 'dist', binName);

function run() {
  return new Promise((resolve, reject) => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'wb-tray-'));
    const args = [root, '--no-sandbox']; // 受限会话需要 no-sandbox（真实桌面不需要，探测逻辑不受影响）
    const child = spawn(electronBin, args, {
      cwd: root,
      env: { ...process.env, WB_TRAY_PROBE: '1', WB_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      cleanup();
      reject(new Error('超时未退出（进程疑似被关闭保护正确挂起，但未打印 OK）\n--- 输出 ---\n' + out.slice(-800)));
    }, 40000);
    const cleanup = () => {
      clearTimeout(timer);
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    };
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => {
      clearTimeout(timer);
      cleanup();
      if (out.includes('[tray-probe] OK')) {
        const line = out.split('\n').find((l) => l.includes('[tray-probe] OK'))?.trim() || '';
        console.log('  ✓ ' + line);
        resolve();
      } else {
        reject(new Error(`未检测到 OK 标记（退出码 ${code}）\n--- 输出 ---\n` + out.slice(-800)));
      }
    });
  });
}

console.log('托盘关闭保护探测（真实 electron 窗口，隔离数据目录）：');
try {
  await run();
  console.log('✓ 关闭保护有效：点 X 不再退出进程');
  process.exit(0);
} catch (err) {
  console.error('✗ ' + (err?.message || err));
  process.exit(1);
}
