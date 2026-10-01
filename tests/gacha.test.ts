// 卡池规则层回归：抽卡经济、保底、墨、槽位解析、七种真实效果、点亮判定。
// 这一层的价值全在「抽到之后真的改到了数据」，所以每个效果都要断言落点，不能只测文案。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Project } from '../src/types';
import {
  CARD_RULE_LIMIT,
  CHANGE_PRICE,
  EMPTY_STATE,
  EMPTY_USER,
  activePool,
  changeFor,
  chargeForPulls,
  codex,
  combineCards,
  dropFromHand,
  litCheck,
  mergeCardRule,
  playCard,
  pruneHand,
  pullsAvailable,
  resolveCard,
  rollMany,
  rollOne,
  takeToHand,
} from '../src/gacha';
import { BASE_CARDS, CARD_RULE_LIMIT, CHANGE_COST, HAND_LIMIT, INK_PER_DUP, PITY, WORDS_PER_PULL } from '../src/cards';

const rng = (...seq: number[]) => {
  let i = 0;
  return () => (i < seq.length ? seq[i++] : 0.5);
};

const of = (id: string, over = {}) => BASE_CARDS.find((c) => c.id === id)!;
const book = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  title: '雾港',
  type: '小说',
  status: '写作中',
  deadline: '',
  notes: '',
  draft: '',
  linkedIdeaIds: [],
  createdAt: '',
  updatedAt: '',
  ...over,
} as Project);

const chapters = [
  { id: 'c1', title: '第一章', content: '已写正文', beats: '原有要点', cast: '林越', createdAt: '', updatedAt: '' },
  { id: 'c2', title: '第二章', content: '', createdAt: '', updatedAt: '' },
  { id: 'c3', title: '第三章', content: '', createdAt: '', updatedAt: '' },
];

const withCards = book({
  mode: 'chapters',
  chapters,
  characters: [
    { id: 'k1', name: '林越', state: '怀疑走私线', log: [], relations: [] },
    { id: 'k2', name: '阿禾', state: '在码头等他', log: [], relations: [] },
  ],
  worldItems: [
    { id: 'w1', name: '夜航船', kind: '地点', content: '每晚十点进港' },
    { id: 'w2', name: '铁锈纹印', kind: '道具', content: '北岸仓库见过' },
  ],
  marks: [{ id: 'm1', type: '伏笔', text: '船头没有名字', start: 0, end: 6, createdAt: '' }],
});

// ---------- 抽卡经济 ----------

test('抽数账：按净产字数结算，删改回扣会带走抽数但不会变负', () => {
  const s = { ...EMPTY_STATE };
  assert.equal(pullsAvailable(s, 3400), 3);
  assert.equal(pullsAvailable(s, 999), 0);
  const after = chargeForPulls(s, 3400, 2);
  assert.equal(after.usedWords, 2000);
  assert.equal(pullsAvailable(after, 3400), 1);
  assert.equal(pullsAvailable(after, 1200), 0, '净产字数掉回去时不该给出负数');
  assert.equal(pullsAvailable(s, 3400, true), 4, '完成日目标额外送一次');
});

test('十连的字数扣账按抽数计，与抽到的卡无关', () => {
  const s = chargeForPulls(EMPTY_STATE, 12000, 10);
  assert.equal(s.usedWords, 10 * WORDS_PER_PULL);
});

// ---------- 概率与保底 ----------

test('保底：第 30 抽无论随机数如何都出 SSR，并把计数归零', () => {
  const pool = activePool(EMPTY_USER);
  const state = { ...EMPTY_STATE, sincePity: PITY - 1 };
  const r = rollOne(pool, state, rng(0.999, 0.999));
  assert.equal(r.card?.rarity, 'SSR');
  assert.equal(r.forced, true);
  assert.equal(r.state.sincePity, 0);
});

test('稀有度分档：随机数落在哪个区间就出哪一档', () => {
  const pool = activePool(EMPTY_USER);
  assert.equal(rollOne(pool, EMPTY_STATE, rng(0.01, 0)).card?.rarity, 'N');
  assert.equal(rollOne(pool, EMPTY_STATE, rng(0.995, 0)).card?.rarity, 'SSR');
  assert.equal(rollOne(pool, EMPTY_STATE, rng(0.62, 0)).card?.rarity, 'R');
  assert.equal(rollOne(pool, EMPTY_STATE, rng(0.96, 0)).card?.rarity, 'SR');
});

