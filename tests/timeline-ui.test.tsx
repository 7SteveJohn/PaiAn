// 双轨时间轴的渲染接缝：图要画得出来、疑似闪回要提示、未标注要看得见位置。
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AIPublic, Chapter, Project } from '../src/types';
import TimelineView from '../src/components/TimelineView';

const el = React.createElement;

const chapter = (title: string, timeLabel?: string): Chapter =>
  ({ id: 'c' + title, title, content: '正文。', timeLabel, createdAt: '', updatedAt: '' }) as Chapter;

const project = (chapters: Chapter[]): Project =>
  ({ id: 'p', title: '雾港', type: '玄幻', status: '写作中', deadline: '', notes: '', draft: '', linkedIdeaIds: [], createdAt: '', updatedAt: '', mode: 'chapters', chapters }) as Project;

const ai: AIPublic = { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:8b', hasKey: false, ready: true, rules: [] };

const render = (chapters: Chapter[]) =>
  renderToStaticMarkup(el(TimelineView, { project: project(chapters), aiInfo: ai, patch: () => {} }));

test('双轨图画得出来：两条轨、每段一带、有图例', () => {
  const html = render([chapter('一', '九月'), chapter('二', '九月'), chapter('三', '十月')]);
  assert.ok(html.includes('tl-track'), '要有双轨 SVG');
  assert.equal((html.match(/tl-rail/g) || []).length, 2, '上下两条轨');
  assert.equal((html.match(/tl-band(?![a-z-])|"tl-band"/g) || []).length >= 1, true, '要有时间带');
  assert.ok(html.includes('上轨：章节序') && html.includes('下轨：故事内时间'), '图例要说明两条轨各是什么');
  assert.ok(!html.includes('疑似闪回'), '没有重复标签就不该报闪回');
});

test('同一标签跨区间复现：报疑似闪回并给出两处章号', () => {
  const html = render([chapter('一', '九月'), chapter('二', '十月'), chapter('三', '九月')]);
  assert.ok(html.includes('疑似闪回'), '要报出来');
  assert.ok(html.includes('「九月」出现在 第 1 章 与 第 3 章'), `要给两处章号：${(html.match(/疑似闪回[^<]*/) || [''])[0]}`);
  assert.ok(html.includes('tl-band-repeat'), '重复的那段要描红');
});

test('未标注的章在图上有位置：点与带都用灰的，别让人找不到哪里没标', () => {
  const html = render([chapter('一', '九月'), chapter('二'), chapter('三')]);
  assert.ok(html.includes('tl-dot-miss'), '未标注的点要灰');
  assert.ok(html.includes('tl-band-miss'), '未标注的带要灰');
  assert.ok(html.includes('（未标注）'), '悬停文案要说明这是未标注');
});
