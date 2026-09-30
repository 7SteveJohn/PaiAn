// 命令面板的过滤纯函数：空串全量、子串命中、trim 行为——面板交互的其余部分由真实窗口冒烟兜底。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterCommands } from '../src/components/CommandPalette';

const cmds = [
  { label: '打开灵感库', kind: '页面' as const, run: () => {} },
  { label: '打开卡池', kind: '页面' as const, run: () => {} },
  { label: '新建作品（AI 引导）', kind: '动作' as const, run: () => {} },
];

test('filterCommands：空查询返回全部', () => {
  assert.equal(filterCommands(cmds, '').length, 3);
  assert.equal(filterCommands(cmds, '   ').length, 3);
});

test('filterCommands：子串过滤命中 label', () => {
  const r = filterCommands(cmds, '卡池');
  assert.equal(r.length, 1);
  assert.equal(r[0].label, '打开卡池');
  assert.equal(filterCommands(cmds, '不存在的命令').length, 0);
});
