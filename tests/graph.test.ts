// 牵线层的锚点：图是「作者亲手连的因果」，最怕的是重复牵线堆节点、删了实体却留下说谎的线，
// 以及「跑一遍」拼出来的上下文其实跟线无关。这几条都必须可断言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Project, StoryGraph } from '../src/types';
import {
  addLink,
  addNote,
  autoWire,
  contextFor,
  dropLink,
  dropNode,
  ensureEntityNodes,
  graphOf,
  graphStats,
  isSameGraph,
  layout,
  moveNode,
  nodeFlag,
  nodeLabel,
  normalizeGraph,
  placeNew,
  problems,
  refNodeId,
  relinkAs,
  syncCast,
  upstreamChapters,
} from '../src/graph';

const ch = (id: string, over: Partial<{ title: string; content: string; beats: string; cast: string }> = {}) => ({
  id,
  title: over.title ?? id,
  content: over.content ?? '',
  beats: over.beats,
  cast: over.cast,
  createdAt: '',
  updatedAt: '',
});

const proj = (over: Partial<Project> = {}): Project =>
  ({
    id: 'p1',
    title: '长夜拾荒',
    type: '玄幻',
    status: '写作中',
    deadline: '',
    notes: '',
    draft: '',
    linkedIdeaIds: [],
    createdAt: '',
    updatedAt: '',
    mode: 'chapters',
    chapters: [ch('c1', { title: '第一章 到港', content: 'x'.repeat(500), beats: '认出铁锈纹', cast: '林越、阿禾' }), ch('c2', { title: '第二章 卸货', beats: '舱单少一页', cast: '林越' }), ch('c3', { title: '第三章 清点' })],
    characters: [
      { id: 'k1', name: '林越', state: '怀疑走私线', log: [], relations: [{ with: '阿禾', note: '欠她一条命' }] },
      { id: 'k2', name: '阿禾', state: '', log: [], relations: [] },
    ],
    worldItems: [{ id: 'w1', name: '夜航船', kind: '地点', content: '' }],
    marks: [
      { id: 'm1', type: '伏笔', start: 0, end: 3, text: '铁锈纹的来处', status: '埋下', chapterId: 'c1', createdAt: '' },
      { id: 'm2', type: '伏笔', start: 0, end: 3, text: '钟声', status: '回收', chapterId: 'c2', createdAt: '' },
    ] as Project['marks'],
    ...over,
  }) as Project;

const g0 = (): StoryGraph => ({ version: 1, nodes: [], links: [] });

test('graphOf：没有图就是空图，脏数据也能整干净', () => {
  assert.deepEqual(graphOf(proj()), g0());
  const dirty = {
    version: 1,
    nodes: [
      { id: 'chapter:c1', kind: 'chapter' },
      { id: 'chapter:c2', kind: 'chapter' },
      { id: 'chapter:c1', kind: 'chapter' }, // 重复
      { id: 'chapter:已删的章', kind: 'chapter' }, // 实体不在了
      { id: 'note:x', kind: 'note', note: '随手一句', x: 12.7, y: -3 },
      { id: 'hook:m9', kind: 'hook' }, // 伏笔也删了
      { id: 'weird', kind: '不存在的类' },
    ],
    links: [
      { id: 'next|chapter:c1->chapter:c2', from: 'chapter:c1', to: 'chapter:c2', kind: 'next' },
      { id: 'next|chapter:c1->chapter:c2', from: 'chapter:c1', to: 'chapter:c2', kind: 'next' }, // 重复
      { id: 'free|a', from: 'chapter:c1', to: 'chapter:不存在的', kind: 'free' }, // 断头
      { id: '自环', from: 'chapter:c1', to: 'chapter:c1', kind: 'free' },
      { id: '乱kind', from: 'chapter:c1', to: 'chapter:c3', kind: '胡说' },
    ],
  };
  const clean = normalizeGraph(proj(), dirty);
  assert.deepEqual(clean.nodes.map((n) => n.id), ['chapter:c1', 'chapter:c2', 'note:x'], `节点没清干净：${clean.nodes.map((n) => n.id).join('、')}`);
  assert.equal(clean.nodes[2].x, 13, '坐标四舍五入');
  assert.deepEqual(clean.links.map((l) => l.id), ['next|chapter:c1->chapter:c2']);
});

test('一键牵线：四类线都长出来，而且幂等', () => {
  const first = autoWire(proj(), g0());
  const kinds = graphStats(first).byLink;
  assert.equal(kinds.next, 2, `三章该有两条推动：${kinds.next}`);
  assert.ok(kinds.cast >= 3, `出场名单该牵出人物线：${kinds.cast}`);
  assert.equal(kinds.kin, 1, '一条关系线');
  assert.equal(kinds.hook, 2, '两条伏笔线（按埋点章）');
  const again = autoWire(proj(), first);
  assert.deepEqual(graphStats(again), graphStats(first), '再点一次「一键牵线」不该多出东西');
  assert.ok(graphStats(again).byKind.chapter === 3 && graphStats(again).byKind.char === 2);
});

