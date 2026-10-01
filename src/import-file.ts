// 「把用户选中的东西变成文本」这一层：本地文件、拖拽、docx、html。
// 全部走浏览器自带的 API（File.arrayBuffer / DecompressionStream），零新增运行时依赖；
// 文件不出本机，桌面版与 Web 版共用同一份代码。
//
// docx 不引第三方库：它就是个 zip，取 word/document.xml 解压后把「标题样式的段落」转成
// markdown 标题，再交给 import-text.ts 的 splitChapters 统一拆章——解析规则只有一套。

import { decodeBytes, extOf, isImportable, normalizeEol, shouldSkipPath, type Decoded } from './import-text';

// ---------- 实体 ----------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  ldquo: '“',
  rdquo: '”',
};

/** 数字实体（&#123; / &#x1F600;）与常见命名实体 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// ---------- ① zip（只为 docx 服务） ----------

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;

/** 中央目录的结束标记在文件末尾（可能带注释），从后往前找 */
function findEndOfCentralDirectory(view: DataView): number {
  const earliest = Math.max(0, view.byteLength - 22 - 65535);
  for (let i = view.byteLength - 22; i >= earliest; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('当前环境不支持解压（需要较新的浏览器内核）');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 从 zip 里取出一个条目的原始字节。
 * 只认 stored(0) 与 deflate(8) 两种存储方式——docx 只会用这两种。
 */
export async function unzipOne(buf: ArrayBuffer, want: string): Promise<Uint8Array> {
  const view = new DataView(buf);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new Error('这不是一个 zip 文件（找不到中央目录）');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const bytes = new Uint8Array(buf);
  const decoder = new TextDecoder('utf-8');
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(p, true) !== CENTRAL_SIG) throw new Error('zip 中央目录损坏');
    const method = view.getUint16(p + 10, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localAt = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (name === want) {
      // 本地头长度不固定（文件名与扩展区长度都可能与中央目录不同），得重新读一遍
      const dataAt = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
      const size = view.getUint32(p + 20, true);
      const raw = bytes.subarray(dataAt, dataAt + size);
      if (method === 0) return raw;
      if (method === 8) return inflateRaw(raw);
      throw new Error(`docx 用了不支持的压缩方式（${method}）`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip 里没有 ${want}`);
}

// ---------- ② docx ----------

/** Word 的标题样式名：英文版 Heading1、中文版「标题 1」、以及本地化 styleId 直接叫 "1" */
function headingLevelOf(paragraph: string): number {
  const m = /<w:pStyle(?:\s[^>]*)?w:val="([^"]+)"/.exec(paragraph);
  if (!m) return 0;
  const val = m[1].trim();
  const named = /^(?:heading|标题)[ _-]?([1-9])$/i.exec(val);
  if (named) return Number(named[1]);
  return /^[1-9]$/.test(val) ? Number(val) : 0;
}

function paragraphText(paragraph: string): string {
  let out = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(paragraph)) !== null) out += m[1];
  return decodeEntities(out).trim();
}

/**
 * docx 的 document.xml → 近似 markdown：标题样式的段落带 `#` 前缀，正文原样。
 * 之所以不自己拆章，是为了让 docx 与纯文本走同一套拆章规则（含「取最高级标题」那套判据）。
 */
export function docxToMarkdown(xml: string): string {
  const paragraphs = xml.split(/<w:p(?:\s[^>]*)?>/).slice(1);
  const lines: string[] = [];
  for (const para of paragraphs) {
    const text = paragraphText(para);
    const level = headingLevelOf(para);
    if (!text) {
      lines.push('');
      continue;
    }
    lines.push(level ? '#'.repeat(level) + ' ' + text : text);
  }
  return lines.join('\n');
}

/** 读取 .docx 的字节，产出可直接交给 splitChapters 的文本 */
export async function docxToText(buf: ArrayBuffer): Promise<string> {
  const xml = await unzipOne(buf, 'word/document.xml');
  return docxToMarkdown(new TextDecoder('utf-8').decode(xml));
}

// ---------- ③ html ----------

/**
 * HTML → 文本。h1~h6 转成 markdown 标题（这样网页另存的稿子也能自动拆章），
 * 块级标签转换行，script/style/注释整段丢弃。
 */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_all, level: string, inner: string) => {
      const text = inner.replace(/<[^>]*>/g, '').trim();
      return text ? `\n${'#'.repeat(Number(level))} ${text}\n` : '\n';
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|li|tr|blockquote|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return normalizeEol(decodeEntities(stripped))
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- ④ 统一入口 ----------

/** 一份待导入的素材：来源名、来源标识（做重复导入记账）、文本、用到的编码 */
export interface ImportSource {
  /** 展示名与默认作品名：取自文件名 */
  name: string;
  /** 来源标识。浏览器拿不到真实路径，所以是文件名；粘贴则固定为「粘贴的内容」 */
  path: string;
  text: string;
  /** 'docx' 表示已按 Word 结构解析过，其余是实际解码用的编码 */
  encoding: string;
}

export async function readAsSource(file: File): Promise<ImportSource> {
  const buf = await file.arrayBuffer();
  const ext = extOf(file.name);
  if (ext === 'docx') return { name: file.name, path: file.name, text: await docxToText(buf), encoding: 'docx' };
  const decoded: Decoded = decodeBytes(buf);
  const text = ext === 'html' || ext === 'htm' ? htmlToText(decoded.text) : decoded.text;
  return { name: file.name, path: file.name, text, encoding: decoded.encoding };
}

export interface ReadBatch {
  sources: ImportSource[];
  failed: { name: string; error: string }[];
}

/**
 * 批量读。单个文件读失败不能拖垮整批——写作现场最烦的就是「因为一张图导入失败，
 * 二十章白选了」，所以失败的单独收集，成功照常返回。
 */
export async function readAsSources(files: File[]): Promise<ReadBatch> {
  const sources: ImportSource[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const file of files) {
    try {
      sources.push(await readAsSource(file));
    } catch (e) {
      failed.push({ name: file.name, error: (e as Error).message });
    }
  }
  return { sources, failed };
}

// ---------- ⑤ 拖拽 ----------

function fileFromEntry(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => entry.file(resolve, () => resolve(null)));
}

async function collectEntry(entry: FileSystemEntry, out: File[], relDir: string): Promise<void> {
  if (entry.isFile) {
    const file = await fileFromEntry(entry as FileSystemFileEntry);
    if (file && isImportable(file.name) && !shouldSkipPath(`${relDir}/${file.name}`)) out.push(file);
    return;
  }
  if (!entry.isDirectory) return;
  const dir = entry as FileSystemDirectoryEntry;
  const reader = dir.createReader();
  // readEntries 一次最多给 100 条，必须循环读到空——只读一次会静默漏掉大半目录
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
    if (batch.length === 0) return;
    for (const child of batch) await collectEntry(child, out, `${relDir}/${entry.name}`);
  }
}

/** 从拖拽事件里取出可导入的文件（含文件夹递归），顺序按自然序排好 */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const items = Array.from(dt.items ?? []);
  const entries = items.map((it) => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null));
  const out: File[] = [];
  if (entries.some(Boolean)) {
    for (const entry of entries) if (entry) await collectEntry(entry, out, entry.name);
  } else {
    for (const file of Array.from(dt.files ?? [])) {
      if (isImportable(file.name) && !shouldSkipPath(file.name)) out.push(file);
    }
  }
  return out;
}

/** 从目录选择框（webkitdirectory）拿到的文件路径里剥掉最外层目录名，用来过滤与展示 */
export function relativeName(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return rel && rel.includes('/') ? rel.slice(rel.indexOf('/') + 1) : file.name;
}
