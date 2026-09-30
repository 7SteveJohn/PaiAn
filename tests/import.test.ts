// 导入解析的回归：编码与拆章是全项目最容易「静默出错」的两处——
// 编码猜错是满屏乱码（程序不报错），拆章猜错是整本书结构崩（用户自己发现）。
// 所以这两条的边界全部钉在这里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeBytes,
  normalizeEol,
  splitChapters,
  detectShape,
  splitTitle,
  stripFrontmatter,
  shouldSkipPath,
  extOf,
  isImportable,
  naturalCompare,
  sortByNaturalName,
} from '../src/import-text';

const enc = (s: string) => new TextEncoder().encode(s);

// ---------- 编码 ----------

test('normalizeEol：CRLF 与孤立 CR 都收成 LF', () => {
  assert.equal(normalizeEol('a\r\nb\rc\nd'), 'a\nb\nc\nd');
});

test('decodeBytes：合法 UTF-8（无 BOM）按 utf-8 解', () => {
  const r = decodeBytes(enc('第1章 落水\n正文'));
  assert.equal(r.encoding, 'utf-8');
  assert.equal(r.hadBom, false);
  assert.equal(r.text, '第1章 落水\n正文');
});

test('decodeBytes：UTF-8 BOM 被剥掉，不进正文', () => {
  const r = decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('第1章')]));
  assert.equal(r.hadBom, true);
  assert.equal(r.encoding, 'utf-8');
  assert.equal(r.text, '第1章');
});

test('decodeBytes：UTF-16LE BOM 走 utf-16le', () => {
  const r = decodeBytes(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]));
  assert.equal(r.encoding, 'utf-16le');
  assert.equal(r.text, 'hi');
});

test('decodeBytes：非法 UTF-8 字节退到 GB18030（本地 txt 最常见的坑）', () => {
  // 0xB0 0xA1 是 GB2312 首个汉字「啊」；这两个字节不构成合法 UTF-8 序列
  const r = decodeBytes(new Uint8Array([0xb0, 0xa1]));
  assert.equal(r.encoding, 'gb18030');
  assert.equal(r.text, '啊');
});

test('decodeBytes：CRLF 在解码环节就统一，不会带 \\r 进 JSON', () => {
  const r = decodeBytes(enc('第一行\r\n第二行'));
  assert.equal(r.text.includes('\r'), false);
  assert.equal(r.text, '第一行\n第二行');
});

test('decodeBytes：ASCII 不会被误判成 GBK', () => {
  const r = decodeBytes(enc('Chapter 1\nplain ascii'));
  assert.equal(r.encoding, 'utf-8');
});

// ---------- 拆章 ----------

test('splitChapters：标准「第N章」逐章切开', () => {
  const r = splitChapters('第1章 码头夜雨\n他站在岸边。\n\n第2章 水下石门\n门后是黑的。');
  assert.equal(r.marker, 'chapter');
  assert.equal(r.shape, 'prose');
  assert.deepEqual(
    r.chapters.map((c) => c.title),
    ['第1章 码头夜雨', '第2章 水下石门'],
  );
  assert.equal(r.chapters[0].body, '他站在岸边。');
  assert.equal(r.chapters[1].body, '门后是黑的。');
});

test('splitChapters：「第N章 章名：剧情」一行一章 → 判成大纲并拆出 summary', () => {
  const text = '第1章 落水：主角被推下河，发现水下石门\n第2章 古玉：捡到会吞噬骨头的玉\n第3章 三叔：账本里藏着上一代的秘密';
  const r = splitChapters(text);
  assert.equal(r.shape, 'outline');
  assert.equal(r.marker, 'chapter');
  assert.deepEqual(
    r.chapters.map((c) => c.title),
    ['第1章 落水', '第2章 古玉', '第3章 三叔'],
  );
  assert.equal(r.chapters[0].summary, '主角被推下河，发现水下石门');
  assert.equal(r.chapters[0].body, '');
});

