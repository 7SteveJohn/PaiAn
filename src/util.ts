import type { StatsData } from './types';
import { loreRedlines } from './watchdog';

export function uid(): string {
  return crypto.randomUUID();
}

export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 本地时间戳 "YYYY-MM-DD HH:mm"，用于版本快照展示与按天判断
export function localStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${localDate(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 启用中的写作规则 → 附加到系统提示的文本
export function rulesSuffix(rules?: { name: string; content: string; on: boolean }[] | undefined): string {
  const on = (rules ?? []).filter((r) => r.on && r.content.trim());
  if (on.length === 0) return '';
  return '\n\n【写作规则（必须遵守）】\n' + on.map((r, i) => `${i + 1}. ${r.content.trim()}`).join('\n');
}

function truncate(text: string, n: number): string {
  return text.length <= n ? text : text.slice(0, n) + '…';
}

// 前情分层参数：近场章节数（完整梗概）与中场窗口（单行摘要）
const NEAR_CHAPTERS = 5;
const MID_CHAPTERS = 20;

// 章节梗概：优先作者/AI 写的 summary，其次结构化要点 beats，最后退回正文开头
function chapterGist(c: { summary?: string; beats?: string; content?: string; pending?: string }, n: number): string {
  const s = (c.summary ?? '').trim() || (c.beats ?? '').trim();
  if (s) return truncate(s, n);
  const body = (c.content ?? c.pending ?? '').replace(/\s+/g, ' ').trim();
  return body ? truncate(body, n) : '';
}

// 远场聚合：把 [from, to) 的章节按批合并成若干段，批数封顶 6，
// 保证 20 章和 200 章的前情占用长度基本一致（不会越写越撑爆上下文）
function arcBlock(
  chapters: { title?: string; summary?: string; beats?: string; content?: string; pending?: string }[],
  from: number,
  to: number,
): string {
  const count = to - from;
  if (count <= 0) return '';
  const step = Math.max(5, Math.ceil(count / 6));
  const out: string[] = [];
  for (let s = from; s < to; s += step) {
    const e = Math.min(to, s + step);
    const batch = chapters.slice(s, e);
    // 逐章罗列梗概会被长度限制切碎，反而丢失信息；这里保留完整章标题（可定位），
    // 只补该批开篇一条例概作为语义锚点
    const titles = batch
      .map((c) => c.title)
      .filter(Boolean)
      .join('、');
    if (!titles) continue;
    const lead = chapterGist(batch[0], 40);
    out.push(truncate(`第${s + 1}–${e}章（${titles}）${lead ? '：开篇 ' + lead : ''}`, 200));
  }
  return out.join('\n');
}

// AI 上下文注入：把设定、人物、世界观与前情拼进系统提示，让 AI「认识」这部作品
export function buildAiContext(
  project: {
    notes: string;
    characters?: { name: string; state: string; power?: string; powerLog?: { chapterId?: string; text: string }[]; relations?: { with: string; note: string }[] }[];
    worldItems?: { name: string; kind: string; content: string }[];
    mode?: 'single' | 'chapters';
    chapters?: { id: string; title: string; content: string; summary?: string; beats?: string; cast?: string; places?: string; hooks?: string; pending?: string }[];
    marks?: { type: string; status?: string; text: string; orphaned?: boolean; chapterId?: string }[];
    rollingSummary?: { upTo: number; text: string };
  },
  chapterId?: string | null,
): string {
  const parts: string[] = [];
  if (project.notes.trim()) parts.push('【作品设定与备注】\n' + truncate(project.notes.trim(), 1200));
  // 块序按「多久变一次」排：越稳的越靠前。供应商的前缀缓存只认可整段公共前缀，一旦把按章
  // 重排的【人物】放到这些罕变块前面，它们就全得按未命中重算——批量连写时这是最大的一笔白烧。
  const world = (project.worldItems ?? []).slice(0, 10);
  if (world.length) {
    parts.push('【世界观词条】\n' + world.map((w) => `${w.name}（${w.kind}）：${truncate(w.content, 100)}`).join('\n'));
  }
  const powerLines = powerChangeLines(project.characters ?? [], project.chapters ?? []);
  if (powerLines) parts.push('【战力变更记录（升级线以此为准，不得跳级或倒退）】\n' + powerLines);
  // 守夜人从正文算出的境界地板：卡上没记 powerLog 也能兜住，且这段与章无关，批量连写时公共前缀不断
  const redlines = loreRedlines(project);
  if (redlines) parts.push('【设定红线（正文已写到的境界，续写不得倒退）】\n' + redlines);
  const foreshadows = openForeshadowLines(project.marks);
  if (foreshadows) parts.push('【未回收伏笔（后续章节需要回收或推进）】\n' + foreshadows);
  // 人物优先注入本章出场人物 (cast)，避免注入无关配角浪费 Token
  let chars = project.characters ?? [];
  const curChap = project.chapters?.find((c) => c.id === chapterId);
  if (curChap?.cast) {
    const castNames = curChap.cast.split(/[,，、\s]+/).filter(Boolean);
    const matched = chars.filter((c) => castNames.includes(c.name));
    const rest = chars.filter((c) => !castNames.includes(c.name));
    chars = [...matched, ...rest].slice(0, 8);
  } else {
    chars = chars.slice(0, 8);
  }
  if (chars.length) {
    parts.push(
      '【人物】\n' +
        chars
          .map((c) => {
            const rel = c.relations?.length ? '；关系：' + c.relations.map((r) => `${r.with}(${r.note})`).join('、') : '';
            const pw = c.power ? '；战力：' + c.power : '';
            return `${c.name}（当前状态：${c.state || '未知'}${pw}）${rel}`;
          })
          .join('\n'),
    );
  }
  if (project.mode === 'chapters' && chapterId) {
    const chapters = project.chapters ?? [];
    const idx = chapters.findIndex((c) => c.id === chapterId);
    if (idx >= 0) {
      // 前情分三层：近场给完整梗概、中场给单行摘要、远场按批聚合。
      // 长篇写到上百章时也不会把早期剧情丢光，同时上下文总量保持稳定。
      const nearFrom = Math.max(0, idx - NEAR_CHAPTERS);
      const nearText = chapters
        .slice(nearFrom, idx)
        .map((c, i) => {
          const n = nearFrom + i + 1;
          const brief = chapterBriefLine(c);
          const gist = chapterGist(c, 150);
          const tag = c.content ? '' : '（草稿）';
          return `第${n}章 ${c.title}${tag}${gist ? '：' + gist : '（未写）'}${brief ? '\n' + brief : ''}`;
        })
        .join('\n');
      if (nearText) parts.push(`【前情提要（最近 ${idx - nearFrom} 章）】\n` + nearText);

      const midFrom = Math.max(0, idx - MID_CHAPTERS);
      if (nearFrom > midFrom) {
        const midLines = chapters
          .slice(midFrom, nearFrom)
          .map((c, i) => {
            const g = chapterGist(c, 50);
            return `第${midFrom + i + 1}章 ${c.title}${g ? '：' + g : ''}`;
          })
          .join('\n');
        if (midLines) parts.push('【中段剧情】\n' + midLines);
      }

      // 远场：优先用 AI 归并的全书梗概；没有则按批聚合，批数封顶，总量恒定
      if (midFrom > 0) {
        const rs = project.rollingSummary;
        if (rs?.text.trim() && rs.upTo >= 1) {
          const covered = Math.min(rs.upTo, midFrom);
          const tail = midFrom > covered ? '\n' + arcBlock(chapters, covered, midFrom) : '';
          parts.push(`【全书梗概（第 1–${covered} 章）】\n` + truncate(rs.text.trim(), 900) + tail);
        } else {
          const arc = arcBlock(chapters, 0, midFrom);
          if (arc) parts.push('【早期剧情（按批聚合）】\n' + arc);
        }
      }
      const cur = chapters[idx];
      const brief = chapterBriefLine(cur);
      parts.push(`【当前章节】第${idx + 1}章 ${cur.title}${brief ? '\n' + brief : ''}`);
    }
  }
  return parts.length ? '\n\n' + parts.join('\n\n') : '';
}

// 章节结构化大纲 → 一行速览（上下文与全书大纲速览用）
export function chapterBriefLine(c: { title: string; beats?: string; cast?: string; places?: string; hooks?: string }): string {
  const seg = [
    c.beats ? '要点：' + truncate(c.beats, 120) : '',
    c.cast ? '人物：' + c.cast : '',
    c.places ? '地点：' + c.places : '',
    c.hooks ? '伏笔：' + truncate(c.hooks, 60) : '',
  ].filter(Boolean);
  return seg.length ? '  └ ' + seg.join('；') : '';
}

// 未回收伏笔清单（最多 8 条），无则返回空串
export function openForeshadowLines(marks?: { type: string; status?: string; text: string; orphaned?: boolean }[]): string {
  const open = (marks ?? []).filter((m) => m.type === '伏笔' && m.status !== '回收' && !m.orphaned && m.text.trim()).slice(0, 8);
  if (!open.length) return '';
  return open.map((m, i) => `${i + 1}. ${truncate(m.text.trim(), 60)}`).join('\n');
}

// 战力变更时间线：按章节顺序汇总所有人物的 powerLog，供升级线一致性注入
export function powerChangeLines(
  characters: { name: string; powerLog?: { chapterId?: string; text: string }[] }[],
  chapters: { id: string }[],
): string {
  const rows: { order: number; name: string; text: string }[] = [];
  for (const c of characters) {
    for (const pl of c.powerLog ?? []) {
      const idx = pl.chapterId ? chapters.findIndex((ch) => ch.id === pl.chapterId) : -1;
      rows.push({ order: idx >= 0 ? idx : 9999, name: c.name, text: pl.text });
    }
  }
  if (!rows.length) return '';
  rows.sort((a, b) => a.order - b.order);
  return rows
    .slice(0, 15)
    .map((r) => (r.order < 9999 ? `第${r.order + 1}章 ${r.name}：${truncate(r.text, 50)}` : `${r.name}：${truncate(r.text, 50)}（章节待定）`))
    .join('\n');
}

// 把向导采纳的大纲文本解析成章节列表（第N章 章节名：剧情 → title/summary）
export function parseOutlineToChapters(text: string): { title: string; summary: string }[] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^-{3,}$/.test(l));
  const chapters: { title: string; summary: string }[] = [];
  for (const line of lines) {
    const m = line.match(/^(?:第\s*(\d+|[一二三四五六七八九十百]+)\s*章)?\s*[:：、.]?\s*(.*)$/);
    const body = (m?.[2] || line).trim();
    const sep = body.indexOf('：') >= 0 ? '：' : ':';
    const p = body.indexOf(sep);
    const title = (p > 0 ? body.slice(0, p) : body).replace(/^[-*·\s]+/, '').trim();
    const summary = p > 0 ? body.slice(p + 1).trim() : '';
    chapters.push({ title: title || `第${chapters.length + 1}章`, summary });
  }
  return chapters.slice(0, 30);
}

