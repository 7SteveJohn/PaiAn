// 画布的渲染接缝：SSR 静态渲染就能查出「图有数据但一个节点都没画出来」这类问题。
// 交互（拖、牵、缩放）走不了 SSR，由 tests/ui-memory-drive.js 的真点步骤兜。
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Project } from '../src/types';
import GraphView from '../src/components/GraphView';

const el = React.createElement;

const project = (over: Partial<Project> = {}): Project =>
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
    chapters: [
      { id: 'c1', title: '第一章 到港', content: '字'.repeat(420), beats: '认出铁锈纹', cast: '林越', createdAt: '', updatedAt: '' },
      { id: 'c2', title: '第二章 卸货', content: '', createdAt: '', updatedAt: '' },
    ],
    characters: [{ id: 'k1', name: '林越', state: '怀疑走私线', log: [], relations: [] }],
    worldItems: [{ id: 'w1', name: '夜航船', kind: '地点', content: '' }],
    marks: [{ id: 'm1', type: '伏笔', start: 0, end: 2, text: '铁锈纹的来处', status: '埋下', chapterId: 'c1', createdAt: '' }] as Project['marks'],
    ...over,
  }) as Project;

const render = (p: Project) => renderToStaticMarkup(el(GraphView, { project: p, onUpdate: () => {}, onOpenChapter: () => {} }));

test('空画布：给出下一步该干什么，而不是留一片白', () => {
  const html = render(project({ graph: undefined }));
  assert.ok(html.includes('一键牵线'), '工具栏要在');
  assert.ok(html.includes('整理布局') && html.includes('同步出场名单'), '三个批量动作都该在');
  assert.ok(!html.includes('gv-node'), '没有图数据时不该凭空画节点');
});

test('已有图：节点、标签与状态都落到 SVG 上', () => {
  const g = {
    version: 1 as const,
    nodes: [
      { id: 'chapter:c1', kind: 'chapter' as const, ref: 'c1', x: 10, y: 10 },
      { id: 'chapter:c2', kind: 'chapter' as const, ref: 'c2', x: 220, y: 10 },
      { id: 'char:k1', kind: 'char' as const, ref: 'k1', x: 220, y: 120 },
      { id: 'hook:m1', kind: 'hook' as const, ref: 'm1', x: 10, y: 120 },
      { id: 'note:n1', kind: 'note' as const, note: '支线：老灯塔', x: 400, y: 120 },
    ],
    links: [
      { id: 'next|chapter:c1->chapter:c2', from: 'chapter:c1', to: 'chapter:c2', kind: 'next' as const },
      { id: 'hook|chapter:c1->hook:m1', from: 'chapter:c1', to: 'hook:m1', kind: 'hook' as const },
    ],
  };
  const html = render(project({ graph: g }));
  for (const s of ['第一章 到港', '第二章 卸货', '林越', '铁锈纹的来处', '支线：老灯塔']) {
    assert.ok(html.includes(s), `节点标签缺了「${s}」`);
  }
  assert.equal((html.match(/class="gv-node/g) || []).length, 5, '节点数对不上');
  assert.equal((html.match(/class="gv-link/g) || []).length, 2, '线条数对不上');
  assert.ok(html.includes('gv-l-next') && html.includes('gv-l-hook'), '线要按类别上色');
  assert.ok(html.includes('未收'), '伏笔要显示回收状态');
  assert.ok(html.includes('420 字') && html.includes('待写'), '章点要带字数/待写');
  assert.ok(html.includes('节点 5') && html.includes('线 2'), '统计栏要对得上');
  assert.ok(html.includes('gv-dk-hook') || html.includes('未收伏笔'), '诊断栏该点名未收的伏笔');
});

test('脏图在渲染前就被规整：断头线与已删实体的影子不会画出来', () => {
  const dirty = {
    version: 1,
    nodes: [
      { id: 'chapter:c1', kind: 'chapter' },
      { id: 'chapter:已删', kind: 'chapter' },
      { id: 'char:k1', kind: 'char' },
    ],
    links: [
      { id: 'a', from: 'chapter:c1', to: 'chapter:已删', kind: 'next' },
      { id: 'b', from: 'chapter:c1', to: 'char:k1', kind: 'cast' },
      { id: 'c', from: 'chapter:c1', to: 'chapter:c1', kind: 'free' },
    ],
  };
  const html = render(project({ graph: dirty as never }));
  assert.equal((html.match(/class="gv-node/g) || []).length, 2, '已删实体的影子不该出现');
  assert.equal((html.match(/class="gv-link/g) || []).length, 1, `断头线/自环该被丢掉：${html.match(/class="gv-link/g)?.length}`);
});