test('只连真实存在的实体：名单里写错的名字不硬造节点', () => {
  const p = proj({ chapters: [ch('c1', { cast: '林越、不存在的某人' }), ch('c2')] });
  const g = autoWire(p, g0());
  assert.ok(!g.nodes.some((n) => nodeLabel(p, n).includes('不存在')), '不该为名单里的错名字造节点');
  assert.equal(g.links.filter((l) => l.kind === 'cast').length, 1);
});

test('布局确定性：章按阅读顺序摆，重复调用结果一致', () => {
  const p = proj({ chapters: [ch('c1'), ch('c2'), ch('c3'), ch('c4'), ch('c5'), ch('c6'), ch('c7')] });
  const g = autoWire(p, g0());
  const a = layout(p, g);
  assert.deepEqual(JSON.stringify(layout(p, a)), JSON.stringify(a), '再摆一次位置不该漂');
  const pos = (id: string) => a.nodes.find((n) => n.id === refNodeId('chapter', id))!;
  assert.ok(pos('c1').x! < pos('c2').x! && pos('c2').y === pos('c1').y);
  assert.ok(pos('c7').y > pos('c1').y, '第七颗该换到下一行');
  assert.ok(a.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
});

test('placeNew：只给没坐标的补位置，摆过的不动', () => {
  const wired = autoWire(proj(), g0());
  const placed = placeNew(proj(), wired);
  assert.ok(placed.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)), '牵完线不该有节点堆在左上角');
  assert.deepEqual(placed.links, wired.links, '补位置不该动线');
  const moved = moveNode(placed, 'chapter:c2', 900, 70);
  const again = placeNew(proj(), addLink(moved, 'chapter:c2', 'char:k1', 'free'));
  const c2 = again.nodes.find((n) => n.id === 'chapter:c2')!;
  assert.deepEqual([c2.x, c2.y], [900, 70], '手动摆过的位置必须原样保留');
  assert.ok(again.nodes.filter((n) => n.id !== 'chapter:c2').every((n) => Number.isFinite(n.x)), '其余缺坐标的照样补上');
});

test('ensureEntityNodes：把新写的章补进图，手动摆过的坐标不动', () => {
  const g = { version: 1 as const, nodes: [{ id: 'chapter:c1', kind: 'chapter' as const, ref: 'c1', x: 999, y: 888 }], links: [] };
  const out = ensureEntityNodes(proj(), g);
  assert.ok(out.nodes.some((n) => n.id === 'chapter:c3'), '新章要补进来');
  assert.equal(out.nodes.find((n) => n.id === 'chapter:c1')!.x, 999);
});

test('诊断：未收伏笔、孤立节点、断头章都点名', () => {
  const g = autoWire(proj(), g0());
  const list = problems(proj(), g);
  assert.ok(list.some((x) => x.kind === '未收伏笔' && x.label.includes('铁锈纹')), `未收的伏笔该列出：${list.map((x) => x.kind + x.label).join(' / ')}`);
  assert.ok(!list.some((x) => x.kind === '未收伏笔' && x.label.includes('钟声')), '已收的不算问题');
  assert.ok(!list.some((x) => x.kind === '断头章'), '连好的章不该被报断头：' + list.map((x) => x.kind + x.label).join(' / '));
  const orphan = problems(proj(), g).filter((x) => x.kind === '孤立节点');
  assert.ok(orphan.some((x) => x.label.includes('夜航船')), '谁都没连上的设定卡该被点出来：' + orphan.map((x) => x.label).join('、'));
  const withNote = addNote(g, '待定的支线');
  assert.ok(!problems(proj(), withNote).some((x) => x.kind === '孤立节点' && x.label.includes('待定的支线')), '便签本来就常常单着，不该被当问题');
  const p2 = proj({ chapters: [ch('c1'), ch('c2'), ch('c3')] });
  const g2 = autoWire(p2, g0());
  assert.deepEqual([], problems(p2, { ...g2, links: g2.links.filter((l) => l.from !== 'chapter:c2' || l.kind !== 'next') }).filter((x) => x.kind === '断头章' && x.label.includes('第二章')), '第二章断链就该被点名');
});

