// 「一次导入」的计划层：面板把用户的选择组装成 ImportRequest，App 按它落库。
// 落点判据、书名推断、要点拼接都必须只有一份——面板禁用不够，落库前要再判一次，
// 所以它们在这里，而不是写在组件里（tests/import-plan.test.ts 钉着）。

import { uid } from './util';
import { splitChapters } from './import-text';
import { entityNameOf } from './obsidian-import';
import type { ImportSource } from './import-file';

export type ImportTarget = 'new-book' | 'append' | 'world' | 'beats' | 'outline' | 'idea';

/** 顺序即界面顺序：新建作品是导入自己稿子的主路径，排第一 */
export const TARGETS: { key: ImportTarget; label: string; hint: string }[] = [
  { key: 'new-book', label: '新建作品', hint: '一步成书：书名取自文件名或正文首行，不用先建空作品' },
  { key: 'append', label: '追加到已有作品', hint: '按章的书追加为新章；单篇草稿追加到正文末尾' },
  { key: 'idea', label: '灵感库', hint: '每个来源进灵感库一条素材，带着来源标识，下次知道导过没有' },
  { key: 'world', label: '设定卡', hint: '每个来源在作品里建一张设定卡：文件名做卡名，内容做卡文' },
  { key: 'beats', label: '并入章要点', hint: '把内容压成一条要点，追加到选中那章的「剧情要点」末尾' },
  { key: 'outline', label: '并入大纲', hint: '按章名把各段分发到对应章的「剧情要点」；对不上的并入备注' },
];

/** 只有这一个落点要选章 */
export function needsChapter(target: ImportTarget): boolean {
  return target === 'beats';
}

/** 要落进作品的落点（其余去灵感库） */
export function intoProject(target: ImportTarget): boolean {
  return target === 'append' || target === 'world' || target === 'beats' || target === 'outline';
}

export interface ImportChapter {
  title: string;
  summary: string;
  body: string;
  /** 从标题识别的卷号（卷一/第一卷），空 = 未分卷 */
  volume?: string;
}

/** 一章草稿：面板里可改名/合并/删除，所以要个稳定 id；各自成书时按 from 分组 */
export interface DraftChapter extends ImportChapter {
  /** 预览里标了「转设定」的行：不进章，落库时变成这本书的设定卡（资料区标题的正确去处） */
  asWorld?: boolean;
  id: string;
  from: string;
}

export interface ImportBook {
  title: string;
  src: string;
  chapters: ImportChapter[];
}

export interface ImportRequest {
  target: ImportTarget;
  /** intoProject 的落点必填 */
  projectId?: string;
  chapterId?: string;
  /** 新建作品时的类型（小说/剧本/…） */
  type?: string;
  /** 要落进作品的：各自成书时可以有多本 */
  books: ImportBook[];
  /** 灵感库 / 设定卡：按来源分块，用原文而不是拆章结果 */
  blocks: { name: string; content: string; src: string; asWorld?: boolean }[];
  kind?: string;
}

/** 落库回执：面板要显示这句话，并知道「打开哪一本」 */
export interface ImportOutcome {
  message: string;
  projectId?: string;
  /** 有这张单子才能撤销——没撤销过的落点（比如没有）就不给按钮 */
  undo?: ImportUndo[];
}

/**
 * 撤销这次导入要动的东西：只记 id 与「改之前的原文」，不记内容。
 * 落库那侧照单反着走一遍即可，不必知道当初导的是什么。
 */
export interface ImportUndo {
  kind: 'idea' | 'book' | 'world' | 'chapters' | 'beats' | 'draft' | 'notes';
  /** idea / book / world / chapters：新加条目的 id */
  ids?: string[];
  projectId?: string;
  /** notes：改之前的作品备注全文 */
  notes?: string;
  chapterId?: string;
  /** beats：改之前的要点全文 */
  beats?: string;
  /** draft：改之前的正文全文 */
  draft?: string;
}

/** 撤销要碰的最小结构——只认用得到的字段，免得把整部作品的类型拖进来 */
export interface UndoProject {
  id: string;
  deletedAt?: string;
  draft?: string;
  notes?: string;
  chapters?: { id: string; beats?: string }[];
  worldItems?: { id: string }[];
}

export interface UndoData {
  projects: UndoProject[];
  ideas: { id: string }[];
}

/**
 * 照撤销单反着走一遍：新加的按 id 撤掉，改过的写回旧值。
 * 认不出的 id 一律忽略——那一条可能刚被别处删了，撤销不该因此报错。
 * 新建的书进回收站而不是硬删：撤销本身也得是可反悔的。
 */
