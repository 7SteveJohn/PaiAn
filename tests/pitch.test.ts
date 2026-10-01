// 琴键与天平的锚点：说话人归属宁缺勿滥、缺席章数按「说话或列名单」算、
// 归一化不能被一章超长句带跑。这几条一旦飘了，画出来的图就是骗人的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Project } from '../src/types';
import { attributeSpeaker, dialogueLines, median, normalize, rollOf, rollsOf, silences } from '../src/pitch';

const NAMES = ['林越', '阿禾', '雾隐师', '老周'];

const proj = (chapters: { id: string; title: string; content: string; cast?: string }[]): Project =>
  ({
    id: 'p',
    title: 't',
    type: '小说',
    status: '写作中',
    deadline: '',
    notes: '',
    draft: '',
    linkedIdeaIds: [],
    createdAt: '',
    updatedAt: '',
    mode: 'chapters',
    chapters: chapters.map((c) => ({ ...c, createdAt: '', updatedAt: '' })),
    characters: NAMES.map((n, i) => ({ id: 'k' + i, name: n, state: '', log: [], relations: [] })),
  }) as Project;

test('台词切分：按引号成对取出，顺序与位置都对', () => {
  const body = '她开口：「第一句。」\n他后退半步：「第二句，别过来。」\n无引号的叙述不算。';
  const lines = dialogueLines(body);
  assert.equal(lines.length, 2, `只该认出两行台词：${lines.map((l) => l.text).join(' / ')}`);
  assert.ok(lines[0].text.startsWith('「第一句'), lines[0].text);
  assert.ok(lines[1].start > lines[0].end, '位置要按出现顺序');
});

test('说话人归属：紧贴引号的名字才算，找不到就留白', () => {
  // 行对象一律用 dialogueLines 拿（它给的是闭区间右移一位的 end，手写下标容易错）
  const line = (body: string, i = 0) => dialogueLines(body)[i];
  assert.equal(attributeSpeaker('林越说：「走。」', line('林越说：「走。」'), NAMES), '林越', '「X 说：」前挂式该认出来');
  assert.equal(attributeSpeaker('「走。」林越说。', line('「走。」林越说。'), NAMES), '林越', '「」X 说。」后挂式该认出来');
  assert.equal(attributeSpeaker('「走。」', line('「走。」'), NAMES), '', '没人可归就别硬塞');
  // 「阿禾看向雾隐师：」——引号前那句里有两个名字，离引号近的才作数
  assert.equal(attributeSpeaker('阿禾看向雾隐师：「上船。」', line('阿禾看向雾隐师：「上船。」'), NAMES), '雾隐师', '两个名字都出现时取离引号更近的那个');
  // 上一行的「XX 问」不许串到这一行来
  const two = '林越问：「你上错船了？」\n阿禾摇头：「没有。」';
  assert.equal(attributeSpeaker(two, line(two, 1), NAMES), '阿禾', '上一行的「林越问」不许串到这一行');
  // 换行后隔着一整段叙述的名字不算数
  const far = '「第三句。」\n\n他走了半条街，林越后来才说：「跟上。」';
  assert.equal(attributeSpeaker(far, line(far, 0), NAMES), '', '隔着一整段叙述的名字不该认领');
  assert.equal(attributeSpeaker(far, line(far, 1), NAMES), '林越', '同一行里前一句挂的名字要能认出来');
});

test('一章的天平：行数、字数与话最多的人', () => {
  const body = ['林越问：「你上错船了？」', '阿禾摇头：「没有。」', '「那就好。」林越说。', '雾隐师只留下一句：「天亮前走。」', '叙述一句没有引号。'].join('\n');
  const r = rollOf(1, '第一章', body, NAMES);
  const lin = r.speakers.find((s) => s.name === '林越');
  assert.ok(lin && lin.lines === 2, `林越该两句：${JSON.stringify(r.speakers)}`);
  assert.equal(r.top, '林越', '话最多的不是林越：top=' + r.top + ' sp=' + JSON.stringify(r.speakers));
  assert.equal(r.quoted, 4);
  assert.equal(r.spoken, 4, 'spoken=' + r.spoken);
  assert.equal(r.unknown, 0, 'unknown=' + r.unknown + ' quoted=' + r.quoted + ' sp=' + JSON.stringify(r.speakers));
  assert.ok(r.dialogueShare > 40 && r.dialogueShare <= 100, `对白占比该不低：${r.dialogueShare}`);
});

