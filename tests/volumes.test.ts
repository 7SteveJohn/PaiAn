// 按卷分文件导出的判据断言。核心只有三条：
// ① 每个卷文件必须是整书导出正文的一段直接切片——N 个文件按分隔符拼回去要等于整书正文，
//    否则作者手里会同时存在两套排版；
// ② 章号恒为全书章号，不在卷内重排（第二章的第一篇不是「第 1 章」）；
// ③ 文件名必须落到磁盘上收得了：非法字符替换掉、洗空了要退回「未分卷」，且一个个
//    确认「没多产出空文件」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVolumeFiles, displayVolumeName, NO_VOLUME_NAME, sanitizeFileName, splitByVolume } from '../src/volumes';
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

// 四章三卷：卷一占前两章，卷二占第三章，第四章没填卷名（文件名上归「未分卷」，正文里不出卷标题）
const book = () => [
  ch('c1', '出发', '列车开了。', '第一卷 废土列车'),
  ch('c2', '售票员', '她收下了半块面包。', '第一卷 废土列车'),
  ch('c3', '站台', '雾比昨天更厚。', '第二卷 锈色海'),
  ch('c4', '断更的一天', '什么都没发生。'),
];

test('相邻同名章节并成一卷，顺序不变', () => {
  const slices = splitByVolume(book());
  assert.deepEqual(
    slices.map((s) => s.volume),
    ['第一卷 废土列车', '第二卷 锈色海', ''],
    '没填卷名的那一卷，卷名就是空串：「未分卷」只补在文件名上，不改写切卷口径',
  );
  assert.deepEqual(slices.map((s) => s.chapters.map((c) => c.no)), [[1, 2], [3], [4]], '章号必须是全书章号');
  // 文件名那边才轮到占位名出场
  assert.deepEqual(
    buildVolumeFiles({ title: '锈色海', chapters: book() }).map((f) => f.name),
    ['锈色海-第一卷 废土列车.md', '锈色海-第二卷 锈色海.md', '锈色海-未分卷.md'],
  );
});

test('被别的卷打断后再次出现同名：算两卷（不擅自合并）', () => {
  const slices = splitByVolume([
    ch('c1', '一', '甲', '第一卷'),
    ch('c2', '二', '乙', '第二卷'),
    ch('c3', '三', '丙', '第一卷'),
  ]);
  assert.deepEqual(slices.map((s) => s.volume), ['第一卷', '第二卷', '第一卷']);
  assert.deepEqual(slices[0].chapters.map((c) => c.no), [1]);
  assert.deepEqual(slices[2].chapters.map((c) => c.no), [3]);
});

// 切卷看的是卷名原文（与既有整书导出的 volumeOf 逐字同口径），trim/占位那是文件名的事
test('卷名原文不同就是不同的一卷：不擅自 trim，也不把空串与纯空白并成一卷', () => {
  const chapters = [ch('c1', '一', '甲', ' 第一卷 '), ch('c2', '二', '乙', '第一卷'), ch('c3', '三', '丙', ''), ch('c4', '四', '丁', '   ')];
  const slices = splitByVolume(chapters);
  assert.deepEqual(slices.map((s) => s.volume), [' 第一卷 ', '第一卷', '', '   ']);
  assert.deepEqual(slices.map((s) => s.chapters.map((c) => c.no)), [[1], [2], [3], [4]]);
  // 落到磁盘上的名字才洗：空白剥掉、空名补占位名，撞在一起再按顺序补 (1)
  const files = buildVolumeFiles({ title: '锈色海', chapters });
  assert.deepEqual(
    files.map((f) => f.name),
    ['锈色海-第一卷.md', '锈色海-第一卷(1).md', '锈色海-未分卷.md', '锈色海-未分卷(1).md'],
  );
  // 界面提示（按钮 title）既不吐带空白的原文，也不留空档
  assert.equal(displayVolumeName(' 第一卷 '), '第一卷');
  assert.equal(displayVolumeName(''), NO_VOLUME_NAME);
  assert.equal(displayVolumeName('   '), NO_VOLUME_NAME);
});

// 缺陷 1：空卷名不许在正文里多插一块卷标题（否则与整书导出对不上）
test('卷名为空：正文直接开篇，文件名仍补「未分卷」', () => {
  const chapters = [ch('c1', '断更的一天', '什么都没发生。')];
  const md = buildVolumeFiles({ title: '锈色海', chapters, fmt: 'md' });
  assert.equal(md[0].text, '## 第1章 断更的一天\n\n什么都没发生。');
  assert.equal(md[0].text.startsWith('# '), false, '不许以卷标题开头：整书导出也没这份标题');
  assert.equal(md[0].name, '锈色海-未分卷.md', '文件名不能空心化');
  const txt = buildVolumeFiles({ title: '锈色海', chapters, fmt: 'txt' });
  assert.equal(txt[0].text, '第1章 断更的一天\n\n什么都没发生。');
});

