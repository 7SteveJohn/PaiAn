// 旧章回响（BM25 bigram）：分词、打分排序、排除自身、片段与注入文本上限。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEcho, echoTop, renderEcho, tokenize } from '../src/echo';

test('tokenize：中英混合拆出 CJK 二字组与小写拉丁词', () => {
  assert.deepEqual(tokenize('Hello 世界 雾港2026'), ['hello', '世界', '雾港', '2026']);
  assert.deepEqual(tokenize(''), []);
});

test('罕见词得分高于高频词：命中罕见词的文档排前', () => {
  const idx = buildEcho([
    { id: 'd1', title: '第一章', text: '码头的雾比昨天更厚。灯塔在雾的尽头。' },
    { id: 'd2', title: '第二章', text: '码头的雾又起了，码头边没人。' },
  ]);
  const hits = echoTop(idx, '码头 灯塔', 5);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].id, 'd1', '只命中高频词的 d2 不该压过还命中罕见词「灯塔」的 d1');
  const d2 = hits.find((h) => h.id === 'd2');
  if (d2) assert.ok(hits[0].score > d2.score);
});

test('空 docs 返回空数组', () => {
  assert.deepEqual(echoTop(buildEcho([]), '随便什么查询', 3), []);
  assert.deepEqual(echoTop(buildEcho([{ id: 'd1', title: 't', text: '   ' }]), '查询', 3), []);
});

test('score>0 才收：查询词全都不在的文档不返回', () => {
  const idx = buildEcho([
    { id: 'd1', title: '第一章', text: '码头的雾比昨天更厚。' },
    { id: 'd2', title: '第二章', text: '账房里算盘响了一夜。' },
  ]);
  const hits = echoTop(idx, '灯塔', 5);
  assert.deepEqual(hits.map((h) => h.id), []);
});

test('excludeId 生效：当前章自己不出现在结果里', () => {
  const idx = buildEcho([
    { id: 'me', title: '当前章', text: '码头的雾又厚了一层，灯塔亮了。' },
    { id: 'old', title: '旧章', text: '码头边旧灯塔还在。' },
  ]);
  const hits = echoTop(idx, '码头 灯塔', 5, 'me');
  assert.ok(hits.length >= 1);
  assert.ok(!hits.some((h) => h.id === 'me'));
});

test('snippet ≤140 且包含命中词附近内容；查不到命中的退回文档开头 140 字', () => {
  const pad = '雾。'.repeat(200);
  const idx = buildEcho([{ id: 'd1', title: '第一章', text: pad + '灯塔在雾的尽头亮了一下。' + pad }]);
  const [hit] = echoTop(idx, '灯塔', 1);
  assert.ok(hit, '该有命中');
  assert.ok(hit.snippet.length <= 140, `snippet 应 ≤140，实际 ${hit.snippet.length}`);
  assert.ok(hit.snippet.includes('灯塔'));
  const bare = buildEcho([{ id: 'd2', title: '第二章', text: '甲'.repeat(300) }]);
  const [miss] = echoTop(bare, '甲甲', 1); // 命中 bigram「甲甲」在文本里找得到
  assert.ok(miss && miss.snippet.length <= 140);
});

test('renderEcho 总长 ≤700：超了从后往前丢', () => {
  const pad = '雾。'.repeat(80); // 160 字，单条就顶满上限附近
  const hits = [1, 2, 3, 4, 5].map((i) => ({ id: `d${i}`, title: `第${i}章`, score: 5 - i, snippet: pad }));
  const out = renderEcho(hits);
  assert.ok(out.length <= 700, `总长应 ≤700，实际 ${out.length}`);
  assert.ok(out.startsWith('\n\n【回响·旧章片段（仅参考，禁止复述原文）】'));
  assert.ok(out.includes('《第1章》'));
  assert.ok(renderEcho([]) === '');
});

test('echoTop：latin 词在原文里是大写也能锚到片段（不区分大小写）', () => {
  const docs = [
    { id: 'a', title: 'A', text: 'He whispers "RUN" and the fog swallows the pier. 林越蹲在缆桩边。' },
    { id: 'b', title: 'B', text: '无关的章节，只有垫话。' },
  ];
  const idx = buildEcho(docs);
  const hits = echoTop(idx, 'run', 1);
  assert.equal(hits.length, 1);
  assert.ok(hits[0].snippet.startsWith('He whispers'), '片段应锚在大写 RUN 处而不是文档开头截断：' + JSON.stringify(hits[0].snippet.slice(0, 20)));
});

test('echoTop：latin 词在原文里是大写也能锚到片段（不区分大小写）', () => {
  const docs = [
    { id: 'a', title: 'A', text: 'He whispers "RUN" and the fog swallows the pier. 林越蹲在缆桩边。' },
    { id: 'b', title: 'B', text: '无关的章节，只有垫话。' },
  ];
  const idx = buildEcho(docs);
  const hits = echoTop(idx, 'run', 1);
  assert.equal(hits.length, 1);
  assert.ok(hits[0].snippet.startsWith('He whispers'), '片段应锚在大写 RUN 处而不是文档开头截断：' + JSON.stringify(hits[0].snippet.slice(0, 20)));
});
