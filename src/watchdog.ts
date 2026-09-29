// 设定守夜人：境界线有没有往回走、称谓是不是写串、谁已经很多章没露面。
// 只吃已有事实——力量体系词条、人物卡的境界、章节正文与出场名单，全确定性、不联网、不调模型。
// 一条底线：**只报不改**，而且认不出就留白。归属有歧义（一段里两个人名挨着同一个境界词）、
// 落在台词里、前面跟着「还没／未曾」这类否定，一律不算——报错一次的代价是你以后不看这个面板了。
import { inQuote, quoteRanges } from './deslop';
import type { GachaCard } from './gacha';

/** 沉默多少章才算「好久没露面」：几章内属于正常换场，不催 */
export const SILENCE_GAP = 6;
/** 境界词与人名挨到多近才归属（字符）：隔太远就是两句话，不算同一个人 */
export const ATTR_WINDOW = 14;
/** 一次最多掉几张卡：守夜人不该把卡池变成报错列表 */
export const CARD_LIMIT = 4;

export interface Ladder {
  label: string;
  source: '词条' | '内置';
  stems: string[]; // 由低到高
}

// 内置境界线只在词条没写清楚时兜底。匹配用一条「长名在前」的正则，
// 否则「大斗师」会被「斗师」吃掉半截。
export const BUILTIN_LADDERS: Ladder[] = [
  { label: '炼气→渡劫', source: '内置', stems: ['炼气', '筑基', '金丹', '元婴', '化神', '炼虚', '合体', '大乘', '渡劫'] },
  { label: '斗气', source: '内置', stems: ['斗者', '斗师', '大斗师', '斗灵', '斗王', '斗皇', '斗宗', '斗尊', '斗圣', '斗帝'] },
  { label: '武者', source: '内置', stems: ['淬体', '开脉', '凝元', '通玄', '超凡', '半圣', '入圣'] },
];

const DIGIT: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function cnNum(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  const m = s.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? DIGIT[m[1]] : 1) * 10 + (m[2] ? DIGIT[m[2]] : 0);
  return DIGIT[s] ?? 0;
}

/** 境界词后面那段「第几层 / 中后期 / 大圆满」→ 同一境界内的刻度（1–90，没标算 1） */
function phaseOf(tail: string): { rank: number; text: string } {
  const s = tail.slice(0, 8);
  for (const [re, rank] of [
    [/^大圆满/, 90],
    [/^(圆满|巅峰|极境)/, 80],
    [/^后期/, 40],
    [/^中期/, 30],
    [/^(前期|初期)/, 20],
  ] as [RegExp, number][]) {
    const m = s.match(re);
    if (m) return { rank, text: m[0] };
  }
  const layer = s.match(/^([0-9]{1,2}|[一二三四五六七八九十]{1,3})层/);
  if (layer) return { rank: Math.min(10, Math.max(1, cnNum(layer[1]))) * 4, text: layer[0] };
  return { rank: 1, text: '' };
}

const byLen = (a: string, b: string) => b.length - a.length || (a < b ? -1 : 1);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CN_ONLY = /^[㐀-䶿一-鿿]{2,4}$/;

/** 从作者自己写的「力量体系」词条里抽出境界序列：按分隔符切开，只留像境界名的段 */
export function stemsFromText(text: string): string[] {
  const out: string[] = [];
  for (const seg of text.split(/\s*(?:→|->|》|＞|>|、|，|,|;|；|\/|\n)+\s*/)) {
    // 只取段首那一串汉字：词条常见写法是「金丹 → 元婴……灵气枯竭后」，省略号后面是说明
    const run = seg.match(/^[\u3400-\u9fff]{2,4}(?![\u3400-\u9fff])/);
    if (!run) continue;
    const stem = run[0].length >= 3 && run[0].endsWith('期') ? run[0].slice(0, -1) : run[0];
    if (!CN_ONLY.test(stem)) continue;
    if (!out.includes(stem)) out.push(stem);
  }
  return out;
}

/** 生效的境界表：词条里写明白的优先，一条都没有才用内置 */
/**
 * 守夜人只吃这几个字段——写成结构类型而不是 Project，AI 上下文层（src/util.ts 的 buildAiContext）
 * 才能拿它自己那份收窄的入参直接调，不必为了注入红线把整份 Project 拖过去。
 */
