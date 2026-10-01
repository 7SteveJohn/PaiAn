// 卡池抽卡的规则层：全部纯函数、可注入随机源、不碰界面也不碰网络。
// 三条设计约束写在这里而不是界面里：
// 1) 抽卡货币 = 净产出字数。stats.daily 是净产出口径（删改会回扣），所以删了再写刷不出抽。
// 2) 保底与「墨」是救济通道：30 抽必出 SSR，重复卡转墨，墨可以**定向换一张**——
//    脸黑不该让正在写的书拿不到它需要的那一张。
// 3) 卡必须真的改到数据：applyCard 返回的是对章节/项目/规则中心的实际补丁，
//    「点亮」则用正文检核（any 必须出现 / absent 不得出现），不是点一下就算收服。
import type { AIRule, Chapter, Project } from './types';
import { asRuleText, describe, evaluate, mergeConstraints, type Constraint } from './constraints';
import { BASE_CARDS, CARD_RULE_LIMIT, CARD_RULE_PREFIX, CHANGE_COST, HAND_LIMIT, INK_PER_DUP, PITY, RATES, WORDS_PER_PULL } from './cards';
export { CHANGE_COST }; // 界面要把「一张多少墨」说清楚

export { CARD_RULE_LIMIT };

export type Rarity = 'N' | 'R' | 'SR' | 'SSR';
export type EffectKind = 'beat' | 'hook' | 'rule' | 'constraint' | 'cast' | 'outline' | 'task';

export interface GachaCard {
  id: string;
  series: string;
  rarity: Rarity;
  name: string;
  effect: EffectKind;
  payload: string; // 卡面任务文本，含 {char} {place} {item} {hook} {num} 槽位
  any?: string[]; // 简写：正文需出现其中之一
  absent?: string[]; // 简写：正文不得出现其中任何一个
  constraints?: Constraint[]; // 达成条件：句长、对白占比、段首人称、AI 味句式…
}

export interface GachaState {
  pulls: number;
  sincePity: number;
  ink: number;
  usedWords: number; // 已折算成抽数的净产字数
  hand: string[]; // 在手卡牌 id（最多三张，打出即移除）
  bonusPulls: number; // 额外赠送的抽数（组合任务达成、日目标完成等），不占字数账
  owned: Record<string, number>;
  applied: Record<string, string>; // cardId → 最近一次打出的时间
  lit: Record<string, string>; // cardId → 首次点亮的时间
}

export interface UserCards {
  version: number;
  custom: GachaCard[];
  off: string[]; // 被关掉的内置卡（不想在池里出现的）
}

export const EMPTY_STATE: GachaState = { pulls: 0, sincePity: 0, ink: 0, usedWords: 0, hand: [], bonusPulls: 0, owned: {}, applied: {}, lit: {} };
export const EMPTY_USER: UserCards = { version: 1, custom: [], off: [] };

export const RARITY_ORDER: Rarity[] = ['N', 'R', 'SR', 'SSR'];

// 效果的人话说明：写作页手牌、卡池图鉴、抽卡动效层都要用，
// 放在领域层而不是某个组件里，免得主包为了一个字符串常量把动效层拽进来。
export const EFFECT_LABEL: Record<EffectKind, string> = {
  beat: '写入本章剧情要点',
  hook: '挂进本章伏笔安排',
  rule: '追加到规则中心',
  constraint: '加入禁用词约束',
  cast: '调动出场人物',
  outline: '铺后续五章',
  task: '交给 AI 工坊出三签',
};

// 抽到的卡先进手牌；手牌满了就只记账，用掉一张后可以从图鉴「上手」再拿
export function takeToHand(state: GachaState, ids: string[], pool?: GachaCard[]): { state: GachaState; overflow: string[] } {
  // 给了池子就先裁僵尸 id，否则三张名额可能被看不见的卡占满
  const base = pool ? pruneHand(state, pool).state : state;
  const hand = [...base.hand];
  const overflow: string[] = [];
  for (const id of ids) {
    if (hand.includes(id)) continue; // 同一张在手牌里不重复占位
    if (hand.length >= HAND_LIMIT) overflow.push(id);
    else hand.push(id);
  }
  return { state: { ...base, hand }, overflow };
}

