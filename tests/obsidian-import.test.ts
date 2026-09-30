// 导入素材预处理这一侧的纯函数断言：批注区剥没剥、属性区剥没剥、预览截断、来源计数、实体名。
// 尤其钉住 NOTES_MARK 跟服务端一致——两边标记一旦漂移，批注会被当正文导进来，
// 而那种错不会报错，只会在几周后表现为「库里全是自己写的旁注」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTES_MARK, entityNameOf, importedCounts, prepareForImport, previewOf, PREVIEW_CAP } from '../src/obsidian-import';
import { NOTES_MARK as SERVER_NOTES_MARK, renderBook } from '../server-lib/obsidian';

test('导入侧的批注区标记与服务端一字不差', () => {
  assert.equal(NOTES_MARK, SERVER_NOTES_MARK);
});

test('属性区与批注区都剥掉，正文一字不动', () => {
  const text = [
    '---',
    'wb-id: c1',
    'aliases:',
    '  - 老码头',
    'title: "第1章 到港"',
    '---',
    '',
    '林越蹲在第七根缆桩边，船没有来。',
    '',
    '第二段的语气也得不丢。',
    '',
    NOTES_MARK,
    '',
    '> [!note] 这里想加一场雨',
    '',
  ].join('\n');
  const r = prepareForImport(text);
  assert.equal(r.droppedFrontmatter, true);
  assert.equal(r.droppedNotes, true);
  assert.equal(r.content, '林越蹲在第七根缆桩边，船没有来。\n\n第二段的语气也得不丢。');
  assert.ok(!r.content.includes('老码头'), '属性区漏进正文');
  assert.ok(!r.content.includes('想加一场雨'), '批注区漏进正文');
});

test('只有属性区、只有批注区、都没有，三种情况各归各', () => {
  const fmOnly = prepareForImport('---\ntags: [a]\n---\n正文在此\n');
  assert.deepEqual([fmOnly.droppedFrontmatter, fmOnly.droppedNotes, fmOnly.content], [true, false, '正文在此']);

  const notesOnly = prepareForImport('正文在此\n' + NOTES_MARK + '\n旁注\n');
  assert.deepEqual([notesOnly.droppedFrontmatter, notesOnly.droppedNotes, notesOnly.content], [false, true, '正文在此']);

  const plain = prepareForImport('一篇干净的笔记\n');
  assert.deepEqual([plain.droppedFrontmatter, plain.droppedNotes, plain.content], [false, false, '一篇干净的笔记']);
});

test('CRLF 的属性区照样认；正文中间的 --- 不当属性区', () => {
  const crlf = prepareForImport('---\r\nwb-id: x\r\n---\r\n第一段\r\n\r\n---\r\n\r\n第二段\r\n');
  assert.equal(crlf.droppedFrontmatter, true);
  assert.equal(crlf.content, '第一段\n\n---\n\n第二段');
});

test('没闭合的属性区不剥，免得把整篇当头部吃掉', () => {
  const r = prepareForImport('---\nwb-id: x\n\n正文没有闭合线\n');
  assert.equal(r.droppedFrontmatter, false);
  assert.ok(r.content.includes('正文没有闭合线'));
});

test('服务端渲染出来的文件，导入回去就是干净的正文', () => {
  const book = renderBook(
    {
      id: 'p1',
      title: '雾港',
      type: '玄幻',
      status: '写作中',
      chapters: [{ id: 'c1', title: '到港', content: '林越蹲在第七根缆桩边。', volume: '', createdAt: '2026-09-23T10:00:00.000Z', updatedAt: '2026-09-23T10:00:00.000Z' }],
      characters: [],
      worldItems: [],
      marks: [],
    } as never,
    [],
  );
  const text = book.files['雾港/章节/第1章 到港.md'].text;
  const r = prepareForImport(text);
  assert.equal(r.content, '林越蹲在第七根缆桩边。');
  assert.equal(r.droppedNotes, false, '没有批注区时不该谎报剥过');
  // 批注区一旦被作者在库里写过，导入就必须停在标记之前
  const noted = text + '\n' + NOTES_MARK + '\n\n> [!note] 这里想加一场雨\n';
  const r2 = prepareForImport(noted);
  assert.equal(r2.droppedNotes, true);
  assert.equal(r2.content, '林越蹲在第七根缆桩边。');
});

test('预览按长度截断，并说明截了', () => {
  const short = previewOf('不太短'.repeat(10));
  assert.deepEqual([short.truncated, short.text.length], [false, 30]);
  const long = previewOf('字'.repeat(PREVIEW_CAP + 500));
  assert.equal(long.truncated, true);
  assert.equal(long.text.length, PREVIEW_CAP);
});

test('来源计数按来源标识累计，没有标识的不算', () => {
  const m = importedCounts([{ src: 'a.md' }, { src: 'a.md' }, { src: 'b.md' }, {}, { content: 'x' }]);
  assert.equal(m.get('a.md'), 2);
  assert.equal(m.get('b.md'), 1);
  assert.equal(m.size, 2);
});

test('实体名取文件名：剥已知后缀、剥日期前缀、剥目录，空路径兜底', () => {
  assert.equal(entityNameOf('素材/码头听来的.md'), '码头听来的');
  assert.equal(entityNameOf('2026-01-01 随手记.md'), '随手记');
  assert.equal(entityNameOf('a/b/名字.MD'), '名字');
  assert.equal(entityNameOf('素材/'), '未命名');
  assert.equal(entityNameOf(''), '未命名');
  // 导入面板支持的全部后缀都要剥，不能只认 .md
  assert.equal(entityNameOf('卷一/第1章.txt'), '第1章');
  assert.equal(entityNameOf('稿子.docx'), '稿子');
  assert.equal(entityNameOf('网页稿.HTM'), '网页稿');
  // 不认识的扩展名不要乱剥
  assert.equal(entityNameOf('草稿.md.bak'), '草稿.md.bak');
});
