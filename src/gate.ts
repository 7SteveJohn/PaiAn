// 批量生成前置门禁：纯函数、确定性、可在设置页整体关掉。
// 只管两件事，都是真实翻车路径：
// 1) 没细纲就批量出稿——等于把这章的剧情白交给模型定，长篇里是几十章无法挽回的漂移；
// 2) 选章里已经挂着未采纳的草稿——再生成会直接覆盖，草稿没有快照，丢了找不回。
import { countWords } from './util';
import { loreWarnings } from './watchdog';
import type { LoreInput } from './watchdog';

// 要点少于这么多字，算「还没想清楚这章写什么」（连一句话都不到）
export const MIN_BEATS = 12;
// 采纳后正文低于目标的这个成数，才提字数欠账；6 成以下多半是没写完
export const QUOTA_FLOOR = 0.6;

export interface GateHit {
  id: string;
  no: number; // 全书章号，1 起
  title: string;
}

export interface GateReport {
  thin: GateHit[]; // 选中且缺细纲
  draft: GateHit[]; // 选中且已有待审草稿，会被覆盖
  safe: number; // 有细纲、可以放心生成的章数
  lore: string[]; // 守夜人查出的境界矛盾：不拦生成，但 AI 会照着已写正文续
}

const bare = (s?: string) => (s ?? '').replace(/[\s·、,，。;；:：-]/g, '').length;

// 这一章的细纲够不够拿去生成（单章不做门禁，只给卡片做标记）
export function isThin(c: { beats?: string }): boolean {
  return bare(c.beats) < MIN_BEATS;
}

// 只用到这几个字段，Chapter 结构上直接满足；测试里也不必造完整章对象
export type GateChapter = { id: string; title?: string; beats?: string; pending?: string };

export function preflight(chapters: GateChapter[], ids: Iterable<string>, project?: LoreInput): GateReport {
  const want = new Set(ids);
  const thin: GateHit[] = [];
  const draft: GateHit[] = [];
  let safe = 0;
  chapters.forEach((c, i) => {
    if (!want.has(c.id)) return;
    const hit: GateHit = { id: c.id, no: i + 1, title: c.title || `第${i + 1}章` };
    if (isThin(c)) thin.push(hit);
    else safe++;
    if ((c.pending ?? '').trim()) draft.push(hit);
  });
  return { thin, draft, safe, lore: project ? loreWarnings(project) : [] };
}

export function hasGatework(rep: GateReport): boolean {
  return rep.thin.length > 0 || rep.draft.length > 0 || rep.lore.length > 0;
}

const list = (hits: GateHit[]) =>
  hits
    .slice(0, 4)
    .map((h) => `第${h.no}章`)
    .join('、') + (hits.length > 4 ? ` 等 ${hits.length} 章` : '');

// 人话摘要，用于门禁面板与确认文案；无问题时返回空串
export function gateSummary(rep: GateReport): string {
  const parts: string[] = [];
  if (rep.thin.length) parts.push(`${rep.thin.length} 章没有剧情要点（${list(rep.thin)}）`);
  if (rep.draft.length) parts.push(`${rep.draft.length} 章已挂着未采纳的草稿，会被覆盖（${list(rep.draft)}）`);
  if (rep.lore.length) parts.push(`正文里有 ${rep.lore.length} 处境界前后不一（${rep.lore[0]}${rep.lore.length > 1 ? ' 等' : ''}）`);
  return parts.join('；');
}

// 采纳后的字数欠账：目标为 0（没设）或达标都返回 null
export function quotaGap(text: string, target: number): { words: number; pct: number } | null {
  if (!(target > 0)) return null;
  const words = countWords(text ?? '');
  if (words >= target * QUOTA_FLOOR) return null;
  return { words, pct: Math.round((words / target) * 100) };
}
