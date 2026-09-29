// 批量生成门禁的锚点：只有选中章参与判定、要点少于 MIN_BEATS 才算薄、
// 未采纳草稿单独列出（会被覆盖），以及采纳后的字数欠账只在明显不足时才提。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_BEATS, QUOTA_FLOOR, gateSummary, hasGatework, isThin, preflight, quotaGap, type GateChapter } from '../src/gate';
import type { LoreInput } from '../src/watchdog';

const ch = (id: string, over: Partial<GateChapter> = {}): GateChapter => ({ id, title: '章' + id, ...over });
const beats12 = '他登上末班车，发现座位上是自己的旧照片'; // 18 字，非空白
const thin = '他上车';

test('门禁只算选中的章', () => {
  const list = [ch('a', { beats: beats12 }), ch('b'), ch('c')];
  const rep = preflight(list, ['b']);
  assert.equal(rep.thin.length, 1);
  assert.equal(rep.thin[0].id, 'b');
  assert.equal(rep.thin[0].no, 2, '章号按全书顺序，1 起');
  assert.equal(rep.safe, 0, '没选中的 a 有细纲也不算安全章');
});

test('要点厚度以去空白后的字数计，标点与项目符号不充数', () => {
  assert.equal(isThin({ beats: '   \n\t  ' }), true);
  assert.equal(isThin({}), true);
  assert.equal(isThin({ beats: thin }), true);
  assert.equal(isThin({ beats: '· '.repeat(MIN_BEATS) }), true, '纯符号重复不该算有细纲');
  assert.equal(isThin({ beats: beats12 }), false);
  assert.equal(isThin({ beats: '字'.repeat(MIN_BEATS - 1) }), true, `差一个字也不该放过（阈值 ${MIN_BEATS}）`);
  assert.equal(isThin({ beats: '字'.repeat(MIN_BEATS) }), false);
});

test('未采纳草稿与薄细纲可以同时命中', () => {
  const rep = preflight([ch('a', { beats: '', pending: '一版旧草稿' }), ch('b', { beats: beats12, pending: '待审' }), ch('c', { beats: beats12 })], ['a', 'b', 'c']);
  assert.deepEqual(rep.thin.map((h) => h.id), ['a']);
  assert.deepEqual(rep.draft.map((h) => h.id), ['a', 'b'], 'a 既薄又有草稿，两处都该列出');
  assert.equal(rep.safe, 2);
  assert.equal(hasGatework(rep), true);
  const s = gateSummary(rep);
  assert.ok(s.includes('1 章没有剧情要点'), s);
  assert.ok(s.includes('2 章已挂着未采纳的草稿'), s);
});

test('守夜人接进门禁：只有境界矛盾也该弹面板，不传作品就哑', () => {
  const book = {
    mode: 'chapters',
    characters: [{ id: 'k1', name: '林越' }],
    chapters: [
      { id: 'c1', title: '第一章', content: '林越一步踏入金丹。' + '细节。'.repeat(20) },
      { id: 'c2', title: '第二章', content: '林越的气息退回筑基中期。' + '细节。'.repeat(20) },
    ],
  } as unknown as LoreInput;
  const rep = preflight([ch('c1', { beats: beats12 }), ch('c2', { beats: beats12 })], ['c1', 'c2'], book);
  assert.deepEqual([rep.thin.length, rep.draft.length, rep.safe], [0, 0, 2], '两章细纲都够，门禁不该在旧维度上报');
  assert.equal(rep.lore.length, 1, JSON.stringify(rep.lore));
  assert.match(rep.lore[0], /林越：第1章「金丹」→ 第2章「筑基中期」/);
  assert.equal(hasGatework(rep), true, '只有设定矛盾也该让面板出现');
  assert.match(gateSummary(rep), /正文里有 1 处境界前后不一/, gateSummary(rep));
  assert.deepEqual(preflight([ch('a', { beats: beats12 })], ['a']).lore, [], '不传作品就当没有这一维');
});

test('没问题时门禁是哑的', () => {
  const rep = preflight([ch('a', { beats: beats12 }), ch('b', { beats: beats12 })], ['a', 'b']);
  assert.equal(hasGatework(rep), false);
  assert.equal(gateSummary(rep), '');
  assert.equal(rep.safe, 2);
});

test('欠账只在明显不足时提，目标未设不提', () => {
  assert.equal(quotaGap('正文'.repeat(500), 0), null, '没设目标就别烦人');
  const target = 1000;
  assert.equal(quotaGap('字'.repeat(Math.round(target * QUOTA_FLOOR)), target), null, '刚好到成数算达标');
  const gap = quotaGap('字'.repeat(520), target);
  assert.ok(gap);
  assert.equal(gap!.words, 520);
  assert.equal(gap!.pct, 52);
  assert.equal(quotaGap('字'.repeat(620), target), null, '6 成以上是正常篇幅，别打扰');
  assert.equal(quotaGap('', target)?.pct, 0, '空正文是 0%');
});