// 作品全文：章节模式按章拼接，单文档为正文本身
export function buildFullText(project: { draft: string; mode?: 'single' | 'chapters'; chapters?: { title: string; content: string }[] }): string {
  if (project.mode === 'chapters' && project.chapters?.length) {
    return project.chapters.map((c, i) => `【第${i + 1}章 ${c.title}】\n${c.content}`).join('\n\n');
  }
  return project.draft;
}

// 项目总字数：章节模式累加各章正文（draft 在章节模式下是空的，不能直接算）
export function projectWords(project: { draft: string; mode?: 'single' | 'chapters'; chapters?: { content: string }[] }): number {
  if (project.mode === 'chapters' && project.chapters?.length) {
    return project.chapters.reduce((a, c) => a + countWords(c.content), 0);
  }
  return countWords(project.draft);
}

// 首屏数据的最小兜底：stats 在类型上是必有 daily/reflection 的，但线路上挡不住
// 合法 JSON 缺字段（手改的数据文件、老版本的备份）。实测 stats:{} 会让
// HomeView 的 stats.daily[today] 直接 TypeError，整站白屏——所以启动时补齐这一处。
// 只兜证明过会崩的字段，不做全量深校验；normalizeStats 后的值随自动保存写回，落盘即自愈。
export function normalizeStats(s?: Partial<StatsData> | null): StatsData {
  return { daily: s?.daily ?? {}, reflection: s?.reflection ?? '', dailyGoal: s?.dailyGoal };
}

