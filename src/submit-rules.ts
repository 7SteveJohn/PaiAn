// 投稿体检·平台惯例：章长 / 长段 / 对白占比三条本地预检。
// 各平台惯例不同，这里只报与「常见区间」的偏离，供参考——改不改始终是作者的事。

export interface RuleInput {
  id: string;
  title: string;
  content: string;
}

export interface RuleFinding {
  kind: '章长' | '长段' | '对白比';
  chapterId: string;
  title: string;
  level: 'warn' | 'info';
  detail: string;
  /** 可跳转的位置（长段首字符）；整章层面的检查没有这个字段 */
  at?: number;
}

const LONG_PARA = 300; // 一段超过这个字数，手机上就是一堵墙
const SHORT_CHAPTER = 800; // 常见网文单章 2000–4000 字，明显低于区间多半是没写完
const LONG_CHAPTER = 9000;
const DIALOGUE_LOW = 0.02; // 对白占比低到这个程度基本是纯叙述
const DIALOGUE_HIGH = 0.85;

/** 逐章过三条预检，返回按章排序的发现列表 */
export function checkSubmission(inputs: RuleInput[]): RuleFinding[] {
  const out: RuleFinding[] = [];
  for (const input of inputs) {
    const text = input.content ?? '';
    if (!text.trim()) continue;
    const title = input.title || '未命名';
    const chars = text.replace(/\s/g, '').length;

    if (chars < SHORT_CHAPTER) {
      out.push({
        kind: '章长',
        chapterId: input.id,
        title,
        level: 'warn',
        detail: `本章只有 ${chars} 字——常见网文单章 2000–4000 字，偏短多半是还没写完。`,
      });
    } else if (chars > LONG_CHAPTER) {
      out.push({
        kind: '章长',
        chapterId: input.id,
        title,
        level: 'info',
        detail: `本章 ${chars} 字，明显超出常见区间；手机上读着累，可考虑在场景切换处拆章。`,
      });
    }

    // 长段：用 indexOf 回位置，split(/\n+/) 吃掉的连续换行不会让跳转点漂移
    let longParas = 0;
    let firstAt: number | undefined;
    let cursor = 0;
    for (const para of text.split(/\n+/)) {
      const idx = text.indexOf(para, cursor);
      const start = idx >= 0 ? idx : cursor;
      const clean = para.trim();
      if (clean.length > LONG_PARA) {
        longParas += 1;
        if (firstAt === undefined) firstAt = start + (para.length - para.trimStart().length);
      }
      cursor = start + para.length;
    }
    if (longParas > 0) {
      out.push({
        kind: '长段',
        chapterId: input.id,
        title,
        level: 'warn',
        at: firstAt,
        detail: `${longParas} 段超过 ${LONG_PARA} 字不分行，手机上是一堵墙。点过去看看，在语气转折处断行。`,
      });
    }

    // 对白占比：字数太少时比值没有意义，不到 500 字不判
    if (chars >= 500) {
      let quoted = 0;
      for (const m of text.matchAll(/[「“][^」”]*[」”]/g)) quoted += m[0].length - 2;
      const ratio = quoted / chars;
      if (ratio < DIALOGUE_LOW) {
        out.push({
          kind: '对白比',
          chapterId: input.id,
          title,
          level: 'info',
          detail: `对白只占 ${(ratio * 100).toFixed(1)}%，几乎全是叙述——确认这是本章刻意为之。`,
        });
      } else if (ratio > DIALOGUE_HIGH) {
        out.push({
          kind: '对白比',
          chapterId: input.id,
          title,
          level: 'info',
          detail: `对白占 ${Math.round(ratio * 100)}%，几乎全是聊天——确认场景和动作没有被对白淹没。`,
        });
      }
    }
  }
  return out;
}

// ---------- 本章诊断：把本地各路体检聚合成一页报告 ----------
// 语义层的判断（钩子留没留、台词像不像本人）不在这里——那是 AI 工坊「钩子体检」「OOC 检查」的事。

export interface DiagInput {
  id: string;
  title: string;
  content: string;
  /** AI 味命中数（本章，deslop 固定词表） */
  deslopCount: number;
  /** 禁用词命中（本章） */
  forbiddenHits: { word: string; count: number; at: number }[];
  /** 敏感词命中（本章范围内，来自投稿体检的词库） */
  sensitiveHits: { word: string; count: number; at: number }[];
  /** 本章埋着还没回收的伏笔数 */
  openForeshadow: number;
  /** 失效标记数（正文改动后找不到锚点，全书口径） */
  orphanedMarks: number;
}

export interface DiagRow {
  key: string;
  label: string;
  n: number;
  detail: string;
  /** 可跳转位置（本章内偏移）；没有就不给 */
  at?: number;
}

/** 只收「有可留意项」的行：全干净就返回空数组，让 UI 说「本章干净」 */
export function chapterDiagnosis(input: DiagInput): DiagRow[] {
  const rows: DiagRow[] = [];
  if (input.deslopCount > 0) {
    rows.push({ key: 'deslop', label: 'AI 味', n: input.deslopCount, detail: '固定套路词表命中；AI 味自检开着时编辑器里有虚线下划线。' });
  }
  if (input.forbiddenHits.length) {
    rows.push({
      key: 'forbidden',
      label: '禁用词',
      n: input.forbiddenHits.reduce((a, x) => a + x.count, 0),
      detail: input.forbiddenHits.map((x) => x.word).slice(0, 6).join('、') + (input.forbiddenHits.length > 6 ? '…' : ''),
      at: input.forbiddenHits[0].at,
    });
  }
  if (input.sensitiveHits.length) {
    rows.push({
      key: 'sensitive',
      label: '敏感词',
      n: input.sensitiveHits.reduce((a, x) => a + x.count, 0),
      detail: input.sensitiveHits.map((x) => x.word).slice(0, 6).join('、') + (input.sensitiveHits.length > 6 ? '…' : '') + '（词库来自「敏感词」页签）',
      at: input.sensitiveHits[0].at,
    });
  }
  if (input.openForeshadow > 0) {
    rows.push({ key: 'foreshadow', label: '伏笔未回收', n: input.openForeshadow, detail: '本章埋着还没回收的伏笔；往下写时记得在合适的章收线。' });
  }
  if (input.orphanedMarks > 0) {
    rows.push({ key: 'orphaned', label: '失效标记', n: input.orphanedMarks, detail: '正文改动后找不到锚点的标记；去素材抽屉里重新锚定或清掉。' });
  }
  // 平台惯例三条（章长/长段/对白比）直接复用预检
  for (const [i, f] of checkSubmission([input]).entries()) {
    rows.push({ key: 'rule' + i, label: f.kind, n: 1, detail: f.detail, at: f.at });
  }
  return rows;
}
