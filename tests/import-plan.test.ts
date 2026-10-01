// 导入计划层的断言：落点判据、书名推断、拆章草稿、请求组装。
// 判据是「面板禁用」与「落库前复核」共用的同一份，改文案就要两边一起想清楚。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TARGETS,
  appendBeats,
  appendNote,
  beatsLine,
  bookTitleOf,
  buildRequest,
  normTitle,
  outlineFileToChapters,
  volumeOf,
  matchOutlineRows,
  markNonUnits,
  clashNote,
  draftChapters,
  firstLineOf,
  gapOf,
  intoProject,
  needsChapter,
  undoImport,
} from '../src/import-plan';
import type { ImportSource } from '../src/import-file';

const src = (path: string, text: string): ImportSource => ({ name: path, path, text, encoding: 'utf-8' });

const base = {
  target: 'new-book' as const,
  chapters: [] as ReturnType<typeof draftChapters>,
  mode: 'merge' as const,
  title: '',
  type: '小说',
  projectId: '',
  chapterId: '',
  kind: '素材',
};

// ---------- 落点清单 ----------

test('落点清单：新建作品排第一，只有「并入章要点」要选章', () => {
  assert.deepEqual(TARGETS.map((t) => t.key), ['new-book', 'append', 'idea', 'world', 'beats', 'outline']);
  assert.equal(TARGETS.filter((t) => needsChapter(t.key)).length, 1);
  assert.equal(needsChapter('beats'), true);
  assert.equal(needsChapter('world'), false);
  assert.equal(new Set(TARGETS.map((t) => t.label)).size, TARGETS.length, '标签撞车，界面上分不出来');
  for (const t of TARGETS) assert.ok(t.hint.length > 8, t.label + ' 没解释清楚');
  // 需要选作品的落点：追加 / 设定卡 / 并要点；灵感库与新建作品都不需要
  assert.deepEqual(TARGETS.filter((t) => intoProject(t.key)).map((t) => t.key), ['append', 'world', 'beats', 'outline']);
});

// ---------- 名字 ----------

test('firstLineOf：跳过空行与 # 标题前缀', () => {
  assert.equal(firstLineOf('\n\n# 码头长生路\n正文'), '码头长生路');
  assert.equal(firstLineOf('直接就是第一行'), '直接就是第一行');
  assert.equal(firstLineOf('   \n\n'), '');
});

test('bookTitleOf：文件名优先，没名字就用正文首行，都没有给兜底', () => {
  assert.equal(bookTitleOf('码头长生路.md', '正文首行'), '码头长生路');
  assert.equal(bookTitleOf('', '第1章 落水'), '第1章 落水');
  assert.equal(bookTitleOf('', ''), '未命名作品');
  assert.equal(bookTitleOf('', '很长的一行'.repeat(20)).length, 30, '首行做书名要截断，不能整段塞进去');
});

// ---------- 拆章草稿 ----------

test('draftChapters：多个来源各自拆章，靠 from 记住出身', () => {
  const list = draftChapters([src('a.md', '第1章 甲\n正文甲\n第2章 乙\n正文乙'), src('b.md', '第1章 丙\n正文丙')]);
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((c) => c.from), ['a.md', 'a.md', 'b.md']);
  assert.deepEqual(list.map((c) => c.title), ['第1章 甲', '第2章 乙', '第1章 丙']);
  assert.equal(new Set(list.map((c) => c.id)).size, 3, 'id 必须唯一，否则改名会改错行');
});

test('draftChapters：没标记的整篇一段也算一章', () => {
  const list = draftChapters([src('a.md', '就是一整段随笔，没有章标记。')]);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, '');
  assert.equal(list[0].body, '就是一整段随笔，没有章标记。');
});

// ---------- 组装 ----------

test('buildRequest：新建作品合成一本时，书名取来源名', () => {
  const sources = [src('码头长生路.md', '第1章 落水\n正文甲')];
  const req = buildRequest({ ...base, sources, chapters: draftChapters(sources) });
  assert.equal(req.books.length, 1);
  assert.equal(req.books[0].title, '码头长生路');
  assert.equal(req.books[0].chapters.length, 1);
  assert.equal(req.books[0].chapters[0].title, '第1章 落水');
  assert.equal(req.books[0].chapters[0].body, '正文甲');
});