test('归属不明的台词单独计，不摊到某个角色头上', () => {
  const r = rollOf(1, '第一章', '「你是谁？」\n「不重要。」林越说。', NAMES);
  assert.equal(r.unknown, 1, JSON.stringify(r.speakers));
  assert.equal(r.spoken, 1);
  assert.equal(r.inferred, 0, '单锚不成对话，不许靠轮替硬塞');
});

test('轮替推断：两人连续对话，没挂名的行按一问一答顶上', () => {
  const body = '林越问：「你上错船了？」\n「没有。」\n阿禾摇头：「真的？」';
  const r = rollOf(1, '第一章', body, NAMES);
  const lin = r.speakers.find((s) => s.name === '林越');
  const ah = r.speakers.find((s) => s.name === '阿禾');
  assert.ok(ah && ah.lines === 2, `阿禾该认领两句（1 推断 + 1 确定）：${JSON.stringify(r.speakers)}`);
  assert.ok(ah && ah.inferred === 1, `其中一句该标成推断：${JSON.stringify(ah)}`);
  assert.ok(lin && lin.lines === 1 && lin.inferred === 0);
  assert.equal(r.unknown, 0, '推断过的行不该再算归属不明');
  assert.equal(r.inferred, 1);
  assert.equal(r.spoken, 3);
});

test('连续几行无名的对白一路交替，尾锚对上才成立', () => {
  const r = rollOf(1, '第一章', '林越问：「一？」\n阿禾道：「二。」\n「三。」\n「四。」\n阿禾道：「五。」', NAMES);
  const lin = r.speakers.find((s) => s.name === '林越');
  const ah = r.speakers.find((s) => s.name === '阿禾');
  assert.ok(lin && lin.lines === 2 && lin.inferred === 1, `林越 1 确定 + 1 推断：${JSON.stringify(r.speakers)}`);
  assert.ok(ah && ah.lines === 3 && ah.inferred === 1, `阿禾 2 确定 + 1 推断：${JSON.stringify(r.speakers)}`);
  assert.equal(r.inferred, 2);
  assert.equal(r.unknown, 0);
});

test('推断与后面的确定锚对不上：整段作废，宁留白不硬塞', () => {
  const r = rollOf(1, '第一章', '林越问：「一？」\n「二。」\n林越道：「三。」', NAMES);
  assert.equal(r.unknown, 1, `推出来的人跟尾锚冲突，该整段留白：${JSON.stringify(r.speakers)}`);
  assert.equal(r.inferred, 0);
});

test('三个人的对话链不轮替：两人规则管不了三人局', () => {
  const r = rollOf(1, '第一章', '林越问：「一？」\n「二。」\n雾隐师道：「三。」\n「四。」\n老周道：「五。」', NAMES);
  assert.equal(r.unknown, 2, `三人链全留白：${JSON.stringify(r.speakers)}`);
  assert.equal(r.inferred, 0);
});

test('只有一个确定锚不开轮替：分不清独白还是对话', () => {
  const r = rollOf(1, '第一章', '林越问：「一？」\n「二。」\n「三。」', NAMES);
  assert.equal(r.unknown, 2, JSON.stringify(r.speakers));
  assert.equal(r.inferred, 0);
});

test('两行台词之间隔着叙述就不算连续对话，链断开', () => {
  const r = rollOf(1, '第一章', '林越问：「一？」\n他顿了顿。\n「二。」\n阿禾道：「三。」', NAMES);
  assert.equal(r.unknown, 1, `叙述断链后第二段只剩一个锚：${JSON.stringify(r.speakers)}`);
  assert.equal(r.inferred, 0);
});

test('长台词不参与轮替：留白，但仍占一个轮替位', () => {
  const long = '这'.repeat(70);
  const r = rollOf(1, '第一章', `林越问：「一。」\n「${long}」\n阿禾道：「二。」`, NAMES);
  assert.equal(r.unknown, 1, `长过上限的行该留白：${JSON.stringify(r.speakers)}`);
  assert.equal(r.inferred, 0);
  // 长行占位把轮替位让出来后，后面的短行仍能被尾锚校验通过
  const r2 = rollOf(1, '第一章', `林越问：「一。」\n阿禾道：「二。」\n「${long}」\n「三。」\n阿禾道：「四。」`, NAMES);
  const ah = r2.speakers.find((s) => s.name === '阿禾');
  assert.ok(ah && ah.lines === 3 && ah.inferred === 1, `短行该顶上、长行留白：${JSON.stringify(r2.speakers)}`);
  assert.equal(r2.inferred, 1);
  assert.equal(r2.unknown, 1);
});

