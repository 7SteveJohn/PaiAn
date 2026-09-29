// 节律区的渲染接缝：复盘栏里那三块（琴键 / 天平 / 利息）都要「有数据就画得出来」，
// 并且掉卡按钮真的往卡池里加一张可判定的收线卡。
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Project, UserCards } from '../src/types';
import PitchPanel from '../src/components/PitchPanel';
import { hookDebts } from '../src/debt';

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
    chapters: [
      { id: 'c1', title: '第一章 到港', content: '林越问：「你上错船了？」\n阿禾摇头：「没有。」\n他沿着第七根缆桩往东走，靴底压过湿木板。'.repeat(6), beats: '认出铁锈纹', cast: '林越、阿禾', createdAt: '', updatedAt: '' },
      { id: 'c2', title: '第二章 夜航', content: '雾从板缝里挤进来，把灯芯压成一团青蓝色。'.repeat(5), beats: '舱单少一页', cast: '林越', createdAt: '', updatedAt: '' },
      { id: 'c3', title: '第三章 钟声', content: '钟声是从船底传来的。'.repeat(6) + '\n「现在跳还来得及。」阿禾说。', beats: '钟响', cast: '阿禾', createdAt: '', updatedAt: '' },
      { id: 'c4', title: '第四章 封口', content: '他把最后一盏灯吹灭，水面立刻把光吞干净。'.repeat(3), beats: '封口', cast: '林越', createdAt: '', updatedAt: '' },
      { id: 'c5', title: '第五章 天亮', content: '雾散了一角，港里的钟又响了。'.repeat(3) + '\n「你听见了？」阿禾说。', beats: '天亮', cast: '林越、阿禾', createdAt: '', updatedAt: '' },
    ],
    characters: [
      { id: 'k1', name: '林越', state: '怀疑走私线', log: [], relations: [{ with: '阿禾', note: '欠她一条命' }] },
      { id: 'k2', name: '阿禾', state: '', log: [], relations: [] },
      { id: 'k3', name: '雾隐师', state: '', log: [], relations: [] },
    ],
    marks: [{ id: 'm1', type: '伏笔', start: 0, end: 3, text: '铁锈纹的来处', status: '埋下', chapterId: 'c1', expected: '第十二章揭一半', createdAt: '' }] as Project['marks'],
    ...over,
  }) as Project;

const render = (p: Project, cards: UserCards = EMPTY) => {
  const calls: UserCards[] = [];
  const html = renderToStaticMarkup(el(PitchPanel, { project: p, cards, onCards: (c: UserCards) => calls.push(c), onOpenGacha: () => {} }));
  return { html, calls };
};

test('三块都在，且琴键一章一格', () => {
  const { html } = render(project());
  assert.ok(html.includes('节奏琴键') && html.includes('对白天平') && html.includes('伏笔利息'), html.slice(0, 200));
  const bars = (html.match(/class="pk-bar"/g) || []).length;
  assert.equal(bars, 5, `五章正文该五根条，实际 ${bars}`);
  assert.ok(html.includes('pk-median'), '要有本书中位句长的基准线');
  assert.ok(html.includes('林越') && html.match(/pk-who/g)?.length === 2, '天平该列出认得出的说话人');
  assert.ok(html.includes('归属不明'), '要把「认不出谁说的」如实报出来');
});

test('伏笔利息：挂着的账要显示出来，掉卡按钮按类别加进池子', () => {
  const { html } = render(project());
  assert.ok(html.includes('铁锈纹的来处'), '欠账要列出条目');
  assert.ok(/挂了 \d+ 章 \/ \d+ 字/.test(html), `要给出挂了多久：${(html.match(/挂了[^<]*/) || [''])[0]}`);
  assert.ok(html.includes('第十二章揭一半'), '作者自己写的预期要带回来');
  assert.ok(html.includes('掉成收线卡'), '该有掉卡按钮');
});

test('没有正文就没有节律区：不拿空图占位', () => {
  const empty = project({ chapters: [{ id: 'c1', title: '第一章', content: '', createdAt: '', updatedAt: '' }] });
  assert.equal(render(empty).html, '', '未开写的书不该画琴键');
});

test('收线卡可重复点：同一条伏笔永远只有一张', async () => {
  const { newDebtCards } = await import('../src/debt');
  const debts = hookDebtsForTest();
  const first = newDebtCards(debts, [], 3);
  assert.equal(first.length, 1, `一条未收伏笔该掉一张：${JSON.stringify(first.map((c) => c.name))}`);
  assert.equal(newDebtCards(debts, first, 3).length, 0, '再点一次不该堆重复卡');
  assert.equal(newDebtCards(debts, [{ id: 'debt-m1' }], 3).length, 0, '按 id 判重，不看卡面文字');
  assert.equal(first[0].id, 'debt-m1');
  assert.ok(first[0].effect === 'hook', '收线卡要落到本章伏笔安排');
});

const hookDebtsForTest = () => hookDebts(project());
