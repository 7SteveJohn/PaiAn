// DOCX / EPUB 导出的钉子：zip 是手写的（无依赖是硬约束），格式错一个字节文件就打不开，
// 所以这里钉的不只是字符串拼装，还有产物 blob 的 zip 结构（PK 头、mimetype 第一且 STORED）。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildDocx,
  buildEpub,
  crc32,
  docxDocumentXml,
  epubChapters,
  epubNav,
  epubOpf,
  epubChapterXhtml,
  paragraphs,
  xmlEscape,
  type ExportBook,
} from '../src/export-doc';

test('crc32：标准测试向量', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('xmlEscape：五个特殊字符全转', () => {
  assert.equal(xmlEscape('a<b>&"\'c'), 'a&lt;b&gt;&amp;&quot;&apos;c');
});

test('paragraphs：按行切段、空行不堆积、全空也有兜底段', () => {
  assert.deepEqual(paragraphs('一段\n\n\n二段'), ['一段', '二段']);
  assert.deepEqual(paragraphs('   \n\n'), ['']);
});

test('docxDocumentXml：书名大标题、卷只在与上一章不同时插一次、正文转义', () => {
  const xml = docxDocumentXml({
    title: '雾<港>',
    chapters: [
      { title: '第1章 到港', body: '林越蹲在缆桩边。', volume: '卷一' },
      { title: '第2章 起雾', body: '', volume: '卷一' },
      { title: '第3章 离岸', body: 'x', volume: '卷二' },
    ],
  });
  assert.ok(xml.includes('<w:t xml:space="preserve">雾&lt;港&gt;</w:t>'), '书名要转义');
  assert.equal(xml.split('>卷一<').length - 1, 1, '同卷连续出现只插一次卷标题');
  assert.ok(xml.includes('>卷二<'));
  assert.ok(xml.includes('林越蹲在缆桩边。'));
  assert.ok(xml.endsWith('<w:sectPr/></w:body></w:document>'));
});

test('epub 三件套：opf 清单/书脊齐全、nav 列全章、章 xhtml 转义正文', () => {
  const book: ExportBook = { title: '晚星', author: '七', chapters: [{ title: '第1章', body: '正文<p>陷阱' }] };
  const opf = epubOpf(book, ['ch1.xhtml'], 'uuid-x', '2026-09-30T00:00:00Z');
  assert.ok(opf.includes('<dc:title>晚星</dc:title>'));
  assert.ok(opf.includes('id="c1"') && opf.includes('<itemref idref="c1"/>'));
  assert.ok(opf.includes('properties="nav"'), 'EPUB3 要有 nav');
  const nav = epubNav(book);
  assert.ok(nav.includes('href="ch1.xhtml">第1章</a>'));
  const xhtml = epubChapterXhtml('第1章', '正文<p>陷阱');
  assert.ok(xhtml.includes('<p>正文&lt;p&gt;陷阱</p>'), '正文里的尖括号要转义');
});

test('epubChapters：卷变化插卷标题页；空书给占位', () => {
  const out = epubChapters({
    title: 'X',
    chapters: [
      { title: 'a', body: 'a', volume: '卷一' },
      { title: 'b', body: 'b', volume: '卷一' },
      { title: 'c', body: 'c', volume: '卷二' },
    ],
  });
  assert.deepEqual(
    out.chapters.map((c) => c.title),
    ['卷一', 'a', 'b', '卷二', 'c'],
  );
  assert.equal(epubChapters({ title: '空', chapters: [] }).chapters.length, 1);
});

// ---------- 产物 blob 的 zip 结构 ----------

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function u16at(b: Uint8Array, off: number) {
  return b[off] | (b[off + 1] << 8);
}
function u32at(b: Uint8Array, off: number) {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

test('buildDocx：合法 zip（PK 头、三个条目、EOCD 数量对上），document.xml 已压缩', async () => {
  const b = await bytesOf(await buildDocx({ title: 'T', chapters: [{ title: 'c1', body: '字' }] }));
  assert.equal(u32at(b, 0), 0x04034b50, '本地文件头 PK\x03\x04');
  const nameLen = u16at(b, 26);
  assert.equal(new TextDecoder().decode(b.subarray(30, 30 + nameLen)), '[Content_Types].xml');
  assert.equal(u16at(b, 8), 8, '正文条目是 deflate');
  // EOCD 在尾部：倒数 22 字节起
  const eocd = b.length - 22;
  assert.equal(u32at(b, eocd), 0x06054b50, 'EOCD 签名');
  assert.equal(u16at(b, eocd + 10), 3, '条目数 = 3');
});

test('buildEpub：mimetype 是第一个条目、STORED 且内容正确（EPUB 规范硬要求）', async () => {
  const b = await bytesOf(
    await buildEpub({
      title: '晚星',
      chapters: [
        { title: 'c1', body: '一'.repeat(200) },
        { title: 'c2', body: '二' },
      ],
    }),
  );
  assert.equal(u32at(b, 0), 0x04034b50);
  assert.equal(u16at(b, 8), 0, 'mimetype 必须 STORED');
  const nameLen = u16at(b, 26);
  const extraLen = u16at(b, 28);
  const name = new TextDecoder().decode(b.subarray(30, 30 + nameLen));
  assert.equal(name, 'mimetype');
  const dataStart = 30 + nameLen + extraLen;
  const size = u32at(b, 18);
  assert.equal(new TextDecoder().decode(b.subarray(dataStart, dataStart + size)), 'application/epub+zip');
  // 收口：EOCD 条目数 = 6（mimetype/container/css/nav/opf/两章 = 7）
  const eocd = b.length - 22;
  assert.equal(u32at(b, eocd), 0x06054b50);
  assert.equal(u16at(b, eocd + 10), 7);
});
