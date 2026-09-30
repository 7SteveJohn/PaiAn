// 文件读取层的回归：docx 的 zip 解析是本项目唯一「手写二进制格式」的地方，
// 出错不会抛异常，只会静默读到空内容——所以必须用一个真造出来的 zip 钉住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { decodeEntities, unzipOne, docxToMarkdown, docxToText, htmlToText, readAsSources, relativeName } from '../src/import-file';
import { splitChapters } from '../src/import-text';

// ---------- 造一个最小 zip（只含 deflate 与 stored 两种存储方式） ----------

function makeZip(entries: { name: string; content: string; stored?: boolean }[]): ArrayBuffer {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const raw = enc.encode(e.content);
    const comp = e.stored ? raw : new Uint8Array(deflateRawSync(raw));
    const method = e.stored ? 0 : 8;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, comp.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    locals.push(local, comp);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, comp.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length + comp.length;
  }
  const cdStart = offset;
  const cdSize = centrals.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);

  const out = new Uint8Array(cdStart + cdSize + 22);
  let p = 0;
  for (const b of [...locals, ...centrals, eocd]) {
    out.set(b, p);
    p += b.length;
  }
  return out.buffer;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="w"><w:body>';
const XML_TAIL = '</w:body></w:document>';

function docxWith(body: string): ArrayBuffer {
  return makeZip([{ name: 'word/document.xml', content: XML_HEAD + body + XML_TAIL }, { name: '[Content_Types].xml', content: '<Types/>' }]);
}

// ---------- 实体 ----------

test('decodeEntities：命名实体与数字实体都能还原', () => {
  assert.equal(decodeEntities('a&amp;b&lt;c&gt;d&quot;e&apos;f'), 'a&b<c>d"e\'f');
  assert.equal(decodeEntities('&#65;&#x4e2d;'), 'A中');
  assert.equal(decodeEntities('&nbsp;'), ' ');
  assert.equal(decodeEntities('&unknown;'), '&unknown;');
});

// ---------- zip ----------

test('unzipOne：能取到 deflate 存储的条目', async () => {
  const buf = makeZip([{ name: 'word/document.xml', content: 'hello 中文' }]);
  assert.equal(new TextDecoder().decode(await unzipOne(buf, 'word/document.xml')), 'hello 中文');
});

test('unzipOne：能取到 stored（未压缩）的条目', async () => {
  const buf = makeZip([{ name: 'a.txt', content: 'plain 内容', stored: true }]);
  assert.equal(new TextDecoder().decode(await unzipOne(buf, 'a.txt')), 'plain 内容');
});

test('unzipOne：条目不在包里时给出说得出话的报错', async () => {
  const buf = makeZip([{ name: 'a.txt', content: 'x' }]);
  await assert.rejects(() => unzipOne(buf, 'word/document.xml'), /没有 word\/document\.xml/);
});

test('unzipOne：不是 zip 就直说，不要解出乱码', async () => {
  const notZip = new TextEncoder().encode('这只是一段普通文本').buffer;
  await assert.rejects(() => unzipOne(notZip as ArrayBuffer, 'a'), /不是一个 zip 文件/);
});

// ---------- docx ----------

test('docxToMarkdown：标题样式的段落带 # 前缀，正文原样', () => {
  const xml =
    XML_HEAD +
    '<w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>第1章 落水</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>他站在岸边。</w:t></w:r></w:p>' +
    XML_TAIL;
  assert.equal(docxToMarkdown(xml), '# 第1章 落水\n他站在岸边。');
});

test('docxToMarkdown：中文版「标题 1」与英文版 Heading2 都认', () => {
  const xml =
    XML_HEAD +
    '<w:p><w:pPr><w:pStyle w:val="标题 1"/></w:pPr><w:r><w:t>章一</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>节一</w:t></w:r></w:p>' +
    XML_TAIL;
  assert.equal(docxToMarkdown(xml), '# 章一\n## 节一');
});

