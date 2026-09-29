// 写作页「分卷导出」按钮的出现条件：只在「章节模式 + 至少两卷」时出现。
// 用 react-dom/server 把整个 WritingView 渲成静态 HTML 再断言（与 pitch-ui / bio-ui 同一套写法）：
// 不引 jsdom，也不为了好写而退化成「只看 splitByVolume 的长度」——按钮真的画出来才算数。
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import WritingView from '../src/components/WritingView';
import { splitByVolume } from '../src/volumes';
import { EMPTY_STATE, EMPTY_USER } from '../src/gacha';
import type { Chapter, Project } from '../src/types';

const el = React.createElement;

const ch = (id: string, title: string, content: string, volume?: string): Chapter => ({
  id,
  title,
  content,
  volume,
  createdAt: '2026-01-01 00:00',
  updatedAt: '2026-01-01 00:00',
});

const project = (over: Partial<Project> = {}): Project =>
  ({
    id: 'p',
    title: '锈色海',
    type: '小说',
    status: '写作中',
    deadline: '',
    notes: '',
    draft: '',
    linkedIdeaIds: [],
    createdAt: '',
    updatedAt: '',
    mode: 'chapters',
    chapters: [
      ch('c1', '出发', '列车开了。', '第一卷 废土列车'),
      ch('c2', '售票员', '她收下了半块面包。', '第一卷 废土列车'),
      ch('c3', '站台', '雾比昨天更厚。', '第二卷 锈色海'),
    ],
    marks: [],
    ...over,
  }) as Project;

function render(p: Project): string {
  return renderToStaticMarkup(
    el(WritingView, {
      project: p,
      ideas: [],
      obsidian: { vaultPath: '', folder: '' },
      onUpdate: () => {},
      onRestoreVersion: () => {},
      onUpdateChapter: () => {},
      onAddChapter: () => {},
      onDeleteChapter: () => {},
      onMoveChapter: () => {},
      onRestoreChapterVersion: () => {},
      onDelete: () => {},
      onBack: () => {},
      aiInfo: { provider: '', baseUrl: '', model: '', hasKey: false, ready: false },
      onOpenSettings: () => {},
      gacha: EMPTY_STATE,
      cards: EMPTY_USER,
      onGacha: () => {},
      onCards: () => {},
      onOpenGacha: () => {},
      onAddRule: () => '',
      todayWords: 0,
      obsSync: {
        syncMsg: '',
        setSyncMsg: () => {},
        syncConflicts: [],
        pendingResolve: {},
        sync: () => {},
        decide: () => {},
        dismissConflicts: () => {},
        touchDoc: () => {},
      },
    }),
  );
}