test('十连：数量对得上，保底在链路里正常生效', () => {
  const pool = activePool(EMPTY_USER);
  const start = { ...EMPTY_STATE, sincePity: PITY - 3 };
  const r = rollMany(pool, start, 10, () => 0.999);
  assert.equal(r.cards.length, 10);
  assert.equal(r.state.pulls, 10);
  assert.ok(r.cards.some((c) => c.rarity === 'SSR'), '第 30 抽必然被保底逼出来');
});

test('池子里没有该稀有度时就近降级，不空手', () => {
  const onlyN = BASE_CARDS.filter((c) => c.rarity === 'N');
  const r = rollOne(onlyN, EMPTY_STATE, rng(0.999));
  assert.ok(r.card, '不该抽出空');
  assert.equal(r.card?.rarity, 'N');
});

// ---------- 重复、墨与定向换卡 ----------

test('重复卡转墨：首抽不转，第二次起每张转固定量', () => {
  const card = of('n01');
  const pool = [card];
  const a = rollOne(pool, EMPTY_STATE, rng(0.01, 0));
  assert.equal(a.gained, 0);
  assert.equal(a.state.ink, 0);
  const b = rollOne(pool, a.state, rng(0.01, 0));
  assert.equal(b.gained, INK_PER_DUP);
  assert.equal(b.state.ink, INK_PER_DUP);
  assert.equal(b.state.owned[card.id], 2);
});

test('定向换卡是救济通道：墨不够或卡不在池里就不扣不动', () => {
  const pool = activePool(EMPTY_USER);
  const id = pool[0].id;
  assert.equal(changeFor({ ...EMPTY_STATE, ink: CHANGE_PRICE - 1 }, id, pool).ok, false);
  assert.equal(changeFor({ ...EMPTY_STATE, ink: 99 }, '不存在的卡', pool).ok, false);
  const ok = changeFor({ ...EMPTY_STATE, ink: 99 }, id, pool);
  assert.equal(ok.state.ink, 99 - CHANGE_PRICE);
  assert.equal(ok.state.owned[id], 1);
  assert.equal(CHANGE_PRICE, CHANGE_COST);
});

// ---------- 手牌 ----------

test('手牌上限三张、同 id 不重复占位，溢出退回图鉴', () => {
  const ids = ['n01', 'n02', 'n03', 'n04'];
  const r = takeToHand({ ...EMPTY_STATE }, ids);
  assert.deepEqual(r.state.hand, ['n01', 'n02', 'n03']);
  assert.deepEqual(r.overflow, ['n04']);
  assert.equal(r.state.hand.length, HAND_LIMIT);
  const again = takeToHand(r.state, ['n01']);
  assert.deepEqual(again.state.hand, ['n01', 'n02', 'n03'], '已在手的不重复占位');
  assert.deepEqual(dropFromHand(again.state, 'n02').hand, ['n01', 'n03']);
});

// ---------- 槽位解析 ----------

