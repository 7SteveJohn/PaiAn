// 「从 Obsidian 导入」这一侧的纯函数断言：批注区剥没剥、属性区剥没剥、预览截断、来源计数。
// 尤其钉住 NOTES_MARK 跟服务端一致——两边标记一旦漂移，批注会被当正文导进灵感库，
// 而那种错不会报错，只会在几周后表现为「灵感库里全是自己写的旁注」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTES_MARK,
  TARGETS,
  appendBeats,
  beatsLine,
  clashNote,
  entityNameOf,
  importedCounts,
  missingTarget,
  prepareForImport,
  targetCtx,
  previewOf,
  PREVIEW_CAP,
} from '../src/obsidian-import';import { NOTES_MARK as SERVER_NOTES_MARK, renderBook } from '../server-lib/obsidian';

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

test('来源计数按路径累计，没有来源的不算', () => {
  const m = importedCounts([{ src: 'a.md' }, { src: 'a.md' }, { src: 'b.md' }, {}, { content: 'x' }]);
  assert.equal(m.get('a.md'), 2);
  assert.equal(m.get('b.md'), 1);
  assert.equal(m.size, 2);
});

// ---------- ④ 导入落点 ----------

test('落点清单：灵感库还是第一个，只有「并入章要点」要选章', () => {
  assert.deepEqual(TARGETS.map((t) => t.key), ['idea', 'world', 'chapter', 'beats']);
  assert.equal(TARGETS.filter((t) => t.needsChapter).length, 1);
  assert.equal(TARGETS[0].key, 'idea');
  assert.equal(new Set(TARGETS.map((t) => t.label)).size, TARGETS.length, '标签撞车，界面上分不出来');
  for (const t of TARGETS) assert.ok(t.hint.length > 8, t.label + ' 没解释清楚');
});

test('实体名取文件名：去 .md、去日期前缀，空路径兜底', () => {
  assert.equal(entityNameOf('素材/码头听来的.md'), '码头听来的');
  assert.equal(entityNameOf('2026-01-01 随手记.md'), '随手记');
  assert.equal(entityNameOf('a/b/名字.MD'), '名字');
  assert.equal(entityNameOf('素材/'), '未命名');
  assert.equal(entityNameOf(''), '未命名');
});

test('并进要点的一条：带来源前缀，换行压成一行，末尾空白清掉', () => {
  assert.equal(beatsLine('码头听来的', '有人在等船。\n\n等了一年。'), '〔库·码头听来的〕有人在等船。 等了一年。');
  assert.equal(beatsLine('x', '一行\n   \n\n\n三行  \n'), '〔库·x〕一行 三行');
  // 整块搬进细纲时不该留下空行——要点是给批量生成看的短行
  assert.ok(!beatsLine('x', '甲\n\n\n\n乙').includes('\n\n'));
});

test('要点追加：空要点不加前导换行，已有内容留一条换行分隔', () => {
  assert.equal(appendBeats('', '第二条'), '第二条');
  assert.equal(appendBeats(undefined, '第一条'), '第一条');
  assert.equal(appendBeats('认船\n', '第二条'), '认船\n第二条');
  assert.equal(appendBeats('认船\n\n\n', '第二条'), '认船\n第二条', '要点末尾的空行不该带进新行');
});

test('targetCtx 与 missingTarget：一份判据，面板与落库共用', () => {
  const single = { id: 'ob2', mode: 'single', chapters: [] as unknown[] };
  const book = { id: 'ob1', mode: 'chapters', chapters: [{ id: 'c1' }, { id: 'c2' }] };
  const empty = { id: 'ob3', mode: 'chapters', chapters: [] as unknown[] };
  // 这句文案冒烟驱动是照着断言的，改字要一并改那边
  assert.equal(missingTarget('chapter', targetCtx(single, '')), '这本是单篇草稿，没有章的结构；导入新章会把它切成按章的书，而界面里没有切回去的入口——原稿会看不见（数据还在）。换一个落点，或到设置/数据里自己处理。');
  assert.equal(missingTarget('chapter', targetCtx(book, '')), '');
  assert.equal(missingTarget('world', targetCtx(single, '')), '', '单篇书建设定卡不该被牵连');
  assert.match(missingTarget('beats', targetCtx(empty, '')), /还没有章/);
  assert.equal(missingTarget('beats', targetCtx(book, 'c2')), '');
  assert.deepEqual(targetCtx(null, ''), { projectId: '', chapterId: '', mode: undefined, chapterCount: 0 });
  assert.equal(missingTarget('idea', targetCtx(undefined, '')), '', '没选书也能进灵感库');
  assert.equal(missingTarget('beats', targetCtx(undefined, '')), '先选一部作品，才知道这张卡/这一章落到哪本书。');
});

test('重名只提醒不拦路', () => {
  assert.match(clashNote('雾钟', ['末法九境', '雾钟']), /已经有一条/);
  assert.match(clashNote('雾钟', [' 雾钟 ']), /已经有一条/, '两边留空格该算同一条');
  assert.equal(clashNote('雾钟', ['末法九境']), '');
  assert.equal(clashNote('雾钟', []), '');
});

test('缺什么就说什么；单篇书导入新章直接挡在门外', () => {
  const ok = { projectId: 'p1', chapterId: '', mode: 'chapters', chapterCount: 3 };
  assert.equal(missingTarget('idea', { projectId: '', chapterId: '' }), '');
  assert.match(missingTarget('world', { projectId: '', chapterId: '' }), /先选一部作品/);
  assert.equal(missingTarget('world', ok), '');
  assert.match(missingTarget('beats', { ...ok, chapterId: '' }), /还要选并进哪一章/);
  assert.equal(missingTarget('beats', { ...ok, chapterId: 'c2' }), '');
  // 一本没有章的书：说「还要选哪一章」等于没说
  assert.match(missingTarget('beats', { projectId: 'p1', chapterId: '', mode: 'chapters', chapterCount: 0 }), /还没有章/);
  // 单篇草稿：导入新章会把界面切不回去，必须禁用而不是提醒
  assert.match(missingTarget('chapter', { projectId: 'p1', chapterId: '', mode: 'single', chapterCount: 0 }), /切不回去|没有切回去的入口/);
  assert.equal(missingTarget('world', { projectId: 'p1', chapterId: '', mode: 'single', chapterCount: 0 }), '', '单篇书建设定卡是可以的，别一起挡掉');
});

test('落点清单：灵感库还是第一个，只有「并入章要点」要选章', () => {
  assert.deepEqual(
    TARGETS.map((t) => t.key),
    ['idea', 'world', 'chapter', 'beats'],
  );
  assert.equal(TARGETS.filter((t) => t.needsChapter).length, 1);
  assert.equal(TARGETS[0].key, 'idea');
  assert.equal(new Set(TARGETS.map((t) => t.label)).size, TARGETS.length, '标签撞车，界面上分不出来');
  for (const t of TARGETS) assert.ok(t.hint.length > 8, t.label + ' 没解释清楚');
});
