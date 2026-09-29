// 作品健康度（大纲页状态条的数据源）：纯函数、零副作用、确定性。
// 规则面向长篇写作的真实翻车模式，宁少勿滥，全部由作品数据直接算出，
// 不依赖 AI、不读外部状态，可在回归测试中直接断言。
import type { Project } from './types';
import { countWords } from './util';

export type HealthLevel = 'warn' | 'info';

export interface HealthIssue {
  key: string;
  level: HealthLevel;
  text: string; // 现象（人话）
  act: string; // 下一步动作建议
}

export interface HealthReport {
  total: number; // 总章数
  written: number; // 有正文
  drafting: number; // 草稿待审（无正文但有 pending）
  todo: number; // 纯待写
  words: number; // 正文总字数
  target: number; // 字数目标（0=未启用）
  targetPct: number | null; // 完成度百分比，未启用目标为 null
  lastWritten: number; // 最新已写章号（1 起；0=尚未开写）
  issues: HealthIssue[]; // 已按 warn 在前排序
}

// 已写正文低于该字数视为「残章」：正常一章动辄上千字，低于阈值多半是没写完就标了已写
const SHORT_WORDS = 300;
// 写够这么多章才提醒生成全书梗概（20 章前近/中场前情足够覆盖，不需要它）
const ARC_MIN_WRITTEN = 12;
// 全书梗概落后正文几章开始提醒（3 章以内属于正常写作节奏）
const ARC_STALE_GAP = 3;
// 草稿积压到几章开始提醒（1 章可能是正在审，不算积压）
const PENDING_MIN = 2;

// 可选：调用方提供「章 → 字数」的查表（通常来自 chapterWordMap 增量缓存），
// 避免健康卡在长书上每次重算都全量扫正文。不传则回退为逐章 countWords。
export function analyzeHealth(p: Project, wordOf?: (c: { id: string; content?: string }) => number): HealthReport | null {
  if (p.mode !== 'chapters') return null;
  const chapters = p.chapters ?? [];
  if (chapters.length === 0) return null;

  const w = (c: { id: string; content?: string }) => (wordOf ? wordOf(c) : countWords(c.content ?? ''));
  const writtenNos: number[] = [];
  const draftingNos: number[] = [];
  let words = 0;
  chapters.forEach((c, i) => {
    if ((c.content ?? '').trim()) {
      writtenNos.push(i + 1);
      words += w(c);
    } else if ((c.pending ?? '').trim()) draftingNos.push(i + 1);
  });
  const lastWritten = writtenNos.length ? writtenNos[writtenNos.length - 1] : 0;
  const target = Math.max(0, Math.floor(p.target ?? 0));
  const targetPct = target > 0 ? Math.round((words / target) * 100) : null;

  const issues: HealthIssue[] = [];

  if (lastWritten === 0) {
    // 全新书：正文未开写，给一条开工引导，不判问题
    issues.push({
      key: 'fresh',
      level: 'info',
      text: `全书 ${chapters.length} 章大纲已就绪，正文还没有开写。`,
      act: '勾选「全选待写章」后批量生成草稿先出第一版，或直接进入章节写正文。',
    });
  } else {
    // 1) 短章 / 残章：已标「已写」但正文远低于正常篇幅
    const shorts = writtenNos.filter((n) => w(chapters[n - 1]) < SHORT_WORDS);
    if (shorts.length) {
      const shown = shorts.slice(0, 3).map((n) => `第${n}章`).join('、');
      issues.push({
        key: 'short-ch',
        level: 'warn',
        text: `${shorts.length} 章正文不足 ${SHORT_WORDS} 字（${shown}${shorts.length > 3 ? ` 等 ${shorts.length} 章` : ''}），进度里已算「已写」但其实是残章。`,
        act: '回对应章节补完正文，或清空正文让它回到待写——别让完成度虚高。',
      });
    }

    // 2) 全书梗概：写长后远古剧情进 AI 上下文全靠它；缺失或落后都会悄悄丢剧情
    const rs = p.rollingSummary;
    if (lastWritten >= ARC_MIN_WRITTEN) {
      if (!rs || !rs.text.trim()) {
        issues.push({
          key: 'arc-missing',
          level: 'warn',
          text: `已写 ${lastWritten} 章，但「全书梗概」还没生成——AI 对 20 章前的剧情会逐渐失忆。`,
          act: '点上方「全书梗概 → 生成」，把已写章节归并成一份滚动摘要。',
        });
      } else if (lastWritten - (rs.upTo ?? 0) >= ARC_STALE_GAP) {
        issues.push({
          key: 'arc-stale',
          level: 'warn',
          text: `全书梗概只并到第 ${rs.upTo} 章，正文已写到第 ${lastWritten} 章，中间这段对 AI 不可见。`,
          act: '点上方「全书梗概 → 并入新章」，补上缺口的剧情。',
        });
      }
    }

    // 3) 草稿积压：多章 pending 悬着不处理，会与后续大纲错位
    if (draftingNos.length >= PENDING_MIN) {
      const shown = draftingNos.slice(0, 3).map((n) => `第${n}章`).join('、');
      issues.push({
        key: 'pending',
        level: 'info',
        text: `${draftingNos.length} 章草稿待审（${shown}${draftingNos.length > 3 ? '…' : ''}），一直挂着的草稿会慢慢和最新大纲脱节。`,
        act: '逐章「看草稿 → 采纳为正文」或弃用，一次清完。',
      });
    }

    // 4) 悬空伏笔（正文锚点标记层）：埋了、没回收、也没标孤立
    const openMarks = (p.marks ?? []).filter((m) => m.type === '伏笔' && m.status !== '回收' && !m.orphaned && m.text.trim());
    if (openMarks.length) {
      const first = openMarks[0].text.trim();
      issues.push({
        key: 'open-marks',
        level: 'info',
        text: `${openMarks.length} 条伏笔埋下后还没回收（如「${first.slice(0, 16)}${first.length > 16 ? '…' : ''}」）。`,
        act: '续写时在相关章节的「伏笔安排」里写推进或回收，别让伏笔烂尾。',
      });
    }
  }

  issues.sort((a, b) => (a.level === 'warn' ? 0 : 1) - (b.level === 'warn' ? 0 : 1));
  return {
    total: chapters.length,
    written: writtenNos.length,
    drafting: draftingNos.length,
    todo: chapters.length - writtenNos.length - draftingNos.length,
    words,
    target,
    targetPct,
    lastWritten,
    issues,
  };
}