test('轮替推断可关闭：关掉就回到认不出全留白的口径', () => {
  const body = '林越问：「你上错船了？」\n「没有。」\n阿禾摇头：「真的？」';
  const off = rollOf(1, '第一章', body, NAMES, false);
  assert.equal(off.unknown, 1, JSON.stringify(off.speakers));
  assert.equal(off.inferred, 0);
  assert.equal(off.speakers.find((s) => s.name === '阿禾')?.lines, 1);
  const p = proj([{ id: 'c1', title: '第一章', content: body }]);
  const rolls = rollsOf(p, false);
  assert.equal(rolls[0].inferred, 0, 'rollsOf 的开关要透传');
});

test('琴键只收有正文的章，章号连续', () => {
  const p = proj([
    { id: 'c1', title: '第一章', content: '林越说：「一。」' },
    { id: 'c2', title: '第二章', content: '   ' },
    { id: 'c3', title: '第三章', content: '阿禾道：「三。」' },
  ]);
  const rolls = rollsOf(p);
  assert.deepEqual(rolls.map((r) => r.title), ['第一章', '第三章']);
  assert.deepEqual(rolls.map((r) => r.no), [1, 2], '章号按已写章重排，画出来才是一格一章');
});

test('中位数与归一化：一章超长句不该把整条基准线拉飞', () => {
  const rolls = [
    { avgSentence: 8 },
    { avgSentence: 9 },
    { avgSentence: 200 },
    { avgSentence: 10 },
  ].map((x, i) => ({ ...x, no: i + 1, title: '', chars: 1000, sentences: 10, maxSentence: 40, dialogueShare: 20, pronounOpen: 1, paragraphs: 5, opener: '', endsOnTalk: false, deslop: {}, speakers: [], spoken: 0, quoted: 0, unknown: 0, inferred: 0, top: '' }));
  assert.equal(median([8, 9, 200, 10]), 9.5);
  const { med, bars } = normalize(rolls);
  assert.equal(med, 9.5, '基准线取中位数');
  assert.ok(bars.every((b) => b.pitch >= 0 && b.pitch <= 1), '条高必须夹在 0-1');
  assert.ok(bars[0].pitch > 0.3 && bars[0].pitch < 0.7, `正常章的条高该在中间：${bars[0].pitch}`);
  assert.equal(bars[2].pitch, 1, '极端长句顶到底就行，不该撑爆画布');
});

test('缺席统计：说话或进出场名单都算在场', () => {
  const chapters = [
    { id: 'c1', title: '第一章', content: '林越说：「在。」阿禾道：「也在。」', cast: '林越、阿禾' },
    { id: 'c2', title: '第二章', content: '林越说：「还在。」', cast: '林越' },
    { id: 'c3', title: '第三章', content: '林越说：「一个人。」' },
    { id: 'c4', title: '第四章', content: '林越说：「还是一个人。」' },
    { id: 'c5', title: '第五章', content: '老周说：「有人来了。」', cast: '阿禾' },
  ];
  const p = proj(chapters);
  const list = silences(p, rollsOf(p));
  const ah = list.find((s) => s.name === '阿禾')!;
  assert.equal(ah.gap, 3, `阿禾第 2–4 章连缺三章：${ah.gap}`);
  assert.equal(ah.lastSpoke, 1);
  const lin = list.find((s) => s.name === '林越')!;
  assert.equal(lin.gap, 1, '林越只在最后一章缺席');
  assert.ok(list[0].name === '阿禾' || list[0].gap >= 2, '最该被点名的排前面');
  // 只在名单里出现却没说话：算在场，但一次也没开口
  const wu = list.find((s) => s.name === '雾隐师')!;
  assert.equal(wu.inCast, 0);
  assert.equal(wu.lastSpoke, 0, '从没开过口');
});

test('空作品与无对白章都不该报错', () => {
  assert.deepEqual(rollsOf(proj([])), []);
  assert.deepEqual(normalize([]).bars, []);
  assert.equal(normalize([]).med, 0);
  const s = silences(proj([{ id: 'c1', title: '第一章', content: '整段叙述，一句引号都没有。' }]), rollsOf(proj([{ id: 'c1', title: '第一章', content: '整段叙述，一句引号都没有。' }])));
  assert.ok(s.every((x) => x.lastSpoke === 0 && x.gap === 1));
});