export function undoImport<T extends UndoData>(data: T, list: ImportUndo[], now: string): T {
  const idsOf = (kind: ImportUndo['kind']) => new Set(list.filter((u) => u.kind === kind).flatMap((u) => u.ids ?? []));
  const deadIdeas = idsOf('idea');
  const deadBooks = idsOf('book');
  const deadWorld = idsOf('world');
  const deadChapters = idsOf('chapters');

  let projects: UndoProject[] = data.projects;
  for (const p of data.projects) {
    const beat = list.find((u) => u.kind === 'beats' && u.projectId === p.id);
    const draft = list.find((u) => u.kind === 'draft' && u.projectId === p.id);
    const notes = list.find((u) => u.kind === 'notes' && u.projectId === p.id);
    if (!deadBooks.has(p.id) && !deadWorld.size && !deadChapters.size && !beat && !draft && !notes) continue;
    let next: UndoProject = p;
    if (deadBooks.has(p.id)) next = { ...next, deletedAt: now };
    if (deadWorld.size && next.worldItems) next = { ...next, worldItems: next.worldItems.filter((w) => !deadWorld.has(w.id)) };
    if (deadChapters.size && next.chapters) next = { ...next, chapters: next.chapters.filter((c) => !deadChapters.has(c.id)) };
    if (beat && next.chapters) next = { ...next, chapters: next.chapters.map((c) => (c.id === beat.chapterId ? { ...c, beats: beat.beats ?? '' } : c)) };
    if (draft) next = { ...next, draft: draft.draft ?? '' };
    if (notes) next = { ...next, notes: notes.notes ?? '' };
    projects = projects.map((x) => (x.id === p.id ? next : x));
  }

  // 这个函数的入参是「调用方自己的数据类型」，内部只按最小结构改；唯一一处收口转换
  return { ...data, projects, ideas: data.ideas.filter((i) => !deadIdeas.has(i.id)) } as T;
}

// ---------- 组装 ----------

/** 正文首行（跳过空行与标题前缀）——给粘贴的内容起书名用 */
export function firstLineOf(text: string): string {
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim().replace(/^#{1,6}[ \t]*/, '').trim();
    if (t) return t;
  }
  return '';
}

/** 书目：文件名去后缀（去日期前缀交给 entityNameOf）；没有文件名就用正文首行 */
export function bookTitleOf(sourceName: string, firstLine: string): string {
  const fromName = entityNameOf(sourceName);
  if (fromName && fromName !== '未命名') return fromName;
  return firstLine.trim().slice(0, 30) || '未命名作品';
}

/**
 * 结构单元标记：这类前缀出现 ≥2 个时，说明这份稿子的「章」是有固定结构的——
 * 同层里不像结构单元的标题（核心设定 / 执行铁律 / …总览这类资料区）就不该混进章里。
 * 只认章节体例词，不认内容关键词：猜内容必误伤。
 */
const UNIT_RE = /^(?:第\s*[0-9零一二三四五六七八九十百千两]+\s*[章回节]|卷\s*[0-9零一二三四五六七八九十百千两]+|chapter\s+[0-9ivxlcdm]+|序章|序幕|楔子|正文|番外|终章|尾声|后记|结局)/i;

/**
 * 自动把「非结构单元」的标题标成转设定。预览里看得见、点「设」随时改回：
 * 机器只负责把最可能的分类摆好，作者保留最终决定权。
 * 少于 2 个结构单元就不动手——只有一个卷/章标记时，剩下的标题很可能都是正经章。
 */
export function markNonUnits<T extends { title: string; asWorld?: boolean }>(chapters: T[]): T[] {
  const isUnit = (c: T) => UNIT_RE.test(c.title.trim());
  const units = chapters.filter(isUnit).length;
  if (units < 2 || units === chapters.length) return chapters;
  return chapters.map((c) => (isUnit(c) ? c : { ...c, asWorld: true }));
}

/** 把多个来源拆成扁平的章节草稿——各自成书时靠 from 分组分回各本书 */
export function draftChapters(sources: { path: string; text: string }[]): DraftChapter[] {
  const out: DraftChapter[] = [];
  for (const source of sources) {
    splitChapters(source.text).chapters.forEach((c) => {
      out.push({ id: uid(), from: source.path, title: c.title, summary: c.summary, body: c.body, volume: volumeOf(c.title) });
    });
  }
  return markNonUnits(out);
}

export interface BuildOptions {
  target: ImportTarget;
  sources: ImportSource[];
  /** 用户编辑过的章节草稿 */
  chapters: DraftChapter[];
  /** 多来源且新建作品时：合成一本 / 各自成书 */
  mode: 'merge' | 'separate';
  title: string;
  type: string;
  projectId: string;
  chapterId: string;
  kind: string;
}