export function dropFromHand(state: GachaState, id: string): GachaState {
  return { ...state, hand: state.hand.filter((x) => x !== id) };
}

// 卡被勾掉或自建卡被删掉时，留在手牌里的 id 会变成看不见的僵尸——它照样占一个名额。
// 所以凡是池子变化或开新局，都先裁一刀，再把被丢掉的还回图鉴（只改 hand，收藏不动）。
export function pruneHand(state: GachaState, pool: GachaCard[]): { state: GachaState; dropped: string[] } {
  const alive = new Set(pool.map((c) => c.id));
  const dropped = state.hand.filter((id) => !alive.has(id));
  return dropped.length ? { state: { ...state, hand: state.hand.filter((id) => alive.has(id)) }, dropped } : { state, dropped: [] };
}

// 卡牌来源的规则按名去重、限量：SR 卡一张追加一条，写几十本就会把每次 AI 调用都撑爆
export function mergeCardRule(rules: AIRule[], rule: { name: string; content: string }, limit = CARD_RULE_LIMIT): { rules: AIRule[]; dropped: string[] } {
  const next = rules.map((r) => (r.name === rule.name ? { ...r, content: rule.content, on: true } : r));
  if (!next.some((r) => r.name === rule.name)) next.push({ name: rule.name, content: rule.content, on: true });
  const fromCards = next.filter((r) => r.name.startsWith(CARD_RULE_PREFIX));
  const dropped: string[] = [];
  if (fromCards.length > limit) {
    for (const victim of fromCards.slice(0, fromCards.length - limit)) {
      dropped.push(victim.name.replace(CARD_RULE_PREFIX, ''));
      const i = next.findIndex((r) => r === victim);
      if (i >= 0) next.splice(i, 1);
    }
  }
  return { rules: next, dropped };
}

// 卡池 = 内置 + 用户自建 - 关掉的
export function activePool(user: UserCards): GachaCard[] {
  const off = new Set(user.off ?? []);
  return [...BASE_CARDS, ...(user.custom ?? [])].filter((c) => c && !off.has(c.id));
}

// 两张在手卡并成一个本章任务：纯本地、不调模型、不消耗卡也不给抽——
// 它的价值是「同时兼顾两件事」，奖励走达成后的 bonusPulls（见 WritingView）。
export interface Combo {
  name: string;
  task: string;
  constraints: Constraint[];
  yielded: string[];
  from: [string, string];
}

const CONFLICT_NOTE: Record<string, string> = {
  '小事|破格': '手法要落在具体一处，别为了破格把细节写空。',
  '破格|大局': '手法服务局面推进，别只在一句话上翻花样。',
  '小事|大局': '先让局面成立，再用细节收口。',
  '岔路|破格': '冲突用人物的选择来推，不要靠叙述者宣告。',
  '岔路|大局': '这两件事得在同一场戏里撞出后果。',
};

export function combineCards(a: GachaCard, b: GachaCard, project: Project, chapter: Chapter | null): Combo {
  const ra = resolveCard(a, project, chapter);
  const rb = resolveCard(b, project, chapter);
  const merged = mergeConstraints(describe(a), describe(b));
  const key = [a.series, b.series].sort().join('|');
  const extra = CONFLICT_NOTE[key];
  const task = `把这两件事写成同一章：${ra.text} 同时——${rb.text}${extra ? ' ' + extra : ''}${merged.yielded.length ? '（' + merged.yielded.join('；') + '）' : ''}`;
  return { name: `${a.name} × ${b.name}`, task, constraints: merged.list, yielded: merged.yielded, from: [a.id, b.id] };
}

