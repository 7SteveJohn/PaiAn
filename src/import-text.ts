// 「导入已有内容」的纯函数层：全项目唯一的导入入口（粘贴 / 本地文件 / 文件夹 / Obsidian 库）
// 都走这里解析，桌面版与 Web 版共用同一份。
// 放在组件外面是因为这几条都必须能断言：编码猜错是满屏乱码、拆章猜错是整本书的结构崩，
// 两件事都不能靠肉眼看 —— tests/import.test.ts 钉着它们。

// ---------- ① 编码 ----------

/** 无 BOM 且不是合法 UTF-8 时的退路：中文本地文本的事实标准是 GB18030（GBK 的超集，多认生僻字） */
const FALLBACK_ENCODING = 'gb18030';

export interface Decoded {
  text: string;
  /** 实际用的编码。面板要显示出来——猜错了用户才知道该把文件另存成什么 */
  encoding: string;
  hadBom: boolean;
}

const BOMS: { bytes: number[]; encoding: string }[] = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8' },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le' },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be' },
];

/** 换行统一成 LF：Windows 上的 txt/md 是 CRLF，不统一会带着 \r 一路进 JSON */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * 字节 → 文本。顺序是「BOM 说了算 → UTF-8 严格试 → GB18030 兜底」。
 * UTF-8 用 fatal 严格解码：ASCII 和合法 UTF-8 会通过，失败就说明它大概率是 GBK 的老文本——
 * 这是本地 txt 最常见的坑，放宽.decode 只会得到一个满屏问号的「成功」。
 */
export function decodeBytes(input: ArrayBuffer | Uint8Array): Decoded {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  for (const bom of BOMS) {
    if (bytes.length < bom.bytes.length) continue;
    if (!bom.bytes.every((v, i) => bytes[i] === v)) continue;
    const body = bytes.subarray(bom.bytes.length);
    return { text: normalizeEol(new TextDecoder(bom.encoding).decode(body)), encoding: bom.encoding, hadBom: true };
  }
  try {
    const strict = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text: normalizeEol(strict), encoding: 'utf-8', hadBom: false };
  } catch {
    return { text: normalizeEol(new TextDecoder(FALLBACK_ENCODING).decode(bytes)), encoding: FALLBACK_ENCODING, hadBom: false };
  }
}

// ---------- ② 拆章 ----------

/** 一篇文本的导入形态：大纲（一行一章，冒号后是一句剧情）/ 正文（每章有真正的段落） */
export type ImportShape = 'outline' | 'prose';

/** 命中的拆章标记——面板要告诉用户「按什么拆的」，猜错了他才知道该改哪里 */
export type SplitMarker = 'heading' | 'chapter' | 'english' | 'numbered' | 'rule' | 'none';

export interface ParsedChapter {
  /** 章名，保留原文编号（「第3章 落水」）。按分隔线拆出来的段没有标题，为空串 */
  title: string;
  /** 大纲式：标题行冒号之后的剧情；正文式恒为空 */
  summary: string;
  /** 章块里除标题行以外的内容 */
  body: string;
}

export interface SplitResult {
  chapters: ParsedChapter[];
  shape: ImportShape;
  marker: SplitMarker;
}

const HEADING_RE = /^#{1,6}[ \t]*\S/;
const CHAPTER_RE = /^第\s*[0-9一二三四五六七八九十百千零两]+\s*[章回节]/;
const ENGLISH_RE = /^chapter\s+[0-9ivxlcdm]+/i;
const NUMBERED_RE = /^(?:[0-9]{1,4}|[一二三四五六七八九十百]+)[ \t]*[、.．:：][ \t]*\S/;
const RULE_RE = /^[ \t]*([-*_=])[ \t]*(?:\1[ \t]*){2,}$/;

/**
 * 这一行能当章标题吗？先把 markdown 的 `#` 剥掉再判——
 * 「# 第1章 落水」和纯文本里的「第1章 落水」是同一种章标记，层级在这件事上无关紧要
 * （网页另存的稿子常常 h1 是第一章、h2 是第二章）。
 */
