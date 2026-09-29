// AI 提示词层拆出来之后第一次可测：重点是「拼出来的话对不对」与
// 「每章变化的信息有没有混进 system 开头」——后者一旦写错，批量续写的缓存会被整片打空。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Chapter, Project } from '../src/types';
import { AI_ACTIONS, JUDGED_ACTIONS, buildMessages, buildRunContext, isJudged } from '../src/ai-prompt';

const rules = [{ name: 'r', content: '不要用破折号', on: true }];
// 头尾各埋一句可辨认的话，断言「只喂末尾 1500 字」才有意义
const longBody = '开头独有的那句话。' + '雾港的雾不肯散，码头第七根缆桩边上一盏灯也没点。'.repeat(140) + '结尾独有的那句话。';
const chapter: Chapter = { id: 'c1', title: '第一章 到港', content: longBody, createdAt: '', updatedAt: '' };
const proj = (over: Partial<Project> = {}): Project =>
  ({
    id: 'p1',
    title: '长夜拾荒',
    type: '玄幻',
    status: '写作中',
    deadline: '',
    notes: '灵气枯竭的世界',
    draft: '单文档正文开头。' + '垫话一句接着一句。'.repeat(240) + '单文档正文结尾。',
    linkedIdeaIds: [],
    mode: 'chapters',
    chapters: [chapter],
    createdAt: '',
    updatedAt: '',
    ...over,
  }) as Project;


// ---------- AI 只判不写 ----------
test('只判不写：三个会代写的动作改成要判断，并明说不要成品正文', () => {
  const p = proj();
  for (const a of ['continue', 'polish', 'expand'] as const) {
    const [sys, user] = buildMessages(a, p, '选中的那句话，雾很大。', undefined, chapter, true);
    assert.ok(isJudged(a, true), a + ' 该被认成会代写的动作');
    assert.ok(sys.content.includes('【只判不写】'), a + ' 的 system 里该有那条约束：' + sys.content.slice(0, 120));
    assert.ok(sys.content.includes('写正文这件事只属于作者'), a + ' 的约束要说清立场');
    assert.ok(!/直接输出|接着写|续写约 300 字|润色后的文字|扩写后的文字/.test(user.content), a + ' 的用户指令还在要成稿：' + user.content.slice(0, 80));
    assert.ok(/判断|指出|给\d* ?3 个|3 种/.test(user.content), a + ' 该要判断与方向：' + user.content.slice(0, 80));
    assert.ok(user.content.includes('选中的那句话') || user.content.includes('结尾独有'), a + ' 还得把素材带上');
  }
  assert.deepEqual(JUDGED_ACTIONS.slice().sort(), ['continue', 'expand', 'polish']);
});

test('只判不写：分析类、拟题、改编类一律不动', () => {
  const p = proj();
  for (const a of ['title', 'outline', 'assoc', 'sensory', 'pov', 'tension', 'voice', 'gdialog', 'gquest', 'ggdd'] as const) {
    assert.equal(isJudged(a, true), false, a + ' 本来就不产出小说正文，不该被改');
    assert.deepEqual(buildMessages(a, p, '选中的那句话', undefined, chapter, true), buildMessages(a, p, '选中的那句话', undefined, chapter), a + ' 的提示词不该变');
  }
});

test('开关关掉就是逐字节照旧（别把默认行为改了）', () => {
  const p = proj();
  for (const a of ['continue', 'polish', 'expand', 'sensory'] as const) {
    assert.deepEqual(buildMessages(a, p, '选中的那句话', undefined, chapter, false), buildMessages(a, p, '选中的那句话', undefined, chapter));
    assert.deepEqual(buildMessages(a, p, '选中的那句话', undefined, chapter, undefined), buildMessages(a, p, '选中的那句话', undefined, chapter));
  }
  assert.equal(isJudged('continue', undefined), false, '默认必须是关');
});

test('只判不写时仍带得上作品语境与规则（判断也要认识这本书）', () => {
  const msgs = buildMessages('continue', proj(), '', [{ name: 'r', content: '不要用破折号', on: true }], chapter, true);
  assert.ok(msgs[0].content.includes('不要用破折号'), '规则该照旧注入');
  assert.ok(msgs[0].content.includes('灵气枯竭的世界'), '作品备注该照旧注入');
  assert.ok(msgs[0].content.indexOf('不要用破折号') < msgs[0].content.indexOf('【只判不写】'), '规则在前、约束紧随，别把每章变化的语境推到它们之前');
});

test('动作清单：游戏类不需要选区，其余按需标注', () => {
  const byKey = new Map(AI_ACTIONS.map((a) => [a.key, a]));
  assert.equal(byKey.get('polish')?.needSelection, true, '润色必须有选区');
  assert.equal(byKey.get('continue')?.needSelection, false, '续写不该要选区');
  assert.equal(byKey.get('gdialog')?.game, true);
  assert.ok(AI_ACTIONS.length >= 13, `动作数掉了：${AI_ACTIONS.length}`);
});