test('buildRequest：标了「转设定」的行不进章，改走 blocks（落库侧建成设定卡）', () => {
  const sources = [src('晚星大纲.md', '## 卷零《旧厂区》\n要点\n## 核心设定\n设定正文')];
  const chapters = draftChapters(sources).map((c, i) => (i === 1 ? { ...c, asWorld: true } : c));
  const req = buildRequest({ ...base, sources, chapters });
  assert.equal(req.books[0].chapters.length, 1);
  assert.equal(req.books[0].chapters[0].title, '卷零《旧厂区》');
  const card = req.blocks.find((b) => b.asWorld);
  assert.ok(card, '转设定的行要出现在 blocks 里');
  assert.equal(card.name, '核心设定');
  assert.equal(card.content, '设定正文');
});

test('buildRequest：设定卡落点不理会「转设定」标记（本来就不按章走）', () => {
  const sources = [src('资料.md', '## 核心设定\n设定正文')];
  const chapters = draftChapters(sources).map((c) => ({ ...c, asWorld: true }));
  const req = buildRequest({ ...base, target: 'world', sources, chapters });
  assert.equal(req.blocks.filter((b) => b.asWorld).length, 0, '不得把 asWorld 行混进 blocks');
  assert.equal(req.blocks.length, 1, '设定卡落点仍按来源一块：整篇一张卡');
});


test('buildRequest：整篇没有章名的那一条，落进作品时 title 为空（由落库侧判单篇）', () => {
  const sources = [src('随笔.md', '整篇就是这样一段。')];
  const req = buildRequest({ ...base, sources, chapters: draftChapters(sources) });
  assert.equal(req.books[0].chapters[0].title, '');
  assert.equal(req.books[0].chapters[0].body, '整篇就是这样一段。');
});

test('buildRequest：各自成书时按来源分组，各拿各的书名与章', () => {
  const sources = [src('甲.md', '第1章 A\n正文A'), src('乙.md', '第1章 B\n正文B')];
  const req = buildRequest({ ...base, sources, chapters: draftChapters(sources), mode: 'separate' });
  assert.equal(req.books.length, 2);
  assert.deepEqual(req.books.map((b) => b.title), ['甲', '乙']);
  assert.deepEqual(req.books.map((b) => b.chapters.length), [1, 1]);
  assert.equal(req.books[1].chapters[0].body, '正文B');
});

test('buildRequest：拆章删空之后不该产出空书', () => {
  const sources = [src('甲.md', '第1章 A\n正文A'), src('乙.md', '第1章 B\n正文B')];
  const chapters = draftChapters(sources).filter((c) => c.from === '甲.md');
  const req = buildRequest({ ...base, sources, chapters, mode: 'separate' });
  assert.deepEqual(req.books.map((b) => b.title), ['甲']);
});

test('buildRequest：追加到已有作品时把用户编辑过的章原样带上', () => {
  const sources = [src('甲.md', '第1章 A\n正文A')];
  const chapters = draftChapters(sources);
  chapters[0].title = '改过的章名';
  const req = buildRequest({ ...base, target: 'append', sources, chapters, projectId: 'p1' });
  assert.equal(req.target, 'append');
  assert.equal(req.projectId, 'p1');
  assert.equal(req.books[0].chapters[0].title, '改过的章名');
});

test('buildRequest：灵感库与设定卡收整篇原文，不是拆章结果', () => {
  const sources = [src('甲.md', '第1章 A\n正文A\n第2章 B\n正文B')];
  const req = buildRequest({ ...base, target: 'idea', sources, chapters: draftChapters(sources) });
  assert.equal(req.blocks.length, 1);
  assert.equal(req.blocks[0].name, '甲');
  assert.equal(req.blocks[0].content, '第1章 A\n正文A\n第2章 B\n正文B');
  assert.equal(req.kind, '素材');
});

// ---------- 判据 ----------

test('gapOf：新建作品只要有内容就放行', () => {
  assert.equal(gapOf({ target: 'new-book', projectId: '', chapterId: '', chapterCount: 3 }), '');
  assert.match(gapOf({ target: 'new-book', projectId: '', chapterId: '', chapterCount: 0 }), /还没有可导入的内容/);
});

