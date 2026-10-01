// 离场人物复现（守夜人 OOC 维度）的锚点。state 是作者维护的快照、没有时间戳——
// 自动猜分界必然误报（坟前提名 / 离场前连续出场都定不了界），所以：
// state 写了章号锚点才精确对账；没写锚点只给引导项（no=0），不进 findings 总账。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LoreInput } from '../src/watchdog';
import { exitReport } from '../src/watchdog';

const ch = (id: string, cast?: string, content = '正文。') => ({ id, title: '第' + id + '章', cast, content });
const proj = (chapters: LoreInput['chapters'], characters: LoreInput['characters']): LoreInput =>
  ({ mode: 'chapters', chapters, characters }) as LoreInput;

test('state 带章号锚点：锚点之后的 cast 点名报出来', () => {
  const p = proj([ch('c1', '林越', '林越走在雾里。'), ch('c2', '', '雾更大了。'), ch('c3', '林越', '坟前长满荒草。')], [
    { name: '林越', state: '已在第一章末死去' },
  ]);
  const out = exitReport(p);
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.equal(out[0].no, 3);
  assert.equal(out[0].anchor, 1, '锚点是「第一章」');
});

test('锚点之前的点名不报：state 说第二章才死，第二章的出场是对的', () => {
  const p = proj([ch('c1', '林越'), ch('c2', '林越', '他倒下了。')], [{ name: '林越', state: '第二章死去' }]);
  assert.deepEqual(exitReport(p), []);
});

test('锚点支持阿拉伯数字与汉字数字（锚点章的出场不报，之后才报）', () => {
  const mk = (state: string) => proj([ch('c1', '林越', '他在。'), ch('c2', '林越', '他还演。'), ch('c3', '林越')], [{ name: '林越', state }]);
  assert.deepEqual(exitReport(mk('第1章起失踪')).map((f) => f.no), [2, 3], '阿拉伯数字：锚点之后每处点名都报');
  assert.deepEqual(exitReport(mk('第二章起离队南下')).map((f) => f.no), [3], '汉字数字：第二章还在演，第三章起可疑');
});

test('state 有回归/否定说法：不按离场报', () => {
  for (const state of ['本以为死了，结果归来', '没死，只是失踪多年后回来了']) {
    const p = proj([ch('c1', '林越')], [{ name: '林越', state }]);
    assert.deepEqual(exitReport(p), [], state);
  }
});

test('名单注了「回忆 / 闪回 / 未露面」：豁免', () => {
  for (const cast of ['林越（回忆）', '林越（闪回）', '林越（未露面）']) {
    const p = proj([ch('c1', '林越', '他在。'), ch('c2', cast)], [{ name: '林越', state: '第1章末死去' }]);
    assert.deepEqual(exitReport(p), [], cast);
  }
});

test('只对账 cast 点名：正文提到、名单没写的不报（回忆与提及太常见）', () => {
  const p = proj([ch('c1', '林越', '林越走在雾里。'), ch('c2', '阿禾', '阿禾想起林越说过的话。')], [
    { name: '林越', state: '第1章末死去' },
    { name: '阿禾' },
  ]);
  assert.deepEqual(exitReport(p), []);
});

test('state 没写章号锚点：给引导项（no=0），不硬报', () => {
  const p = proj([ch('c1', '林越', '他在。'), ch('c2', '林越')], [{ name: '林越', state: '已死' }]);
  const out = exitReport(p);
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.equal(out[0].no, 0, '引导项不计入 findings');
  assert.equal(out[0].anchor, null);
});

test('单篇模式直接不跑；名单从没点过名也不产生任何项', () => {
  const single: LoreInput = { mode: 'single', draft: '林越还在。', characters: [{ name: '林越', state: '已死' }] };
  assert.deepEqual(exitReport(single), []);
  const p = proj([ch('c1', '', '只有雾。')], [{ name: '林越', state: '已死' }]);
  assert.deepEqual(exitReport(p), []);
});
