// 首屏兜底的断言：合法 JSON 缺字段不该白屏（实测 stats:{} 会让首页 stats.daily[today]
// 抛 TypeError，React 整树卸载）。normalizeStats 是启动路径上最后一个防线。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStats } from '../src/util';

test('normalizeStats：缺 daily/reflection 时补默认值，不再 TypeError', () => {
  assert.deepEqual(normalizeStats({}), { daily: {}, reflection: '', dailyGoal: undefined });
  assert.deepEqual(normalizeStats(undefined), { daily: {}, reflection: '', dailyGoal: undefined });
  assert.deepEqual(normalizeStats(null), { daily: {}, reflection: '', dailyGoal: undefined });
});

test('normalizeStats：有的字段原样保留，不吃合法数据', () => {
  const s = { daily: { '2026-09-28': 500 }, reflection: '今天写了', dailyGoal: 2000 };
  assert.deepEqual(normalizeStats(s), s);
  const partial = { daily: { '2026-09-28': 500 } };
  assert.equal(normalizeStats(partial).reflection, '');
  assert.equal(normalizeStats(partial).daily['2026-09-28'], 500);
});