const countOf = (html: string, needle: string) => (html.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;

test('章节模式 + 三卷：画得出「分卷 .md」「分卷 .txt」，且标题写明拆成几个文件', () => {
  const html = render(project());
  assert.equal(countOf(html, '分卷 .md'), 1, '分卷 .md 按钮应恰好一个');
  assert.equal(countOf(html, '分卷 .txt'), 1, '分卷 .txt 按钮应恰好一个');
  // 按钮 title 里要给出卷数与卷名，作者点之前就知道会掉下来几个文件
  assert.ok(
    html.includes('按卷拆成 2 个 .md 文件：第一卷 废土列车、第二卷 锈色海'),
    `分卷 .md 的 title 应写明卷数与卷名：${html.slice(html.indexOf('按卷拆成'), html.indexOf('按卷拆成') + 120)}`,
  );
  assert.ok(html.includes('按卷拆成 2 个 .txt 文件：第一卷 废土列车、第二卷 锈色海（Windows 换行）'));
});

test('只有一卷：不画分卷按钮（此时点导出就该走既有的单文件导出）', () => {
  const one = project({ chapters: [ch('c1', '一', '甲', '第一卷'), ch('c2', '二', '乙', '第一卷')] });
  assert.equal(splitByVolume(one.chapters ?? []).length, 1);
  const html = render(one);
  assert.equal(countOf(html, '分卷 .md'), 0, '一卷时不该有分卷 .md');
  assert.equal(countOf(html, '分卷 .txt'), 0, '一卷时不该有分卷 .txt');
});

test('全书都没填卷名：只有一卷，同样不画分卷按钮', () => {
  const html = render(project({ chapters: [ch('c1', '一', '甲'), ch('c2', '二', '乙')] }));
  assert.equal(countOf(html, '分卷 .md'), 0);
  assert.equal(countOf(html, '分卷 .txt'), 0);
});

test('单文档模式：即使 chapters 里躺着两卷，也不画分卷按钮', () => {
  const single = project({ mode: 'single', draft: '雾比昨天更厚。' });
  assert.equal(splitByVolume(single.chapters ?? []).length, 2, '这份数据确实能切出两卷——按钮该由模式挡住，而不是靠数据凑巧');
  const html = render(single);
  assert.equal(countOf(html, '分卷 .md'), 0, '单文档模式不该有分卷 .md');
  assert.equal(countOf(html, '分卷 .txt'), 0, '单文档模式不该有分卷 .txt');
});

test('没有章节：不画分卷按钮', () => {
  const html = render(project({ chapters: [] }));
  assert.equal(countOf(html, '分卷 .md'), 0);
  assert.equal(countOf(html, '分卷 .txt'), 0);
});

test('新增的分卷按钮不能顶掉既有的「导出 .md / 导出 .txt」', () => {
  const html = render(project());
  assert.ok(html.includes('导出 .md'), '既有导出 .md 入口必须还在');
  assert.ok(html.includes('导出 .txt'), '既有导出 .txt 入口必须还在');
  assert.equal(countOf(html, '导出 .md'), 1, '导出 .md 不该被复制成两份');
  assert.equal(countOf(html, '导出 .txt'), 1);
});

// 界面提示（tooltip）走的是 displayVolumeName 那套口径：空卷名显示成「未分卷」。
// 这是「切卷按原文、展示按 trim + 占位」两层口径唯一的可见接缝，必须钉住
test('开头的卷没填卷名时，tooltip 显示「未分卷」而不是留一个空档', () => {
  const p = project({
    chapters: [ch('c1', '一', '甲'), ch('c2', '二', '乙'), ch('c3', '三', '丙', '第二卷 锈色海')],
  });
  assert.equal(splitByVolume(p.chapters ?? []).length, 2);
  const html = render(p);
  assert.ok(
    html.includes('按卷拆成 2 个 .md 文件：未分卷、第二卷 锈色海'),
    `空卷名该显示成占位名：${(html.match(/按卷拆成[^"]*/) || [''])[0]}`,
  );
  assert.ok(
    html.includes('按卷拆成 2 个 .txt 文件：未分卷、第二卷 锈色海（Windows 换行）'),
    'txt 按钮的 tooltip 同样要走占位名',
  );
  assert.equal(html.includes('按卷拆成 2 个 .md 文件：、第二卷'), false, '不许留一个空档');
});

// 切卷比的是卷名原文：' 第一卷 ' 与 '第一卷' 是两卷（与整书导出同口径），
// 但 tooltip 里两边都显示成 trim 后的「第一卷」——两层口径不许互相串味
//
// 注意：下面断言里的「第一卷、第一卷」是**刻意保留**的行为，不是待修的 bug，别顺手去重：
// 作者把卷名打歪（多打了首尾空白）这件事，tooltip 是他第一次能看见的地方；
// 真要消除误导，正确做法是把落盘后带 (1) 后缀的真实文件名回显给用户——
// 点完按钮的回执消息（WritingView.downloadByVolume 的 obsSync.setSyncMsg）本来就在列 f.name，
// 那条已经带着去重结果了。在 title 上做去重只会把问题藏到作者打开目录那一刻。
test('卷名只差首尾空白：切卷算两卷（tooltip 列 3 项），展示名却都是「第一卷」', () => {
  const p = project({
    chapters: [ch('c1', '一', '甲', ' 第一卷 '), ch('c2', '二', '乙', '第一卷'), ch('c3', '三', '丙', '第二卷')],
  });
  assert.equal(splitByVolume(p.chapters ?? []).length, 3, '切卷按原文，带空白与不带空白是两卷');
  const html = render(p);
  assert.ok(html.includes('按卷拆成 3 个 .md 文件：第一卷、第一卷、第二卷'), 'tooltip 里是 trim 后的展示名');
});

test('按钮出现条件与 splitByVolume 的卷数严格同频：≥2 卷才画，卷数变化立刻跟着变', () => {
  const shapes: Chapter[][] = [
    [],
    [ch('c1', '一', '甲')],
    [ch('c1', '一', '甲', '第一卷'), ch('c2', '二', '乙', '第一卷')],
    [ch('c1', '一', '甲', '第一卷'), ch('c2', '二', '乙', '第二卷')],
    [ch('c1', '一', '甲', '第一卷'), ch('c2', '二', '乙', '第二卷'), ch('c3', '三', '丙', '第三卷')],
  ];
  for (const chapters of shapes) {
    const volumes = splitByVolume(chapters).length;
    const html = render(project({ chapters }));
    const shown = countOf(html, '分卷 .md');
    assert.equal(shown, volumes > 1 ? 1 : 0, `${volumes} 卷时按钮该${volumes > 1 ? '出现' : '不出现'}，实际出现 ${shown} 次`);
    if (volumes > 1) {
      assert.ok(html.includes(`按卷拆成 ${volumes} 个 .md 文件`), `title 里的卷数该是 ${volumes}：${html.slice(0, 0)}`);
    }
  }
});
