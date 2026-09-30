// DOCX / EPUB 导出的纯函数层。零依赖是硬约束：
// zip 用 CompressionStream(deflate-raw) 现场压，CRC32 自己写表；
// EPUB 的 mimetype 必须是第一个条目且不压缩（STORED），这是规范要求，不是偏好。

export interface ExportChapter {
  title: string;
  body: string;
  /** 所属卷：与上一章不同时插一张卷标题页 */
  volume?: string;
}

export interface ExportBook {
  title: string;
  author?: string;
  chapters: ExportChapter[];
}

// ---------- CRC32 ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- 最小 zip 写入器 ----------

type Bytes = Uint8Array<ArrayBuffer>;
const encoder = new TextEncoder();
/** TextEncoder 的返回类型带着 ArrayBufferLike，过不了 BlobPart/BufferSource 的门：统一收成 ArrayBuffer 背书的 Bytes */
const encode = (text: string): Bytes => encoder.encode(text) as Bytes;

async function deflateRaw(bytes: Bytes): Promise<Bytes> {
  // 已压过的/空的直接原样存，压缩反而更大
  if (bytes.length < 64) return bytes;
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  await writer.write(bytes);
  await writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  const out = new Uint8Array(buf);
  return out.length < bytes.length ? out : bytes;
}

class ZipWriter {
  private parts: BlobPart[] = [];
  private offset = 0;
  private central: BlobPart[] = [];
  private centralSize = 0;
  private count = 0;

  private u16(v: number): Bytes {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    return b;
  }
  private u32(v: number): Bytes {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    return b;
  }
  private push(part: BlobPart, len: number) {
    this.parts.push(part);
    this.offset += len;
  }

  /** method 0 = STORED（mimetype 必须用它且第一个），8 = deflate */
  private async add(name: string, bytes: Bytes, method: 0 | 8) {
    const data = method === 8 ? await deflateRaw(bytes) : bytes;
    const nameBytes = encode(name);
    const crc = crc32(bytes);
    const local = new Blob([this.u32(0x04034b50), this.u16(20), this.u16(0x0800), this.u16(method), this.u16(0), this.u16(0x21), this.u32(crc), this.u32(data.length), this.u32(bytes.length), this.u16(nameBytes.length), this.u16(0), nameBytes, data]);
    const headOffset = this.offset;
    this.push(local, local.size);

    const centralPart = new Blob([
      this.u32(0x02014b50),
      this.u16(20),
      this.u16(20),
      this.u16(0x0800),
      this.u16(method),
      this.u16(0),
      this.u16(0x21),
      this.u32(crc),
      this.u32(data.length),
      this.u32(bytes.length),
      this.u16(nameBytes.length),
      this.u16(0),
      this.u16(0),
      this.u16(0),
      this.u16(0),
      this.u32(0),
      this.u32(headOffset),
      nameBytes,
    ]);
    this.central.push(centralPart);
    this.centralSize += centralPart.size;
    this.count += 1;
  }

  addStored(name: string, text: string) {
    return this.add(name, encode(text), 0);
  }
  addDeflated(name: string, text: string) {
    return this.add(name, encode(text), 8);
  }

  finish(): Blob {
    const eocd = new Blob([this.u32(0x06054b50), this.u16(0), this.u16(0), this.u16(this.count), this.u16(this.count), this.u32(this.centralSize), this.u32(this.offset), this.u16(0)]);
    return new Blob([...this.parts, ...this.central, eocd], { type: 'application/octet-stream' });
  }
}

// ---------- 通用：XML 转义与正文段落 ----------

export function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** 正文按空行切段、每段一个 <w:p>/<xhtml:p>；连续空行不产生堆积的空段 */
export function paragraphs(body: string): string[] {
  const out: string[] = [];
  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    const t = raw.trim();
    if (t) out.push(t);
  }
  return out.length ? out : [''];
}

// ---------- DOCX ----------

const DOCX_CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const DOCX_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const docxHeading = (text: string, big: boolean) =>
  `<w:p><w:r><w:rPr><w:b/><w:sz w:val="${big ? 36 : 30}"/></w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
const docxPara = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
const docxEmpty = () => '<w:p/>';

export function docxDocumentXml(book: ExportBook): string {
  const body: string[] = [docxHeading(book.title, true), docxEmpty()];
  let lastVolume = '';
  for (const c of book.chapters) {
    if (c.volume && c.volume !== lastVolume) {
      body.push(docxHeading(c.volume, false));
      lastVolume = c.volume;
    }
    body.push(docxHeading(c.title || '未命名章节', false));
    for (const p of paragraphs(c.body)) body.push(docxPara(p));
    body.push(docxEmpty());
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr/></w:body></w:document>`;
}