export interface LoreInput {
  mode?: 'single' | 'chapters';
  draft?: string;
  chapters?: { id?: string; title?: string; content?: string; cast?: string }[];
  characters?: { id?: string; name: string; power?: string; state?: string; relations?: { with: string }[] }[];
  worldItems?: { id?: string; name: string; kind: string; content: string }[];
}
export function laddersOf(project: LoreInput): Ladder[] {
  const fromCards = (project.worldItems ?? [])
    .filter((w) => w.kind === '力量体系')
    .map((w) => ({ label: w.name, source: '词条' as const, stems: stemsFromText(w.content ?? '') }))
    .filter((L) => L.stems.length >= 3);
  return fromCards.length ? fromCards : BUILTIN_LADDERS;
}

export const LADDER_SCAFFOLD = {
  name: '力量体系',
  kind: '力量体系' as const,
  content: '炼气 → 筑基 → 金丹 → 元婴（把你自己那套境界按高低排成一行，用 → 分隔；写对了守夜人才判得出回退）',
};

/** 还在用内置境界表，就是这本书的体系没写给工具看——自创境界（灯境、夜阶…）判不了，差的就是这一张卡 */
export function needsLadderCard(project: LoreInput): boolean {
  return !laddersOf(project).some((L) => L.source === '词条');
}

/** 一句「筑基中期」在境界表里的位置；认不出来回 null */
export function rankOfTerm(text: string, ladders: Ladder[]): { ladder: string; rank: number; term: string } | null {
  for (const L of ladders) {
    const stems = L.stems.slice().sort(byLen);
    for (const stem of stems) {
      const at = text.indexOf(stem);
      if (at < 0) continue;
      const { rank: phase, text: phaseText } = phaseOf(text.slice(at + stem.length, at + stem.length + 8));
      return { ladder: L.label, rank: L.stems.indexOf(stem) * 100 + phase, term: stem + phaseText };
    }
  }
  return null;
}

export interface RealmObs {
  name: string;
  ladder: string;
  term: string; // 「筑基中期」这样的原文词
  rank: number;
  no: number; // 第几章（单篇模式恒为 1）
  snippet: string;
}

export type RealmFinding =
  | { kind: 'regress'; name: string; ladder: string; from: { no: number; term: string }; to: { no: number; term: string }; snippet: string }
  | { kind: 'flip'; name: string; ladder: string; no: number; terms: [string, string] }
  | { kind: 'card-behind'; name: string; ladder: string; card: string; max: { no: number; term: string } };

export interface RealmReport {
  obs: RealmObs[];
  findings: RealmFinding[];
  ladderLabel: string;
  skipped: { dialogue: number; ambiguous: number; hedged: number };
}

interface Unit {
  no: number;
  body: string;
}

/** 章节模式按章、单篇按整篇——后面所有统计都只吃这个形状 */
export function unitsOf(project: LoreInput): Unit[] {
  if (project.mode === 'chapters' && project.chapters?.length) {
    return project.chapters.map((c, i) => ({ no: i + 1, body: c.content ?? '' }));
  }
  return [{ no: 1, body: project.draft ?? '' }];
}

// 「还没筑基」是否定，「当年他还是炼气」是回忆——都不是他此刻的境界，一律挡掉
const HEDGE_TAIL = /(尚未|还未|还没|未曾|不曾|没有|未|没|当年|那时|当初|曾经|从前|昔日)$/;
/** 境界词前面那口气里有没有「还没／当年」：允许 hedge 词后再挂一到两个字（当年他炼气…） */
function hedged(body: string, start: number): boolean {
  const near = body.slice(Math.max(0, start - 8), start);
  for (let cut = 0; cut <= 2; cut++) {
    const probe = cut === 0 ? near : near.slice(0, near.length - cut).replace(/[^\u3400-\u9fff]+$/, '');
    if (HEDGE_TAIL.test(probe)) return true;
  }
  return false;
}