test('gapOf：需要作品的落点要先选书，选中的书不存在要直说', () => {
  assert.match(gapOf({ target: 'world', projectId: '', chapterId: '', chapterCount: 1 }), /先选一部作品/);
  assert.match(gapOf({ target: 'world', projectId: 'p1', chapterId: '', project: null, chapterCount: 1 }), /找不到/);
  assert.equal(gapOf({ target: 'world', projectId: 'p1', chapterId: '', project: { mode: 'chapters', chapters: [] }, chapterCount: 1 }), '');
  assert.equal(gapOf({ target: 'idea', projectId: '', chapterId: '', chapterCount: 1 }), '', '没选书也能进灵感库');
});

test('gapOf：并要点要求书里有章、并且选中了章', () => {
  const empty = { mode: 'chapters', chapters: [] };
  const book = { mode: 'chapters', chapters: [{ id: 'c1' }, { id: 'c2' }] };
  assert.match(gapOf({ target: 'beats', projectId: 'p1', chapterId: '', project: empty, chapterCount: 1 }), /还没有章/);
  assert.match(gapOf({ target: 'beats', projectId: 'p1', chapterId: '', project: book, chapterCount: 1 }), /还要选并进哪一章/);
  assert.equal(gapOf({ target: 'beats', projectId: 'p1', chapterId: 'c2', project: book, chapterCount: 1 }), '');
});

test('gapOf：单篇草稿不再被挡门——追加会拼成正文接在后面', () => {
  const single = { mode: 'single', chapters: [] };
  assert.equal(gapOf({ target: 'append', projectId: 'p1', chapterId: '', project: single, chapterCount: 3 }), '');
  assert.match(appendNote('single', 3), /拼成一段正文/);
  assert.match(appendNote('single', 1), /拼成一段正文/, '只追加一段也要说清楚落法，否则他以为会新建一章');
  assert.match(appendNote('single', 1), /接在现有正文末尾/);
  assert.equal(appendNote('chapters', 5), '', '按章的书追加就是新章，没什么要提醒的');
  assert.equal(appendNote(undefined, 2), '');
});

test('clashNote：重名只提醒不拦路', () => {
  assert.match(clashNote('雾钟', ['末法九境', '雾钟']), /已经有一条/);
  assert.match(clashNote('雾钟', [' 雾钟 ']), /已经有一条/, '两边留空格该算同一条');
  assert.equal(clashNote('雾钟', ['末法九境']), '');
  assert.equal(clashNote('雾钟', []), '');
});

// ---------- 要点 ----------

test('并进要点的一条：带来源前缀，换行压成一行，末尾空白清掉', () => {
  assert.equal(beatsLine('码头听来的', '有人在等船。\n\n等了一年。'), '〔导入·码头听来的〕有人在等船。 等了一年。');
  assert.equal(beatsLine('x', '一行\n   \n\n\n三行  \n'), '〔导入·x〕一行 三行');
  assert.ok(!beatsLine('x', '甲\n\n\n\n乙').includes('\n\n'), '要点是给批量生成看的短行，不该留空行');
});

test('要点追加：空要点不加前导换行，已有内容留一条换行分隔', () => {
  assert.equal(appendBeats('', '第二条'), '第二条');
  assert.equal(appendBeats(undefined, '第一条'), '第一条');
  assert.equal(appendBeats('认船\n', '第二条'), '认船\n第二条');
  assert.equal(appendBeats('认船\n\n\n', '第二条'), '认船\n第二条', '要点末尾的空行不该带进新行');
});

// ---------- 撤销 ----------

const NOW = '2026-09-30T00:00:00.000Z';
const undoBase = () => ({
  projects: [
    {
      id: 'ob1',
      title: '雾港',
      draft: '原来的正文',
      chapters: [
        { id: 'c1', title: '到港', beats: '认船' },
        { id: 'c2', title: '黑车', beats: '' },
      ],
      worldItems: [{ id: 'w1', name: '雾钟' }, { id: 'w2', name: '码头传闻' }],
    },
    { id: 'ob2', title: '短篇', draft: '一篇还没分章的短稿。' },
  ],
  ideas: [{ id: 'i1' }, { id: 'i2' }],
  stats: { words: 12 },
});

