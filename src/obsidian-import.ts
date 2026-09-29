// 「从 Obsidian 导入」这一侧的纯函数：把「能直接进灵感库的正文」算出来，以及来源路径的账。
// 放在组件外面是因为这几条都必须能断言——尤其是批注区那个标记串，它跟 server-lib/obsidian.js
// 里的必须一字不差，两边不一致就会哪天悄悄把批注当正文导进来（tests/obsidian-import.test.ts 钉着这条）。

/** 我方同步文件里批注区的分隔标记（与 server-lib/obsidian.js 的 NOTES_MARK 同值） */
export const NOTES_MARK = '<!-- wb-notes -->';

/** 预览截断长度：一篇几十章的镜像文件不该整个塞进 <pre> */
export const PREVIEW_CAP = 12000;

/**
 * 导入前整理正文：剥掉 YAML 属性区（Obsidian 生态的通行做法），
 * 再剥掉我方维护的批注区——那是「他在库里写的旁注」，不是素材正文。
 */
export function prepareForImport(text: string): { content: string; droppedFrontmatter: boolean; droppedNotes: boolean } {
  // Obsidian 在 Windows 上按 CRLF 存盘：换行统一成 LF 再进灵感库，
  // 否则 \r 会一路跟着 JSON 存进卡片，之后到处是看不见的差异
  let body = String(text ?? '').replace(/\r\n/g, '\n');
  let droppedFrontmatter = false;
  let droppedNotes = false;
  const fm = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/.exec(body);
  if (fm) {
    body = body.slice(fm[0].length);
    droppedFrontmatter = true;
  }
  const at = body.indexOf(NOTES_MARK);
  if (at >= 0) {
    body = body.slice(0, at);
    droppedNotes = true;
  }
  return { content: body.replace(/\s+$/, '').replace(/^\s+/, ''), droppedFrontmatter, droppedNotes };
}

/** 预览用的截断：明确告诉他截了，导入的是全文 */
export function previewOf(content: string, cap = PREVIEW_CAP): { text: string; truncated: boolean } {
  return content.length <= cap ? { text: content, truncated: false } : { text: content.slice(0, cap), truncated: true };
}

/** 灵感库里每个来源路径导入过几条 */
export function importedCounts(ideas: { src?: string }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of ideas) {
    if (!i.src) continue;
    m.set(i.src, (m.get(i.src) ?? 0) + 1);
  }
  return m;
}

// ---------- ④ 导入落点：不只灵感库，也能直接成为作品里的实体 ----------

export type ImportTarget = 'idea' | 'world' | 'chapter' | 'beats';

/** 顺序即界面顺序：灵感库是原来的唯一去向，摆在第一位不变习惯 */
export const TARGETS: { key: ImportTarget; label: string; hint: string; needsChapter?: boolean }[] = [
  { key: 'idea', label: '灵感库', hint: '进灵感库一条素材，带着库内路径，下次开面板知道这篇导过没有' },
  { key: 'world', label: '设定卡', hint: '在作品里新建一张设定卡：文件名做卡名，正文做卡的内容' },
  { key: 'chapter', label: '新章节', hint: '新建一章，文件名做章名、正文进正文——库里写好的章直接搬进来' },
  { key: 'beats', label: '并入章要点', hint: '把这篇作为一条要点追加到你选的那章的「剧情要点」末尾', needsChapter: true },
];

/** 面板要能选落点，就得知道有哪些作品与章——这里只取用得到的几个字段，别把整部作品塞进组件 */
export interface ImportProjectLite {
  id: string;
  title: string;
  /** 单篇草稿与按章的书能做的事不一样，导入新章只对后者开放 */
  mode?: 'single' | 'chapters';
  chapters: { id: string; title: string }[];
  /** 已有的设定卡名，用来提醒重名 */
  worldNames: string[];
}

export interface ImportPlan {
  target: ImportTarget;
  /** 灵感库以外的落点都要作品 */
  projectId: string;
  chapterId?: string;
  /** 实体名：章名 / 设定卡名 */
  name: string;
  content: string;
  /** 只有灵感库用到 */
  kind?: string;
  src?: string;
}

/** 实体名取文件名去 .md；库里常见「2026-01-01 随手记」这种名字，截一下就行，不猜内容 */
export function entityNameOf(path: string): string {
  const base = String(path ?? '').split('/').pop() ?? '';
  const name = base.replace(/\.md$/i, '').replace(/^\d{4}-\d{2}-\d{2}\s+/, '').trim();
  return name || '未命名';
}

/**
 * 并进「剧情要点」的一条。要点是给批量生成看的短行，所以加来源前缀、并把连续空行压掉——
 * 一篇几十字到几千字的笔记原样糊进细纲，会把要点变成没人读的散文。
 */
/**
 * 并进「剧情要点」的一条。要点是给批量生成看的短行，所以：带来源前缀、
 * 换行（连同两侧空白，含只放着空格的「空行」）一律压成一个空格——
 * 一篇几十字到几千字的笔记原样糊进细纲，会把要点变成没人读的散文。
 */
export function beatsLine(name: string, content: string): string {
  const body = String(content ?? '')
    .replace(/[ \t]*\n+[ \t]*/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  return `〔库·${name}〕${body}`;
}

/** 追加到既有要点末尾（要点为空时不加前导换行） */
export function appendBeats(beats: string | undefined, line: string): string {
  const b = String(beats ?? '').replace(/\s+$/, '');
  return b ? `${b}\n${line}` : line;
}

/** 重名不拦路，只说清楚：他要的就是再建一条时也能自己决定 */
export function clashNote(name: string, existing: string[]): string {
  return existing.some((x) => x.trim() === name) ? `这里已经有一条叫「${name}」了，还是会再建一条。` : '';
}

/** 落点缺什么就用哪句提示，别让他点了才报错 */
/**
 * 落点还缺什么——返回一句说明，空串表示可以下单。
 * 两种情况要挡在门外而不是事后提示：
 *  - 单篇草稿的书没有章的结构，而导入新章会把 mode 切成按章——**界面上没有切回去的入口**，
 *    他那篇 draft 就此看不见（数据还在，但没地方显示）。这种不可逆的事不能顺手做掉。
 *  - 一本书一章都没有时，「并入章要点」的下拉是空的，说「还要选哪一章」等于没说。
 */
/** 从一部作品取出判据要的那几项；面板与落库前都走这里，两边不会各写一套口径 */
export function targetCtx(project: { id?: string; mode?: string; chapters?: unknown[] } | null | undefined, chapterId: string) {
  return { projectId: project?.id ?? '', chapterId, mode: project?.mode, chapterCount: project?.chapters?.length ?? 0 };
}

export function missingTarget(
  target: ImportTarget,
  ctx: { projectId: string; chapterId: string; mode?: string; chapterCount?: number },
): string {
  if (target === 'idea') return '';
  if (!ctx.projectId) return '先选一部作品，才知道这张卡/这一章落到哪本书。';
  const single = ctx.mode === 'single';
  if (target === 'chapter' && single) {
    return '这本是单篇草稿，没有章的结构；导入新章会把它切成按章的书，而界面里没有切回去的入口——原稿会看不见（数据还在）。换一个落点，或到设置/数据里自己处理。';
  }
  if (target === 'beats' && !ctx.chapterCount) return '这本还没有章，没有「要点」可以并进去。';
  if (target === 'beats' && !ctx.chapterId) return '「并入章要点」还要选并进哪一章。';
  return '';
}