/** 人名命中：长名先占位，「林越舟」里的「林越」不再算第二次出现 */
function nameSpans(body: string, names: string[]) {
  const taken = new Uint8Array(body.length);
  const spans: { name: string; start: number; end: number }[] = [];
  for (const n of [...names].filter(Boolean).sort(byLen)) {
    let i = body.indexOf(n);
    while (i >= 0) {
      if (!taken[i]) {
        spans.push({ name: n, start: i, end: i + n.length });
        for (let k = i; k < i + n.length; k++) taken[k] = 1;
      }
      i = body.indexOf(n, i + 1);
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

// 一句一句地归属：跨句就换主语了，「炼气三层。阿禾在身后咳嗽」不该算到阿禾头上
function sentenceRanges(body: string): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (/[。！？!?；;\n]/.test(body[i])) {
      out.push([start, i + 1]);
      start = i + 1;
    }
  }
  if (start < body.length) out.push([start, body.length]);
  return out;
}

function scanUnit(body: string, names: string[], ladders: Ladder[]) {
  const spans = nameSpans(body, names);
  const sentences = sentenceRanges(body);
  const quotes = quoteRanges(body);
  const obs: RealmObs[] = [];
  const skipped = { dialogue: 0, ambiguous: 0, hedged: 0 };
  const done = new Set<number>(); // 同一位置只按第一张命中的境界表处理，计数也不重复
  for (const L of ladders) {
    if (!L.stems.length) continue;
    const re = new RegExp(L.stems.slice().sort(byLen).map(escapeRe).join('|'), 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      const start = m.index;
      const end = start + m[0].length;
      if (done.has(start)) continue;
      done.add(start);
      if (inQuote(quotes, start, end)) {
        skipped.dialogue++;
        continue;
      }
      if (hedged(body, start)) {
        skipped.hedged++;
        continue;
      }
      const { rank: phase, text: phaseText } = phaseOf(body.slice(end, end + 8));
      const [sa, sb] = sentences.find(([a, b]) => start >= a && end <= b) ?? [0, body.length];
      const who = new Set(spans.filter((p) => p.start >= sa && p.end <= sb && p.end >= start - ATTR_WINDOW && p.start <= end + ATTR_WINDOW).map((p) => p.name));
      if (who.size !== 1) {
        if (who.size > 1) skipped.ambiguous++;
        continue;
      }
      obs.push({
        name: [...who][0],
        ladder: L.label,
        term: m[0] + phaseText,
        rank: L.stems.indexOf(m[0]) * 100 + phase,
        no: 0,
        snippet: body.slice(Math.max(0, start - 14), Math.min(body.length, end + 16)).replace(/\s+/g, ' ').trim(),
      });
    }
  }
  return { obs, skipped };
}

/** 把境界按章排出来，再判三种不一致：同章打架、往回走、卡落后于正文 */
export function realmReport(project: LoreInput): RealmReport {
  const names = (project.characters ?? []).map((c) => c.name);
  const ladders = laddersOf(project);
  const all: RealmObs[] = [];
  const skipped = { dialogue: 0, ambiguous: 0, hedged: 0 };
  for (const u of unitsOf(project)) {
    const r = scanUnit(u.body, names, ladders);
    for (const o of r.obs) o.no = u.no;
    all.push(...r.obs);
    skipped.dialogue += r.skipped.dialogue;
    skipped.ambiguous += r.skipped.ambiguous;
    skipped.hedged += r.skipped.hedged;
  }
  const findings: RealmFinding[] = [];
  if (all.length) {
    for (const name of [...new Set(all.map((o) => o.name))]) {
      for (const label of [...new Set(all.filter((o) => o.name === name).map((o) => o.ladder))]) {
        const mine = all.filter((o) => o.name === name && o.ladder === label);
        const byCh = new Map<number, RealmObs[]>();
        for (const o of mine) byCh.set(o.no, [...(byCh.get(o.no) ?? []), o]);
        const chapters = [...byCh.keys()].sort((a, b) => a - b);
        let best: RealmObs | null = null;
        for (const no of chapters) {
          const list = byCh.get(no) ?? [];
          const lo = list.reduce((a, b) => (b.rank < a.rank ? b : a));
          const hi = list.reduce((a, b) => (b.rank > a.rank ? b : a));
          if (lo.term !== hi.term) findings.push({ kind: 'flip', name, ladder: label, no, terms: [hi.term, lo.term] });
          if (best && hi.rank < best.rank) {
            findings.push({ kind: 'regress', name, ladder: label, from: { no: best.no, term: best.term }, to: { no, term: hi.term }, snippet: hi.snippet });
          }
          if (!best || hi.rank > best.rank) best = hi;
        }
        const card = project.characters?.find((c) => c.name === name);
        if (card?.power) {
          const at = rankOfTerm(card.power, ladders.filter((L) => L.label === label));
          const max = mine.reduce<RealmObs | null>((a, b) => (!a || b.rank > a.rank ? b : a), null);
          if (at && max && max.rank > at.rank) findings.push({ kind: 'card-behind', name, ladder: label, card: at.term, max: { no: max.no, term: max.term } });
        }
      }
    }
  }
  return { obs: all, findings, ladderLabel: ladders.map((L) => `${L.label}(${L.source})`).join('、'), skipped };
}

export type NameFinding =
  | { kind: 'near'; names: [string, string]; why: string; counts: [number, number] }
  | { kind: 'dead'; names: [string]; why: string }
  | { kind: 'cast-miss'; names: [string]; no: number; why: string }
  | { kind: 'relation-dangling'; names: [string, string]; why: string };

/** 称谓一致性：近名对、从没落地的卡、出场名单与正文对不上、关系指向空名 */
export function nameReport(project: LoreInput): NameFinding[] {
  const chars = (project.characters ?? []).filter((c) => c.name);
  if (!chars.length) return [];
  const units = unitsOf(project);
  const out: NameFinding[] = [];
  const uses = new Map(chars.map((c) => [c.name, units.reduce((a, u) => a + (u.body.split(c.name).length - 1), 0)]));

  for (const c of chars) {
    if (!uses.get(c.name)) out.push({ kind: 'dead', names: [c.name], why: '建档之后正文一次也没出现过这个名字' });
  }

  for (let i = 0; i < chars.length; i++) {
    for (let j = i + 1; j < chars.length; j++) {
      const a = chars[i].name;
      const b = chars[j].name;
      if (!uses.get(a) || !uses.get(b)) continue; // 没出场的人写不串
      const head = [...a].findIndex((ch, k) => ch !== [...b][k]);
      const prefix = head < 0 ? Math.min(a.length, b.length) : head;
      const ra = [...a].reverse();
      const rb = [...b].reverse();
      const tailAt = ra.findIndex((ch, k) => ch !== rb[k]);
      const suffix = tailAt < 0 ? Math.min(a.length, b.length) : tailAt;
      const why =
        a === b ? '两张卡同名' : a.includes(b) || b.includes(a) ? '一个是另一个的一部分' : prefix >= 2 ? `开头「${a.slice(0, prefix)}」相同` : suffix >= 2 ? `末尾「${a.slice(a.length - suffix)}」相同` : '';
      if (why) out.push({ kind: 'near', names: [a, b], why, counts: [uses.get(a)!, uses.get(b)!] });
    }
  }

  const roster = new Set(chars.map((c) => c.name));
  if (project.mode === 'chapters') {
    (project.chapters ?? []).forEach((ch, i) => {
      for (const raw of (ch.cast ?? '').split(/[、，,；;\n]+/)) {
        // 名单里最常见的两种写法是「铁鸦（未露面）」和「林越／阿禾」：先剥括号注释，再按斜杠拆开
        // 名单里作者自己标了「未露面」的，就是故意的，别再报一遍
        if (/未露面|未出场|未登场|不在场|回忆|闪回|仅提及/.test(raw)) continue;
        const stripped = raw.replace(/[（(][^）)]*[）)]?/g, '');
        for (const name of stripped.split(/[/／]/).map((s) => s.trim()).filter(Boolean)) {
          if ((ch.content ?? '').includes(name)) continue;
          out.push({ kind: 'cast-miss', names: [name], no: i + 1, why: roster.has(name) ? '出场名单里写了，正文却没有这个字' : '名单里这个名字没有对应的人物卡' });
        }
      }
    });
  }

  for (const c of chars) {
    for (const rel of c.relations ?? []) {
      if (rel.with && !roster.has(rel.with)) out.push({ kind: 'relation-dangling', names: [c.name, rel.with], why: `「${c.name}」的关系栏指向「${rel.with}」，可这本书里没有这张卡` });
    }
  }
  return out;
}

