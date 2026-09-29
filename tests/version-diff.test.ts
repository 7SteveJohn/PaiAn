// 版本对比纯函数的断言。核心只有三条：
// ① 被删掉的段落必须能在 del 里整段找回——这个功能存在的理由就是「昨天删掉的那段描写其实想要」；
// ② 字节守恒：same+del 拼起来按行拆 == 旧稿、same+ins == 新稿，一行都不能多不能少；
// ③ 不撒碎屑：整段重写就整段成块，别把一个段落撕成几十个红绿渣。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffStat, diffTexts, type DiffSpan } from '../src/version-diff';

const byType = (spans: DiffSpan[], t: DiffSpan['t']) =>
  spans.filter((s) => s.t === t).map((s) => s.text).join('');

// 字节守恒：按 span 顺序取旧稿侧（same+del）拼接必须等于「旧稿 + 恰好一个换行」——
// diff 路径里每行（含末行）都带行尾 \n（渲染成删行/增行各占一行的统一 diff 形状），
// 所以拼接恒多一个收尾换行；多一个少一个都说明有行被吞了或重了。新稿侧同理。
// 注意必须按位置过滤，不能「same 拼完再拼 del」——那会把对齐信息抹掉。
function assertByteAccounting(oldText: string, newText: string) {
  const spans = diffTexts(oldText, newText);
  const oldSide = spans.filter((s) => s.t !== 'ins').map((s) => s.text).join('');
  const newSide = spans.filter((s) => s.t !== 'del').map((s) => s.text).join('');
  assert.equal(oldSide, oldText + '\n', '旧稿侧逐行不等：' + JSON.stringify(spans));
  assert.equal(newSide, newText + '\n', '新稿侧逐行不等：' + JSON.stringify(spans));
}

test('完全相同：一段 same，无红无绿', () => {
  const spans = diffTexts('第一段。\n\n第二段。', '第一段。\n\n第二段。');
  assert.deepEqual(spans, [{ t: 'same', text: '第一段。\n\n第二段。' }]);
});

test('被删的段落整段找回（本功能的核心场景）', () => {
  const old = '林越蹲在缆桩边。\n\n船没有来。\n\n雾从海面涌上码头时，第一班船照例会响三声汽笛。';
  const now = '林越蹲在缆桩边。\n\n雾从海面涌上码头时，第一班船照例会响三声汽笛。';
  const spans = diffTexts(old, now);
  const del = byType(spans, 'del');
  assert.ok(del.includes('船没有来。'), '删掉的段落必须在 del 里：' + JSON.stringify(spans));
  assert.ok(!del.includes('林越'), '没删的段落不该标红');
  assertByteAccounting(old, now);
});

test('新增的段落整段标绿', () => {
  const old = '第一段。';
  const now = '第一段。\n\n新加的一段。';
  const spans = diffTexts(old, now);
  assert.ok(byType(spans, 'ins').includes('新加的一段。'));
  assert.equal(byType(spans, 'del'), '');
  assertByteAccounting(old, now);
});

test('段内小改：只标改动的字，不撒整段', () => {
  const old = '今天天气很好，我们去公园散步。';
  const now = '今天天气很好，我们去公园跑步。';
  const spans = diffTexts(old, now);
  assert.equal(byType(spans, 'del'), '散');
  assert.equal(byType(spans, 'ins'), '跑');
  assertByteAccounting(old, now);
});

test('整段重写：整段成块，不撒碎屑', () => {
  const oldPara = '他想起师父临死前说的话：拾荒人捡的不是宝，是债。';
  const newPara = '雨点砸在铁皮棚顶上，噼里啪啦，像谁在上面倒豆子。林越数着雨点，等天黑。';
  const old = '开头一段。\n\n' + oldPara;
  const now = '开头一段。\n\n' + newPara;
  const spans = diffTexts(old, now);
  assert.ok(byType(spans, 'del').includes(oldPara), '旧段要整段在 del 里');
  assert.ok(byType(spans, 'ins').includes(newPara), '新段要整段在 ins 里');
  assertByteAccounting(old, now);
});

test('段内改了一半：相似度够就精比，改的字别扩成整段', () => {
  const base = '他把残片丢进腰间的布袋，布袋发出闷响。今天第七件。够换两块压缩饼，或者半天的清水。他把铁钎插回靴筒，膝盖咔地响了一声。远处，一列没有车头的黑皮列车正从雾里滑出来。';
  const old = base + '车厢上没有窗，只有一排排铆死的铁板。';
  const now = base + '车厢上没有窗，只有一排排锈死的铁板。';
  const spans = diffTexts(old, now);
  assert.equal(byType(spans, 'del'), '铆');
  assert.equal(byType(spans, 'ins'), '锈');
  assertByteAccounting(old, now);
});

test('CRLF 与结尾换行的形状都守恒', () => {
  for (const [old, now] of [
    ['第一段。\r\n\r\n第二段。', '第一段。\r\n\r\n改了。\r\n\r\n第二段。'],
    ['甲\n乙\n', '甲\n丙\n'],
    ['\n\n', ''],
    ['', '第一行\n第二行'],
  ] as [string, string][]) {
    assertByteAccounting(old, now);
  }
});

test('超长配对段落直接整段成块（不进字符精比，不卡）', () => {
  const longA = '旧稿很长的一段。' + '甲'.repeat(4000);
  const longB = '新稿很长的一段。' + '甲'.repeat(200) + '乙'.repeat(3800);
  const t0 = Date.now();
  const spans = diffTexts('头。\n\n' + longA, '头。\n\n' + longB);
  const ms = Date.now() - t0;
  assert.ok(ms < 800, '超长配对应整段成块，实测 ' + ms + 'ms');
  assert.ok(byType(spans, 'del').includes('旧稿很长的一段。'));
  assertByteAccounting('头。\n\n' + longA, '头。\n\n' + longB);
});

test('几万字的章级对比在秒级内完成（日常最大的一章也就几千字）', () => {
  const para = () => '林越沿着锈轨向北走了三里地，断轨尽头的芦苇比人高，风一过就伏成一片。他数着枕木走，第七根下面埋着半枚铜印。';
  const old = Array.from({ length: 400 }, (_, i) => para() + i).join('\n\n');
  const now = Array.from({ length: 400 }, (_, i) => (i % 8 === 3 ? '这一段整段换掉了：' + i : para() + i)).join('\n\n');
  const t0 = Date.now();
  const spans = diffTexts(old, now);
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, '5 万字级对比应在秒级内，实测 ' + ms + 'ms');
  assert.ok(byType(spans, 'del').includes('铜印。3'), '被换掉的段（i=3）要出现在 del 里');
  assert.ok(byType(spans, 'ins').includes('这一段整段换掉了：3'), '替换段要出现在 ins 里');
  assertByteAccounting(old, now);
});

test('diffStat：红绿字数合计正确', () => {
  const spans = diffTexts('甲乙丙丁', '甲XY丁');
  assert.deepEqual(diffStat(spans), { del: 2, ins: 2 });
  assert.deepEqual(diffStat([{ t: 'same', text: '一样' }]), { del: 0, ins: 0 });
});
