/**
 * 打包输出目录自动选择器（替代手写 -c.directories.output=releaseN）
 *
 * 背景：本机杀软/云盘同步进程会长期握着上一轮的 app.asar，electron-builder 覆盖时报
 *       `app.asar: The process cannot access the file`，只能人工换一个新目录重跑。
 * 做法：先探最新一份 release 系列目录里的 app.asar 能不能改名（能改名 = builder 也覆盖得动），
 *       可以就原地复用；不行（被占用 / 目录还没产物）就顺延到下一个空闲名字。
 * 命名：始终维持 /^release\d*$/（release、release2、release3…），这样
 *       check-parity.mjs 与 check-dist.mjs 的「自动找最近产出目录」逻辑照旧生效。
 *
 * 用法：node scripts/dist.mjs [--dry-run]   --dry-run 只打印选中的目录，不真打包
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME_RE = /^release(\d*)$/;

/** 名字 → 目录名：1 用裸名 release，其余 releaseN */
const nameOf = (i) => (i === 1 ? 'release' : `release${i}`);

/** 现存的 release* 目录名，按「最近产出」排序（同 check-dist.mjs，用 mtime 新→旧） */
function existingReleaseDirs() {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && NAME_RE.test(d.name))
    .map((d) => ({ name: d.name, time: safeMtime(path.join(root, d.name)) }))
    .sort((a, b) => b.time - a.time)
    .map((d) => d.name);
}

function safeMtime(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** 下一个空闲名字：已有最大序号 + 1（一个都没有时就是裸 release） */
function nextFreeName(taken) {
  let max = 0;
  for (const name of taken) {
    const m = NAME_RE.exec(name);
    if (m) max = Math.max(max, m[1] ? Number(m[1]) : 1);
  }
  let n = max || 1;
  while (taken.includes(nameOf(n))) n += 1;
  return nameOf(n);
}

/** 锁定位候选：<dir>/win-unpacked/resources 下的 app.asar（退而求其次任意 .asar） */
function lockCandidate(dirName) {
  const res = path.join(root, dirName, 'win-unpacked', 'resources');
  if (!existsSync(res)) return null;
  let asars = [];
  try {
    asars = readdirSync(res).filter((f) => /\.asar$/i.test(f));
  } catch {
    return null; // 连目录都读不动，等同不可复用
  }
  if (!asars.length) return null;
  return path.join(res, asars.includes('app.asar') ? 'app.asar' : asars[0]);
}

/**
 * 为什么用「改名再改回」当探针：Windows 下文件被别的进程开着、且对方没给 FILE_SHARE_DELETE
 * 时（杀软扫描、云盘同步就是这种），改名会被直接拒绝；而 electron-builder 覆盖 app.asar
 * 卡住的正是同一份写权限，所以「能不能改名」比 access() 只看属性位真实得多。
 * 探针不改内容，成功就立刻改回原名；万一改回失败会尽力补救并报不可复用。
 */
function probeReusable(dirName) {
  const target = lockCandidate(dirName);
  if (!target) return { ok: false, why: `${dirName}/ 下没有 app.asar 可探测（尚未产出或目录为空）` };
  const rel = path.relative(root, target).replace(/\\/g, '/');
  const staging = `${target}.probe-rename`;
  try {
    renameSync(target, staging);
  } catch (err) {
    return { ok: false, why: `${rel} 被第三方进程占用（${err.code || err.message}），覆盖必失败` };
  }
  try {
    renameSync(staging, target);
    return { ok: true, why: `${rel} 可改名，未被占用` };
  } catch (err) {
    // 极端情况：改出后改不回。再试一次，失败就留着 .probe-rename 让 builder 自己重铺
    try {
      renameSync(staging, target);
    } catch {
      /* 交给下一次打包覆盖，不做删除类操作 */
    }
    return { ok: false, why: `${rel} 改名后无法改回（${err.code || err.message}）` };
  }
}

function chooseOutputDir() {
  const dirs = existingReleaseDirs();
  if (!dirs.length) {
    const chosen = nextFreeName(dirs);
    return { chosen, reason: `本机还没有 release* 产物，用新目录 ${chosen}/` };
  }
  const newest = dirs[0];
  const { ok, why } = probeReusable(newest);
  if (ok) return { chosen: newest, reason: why };
  const chosen = nextFreeName(dirs);
  return { chosen, reason: `${why}；顺延到新目录 ${chosen}/` };
}

const dryRun = process.argv.includes('--dry-run');
const { chosen, reason } = chooseOutputDir();
console.log(`[dist] 输出目录：${chosen}/`);
console.log(`[dist] 选择原因：${reason}`);

if (dryRun) {
  console.log('[dist] --dry-run：只选目录，不调用 electron-builder');
  process.exit(0);
}

// 打包目标从 package.json 的 build.win.target 读（nsis/portable/zip…）——
// 之前硬编码 nsis portable，往 package.json 里加的 zip 目标永远不进 dist，白配。
const pkgTargets = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'))?.build?.win?.target?.map((t) =>
  typeof t === 'string' ? t : t.target,
) ?? [];
const targets = pkgTargets.length ? pkgTargets : ['nsis', 'portable'];

const args = ['electron-builder', '--win', ...targets, `-c.directories.output=${chosen}`];
console.log(`[dist] 执行：npx ${args.join(' ')}`);

// Windows 上 npx 其实是 npx.cmd，得让 cmd.exe 来解析，所以拼成整条命令串走 shell
// （chosen 由上面的正则与 nameOf 生成，只有 release / releaseN 两种形状，不含空格与元字符）；
// POSIX 下不必套 shell，直接交给 spawn 传参数数组。
const child = process.platform === 'win32'
  ? spawn(`npx ${args.join(' ')}`, { cwd: root, stdio: 'inherit', shell: true })
  : spawn('npx', args, { cwd: root, stdio: 'inherit' });
child.on('error', (err) => {
  console.error(`[dist] 启动 electron-builder 失败：${err.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