// 抽卡经济：净产字数换抽 + 日目标奖励 + 组合任务达成奖励
export function pullsAvailable(state: GachaState, netWords: number, goalHit = false): number {
  const earned = Math.floor(Math.max(0, netWords - state.usedWords) / WORDS_PER_PULL);
  return earned + (goalHit ? 1 : 0) + (state.bonusPulls ?? 0);
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const RARITY_TABLE: [Rarity, number][] = RARITY_ORDER.map((r) => [r, RATES[r]]);

function pickRarity(rng: () => number): Rarity {
  let x = rng();
  for (const [r, p] of RARITY_TABLE) {
    if (x < p) return r;
    x -= p;
  }
  return 'N';
}

function pickOf(pool: GachaCard[], rarity: Rarity, rng: () => number): GachaCard | null {
  const cand = pool.filter((c) => c.rarity === rarity);
  return cand.length ? cand[Math.floor(rng() * cand.length) % cand.length] : null;
}

export interface RollResult {
  card: GachaCard | null;
  state: GachaState;
  forced: boolean; // 这次是不是保底逼出来的 SSR
  gained: number; // 新增墨（重复卡转化）
}

// 抽一张。不改动传入 state，返回新 state；调用方负责先扣次数（pullsAvailable>0）。
export function rollOne(pool: GachaCard[], state: GachaState, rng: () => number = Math.random): RollResult {
  const forced = state.sincePity + 1 >= PITY;
  let rarity: Rarity = forced ? 'SSR' : pickRarity(rng);
  let card = pickOf(pool, rarity, rng);
  if (!card) {
    // 该稀有度没卡（用户把池子关空了）：就近降级，别让人空手
    for (const alt of RARITY_ORDER) {
      card = pickOf(pool, alt, rng);
      if (card) {
        rarity = alt;
        break;
      }
    }
  }
  const owned = { ...state.owned };
  let ink = state.ink;
  let gained = 0;
  if (card) {
    const had = owned[card.id] ?? 0;
    owned[card.id] = had + 1;
    if (had > 0) {
      gained = INK_PER_DUP;
      ink += gained;
    }
  }
  return {
    card,
    forced,
    gained,
    state: {
      ...state,
      pulls: state.pulls + 1,
      sincePity: card && card.rarity === 'SSR' ? 0 : state.sincePity + 1,
      ink,
      owned,
    },
  };
}

// 十连：逐张抽，保底在链路里正常生效
export function rollMany(pool: GachaCard[], state: GachaState, n: number, rng?: () => number): { cards: GachaCard[]; state: GachaState; ink: number } {
  let s = state;
  let ink = 0;
  const cards: GachaCard[] = [];
  for (let i = 0; i < n; i++) {
    const r = rollOne(pool, s, rng);
    s = r.state;
    ink += r.gained;
    if (r.card) cards.push(r.card);
  }
  return { cards, state: s, ink };
}

// 抽 n 次的代价：先花掉赠送的抽数（组合任务、日目标来的），剩下的才按每次 1000 字记账。
// 反过来的话，手上有三次奖励还要照扣三次的字数，等于白送又白收。
export function chargeForPulls(state: GachaState, netWords: number, n: number): GachaState {
  const fromBonus = Math.min(n, state.bonusPulls ?? 0);
  const fromWords = n - fromBonus;
  const spend = Math.min(fromWords * WORDS_PER_PULL, Math.max(0, netWords) - state.usedWords);
  return { ...state, bonusPulls: (state.bonusPulls ?? 0) - fromBonus, usedWords: state.usedWords + Math.max(0, spend) };
}

// 定向换卡：扣墨，指定卡必须存在于池里
export function changeFor(state: GachaState, cardId: string, pool: GachaCard[]): { state: GachaState; ok: boolean } {
  if (state.ink < CHANGE_COST || !pool.some((c) => c.id === cardId)) return { state, ok: false };
  const owned = { ...state.owned };
  const had = owned[cardId] ?? 0;
  owned[cardId] = had + 1;
  return { state: { ...state, ink: state.ink - CHANGE_COST, owned }, ok: had === 0 };
}

// ---------- 槽位解析：同一张卡用在不同的书上，落出来的任务不一样 ----------
export interface ResolvedCard {
  card: GachaCard;
  text: string; // 槽位填好后的任务文本
  slots: { char: string; place: string; item: string; hook: string }; // 填进去的实际取值
  missing: string[]; // 这本书里取不到、用了兜底词的槽位
}

const FALLBACK: Record<string, string> = {
  char: '一个刚出场的人物',
  place: '本章的主要场景',
  item: '一件已经出现过两次的东西',
  hook: '一条还没回收的伏笔',
  num: '三',
};

export function resolveCard(card: GachaCard, project: Project, chapter: Chapter | null): ResolvedCard {
  const chapters = project.chapters ?? [];
  const idx = chapter ? Math.max(0, chapters.findIndex((c) => c.id === chapter.id)) : 0;
  const seed = hash(card.id + '|' + (chapter?.id ?? 'draft') + '|' + chapters.length);
  const chars = (project.characters ?? []).map((c) => c.name).filter(Boolean);
  const places = (project.worldItems ?? []).filter((w) => w.kind === '地点').map((w) => w.name);
  const items = (project.worldItems ?? []).filter((w) => w.kind === '道具' || w.kind === '设定' || w.kind === '势力').map((w) => w.name);
  const openHooks = (project.marks ?? [])
    .filter((m) => m.type === '伏笔' && m.status !== '回收' && !m.orphaned && m.text.trim())
    .map((m) => m.text.trim().slice(0, 18));
  const pick = (arr: string[], slot: string, off: number) => {
    if (!arr.length) return { v: FALLBACK[slot], miss: true };
    return { v: arr[(seed + off * 7) % arr.length], miss: false };
  };
  const c = pick(chars, 'char', 0);
  const p = pick(places, 'place', 1);
  const i = pick(items.length ? items : places, 'item', 2);
  const h = pick(openHooks, 'hook', 3);
  const missing = (
    [
      [c.miss, 'char'],
      [p.miss, 'place'],
      [i.miss, 'item'],
      [h.miss, 'hook'],
    ] as [boolean, string][]
  )
    .filter(([m]) => m)
    .map(([, k]) => k);
  const num = Math.min(chapters.length || 1, idx + 1 + (seed % 6) + 2);
  const text = card.payload
    .replace(/\{char\}/g, c.v)
    .replace(/\{place\}/g, p.v)
    .replace(/\{item\}/g, i.v)
    .replace(/\{hook\}/g, h.v)
    .replace(/\{num\}/g, String(num));
  return { card, text, missing, slots: { char: c.v, place: p.v, item: i.v, hook: h.v } };
}

// ---------- 打出卡牌：返回对数据层的实际改动 ----------
export interface CardPlay {
  chapterPatch?: Partial<Chapter>;
  chapterPatches?: { id: string; patch: Partial<Chapter> }[];
  projectPatch?: Partial<Project>;
  rule?: { name: string; content: string };
  task?: string; // 交给 AI 工坊出三签的指令
  note: string; // 人话回执：写清楚改在哪儿
}

const addLine = (cur: string | undefined, line: string) => (cur?.trim() ? cur.replace(/\s+$/, '') + '\n' + line : line);

export function playCard(res: ResolvedCard, project: Project, chapter: Chapter | null): CardPlay {
  const { card, text } = res;
  switch (card.effect) {
    // 单篇模式没有章节字段，落点改成作品备注——卡不能抽出来没地方去
    case 'beat':
      return chapter
        ? { chapterPatch: { beats: addLine(chapter.beats, '· ' + text) }, note: '已写进本章「剧情要点」。' }
        : { projectPatch: { notes: addLine(project.notes, `· [卡·${card.name}] ${text}`) }, note: '单篇没有章节要点栏，已写进作品备注。' };
    case 'hook':
      return chapter
        ? { chapterPatch: { hooks: addLine(chapter.hooks, text) }, note: '已挂到本章「伏笔安排」，会随前情注入 AI。' }
        : { projectPatch: { notes: addLine(project.notes, `· [卡·${card.name}] ${text}`) }, note: '单篇没有伏笔安排栏，已写进作品备注。' };
    case 'cast': {
      // cast 字段是「出场人物名」的顿号清单（buildAiContext 靠它排优先级），
      // 所以这里只并把名字塞进名单，卡面指令另存进剧情要点，不污染名单。
      if (!chapter) return { projectPatch: { notes: addLine(project.notes, `· [卡·${card.name}] ${text}`) }, note: '单篇模式没有出场名单，指令已写进备注。' };
      const name = res.missing.includes('char') ? '' : res.slots.char;
      return {
        chapterPatch: {
          cast: name && !(chapter.cast ?? '').includes(name) ? addLine(chapter.cast, name) : chapter.cast,
          beats: addLine(chapter.beats, '· ' + text),
        },
        note: name ? `已把「${name}」加进本章出场名单，并写进剧情要点。` : '本章出场名单没有可用人物，指令先记在剧情要点里。',
      };
    }
    case 'constraint': {
      const now = project.game?.forbidden ?? [];
      const add = (card.absent ?? []).filter((w) => w && !now.includes(w));
      // 只有词表的约束不用通知 AI（正文已有浅灰提醒）；句长/对白/段首这类
      // 需要理解语义的条件必须同时进规则中心，否则 AI 一键续写就把你的约束打回去。
      const ruleText = asRuleText(describe(card));
      return {
        projectPatch: add.length ? { game: { ...(project.game ?? { forbidden: [] }), forbidden: [...now, ...add] } } : undefined,
        rule: ruleText ? { name: '卡牌·' + card.name, content: ruleText } : undefined,
        note: add.length
          ? `已加入本章禁用词练笔：${add.join('、')}（命中处会有浅灰提醒）`
          : ruleText
            ? '禁词早已在练笔清单里；这条约束的语义部分已进规则中心，AI 续写会一起遵守。'
            : '这些禁词早已在练笔清单里，未重复添加。',
      };
    }
    case 'rule':
      return { rule: { name: '卡牌·' + card.name, content: text }, note: '已追加到规则中心：之后每次 AI 调用都会带上这条。' };
    case 'task':
      return { task: text, note: '已把这张卡交给 AI 工坊出三签。' };
    case 'outline': {
      const steps = text
        .split('；')
        .map((s) => s.trim())
        .filter(Boolean);
      const targets = (project.chapters ?? []).filter((c) => !(c.content ?? '').trim()).slice(0, steps.length);
      if (!targets.length) {
        return {
          projectPatch: { notes: addLine(project.notes, `· [卡·${card.name}] ${steps.join(' ')}`) },
          note: '没有未写章节可铺，这条局面已整条写进作品备注。',
        };
      }
      const patches = targets.map((c, i) => ({ id: c.id, patch: { beats: addLine(c.beats, `· [卡·${card.name}] ${steps[i] ?? steps[steps.length - 1]}`) } }));
      return {
        chapterPatches: patches,
        note: patches.length ? `已铺进后续 ${patches.length} 个未写章的剧情要点。` : '没有未写的章节可铺——先补几章大纲再打这张。',
      };
    }
    default:
      return { note: '这张卡没有绑定效果。' };
  }
}

// 达成条件求值：手牌条每敲几下就算一次，所以对外给的是整份报告（含每项当前值）
export function progress(card: GachaCard, text: string) {
  return evaluate(text, describe(card));
}

// 点亮判定：打出去不等于点亮，正文真做到才算；没有条件的卡落地即亮
export function litCheck(card: GachaCard, text: string): { ok: boolean; why: string } {
  const list = describe(card);
  if (!list.length) return { ok: true, why: '落地即点亮' };
  const r = evaluate(text, list);
  if (r.done) return { ok: true, why: '达成' };
  return { ok: false, why: r.items.filter((i) => !i.ok).map((i) => `${i.label}（${i.detail}）`).join('；') };
}

// 图鉴：按系列分组，标出已收/已点亮
export interface CodexRow {
  card: GachaCard;
  owned: number;
  litAt?: string;
  appliedAt?: string;
}
export function codex(user: UserCards, state: GachaState): { series: string; rows: CodexRow[] }[] {
  const pool = activePool(user);
  const bySeries = new Map<string, CodexRow[]>();
  for (const card of pool) {
    const list = bySeries.get(card.series) ?? [];
    list.push({ card, owned: state.owned[card.id] ?? 0, litAt: state.lit[card.id], appliedAt: state.applied[card.id] });
    bySeries.set(card.series, list);
  }
  return [...bySeries.entries()].map(([series, rows]) => ({ series, rows }));
}

export const CHANGE_PRICE = CHANGE_COST;