export interface SilenceRow {
  id: string;
  kind: '人物' | '设定';
  name: string;
  first: number;
  last: number; // 上次「进场」：出现在叙述里；0 = 从没进过场
  lastAny: number; // 最后一次被提到（含台词）
  mentionsAfter: number; // 上次进场之后，只在别人台词里出现了几次
  offstage: boolean;
  gap: number; // 距最新已写章隔了几章（按进场算）
  words: number; // 这些间隔里写了多少字——读者等了多远
}

/** 这个名字在这一章里是「进场」（叙述）还是只被别人「提起」（台词） */
function mentions(body: string, name: string) {
  const q = quoteRanges(body);
  let stage = 0;
  let talk = 0;
  let i = body.indexOf(name);
  while (i >= 0) {
    if (inQuote(q, i, i + name.length)) talk++;
    else stage++;
    i = body.indexOf(name, i + 1);
  }
  return { stage, talk };
}

/** 人物卡 state 里写了这些，就算「按卡他已不在场」。state 是作者自己维护的当前快照，工具只对账。 */
export const EXIT_WORDS = /已死|死去|死了|身亡|殁|牺牲|陨落|不在了|离世|丧命|尸骨|离队|已离开|远行未归|失踪|闭关|被俘|被囚|被带走/;
/** state 里写了这些（回归/否定），就别再按离场报——「没死」「归来」优先于「死了」 */
export const RETURN_WORDS = /归来|回来了|已回|返回|没死|未死|并未|没有死|没有离开|苏醒|复活/;

