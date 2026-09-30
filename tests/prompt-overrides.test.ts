// 提示词开放成 md 文件：promptOf 的回退/覆盖语义，以及 buildMessages / buildDraftMessages 接受覆盖后行为不变。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Chapter, Project } from '../src/types';
import { PROMPT_DEFS, buildDraftMessages, buildMessages, promptOf } from '../src/ai-prompt';

const rules = [{ name: '文风', content: '句子要短', on: true }];
const chapter: Chapter = { id: 'c1', title: '第一章 到港', content: '雾港的雾不肯散。', createdAt: '', updatedAt: '' };
const proj = (): Project =>
  ({
    id: 'p1',
    title: '长夜拾荒',
    type: '玄幻',
    status: '写作中',
    deadline: '',
    notes: '灵气枯竭的世界',
    draft: '单文档正文。',
    linkedIdeaIds: [],
    mode: 'chapters',
    chapters: [chapter],
    createdAt: '',
    updatedAt: '',
  }) as Project;

test('promptOf：无覆盖回退内置默认，覆盖生效，空白覆盖回退默认', () => {
  const advisor = PROMPT_DEFS.find((d) => d.key === 'advisor')!;
  assert.equal(promptOf('advisor'), advisor.fallback);
  assert.equal(promptOf('chat', { chat: '自定义身份' }), '自定义身份');
  assert.equal(promptOf('chat', { chat: '   ' }), PROMPT_DEFS.find((d) => d.key === 'chat')!.fallback);
  assert.ok(PROMPT_DEFS.length === 4, '四个入口：advisor / advisor-judge / draft / chat');
});

test('buildMessages：覆盖 advisor 身份句后，workName 占位符被回填，规则与语境照旧', () => {
  const p = proj();
  const msgs = buildMessages('polish', p, '选中的句子', rules, chapter, false, { advisor: '你是{workName}的守夜人。' });
  assert.ok(msgs[0].content.startsWith('你是玄幻《长夜拾荒》的守夜人。'), msgs[0].content.slice(0, 60));
  assert.ok(msgs[0].content.includes('句子要短'), '写作规则照旧注入');
  assert.ok(msgs[0].content.includes('【当前章节】第一章 到港'), '章名尾巴照旧');
});

test('buildMessages：不带覆盖时逐字节照旧（别把默认行为改了）', () => {
  const p = proj();
  assert.deepEqual(
    buildMessages('polish', p, '选中的句子', rules, chapter, false, {}),
    buildMessages('polish', p, '选中的句子', rules, chapter),
  );
  const judged = buildMessages('continue', p, '', rules, chapter, true, { 'advisor-judge': '只给判断。' });
  assert.ok(judged[0].content.startsWith('只给判断。'), judged[0].content.slice(0, 40));
});

test('buildDraftMessages：覆盖 draft 后 system 用覆盖文本并回填 {type}/{title}', () => {
  const p = proj();
  const msgs = buildDraftMessages(p, chapter, 1000, rules, { draft: '写{type}《{title}》初稿。' });
  assert.ok(msgs[0].content.startsWith('写玄幻《长夜拾荒》初稿。'), msgs[0].content.slice(0, 40));
  assert.ok(msgs[0].content.includes('【本次任务】撰写「第一章 到港」一章。'), '任务尾巴照旧');
  const plain = buildDraftMessages(p, chapter, 1000, rules);
  assert.ok(plain[0].content.includes('撰写章节正文初稿'), '默认走内置文案');
});
