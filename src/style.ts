// 笔触漂移：拿「你自己惯常的写法」当对照，看最近几章往哪儿偏了。
// 与拆文对标是同一套尺子（bench 的节奏统计 + compare 的差距），只是对照物从
// 「别人的书」换成「你自己前段/其它书」——长篇最怕的不是写得像别人，是写着写着自己变了。
// 纯统计，不存原文、不调模型。
import { compare, myStats, type ChapterStats, type Gap } from './bench';

// 短于这个字数的章不参与：一段随手标注会把句长中位数整个带跑
export const MIN_CHAPTER_CHARS = 150;
// 「最近」取几章（再多就不算「最近」了，漂移要的是近期趋势）
export const TAIL_CHAPTERS = 8;
// 别的书凑够这么多章才配当基准，否则退回「同一本书的前段」
export const OTHER_BOOK_MIN = 6;
// 基准最多取多少章：太久远的习惯不必一路背着
export const BASE_CAP = 30;
// 两边各少于这个章数，中位数没有意义，直接不判
export const SIDE_MIN = 3;

export interface PortraitInput {
  id: string;
  title?: string;
  mode?: string;
  draft?: string;
  chapters?: { id: string; title: string; content: string }[];
}

export interface Portrait {
  recent: ChapterStats[];
  base: ChapterStats[];
  recentLabel: string;
  baseLabel: string;
  ok: boolean;
  note: string; // 不成立时说明差多少章；成立时为空
}

const usable = (list: ChapterStats[]) => list.filter((c) => c.chars >= MIN_CHAPTER_CHARS);

function empty(note: string): Portrait {
  return { recent: [], base: [], recentLabel: '', baseLabel: '', ok: false, note };
}

export function portrait(projects: PortraitInput[], currentId: string): Portrait {
  const cur = projects.find((p) => p.id === currentId) ?? projects[0];
  if (!cur) return empty('还没有作品，先写几章再来看笔触。');
  const mineAll = usable(myStats(cur as Parameters<typeof myStats>[0]));
  let others: ChapterStats[] = [];
  let otherBooks = 0;
  for (const p of projects) {
    if (p.id === cur.id) continue;
    const s = usable(myStats(p as Parameters<typeof myStats>[0]));
    if (s.length >= SIDE_MIN) {
      otherBooks++;
      others = others.concat(s);
    }
  }
  // 先给基准留出 SIDE_MIN 章，否则「最近」会把整本书吃掉
  const recentN = Math.max(SIDE_MIN, Math.min(TAIL_CHAPTERS, mineAll.length - SIDE_MIN));
  const recent = mineAll.slice(-recentN);
  const head = mineAll.slice(0, Math.max(0, mineAll.length - recentN));
  const useOthers = others.length >= OTHER_BOOK_MIN;
  const base = (useOthers ? others : head).slice(-BASE_CAP);
  const baseLabel = useOthers ? `你另外 ${otherBooks} 部书共 ${base.length} 章` : `同一本书的前 ${base.length} 章`;
  const ok = base.length >= SIDE_MIN && recent.length >= SIDE_MIN;
  return {
    recent,
    base,
    recentLabel: `最近 ${recent.length} 章`,
    baseLabel,
    ok,
    note: ok
      ? ''
      : `判漂移要两边各 ≥${SIDE_MIN} 章：这本可用正文 ${mineAll.length} 章（不足 ${MIN_CHAPTER_CHARS} 字的章不计），再多写几章就有了。`,
  };
}

// mine = 最近，theirs = 惯常：差值方向与「掉卡学它」保持一致，卡面只是把「学它」换成「找回」
export function driftGaps(p: Portrait): Gap[] {
  return p.ok ? compare(p.recent, p.base) : [];
}