// 中文字符按 1 计，连续的英文/数字串按 1 词计
// 计数实现用「剔除 CJK 后的长度差」，避免 match 为每个汉字建数组——百万字级全文
// 单次约 12ms（match 版约 55ms）。latin 词在正文里数量很少，match 数组开销可忽略。
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/g;
const LATIN_RE = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;
/** ⑤ 自动同步的静默时长：写作页停下这么久才推一次，设置页的文案引用同一个数 */
export const AUTO_SYNC_MS = 12000;

export function countWords(text: string): number {
  return text.length - text.replace(CJK_RE, '').length + (text.match(LATIN_RE) ?? []).length;
}

// ---------- 章节词数增量缓存 ----------
// 长篇 500 章时，每键都重扫全部正文会卡。章节对象在 App 层只替换改动的那个，
// 其余章 content 保持同一字符串引用——据此只对引用变化的章重扫，命中 O(1)。
export interface ChapterWordHit {
  content: string | undefined;
  words: number;
}

// 纯函数：遍历 chapters 生成 id → words 映射；cache 里 content 引用一致的直接复用。
// 返回 miss 数便于测试增量行为。cache 由调用方持有（React 里放 useRef）。
export function chapterWordMap(
  chapters: { id: string; content?: string }[],
  cache?: Map<string, ChapterWordHit>,
): { map: Map<string, number>; cache: Map<string, ChapterWordHit>; misses: number } {
  const c = cache ?? new Map();
  const map = new Map<string, number>();
  let misses = 0;
  for (const ch of chapters) {
    const hit = c.get(ch.id);
    if (hit && hit.content === ch.content) {
      map.set(ch.id, hit.words);
    } else {
      const words = countWords(ch.content ?? '');
      c.set(ch.id, { content: ch.content, words });
      map.set(ch.id, words);
      misses++;
    }
  }
  // 修剪已删除章节的缓存，防止无限增长（阈值宽松：正常不会有大量删除）
  if (c.size > chapters.length * 2 + 64) {
    for (const k of [...c.keys()]) if (!map.has(k)) c.delete(k);
  }
  return { map, cache: c, misses };
}

export function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}