const strip = (c: DraftChapter): ImportChapter => ({ title: c.title, summary: c.summary, body: c.body });

export function buildRequest(opts: BuildOptions): ImportRequest {
  const alive = opts.chapters.filter((c) => c.title.trim() || c.body.trim());
  // 标了「转设定」的行不进章：资料区标题（核心设定/执行铁律/…总览）的正确去处是设定卡。
  // 只在落进作品的两个章落点生效——设定卡/灵感库/要点本来就不是按章走的。
  const toCards = opts.target === 'new-book' || opts.target === 'append' ? alive.filter((c) => c.asWorld) : [];
  const chapterRows = alive.filter((c) => !c.asWorld);
  const blocks = opts.sources.map((s) => ({
    // 卡名/条目名：用户填了就用他填的，否则取文件名（设定卡落点靠这一项命名）
    name: opts.title.trim() || entityNameOf(s.name) || entityNameOf(s.path) || '未命名',
    content: s.text.trim(),
    src: s.path,
  }));
  const req: ImportRequest = {
    target: opts.target,
    projectId: opts.projectId || undefined,
    chapterId: opts.chapterId || undefined,
    type: opts.type,
    books: [],
    blocks,
    kind: opts.kind,
  };

  if (toCards.length) {
    req.blocks = [
      ...req.blocks,
      ...toCards.map((c) => ({ name: c.title.trim() || '未命名资料', content: c.body.trim(), src: c.from, asWorld: true as const })),
    ];
  }

  if (opts.target !== 'new-book') {
    req.books = [{ title: '', src: opts.sources[0]?.path ?? '', chapters: chapterRows.map(strip) }];
    return req;
  }

  if (opts.mode === 'separate' && opts.sources.length > 1) {
    req.books = opts.sources
      .map((s) => ({
        title: bookTitleOf(s.name, firstLineOf(s.text)),
        src: s.path,
        chapters: chapterRows.filter((c) => c.from === s.path).map(strip),
      }))
      .filter((b) => b.chapters.length > 0);
    return req;
  }

  const head = opts.sources[0];
  req.books = [
    {
      title: opts.title.trim() || bookTitleOf(head?.name ?? '', firstLineOf(head?.text ?? '')),
      src: head?.path ?? '',
      chapters: chapterRows.map(strip),
    },
  ];
  return req;
}

// ---------- 落点判据 ----------

/** 面板要能选落点，就得知道有哪些作品与章——只取用得到的几个字段，别把整部作品塞进组件 */
export interface ImportProjectLite {
  id: string;
  title: string;
  /** 单篇草稿与按章的书，追加时的行为不一样 */
  mode?: string;
  chapters: { id: string; title: string }[];
  /** 已有的设定卡名，用来提醒重名 */
  worldNames: string[];
}

/** 重名不拦路，只说清楚：他要的就是再建一条时也能自己决定 */
export function clashNote(name: string, existing: string[]): string {
  return existing.some((x) => x.trim() === name) ? `这里已经有一条叫「${name}」了，还是会再建一条。` : '';
}

export interface GapContext {
  target: ImportTarget;
  projectId: string;
  chapterId: string;
  /** 目标作品；未选中时给 null */
  project?: { mode?: string; chapters?: unknown[] } | null;
  /** 可落的内容有多少（新建作品要求至少一章） */
  chapterCount: number;
}

/**
 * 落点还缺什么——返回一句说明，空串表示可以下单。
 * 面板把它显示出来并禁用按钮，落库前 App 再问一次，两边同一份口径。
 */
export function gapOf(ctx: GapContext): string {
  // 这两个落点不碰已有作品：只要有内容就能下单
  if (ctx.target === 'new-book' || ctx.target === 'idea') {
    return ctx.chapterCount > 0 ? '' : '还没有可导入的内容：先粘贴文本或选文件。';
  }
  if (!ctx.projectId) return '先选一部作品，才知道这些内容落到哪本书。';
  if (!ctx.project) return '那本书找不到了（可能刚被删掉）。';
  if (ctx.target === 'beats') {
    if (!ctx.project.chapters?.length) return '这本还没有章，没有「剧情要点」可以并进去。';
    if (!ctx.chapterId) return '「并入章要点」还要选并进哪一章。';
  }
  if (ctx.target === 'outline' && !ctx.project.chapters?.length) {
    return '这本还没有章，大纲没有可以分发的对象（先建章，或改用「并入章要点」）。';
  }
  return '';
}