export async function buildDocx(book: ExportBook): Promise<Blob> {
  const zip = new ZipWriter();
  await zip.addDeflated('[Content_Types].xml', DOCX_CT);
  await zip.addDeflated('_rels/.rels', DOCX_RELS);
  await zip.addDeflated('word/document.xml', docxDocumentXml(book));
  return zip.finish();
}

// ---------- EPUB 3 ----------

const EPUB_CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;

const EPUB_CSS = `body{margin:1.2em;line-height:1.8;font-family:serif}h1{font-size:1.5em}h2{font-size:1.2em}p{text-indent:2em;margin:.4em 0}`;

const xhtmlDoc = (title: string, inner: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN"><head><meta charset="utf-8"/><title>${xmlEscape(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${inner}</body></html>`;

const xhtmlPara = (text: string) => `<p>${xmlEscape(text)}</p>`;

export function epubChapterXhtml(title: string, body: string): string {
  return xhtmlDoc(title, `<h2>${xmlEscape(title)}</h2>${paragraphs(body).map(xhtmlPara).join('')}`);
}

export function epubOpf(book: ExportBook, chapterFiles: string[], bookId: string, modified: string): string {
  const items = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="css" href="style.css" media-type="text/css"/>`,
    ...chapterFiles.map((f, i) => `<item id="c${i + 1}" href="${f}" media-type="application/xhtml+xml"/>`),
  ].join('');
  const spine = chapterFiles.map((_, i) => `<itemref idref="c${i + 1}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">urn:uuid:${bookId}</dc:identifier><dc:title>${xmlEscape(book.title)}</dc:title>${book.author ? `<dc:creator>${xmlEscape(book.author)}</dc:creator>` : ''}<dc:language>zh-CN</dc:language><meta property="dcterms:modified">${modified}</meta></metadata><manifest>${items}</manifest><spine>${spine}</spine></package>`;
}

export function epubNav(book: ExportBook): string {
  const lis = book.chapters.map((c, i) => `<li><a href="ch${i + 1}.xhtml">${xmlEscape(c.title || `第${i + 1}章`)}</a></li>`).join('');
  return xhtmlDoc(
    book.title + ' · 目录',
    `<nav epub:type="toc" id="toc"><h1>${xmlEscape(book.title)}</h1><ol>${lis}</ol></nav>`,
  );
}

/** 卷变化时插一张卷标题页，章内容各自成章——与 .md 导出同一套分层 */
export function epubChapters(book: ExportBook): ExportBook {
  const out: ExportChapter[] = [];
  let lastVolume = '';
  for (const c of book.chapters) {
    if (c.volume && c.volume !== lastVolume) {
      out.push({ title: c.volume, body: '', volume: c.volume });
      lastVolume = c.volume;
    }
    out.push({ ...c, volume: c.volume });
  }
  return { ...book, chapters: out.length ? out : [{ title: book.title || '全文', body: '' }] };
}

export async function buildEpub(book: ExportBook): Promise<Blob> {
  const full = epubChapters(book);
  const zip = new ZipWriter();
  zip.addStored('mimetype', 'application/epub+zip');
  await zip.addStored('META-INF/container.xml', EPUB_CONTAINER);
  await zip.addDeflated('OEBPS/style.css', EPUB_CSS);
  const chapterFiles = full.chapters.map((_, i) => `ch${i + 1}.xhtml`);
  for (let i = 0; i < full.chapters.length; i += 1) {
    const c = full.chapters[i];
    await zip.addDeflated(`OEBPS/ch${i + 1}.xhtml`, epubChapterXhtml(c.title, c.body));
  }
  await zip.addDeflated('OEBPS/nav.xhtml', epubNav(full));
  await zip.addDeflated('OEBPS/content.opf', epubOpf(full, chapterFiles, `pai-${crc32(encoder.encode(book.title)).toString(16)}`, new Date().toISOString().replace(/\.\d+Z$/, 'Z')));
  return zip.finish();
}