export interface ExitFinding {
  name: string;
  state: string; // 卡上的离场说法（截短展示）
  /** 可疑点名的章号；0 = state 没写章号锚点，无法对账（是引导项，不算 finding） */
  no: number;
  /** state 里写的章号锚点；null = 没写 */
  anchor: number | null;
}

/**
 * 离场人物又出场（OOC 维度）。state 是作者维护的当前快照，本身没有时间戳——
 * 自动猜分界（最后一次叙述出场 / 最后一次点名）都会误报：坟前提名、回忆、
 * 离场前的连续出场都定不了界。所以认得出才报：state 里写了章号锚点
 * （「第7章死去」「第二章起离队」）就只对锚点之后的 cast 点名对账；
 * 没写锚点的返回 no=0 的引导项（不进 findings 总账），面板提示作者补一句章号。
 * 名单注了「回忆 / 闪回 / 未露面」的豁免（与 nameReport 同一套口径）。
 */
export function exitReport(project: LoreInput): ExitFinding[] {
  const chars = (project.characters ?? []).filter((c) => c.name);
  if (!chars.length || project.mode !== 'chapters') return [];
  const EXEMPT = /未露面|未出场|未登场|不在场|回忆|闪回|仅提及/;
  const ANCHOR = /第\s*([0-9]{1,4}|[一二三四五六七八九十]{1,4})\s*章/;
  const out: ExitFinding[] = [];
  for (const c of chars) {
    const state = (c.state ?? '').trim();
    if (!state || RETURN_WORDS.test(state) || !EXIT_WORDS.test(state)) continue;
    const named = (project.chapters ?? []).map((ch) => {
      for (const raw of (ch.cast ?? '').split(/[、，,；;\n]+/)) {
        if (EXEMPT.test(raw)) continue;
        const stripped = raw.replace(/[（(][^）)]*[）)]?/g, '');
        if (stripped.split(/[/／]/).some((s) => s.trim() === c.name)) return true;
      }
      return false;
    });
    if (!named.some(Boolean)) continue; // 名单里压根没点过名：无从对账，正文提及不算（回忆太常见）
    const m = state.match(ANCHOR);
    if (!m) {
      out.push({ name: c.name, state: state.slice(0, 24), no: 0, anchor: null });
      continue;
    }
    const anchor = Math.max(1, cnNum(m[1]));
    named.forEach((yes, i) => {
      const no = i + 1;
      if (yes && no > anchor) out.push({ name: c.name, state: state.slice(0, 24), no, anchor });
    });
  }
  return out.sort((a, b) => (a.no === 0 ? 1 : b.no === 0 ? -1 : a.no - b.no) || a.name.localeCompare(b.name, 'zh'));
}

