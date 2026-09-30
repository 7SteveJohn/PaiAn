// 「演一遍」的剧本层：沿「推动」线一拍拍走，线断了按目录补、有环不死循环、
// 每一拍讲的必须是这一章自己的东西（梗概 → 要点 → 正文开头，谁先用谁）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Project, StoryGraph } from '../src/types';
import { addLink, emptyGraph, ensureEntityNodes, playScript, refNodeId } from '../src/graph';

const ch = (id: string, over: Partial<{ title: string; content: string; beats: string; summary: string; cast: string }> = {}) => ({
  id,
  title: over.title ?? id,
  content: over.content ?? '',
  summary: over.summary,
  beats: over.beats,
  cast: over.cast,
  createdAt: '',
  updatedAt: '',
});

const proj = (over: Partial<Project> = {}): Project =>
  ({
    id: 'p',
    title: 't',
    type: '小说',
    status: '写作中',
    deadline: '',
    notes: '',
    draft: '',
    linkedIdeaIds: [],
    createdAt: '',
    updatedAt: '',
    mode: 'chapters',
    chapters: [],
    characters: [],
    worldItems: [],
    marks: [],
    ...over,
  }) as unknown as Project;

const wired = (p: Project, ids: string[], links: [string, string, 'next' | 'cast' | 'free'][]) => {
  let g: StoryGraph = ensureEntityNodes(
    p,
    Object.assign(emptyGraph(), {
      nodes: ids.map((id, i) => ({ id, kind: id.startsWith('chapter:') ? 'chapter' : id.startsWith('char:') ? 'char' : 'note', ref: id.split(':')[1], x: i * 200, y: 0 })) as StoryGraph['nodes'],
    }),
  );
  for (const [a, b, k] of links) g = addLink(g, a, b, k);
  return g;
};

test('沿「推动」线走，起点是没有前章的那一章', () => {
  const p = proj({ chapters: [ch('c1'), ch('c2', { title: '第二章' }), ch('c3', { title: '第三章' })] });
  // 目录顺序是 1,2,3，但因果线故意牵成 1 → 3 → 2：播放该照线走，不是照目录走
  const g = wired(p, ['chapter:c1', 'chapter:c2', 'chapter:c3'], [
    ['chapter:c1', 'chapter:c3', 'next'],
    ['chapter:c3', 'chapter:c2', 'next'],
  ]);
  assert.deepEqual(
    playScript(p, g).map((b) => [b.chapterId, b.via]),
    [
      ['c1', 'first'],
      ['c3', 'link'],
      ['c2', 'link'],
    ],
  );
});

test('链断了不猜：没走到的章按目录顺序补在末尾，并标成 order', () => {
  const p = proj({ chapters: [ch('c1'), ch('c2'), ch('c3'), ch('c4')] });
  const g = wired(p, ['chapter:c1', 'chapter:c2', 'chapter:c3', 'chapter:c4'], [
    ['chapter:c1', 'chapter:c2', 'next'],
    ['chapter:c3', 'chapter:c4', 'next'],
  ]);
  const got = playScript(p, g);
  assert.deepEqual(got.map((b) => b.chapterId), ['c1', 'c2', 'c3', 'c4'], JSON.stringify(got.map((b) => b.via)));
  assert.deepEqual(got.map((b) => b.via), ['first', 'link', 'order', 'link'], '第二段段首没线接过来标 order，段内照「推动」线仍算 link');
});

test('环不会把播放挂住：走一圈就停', () => {
  const p = proj({ chapters: [ch('c1'), ch('c2'), ch('c3')] });
  const g = wired(p, ['chapter:c1', 'chapter:c2', 'chapter:c3'], [
    ['chapter:c1', 'chapter:c2', 'next'],
    ['chapter:c2', 'chapter:c1', 'next'], // 手滑牵回去的环
    ['chapter:c2', 'chapter:c3', 'next'],
  ]);
  const got = playScript(p, g);
  assert.deepEqual(got.map((b) => b.chapterId), ['c1', 'c2', 'c3'], JSON.stringify(got));
});

test('每一拍讲的是本章的东西：梗概优先、没写正文标出来、人物取线加字段的并集', () => {
  const p = proj({
    chapters: [ch('c1', { summary: '林越在码头认出夜航船', cast: '林越、雾隐师', content: '第一段正文' }), ch('c2', { beats: '舱单少一页', content: '' }), ch('c3', { content: '钟声从船底传来，不敲在铜上。'.repeat(4) })],
    characters: [{ id: 'k1', name: '林越', state: '', log: [], relations: [] }, { id: 'k2', name: '阿禾', state: '', log: [], relations: [] }],
    marks: [
      { id: 'm1', type: '伏笔', start: 0, end: 2, text: '铁锈纹的来处', status: '埋下', chapterId: 'c1', createdAt: '' },
      { id: 'm2', type: '伏笔', start: 0, end: 2, text: '已经收掉的', status: '回收', chapterId: 'c1', createdAt: '' },
      { id: 'm3', type: '彩蛋', start: 0, end: 2, text: '不是伏笔', chapterId: 'c1', createdAt: '' },
    ] as unknown as Project['marks'],
  });
  const g = wired(p, ['chapter:c1', 'chapter:c2', 'chapter:c3', 'char:k2'], [
    ['chapter:c1', 'chapter:c2', 'next'],
    ['chapter:c2', 'chapter:c3', 'next'],
    ['chapter:c1', 'char:k2', 'cast'],
  ]);
  const beats = playScript(p, g);
  assert.equal(beats[0].gist, '林越在码头认出夜航船');
  assert.deepEqual(beats[0].cast, ['林越', '雾隐师', '阿禾'], '字段与牵的线取并集，别把亲手连的人丢掉');
  assert.deepEqual(beats[0].hooks, ['铁锈纹的来处'], '只报未回收的伏笔');
  assert.equal(beats[0].written, true);
  assert.equal(beats[1].gist, '舱单少一页', '没梗概就退到要点');
  assert.equal(beats[1].written, false, '没写正文的章要标出来，不然像在演空气');
  assert.match(beats[2].gist, /^钟声从船底传来/, '两样都没有就念正文开头');
});

test('空图与没有章：给空剧本，不给假的第 1 拍', () => {
  assert.deepEqual(playScript(proj({ chapters: [ch('c1')] }), emptyGraph()), []);
  assert.deepEqual(playScript(proj({ chapters: [] }), emptyGraph()), []);
});

test('便签牵到哪一章，就在哪一章被念出来', () => {
  const p = proj({ chapters: [ch('c1', { content: '正文' }), ch('c2', { content: '正文' })] });
  const g: StoryGraph = {
    version: 1,
    nodes: [
      { id: 'chapter:c1', kind: 'chapter', ref: 'c1', x: 0, y: 0 },
      { id: 'chapter:c2', kind: 'chapter', ref: 'c2', x: 200, y: 0 },
      { id: 'note:n1', kind: 'note', note: '这里要回收铜铃', x: 100, y: 90 },
    ],
    links: [
      { id: 'l1', from: 'chapter:c1', to: 'chapter:c2', kind: 'next' },
      { id: 'l2', from: 'note:n1', to: 'chapter:c2', kind: 'free' },
    ],
  };
  const beats = playScript(p, g);
  assert.deepEqual(beats[0].notes, [], '没牵到第一章就不该冒出来');
  assert.deepEqual(beats[1].notes, ['这里要回收铜铃'], '便签双向牵的都算');
  void refNodeId;
});