test('撤销：新加的按 id 撤掉，其他条目与整包其它字段一个不动', () => {
  const out = undoImport(undoBase(), [{ kind: 'world', ids: ['w2'], projectId: 'ob1' }], NOW);
  assert.deepEqual(out.projects[0].worldItems, [{ id: 'w1', name: '雾钟' }], '只该拿走导进来的那一张');
  assert.equal(out.projects[0].chapters.length, 2, '章不该被顺带动');
  assert.equal(out.ideas.length, 2);
  assert.deepEqual(out.stats, { words: 12 }, '整包其它字段得原样带着走');
});

test('撤销：灵感按 id 拿走，没提到的留着', () => {
  const out = undoImport(undoBase(), [{ kind: 'idea', ids: ['i1'] }], NOW);
  assert.deepEqual(out.ideas, [{ id: 'i2' }]);
  assert.equal(out.projects.length, 2);
});

test('撤销：新建的作品进回收站而不是硬删——撤销本身也得能反悔', () => {
  const out = undoImport(undoBase(), [{ kind: 'book', ids: ['ob2'] }], NOW);
  assert.equal(out.projects.length, 2, '不能把书从数组里抽走：回收站里还得看得见');
  assert.equal(out.projects[1].deletedAt, NOW);
  assert.equal(out.projects[0].deletedAt, undefined);
});

test('撤销：并进要点写回原文（原本没有要点就是空），正文不动', () => {
  const out = undoImport(undoBase(), [{ kind: 'beats', projectId: 'ob1', chapterId: 'c1', beats: '认船' }], NOW);
  assert.equal(out.projects[0].chapters[0].beats, '认船');
  const out2 = undoImport(undoBase(), [{ kind: 'beats', projectId: 'ob1', chapterId: 'c2', beats: '' }], NOW);
  assert.equal(out2.projects[0].chapters[1].beats, '');
});

test('撤销：追加的章按 id 删掉，正文与原草稿按旧值写回', () => {
  const added = { id: 'c9', title: '起雾', beats: '' };
  const withNew = undoBase();
  withNew.projects[0].chapters.push(added);
  const out = undoImport(withNew, [{ kind: 'chapters', ids: ['c9'], projectId: 'ob1' }], NOW);
  assert.deepEqual(out.projects[0].chapters.map((c) => c.id), ['c1', 'c2']);

  const out2 = undoImport(undoBase(), [{ kind: 'draft', projectId: 'ob2', draft: '一篇还没分章的短稿。' }], NOW);
  assert.equal(out2.projects[1].draft, '一篇还没分章的短稿。', '正文写回导入前那一版');
  assert.equal(out2.projects[0].draft, '原来的正文', '别的书正文不该被顺手改');
});

test('撤销：多张单子一起走，认不出的 id 忽略（那一条可能刚被别处删了）', () => {
  const out = undoImport(
    undoBase(),
    [
      { kind: 'world', ids: ['w2', 'w404'], projectId: 'ob1' },
      { kind: 'idea', ids: ['i404'] },
    ],
    NOW,
  );
  assert.deepEqual(out.projects[0].worldItems, [{ id: 'w1', name: '雾钟' }]);
  assert.deepEqual(out.ideas, [{ id: 'i1' }, { id: 'i2' }]);
});

test('markNonUnits：晚星式大纲（卷 + 资料区混排），资料区自动标转设定', () => {
  const titles = [
    '核心设定',
    '写作执行提醒（动笔前必读）',
    '人物锚点',
    '卷零《旧厂区的蝉鸣》（2011.9 — 2012.8）',
    '卷一《铁丝上的纸条》（2012.9 — 2014.6）',
    '卷二《刺猬的铠甲》（2014.9 — 2018.6）',
    '卷三《省城的第一场雪》（2018.9 — 2021.6）',
    '卷四《城中村的微光与冷风》（2021.7 — 2022.6）',
    '卷五《沉默的体面》（2022.9 — 2024.6）',
    '卷六《没有你的毛坯房》（2024.9 — 2026.6）',
    '卷七《学会了喊疼》（2026.9 — 2028.6）',
    '通信媒介演变线',
    '全书执行铁律',
    '全文物件追踪总览',
    '全书总览',
  ];
  const out = markNonUnits(titles.map((t) => ({ title: t })));
  const marked = out.filter((c) => c.asWorld).map((c) => c.title);
  assert.deepEqual(marked, ['核心设定', '写作执行提醒（动笔前必读）', '人物锚点', '通信媒介演变线', '全书执行铁律', '全文物件追踪总览', '全书总览']);
  assert.equal(out.find((c) => c.title.startsWith('卷零'))?.asWorld, undefined, '卷是正经章，不动');
});