test('splitChapters：中文数字章号（第三章 / 第三节 / 第五回）', () => {
  const r = splitChapters('第三章 落水\n正文甲\n第三节 石门\n正文乙\n第五回 账本\n正文丙');
  assert.equal(r.marker, 'chapter');
  assert.equal(r.chapters.length, 3);
  assert.equal(r.chapters[2].title, '第五回 账本');
});

test('splitChapters：带 # 的章标记照拆，章名不该带 # 前缀', () => {
  const r = splitChapters('# 第1章 落水\n正文甲\n## 第2章 石门\n正文乙');
  assert.equal(r.marker, 'chapter');
  assert.deepEqual(
    r.chapters.map((c) => c.title),
    ['第1章 落水', '第2章 石门'],
  );
});

test('splitChapters：标题只写章名（无编号）时按标题层级拆', () => {
  const r = splitChapters('# 落水\n正文甲\n# 石门\n正文乙');
  assert.equal(r.marker, 'heading');
  assert.deepEqual(
    r.chapters.map((c) => c.title),
    ['落水', '石门'],
  );
});

test('splitChapters：`# 书名` + `## 第N章` 时按章标记拆，书名并进第一章', () => {
  const r = splitChapters('# 码头长生路\n## 第1章 落水\n正文甲\n## 第2章 石门\n正文乙');
  assert.equal(r.marker, 'chapter');
  assert.equal(r.chapters.length, 2);
  assert.equal(r.chapters[0].title, '第1章 落水');
  assert.equal(r.chapters[0].body.startsWith('# 码头长生路'), true);
  assert.equal(r.chapters[1].title, '第2章 石门');
});

test('splitChapters：单独一章的 md（只有「# 第1章」）不该丢标题', () => {
  const r = splitChapters('# 第1章 落水\n只有这一章的正文。');
  assert.equal(r.marker, 'chapter');
  assert.equal(r.chapters.length, 1);
  assert.equal(r.chapters[0].title, '第1章 落水');
  assert.equal(r.chapters[0].body, '只有这一章的正文。');
});

test('splitChapters：Chapter N（英文）', () => {
  const r = splitChapters('Chapter 1 The Dock\nIt rained.\nChapter 2 The Door\nIt opened.');
  assert.equal(r.marker, 'english');
  assert.deepEqual(
    r.chapters.map((c) => c.title),
    ['Chapter 1 The Dock', 'Chapter 2 The Door'],
  );
});

test('splitChapters：纯序号（3. 落水）拆得动', () => {
  const r = splitChapters('1. 落水\n正文甲\n2. 石门\n正文乙\n3. 古玉\n正文丙');
  assert.equal(r.marker, 'numbered');
  assert.equal(r.chapters.length, 3);
  assert.equal(r.chapters[1].title, '2. 石门');
});

test('splitChapters：正文里的连续有序列表不该被当成章', () => {
  const text = '买东西的清单：\n1. 酱油\n2. 醋\n3. 盐\n4. 糖\n他把清单折好放进口袋，走出了门。';
  const r = splitChapters(text);
  assert.equal(r.marker, 'none');
  assert.equal(r.chapters.length, 1);
  assert.equal(r.chapters[0].body, text);
});

test('splitChapters：分隔线（---）在没有任何章标记时兜底', () => {
  const r = splitChapters('第一段内容。\n---\n第二段内容。\n---\n第三段内容。');
  assert.equal(r.marker, 'rule');
  assert.equal(r.shape, 'prose');
  assert.equal(r.chapters.length, 3);
  assert.equal(r.chapters[0].title, '');
  assert.equal(r.chapters[1].body, '第二段内容。');
});

test('splitChapters：有章标记时，分隔线不抢戏（只用更强的那一种）', () => {
  const r = splitChapters('第1章 落水\n正文甲\n---\n正文乙\n第2章 石门\n正文丙');
  assert.equal(r.marker, 'chapter');
  assert.equal(r.chapters.length, 2);
});

