// 场景块切分的纯函数断言。核心只有一条：**拼回去必须与原稿逐字节相等**。
// 切块是看结构的手段，不是重排格式的机会——一旦这里丢字节，作者点开面板再关掉，
// 一章稿子就被静默改过（自动保存还会把它记进历史版本），那种 bug 没人能当场发现。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendBlock, blockExcerpt, dropBlock, escCancelsDrag, joinScenes, moveBlock, removeBlockFrom, splitScenes, swapBlocks } from '../src/scenes';

const SAMPLES: [string, string][] = [
  ['空文本', ''],
  ['只有换行', '\n\n\n'],
  ['单块无换行', '只有一段'],
  ['两块', '第一块。\n\n第二块。'],
  ['结尾有换行', '第一块。\n\n第二块。\n'],
  ['结尾两个空行', '第一块。\n\n第二块。\n\n\n'],
  ['开头有空行', '\n\n上来先空一行。\n\n下一块。'],
  ['块内多行', '一段的两行\n还是同一段\n\n第二段\n\n第三段。'],
  ['单换行分段', '林越蹲在缆桩边。\n船没有来。\n阿禾在身后说话。'],
  ['块间多个空行', '第一块。\n\n\n\n第二块。\n\n第三块。'],
  ['CRLF 全篇', '第一块。\r\n\r\n第二块。\r\n\r\n第三块。\r\n'],
  ['CRLF 块内多行', '一行的尾\r\n还是这段\r\n\r\n下一段\r\n'],
  ['空白行带空格', '第一块。\n \t \n第二块。'],
  ['markdown 标题当分场', '## 灯塔\n\n灯灭了。\n\n## 码头\n\n船也没有。'],
  ['真稿样本', '雨从后半夜开始下。\n\n　　林越蹲在第七根缆桩边，把半枚铜印在掌心里翻了个面。船没有来。他在心里数到第十一，才听见身后有脚步。\n\n　　「你在这里做什么？」\n\n　　阿禾的声音比雨还轻。他没有回头。\n\n　　雾从海面涌上码头时，第一班船照例会响三声汽笛。可那年的雾里没有汽笛。\n'],
];

const roundTrip = (t: string) => assert.equal(joinScenes(splitScenes(t)), t, '拼回去与原稿不一致：' + JSON.stringify(t));

test('切块拼回：15 种形状全部逐字节相等', () => {
  for (const [name, t] of SAMPLES) {
    const s = splitScenes(t);
    assert.equal(joinScenes(s), t, name + ' 的往返不一致');
    assert.equal(s.gaps.length, s.items.length + 1, name + ' 的 gaps 长度不守恒');
  }
});

test('往返与换行风格无关：同一章 CRLF 版与 LF 版切出的块内容一致', () => {
  const lf = splitScenes(SAMPLES[14][1]);
  const crlf = splitScenes(SAMPLES[14][1].replace(/\n/g, '\r\n'));
  // 块内行尾的 \r 是原稿的一部分（切块不许规整），比对 LF 版时才剥掉
  assert.deepEqual(crlf.items.map((i) => i.replace(/\r/g, '')), lf.items);
  assert.equal(lf.items.length, 5, '真稿样本该切出 5 块');
});

test('单换行分段自动退到「段」粒度，空行分场用「场」', () => {
  assert.equal(splitScenes('一段\n二段\n三段').unit, '段');
  assert.equal(splitScenes('第一段。\n\n第二段。').unit, '场');
  assert.equal(splitScenes('一段的两行\n还在同一段').unit, '段');
  assert.equal(splitScenes('只有一段').unit, '场');
  assert.equal(splitScenes('').items.length, 0);
});

test('重排只动块顺序：字节数与空隙形状一个不变', () => {
  for (const [, t] of SAMPLES) {
    const s = splitScenes(t);
    if (s.items.length < 2) continue;
    const moved = moveBlock(s, 0, s.items.length);
    const back = moveBlock(moved, s.items.length - 1, 0);
    assert.equal(joinScenes(back), t, '移出去再移回来不等于原稿：' + JSON.stringify(t));
    assert.equal(joinScenes(moved).length, t.length, '重排改变了总字节数');
    assert.deepEqual(moved.gaps, s.gaps, '重排动了空隙');
  }
});

test('移到末尾、越界夹紧、原地移动', () => {
  const s = splitScenes('一。\n\n二。\n\n三。');
  assert.deepEqual(moveBlock(s, 0, 3).items, ['二。', '三。', '一。']);
  assert.deepEqual(moveBlock(s, 2, 0).items, ['三。', '一。', '二。']);
  assert.deepEqual(moveBlock(s, 1, 1).items, s.items);
  assert.equal(moveBlock(s, 9, 0), s, '越界起点该原样返回');
  assert.deepEqual(moveBlock(s, -1, 1).items, s.items);
});

