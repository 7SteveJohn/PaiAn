// 按卷分文件导出 · 边界与跨函数一致性（QA 独立补充轮）
//
// 与 tests/volumes.test.ts 的分工：那边钉「分卷本身怎么切、文件名怎么洗」，
// 这边钉三条更容易悄悄变形的东西——
// ① 章号是全书章号（拿「卷二从第 4 章才开始」这种最常见的书型反证）；
// ② N 个卷文件按分隔符拼回去，必须逐字等于既有「导出 .md/.txt」的正文——
//    这里不再手写期望串，而是把 WritingView.tsx 里 downloadFull 的拼装原样抄成
//    一个对照实现（见下方 fullExportBody），让「整书导出」自己当裁判；
// ③ 任何导出都不许动稿子，也不许凭空多产出文件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVolumeFiles, NO_VOLUME_NAME, sanitizeFileName, splitByVolume } from '../src/volumes';
import type { Chapter, TextMark } from '../src/types';

const ch = (id: string, title: string, content: string, volume?: string): Chapter => ({
  id,
  title,
  content,
  volume,
  createdAt: '2026-01-01 00:00',
  updatedAt: '2026-01-01 00:00',
});

const egg = (chapterId: string, start: number, end: number, note: string, extra: Partial<TextMark> = {}): TextMark => ({
  id: `${chapterId}-${start}`,
  type: '彩蛋',
  chapterId,
  start,
  end,
  text: '',
  note,
  createdAt: '2026-01-01 00:00',
  ...extra,
});

// ---------- 裁判：既有「整书导出」的正文拼装 ----------
// 下面两个函数是从 src/components/WritingView.tsx 抄下来的，不是另起一套判据：
//   volumeOf   ← L601-602（downloadFull 插卷标题的判据）
//   fullExportBody ← downloadFull 章节模式分支 L611-628（body 那段）
// 抄的目的正是为了让「既有导出」当裁判：分卷导出若与它不一致，作者手里就会同时
// 躺着两套排版，而这正是 volumes.ts 自己在文件头声明要避免的事。
const volumeOf = (c: { volume?: string }, i: number, arr: { volume?: string }[]) =>
  i === 0 || (c.volume ?? '') !== (arr[i - 1].volume ?? '') ? (c.volume ?? '') : null;

function fullExportBody(chapters: readonly Chapter[], isTxt = false): string {
  return chapters
    .map((c, i) => {
      const vol = volumeOf(c, i, chapters as Chapter[]);
      const volHead = vol ? (isTxt ? `${vol}\r\n\r\n` : `# ${vol}\n\n`) : '';
      const head = isTxt ? `第${i + 1}章 ${c.title}` : `## 第${i + 1}章 ${c.title}`;
      return `${volHead}${head}\n\n${c.content}`;
    })
    .join(isTxt ? '\r\n\r\n' : '\n\n');
}

/** 拼回去：md 用 LF 分隔符，txt 用 CRLF 分隔符，与 volumes.ts 里 SEP_MD / SEP_TXT 对应 */
const joinFiles = (texts: string[], isTxt: boolean) => texts.join(isTxt ? '\r\n\r\n' : '\n\n');

// ---------- 书型矩阵：覆盖作者真正会写出来的几种卷结构 ----------
const SHAPES: { name: string; chapters: Chapter[] }[] = [
  {
    name: '每章都填了卷名',
    chapters: [
      ch('c1', '一', '甲', '第一卷 废土列车'),
      ch('c2', '二', '乙', '第一卷 废土列车'),
      ch('c3', '三', '丙', '第二卷 锈色海'),
    ],
  },
  {
    name: '开头几章没填卷名，卷二从第 4 章才起',
    chapters: [
      ch('c1', '一', '甲'),
      ch('c2', '二', '乙'),
      ch('c3', '三', '丙'),
      ch('c4', '四', '丁', '第二卷 锈色海'),
      ch('c5', '五', '戊', '第二卷 锈色海'),
      ch('c6', '六', '己', '第二卷 锈色海'),
    ],
  },
  {
    name: '卷名带首尾空白',
    chapters: [
      ch('c1', '一', '甲', ' 第一卷 '),
      ch('c2', '二', '乙', '第一卷'),
      ch('c3', '三', '丙', '第二卷'),
    ],
  },
  {
    name: '卷名是空串',
    chapters: [ch('c1', '一', '甲', ''), ch('c2', '二', '乙', '第二卷')],
  },
  {
    name: '只有一卷（全书同名）',
    chapters: [ch('c1', '一', '甲', '第一卷'), ch('c2', '二', '乙', '第一卷')],
  },
  {
    name: '只有一卷（全书都没填卷名）',
    chapters: [ch('c1', '一', '甲'), ch('c2', '二', '乙')],
  },
];