test('跑一遍：沿链拼出前章要点、出场人物状态与伏笔', () => {
  const p = proj();
  const g = autoWire(p, g0());
  const text = contextFor(p, g, 'c3', { depth: 2 });
  assert.ok(text.includes('第一章 到港') && text.includes('认出铁锈纹'), `前章要点没进来：\n${text}`);
  assert.ok(text.includes('第二章 卸货'), '两章深度该都带上');
  assert.ok(text.includes('林越') && text.includes('怀疑走私线'), '牵到的人物要带当前状态');
  assert.ok(text.includes('铁锈纹的来处') && text.includes('未收'), '链上伏笔按状态列出');
  assert.ok(text.startsWith('【牵线上的前章】') && text.includes('【落点】现在要写：第三章 清点'), `结构不对：\n${text}`);
  assert.equal(contextFor(p, g, '不存在'), '');
});

test('upstreamChapters：只往前追，深度可限', () => {
  const g = autoWire(proj(), g0());
  assert.deepEqual(upstreamChapters(proj(), g, 'c3', 1), ['c2']);
  assert.deepEqual(upstreamChapters(proj(), g, 'c3', 8), ['c1', 'c2'], '超出链头就停，不重复不绕圈');
  assert.deepEqual(upstreamChapters(proj(), g, 'c1', 3), [], '第一章没有前章');
  // 手牵的 free 线（倒着指回来）也算前章
  const wired = addLink(g, refNodeId('chapter', 'c1'), refNodeId('chapter', 'c3'), 'free');
  assert.deepEqual(upstreamChapters(proj(), wired, 'c3', 1), ['c1', 'c2'], 'next 前章与手牵进来的章都算');
});

test('画布增删：自环与断头一律不进，删节点顺带删掉它的线', () => {
  const base = autoWire(proj(), g0());
  assert.equal(addLink(base, 'chapter:c1', 'chapter:c1').links.length, base.links.length, '自环不受理');
  assert.equal(addLink(base, 'chapter:c1', 'chapter:不存在的', 'free').links.length, base.links.length);
  const added = addLink(base, refNodeId('chapter', 'c1'), refNodeId('world', 'w1'), 'free');
  assert.equal(added.links.length, base.links.length + 1);
  assert.equal(addLink(added, refNodeId('chapter', 'c1'), refNodeId('world', 'w1'), 'free').links.length, added.links.length, '同一条线不重复');
  const moved = moveNode(added, 'chapter:c1', 120.6, 40.2);
  assert.deepEqual([moved.nodes.find((n) => n.id === 'chapter:c1')!.x, moved.nodes.find((n) => n.id === 'chapter:c1')!.y], [121, 40]);
  const gone = dropNode(moved, 'chapter:c3');
  assert.ok(!gone.links.some((l) => l.from === 'chapter:c3' || l.to === 'chapter:c3'), '删点要连它身上的线一起删');
  const relinked = relinkAs(added, added.links.find((l) => l.kind === 'cast')!.id, 'free');
  assert.ok(relinked.links.some((l) => l.kind === 'free' && l.from === 'chapter:c1'), '改线类别要真的换掉');
  assert.ok(isSameGraph(added, added), '同一份图判定相同');
  assert.ok(!isSameGraph(added, moved));
});

test('出场名单反向写回：图上牵了就不让 cast 空着', () => {
  const p = proj({ chapters: [ch('c1', { cast: '林越' }), ch('c2')] });
  const g = ensureEntityNodes(p, g0());
  const wired = addLink(addLink(g, refNodeId('chapter', 'c2'), refNodeId('char', 'k1'), 'cast'), refNodeId('chapter', 'c2'), refNodeId('char', 'k2'), 'cast');
  const { project, changed } = syncCast(p, wired);
  assert.equal(changed, 1);
  assert.equal(project.chapters![1].cast, '林越、阿禾', `cast 写回不对：${project.chapters![1].cast}`);
  assert.equal(project.chapters![0].cast, '林越', '没牵线的章不动');
  const again = syncCast(project, wired);
  assert.equal(again.changed, 0, '再同步一次不该重复追加');
});

test('便签与状态标签：note 自带正文，章按字数、伏笔按回收状态', () => {
  const p = proj();
  const g = addNote(autoWire(p, g0()), '支线：老灯塔', { x: 10.4, y: 20.6 });
  const note = g.nodes.find((n) => n.kind === 'note')!;
  assert.equal(nodeLabel(p, note), '支线：老灯塔');
  assert.deepEqual([note.x, note.y], [10, 21]);
  assert.equal(nodeFlag(p, { id: 'chapter:c3', kind: 'chapter', ref: 'c3' }), '待写');
  assert.equal(nodeFlag(p, { id: 'chapter:c1', kind: 'chapter', ref: 'c1' }), '500 字');
  assert.equal(nodeFlag(p, { id: 'hook:m1', kind: 'hook', ref: 'm1' }), '未收');
  assert.equal(nodeFlag(p, { id: 'hook:m2', kind: 'hook', ref: 'm2' }), '已收');
});