// 缺陷 2：N 个卷必须有 N 个互不相同的文件名
test('文件名去重：同名卷按出现顺序追加 (1) (2)，不用时间戳也不用随机数', () => {
  // 同名卷必须被别的卷打断才会单独成卷（相邻同名仍是一卷），所以这里交错着给
  const chapters = [
    ch('c1', '一', '甲', '第一卷'),
    ch('c2', '二', '乙', '第二卷'),
    ch('c3', '三', '丙', '第一卷'),
    ch('c4', '四', '丁', '第二卷'),
    ch('c5', '五', '戊', '第一卷'),
  ];
  const first = buildVolumeFiles({ title: '锈色海', chapters });
  assert.deepEqual(
    first.map((f) => f.name),
    [
      '锈色海-第一卷.md',
      '锈色海-第二卷.md',
      '锈色海-第一卷(1).md',
      '锈色海-第二卷(1).md',
      '锈色海-第一卷(2).md',
    ],
  );
  assert.equal(new Set(first.map((f) => f.name)).size, first.length, '四个卷必须四个不同的文件名');
  // 后缀加在扩展名之前，不能写成「.md(1)」
  for (const f of first) assert.ok(/\.(md|txt)$/.test(f.name), `后缀加错位置：${f.name}`);
  // 确定性：同一份稿子再导一次（哪怕账面上隔了一小段时间）必须逐字一致
  const again = buildVolumeFiles({ title: '锈色海', chapters });
  assert.deepEqual(again, first, '文件名不该掺时间戳/随机数');
});

test('去重连撞：卷名本身就写着「(1)」时也要分得开', () => {
  const chapters = [ch('c1', '一', '甲', '第一卷'), ch('c2', '二', '乙', '第一卷(1)'), ch('c3', '三', '丙', '第一卷')];
  const files = buildVolumeFiles({ title: '锈色海', chapters });
  assert.deepEqual(
    files.map((f) => f.name),
    ['锈色海-第一卷.md', '锈色海-第一卷(1).md', '锈色海-第一卷(2).md'],
    '第三卷不能占用「自动分给上一卷的那个名字」，得继续往下找空位',
  );
  assert.equal(new Set(files.map((f) => f.name)).size, 3);
});

test('没有章节：不产出任何文件（退化交给调用方走既有单文件导出）', () => {
  assert.deepEqual(splitByVolume([]), []);
  assert.deepEqual(buildVolumeFiles({ title: '一个人的列车', chapters: [] }), []);
  assert.deepEqual(buildVolumeFiles({ title: '一个人的列车' }), []);
});

test('md：一卷一个文件，有卷名的以卷标题开头，没填卷名的直接开篇', () => {
  const files = buildVolumeFiles({ title: '锈色海', chapters: book(), fmt: 'md' });
  assert.equal(files.length, 3);
  assert.equal(files[0].text, '# 第一卷 废土列车\n\n## 第1章 出发\n\n列车开了。\n\n## 第2章 售票员\n\n她收下了半块面包。');
  assert.equal(files[1].text, '# 第二卷 锈色海\n\n## 第3章 站台\n\n雾比昨天更厚。');
  assert.equal(files[2].text, '## 第4章 断更的一天\n\n什么都没发生。');
});

// 不变式①：把卷文本按同样的分隔符拼回去，必须得到整书导出的正文
test('md：各卷切片拼回来 == 整书导出正文', () => {
  const chapters = book();
  const files = buildVolumeFiles({ title: '锈色海', chapters, fmt: 'md' });
  const whole =
    '# 第一卷 废土列车\n\n## 第1章 出发\n\n列车开了。\n\n## 第2章 售票员\n\n她收下了半块面包。' +
    '\n\n# 第二卷 锈色海\n\n## 第3章 站台\n\n雾比昨天更厚。' +
    '\n\n## 第4章 断更的一天\n\n什么都没发生。';
  assert.equal(files.map((f) => f.text).join('\n\n'), whole);
});

test('txt：卷标题与章间分隔用 Windows 换行，章标题后沿用既有 LF 写法', () => {
  const files = buildVolumeFiles({ title: '锈色海', chapters: book(), fmt: 'txt' });
  assert.equal(files.length, 3);
  assert.equal(
    files[0].text,
    '第一卷 废土列车\r\n\r\n第1章 出发\n\n列车开了。\r\n\r\n第2章 售票员\n\n她收下了半块面包。',
  );
  assert.equal(files[1].text, '第二卷 锈色海\r\n\r\n第3章 站台\n\n雾比昨天更厚。');
  assert.equal(files[2].name, '锈色海-未分卷.txt');
});

