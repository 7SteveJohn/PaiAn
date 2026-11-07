// 口头禅雷达 / 平台惯例预检 / 冲刺结算：三个纯函数的回归钉。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTics } from '../src/tics';
import { checkSubmission, chapterDiagnosis } from '../src/submit-rules';
import { settleSprint, sprintLeftMs, fmtClock } from '../src/sprint';

test('口头禅：跨章重复片段上榜，报次数/每千字/首处位置', () => {
  const para = '雾从码头漫上来。他站在码头尽头，看雾吃掉灯，看雾吃掉桅杆。';
  const hits = findTics(
    [
      { id: 'c1', title: '第一章', content: para },
      { id: 'c2', title: '第二章', content: para },
      { id: 'c3', title: '第三章', content: para },
      { id: 'c4', title: '第四章', content: para },
    ],
    { minCount: 3 },
  );
  const ma = hits.find((h) => h.text === '码头');
  assert.ok(ma, '「码头」必须上榜');
  assert.ok(ma.count >= 8, `「码头」出现 8 次，实报 ${ma.count}`);
  assert.equal(ma.chapterId, 'c1', '首处落在第一章');
  assert.equal(ma.at, 2, '首处是「码头」的起点（雾0 从1 码2）');
  assert.ok(ma.per1k > 0, '每千字指标要有值');
});

test('口头禅：长组合吸收短组合，「试试看」在榜则「试试」不该陪跑', () => {
  const hits = findTics([{ id: 'c1', title: '一', content: '试试看试试看试试看，别光试试看。' }], { minCount: 2 });
  assert.ok(hits.some((h) => h.text === '试试看'), '三字组本身要在榜');
  assert.ok(!hits.some((h) => h.text === '试试'), '三字组的高频不该把它的前两字也抬上榜');
});

test('口头禅：全虚字组合不报，拉丁词整词计数', () => {
  const hits = findTics(
    [{ id: 'c1', title: '一', content: '的是的是的是的，你说 OK 我说 OK 大家都说 OK。' }],
    { minCount: 3 },
  );
  assert.ok(!hits.some((h) => h.text === '的是'), '全虚字组合是噪声');
  const ok = hits.find((h) => h.text === 'ok');
  assert.ok(ok && ok.count >= 3, '拉丁词按整词计数');
});

test('平台惯例：长段报首处位置、短章告警、对白占比两端都有提示', () => {
  const longPara = '长'.repeat(320);
  const findings = checkSubmission([
    { id: 'a', title: '短章', content: `太短。\n${longPara}` },
    { id: 'b', title: '纯对白', content: '他说：「' + '好'.repeat(600) + '」她说：「' + '行'.repeat(300) + '」' },
    { id: 'c', title: '纯叙述', content: '叙'.repeat(600) },
  ]);
  const a = findings.filter((f) => f.chapterId === 'a');
  assert.ok(a.some((f) => f.kind === '章长' && f.level === 'warn'), '800 字以下报章长');
  const para = a.find((f) => f.kind === '长段');
  assert.ok(para, '长段要报');
  assert.equal(para!.at, 4, '长段跳转点落在长段首字符（前文 4 字）');

  const b = findings.find((f) => f.chapterId === 'b' && f.kind === '对白比');
  assert.ok(b && b.level === 'info', '几乎全对白要有提示');
  const c = findings.find((f) => f.chapterId === 'c' && f.kind === '对白比');
  assert.ok(c && c.level === 'info', '几乎零对白要有提示');
});

test('平台惯例：正常章零发现', () => {
  const body = Array.from({ length: 30 }, (_, i) => `第${i}段，写了两行左右的日常叙述。他说：「行，就这么办。」她点头，转身出门。`).join('\n');
  const findings = checkSubmission([{ id: 'ok', title: '正常章', content: body.repeat(4) }]);
  assert.deepEqual(findings, [], '字数合适、段落正常、对白适中的章不该有发现');
});

test('冲刺结算：时长取整、字数取差值并压 0 下限', () => {
  const start = Date.parse('2026-11-07T10:00:00.000Z');
  const s = { start, minutes: 25, baseWords: 1000 };
  const end = start + 25 * 60_000 + 20_000;
  const rec = settleSprint(s, 1580, end);
  assert.equal(rec.minutes, 25, '到点结算按计划时长计');
  assert.equal(rec.words, 580, '字数是今日字数差');
  const early = settleSprint(s, 1050, start + 90_000);
  assert.equal(early.minutes, 2, '提前结束按实际时长向上取整（90s → 2 分钟）');
  assert.equal(early.words, 50);
  const negative = settleSprint(s, 800, end);
  assert.equal(negative.words, 0, '删改回扣到负数压 0');
  assert.equal(sprintLeftMs(s, start + 24 * 60_000), 60_000);
  assert.equal(fmtClock(61_500), '01:02', '时钟向上取整到秒');
});

test('本章诊断：各路体检聚合成行、带首处位置；全干净的章一行不出', () => {
  const rows = chapterDiagnosis({
    id: 'c1',
    title: '一',
    content: '太短。',
    deslopCount: 2,
    forbiddenHits: [{ word: '瞬间', count: 3, at: 5 }],
    sensitiveHits: [{ word: '血腥', count: 1, at: 9 }],
    openForeshadow: 1,
    orphanedMarks: 2,
  });
  const keys = rows.map((r) => r.key);
  for (const k of ['deslop', 'forbidden', 'sensitive', 'foreshadow', 'orphaned']) assert.ok(keys.includes(k), `${k} 行要出现`);
  assert.ok(keys.some((k) => k.startsWith('rule')), '短章还要带出平台惯例的章长行');
  const fb = rows.find((r) => r.key === 'forbidden')!;
  assert.equal(fb.n, 3, '禁用词行计数合并');
  assert.equal(fb.at, 5, '禁用词行带首处位置');
  const clean = chapterDiagnosis({
    id: 'c2',
    title: '二',
    content: Array.from({ length: 30 }, (_, i) => `第${i}段。他说：「行，就这么办。」她点头，转身出门。`).join('\n').repeat(3),
    deslopCount: 0,
    forbiddenHits: [],
    sensitiveHits: [],
    openForeshadow: 0,
    orphanedMarks: 0,
  });
  assert.deepEqual(clean, [], '全干净的章一行都不出');
});
