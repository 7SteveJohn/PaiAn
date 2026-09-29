// 双轨时间轴的锚点：切带按「trim 后相邻同标签」、重复标签才报疑似闪回、空标签不算。
// 这几条飘了，图上就会把正常书写画成闪回、或者把真闪回藏起来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repeatedLabels, runText, timeRuns, trackLayout } from '../src/timeline';

const ch = (timeLabel?: string) => ({ timeLabel });

test('连续同标签并成一段，trim 后才算同一个', () => {
  const runs = timeRuns([ch(' 九月 '), ch('九月'), ch('九月'), ch('十月')]);
  assert.deepEqual(
    runs.map((r) => [r.label, r.from, r.to]),
    [
      ['九月', 1, 3],
      ['十月', 4, 4],
    ],
    JSON.stringify(runs),
  );
});

test('同标签被隔开就算两段（这是疑似闪回的原料）', () => {
  const runs = timeRuns([ch('九月'), ch('十月'), ch('九月')]);
  assert.equal(runs.length, 3);
  assert.deepEqual(runs[2], { label: '九月', from: 3, to: 3 });
});

test('未标注也是一段（画灰块），空书返回空', () => {
  assert.deepEqual(timeRuns([ch('九月'), ch(), ch()]), [
    { label: '九月', from: 1, to: 1 },
    { label: '', from: 2, to: 3 },
  ]);
  assert.deepEqual(timeRuns([]), []);
});

test('重复标签：非空且出现 ≥2 段才报，按首次出现排序', () => {
  const repeats = repeatedLabels([ch('九月'), ch('十月'), ch(' 九月 '), ch('冬'), ch('十月')]);
  assert.deepEqual(
    repeats.map((g) => [g.label, g.runs.map((r) => [r.from, r.to])]),
    [
      ['九月', [[1, 1], [3, 3]]],
      ['十月', [[2, 2], [5, 5]]],
    ],
    JSON.stringify(repeats),
  );
});

test('未标注出现多少次都不算重复', () => {
  assert.deepEqual(repeatedLabels([ch(), ch(), ch('九月'), ch()]), []);
});

test('布局：与章节序同一比例尺，重复标签有标记', () => {
  const t = trackLayout([ch('九月'), ch('九月'), ch('十月'), ch('九月')]);
  assert.equal(t.total, 4);
  assert.equal(t.dots.length, 4);
  assert.equal(t.dots[3].labeled, true);
  // 三个带：九月(1-2)、十月(3)、九月(4)；后两个 x 首尾相接铺满 [0,1]
  assert.deepEqual(
    t.blocks.map((b) => [b.label, +b.x0.toFixed(4), +b.x1.toFixed(4), b.repeated]),
    [
      ['九月', 0, 0.5, true],
      ['十月', 0.5, 0.75, false],
      ['九月', 0.75, 1, true],
    ],
    JSON.stringify(t.blocks),
  );
});

test('空书布局不炸，区间文案单章与多章两种形', () => {
  const t = trackLayout([]);
  assert.equal(t.total, 0);
  assert.deepEqual(t.blocks, []);
  assert.deepEqual(t.dots, []);
  assert.equal(runText({ label: '九月', from: 3, to: 3 }), '第 3 章');
  assert.equal(runText({ label: '九月', from: 3, to: 5 }), '第 3–5 章');
});
