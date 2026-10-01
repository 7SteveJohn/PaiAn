// 伏笔利息：把「埋了忘收」从一句提醒变成会累积的账。
// 只吃已有事实——伏笔标记的埋点章 + 章序 + 正文长度，不猜剧情、不调模型。
import type { GachaCard } from './gacha';
import type { Project } from './types';

// 挂过这几章就开始计息：前 3 章属于正常写作节奏，不该一埋就催
export const DEBT_AGE = { soon: 4, late: 9, lost: 18 };

export type DebtLevel = 'ok' | 'soon' | 'late' | 'lost';

export const DEBT_LABEL: Record<DebtLevel, string> = {
  ok: '新鲜',
  soon: '该想想',
  late: '该收了',
  lost: '快烂尾',
};

const RANK: Record<DebtLevel, number> = { lost: 0, late: 1, soon: 2, ok: 3 };

export interface HookDebt {
  id: string; // 就是那条伏笔标记的 id，掉卡时拿它当稳定 key
  text: string;
  plantedAt: number | null; // 埋在第几章（1 起，按目录顺序）；锚点丢了为 null
  age: number; // 到最新已写章挂了几章
  words: number; // 埋点之后又写了多少字——「读者等了多远」的真实刻度
  level: DebtLevel;
  expected?: string;
  unanchored?: boolean; // 没有埋点章（单文档项目或标记被挪过），算不出账
}

const levelOf = (age: number): DebtLevel => (age >= DEBT_AGE.lost ? 'lost' : age >= DEBT_AGE.late ? 'late' : age >= DEBT_AGE.soon ? 'soon' : 'ok');

/** 每条未回收伏笔的欠账，按严重程度排好序 */
export function hookDebts(project: Project): HookDebt[] {
  const marks = (project.marks ?? []).filter((m) => m.type === '伏笔' && m.status !== '回收' && (m.text ?? '').trim());
  if (!marks.length) return [];
  const chapters = project.chapters ?? [];
  const noOf = new Map(chapters.map((c, i) => [c.id, i + 1]));
  let last = 0; // 最新已写章：全都没写就不该催账
  chapters.forEach((c, i) => {
    if ((c.content ?? '').trim()) last = Math.max(last, i + 1);
  });
  const out: HookDebt[] = marks.map((m) => {
    const plantedAt = m.chapterId ? noOf.get(m.chapterId) ?? null : null;
    const age = plantedAt ? Math.max(0, last - plantedAt) : 0;
    let words = 0;
    if (plantedAt) {
      for (let i = plantedAt; i < last; i++) words += (chapters[i]?.content ?? '').trim().length;
    }
    return {
      id: m.id,
      text: m.text.trim().slice(0, 60),
      plantedAt,
      age,
      words,
      level: plantedAt ? levelOf(age) : 'ok',
      ...(m.expected?.trim() ? { expected: m.expected.trim().slice(0, 30) } : {}),
      ...(plantedAt || !m.chapterId ? {} : { unanchored: true }),
    };
  });
  return out.sort((a, b) => RANK[a.level] - RANK[b.level] || b.age - a.age || b.words - a.words);
}

/** 欠得最多的几条做成卡：打出去就把「收线」挂到本章的伏笔安排里 */
export function debtCards(debts: HookDebt[], limit = 3): GachaCard[] {
  return debts
    .filter((d) => d.level !== 'ok')
    .slice(0, Math.max(1, Math.min(10, limit)))
    .map((d) => {
      const where = d.plantedAt ? `第${d.plantedAt}章埋的` : '埋点章已找不到';
      const payload =
        `这条伏笔${where}，到现在挂了 ${d.age} 章、约 ${d.words} 字还没收。` +
        (d.expected ? `你当时写的预期是「${d.expected}」，` : '') +
        '本章要么兑现，要么明确推进半步（读者要看得出它在动），要么写一段让人知道你是故意按着的——最坏的是继续悬着。';
      return {
        id: `debt-${d.id}`,
        series: '小事',
        rarity: 'N' as const,
        name: `收线：${d.text.slice(0, 10)}${d.text.length > 10 ? '…' : ''}`.slice(0, 30),
        effect: 'hook' as const,
        payload: payload.slice(0, 600),
      };
    });
}

/** 与卡池里已有的卡合并：同一条伏笔永远只有一张收线卡 */
export function newDebtCards(debts: HookDebt[], existing: { id: string }[], limit = 3): GachaCard[] {
  const have = new Set(existing.map((c) => c.id));
  return debtCards(debts, limit).filter((c) => !have.has(c.id));
}
