// npm test 入口：把 TS 测试套件 esbuild 打包成单个 ESM，再交给 node --test 执行。
// 不新增任何运行时/测试依赖（esbuild 已在 devDependencies 中，vite 自带）。
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = path.join(root, 'tests');
const outDir = path.join(root, '.tmp-tests');
// 每个 *.test.ts / *.test.tsx 都是一个独立测试文件
const entries = readdirSync(testsDir)
  .filter((f) => /\.test\.tsx?$/.test(f))
  .sort()
  .map((f) => path.join(testsDir, f));

mkdirSync(outDir, { recursive: true });
let code = 1;
try {
  await build({
    entryPoints: entries,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outdir: outDir,
    outExtension: { '.js': '.test.mjs' },
    // 部分依赖是 CJS（react-dom/server、lucide-react），被打成 ESM 后会动态 require 内建模块而报错。
    // 注入真 require 让这类模块照常工作，不必逐个声明 external。
    // 组件读写 localStorage 存展示偏好；node/SSR 环境没有，给个 noop stub 让 renderToStaticMarkup 能跑。
    banner: {
      js: [
        "import { createRequire as __wbCreateRequire } from 'node:module'; const require = __wbCreateRequire(import.meta.url);",
        "if (typeof globalThis.localStorage === 'undefined') globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };",
      ].join('\n'),
    },
    // 组件偶尔会链入 CSS import，Node 里跑测试不需要样式
    loader: { '.css': 'empty' },
    logLevel: 'error',
  });
  const files = readdirSync(outDir)
    .filter((f) => f.endsWith('.test.mjs'))
    .map((f) => path.join(outDir, f));
  const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root });
  code = r.status ?? 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
process.exit(code);
