// 组件层测试：用 react-dom/server 在纯 Node 里渲染成静态 HTML 再断言。
// 不引入 jsdom / testing-library 等新依赖——重心是「数据到界面」的接缝是否还在。
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import HealthCard from '../src/components/HealthCard';
import Sidebar from '../src/components/Sidebar';
import type { HealthReport } from '../src/health';

const el = React.createElement;

function mkReport(over: Partial<HealthReport> = {}): HealthReport {
  return {
    total: 10,
    written: 5,
    drafting: 2,
    todo: 3,
    words: 12000,
    target: 0,
    targetPct: null,
    lastWritten: 5,
    issues: [],
    ...over,
  };
}

test('HealthCard：有 warn 时用告警样式与「需处理」计数', () => {
  const report = mkReport({
    issues: [
      { key: 'short', level: 'warn', text: '第 3 章只有 120 字', act: '补齐到 1000 字以上' },
      { key: 'arc', level: 'info', text: '建议生成全书梗概', act: '去人机工坊生成' },
    ],
  });
  const html = renderToStaticMarkup(el(HealthCard, { report }));
  assert.ok(html.includes('health-card s-warn'), '应整体标记为 warn');
  assert.ok(html.includes('1 项需处理'), 'warn 计数文案');
  assert.ok(html.includes('第 3 章只有 120 字'), '现象文案应渲染');
  assert.ok(html.includes('→ 补齐到 1000 字以上'), '每条必须带下一步动作建议');
  assert.ok(html.includes('建议生成全书梗概'), 'info 文案也要渲染');
});

test('HealthCard：只有建议时用 info 样式', () => {
  const report = mkReport({
    issues: [
      { key: 'a', level: 'info', text: '建议一', act: '动作一' },
      { key: 'b', level: 'info', text: '建议二', act: '动作二' },
    ],
  });
  const html = renderToStaticMarkup(el(HealthCard, { report }));
  assert.ok(html.includes('health-card s-info'), '应为 info 样式');
  assert.ok(html.includes('2 条建议'), 'info 计数文案');
  assert.ok(!html.includes('项需处理'), '不应出现 warn 措辞');
});

test('HealthCard：无问题时状态良好且不渲染清单', () => {
  const html = renderToStaticMarkup(el(HealthCard, { report: mkReport() }));
  assert.ok(html.includes('health-card s-ok'), '应为 ok 样式');
  assert.ok(html.includes('状态良好'), '状态词');
  assert.ok(!html.includes('health-issues'), '无问题时不应渲染问题列表');
});

test('HealthCard：统计行随数据变化，0 值项不占位', () => {
  const full = renderToStaticMarkup(el(HealthCard, { report: mkReport() }));
  assert.ok(full.includes(`<b>5</b>/10 章`), '已写/总章数');
  assert.ok(full.includes('草稿'), 'drafting>0 应显示草稿');
  assert.ok(full.includes('待写'), 'todo>0 应显示待写');
  assert.ok(full.includes((12000).toLocaleString()), '正文字数（按本机 locale 格式化）');

  const empty = renderToStaticMarkup(el(HealthCard, { report: mkReport({ drafting: 0, todo: 0 }) }));
  assert.ok(!empty.includes('草稿'), 'drafting=0 不应占位');
  assert.ok(!empty.includes('待写'), 'todo=0 不应占位');
});

test('HealthCard：未启用字数目标时不渲染进度条，启用后按百分比渲染宽度', () => {
  const off = renderToStaticMarkup(el(HealthCard, { report: mkReport() }));
  assert.ok(!off.includes('health-progress'), 'target=0 时不应出现进度条');
  assert.ok(!off.includes('目标进度'), 'target=0 时不显示目标进度');

  const on = renderToStaticMarkup(el(HealthCard, { report: mkReport({ target: 20000, targetPct: 60 }) }));
  assert.ok(on.includes('health-progress'), '启用目标后应有进度条');
  assert.ok(on.includes('width:60%'), '进度条宽度应取 targetPct');
  assert.ok(on.includes('60%'), '应显示百分比');
});

test('HealthCard：超范围百分比被夹在 0-100', () => {
  const html = renderToStaticMarkup(el(HealthCard, { report: mkReport({ target: 1000, targetPct: 240 }) }));
  assert.ok(html.includes('width:100%'), '超出 100 应夹到 100');
  assert.ok(!html.includes('width:240%'), '不应直接把脏数据渲染出去');
});

function renderSidebar(over: Partial<{ view: string; trashCount: number; saveState: string; aiReady: boolean }> = {}) {
  const props = {
    view: 'home',
    onNavigate: () => {},
    saveState: 'saved',
    onRetrySave: () => {},
    aiReady: true,
    trashCount: 0,
    projects: [],
    ideas: [],
    onOpenProject: () => {},
    onSearchIdea: () => {},
    theme: 'light',
    onToggleTheme: () => {},
    ...over,
  } as never;
  return renderToStaticMarkup(el(Sidebar, props));
}

test('Sidebar：七个导航入口齐全，当前视图高亮', () => {
  const html = renderSidebar({ view: 'projects' });
  for (const label of ['首页', '灵感库', '创作项目', 'AI 对话', '统计复盘', '设置', '回收站']) {
    assert.ok(html.includes(label), `应渲染导航项：${label}`);
  }
  const activeCount = (html.match(/nav-item active/g) || []).length;
  assert.equal(activeCount, 1, '同一时刻只应有一个高亮项');
  const navPart = html.split('创作项目')[0].slice(-400);
  assert.ok(navPart.includes('nav-item active') || html.includes('nav-item active'), '应有高亮项');
});

test('Sidebar：回收站计数仅在 >0 时出现', () => {
  const zero = renderSidebar({ trashCount: 0 });
  assert.ok(!zero.includes('nav-count'), '0 项时不应出现计数角标');
  const three = renderSidebar({ trashCount: 3 });
  assert.ok(three.includes('nav-count'), '>0 时应出现计数角标');
  assert.ok(three.includes('>3<'), '应显示具体条数');
});

test('Sidebar：保存状态四种文案与错误态可点', () => {
  assert.ok(renderSidebar({ saveState: 'saved' }).includes('已保存'));
  assert.ok(renderSidebar({ saveState: 'saving' }).includes('保存中'));
  assert.ok(renderSidebar({ saveState: 'dirty' }).includes('有改动待保存'));
  const err = renderSidebar({ saveState: 'error' });
  assert.ok(err.includes('保存失败'), '错误态应有明确文案');
  assert.ok(err.includes('clickable'), '错误态应可点击重试');
  assert.ok(!renderSidebar({ saveState: 'saved' }).includes('clickable'), '非错误态不应可点');
});

test('Sidebar：AI 未配置时给设置项打提示点', () => {
  assert.ok(renderSidebar({ aiReady: false }).includes('nav-dot'), '未配置应出现提示点');
  assert.ok(!renderSidebar({ aiReady: true }).includes('nav-dot'), '已配置不应出现提示点');
});