test('markNonUnits：少于 2 个结构单元不动手（只有一两个卷/章标记时，其余多半是正经章）', () => {
  const out = markNonUnits([{ title: '卷一' }, { title: '设定' }, { title: '人物' }]);
  assert.ok(out.every((c) => !c.asWorld));
});

test('markNonUnits：整篇都是结构单元（正常一本书）不标', () => {
  const out = markNonUnits([{ title: '第1章 落水' }, { title: '第2章 进城' }, { title: '番外 婚书' }]);
  assert.ok(out.every((c) => !c.asWorld));
});

test('markNonUnits：晚星式大纲（卷 + 资料区混排），资料区自动标转设定', () => {
  const titles = [
    '核心设定',
    '写作执行提醒（动笔前必读）',
    '人物锚点',
    '卷零《旧厂区的蝉鸣》（2011.9 — 2012.8）',
    '卷一《铁丝上的纸条》（2012.9 — 2014.6）',
    '卷二《刺猬的铠甲》（2014.9 — 2018.6）',
    '卷三《省城的第一场雪》（2018.9 — 2021.6）',
    '卷四《城中村的微光与冷风》（2021.7 — 2022.6）',
    '卷五《沉默的体面》（2022.9 — 2024.6）',
    '卷六《没有你的毛坯房》（2024.9 — 2026.6）',
    '卷七《学会了喊疼》（2026.9 — 2028.6）',
    '通信媒介演变线',
    '全书执行铁律',
    '全文物件追踪总览',
    '全书总览',
  ];
  const out = markNonUnits(titles.map((t) => ({ title: t })));
  const marked = out.filter((c) => c.asWorld).map((c) => c.title);
  assert.deepEqual(marked, ['核心设定', '写作执行提醒（动笔前必读）', '人物锚点', '通信媒介演变线', '全书执行铁律', '全文物件追踪总览', '全书总览']);
  assert.equal(out.find((c) => c.title.startsWith('卷零'))?.asWorld, undefined, '卷是正经章，不动');
});

test('markNonUnits：少于 2 个结构单元不动手（只有一两个卷/章标记时，其余多半是正经章）', () => {
  const out = markNonUnits([{ title: '卷一' }, { title: '设定' }, { title: '人物' }]);
  assert.ok(out.every((c) => !c.asWorld));
});

test('markNonUnits：整篇都是结构单元（正常一本书）不标', () => {
  const out = markNonUnits([{ title: '第1章 落水' }, { title: '第2章 进城' }, { title: '番外 婚书' }]);
  assert.ok(out.every((c) => !c.asWorld));
});




test('normTitle：剥卷章序号与书名号', () => {
  assert.equal(normTitle('卷三《省城的第一场雪》'), '省城的第一场雪');
  assert.equal(normTitle('第三章 省城的第一场雪'), '省城的第一场雪');
  assert.equal(normTitle('第12章 到港'), '到港');
});

test('matchOutlineRows：归一化互含匹配、一章只吃一行、对不上的进 unmatched', () => {
  const chapters = [
    { id: 'c1', title: '卷一《铁丝上的纸条》' },
    { id: 'c2', title: '第二章 刺猬的铠甲' },
  ];
  const rows = [
    { title: '卷一《铁丝上的纸条》（2012.9 — 2014.6）', body: '卷一大纲' },
    { title: '卷二《刺猬的铠甲》', body: '卷二大纲' },
    { title: '全书执行铁律', body: '铁律' },
  ];
  const { matched, unmatched } = matchOutlineRows(chapters, rows);
  assert.deepEqual(matched.map((m) => m.chapterId), ['c1', 'c2']);
  assert.deepEqual(unmatched.map((r) => r.title), ['全书执行铁律']);
});

