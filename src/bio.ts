// 角色人生经历：把一个人散在各章的出场压成一段「他经历了什么」的连贯叙述。
// 证据是确定性提取的——只收出现他名字的章、只摘含他名字的段落；AI 只负责把这些证据讲成一段话。
// 跟「出场记忆」的分工：那是按章逐条记流水（log），这是跨章汇总成一段（bio）。
import type { Chapter, Character, Project } from './types';

// 三道上限：单章摘几段、每段多长、全书证据总共多少字——够讲清一个人，也不会撑爆上下文
const SNIPPETS_PER_CHAPTER = 6;
const SNIPPET_MAX = 220;
const EVIDENCE_TOTAL = 4000;
export const BIO_MAX = 600;

export interface BioEvidence {
  chapterId: string;
  no: number; // 已写章里的序号（跟琴键一格一章同一把尺子）
  title: string;
  gist: string; // 本章梗概/要点，给模型章节语境
  snippets: string[]; // 只含该角色名字的段落
}

export interface BioMessages {
  role: 'system' | 'user';
  content: string;
}

const castOf = (chapter: Chapter, name: string): boolean =>
  (chapter.cast ?? '')
    .split(/[、,，;；\n]/)
    .map((s) => s.trim())
    .includes(name);

/**
 * 某角色在正文里的出场证据。只收真的出现了他名字的章——章节 cast 名单点名但正文没提名字的，
 * 只带本章梗概进来，不摘段落：宁可少给证据，也不把别人的段落算到他头上。
 */
export function bioEvidence(project: Project, name: string): BioEvidence[] {
  const key = name.trim();
  if (!key) return [];
  const written = (project.chapters ?? []).filter((c) => (c.content ?? '').trim());
  const out: BioEvidence[] = [];
  let budget = EVIDENCE_TOTAL;
  written.forEach((c, i) => {
    if (budget <= 0) return;
    const body = c.content ?? '';
    const hits = body
      .split(/\n+/)
      .map((s) => s.trim())
      .filter((s) => s.includes(key))
      .slice(0, SNIPPETS_PER_CHAPTER)
      .map((s) => s.slice(0, SNIPPET_MAX));
    if (!hits.length && !castOf(c, key)) return; // 这章既没提他、名单也没他：不算出场
    const gist = ((c.summary || c.beats || '').trim() || c.title || '').slice(0, 160);
    const cost = gist.length + hits.reduce((s, x) => s + x.length, 0);
    if (cost > budget) return; // 预算装不下这一章就跳过，后面更短的章还有机会
    budget -= cost;
    out.push({ chapterId: c.id, no: i + 1, title: c.title, gist, snippets: hits });
  });
  return out;
}

// rules 传 rulesSuffix(aiInfo.rules) 拼好的文风规则后缀，跟其它 AI 入口同一把尺子
export function buildBioMessages(c: Character, evidence: BioEvidence[], rules = ''): BioMessages[] {
  const log = (c.log ?? []).map((x) => `· ${x.text}`).join('\n') || '（暂无）';
  const rels = (c.relations ?? []).map((r) => `${r.with}：${r.note}`).join('；') || '（暂无）';
  const body = evidence
    .map((e) => `【第${e.no}章 ${e.title}】\n${e.gist ? `要点：${e.gist}\n` : ''}${e.snippets.length ? e.snippets.map((s) => `- ${s}`).join('\n') : '（本章只在出场名单里，正文未提名字）'}`)
    .join('\n\n');
  const system =
    '你是网文作品资料库的整理员。给你一个角色的现有记录与各章出场证据，把他迄今为止的经历讲成一段连贯的话。\n' +
    '规则：\n' +
    '1. 只写证据里有的事，禁止脑补、禁止补前传、禁止预言后续。\n' +
    '2. 按章节先后串成经历（他遇上什么、做了什么、变成什么样），不要罗列要点、不要分条。\n' +
    '3. 用第三人称写这个角色，一段到底，中文，克制不煽情，' + BIO_MAX + ' 字以内。\n' +
    '4. 只输出这段经历本身，不要标题、不要解释、不要 markdown。' + rules;
  const user =
    `【角色】${c.name}\n` +
    `【当前心理状态】${c.state || '（未填）'}\n` +
    `【当前境界/战力】${c.power || '（未填）'}\n` +
    `【已知关系】${rels}\n` +
    `【已记履历流水】\n${log}\n\n` +
    `【各章出场证据】\n${body || '（正文里找不到他）'}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 模型返回的原文清洗：去代码围栏与首尾引号、压掉多余空行、限长。解不出内容就留空。 */
export function sanitizeBio(text: string): string {
  if (!text) return '';
  let t = text.trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '');
  t = t.replace(/^["'「『]|["'」』]$/g, '').trim();
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.slice(0, BIO_MAX).trim();
}