test('docxToMarkdown：段内多个 run 的文本要接起来，不能各算一行', () => {
  const xml = XML_HEAD + '<w:p><w:r><w:t>前半</w:t></w:r><w:r><w:t>后半</w:t></w:r></w:p>' + XML_TAIL;
  assert.equal(docxToMarkdown(xml), '前半后半');
});

test('docxToText + splitChapters：整条链路把 Word 稿拆成章', async () => {
  const buf = docxWith(
    '<w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>第1章 落水</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>他站在岸边。</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>第2章 石门</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>门后是黑的。</w:t></w:r></w:p>',
  );
  const r = splitChapters(await docxToText(buf));
  assert.equal(r.marker, 'chapter');
  assert.deepEqual(
    r.chapters.map((c) => c.title),
    ['第1章 落水', '第2章 石门'],
  );
  assert.equal(r.chapters[0].body, '他站在岸边。');
});

test('docxToText + splitChapters：没有标题样式的 docx 整篇一章，不硬拆', async () => {
  const buf = docxWith('<w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p>');
  const r = splitChapters(await docxToText(buf));
  assert.equal(r.marker, 'none');
  assert.equal(r.chapters.length, 1);
  assert.equal(r.chapters[0].body, '第一段\n第二段');
});

// ---------- html ----------

test('htmlToText：script/style/注释整段丢弃，标签剥掉', () => {
  const html = '<html><head><style>p{color:red}</style></head><body><!-- 注释 --><p>正文甲</p><script>alert(1)</script></body></html>';
  assert.equal(htmlToText(html), '正文甲');
});

test('htmlToText：h1~h6 转成 markdown 标题，网页稿也能拆章（含 h1/h2 混用）', () => {
  const html = '<h1>第1章 落水</h1><p>他站在岸边。</p><h2>第2章 石门</h2><p>门后是黑的。</p>';
  const r = splitChapters(htmlToText(html));
  assert.equal(r.marker, 'chapter');
  assert.deepEqual(
    r.chapters.map((c) => c.title),
    ['第1章 落水', '第2章 石门'],
  );
  assert.equal(r.chapters[1].body, '门后是黑的。');
});

test('htmlToText：br 与块级结束标签都成了换行，实体被还原', () => {
  assert.equal(htmlToText('<p>甲</p><p>乙&amp;丙<br>丁</p>'), '甲\n乙&丙\n丁');
});

// ---------- 批量读取 ----------

test('readAsSources：一个文件读失败不拖垮整批', async () => {
  if (typeof File === 'undefined') return; // 老 Node 无 File 全局，跳过
  const ok = new File([new TextEncoder().encode('第1章 甲\n正文')], '第1章.md');
  const bad = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])], '坏的.docx');
  const r = await readAsSources([ok, bad]);
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0].name, '第1章.md');
  assert.equal(r.sources[0].encoding, 'utf-8');
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].name, '坏的.docx');
});

test('readAsSources：GBK 编码的 txt 也能读对', async () => {
  if (typeof File === 'undefined') return;
  // 0xB0A1 = 「啊」的 GB2312 编码，不是合法 UTF-8
  const file = new File([new Uint8Array([0xb0, 0xa1, 0x0a])], '稿子.txt');
  const r = await readAsSources([file]);
  assert.equal(r.sources[0].encoding, 'gb18030');
  assert.equal(r.sources[0].text, '啊\n');
});

test('relativeName：剥掉最外层目录名，只留目录内的相对路径', () => {
  const named = (name: string, rel: string) => Object.assign(new File([], name), { webkitRelativePath: rel });
  assert.equal(relativeName(named('第1章.md', '书稿/第1章.md')), '第1章.md');
  assert.equal(relativeName(named('第1章.md', '书稿/卷一/第1章.md')), '卷一/第1章.md');
  assert.equal(relativeName(named('第1章.md', '')), '第1章.md');
});