/** 单篇草稿追加时要说清楚：内容会拼成一段正文接在后面，不是变成按章的书 */
export function appendNote(mode: string | undefined, chapterCount: number): string {
  if (mode !== 'single' || chapterCount < 1) return '';
  return '这是一本单篇草稿的作品：内容会拼成一段正文，接在现有正文末尾（不会改成按章的书）。';
}

// ---------- 要点 ----------

/**
 * 并进「剧情要点」的一条：带来源前缀、换行一律压成空格。
 * 要点是给批量生成看的短行，一篇几千字的笔记原样糊进细纲，会把要点变成没人读的散文。
 */
export function beatsLine(name: string, content: string): string {
  const body = String(content ?? '')
    .replace(/[ \t]*\n+[ \t]*/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  return `〔导入·${name}〕${body}`;
}

/** 追加到既有要点末尾（要点为空时不加前导换行） */
export function appendBeats(beats: string | undefined, line: string): string {
  const b = String(beats ?? '').replace(/\s+$/, '');
  return b ? `${b}\n${line}` : line;
}

// ---------- 大纲分发 ----------

/** 归一化章名：剥空白/卷章序号/书名号，让「卷三《省城的第一场雪》」和「第三章 省城的第一场雪」能对上 */
/** 从标题识别卷号：「卷一《…》」「第一卷 …」→「卷一」/「第一卷」；无卷号返回空串 */
export function volumeOf(t: string): string {
  const m = /^(?:第?[0-9零一二三四五六七八九十百千两]+卷|卷[0-9零一二三四五六七八九十百千两]+)/.exec(String(t ?? '').trim());
  return m ? m[0] : '';
}

export function normTitle(t: string): string {
  return t
    .replace(/[\s《》「」]/g, '')
    .replace(/^(?:第[0-9零一二三四五六七八九十百千两]+[章回节]|卷[0-9零一二三四五六七八九十百千两]+)/, '');
}

export interface OutlineRow {
  title: string;
  body: string;
}

export interface OutlineMatch {
  chapterId: string;
  chapterTitle: string;
  body: string;
}

/**
 * 大纲行 → 现有章 的标题匹配：归一化后互相包含即命中（行名含章名或章名含行名，短边 ≥2 字）。
 * 一行命中多章取第一个；多行命中同章取第一行——宁缺毋滥，剩下的走备注。
 */
export function matchOutlineRows(chapters: { id: string; title: string }[], rows: OutlineRow[]): { matched: OutlineMatch[]; unmatched: OutlineRow[] } {
  const norm = (t: string) => normTitle(t);
  const used = new Set<string>();
  const matched: OutlineMatch[] = [];
  const unmatched: OutlineRow[] = [];
  for (const row of rows) {
    const rt = norm(row.title);
    if (rt.length < 2) {
      unmatched.push(row);
      continue;
    }
    const hit = chapters.find((c) => {
      if (used.has(c.id)) return false;
      const ct = norm(c.title);
      return ct.length >= 2 && (ct.includes(rt) || rt.includes(ct));
    });
    if (hit) {
      used.add(hit.id);
      matched.push({ chapterId: hit.id, chapterTitle: hit.title, body: row.body });
    } else {
      unmatched.push(row);
    }
  }
  return { matched, unmatched };
}
/**
 * 大纲文件 → 本书新章 + 备注追加（大纲视图「导入大纲文件」的纯函数核心）。
 * 章行（非转设定）→ 新章（title 章、beats = 段落全文）；资料区行 → 备注里一个块。
 */
export interface OutlineChapterDraft {
  title: string;
  beats: string;
  summary: string;
  volume: string;
}

export function outlineFileToChapters(
  rows: { title: string; body: string; asWorld?: boolean }[],
  notes: string,
): { chapters: OutlineChapterDraft[]; notes: string } {
  const chapterRows = rows.filter((r) => !r.asWorld && r.body.trim());
  const infoRows = rows.filter((r) => r.asWorld && (r.title.trim() || r.body.trim()));
  const chapters = chapterRows.map((r) => ({
    title: r.title.trim() || '未命名章',
    beats: r.body.trim(),
    summary: '',
    volume: volumeOf(r.title),
  }));
  let nextNotes = notes;
  if (infoRows.length) {
    const block = infoRows.map((r) => `【${r.title.trim() || '资料'}】\n${r.body.trim()}`).join('\n\n');
    nextNotes = (notes ? notes.replace(/\s+$/, '') + '\n\n' : '') + '【导入的大纲资料】\n' + block;
  }
  return { chapters, notes: nextNotes };
}