test('相邻上下移：到底了不动，不越界', () => {
  const s = splitScenes('一。\n\n二。\n\n三。');
  assert.deepEqual(swapBlocks(s, 0, 1).items, ['二。', '一。', '三。']);
  assert.deepEqual(swapBlocks(s, 2, 3).items, s.items, '越界终点该原样返回');
  assert.equal(joinScenes(swapBlocks(s, 0, 1)).length, joinScenes(s).length);
});

test('摘走一块：正文少掉这一块，空行不留洞', () => {
  const s = splitScenes('一。\n\n二。\n\n三。');
  const mid = dropBlock(s, 1);
  assert.equal(joinScenes(mid), '一。\n\n三。');
  const last = dropBlock(s, 2);
  assert.equal(joinScenes(last), '一。\n\n二。', '摘掉末块后结尾不该拖着一串空行');
  const first = dropBlock(s, 0);
  assert.equal(joinScenes(first), '二。\n\n三。');
  assert.equal(joinScenes(dropBlock(s, 9)), joinScenes(s), '越界摘除不该改动');
});

test('摘掉唯一一块只剩空白，拼回去仍是那串空白', () => {
  const s = splitScenes('唯一一块。\n');
  const d = dropBlock(s, 0);
  assert.deepEqual(d.items, []);
  assert.equal(joinScenes(d), '\n', 'EOF 的换行留住，空白不该翻倍');
});

test('整块搬去下一章：目标末尾补一个空行，已有空行就不重复', () => {
  assert.equal(appendBlock('那边已经有正文。\n', '搬来的一块。'), '那边已经有正文。\n\n搬来的一块。');
  assert.equal(appendBlock('那边已经空过行。\n\n', '搬来的一块。'), '那边已经空过行。\n\n搬来的一块。');
  assert.equal(appendBlock('', '搬来的一块。'), '搬来的一块。');
  assert.equal(appendBlock('   \n', '搬来的一块。'), '搬来的一块。', '只有空白的章等于空章');
  assert.equal(appendBlock('CRLF 章。\r\n', '搬来的一块。'), 'CRLF 章。\r\n\r\n搬来的一块。', 'CRLF 稿子不该混进 LF');
  assert.equal(appendBlock('没有换行结尾', '块'), '没有换行结尾\n\n块');
});

test('取回整块（跨章「退回」的反向）：只认完整块，找不到就一字不动', () => {
  const t = '那边已经有正文。\n\n搬来的一块。';
  assert.equal(removeBlockFrom(t, '搬来的一块。'), '那边已经有正文。');
  assert.equal(removeBlockFrom('搬来的一块。\n\n第一块。', '搬来的一块。'), '第一块。');
  // 只在句中引用过那句话：不是整块，不许动手
  assert.equal(removeBlockFrom('他说过搬来的一块，没别人。', '搬来的一块'), '他说过搬来的一块，没别人。');
  // 中间那块取回来，两侧空行合并成一条缝
  assert.equal(removeBlockFrom('一。\n\n二。\n\n三。', '二。'), '一。\n\n三。');
});

test('一块里的多行都留在这一块：块首不能被内层循环推走', () => {
  // 往返逐字节相等抓不到这个错——前几行会被当成「空隙」吃掉，拼回去照样相等。
  // 所以块的**内容**必须单独钉一条。
  const s = splitScenes('缆桩\n雾还没散。\n\n灯塔\n灯灭了。');
  assert.equal(s.unit, '场');
  assert.deepEqual(s.items, ['缆桩\n雾还没散。', '灯塔\n灯灭了。']);
  assert.deepEqual(s.gaps, ['', '\n\n', '']);
  assert.deepEqual(splitScenes('甲\n乙\n丙').items, ['甲', '乙', '丙'], '段粒度下每行一块');
});

test('卡片标题取块内第一行，去掉 markdown 记号并截断', () => {
  assert.equal(blockExcerpt('## 灯塔\n\n灯灭了。'), '灯塔');
  assert.equal(blockExcerpt('\n\n- 项目符号开头'), '项目符号开头');
  assert.equal(blockExcerpt('「你在这里做什么？」'), '「你在这里做什么？」');
  assert.equal(blockExcerpt('很长很长'.repeat(20), 12).length, 13, '截断后应留一个省略号');
});

test('Esc 只在拖动进行中归场景板管：没在拖的透传给全局「收工」，别的键也不吞', () => {
  assert.equal(escCancelsDrag('Escape', true), true, '拖动中按 Esc：取消这次拖动');
  assert.equal(escCancelsDrag('Escape', false), false, '没在拖：Esc 是收抽屉/退专注的事，场景板不掺和');
  assert.equal(escCancelsDrag('Enter', true), false, '别的键不归场景板');
  assert.equal(escCancelsDrag(undefined, true), false, '没有键值的不认');
});
