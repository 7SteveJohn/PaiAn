// AI 味三处接入的接缝测试：复盘页要能算出「全书/每千字/最毒句式/最重的章」，
// 且没数据时给引导而不是 NaN。编辑器装饰与工坊自检属渲染细节，由 test:ui 真点击覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReviewPanel from '../src/components/ReviewPanel';
import type { Project } from '../src/types';

const el = React.createElement;

function book(chapters: { id: string; title: string; content: string }[]): Project {
  return {
    id: 'p1',
    title: '雾港',
    type: '小说',
    status: '写作中',
    deadline: '',
    notes: '',
    draft: '',
    linkedIdeaIds: [],
    createdAt: '',
    updatedAt: '',
    mode: 'chapters',
    chapters: chapters.map((c) => ({ ...c, createdAt: '', updatedAt: '' })),
  };
}

test('复盘页：AI 味统计按章汇总，最毒句式排在前面', () => {
  const p = book([
    { id: 'c1', title: '第一章', content: '他不是不怕，是没有时间怕。夜里很静，一丝不安划过心头。' },
    { id: 'c2', title: '第二章', content: '汽笛响了三声，她把信塞回袖子，数着站台上的灯。' },
    { id: 'c3', title: '第三章', content: '她笑了一下，带着一丝勉强。' + '雨打在铁皮上。'.repeat(12) },
  ]);
  const html = renderToStaticMarkup(el(ReviewPanel as never, { project: p, text: '' } as never));
  assert.match(html, /AI 味（模板句式）/, '复盘页应新增 AI 味栏');
  assert.match(html, /全书 4 处/, `应汇总三章共 4 处命中，实际片段：${(html.match(/全书 \d+ 处/) || [''])[0]}`);
  assert.match(html, /处\/千字/, '要给出每千字口径（跨章可比）');
  assert.ok(html.indexOf('不是A，而是B') < html.indexOf('，带着'), '毒级更高者排在前面');
  assert.match(html, /密度最高的章/, '要列出最重的几章');
  assert.match(html, /第1章[\s\S]{0,40}千字/, '按章行要有「第N章 + x/千字」');
});

test('复盘页：空正文不出现 NaN / Infinity', () => {
  const html = renderToStaticMarkup(el(ReviewPanel as never, { project: book([{ id: 'c1', title: '第一章', content: '' }]), text: '' } as never));
  assert.doesNotMatch(html, /NaN|Infinity/, '空章应显示 0 而不是 NaN');
  assert.match(html, /全书 0 处/);
});

test('复盘页：单文档模式按整篇统计', () => {
  const p: Project = { ...book([]), mode: 'single', draft: '他不是犹豫，而是算定了你会来。' };
  const html = renderToStaticMarkup(el(ReviewPanel as never, { project: p, text: p.draft } as never));
  assert.match(html, /全书 1 处/);
  assert.doesNotMatch(html, /密度最高的章/, '单文档没有分章，不该冒出按章列表');
});