test('槽位从当前这本书里取，取不到才兜底并记在 missing', () => {
  const res = resolveCard(of('r01'), withCards, withCards.chapters![0]);
  assert.ok(res.text.includes('铁锈纹印'), `道具槽应取到书里的词条：${res.text}`);
  assert.ok(res.text.includes('林越') || res.text.includes('阿禾'), `人物槽应取到人物卡：${res.text}`);
  assert.deepEqual(res.missing, [], '这本书槽位齐全');
  const empty = resolveCard(of('r01'), book(), null);
  assert.deepEqual(empty.missing.sort(), ['char', 'hook', 'item', 'place']);
  assert.ok(!/\{/.test(empty.text), '兜底后不该留占位符');
  const a = resolveCard(of('r01'), withCards, withCards.chapters![0]);
  const b = resolveCard(of('r01'), withCards, withCards.chapters![0]);
  assert.equal(a.text, b.text, '同一张卡同一章结果要稳定，不能每次刷新都变');
  const other = resolveCard(of('r01'), { ...withCards, characters: [{ id: 'z', name: '只在另一本书里的人', state: '', log: [], relations: [] }] }, withCards.chapters![0]);
  assert.notEqual(other.text, a.text, '换一本书，同一张卡应给出不同的任务');
});

// ---------- 七种真实效果 ----------

test('beat / hook：追加而不覆盖本章已有内容', () => {
  const ch = withCards.chapters![0];
  const beat = playCard(resolveCard(of('n01'), withCards, ch), withCards, ch);
  assert.match(beat.chapterPatch!.beats!, /^原有要点\n· /, '要在原要点后面追加');
  assert.match(beat.chapterPatch!.beats!, /第 \d+ 章/, '槽位 {num} 要换成真实章号');
  const hook = playCard(resolveCard(of('n05'), withCards, ch), withCards, ch);
  assert.ok(hook.chapterPatch!.hooks!.length > 4);
});

test('cast：出场名单只加名字，卡面指令进要点（名单要能被上下文解析）', () => {
  const ch = withCards.chapters![0];
  const out = playCard(resolveCard(of('n11'), withCards, ch), withCards, ch);
  const cast = out.chapterPatch!.cast!;
  assert.ok(cast.startsWith('林越'), `名单原样保留在前：${cast}`);
  assert.ok(!cast.includes('视角'), '名单里不该混进整句指令');
  assert.ok(out.chapterPatch!.beats!.includes('视角'), '指令应落在要点里');
});

test('constraint：禁词并入现有禁用词且不重复堆叠', () => {
  const p = { ...book(), game: { forbidden: ['很多', '一些'] } };
  const out = playCard(resolveCard(of('n09'), p, null), p, null);
  const list = out.projectPatch!.game!.forbidden;
  assert.ok(list.includes('几天'), '新禁词进来');
  assert.equal(list.filter((w) => w === '很多').length, 1, '已有不该重复');
  const again = playCard(resolveCard(of('n09'), { ...p, game: { forbidden: list } }, null), { ...p, game: { forbidden: list } }, null);
  assert.equal(again.projectPatch, undefined, '全都在禁词里时不再产生补丁');
  assert.match(again.note, /早已在练笔清单里|未重复添加/);
});

test('outline：只铺未写的章，且带卡名可追溯', () => {
  const out = playCard(resolveCard(of('v01'), withCards, withCards.chapters![0]), withCards, withCards.chapters![0]);
  assert.equal(out.chapterPatches?.length, 2, '两个未写章都该被铺到');
  assert.deepEqual(out.chapterPatches!.map((p) => p.id), ['c2', 'c3']);
  assert.match(out.chapterPatches![0].patch.beats!, /\[卡·他要保的人不在船上\]/);
  const none = playCard(resolveCard(of('v01'), book(), null), book(), null);
  assert.equal(none.chapterPatches, undefined);
  assert.match(none.projectPatch!.notes!, /他要保的人不在船上/, '没有未写章时整条落备注');
});

test('rule / task：一条进规则中心，一条交给工坊出三签', () => {
  const out = playCard(resolveCard(of('s01'), withCards, withCards.chapters![0]), withCards, withCards.chapters![0]);
  assert.equal(out.rule!.name, '卡牌·第二人称逼问');
  assert.match(out.rule!.content, /第二人称/);
  const task = playCard(resolveCard(of('r01'), withCards, withCards.chapters![0]), withCards, withCards.chapters![0]);
  assert.match(task.task!, /铁锈纹印/);
});

test('单篇模式：所有效果都落到备注，不会出现没地方去', () => {
  const single = book({ notes: '既有备注' });
  for (const id of ['n01', 'n05', 'n11', 'v01']) {
    const out = playCard(resolveCard(of(id), single, null), single, null);
    assert.match(out.projectPatch!.notes!, /^既有备注\n· \[卡·/, `${id} 应追加到备注`);
  }
});

// ---------- 点亮判定 ----------

test('点亮：约束类看正文是否还留着禁词，行为类看有没有真写进去', () => {
  const constraint = of('n09');
  assert.equal(litCheck(constraint, '这里有几个理由').ok, false, '还有「几个」就不该亮');
  assert.equal(litCheck(constraint, '三个理由，两里地').ok, true);
  const action = of('n02');
  assert.equal(litCheck(action, '他把东西带走了').ok, false, '没写「放下/留在」不亮');
  assert.equal(litCheck(action, '他把东西留在了站台上').ok, true, '「留在」算达成');
  assert.equal(litCheck(action, '他放下它，转身走').ok, true);
  assert.equal(litCheck(of('n01'), '').ok, true, '没有检核条件的卡，落地即亮');
});

// ---------- 卡池与图鉴 ----------

test('僵尸手牌：卡被移出池子后自动让出名额，收藏与点亮记录不动', () => {
  const pool = activePool(EMPTY_USER);
  const alive = pool[0].id;
  const dead = pool[1].id;
  const st = { ...EMPTY_STATE, hand: [alive, dead, 'u-gone'], owned: { 'u-gone': 3 }, lit: { 'u-gone': '2026-09-22T00:00:00.000Z' } };
  const r = pruneHand(st, pool.filter((c) => c.id !== dead));
  assert.deepEqual(r.state.hand, [alive], '被移除的两张都退出手牌');
  assert.deepEqual(r.dropped, [dead, 'u-gone']);
  assert.equal(r.state.owned['u-gone'], 3, '收藏记录要留着');
  assert.equal(r.state.lit['u-gone'], '2026-09-22T00:00:00.000Z', '已点亮的图鉴记录要留着');
  assert.deepEqual(pruneHand(r.state, pool).dropped, [], '没有僵尸时不产生新对象');
  // 满了但其中一张是僵尸：抽卡应该能把新卡塞进去
  const full = { ...EMPTY_STATE, hand: ['ghost', 'n02', 'n03'] };
  const withPool = takeToHand(full, ['n01'], pool);
  assert.deepEqual(withPool.state.hand, ['n02', 'n03', 'n01']);
  assert.deepEqual(withPool.overflow, []);
  const noPool = takeToHand(full, ['n01']);
  assert.deepEqual(noPool.overflow, ['n01'], '不传池子时按原样判上限（老调用方行为不变）');
});

test('卡牌规则限量与去重：同名覆盖不追加，超过 6 条顶掉最早的', () => {
  const mk = (n: string) => ({ name: n, content: 'c-' + n, on: true });
  const base = [mk('作者自己的规则'), mk('卡牌·第一式'), mk('卡牌·第二式')];
  const dup = mergeCardRule(base, { name: '卡牌·第一式', content: '改过的内容' });
  assert.equal(dup.rules.length, 3, '同名覆盖，不该变四条');
  assert.equal(dup.rules.find((r) => r.name === '卡牌·第一式')!.content, '改过的内容');
  assert.deepEqual(dup.dropped, []);
  const many = [mk('手工规则'), ...['三', '四', '五', '六', '七', '八'].map((n) => mk('卡牌·第' + n))];
  assert.equal(mergeCardRule(many, { name: '卡牌·第九', content: 'x' }).rules.filter((r) => r.name.startsWith('卡牌·')).length, CARD_RULE_LIMIT);
  const out = mergeCardRule(many, { name: '卡牌·第九', content: 'y' }, 5);
  assert.equal(out.rules.filter((r) => r.name.startsWith('卡牌·')).length, 5, '卡牌来源的规则按上限截断');
  assert.deepEqual(out.dropped, ['第三', '第四'], '超出两条就按先后顶掉两条，回执给名字（去掉前缀）');
  assert.ok(out.rules.some((r) => r.name === '手工规则'), '作者手写的规则不该被顶掉');
  assert.ok(out.rules.some((r) => r.name === '卡牌·第八'), '较新的卡牌规则留下');
  assert.equal(out.rules[out.rules.length - 1].name, '卡牌·第九', '新的一条追加在末尾');
  const re = mergeCardRule(many, { name: '卡牌·第三', content: 'z' }, 5);
  assert.equal(re.rules.filter((r) => r.name.startsWith('卡牌·')).length, 5, '覆盖已有条目不会让条数继续增长');
  assert.deepEqual(re.dropped, ['第三'], '本来就超出上限时，照样按先进先出截断');
  assert.ok(!re.rules.some((r) => r.name === '卡牌·第三'), '被截掉的就是被覆盖的那条旧规则');
});

test('卡池：内置 + 自建 - 关掉的；图鉴按系列归组并带上收藏状态', () => {
  const user = { version: 1, custom: [{ id: 'u1', series: '自建', rarity: 'N' as const, name: '我的卡', effect: 'beat' as const, payload: '写一句' }], off: ['n01'] };
  const pool = activePool(user);
  assert.ok(pool.some((c) => c.id === 'u1'), '自建卡进池');
  assert.ok(!pool.some((c) => c.id === 'n01'), '关掉的卡不出池');
  assert.equal(pool.length, BASE_CARDS.length + 1 - 1);
  const book2 = codex(user, { ...EMPTY_STATE, owned: { n02: 1 }, lit: { n02: '2026-09-22T00:00:00.000Z' } });
  const 小事 = book2.find((s) => s.series === '小事')!;
  const r = 小事.rows.find((x) => x.card.id === 'n02')!;
  assert.equal(r.owned, 1);
  assert.equal(r.litAt, '2026-09-22T00:00:00.000Z');
});

test('内置卡池自洽：稀有度分布、效果白名单、槽位只用支持的那些', () => {
  const seen = new Set<string>();
  for (const c of BASE_CARDS) {
    assert.ok(!seen.has(c.id), `卡 id 重复：${c.id}`);
    seen.add(c.id);
    assert.ok(['N', 'R', 'SR', 'SSR'].includes(c.rarity), c.id);
    assert.ok(['beat', 'hook', 'rule', 'constraint', 'cast', 'outline', 'task'].includes(c.effect), `${c.id} 效果非法`);
    assert.ok(c.name && c.payload && c.series, `${c.id} 字段不全`);
    for (const slot of c.payload.match(/\{(\w+)\}/g) ?? []) {
      assert.ok(['{char}', '{place}', '{item}', '{hook}', '{num}'].includes(slot), `${c.id} 用了不支持的槽位 ${slot}`);
    }
  }
  const byRarity = (r: string) => BASE_CARDS.filter((c) => c.rarity === r).length;
  assert.ok(byRarity('N') >= 10 && byRarity('R') >= 8 && byRarity('SR') >= 8 && byRarity('SSR') >= 5, '每档都要够抽');
});

test('合成两卡：立成本章任务，不消耗手牌、不发抽，条件与让步都带在卡上', () => {
  const ch = withCards.chapters![0];
  const c = combineCards(of('x01'), of('n02'), withCards, ch);
  assert.equal(c.name, '短句行军 × 一件带不走的东西');
  assert.ok(c.task.includes('18 字') && c.task.includes('留在'), `任务文本要把两张卡都说清：${c.task}`);
  assert.deepEqual(c.from, ['x01', 'n02']);
  assert.equal(c.constraints.length, 2, '两张卡各自的条件都要并进来');
  assert.ok(!('pulls' in c) && !('cost' in c), '合成不该动抽数账');
  const taskless = combineCards(of('x01'), of('r01'), withCards, ch);
  assert.equal(taskless.constraints.length, 1, '出三签类卡本来就没有条件，只贡献任务文本');
  assert.ok(taskless.task.includes('铁锈纹印'), '条件少也要把两张卡的事都写进去');
  const same = combineCards(of('x01'), of('n02'), withCards, ch);
  assert.equal(same.task, c.task, '同一对卡的结果要稳定');
});

test('奖励抽：先花赠送的次数，剩下的才按字数记账', () => {
  const s = { ...EMPTY_STATE, bonusPulls: 3 };
  assert.equal(pullsAvailable(s, 0), 3, '一个字没写也能用掉奖励抽');
  assert.equal(pullsAvailable(s, 2500), 5, '奖励与字数抽叠加');
  const spent = chargeForPulls(s, 2500, 5);
  assert.equal(spent.bonusPulls, 0, '三次奖励抽先被花掉');
  assert.equal(spent.usedWords, 2000, '只扣剩下的两次字数账，不重复收费');
  assert.equal(pullsAvailable(spent, 2500), 0, '全部用完归零');
  const few = chargeForPulls({ ...EMPTY_STATE, bonusPulls: 3 }, 0, 2);
  assert.equal(few.bonusPulls, 1, '纯奖励抽时不动字数账');
  assert.equal(few.usedWords, 0);
});