test('续写：只喂正文末尾 1500 字，规则与作品名进 system', () => {
  assert.ok(longBody.length > 1500, `样本得比 1500 字长才测得出截断，实际 ${longBody.length}`);
  const msgs = buildMessages('continue', proj(), '', rules, chapter);
  assert.ok(msgs[0].content.includes('不要用破折号'), '规则中心启用项要进 system');
  assert.ok(msgs[0].content.includes('《长夜拾荒》'), `system 要带作品名：${msgs[0].content.slice(0, 60)}`);
  assert.ok(msgs[1].content.includes('续写约 300 字'), `user 要说清干什么：${msgs[1].content.slice(0, 40)}`);
  assert.ok(msgs[1].content.includes('结尾独有的那句话。'), '末尾要带给模型');
  assert.ok(!msgs[1].content.includes('开头独有的那句话。'), '1500 字之外的开头不该被塞进去');
});

test('同输入逐字节稳定；每章变化的只准出现在语境块里，不能污染开头', () => {
  const a = buildMessages('continue', proj(), '', rules, chapter);
  assert.deepEqual(buildMessages('continue', proj(), '', rules, chapter), a, '同一章重复拼装必须逐字节一致（缓存命中的前提）');
  // 换一章：前情/本章要点本就不同，但开头的身份指令段必须一字不动
  const b = buildMessages('continue', proj(), '', rules, { ...chapter, id: 'c2', title: '第二章 卸货' });
  assert.equal(b[0].content.slice(0, 60), a[0].content.slice(0, 60), 'system 开头被章序打散了，前缀缓存会整片落空');
  assert.notEqual(a[0].content, b[0].content, '不同章的前情确实不同——别装作一样');
  // 拟大纲这类不带章的任务，system 应当整段与章无关
  const o1 = buildMessages('outline', proj(), '', rules, chapter);
  const o2 = buildMessages('outline', proj(), '', rules, null);
  assert.equal(o1[1].content, o2[1].content, '拟大纲的 user 任务不该受当前章影响');
});

test('分析类动作保持「辅助不替代」：明写不要代写', () => {
  const sel = '「你认得这道纹。」她盯着他的手。';
  const want: Record<string, string> = {
    assoc: '不要写成句子',
    sensory: '不要替我写成句',
    pov: '不要改写原文',
    tension: '不要替我写台词',
    voice: '不要生成新台词',
  };
  for (const [key, phrase] of Object.entries(want)) {
    const m = buildMessages(key as never, proj(), sel, rules, chapter);
    assert.ok(m[1].content.includes(sel), `${key} 应把选区带给模型`);
    assert.ok(m[1].content.includes(phrase), `${key} 的话术该保住「${phrase}」这条边界：${m[1].content}`);
  }
});

test('语境卡：说清这次到底接在哪段文本上', () => {
  const doc = longBody;
  const c = buildRunContext('continue', doc, { start: 0, end: 0 }, chapter.title);
  assert.equal(c.kind, 'tail');
  assert.equal(c.range?.[1], doc.length, '续写接在正文末尾');
  assert.equal(c.snippet, doc.slice(-1500));
  assert.equal(c.chapterTitle, chapter.title, '语境卡要说是哪一章');
  assert.equal(buildRunContext('title', doc, { start: 0, end: 0 }).kind, 'head', '拟标题看开头');
  const none = buildRunContext('outline', doc, { start: 0, end: 0 });
  assert.equal(none.kind, 'none');
  assert.equal(none.range, null, '拟大纲不带正文，就别谎称带了');
  const sel = buildRunContext('polish', doc, { start: 3, end: 9 }, chapter.title);
  assert.equal(sel.kind, 'selection');
  assert.equal(sel.snippet, doc.slice(3, 9));
  assert.equal(buildRunContext('polish', doc, { start: 0, end: 0 }).snippet, '', '没选区就明说没有');
  const game = buildRunContext('gdialog', doc, { start: 0, end: 0 });
  assert.equal(game.kind, 'chapter', '游戏改编类吃整章');
  assert.equal(game.snippet, doc.slice(0, 3000));
});

test('没有本章（单文档项目）也能拼出可用的续写请求', () => {
  const p = proj({ mode: undefined, chapters: undefined });
  const msgs = buildMessages('continue', p, '', rules, null);
  assert.ok(msgs[1].content.includes('本文'), `无章时用「本文」指代：${msgs[1].content.slice(0, 30)}`);
  assert.ok(msgs[1].content.includes('单文档正文结尾。'), 'user 里要带正文末尾');
  assert.ok(!msgs[1].content.includes('单文档正文开头。'), '同样只给末尾，不整篇灌进去');
});