// 不变式①在 txt 侧同样成立
test('txt：各卷切片拼回来 == 整书导出正文', () => {
  const files = buildVolumeFiles({ title: '锈色海', chapters: book(), fmt: 'txt' });
  const whole =
    '第一卷 废土列车\r\n\r\n第1章 出发\n\n列车开了。\r\n\r\n第2章 售票员\n\n她收下了半块面包。' +
    '\r\n\r\n第二卷 锈色海\r\n\r\n第3章 站台\n\n雾比昨天更厚。' +
    '\r\n\r\n第4章 断更的一天\n\n什么都没发生。';
  assert.equal(files.map((f) => f.text).join('\r\n\r\n'), whole);
});

test('只有一卷时不多拆：仍然只出一个文件', () => {
  const one = [ch('c1', '出发', '列车开了。'), ch('c2', '售票员', '她收下了半块面包。')];
  const files = buildVolumeFiles({ title: '锈色海', chapters: one });
  assert.equal(files.length, 1);
  assert.equal(files[0].name, '锈色海-未分卷.md');
  assert.equal(files[0].text, '## 第1章 出发\n\n列车开了。\n\n## 第2章 售票员\n\n她收下了半块面包。');
});

test('文件名：<书名>-<卷名>.<扩展名>，两边都做非法字符清洗', () => {
  const files = buildVolumeFiles({
    title: '开局绑定/NUL:系统',
    chapters: [ch('c1', '一', '甲', '第一卷:废土'), ch('c2', '二', '乙', '第二卷/锈海')],
  });
  assert.deepEqual(files.map((f) => f.name), ['开局绑定_NUL_系统-第一卷_废土.md', '开局绑定_NUL_系统-第二卷_锈海.md']);
  const txt = buildVolumeFiles({ title: '锈色海', chapters: [ch('c1', '一', '甲', '第一卷')], fmt: 'txt' });
  assert.equal(txt[0].name, '锈色海-第一卷.txt');
});

test('书名/卷名被洗空：退回兜底名，不写出断头文件名', () => {
  assert.equal(sanitizeFileName(''), NO_VOLUME_NAME, '洗空了要退回占位名');
  assert.equal(sanitizeFileName('///'), '___', '非法字符是替换不是删除，免得「第 一 卷」粘成一团看不懂');
  // 书名两头空白 -> 退回「未命名」，而不是借卷名的占位名过来用
  assert.equal(buildVolumeFiles({ title: '  ', chapters: [ch('c1', '一', '甲', '///')] })[0].name, '未命名-___.md');
  assert.equal(sanitizeFileName('第一卷。  '), '第一卷。', '卷名两头的空白剥掉');
  assert.equal(sanitizeFileName('第一卷. '), '第一卷', '结尾的点是 Windows 文件名收不了的，得剥掉');
  assert.equal(sanitizeFileName('第一卷\n\n第二'), '第一卷 第二', '卷名里的换行压成空格');
});

test('带注释阅读版：彩蛋按位置插入，且不动正文源', () => {
  const chapters = [ch('c1', '站台', '雾比昨天更厚。')];
  const marks = [egg('c1', 0, 1, '卷首镜头'), egg('c1', 3, 4, '感官')];
  const files = buildVolumeFiles({ title: '锈色海', chapters, marks, annotated: true });
  assert.equal(files[0].text, '## 第1章 站台\n\n雾〔彩蛋：卷首镜头〕比昨天〔彩蛋：感官〕更厚。');
  assert.equal(chapters[0].content, '雾比昨天更厚。', '注释只能插进导出副本，稿子必须干净');
  const plain = buildVolumeFiles({ title: '锈色海', chapters, marks });
  assert.equal(plain[0].text, '## 第1章 站台\n\n雾比昨天更厚。', '不带注释时正文一个字都不能多');
});

test('带注释阅读版：跳过失效锚点、非彩蛋标记与别章的锚点', () => {
  const chapters = [ch('c1', '站台', '雾比昨天更厚。'), ch('c2', '出发', '列车开了。', '第二卷')];
  const marks = [
    egg('c1', 0, 1, '失效的', { orphaned: true }),
    egg('c1', 3, 4, '感官'),
    egg('c2', 0, 1, '主角视角'),
    { ...egg('c1', 1, 2, '伏笔'), type: '伏笔' as TextMark['type'] },
  ];
  const files = buildVolumeFiles({ title: '锈色海', chapters, marks, annotated: true });
  assert.equal(files.length, 2);
  assert.equal(files[0].text, '## 第1章 站台\n\n雾比昨天〔彩蛋：感官〕更厚。');
  assert.equal(files[0].text.includes('失效的'), false, '锚点失效的注释不能出现在导出里');
  assert.equal(files[0].text.includes('伏笔'), false, '只有彩蛋插进正文，伏笔标记不参与导出');
  assert.equal(files[0].text.includes('主角视角'), false, '别章的锚点不能串进本卷');
  assert.equal(files[1].text, '# 第二卷\n\n## 第2章 出发\n\n列〔彩蛋：主角视角〕车开了。');
});