// ---------- ① 章号恒为全书章号 ----------
test('不变式①：卷二从第 4 章开始时，卷内章号是 4/5/6 而不是 1/2/3', () => {
  const chapters = SHAPES[1].chapters;
  assert.equal(splitByVolume(chapters).length, 2);
  const files = buildVolumeFiles({ title: '锈色海', chapters, fmt: 'md' });
  assert.deepEqual(
    files.map((f) => f.name),
    ['锈色海-未分卷.md', '锈色海-第二卷 锈色海.md'],
  );
  // 第二卷的三章必须打着全书章号出场
  assert.ok(files[1].text.includes('## 第4章 四'), `第二卷首章应是第4章：${files[1].text}`);
  assert.ok(files[1].text.includes('## 第5章 五'));
  assert.ok(files[1].text.includes('## 第6章 六'));
  assert.equal(files[1].text.includes('## 第1章 四'), false, '不许在卷内重新计数');
  assert.equal(files[1].text.includes('## 第2章 五'), false);
  assert.equal(files[1].text.includes('## 第3章 六'), false);
  // 切卷后章号仍然 1..N 连续，不重不漏
  assert.deepEqual(
    splitByVolume(chapters).flatMap((s) => s.chapters.map((c) => c.no)),
    [1, 2, 3, 4, 5, 6],
  );
});

test('不变式①在 txt 侧同样成立：卷内章号不重排', () => {
  const files = buildVolumeFiles({ title: '锈色海', chapters: SHAPES[1].chapters, fmt: 'txt' });
  assert.ok(files[1].text.includes('第4章 四') && files[1].text.includes('第6章 六'), files[1].text);
  assert.equal(files[1].text.includes('第1章 四'), false);
});

// ---------- ② N 个卷文件拼回去 == 既有整书导出正文 ----------
test('不变式②（md）：各卷拼回去逐字等于既有「导出 .md」的正文', () => {
  const bad: string[] = [];
  for (const { name, chapters } of SHAPES) {
    const files = buildVolumeFiles({ title: '锈色海', chapters, fmt: 'md' });
    const got = joinFiles(
      files.map((f) => f.text),
      false,
    );
    const want = fullExportBody(chapters, false);
    if (got !== want) bad.push(`${name}\n  分卷拼回：${JSON.stringify(got)}\n  整书导出：${JSON.stringify(want)}`);
  }
  assert.deepEqual(bad, [], `这些书型的分卷导出与整书导出不是同一套排版：\n${bad.join('\n')}`);
});

test('不变式②（txt）：各卷拼回去逐字等于既有「导出 .txt」的正文', () => {
  const bad: string[] = [];
  for (const { name, chapters } of SHAPES) {
    const files = buildVolumeFiles({ title: '锈色海', chapters, fmt: 'txt' });
    const got = joinFiles(
      files.map((f) => f.text),
      true,
    );
    const want = fullExportBody(chapters, true);
    if (got !== want) bad.push(`${name}\n  分卷拼回：${JSON.stringify(got)}\n  整书导出：${JSON.stringify(want)}`);
  }
  assert.deepEqual(bad, [], `这些书型的分卷导出与整书导出不是同一套排版：\n${bad.join('\n')}`);
});

// ---------- 单文档模式 / 没有章节：一个文件都不许多出来 ----------
test('单文档模式与空书：返回空数组，交给调用方退化成既有单文件导出', () => {
  assert.deepEqual(buildVolumeFiles({ title: '一个人的列车', chapters: [] }), []);
  assert.deepEqual(buildVolumeFiles({ title: '一个人的列车' }), []);
  assert.deepEqual(buildVolumeFiles({ title: '一个人的列车', chapters: [], fmt: 'txt' }), []);
  // 单文档模式的正文在 draft 里：分卷层连读都不该读它，更不能拿它拼出一个「未分卷」文件
  const single = { mode: 'single' as const, title: '一个人的列车', draft: '雾比昨天更厚。', chapters: undefined };
  assert.deepEqual(buildVolumeFiles({ title: single.title, chapters: single.chapters }), []);
  assert.equal(single.draft, '雾比昨天更厚。', '导出不许碰 draft');
});

