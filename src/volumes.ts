// 按卷分文件导出的纯函数层：切卷 → 拼每卷正文 → 洗文件名。全部本地字符串变换，
// 不碰 DOM、不碰网络、不改稿子。
//
// 为什么单独抽一层：「导出」是最容不得变的功能。同一份稿子今天导出、三个月后投稿时
// 再导出，文件名、卷标题、章号必须一模一样，否则作者手里会躺着两套对不上的文件。
// 拼装规则一旦散在组件里，就会跟着某次界面调整悄悄变形。所以这里只做纯字符串变换，
// Blob / a.click() 那点脏活留给组件；规则能不能站住，由 tests/volumes.test.ts 说话。
//
// 两条不变式（改之前先想清楚）：
// ① 章号恒为全书章号，不在卷内重新计数——卷二第七篇仍然是「第 17 章」。这样任意两个
//    卷文件之间还能按章号接回原地，跨平台投稿时章节序号也不会因为分卷而错位。
// ② 每个卷文件都必须是「整书导出正文」的一段直接切片：把全部卷文件按同样的分隔符
//    顺序拼回来，要能得到整书导出的正文（不含书名那一行）。于是分卷导出不会悄悄
//    引入第二套排版——包括既有导出里那个「章标题后 LF、章与章之间 CRLF」的历史写法，
//    这里是照抄的，不是漏改。
//    这条不变式是硬的，所以卷怎么切、卷标题出不出来，一律以既有整书导出为准：
//      · 切卷用「相邻章节的卷名**原文**不同才另起一卷」——原文比较，不 trim；
//      · 只有卷名是非空字符串才输出卷标题。注意「没填」（undefined/''）才是不输出的那一路；
//        卷名写成 '   ' 是有名字的，整书导出会给它出标题，分卷也必须出。
//    文件名与界面提示是另一套口径（空白剥掉、空名用「未分卷」占位）：那是磁盘上的名字和
//    给人看的那行字，不是正文排版，两边各归各，别混着用。
import type { Chapter, TextMark } from './types';

/** 不填卷名的那一卷在**文件名**与界面提示里叫什么。
 *  只管磁盘上的名字和给人看的那行字：正文排版里空卷名是不出标题的，那是另一套口径，见文件头不变式②。
 *  书名洗空另有兜底名（NO_TITLE_NAME），不借这里的占位名。 */
export const NO_VOLUME_NAME = '未分卷';
/** 不带 title / chapters 字段时的兜底书名 */
const NO_TITLE_NAME = '未命名';

