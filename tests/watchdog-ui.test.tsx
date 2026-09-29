// 守夜人面板的渲染接缝：有卡才画得出来，证据要带章号与原话，留白也要如实报数。
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Project, UserCards } from '../src/types';
import LorePanel from '../src/components/LorePanel';

const el = React.createElement;
const EMPTY: UserCards = { version: 1, custom: [], off: [] };

const project = (over: Partial<Project> = {}): Project =>
  ({
    id: 'p',
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
    characters: [
      { id: 'k1', name: '林越', state: '', log: [], relations: [], power: '炼气二层' },
      { id: 'k2', name: '阿禾', state: '', log: [], relations: [] },
      { id: 'k3', name: '雾隐师', state: '', log: [], relations: [] },
    ],
    worldItems: [{ id: 'w1', name: '玉扣', kind: '道具', content: '认主不认人' }],
    chapters: [
      { id: 'c1', title: '第一章', content: '林越停在炼气三层，手里那枚玉扣发烫。', createdAt: '', updatedAt: '' },
      { id: 'c2', title: '第二章', content: '林越一步踏入金丹，全场无人说话。\n「林越到底是筑基。」阿禾说。', createdAt: '', updatedAt: '' },
      { id: 'c3', title: '第三章', content: '林越的气息退回筑基中期。', createdAt: '', updatedAt: '' },
      { id: 'c4', title: '第四章', content: '阿禾在灯下修那只旧表。'.repeat(4), createdAt: '', updatedAt: '' },
      { id: 'c5', title: '第五章', content: '阿禾没有回头。'.repeat(4), createdAt: '', updatedAt: '' },
      { id: 'c6', title: '第六章', content: '阿禾替他把话说完。'.repeat(4), createdAt: '', updatedAt: '' },
      { id: 'c7', title: '第七章', content: '阿禾先睡了。'.repeat(4), createdAt: '', updatedAt: '' },
    ],
    ...over,
  }) as Project;

const render = (p: Project, onAddLadder = () => '已建') => {
  const calls: string[] = [];
  const html = renderToStaticMarkup(el(LorePanel, { project: p, cards: EMPTY, onCards: () => {}, onOpenGacha: () => {}, onAddLadder: () => (calls.push('x'), onAddLadder()) }));
  return { html, calls };
};

test('三块都在，且每条发现带着章号与原话', () => {
  const html = render(project()).html;
  assert.ok(html.includes('境界线') && html.includes('称谓与名册') && html.includes('远场沉默'), html.slice(0, 240));
  assert.match(html, /第2章写到「金丹」，第3章成了「筑基中期」/, '回退要说清从哪儿掉到哪儿');
  assert.ok(html.includes('卡落后正文'), '卡上境界低于正文也要报');
  assert.ok(html.includes('卡没落地'), '从没出场过的卡要报名字');
  assert.match(html, /玉扣[\s\S]*已隔 6 章/, '沉默要给出隔了几章');
  assert.ok(html.includes('掉成卡'), '该有掉卡按钮');
});

test('留白要如实报数：台词、否定、归属不清各挡了几处', () => {
  const html = render(project()).html;
  assert.match(html, /另有 1 处在台词里/, `要说出挡掉了几处：${(html.match(/另有[^<]*/) || [''])[0]}`);
});

test('没有人物卡也没有设定卡：整块不出现，不占复盘栏', () => {
  assert.equal(render(project({ characters: [], worldItems: [] })).html, '');
});

test('单篇模式：说清章序判不了，而不是给个空表', () => {
  const html = render(project({ mode: 'single', chapters: undefined, draft: '林越已是金丹。' + '细节。'.repeat(30) + '林越身上是筑基中期的气息。' })).html;
  assert.ok(html.includes('单篇模式没有章序'), html.slice(0, 200));
});

test('还在吃内置境界表就给入口；写清楚词条后入口消失、面板改用你的线', () => {
  const bare = render(project());
  assert.ok(bare.html.includes('补一张力量体系卡'), '自创体系判不了时不能只留一句提示');
  assert.match(bare.html, /内置/, '要如实说现在用的是内置表');

  const withCard = project({
    worldItems: [
      { id: 'w1', name: '力量体系', kind: '力量体系', content: '灯境 → 守夜 → 长夜 → 无明' },
      { id: 'w2', name: '玉扣', kind: '道具', content: '认主不认人' },
    ],
    chapters: [
      { id: 'c1', title: '第一章', content: '林越一步踏入长夜。' + '细节。'.repeat(30), createdAt: '', updatedAt: '' },
      { id: 'c2', title: '第二章', content: '林越退回灯境。' + '细节。'.repeat(30), createdAt: '', updatedAt: '' },
    ],
  });
  const got = render(withCard);
  assert.ok(!got.html.includes('补一张力量体系卡'), '有了词条就别再劝建卡');
  assert.match(got.html, /力量体系[(]词条[)]/, '面板要说清这条线是谁的');
  assert.match(got.html, /第1章写到「长夜」，第2章成了「灯境」|第1章「长夜」→ 第2章「灯境」/, '自创体系也要判得出回退：' + (got.html.match(/第1章[^<]{0,40}/) || [''])[0]);
});