test('无论什么书型，都不产出空文件（text 全空白的文件一个都不许有）', () => {
  for (const { name, chapters } of SHAPES) {
    for (const fmt of ['md', 'txt'] as const) {
      const files = buildVolumeFiles({ title: '锈色海', chapters, fmt });
      for (const f of files) {
        assert.ok(f.name.trim().length > 0, `${name}/${fmt} 产出了空文件名`);
        assert.ok(f.text.trim().length > 0, `${name}/${fmt} 的 ${f.name} 是空文件`);
      }
    }
  }
});

// ---------- 文件名退化矩阵 ----------
test('文件名：非法字符、纯空白卷名、结尾的点与空格、书名卷名双双洗空', () => {
  assert.equal(sanitizeFileName('第一卷/废土:列车'), '第一卷_废土_列车', '非法字符替换成下划线而不是删掉');
  assert.equal(sanitizeFileName('  第一卷  '), '第一卷', '两头空白剥掉');
  assert.equal(sanitizeFileName('第一卷. '), '第一卷', '结尾的点与空格剥掉（Windows 收不了）');
  assert.equal(sanitizeFileName('   '), NO_VOLUME_NAME, '纯空白洗空后退回占位名');
  assert.equal(sanitizeFileName('第一卷\n\n第二'), '第一卷 第二', '内部换行压成空格');
  assert.equal(sanitizeFileName('...'), NO_VOLUME_NAME, '只剩点也洗空');

  // 卷名只有空白：归入「未分卷」，文件名不断头
  const blank = buildVolumeFiles({ title: '锈色海', chapters: [ch('c1', '一', '甲', '   '), ch('c2', '二', '乙', '第二卷')] });
  assert.equal(blank[0].name, '锈色海-未分卷.md');

  // 书名卷名都洗空：书名退「未命名」、卷名退「未分卷」，两边各用各的占位名
  const both = buildVolumeFiles({ title: '...', chapters: [ch('c1', '一', '甲', '...'), ch('c2', '二', '乙', '第二卷')] });
  assert.equal(both[0].name, '未命名-未分卷.md', `书名卷名双双洗空时的退化：${both[0].name}`);

  // 书名含非法字符 + 卷名含非法字符
  const dirty = buildVolumeFiles({
    title: '开局绑定/NUL*系统',
    chapters: [ch('c1', '一', '甲', '第一卷<>废土'), ch('c2', '二', '乙', '第二卷|锈海')],
  });
  assert.deepEqual(
    dirty.map((f) => f.name),
    ['开局绑定_NUL_系统-第一卷__废土.md', '开局绑定_NUL_系统-第二卷_锈海.md'],
  );
  // 文件名里不能残留任何非法字符（含路径分隔符——漏一个就会写进别的目录）
  for (const f of dirty) assert.equal(/[\\/:*?"<>|]/.test(f.name), false, `文件名残留非法字符：${f.name}`);
});

// ---------- 文件名不许撞车 ----------
// 分卷导出是一次性连着触发 N 个下载：两个文件同名时，浏览器要么给后来者加「(1)」，
// 要么直接问是否覆盖——作者手里就会躺着两个看不出谁是谁的文件。
test('文件名不许撞车：切出的每一卷都要有一个互不相同的文件名', () => {
  const shapes: Chapter[][] = [
    // 同名卷被别的卷打断后再出现（volumes.ts 自己就规定这算两卷）
    [ch('c1', '一', '甲', '第一卷'), ch('c2', '二', '乙', '第二卷'), ch('c3', '三', '丙', '第一卷')],
    // 卷名只差一个结尾的点：洗净后一模一样
    [ch('c1', '一', '甲', '第一卷'), ch('c2', '二', '乙', '第一卷.')],
    // 卷名里的非法字符不同，洗净后撞名
    [ch('c1', '一', '甲', '第一卷/上'), ch('c2', '二', '乙', '第一卷:上')],
  ];
  const bad: string[] = [];
  for (const chapters of shapes) {
    const names = buildVolumeFiles({ title: '锈色海', chapters }).map((f) => f.name);
    if (new Set(names).size !== names.length) {
      bad.push(`卷：${JSON.stringify(splitByVolume(chapters).map((s) => s.volume))} → 文件名：${JSON.stringify(names)}`);
    }
  }
  assert.deepEqual(bad, [], `这些书型会导出同名文件：\n${bad.join('\n')}`);
});

// ---------- 空章节 ----------
test('空章节：正文为空/纯空白的章照常留在卷里，不多产文件也不产空文件', () => {
  const chapters = [ch('c1', '一', ''), ch('c2', '二', '   '), ch('c3', '三', '丙', '第二卷')];
  const files = buildVolumeFiles({ title: '锈色海', chapters });
  assert.equal(files.length, 2, '空章节不该把一卷劈成两卷');
  assert.equal(files[0].text, '## 第1章 一\n\n\n\n## 第2章 二\n\n   ');
  assert.ok(files[1].text.trim().length > 0);
});

// ---------- 彩蛋注释 ----------
test('彩蛋：别章的锚点、失效锚点、非彩蛋类型都不进本卷；正文源一个字都不改', () => {
  const chapters = [ch('c1', '站台', '雾比昨天更厚。'), ch('c2', '出发', '列车开了。', '第二卷')];
  const marks = [
    egg('c2', 0, 1, '别章的'),
    egg('c1', 0, 1, '失效的', { orphaned: true }),
    egg('c1', 3, 4, '本卷的'),
    { ...egg('c1', 5, 6, '伏笔别插'), type: '伏笔' as TextMark['type'] },
    egg('c1', 7, 8, ''), // 没写注释也要占位，作者好回头补
  ];
  const snapshot = JSON.stringify({ chapters, marks });
  const files = buildVolumeFiles({ title: '锈色海', chapters, marks, annotated: true });
  // 末位锚点的 start/end 已经越过正文长度（老稿改短留下的），不许崩，落回正文末尾
  assert.equal(files[0].text, '## 第1章 站台\n\n雾比昨天〔彩蛋：本卷的〕更厚。〔彩蛋：无注释〕');
  assert.equal(files[0].text.includes('别章的'), false, '别章的锚点不许串进本卷');
  assert.equal(files[0].text.includes('失效的'), false);
  assert.equal(files[0].text.includes('伏笔别插'), false, '只有彩蛋进正文');
  assert.equal(files[1].text.includes('别章的'), true, '别章的注释要出现在它自己那一卷');
  // 红线：稿子与标记都是只读的
  assert.equal(JSON.stringify({ chapters, marks }), snapshot, '导出改了稿子或标记');
});

test('不带注释时：彩蛋一个字都不许出现在正文里', () => {
  const chapters = [ch('c1', '站台', '雾比昨天更厚。')];
  const marks = [egg('c1', 0, 1, '卷首镜头')];
  const plain = buildVolumeFiles({ title: '锈色海', chapters, marks, annotated: false });
  assert.equal(plain[0].text, '## 第1章 站台\n\n雾比昨天更厚。');
  assert.equal(plain[0].text.includes('彩蛋'), false);
});

// ---------- 幂等：三个月后再导出必须一模一样 ----------
// 两次调用之间等一小拍：文件名里要是混进了 Date.now()，同一毫秒内跑两次是抓不到的
test('同一份稿子连导两次，产出逐字一致（导出不能带时间戳/随机数）', async () => {
  const chapters = SHAPES[1].chapters;
  const marks = [egg('c4', 0, 1, '卷首'), egg('c1', 0, 1, '开头')];
  const args = { title: '锈色海', chapters, marks, annotated: true, fmt: 'md' as const };
  const first = buildVolumeFiles(args);
  await new Promise((r) => setTimeout(r, 5));
  const second = buildVolumeFiles(args);
  assert.deepEqual(second, first, '隔一小拍再导出，文件名或正文变了');
  // 文件名也必须是不掺任何时间戳的确定性字符串
  assert.deepEqual(
    first.map((f) => f.name),
    ['锈色海-未分卷.md', '锈色海-第二卷 锈色海.md'],
  );
  const txtArgs = { ...args, fmt: 'txt' as const };
  const t1 = buildVolumeFiles(txtArgs);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(buildVolumeFiles(txtArgs), t1);
});

test('切卷不改写入参数组：splitByVolume 只读', () => {
  const chapters = SHAPES[0].chapters;
  const snapshot = JSON.stringify(chapters);
  const slices = splitByVolume(chapters);
  assert.deepEqual(
    slices.map((s) => s.volume),
    ['第一卷 废土列车', '第二卷 锈色海'],
  );
  assert.equal(JSON.stringify(chapters), snapshot, '切卷改写了入参章节');
});