test('splitChapters：完全没标记 → 整篇一章，不瞎猜', () => {
  const text = '这是一整段没有任何章节标记的随笔，写到哪里算哪里。';
  const r = splitChapters(text);
  assert.equal(r.marker, 'none');
  assert.equal(r.shape, 'prose');
  assert.equal(r.chapters.length, 1);
  assert.equal(r.chapters[0].title, '');
  assert.equal(r.chapters[0].body, text);
});

test('splitChapters：开头的 YAML 属性区被剥掉，不当正文', () => {
  const text = '---\ntitle: 落水\ntags: [小说]\n---\n第1章 落水\n正文甲';
  const r = splitChapters(text);
  assert.equal(r.chapters.length, 1);
  assert.equal(r.chapters[0].body, '正文甲');
  assert.equal(r.chapters[0].body.includes('title:'), false);
});

test('splitChapters：空文本返回零章，不造空壳章节', () => {
  assert.deepEqual(splitChapters('').chapters, []);
  assert.deepEqual(splitChapters('   \n\n  ').chapters, []);
});

test('splitChapters：章块之间的空行不残留在正文末尾', () => {
  const r = splitChapters('第1章 甲\n正文甲\n\n\n第2章 乙\n正文乙\n\n');
  assert.equal(r.chapters[0].body, '正文甲');
  assert.equal(r.chapters[1].body, '正文乙');
});

test('stripFrontmatter：只剥开头那一段，正文里的 --- 不动', () => {
  assert.equal(stripFrontmatter('---\na: 1\n---\n正文'), '正文');
  assert.equal(stripFrontmatter('正文\n---\n后面'), '正文\n---\n后面');
});

test('splitTitle：按第一个冒号切章名与剧情', () => {
  assert.deepEqual(splitTitle('第3章 落水：主角被推下河'), { title: '第3章 落水', summary: '主角被推下河' });
  assert.deepEqual(splitTitle('第3章 落水: 半角冒号也行'), { title: '第3章 落水', summary: '半角冒号也行' });
  assert.deepEqual(splitTitle('第3章 落水'), { title: '第3章 落水', summary: '' });
});

test('detectShape：一行一章且带冒号 → 大纲；有实段 → 正文', () => {
  assert.equal(
    detectShape([
      { title: '第1章 落水：被推下河', body: '' },
      { title: '第2章 石门：发现暗门', body: '' },
    ]),
    'outline',
  );
  assert.equal(
    detectShape([
      { title: '第1章 落水', body: '他站在岸边。\n风很大。' },
      { title: '第2章 石门', body: '门后是黑的。' },
    ]),
    'prose',
  );
});

// ---------- 文件与目录 ----------

test('extOf / isImportable：认得该读的后缀', () => {
  assert.equal(extOf('第1章.MD'), 'md');
  assert.equal(extOf('no-ext'), '');
  assert.equal(isImportable('a/b/c.docx'), true);
  assert.equal(isImportable('封面.png'), false);
});

test('shouldSkipPath：跳隐藏目录、依赖目录与二进制附件', () => {
  assert.equal(shouldSkipPath('.obsidian/workspace.json'), true);
  assert.equal(shouldSkipPath('书稿/.git/config'), true);
  assert.equal(shouldSkipPath('书稿/node_modules/x/readme.md'), true);
  assert.equal(shouldSkipPath('.hidden.md'), true);
  assert.equal(shouldSkipPath('书稿/封面.png'), true);
  assert.equal(shouldSkipPath('书稿/第1章.md'), false);
  assert.equal(shouldSkipPath('书稿\\第1章.txt'), false);
});

test('naturalCompare：第2章 排在 第10章 之前（不是字典序）', () => {
  assert.equal(naturalCompare('第2章', '第10章') < 0, true);
  const sorted = sortByNaturalName([{ name: '第10章.md' }, { name: '第2章.md' }, { name: '第1章.md' }]);
  assert.deepEqual(
    sorted.map((x) => x.name),
    ['第1章.md', '第2章.md', '第10章.md'],
  );
});
