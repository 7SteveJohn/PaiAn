// 笔触漂移的锚点：基准优先取「其它书」，只有一本时退回「本书前段」；
// 短章不进统计；两边都不足 3 章就老实说比不了；卡面在 self 口径下必须说「你」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardsFromGaps, compare, myStats } from '../src/bench';
import { MIN_CHAPTER_CHARS, driftGaps, portrait, type PortraitInput } from '../src/style';

// 对白多、句子短的一路
const TALK = ['「走。」她说。', '「去哪儿？」他问。', '「船十点开，开了就不等人。」', '她先把缆绳解开，手指冻得发白，还是没有停。', '「你不该来。」', '「我偏来。」他说。'].join('\n');
// 只有叙述、句子拖得很长的一路
const NARR =
  '码头上那排缆桩在雾里一直延伸到看不见尽头的地方，他沿着第七根往东走，靴底压过湿漉漉的木板发出的闷响一路都被雾吞掉，只剩下远处某台机器不知疲倦地重复着同一个动作，把整夜的空气搅成一种黏稠的、令人发昏的节奏。' +
  '他想起很多年前也是这样的雾，那时候还没有这条航线，也没有这些后来被写进舱单里的名字，所以此刻他听见自己的呼吸都比平时重了一些，像是怕惊动什么已经知道答案的东西。';

const body = (kind: 'talk' | 'narr') => (kind === 'talk' ? TALK.repeat(3) : NARR);
const book = (id: string, kinds: ('talk' | 'narr')[]): PortraitInput => ({
  id,
  title: id,
  mode: 'chapters',
  chapters: kinds.map((k, i) => ({ id: id + '-' + i, title: `第${i + 1}章`, content: body(k) })),
});
const len = (s: string) => s.length;

test('样本准备：两条路都要够长，否则被短章阈值剔掉', () => {
  assert.ok(len(body('talk')) >= MIN_CHAPTER_CHARS, `对白样本 ${len(body('talk'))} 字`);
  assert.ok(len(body('narr')) >= MIN_CHAPTER_CHARS, `叙述样本 ${len(body('narr'))} 字`);
  assert.ok(!body('narr').includes('「'), '叙述样本里不该有对白，否则漂移方向测不准');
  assert.ok((body('talk').match(/「/g) ?? []).length >= 4, '对白样本要够密，才拉得开 dialogueShare');
});

test('只有一本书时拿本书前段当基准', () => {
  const p = portrait([book('only', ['talk', 'talk', 'talk', 'narr', 'narr', 'narr'])], 'only');
  assert.equal(p.ok, true);
  assert.equal(p.recent.length, 3);
  assert.equal(p.base.length, 3);
  assert.ok(p.baseLabel.includes('同一本书的前 3 章'), p.baseLabel);
  assert.equal(p.note, '');
});

test('够别的书就用别的书当基准，不跟自己前段比', () => {
  const projects = [book('cur', ['talk', 'talk', 'talk', 'narr', 'narr', 'narr']), book('other', Array(7).fill('talk')), { id: 'tiny', title: 't', mode: 'chapters', chapters: [{ id: 'x', title: 'x', content: '太短' }] }];
  const p = portrait(projects, 'cur');
  assert.ok(p.baseLabel.includes('你另外 1 部书共 7 章'), p.baseLabel);
  assert.equal(p.base.length, 7);
  assert.equal(p.recent.length, 3, '基准换了，最近几章的口径不变');
});

test('章数不够就老实说比不了，短章也不算数', () => {
  const short = portrait([book('s', ['talk', 'narr'])], 's');
  assert.equal(short.ok, false);
  assert.match(short.note, /判漂移要两边各/);
  const stubs = portrait([{ id: 'b', title: 'b', mode: 'chapters', chapters: Array(10).fill(0).map((_, i) => ({ id: 'c' + i, title: 't', content: '只有几个字' })) }], 'b');
  assert.equal(stubs.recent.length, 0, '每章都不足 150 字，一章都不该进统计');
  assert.equal(stubs.ok, false);
  const none = portrait([], 'x');
  assert.equal(none.ok, false);
  assert.match(none.note, /还没有作品/);
});

test('漂移方向：最近这截对白掉光、句子变长', () => {
  const p = portrait([book('drift', ['talk', 'talk', 'talk', 'narr', 'narr', 'narr'])], 'drift');
  const gaps = driftGaps(p);
  assert.ok(gaps.length > 0);
  const talk = gaps.find((g) => g.key === 'dialogueShare');
  const sent = gaps.find((g) => g.key === 'avgSentence');
  assert.ok(talk && sent, `应报出对白与句长两项：${gaps.map((g) => g.key).join(' / ')}`);
  assert.ok(talk!.mine < talk!.theirs && talk!.worth, `对白占比该从 ${talk!.theirs}% 掉到 ${talk!.mine}%`);
  assert.ok(sent!.mine > sent!.theirs && sent!.worth, `句长该从 ${sent!.theirs} 字涨到 ${sent!.mine} 字`);
  assert.deepEqual(driftGaps(portrait([book('s', ['talk'])], 's')), [], '样本不足时不产出漂移');
});

test('同一份统计，compare 与 portrait 口径一致', () => {
  const p = portrait([book('same', ['talk', 'talk', 'talk', 'narr', 'narr', 'narr'])], 'same');
  assert.deepEqual(driftGaps(p).map((g) => `${g.key}:${g.mine}/${g.theirs}`), compare(p.recent, p.base).map((g) => `${g.key}:${g.mine}/${g.theirs}`));
});

test('self 口径下卡面说「你」，对照物不再是书名', () => {
  const p = portrait([book('drift', ['talk', 'talk', 'talk', 'narr', 'narr', 'narr'])], 'drift');
  const self = cardsFromGaps({ id: 'self-drift', title: '我的惯常笔触', createdAt: '', chapters: p.base }, driftGaps(p), true);
  assert.ok(self.length > 0, `对白掉光 + 句子变长，至少该掉出卡：${driftGaps(p).map((g) => `${g.key}${g.worth ? '' : '(不值)'}`).join(' ')}`);
  for (const c of self) {
    assert.ok(c.name.startsWith('找回：') || c.name.startsWith('戒掉：'), `self 卡名不该再是学它：${c.name}`);
    assert.ok(c.payload.includes('你惯常的笔触'), c.payload);
    assert.ok(!c.payload.includes('《'), `self 卡面不该出现书名号：${c.payload}`);
    assert.equal(c.effect, 'constraint');
    assert.ok(c.constraints && c.constraints.length, '找回卡也要能判达成，不能只是提醒');
  }
  const theirs = cardsFromGaps({ id: 'b1', title: '标杆书', createdAt: '', chapters: p.base }, compare(myStats(book('drift', ['narr', 'narr', 'narr'])), p.base));
  for (const c of theirs) {
    assert.ok(c.name.startsWith('学它：') || c.name.startsWith('戒掉：'), `默认口径仍应是学它：${c.name}`);
    assert.ok(c.payload.includes('《标杆书》'), c.payload);
  }
  const again = cardsFromGaps({ id: 'self-drift', title: '我的惯常笔触', createdAt: '', chapters: p.base }, driftGaps(p), true);
  assert.deepEqual(again.map((c) => c.id), self.map((c) => c.id), '重复掉卡 id 必须一致（幂等）');
});
