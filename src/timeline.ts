// 双轨时间轴的数据层：把「章节序」与「故事内时间标签」压成可画的两条轨。
// timeLabel 是自由文本（「入历327年九月」「穿越第三日」），机器不比较先后——
// 只按「连续同标签」切段画带；同一标签出现在两个不连续区间，疑似闪回/回跳，
// 标出来给作者自己判断（也可能只是回到同一地点的后续），不替作者下结论。
import type { Chapter } from './types';

export interface TimeRun {
  label: string; // 标签原文（trim 过）；空串 = 未标注
  from: number; // 起始章号（全书章号，含）
  to: number; // 结束章号（含）
}

/** 连续同标签切段：相邻两章 trim 后标签相同才并进同一段。未标注也是一段（画灰色块）。 */
export function timeRuns(chapters: Pick<Chapter, 'timeLabel'>[]): TimeRun[] {
  const out: TimeRun[] = [];
  for (let i = 0; i < chapters.length; i++) {
    const label = (chapters[i].timeLabel ?? '').trim();
    const last = out[out.length - 1];
    if (last && last.label === label) last.to = i + 1;
    else out.push({ label, from: i + 1, to: i + 1 });
  }
  return out;
}

export interface RepeatGroup {
  label: string;
  runs: TimeRun[]; // ≥2 段，按出现顺序
}

/** 同一（非空）标签出现在 ≥2 个区间的：疑似闪回/回跳。按首次出现排序。 */
export function repeatedLabels(chapters: Pick<Chapter, 'timeLabel'>[]): RepeatGroup[] {
  const byLabel = new Map<string, TimeRun[]>();
  for (const r of timeRuns(chapters)) {
    if (!r.label) continue;
    const list = byLabel.get(r.label) ?? [];
    list.push(r);
    byLabel.set(r.label, list);
  }
  return [...byLabel.entries()].filter(([, rs]) => rs.length >= 2).map(([label, runs]) => ({ label, runs }));
}

export interface TrackBlock extends TimeRun {
  x0: number; // 0–1，与章节序同一比例尺
  x1: number;
  repeated: boolean;
}

export interface TrackLayout {
  total: number;
  blocks: TrackBlock[];
  dots: { x: number; labeled: boolean }[]; // 上轨：每章一点
}

/** 布局：x 轴 = 章节序比例尺。正常书写时下轨的带子近似水平；标签跨区间复现会拉出长回线。 */
export function trackLayout(chapters: Pick<Chapter, 'timeLabel'>[]): TrackLayout {
  const total = chapters.length;
  const repeats = new Set(repeatedLabels(chapters).map((r) => r.label));
  const runs = timeRuns(chapters);
  const blocks: TrackBlock[] = runs.map((r) => ({
    ...r,
    x0: (r.from - 1) / total,
    x1: r.to / total,
    repeated: repeats.has(r.label),
  }));
  const dots = chapters.map((c, i) => ({ x: (i + 0.5) / total, labeled: Boolean((c.timeLabel ?? '').trim()) }));
  return { total, blocks, dots };
}

/** 给提示行用的区间文案：「第 3–5 章」，单章就是「第 3 章」。 */
export function runText(r: TimeRun): string {
  return r.from === r.to ? `第 ${r.from} 章` : `第 ${r.from}–${r.to} 章`;
}
