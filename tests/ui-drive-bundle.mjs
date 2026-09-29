// 把公共助手片段（ui-drive-helpers.js）拼在驱动前面写进临时文件。
// 驱动被 electron/main.cjs 当字符串 executeJavaScript，不能 import——
// 共享只能由冒烟脚本在启动前拼好；临时文件放进各自的 dataDir，随它一起清理。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPERS = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui-drive-helpers.js'), 'utf-8');

export function bundleDrive(dir, drivePath) {
  const out = path.join(dir, path.basename(drivePath));
  writeFileSync(out, HELPERS + '\n' + readFileSync(drivePath, 'utf-8'));
  return out;
}
