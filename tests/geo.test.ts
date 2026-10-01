// 地点层级的锚点：链按 parent 串、环与悬空截断不猜、展示序父在子前、碎片关联长名优先。
// 这几条飘了，地点卡上就会画出「码头 › 码头」这种鬼东西，或者把「雾港」错当成「雾港码头」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldItem } from '../src/types';
import { fragmentLinks, placeChain, placeRows } from '../src/geo';

const place = (name: string, parent?: string): WorldItem => ({ id: 'w-' + name, name, kind: '地点', content: '', ...(parent ? { parent } : {}) });
const other = (name: string): WorldItem => ({ id: 'w-' + name, name, kind: '设定', content: '' });

test('归属链：从自己一路串到顶层', () => {
  const items = [place('雾港'), place('码头', '雾港'), place('七号栈桥', '码头')];
  assert.deepEqual(placeChain(items[2], items), ['雾港', '码头', '七号栈桥']);
  assert.deepEqual(placeChain(items[1], items), ['雾港', '码头']);
  assert.deepEqual(placeChain(items[0], items), ['雾港']);
});

test('parent 指向不存在的名字：悬空，链在那里截断，不报错', () => {
  const items = [place('码头', '不存在的港')];
  assert.deepEqual(placeChain(items[0], items), ['码头']);
});

test('成环（互相指 / 指自己）：截断，别把渲染搞死', () => {
  const a = place('甲', '乙');
  const b = place('乙', '甲');
  const chainA = placeChain(a, [a, b]);
  assert.equal(chainA.length, 2, '甲→乙→(乙已走过) 停：' + JSON.stringify(chainA));
  assert.deepEqual(placeChain(place('自指', '自指'), [place('自指', '自指')]), ['自指']);
});

test('只有「地点」参与成链，别的 kind 不该被 parent 认领', () => {
  const items = [place('雾港'), { ...place('灯塔'), parent: '雾港' }, other('雾港传说')];
  assert.deepEqual(placeChain(items[1], items), ['雾港', '灯塔']);
});

test('展示序：同一根的挨在一起、父在子前；悬空的标出来', () => {
  const items = [place('码头', '雾港'), place('雾港'), place('车站', '不存在的城')];
  const rows = placeRows(items);
  assert.deepEqual(
    rows.map((r) => r.item.name),
    ['雾港', '码头', '车站'],
    JSON.stringify(rows.map((r) => r.chain)),
  );
  assert.equal(rows[1].depth, 1);
  assert.equal(rows[2].dangling, true, '车站的 parent 不存在，该标悬空');
  assert.equal(rows[0].dangling, false);
});

test('碎片关联：提到的实体名都标出来，长名优先防子串冒领', () => {
  const names = ['林越', '雾港', '雾港码头'];
  const links = fragmentLinks('林越在雾港码头的栈桥上等了一夜。', names);
  assert.deepEqual(links, ['雾港码头', '林越'], JSON.stringify(links));
  assert.deepEqual(fragmentLinks('什么都没提到。', names), []);
  assert.deepEqual(fragmentLinks('任何文本', ['']), [], '空名字不算');
});

test('非地点（设定卡）不参与碎片关联排序以外的逻辑——只按文本匹配', () => {
  assert.deepEqual(fragmentLinks('提到了铁鸦小队和码头', ['铁鸦', '码头', '铁鸦小队']), ['铁鸦小队', '码头'], '长名吃掉短名');
});
