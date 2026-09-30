// 约束类卡牌的求值层：把「这张卡要求你做到什么」写成可判定的条件，
// 一边写一边算达成率，全过才点亮。全部确定性字符串/正则判断，不调模型、不联网。
//
// 三条口径上的坚持：
// 1) 统计只看叙述段——引号里的对白不算句长、不算段首人称，否则写对白多的章永远达不成。
// 2) 达成率给分项而不只给结论：每一项都带人话说明与当前值，看得见差在哪。
// 3) 条件数量而不是文学质量。它能治「他…他…他」和「整章全是长句」这类节奏病，
//    不能判断写得好不好——那是你的事。
import { quoteRanges, scanDeslop, DESLOP_RULES } from './deslop';

export type Constraint =
  | { kind: 'any'; words: string[] }
  | { kind: 'absent'; words: string[] }
  | { kind: 'maxSentence'; chars: number }
  | { kind: 'dialogueShare'; min?: number; max?: number }
  | { kind: 'pronounOpen'; max: number }
  | { kind: 'deslopMax'; key: string; count: number };

export interface ConstraintItem {
  label: string;
  ok: boolean;
  detail: string; // 当前值或差在哪，直接给作者看
}

export interface ConstraintReport {
  items: ConstraintItem[];
  total: number;
  passed: number;
  done: boolean;
}

