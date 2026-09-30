// 召回率夹具：往一本 30 章合成书里埋 6 处设定事故 + 5 类正常写法（诱饵），
// 要求「埋的全检出、诱饵的一个不报」。误报是这类面板唯一真正致命的失败模式——
// 报错过一次，作者以后就不看这个面板了，所以这条测试比功能本身更该锁住。
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Project } from '../src/types';
import { realmReport, silences, nameReport, watchdogCards } from '../src/watchdog';

const pad = '细节补一句。'.repeat(12);

// 每章正文：注释里标出「埋」=故意放进去的事故，「诱饵」=必须不报警的正常写法
const bodies: string[] = [
  '林越一掌拍在桌上，气息已是金丹后期。',
  '「他三年前就是元婴了。」阿禾低声说。', // 诱饵：台词里的境界
  '林越还没有筑基，谈不上御剑。', // 诱饵：否定
  '当年他炼气九层，一枚灵石掰成两次用。', // 诱饵：回忆
  '林越撞破了那层膜。筑基。\n阿禾在身后咳嗽了一声。', // 诱饵：跨句换主语
  '铜铃响了一声，就再没响过。', // 埋：从这里开始沉默
  '阿禾把灯芯挑亮了些。',
  '林越与阿禾都停在金丹。', // 诱饵：归属歧义
  '铁鸦站在车头上，指尖是化神的灵压。',
  '雨落了整夜。', // 埋：本章名单写了阿禾，正文却没有
  '阿禾修好了那只旧泵。',
  '林越明明是元婴。' + '水声。'.repeat(20) + '林越到底只是金丹。', // 埋：同章打架
  '铁鸦的手抖了一下。',
  '阿禾替他守着门。',
  '林越在墙角坐下。',
  '阿禾数着缆桩。',
  '铁鸦终于开口。',
  '林越已经是金丹。', // 埋：回退之前的最高点
  '阿禾把话咽了回去。',
  '铁鸦退回人群里。',
  '林越翻了个身。',
  '阿禾先睡了。',
  '铁鸦没有回头。',
  '阿禾擦着扳手。',
  '林越看着天花板。',
  '铁鸦点了根烟。',
  '阿禾吹灭灯。',
  '林越的气息掉回筑基中期，掌心发烫。', // 埋：境界回退
  '铁鸦再进一步，气息压向合体。', // 埋：卡上写着筑基初期，正文已到合体
  '阿禾替他掖了掖毯子。',
];

const book = {
  id: 'p',
  title: '合成书',
  type: '玄幻',
  status: '写作中',
  deadline: '',
  notes: '',
  draft: '',
  linkedIdeaIds: [],
  createdAt: '',
  updatedAt: '',
  mode: 'chapters',
  chapters: bodies.map((b, i) => ({
    id: 'c' + (i + 1),
    title: '第' + (i + 1) + '章',
    content: b + pad,
    createdAt: '',
    updatedAt: '',
    ...(i === 9 ? { cast: '林越、阿禾、铁鸦' } : {}),
  })),
  characters: [
    { id: 'k1', name: '林越', state: '', log: [], relations: [] },
    { id: 'k2', name: '阿禾', state: '', log: [], relations: [{ with: '旧日恩师', note: '当年带过她' }] },
    { id: 'k3', name: '铁鸦', state: '', log: [], relations: [], power: '筑基初期' },
    { id: 'k4', name: '雾隐师', state: '', log: [], relations: [] }, // 埋：从没出场的卡
  ],
  worldItems: [{ id: 'w1', name: '铜铃', kind: '道具', content: '响过一次' }],
} as unknown as Project;

test('境界归属只认得下该认的：7 处命中，诱饵一处都不进账', () => {
  const r = realmReport(book);
  assert.deepEqual(
    r.obs.map((o) => `${o.name}#${o.no}=${o.term}`),
    ['林越#1=金丹后期', '铁鸦#9=化神', '林越#12=元婴', '林越#12=金丹', '林越#18=金丹', '林越#28=筑基中期', '铁鸦#29=合体'],
    `命中集合该正好是这些：${JSON.stringify(r.obs.map((o) => `${o.name}#${o.no}=${o.term}`))}`,
  );
  assert.deepEqual(r.skipped, { dialogue: 1, hedged: 2, ambiguous: 1 }, '三类挡掉的量要各就各位，报了才算诚实');
});

test('埋进去的四处境界事故全检出，章号与原话都对', () => {
  const f = realmReport(book).findings;
  const reg = f.filter((x) => x.kind === 'regress');
  assert.ok(
    reg.some((x) => x.kind === 'regress' && x.name === '林越' && x.from.no === 12 && x.from.term === '元婴' && x.to.no === 28 && x.to.term === '筑基中期'),
    `第18→28章的回退该抓到：${JSON.stringify(reg)}`,
  );
  assert.ok(f.some((x) => x.kind === 'flip' && x.name === '林越' && x.no === 12), '同章打架');
  const behind = f.find((x) => x.kind === 'card-behind');
  assert.ok(behind && behind.name === '铁鸦' && behind.max.term === '合体', '卡上筑基、正文合体要报卡落后');
});

test('称谓与沉默：死卡、名单漏写、关系空指、沉默 24 章各报一次', () => {
  const names = nameReport(book);
  assert.ok(names.some((x) => x.kind === 'dead' && x.names[0] === '雾隐师'));
  const miss = names.filter((x) => x.kind === 'cast-miss');
  assert.ok(miss.some((x) => x.kind === 'cast-miss' && x.no === 10 && x.names[0] === '阿禾'), `第10章名单里的阿禾正文没写：${JSON.stringify(miss)}`);
  assert.ok(names.some((x) => x.kind === 'relation-dangling' && x.names[1] === '旧日恩师'));
  const rows = silences(book);
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.ok(rows[0].name === '铜铃' && rows[0].gap === 24 && rows[0].words > 2000, JSON.stringify(rows[0]));
});

test('可动笔的三类才掉卡，且卡面带着章号与字数', () => {
  const cards = watchdogCards(book, []);
  assert.deepEqual(
    cards.map((c) => c.id).sort(),
    ['wd-dead-k4', 'wd-realm-k1', 'wd-silent-设定-w1'],
    `回退/死卡/沉默各一张，打架与名单类不代笔：${JSON.stringify(cards.map((c) => c.id))}`,
  );
  const reg = cards.find((c) => c.id === 'wd-realm-k1')!;
  assert.match(reg.payload, /第12章写到「元婴」，第28章却成了「筑基中期」/);
  assert.match(reg.payload, /掌心发烫/, '要把那一处原话带进卡面');
  assert.deepEqual(reg.any, ['林越'], '点亮条件就是这个名字出现在正文');
  assert.equal(watchdogCards(book, cards).length, 0, '重复点不堆重复卡');
});
