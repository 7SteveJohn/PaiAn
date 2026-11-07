// 快路径判据与词数缓存：statsEqual 按值比对（打字每键换新引用，引用比必失败）；
// countWords 引用缓存只做加速，结果必须与无缓存时逐字一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countWords, normalizeIdeas, normalizeStats, statsEqual } from '../src/util';

test('statsEqual：内容相同引用不同判等，任一字段不同判不等', () => {
  const a = normalizeStats({ daily: { '2026-11-07': 1200 }, reflection: '今天顺手' });
  const b = normalizeStats({ daily: { '2026-11-07': 1200 }, reflection: '今天顺手' });
  assert.notEqual(a, b, 'normalizeStats 每次造新对象，正是打字时的引用形态');
  assert.equal(statsEqual(a, b), true);

  assert.equal(statsEqual(a, normalizeStats({ daily: { '2026-11-07': 1201 }, reflection: '今天顺手' })), false, '当日字数变了');
  assert.equal(statsEqual(a, normalizeStats({ daily: { '2026-11-07': 1200 }, reflection: '改了感想' })), false, '感想变了');
  assert.equal(statsEqual(a, normalizeStats({ daily: { '2026-11-06': 1200 }, reflection: '今天顺手' })), false, '日期键不同');
  assert.equal(statsEqual(normalizeStats(null), normalizeStats({})), true, '两个空 stats 判等');
});

test('normalizeIdeas：content 缺失补空串，其余字段原样透传', () => {
  const raw = [
    { id: 'i1', kind: '设定', title: '潮汐灯语', content: '灯塔信标' },
    { id: 'i2', kind: '灵感', title: '缺正文的条目' },
  ] as never[];
  const out = normalizeIdeas(raw);
  assert.equal(out[0].content, '灯塔信标', '正常条目不动');
  assert.equal(out[1].content, '', '缺 content 补空串（否则关联灵感下拉读 length 白屏）');
  assert.equal((out[1] as { title: string }).title, '缺正文的条目', '其余字段透传');
  assert.deepEqual(normalizeIdeas(undefined), [], '空值兜空数组');
});

test('statsEqual：键序不同但内容相同也判等（stringify 语义，双方都出自同一展开路径）', () => {
  const a = normalizeStats({ daily: { '2026-11-06': 10, '2026-11-07': 20 } });
  const b = { daily: { '2026-11-06': 10, '2026-11-07': 20 }, reflection: '', sprints: [] };
  assert.equal(statsEqual(a, b as never), true);
});

test('countWords：中英混合计数与缓存命中结果一致', () => {
  const text = '雾港的灯塔亮了。Two words 和 2026 个理由。';
  const expect = text.length - text.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, '').length + (text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) ?? []).length;
  assert.equal(countWords(text), expect);
  assert.equal(countWords(text), countWords(text), '同引用二次调用（命中缓存）结果不变');
  assert.equal(countWords(''), 0);
  assert.equal(countWords('三'), 1);
});

test('countWords：缓存驱逐（超容量清空）后结果仍逐字正确', () => {
  const seen = new Map<string, number>();
  for (let i = 0; i < 40; i++) {
    const s = `第${i}章：` + '字'.repeat(i + 1) + ` plus ${i} tokens`;
    seen.set(s, countWords(s));
  }
  // 容量只有 16，中途已多次清空：回查早期字符串必须重新全扫且结果一致
  for (const [s, n] of seen) assert.equal(countWords(s), n);
});