const SENT_SPLIT = /[。！？…；\n]+/;
const PRONOUN_OPEN = /^(他|她|它)(?![们])/;
const QUOTE_START = /^[「“‘『']/;

// 去掉引号覆盖的字符，得到「叙述层」文本；长度按剩余字符计
function narrationOnly(text: string): string {
  const ranges = quoteRanges(text);
  if (!ranges.length) return text;
  let out = '';
  let cursor = 0;
  for (const [a, b] of ranges) {
    if (a > cursor) out += text.slice(cursor, a);
    cursor = Math.max(cursor, b);
  }
  return out + text.slice(cursor);
}

export function quotedShare(text: string): number {
  const all = text.replace(/\s/g, '').length;
  if (!all) return 0;
  const inQuote = text.length - narrationOnly(text).length;
  return Math.round((inQuote / all) * 100);
}

const ruleLabel = (key: string) => DESLOP_RULES.find((r) => r.key === key)?.label ?? key;

export function evaluate(text: string, list: Constraint[]): ConstraintReport {
  const body = text ?? '';
  const items: ConstraintItem[] = [];
  for (const c of list) {
    switch (c.kind) {
      case 'any': {
        const hit = c.words.find((w) => body.includes(w));
        items.push({ label: `写出「${c.words.join('／')}」之一`, ok: Boolean(hit), detail: hit ? `已有「${hit}」` : '正文里还没有' });
        break;
      }
      case 'absent': {
        const hit = c.words.filter((w) => body.includes(w));
        items.push({ label: `不出现「${c.words.join('／')}」`, ok: hit.length === 0, detail: hit.length ? `还留着：${hit.slice(0, 3).join('、')}` : '干净' });
        break;
      }
      case 'maxSentence': {
        const sentences = narrationOnly(body)
          .split(SENT_SPLIT)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const over = sentences.filter((s) => s.length > c.chars);
        const longest = sentences.reduce((m, s) => Math.max(m, s.length), 0);
        items.push({
          label: `叙述句不超过 ${c.chars} 字`,
          ok: over.length === 0 && sentences.length > 0,
          detail: !sentences.length ? '还没有叙述句' : over.length ? `${over.length} 句超长，最长 ${longest} 字：${over[0].slice(0, 18)}…` : `最长 ${longest} 字`,
        });
        break;
      }
      case 'dialogueShare': {
        const share = quotedShare(body);
        const lo = c.min ?? 0;
        const hi = c.max ?? 100;
        items.push({
          label: c.min !== undefined && c.max === undefined ? `对白占比 ≥ ${lo}%` : c.max !== undefined && c.min === undefined ? `对白占比 ≤ ${hi}%` : `对白占比 ${lo}–${hi}%`,
          ok: body.trim().length > 0 && share >= lo && share <= hi,
          detail: body.trim() ? `现在 ${share}%` : '正文还是空的',
        });
        break;
      }
      case 'pronounOpen': {
        const paras = body
          .split(/\n+/)
          .map((p) => p.trim())
          .filter(Boolean);
        // 拿引号开场的段落正是我们鼓励的换法，不该剥掉引号再回头判它「以他开头」
        const hits = paras.filter((p) => !QUOTE_START.test(p) && PRONOUN_OPEN.test(p));
        items.push({
          label: `以「他/她」开头的段落 ≤ ${c.max} 段`,
          ok: hits.length <= c.max,
          detail: hits.length ? `现在 ${hits.length} 段：${hits[0].slice(0, 14)}…` : '没有',
        });
        break;
      }
      case 'deslopMax': {
        const n = scanDeslop(body).filter((h) => h.key === c.key).length;
        items.push({
          label: `「${ruleLabel(c.key)}」≤ ${c.count} 处`,
          ok: n <= c.count,
          detail: n ? `命中 ${n} 处` : '一处没有',
        });
        break;
      }
      default:
        items.push({ label: '未知条件', ok: false, detail: '这张卡的约束写法不认识，请删掉或改成已支持的类型' });
    }
  }
  const passed = items.filter((i) => i.ok).length;
  // 没有条件的卡：落地即达成，与 litCheck 的「落地即点亮」同一口径，别出现两套判据
  return { items, total: items.length, passed, done: passed === items.length };
}

export function describe(card: { name: string; any?: string[]; absent?: string[]; constraints?: Constraint[] }): Constraint[] {
  const list: Constraint[] = [];
  if (card.any?.length) list.push({ kind: 'any', words: card.any });
  if (card.absent?.length) list.push({ kind: 'absent', words: card.absent });
  for (const c of card.constraints ?? []) list.push(c);
  return list;
}

// 卡面上的一句话条件摘要，图鉴与手牌都用它
export function summarize(list: Constraint[]): string {
  return list
    .map((c) => {
      switch (c.kind) {
        case 'any':
          return `需出现：${c.words.join('／')}`;
        case 'absent':
          return `禁：${c.words.join('／')}`;
        case 'maxSentence':
          return `叙述句≤${c.chars}字`;
        case 'dialogueShare':
          return c.min !== undefined ? `对白≥${c.min}%` : `对白≤${c.max}%`;
        case 'pronounOpen':
          return `段首人称≤${c.max}段`;
        case 'deslopMax':
          return `${ruleLabel(c.key)}≤${c.count}`;
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join(' · ');
}

// 两张卡的条件下酒：同一维度冲突时取较松的一侧。
// 理由很实际——永远达不成的组合会把「点亮」变成挫败，而组合的价值在于
// 要同时兼顾更多维度，不在于把每项都拧到最严。谁让了步会回传给卡面文本。
export interface MergedConstraints {
  list: Constraint[];
  yielded: string[]; // 「对白占比取了两头的并集」这类让步说明
}

export function mergeConstraints(a: Constraint[], b: Constraint[]): MergedConstraints {
  const list: Constraint[] = [];
  const yielded: string[] = [];
  const words = (kind: 'any' | 'absent', ...cs: Constraint[]) => cs.filter((c): c is Extract<Constraint, { kind: 'any' }> | Extract<Constraint, { kind: 'absent' }> => c.kind === kind).flatMap((c) => c.words);
  for (const kind of ['any', 'absent'] as const) {
    for (const group of [words(kind, ...a), words(kind, ...b)]) {
      const uniq = [...new Set(group)].filter(Boolean);
      if (uniq.length) list.push({ kind, words: uniq } as Constraint);
    }
  }
  const maxSentence = [...a, ...b].filter((c): c is Extract<Constraint, { kind: 'maxSentence' }> => c.kind === 'maxSentence');
  if (maxSentence.length) {
    const chars = Math.max(...maxSentence.map((c) => c.chars));
    list.push({ kind: 'maxSentence', chars });
    if (maxSentence.length > 1 && Math.min(...maxSentence.map((c) => c.chars)) !== chars) yielded.push(`叙述句长放宽到 ${chars} 字（两卡要求不一，取宽松一侧）`);
  }
  const share = [...a, ...b].filter((c): c is Extract<Constraint, { kind: 'dialogueShare' }> => c.kind === 'dialogueShare');
  if (share.length) {
    const min = Math.min(...share.map((c) => c.min ?? 0));
    const max = Math.max(...share.map((c) => c.max ?? 100));
    list.push({ kind: 'dialogueShare', min, max });
    if (share.some((c) => c.min !== undefined) && share.some((c) => c.max !== undefined)) yielded.push(`对白占比取 ${min}–${max}%（一张要话多、一张要话少，取两头的并集）`);
  }
  const pronoun = [...a, ...b].filter((c): c is Extract<Constraint, { kind: 'pronounOpen' }> => c.kind === 'pronounOpen');
  if (pronoun.length) {
    const max = Math.max(...pronoun.map((c) => c.max));
    list.push({ kind: 'pronounOpen', max });
    if (pronoun.length > 1 && Math.min(...pronoun.map((c) => c.max)) !== max) yielded.push(`段首人称放宽到 ${max} 段`);
  }
  const deslop = new Map<string, number>();
  for (const c of [...a, ...b]) {
    if (c.kind !== 'deslopMax') continue;
    deslop.set(c.key, Math.max(deslop.get(c.key) ?? -1, c.count));
  }
  for (const [key, count] of deslop) list.push({ kind: 'deslopMax', key, count });
  return { list, yielded };
}

// 交给规则中心的文本：AI 也要守这张卡的规矩，不然它续写会直接把约束打回去。
// 词表类不用注入（禁用词提醒已经在正文里了），只给需要理解语义的那几类。
export function asRuleText(list: Constraint[]): string {
  const hard = list.filter((c) => c.kind !== 'any' && c.kind !== 'absent');
  if (!hard.length) return '';
  return (
    '本章带着这些写作约束，续写/润色/扩写都要遵守，不要把它们写回去：' +
    hard
      .map((c) => {
        switch (c.kind) {
          case 'maxSentence':
            return `叙述句控制在 ${c.chars} 字以内，宁可断句`;
          case 'dialogueShare':
            return c.min !== undefined ? `对白要占到全章 ${c.min}% 以上` : `几乎不用对白（占比压在 ${c.max}% 以下）`;
          case 'pronounOpen':
            return `别用「他/她」开头铺段，全章最多 ${c.max} 段`;
          case 'deslopMax':
            return `「${ruleLabel(c.key)}」这类句子最多 ${c.count} 处`;
          default:
            return '';
        }
      })
      .filter(Boolean)
      .join('；') +
    '。'
  );
}
