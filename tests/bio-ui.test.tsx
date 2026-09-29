// 人物卡上的「人生经历」渲染接缝：字段要画出来、已有值要回填、AI 没配时按钮要禁用。
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AIPublic, Project } from '../src/types';
import ProjectDrawer from '../src/components/ProjectDrawer';

const el = React.createElement;

const project = (chars: { name: string; bio?: string }[]): Project =>
  ({
    id: 'p',
    title: '雾港',
    type: '玄幻',
    status: '写作中',
    deadline: '',
    notes: '',
    draft: '',
    linkedIdeaIds: [],
    createdAt: '',
    updatedAt: '',
    mode: 'chapters',
    chapters: [{ id: 'c1', title: '第一章', content: '林越沿着码头走。', cast: '林越', createdAt: '', updatedAt: '' }],
    characters: chars.map((c, i) => ({ id: 'k' + i, name: c.name, state: '', log: [], relations: [], ...(c.bio ? { bio: c.bio } : {}) })),
  }) as Project;

const ai = (over: Partial<AIPublic> = {}): AIPublic => ({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:8b', hasKey: false, ready: true, rules: [], ...over });

const render = (p: Project, aiInfo: AIPublic) =>
  renderToStaticMarkup(
    el(ProjectDrawer, {
      project: p,
      ideas: [],
      aiInfo,
      tab: '人物',
      onTab: () => {},
      onClose: () => {},
      onUpdate: () => {},
      onJump: () => {},
      onInsert: () => {},
    }),
  );

test('人物卡画出人生经历区，已有经历回填，可手改', () => {
  const html = render(project([{ name: '林越', bio: '自幼在码头长大，认得铁锈纹。' }]), ai());
  assert.ok(html.includes('人生经历'), '要有这一块');
  assert.ok(html.includes('自幼在码头长大'), '已有经历要回填进输入框');
  assert.ok(html.includes('AI 提炼'), '要有提炼按钮');
  assert.ok(/<textarea[^>]*char-bio-text/.test(html), `该是可改的多行框：${(html.match(/<textarea[^>]*/) || [''])[0]}`);
});

test('AI 没配好：提炼按钮禁用并给出原因，别让人白点', () => {
  const html = render(project([{ name: '林越' }]), ai({ ready: false }));
  assert.ok(html.includes('AI 提炼'), '按钮还在，只是不可点');
  assert.ok(/<button[^>]*disabled/.test(html), '未配好 AI 时该禁用：' + (html.match(/<button[^>]*AI[^>]*/) || [''])[0]);
  assert.ok(html.includes('先在设置页配好 AI'), '要说明为什么点不了');
});
