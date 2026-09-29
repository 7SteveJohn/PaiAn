// 开关要真的按得住按钮：只判不写开着，「生成草稿」必须是禁用且说清为什么；
// 关掉必须立刻能用——相邻两档不一样，否则这就是个装饰性开关。
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Chapter } from '../src/types';
import OutlineCard from '../src/components/OutlineCard';

const el = React.createElement;

const chapter: Chapter = {
  id: 'c1',
  title: '第一章 到港',
  content: '雾港的雾一年里有三百天不肯散。',
  beats: '认出铁锈纹',
  cast: '林越',
  createdAt: '',
  updatedAt: '',
};

const ops = {
  patch: () => {},
  genDraft: () => {},
  togglePreview: () => {},
  refineSummary: () => {},
  adopt: () => {},
  drop: () => {},
  ask: () => {},
  toggleDiscuss: () => {},
  send: () => {},
} as unknown as React.ComponentProps<typeof OutlineCard>['ops'];

const render = (judgeOnly: boolean) =>
  renderToStaticMarkup(
    el(OutlineCard as never, {
      c: chapter,
      i: 0,
      cWords: 15,
      sel: true,
      aiReady: true,
      judgeOnly,
      isRunning: false,
      isCurrent: false,
      previewOpen: false,
      sumBusy: false,
      discussOpen: false,
      debt: null,
      ops,
    } as never),
  );

const draftBtn = (html: string) => {
  const m = html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*生成草稿<\/button>/);
  return m ? m[0] : '';
};

test('只判不写开着：单章「生成草稿」禁用，并把理由写在 title 上', () => {
  const on = draftBtn(render(true));
  assert.ok(on, '卡片上该有「生成草稿」按钮：' + render(true).slice(0, 200));
  assert.ok(/\bdisabled=""\b|\bdisabled\b/.test(on), '开着时按钮必须禁用：' + on);
  assert.match(on, /只判不写/, 'title 要说清为什么按住了：' + on);
});

test('关掉之后同一个按钮立刻能用（相邻两档必须不一样）', () => {
  const off = draftBtn(render(false));
  assert.ok(off && !/disabled/.test(off), '关掉开关后不该还是禁用态：' + off);
  assert.ok(!/只判不写/.test(off), '没开着就别挂着那句理由');
  assert.match(off, /按本章大纲生成一版草稿/, '关掉时 title 该回到原来的说明');
});