test('matchOutlineRows：一行命中多章取第一个，短名（<2 字）不参与', () => {
  const chapters = [
    { id: 'a', title: '雾' },
    { id: 'b', title: '雾港' },
  ];
  const { matched, unmatched } = matchOutlineRows(chapters, [
    { title: '雾港', body: 'x' },
    { title: '雾', body: 'y' },
  ]);
  assert.deepEqual(matched.map((m) => m.chapterId), ['b']);
  assert.equal(unmatched.length, 1);
});

test('undoImport：notes 撤销写回旧备注', () => {
  const data = {
    projects: [{ id: 'p1', notes: '旧备注', chapters: [] }],
    ideas: [],
  };
  const out = undoImport(data, [{ kind: 'notes', projectId: 'p1', notes: '更旧的备注' }], '2026-09-30T00:00:00.000Z');
  assert.equal((out.projects as unknown as { notes: string }[])[0].notes, '更旧的备注');
});

test('outlineFileToChapters：章行→新章要点，资料区→备注块', () => {
  const rows = [
    { title: '卷一《铁丝上的纸条》', body: '卷一大纲全文', asWorld: true },
    { title: '第一章 到港', body: '到港的要点' },
  ];
  const { chapters, notes } = outlineFileToChapters(rows, '原备注');
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].title, '第一章 到港');
  assert.equal(chapters[0].beats, '到港的要点');
  assert.ok(notes.includes('原备注') && notes.includes('【导入的大纲资料】') && notes.includes('卷一大纲全文'));
});

test('outlineFileToChapters：无资料区时备注原样返回', () => {
  const { chapters, notes } = outlineFileToChapters([{ title: '第一章', body: 'x' }], '');
  assert.equal(chapters.length, 1);
  assert.equal(notes, '');
});

test('outlineFileToChapters：章行→新章要点，资料区→备注块', () => {
  const rows = [
    { title: '卷一《铁丝上的纸条》', body: '卷一大纲全文', asWorld: true },
    { title: '第一章 到港', body: '到港的要点' },
  ];
  const { chapters, notes } = outlineFileToChapters(rows, '原备注');
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].title, '第一章 到港');
  assert.equal(chapters[0].beats, '到港的要点');
  assert.ok(notes.includes('原备注') && notes.includes('【导入的大纲资料】') && notes.includes('卷一大纲全文'));
});

test('outlineFileToChapters：无资料区时备注原样返回', () => {
  const { chapters, notes } = outlineFileToChapters([{ title: '第一章', body: 'x' }], '');
  assert.equal(chapters.length, 1);
  assert.equal(notes, '');
});

test('volumeOf：识别卷一/第一卷，无卷号返回空', () => {
  assert.equal(volumeOf('卷一《省城的第一场雪》'), '卷一');
  assert.equal(volumeOf('第一卷 到港'), '第一卷');
  assert.equal(volumeOf('第12章 到港'), '');
  assert.equal(volumeOf('全书执行铁律'), '');
});

test('draftChapters：拆章时带上卷标', () => {
  const s = src('晚星照澈全书大纲.md', '## 卷一《省城的第一场雪》\n卷一 第1段：规划行。\n卷一 第2段：规划行。\n\n## 卷二《刺猬的铠甲》\n卷二 第1段：规划行。\n卷二 第2段：规划行。');
  const rows = draftChapters([s]);
  assert.equal(rows[0].volume, '卷一');
  assert.equal(rows[1].volume, '卷二');
});

test('outlineFileToChapters：新章携带卷标', () => {
  const { chapters } = outlineFileToChapters([{ title: '卷二《刺猬的铠甲》', body: '要点' }], '');
  assert.equal(chapters[0].volume, '卷二');
});

test('volumeOf：识别卷一/第一卷，无卷号返回空', () => {
  assert.equal(volumeOf('卷一《省城的第一场雪》'), '卷一');
  assert.equal(volumeOf('第一卷 到港'), '第一卷');
  assert.equal(volumeOf('第12章 到港'), '');
  assert.equal(volumeOf('全书执行铁律'), '');
});
