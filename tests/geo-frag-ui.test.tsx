// 地点层级与碎片关联的渲染接缝 + 写作页「对照」按钮的出现条件。
// MarkRow 是伏笔/碎片/人物/彩蛋四个页签共用的组件，加 children 之后要确认别的页签没被带坏。
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ProjectDrawer from '../src/components/ProjectDrawer';
import WritingView from '../src/components/WritingView';
import { EMPTY_STATE, EMPTY_USER } from '../src/gacha';
import type { AIPublic, Chapter, Project, TextMark, WorldItem } from '../src/types';

const el = React.createElement;
const ai: AIPublic = { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:8b', hasKey: false, ready: true, rules: [] };

const world = (name: string, kind: WorldItem['kind'], parent?: string): WorldItem =>
  ({ id: 'w-' + name, name, kind, content: '', ...(parent ? { parent } : {}) });

const drawer = (tab: '设定' | '碎片', over: Partial<Project> = {}, marks: TextMark[] = []) => {
  const p = {
    id: 'p', title: '雾港', type: '玄幻', status: '写作中', deadline: '', notes: '', draft: '', linkedIdeaIds: [],
    createdAt: '', updatedAt: '', mode: 'chapters',
    chapters: [{ id: 'c1', title: '第一章', content: '林越在码头。', createdAt: '', updatedAt: '' }],
    characters: [{ id: 'k1', name: '林越', state: '', log: [], relations: [] }],
    worldItems: [] as WorldItem[],
    marks,
    ...over,
  } as Project;
  return renderToStaticMarkup(el(ProjectDrawer, { project: p, ideas: [], aiInfo: ai, tab, onTab: () => {}, onClose: () => {}, onUpdate: () => {}, onJump: () => {}, onInsert: () => {} }));
};

test('地点卡挂了上级：画出归属链「雾港 › 码头」', () => {
  const html = drawer('设定', { worldItems: [world('雾港', '地点'), world('码头', '地点', '雾港')] });
  assert.ok(html.includes('雾港'), '地点卡要渲染');
  assert.ok(html.includes('place-chain'), '要有归属链区块');
  assert.ok(/雾港[^<]*›[^<]*码头|›/.test(html), `链要用 › 串起来：${html.slice(html.indexOf('place-chain') - 80, html.indexOf('place-chain') + 120)}`);
  assert.ok(html.includes('上级地点'), '要有上级输入框');
});

test('顶层地点与悬空 parent：不画链（悬空没得画），输入框仍在', () => {
  const html = drawer('设定', { worldItems: [world('雾港', '地点'), world('车站', '地点', '不存在的城')] });
  assert.equal(html.includes('place-chain'), false, '悬空的链不画');
  assert.ok(html.includes('上级地点'), '输入框还在，作者可以改');
});

test('碎片里提到的人物/设定：自动标出「提到：…」', () => {
  const mark: TextMark = { id: 'm1', type: '碎片', start: 0, end: 6, text: '林越在码头的传闻', createdAt: '' };
  const html = drawer('碎片', { worldItems: [world('码头', '地点')] }, [mark]);
  assert.ok(html.includes('frag-links'), '要有自动关联区块');
  assert.ok(html.includes('提到'), '要有「提到」前缀');
  assert.ok(html.includes('林越') && html.includes('码头'), '人物与地点名都要标出');
});

test('MarkRow 加了 children 之后，伏笔页签照常渲染（共享组件不回归）', () => {
  const mark: TextMark = { id: 'm2', type: '伏笔', start: 0, end: 4, text: '铁锈纹的来处', status: '埋下', createdAt: '' };
  const html = drawer('伏笔', {}, [mark]);
  assert.ok(html.includes('铁锈纹的来处'), '伏笔条目照常');
  assert.equal(html.includes('frag-links'), false, '伏笔页签不该出现碎片关联块');
});

// —— 写作页「对照」按钮 ——
const ch = (id: string, title: string, content: string): Chapter => ({ id, title, content, createdAt: '', updatedAt: '' });

const writing = (over: Partial<Project> = {}) => {
  const p = {
    id: 'p', title: '雾港', type: '玄幻', status: '写作中', deadline: '', notes: '', draft: '', linkedIdeaIds: [],
    createdAt: '', updatedAt: '', mode: 'chapters',
    chapters: [ch('c1', '出发', '列车开了。'), ch('c2', '站台', '雾比昨天更厚。')],
    marks: [],
    ...over,
  } as Project;
  return renderToStaticMarkup(
    el(WritingView, {
      project: p, ideas: [], obsidian: { vaultPath: '', folder: '' }, onUpdate: () => {}, onRestoreVersion: () => {},
      onUpdateChapter: () => {}, onAddChapter: () => {}, onDeleteChapter: () => {}, onMoveChapter: () => {},
      onRestoreChapterVersion: () => {}, onDelete: () => {}, onBack: () => {},
      aiInfo: { provider: '', baseUrl: '', model: '', hasKey: false, ready: false },
      onOpenSettings: () => {}, gacha: EMPTY_STATE, cards: EMPTY_USER, onGacha: () => {}, onCards: () => {},
      onOpenGacha: () => {}, onAddRule: () => '', todayWords: 0,
      obsSync: { syncMsg: '', setSyncMsg: () => {}, syncConflicts: [], pendingResolve: {}, sync: () => {}, decide: () => {}, dismissConflicts: () => {}, touchDoc: () => {} },
    }),
  );
};

test('章节模式画「对照」按钮；单文档模式不画（没有章可对照）', () => {
  assert.ok(writing().includes('对照'), '章节模式要有对照按钮');
  const single = writing({ mode: 'single', draft: '雾比昨天更厚。' });
  assert.ok(/>(对照)</.test(single) === false && !single.includes('>对照<'), `单文档模式不该有对照按钮：${single.includes('对照')}`);
});
