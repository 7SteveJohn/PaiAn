/**
 * 产物-源码一致性守卫
 *
 * 目的：防止"打包了旧代码"这类隐性漂移。之前踩过一次——exe 落后源码 6 个提交而无人察觉。
 * 做法：解开 app.asar，把包内的 dist/**、server.js、electron/**、server-lib/** 与当前源码构建产物
 *       逐文件比 sha1；包内 package.json 只校验 version 与运行时 dependencies（其余字段会被
 *       electron-builder 正常裁剪，不算漂移）。
 *
 * 用法：node scripts/check-parity.mjs [asar路径或 win-unpacked 目录]
 * 退出码：0=一致（或跳过），1=发现漂移
 */
import { existsSync, readdirSync, readFileSync, statSync, rmSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 只对这些文本后缀做行尾规范化：本机 core.autocrlf=true，git checkout 会把 LF smudge 成 CRLF，
// 不规范化会导致"内容其实一致、字节不同"的误报。二进制文件（图片/字体等）保持原样比较。
const TEXT_EXT = /\.(js|cjs|mjs|json|html|css|map|svg|txt|md)$/i;

function sha1(p) {
  const buf = readFileSync(p);
  if (!TEXT_EXT.test(path.extname(p))) return createHash('sha1').update(buf).digest('hex');
  return createHash('sha1').update(buf.toString('utf8').replace(/\r\n/g, '\n')).digest('hex');
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p));
  }
  return out;
}

/** 扫描最新的 releaseN/ 里 win-unpacked 下的 app.asar */
function findAsar(arg) {
  if (arg) {
    if (arg.endsWith('.asar')) return existsSync(arg) ? arg : null;
    const cand = path.join(arg, 'resources', 'app.asar');
    return existsSync(cand) ? cand : null;
  }
  const dirs = readdirSync(root)
    .filter((d) => /^release\d*$/.test(d))
    .map((d) => ({
      name: d,
      time: statSync(path.join(root, d)).mtimeMs,
      asar: path.join(root, d, 'win-unpacked', 'resources', 'app.asar'),
    }))
    .filter((d) => existsSync(d.asar))
    .sort((a, b) => b.time - a.time);
  return dirs.length ? dirs[0].asar : null;
}

const asarPath = findAsar(process.argv[2]);
if (!asarPath) {
  console.log('⊘ 未找到打包产物，跳过一致性校验（先跑 npm run dist）');
  process.exit(0);
}

let asar;
try {
  asar = await import('@electron/asar');
} catch {
  console.log('⊘ 缺少 @electron/asar，跳过一致性校验');
  process.exit(0);
}

const tmp = mkdtempSync(path.join(tmpdir(), 'wb-parity-'));
const extracted = path.join(tmp, 'app');
const problems = [];
let compared = 0;

try {
  asar.extractAll(asarPath, extracted);

  // 1) dist 全量比对（界面代码）
  const localDist = path.join(root, 'dist');
  if (!existsSync(localDist)) {
    problems.push('本地 dist/ 不存在，无法比对（先跑 npm run build）');
  } else {
    for (const rel of walk(localDist)) {
      const a = path.join(extracted, 'dist', rel);
      const b = path.join(localDist, rel);
      compared++;
      if (!existsSync(a)) problems.push(`包内缺失 dist/${rel}`);
      else if (sha1(a) !== sha1(b)) problems.push(`内容漂移 dist/${rel}`);
    }
  }

  // 2) 服务端与主进程比对接（逻辑代码；server-lib 是拆出去的纯数据层，漏打包会表现为「启动即 500」）
  // electron/ 与 server-lib/ 都按目录枚举：新增文件（如 preload.cjs）自动纳入比对，不会漏检
  const serverFiles = ['server.js', ...walk(path.join(root, 'electron')).map((r) => path.join('electron', r)), ...walk(path.join(root, 'server-lib')).map((r) => path.join('server-lib', r))];
  for (const rel of serverFiles) {
    const a = path.join(extracted, rel);
    const b = path.join(root, rel);
    compared++;
    if (!existsSync(a)) problems.push(`包内缺失 ${rel}`);
    else if (sha1(a) !== sha1(b)) problems.push(`内容漂移 ${rel}`);
  }

  // 3) package.json 只校验版本与运行时依赖（其余字段被 builder 裁剪属正常）
  const packed = JSON.parse(readFileSync(path.join(extracted, 'package.json'), 'utf8'));
  const local = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  compared++;
  if (packed.version !== local.version) {
    problems.push(`版本号不一致：包内 ${packed.version} vs 源码 ${local.version}`);
  }
  const depA = Object.keys(packed.dependencies || {}).sort().join(',');
  const depB = Object.keys(local.dependencies || {}).sort().join(',');
  if (depA !== depB) problems.push(`运行时依赖不一致：\n    包内 ${depA}\n    源码 ${depB}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (problems.length) {
  console.error(`\n✗ 包产物与当前源码不一致（已比对 ${compared} 项）：`);
  for (const p of problems) console.error('  - ' + p);
  console.error('\n→ 说明包是用旧代码打的，重新执行 npm run dist 即可对齐。\n');
  process.exit(1);
}

console.log(`✓ 产物一致性校验通过：${path.relative(root, asarPath)} 与当前源码逐字节一致（${compared} 项）`);