/** 远场沉默：把「第 1 章的细节到第 28 章还在不在」变成每个实体都算一次的常规账 */
export function silences(project: LoreInput, gap = SILENCE_GAP): SilenceRow[] {
  const units = unitsOf(project);
  const lastWritten = units.reduce((a, u) => (u.body.trim() ? Math.max(a, u.no) : a), 0);
  const rows: SilenceRow[] = [];
  const entities = [
    ...(project.characters ?? []).map((c) => ({ id: c.id ?? 'k:' + c.name, kind: '人物' as const, name: c.name })),
    ...(project.worldItems ?? []).map((w) => ({ id: w.id ?? 'w:' + w.name, kind: '设定' as const, name: w.name })),
  ];
  for (const e of entities) {
    if (!e.name) continue;
    let first = 0;
    let last = 0;
    let lastAny = 0;
    for (const u of units) {
      const m = mentions(u.body, e.name);
      if (!m.stage && !m.talk) continue;
      if (!first) first = u.no;
      lastAny = u.no;
      if (m.stage) last = u.no;
    }
    if (!first) continue; // 一次没出现的走「死卡」，不在这里重复报
    // 锚点取「上次进场」；从没进过场就退回最后一次被提起
    const anchor = last || lastAny;
    const g = lastWritten - anchor;
    if (g < gap) continue;
    const mentionsAfter = units.filter((u) => u.no > anchor).reduce((a, u) => a + mentions(u.body, e.name).talk, 0);
    const words = units.filter((u) => u.no > anchor && u.no <= lastWritten).reduce((a, u) => a + u.body.trim().length, 0);
    rows.push({ id: `${e.kind}-${e.id}`, kind: e.kind, name: e.name, first, last, lastAny, mentionsAfter, offstage: !last, gap: g, words });
  }
  return rows.sort((a, b) => b.gap - a.gap || b.words - a.words || a.name.localeCompare(b.name, 'zh'));
}

/** 守夜人的发现掉成卡：点亮条件就是这个名字本章真的出现在正文里 */
export function watchdogCards(project: LoreInput, existing: { id: string }[], limit = CARD_LIMIT): GachaCard[] {
  const realm = realmReport(project);
  const charId = new Map((project.characters ?? []).map((c) => [c.name, c.id]));
  const want: GachaCard[] = [];
  // 同一条线上可能连掉两次，只提醒最近那一次：那是还来得及改的地方
  const latest = new Map<string, RealmFinding & { kind: 'regress' }>();
  for (const f of realm.findings) {
    if (f.kind !== 'regress') continue;
    const prev = latest.get(f.name);
    if (prev && f.to.no <= prev.to.no) continue;
    latest.set(f.name, f);
  }
  for (const f of latest.values()) {
    want.push({
      id: `wd-realm-${charId.get(f.name) ?? f.name}`,
      series: '小事',
      rarity: 'N',
      name: `校境：${f.name}`.slice(0, 30),
      effect: 'beat',
      payload:
        `${f.name}的境界线：第${f.from.no}章写到「${f.from.term}」，第${f.to.no}章却成了「${f.to.term}」（那章的原话是「${f.snippet}」）。` +
        '本章要么把掉回去的代价写出来——废功、重伤、血脉反噬，读者接受「变强又变弱」，不接受没人解释；要么回头把那处改对。',
      any: [f.name],
    });
  }
  for (const c of project.characters ?? []) {
    if (!c.name || unitsOf(project).some((u) => u.body.includes(c.name))) continue;
    want.push({
      id: `wd-dead-${c.id ?? c.name}`,
      series: '小事',
      rarity: 'N',
      name: `唤醒：${c.name}`.slice(0, 30),
      effect: 'beat',
      payload:
        `人物卡「${c.name}」建档以来正文里一次也没出现过。本章让他露面一次：一个名字、一句台词、一个别人提起他的理由都行。` +
        '留着不用的卡只有两种可能——该删，或者这条线你已经忘了。',
      any: [c.name],
    });
  }
  for (const s of silences(project).slice(0, 4)) {
    want.push({
      id: `wd-silent-${s.id}`,
      series: '小事',
      rarity: 'N',
      name: `复现：${s.name}`.slice(0, 30),
      effect: 'beat',
      payload:
        (s.offstage
          ? `「${s.name}」从第${s.first}章到现在一次也没进过场——只在别人的台词里被提到 ${s.mentionsAfter || 1} 次（最后第${s.lastAny}章），距今 ${s.gap} 章、约 ${s.words} 字。` +
            '挂在别人嘴里的东西不算写过：要么让它真进一次场，要么把这张卡删掉。'
          : `「${s.name}」上次进场是第${s.last}章（第${s.first}章首次出现），之后又写了 ${s.gap} 章、约 ${s.words} 字它没再露面` +
            (s.mentionsAfter ? `，只在台词里被提起 ${s.mentionsAfter} 次（最后第${s.lastAny}章）` : '') +
            '。本章提它一下——不必进场，一句回忆、一个旧物件就够；或者写明白它为什么不在。读者会替你记住人物，也会替你记仇。'),
      any: [s.name],
    });
  }
  const have = new Set(existing.map((c) => c.id));
  const seen = new Set<string>();
  return want.filter((c) => !have.has(c.id) && !seen.has(c.id) && !!seen.add(c.id)).slice(0, Math.max(1, Math.min(10, limit)));
}

