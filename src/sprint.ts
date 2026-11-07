// 码字冲刺：一段不受打扰的计时写作。
// 进行中的冲刺存 localStorage（换视图 / 重启不丢），成绩记进 stats.sprints 随自动保存落盘。纯本地。

import type { SprintRecord } from './types';

export type { SprintRecord };

export interface ActiveSprint {
  /** 开始时刻（epoch ms） */
  start: number;
  /** 计划时长（分钟） */
  minutes: number;
  /** 起跑时的今日字数（结算用差值） */
  baseWords: number;
}

const KEY = 'ww-sprint-active';

/** 冲刺时长可选档位 */
export const SPRINT_CHOICES = [15, 25, 45];

export function loadActiveSprint(): ActiveSprint | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as ActiveSprint;
    if (typeof s?.start !== 'number' || typeof s?.minutes !== 'number' || typeof s?.baseWords !== 'number') return null;
    return s;
  } catch {
    return null;
  }
}

export function saveActiveSprint(s: ActiveSprint | null): void {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    // 存不进就只活在本次会话里
  }
}

export function sprintLeftMs(s: ActiveSprint, now = Date.now()): number {
  return Math.max(0, s.start + s.minutes * 60_000 - now);
}

export function fmtClock(ms: number): string {
  const t = Math.ceil(ms / 1000);
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 结算一条冲刺记录：实际计时时长按分钟取整（至少 1），字数取今日字数差（删改回扣，不低于 0） */
export function settleSprint(s: ActiveSprint, nowWords: number, endedAt = Date.now()): SprintRecord {
  const elapsedMin = Math.max(1, Math.round((Math.min(endedAt, s.start + s.minutes * 60_000) - s.start) / 60_000));
  return { at: new Date(endedAt).toISOString(), minutes: elapsedMin, words: Math.max(0, nowWords - s.baseWords) };
}