/** Windows 与 macOS 都不收这几个字符；删了要出事，一律替换成下划线 */
const ILLEGAL_CHARS = /[\\/:*?"<>|]/g;
/** 连续空白压成一个空格：卷名里混进换行/制表符时，文件名会变得没法看也没法选 */
const WHITESPACE_RUN = /\s+/g;
/** Windows 资源管理器不吃以空格或点结尾的文件名（它自己会把尾巴剥掉，剥完就可能撞名） */
const TRAILING_DOTS = /[. ]+$/;

/** md 正文里的分隔符 */
const SEP_MD = '\n\n';
/** txt 分章版沿用 Windows 换行，章与章之间 CRLF */
const SEP_TXT = '\r\n\r\n';

export type ExportFormat = 'md' | 'txt';

/** 一卷里的一章：no 是全书章号（1 起），不是卷内序号 */
export interface VolumeChapter {
  no: number;
  chapter: Chapter;
}

/** 相邻「卷名原文」相同的一段：中间被别的卷打断后再次出现同名，算新的一卷。
 *  volume 存的是作者填的原文（没填就是空串），不是洗过的文件名片段 */
export interface VolumeSlice {
  volume: string;
  chapters: VolumeChapter[];
}

/** 一个待写出的文件。name 是完整文件名（含书名前缀与扩展名），组件直接塞给 a.download */
export interface VolumeExportFile {
  name: string;
  text: string;
}

export interface VolumeExportInput {
  title: string;
  /** 章节模式的全部章节；缺省或空数组表示「没有可分的卷」，返回空数组由调用方退化成单文件导出 */
  chapters?: Chapter[];
  /** 彩蛋注释锚点，annotated 为真时才用得上 */
  marks?: TextMark[];
  fmt?: ExportFormat;
  annotated?: boolean;
}

/**
 * 洗成一个文件系统收得下的文件名片段（不含扩展名）。
 * fallback 让调用方自己说了算：卷名洗空退回「未分卷」，书名洗空退回「未命名」——
 * 共用 NO_VOLUME_NAME 会让书名变成「未分卷.md」，看着像丢失了书名。
 */
export function sanitizeFileName(name: string, fallback: string = NO_VOLUME_NAME): string {
  const cleaned = name
    .replace(ILLEGAL_CHARS, '_')
    .replace(WHITESPACE_RUN, ' ')
    .trim()
    .replace(TRAILING_DOTS, '');
  return cleaned || fallback;
}

/** 卷的展示名：界面提示文案（按钮 title 里那串卷名）用。
 *  只管「人眼看的那行字」，不参与任何切卷或排版判据：空卷名在这里显示成 NO_VOLUME_NAME。 */
export function displayVolumeName(volume: string): string {
  return volume.trim() || NO_VOLUME_NAME;
}

/**
 * 切卷用的卷名口径：只把 undefined 归一成空串，**不 trim、不回退占位名**。
 * 因为这一层的判据必须和既有整书导出逐字一致（WritingView.volumeOf），
 * 而那边比的是原文：` 第一卷 ` 与 `第一卷` 在那里算两个卷边界，这里也必须算两个；
 * 回退成「未分卷」还会在正文中多插一块整书导出没有的 `# 未分卷`，直接违反不变式②。
 */
function volumeNameOf(raw: string | undefined): string {
  return raw ?? '';
}

/**
 * 按「相邻同原文名」把章节切成若干卷，保持原顺序。
 * 判据与整书导出插卷标题的判据严格一致（只有与上一章卷名原文不同才另起一卷），
 * 所以把各卷按分隔符拼回去天然能和整书导出的正文逐字对上（不变式②）。
 */
export function splitByVolume(chapters: readonly Chapter[]): VolumeSlice[] {
  const out: VolumeSlice[] = [];
  chapters.forEach((chapter, i) => {
    const volume = volumeNameOf(chapter.volume);
    const last = out[out.length - 1];
    if (last && last.volume === volume) last.chapters.push({ no: i + 1, chapter });
    else out.push({ volume, chapters: [{ no: i + 1, chapter }] });
  });
  return out;
}

// 重名文件追加 (1) (2)：分卷导出是一次连着触发 N 个下载，两个文件同名时浏览器要么给后来者
// 自动加后缀、要么问是否覆盖，作者手里就会剩下两个分不清谁是谁、还丢了卷序的文件。
// 计数不用时间戳也不用随机数——同一份稿子三个月后再导出必须导出同样的文件名。
export function uniqueFileName(stem: string, ext: string, used: Set<string>): string {
  const base = `${stem}.${ext}`;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 1;
  let candidate = `${stem}(${n}).${ext}`;
  while (used.has(candidate)) {
    n++;
    candidate = `${stem}(${n}).${ext}`;
  }
  used.add(candidate);
  return candidate;
}

/** 把该章的彩蛋注释插进副本；从后往前插，前面那些锚点的偏移量才不会被顶歪。正文源始终干净 */
function withEggNotes(content: string, marks: TextMark[], chapterId: string): string {
  const eggs = marks
    .filter((m) => m.type === '彩蛋' && !m.orphaned && m.chapterId === chapterId)
    .sort((a, b) => b.start - a.start);
  let text = content;
  for (const m of eggs) text = text.slice(0, m.end) + `〔彩蛋：${m.note || '无注释'}〕` + text.slice(m.end);
  return text;
}

/**
 * 把一个项目切成一个卷一个文件。
 * 返回 [] 表示「没有可分的卷」（单文档模式、或还没有章节），调用方应当退化成既有的单文件导出，
 * 不要凭空多出一个空文件。
 */
export function buildVolumeFiles(input: VolumeExportInput): VolumeExportFile[] {
  const fmt: ExportFormat = input.fmt ?? 'md';
  const annotated = input.annotated ?? false;
  const isTxt = fmt === 'txt';
  const sep = isTxt ? SEP_TXT : SEP_MD;
  const marks = input.marks ?? [];
  const book = sanitizeFileName(input.title || NO_TITLE_NAME, NO_TITLE_NAME);
  const used = new Set<string>();
  return splitByVolume(input.chapters ?? []).map((slice) => {
    const blocks = slice.chapters.map(({ no, chapter }) => {
      const body = annotated ? withEggNotes(chapter.content, marks, chapter.id) : chapter.content;
      const head = isTxt ? `第${no}章 ${chapter.title}` : `## 第${no}章 ${chapter.title}`;
      return `${head}\n\n${body}`;
    });
    // 卷名为空时一个字都不写——整书导出也是这么做的（WritingView.downloadFull 只在卷名
    // 非空时才插标题）。删掉这个判断，就会给最常见的「开头几章还没填卷名」悄悄多插一块
    // 整书导出里没有的卷标题，两种导出立刻对不上。
    const vol = slice.volume;
    const volHead = vol ? (isTxt ? `${vol}\r\n\r\n` : `# ${vol}\n\n`) : '';
    // 文件名走另一套口径：卷名空的用它占位、非法字符替换掉；
    // 撞名再按出现顺序追加 (1)(2)，保证 N 个卷一定有 N 个不同的文件名，且不掺时间戳
    const stem = `${book}-${sanitizeFileName(vol)}`;
    return { name: uniqueFileName(stem, fmt, used), text: volHead + blocks.join(sep) };
  });
}