export interface Watchdog {
  realm: RealmReport;
  names: NameFinding[];
  exits: ExitFinding[];
  rows: SilenceRow[];
  total: number;
  /** 单篇模式没有章序：涉及章号的账要降级说明，别装作算出来了 */
  numbered: boolean;
}

/** 面板入口：一次算完，界面只管摆 */
export function watchdog(project: LoreInput): Watchdog {
  const realm = realmReport(project);
  const names = nameReport(project);
  const exits = exitReport(project);
  const rows = silences(project);
  return {
    realm,
    names,
    exits,
    rows,
    total: realm.findings.length + names.length + exits.filter((e) => e.no > 0).length + rows.length,
    numbered: project.mode === 'chapters' && (project.chapters?.length ?? 0) > 1,
  };
}

export interface RealmFloor {
  name: string;
  term: string;
  no: number; // 是在第几章写到的
  rank: number;
}

/** 每个人物「正文里已经写到的最高境界」——这是续写不许跌破的地板，与卡上写什么是两回事 */
export function realmFloors(project: LoreInput, limit = 8): RealmFloor[] {
  const best = new Map<string, RealmFloor>();
  for (const o of realmReport(project).obs) {
    const cur = best.get(o.name);
    if (!cur || o.rank > cur.rank) best.set(o.name, { name: o.name, term: o.term, no: o.no, rank: o.rank });
  }
  return [...best.values()].sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name, 'zh')).slice(0, Math.max(1, Math.min(20, limit)));
}

/** 注入 AI 上下文的那一段。整段只依赖「已写正文」，批量连写时每章都相同——
 *  放在罕变区（战力记录之后、按章重排的【人物】之前），公共前缀因此不被打断。 */
export function loreRedlines(project: LoreInput): string {
  const floors = realmFloors(project);
  if (!floors.length) return '';
  return floors.map((f) => `· ${f.name}：不低于「${f.term}」（正文第${f.no}章已写到）`).join('\n');
}

/** 门禁用的一行式警告：只列会影响续写的境界矛盾，最多 limit 条 */
export function loreWarnings(project: LoreInput, limit = 3): string[] {
  const out: string[] = [];
  for (const f of realmReport(project).findings) {
    if (out.length >= limit) break;
    if (f.kind === 'regress') out.push(`${f.name}：第${f.from.no}章「${f.from.term}」→ 第${f.to.no}章「${f.to.term}」`);
    else if (f.kind === 'flip') out.push(`${f.name}：第${f.no}章同时出现「${f.terms[0]}」与「${f.terms[1]}」`);
    else out.push(`${f.name}：卡上「${f.card}」落后于正文第${f.max.no}章的「${f.max.term}」`);
  }
  return out;
}