function strongestMarker(line: string): SplitMarker | null {
  const bare = line.replace(/^#{1,6}[ \t]*/, '');
  if (CHAPTER_RE.test(bare)) return 'chapter';
  if (ENGLISH_RE.test(bare)) return 'english';
  if (HEADING_RE.test(line)) return 'heading';
  if (NUMBERED_RE.test(bare)) return 'numbered';
  if (RULE_RE.test(line)) return 'rule';
  return null;
}

/** 纯序号做章标记最容易误判——正文里也满是「1. 」的有序列表，所以只认「不挨着」的那些 */
function looksNumbered(hits: (SplitMarker | null)[]): boolean {
  const at = hits.map((h, i) => (h === 'numbered' ? i : -1)).filter((i) => i >= 0);
  if (at.length < 2) return false;
  return at.every((_, k) => k === 0 || at[k] - at[k - 1] > 1);
}

/** 该按第几级标题拆：取从 # 往下第一个出现 ≥2 次的层级（「# 书名」只有一行时不会被选中） */
function pickHeadingLevel(lines: string[]): number | null {
  const count = [0, 0, 0, 0, 0, 0, 0];
  for (const line of lines) {
    const m = /^(#{1,6})/.exec(line);
    if (m) count[m[1].length] += 1;
  }
  for (let n = 1; n <= 6; n += 1) if (count[n] >= 2) return n;
  return null;
}

function pickMarker(lines: string[], hits: (SplitMarker | null)[]): SplitMarker {
  // 带章号的标记最硬（带不带 # 都算），优先于「按标题层级拆」
  if (hits.includes('chapter')) return 'chapter';
  if (hits.includes('english')) return 'english';
  if (pickHeadingLevel(lines) !== null) return 'heading';
  if (looksNumbered(hits)) return 'numbered';
  if (hits.includes('rule')) return 'rule';
  return 'none';
}

/** 剥掉开头的 YAML 属性区：它是 Obsidian/静态站生态的元数据，不是正文 */
export function stripFrontmatter(text: string): string {
  const m = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/** 标题行按第一个冒号切成「章名 / 剧情」——大纲常写成「第3章 落水：主角被推下河」 */
export function splitTitle(title: string): { title: string; summary: string } {
  const m = /[:：]/.exec(title);
  if (!m) return { title: title.trim(), summary: '' };
  return { title: title.slice(0, m.index).trim(), summary: title.slice(m.index + 1).trim() };
}

/**
 * 大纲还是正文：一半以上的章「除标题外最多一行」且「标题里带冒号」→ 判定为大纲。
 * 判错只影响落点（summary 还是 content），两种都能在面板里手动切，所以阈值不必更严。
 */
export function detectShape(chapters: { title: string; body: string }[]): ImportShape {
  if (chapters.length === 0) return 'prose';
  let thin = 0;
  let colon = 0;
  for (const c of chapters) {
    const n = c.body ? c.body.split('\n').filter((l) => l.trim()).length : 0;
    if (n <= 1) thin += 1;
    if (/[:：]/.test(c.title)) colon += 1;
  }
  return thin * 2 >= chapters.length && colon * 2 >= chapters.length ? 'outline' : 'prose';
}

/**
 * 拆章。marker='none' 时整篇作为一章返回（不瞎猜）——这是「导入自己写的一大段」的兜底，
 * 面板会提示用户「没识别到章标记」。
 */
export function splitChapters(raw: string): SplitResult {
  const text = stripFrontmatter(normalizeEol(raw)).replace(/^\s+|\s+$/g, '');
  if (!text) return { chapters: [], shape: 'prose', marker: 'none' };

  const lines = text.split('\n');
  const hits = lines.map(strongestMarker);
  const marker = pickMarker(lines, hits);
  if (marker === 'none') {
    return { chapters: [{ title: '', summary: '', body: text }], shape: 'prose', marker };
  }

  const level = marker === 'heading' ? (pickHeadingLevel(lines) ?? 1) : 0;
  const headRe = level ? new RegExp('^#{' + level + '}(?!#)') : null;
  const isHit = (i: number) => (headRe ? headRe.test(lines[i]) : hits[i] === marker);

  const blocks: { title: string; lines: string[] }[] = [];
  const preamble: string[] = [];
  let cur: { title: string; lines: string[] } | null = null;
  lines.forEach((line, i) => {
    if (isHit(i)) {
      // 章名统一剥掉 markdown 的 # 前缀：「# 第1章 落水」和「第1章 落水」该得到同一个章名
      cur = { title: line.trim().replace(/^#{1,6}[ \t]*/, '').trim(), lines: [] };
      blocks.push(cur);
    } else if (cur) cur.lines.push(line);
    else preamble.push(line);
  });
  // 第一个章标记之前的内容不丢：按分隔线拆时它自己就是一段，其余情况并进第一章正文之前
  if (preamble.length) {
    if (marker === 'rule') blocks.unshift({ title: '', lines: preamble });
    else if (blocks.length) blocks[0].lines.unshift(...preamble);
  }

  const drafts = blocks.map((b) => ({ title: b.title, body: b.lines.join('\n').trim() }));
  const shape: ImportShape = marker === 'rule' ? 'prose' : detectShape(drafts);
  const chapters: ParsedChapter[] =
    shape === 'outline'
      ? drafts.map((d) => {
          const s = splitTitle(d.title);
          return { title: s.title, summary: s.summary, body: d.body };
        })
      : drafts.map((d) => ({ title: d.title, summary: '', body: d.body }));
  return { chapters, shape, marker };
}

// ---------- ③ 文件与目录 ----------

/** 能读进来当素材的后缀（docx 与 html 走各自的解析，不按纯文本读） */
export const IMPORT_EXTS = ['md', 'markdown', 'txt', 'text', 'docx', 'html', 'htm'] as const;

/** 扫描时不必看的目录：版本控制、Obsidian 元数据、依赖、系统回收站 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.obsidian', '.trash', '$recycle.bin', 'system volume information', '__pycache__']);

export function extOf(name: string): string {
  const m = /\.([^./\\]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

export function isImportable(name: string): boolean {
  return (IMPORT_EXTS as readonly string[]).includes(extOf(name));
}

/** 目录扫描的过滤：隐藏文件、跳过目录、非素材后缀一律不看 */
export function shouldSkipPath(relPath: string): boolean {
  const parts = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0) return true;
  const dirs = parts.slice(0, -1);
  if (dirs.some((d) => d.startsWith('.') || SKIP_DIRS.has(d.toLowerCase()))) return true;
  const name = parts[parts.length - 1];
  if (name.startsWith('.')) return true;
  return !isImportable(name);
}

/** 自然序：让「第2章」排在「第10章」前面（资源管理器式的直觉，而不是字典序） */
const COLLATOR = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

export function naturalCompare(a: string, b: string): number {
  return COLLATOR.compare(a, b);
}

export function sortByNaturalName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => naturalCompare(a.name, b.name));
}
