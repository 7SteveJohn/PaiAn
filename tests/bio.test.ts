// 人生经历提炼的锚点：证据只收真提了名字的章、段落与总量都有上限、prompt 带上履历流水、
// 模型回来的废话要被洗掉。这几条飘了，人物卡上就会多出一段编的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Chapter, Character, Project } from '../src/types';
import { BIO_MAX, bioEvidence, buildBioMessages, sanitizeBio } from '../src/bio';

const ch = (id: string, content: string, over: Partial<Chapter> = {}): Chapter =>
  ({ id, title: '第' + id + '章', content, createdAt: '', updatedAt: '', ...over }) as Chapter;

const proj = (chapters: Chapter[], characters: Character[] = []): Project =>
  ({ id: 'p', title: 't', type: '小说', status: '写作中', deadline: '', notes: '', draft: '', linkedIdeaIds: [], createdAt: '', updatedAt: '', mode: 'chapters', chapters, characters }) as Project;

const lin: Character = { id: 'k1', name: '林越', state: '起疑', log: [{ at: '2026-09-01 10:00', text: '认出铁锈纹' }], relations: [{ with: '阿禾', note: '欠她一条命' }], power: '筑基' };

test('证据只收出现他名字的章，无名无名单的章不算出场', () => {
  const p = proj([
    ch('c1', '林越沿着码头走。\n他蹲下来看那道纹。'),
    ch('c2', '雾从板缝里挤进来，灯芯压成一团青蓝。'),
    ch('c3', '「别再往前了。」阿禾说。\n林越抬头。'),
  ]);
  const ev = bioEvidence(p, '林越');
  assert.deepEqual(ev.map((e) => e.chapterId), ['c1', 'c3'], `第 2 章没提林越：${JSON.stringify(ev)}`);
  assert.ok(ev[0].snippets.every((s) => s.includes('林越')), '摘的段落必须含他名字');
  assert.ok(ev[0].snippets.length === 1, `第 1 章只有一段提到他：${JSON.stringify(ev[0].snippets)}`);
});

test('章号按已写章重排：空章不占位', () => {
  const p = proj([ch('c1', '林越来了。'), ch('c2', '   '), ch('c3', '林越又来了。')]);
  assert.deepEqual(bioEvidence(p, '林越').map((e) => e.no), [1, 2]);
});

test('出场名单点名但正文没提名字：带本章梗概进来，不摘段落', () => {
  const p = proj([ch('c1', '雾散了一角，港里的钟又响了。', { cast: '林越', summary: '林越在钟声里做了决定' })]);
  const ev = bioEvidence(p, '林越');
  assert.equal(ev.length, 1, '名单里有他就该算这一章');
  assert.deepEqual(ev[0].snippets, [], '正文没提名字就不许摘段落：' + JSON.stringify(ev[0].snippets));
  assert.ok(ev[0].gist.includes('钟声'), '本章梗概要带进来：' + ev[0].gist);
});

test('长书有预算：单章段数封顶，全书证据不超总量', () => {
  const one = Array.from({ length: 40 }, (_, i) => `第${i}段提到林越的${'字'.repeat(120)}`).join('\n');
  const many = Array.from({ length: 60 }, (_, i) => ch('c' + i, one));
  const ev = bioEvidence(proj(many), '林越');
  assert.ok(ev.length < 60, `证据章数该被预算截住：${ev.length}`);
  assert.ok(ev.every((e) => e.snippets.length <= 6), '单章最多 6 段');
  const total = ev.reduce((s, e) => s + e.gist.length + e.snippets.reduce((a, x) => a + x.length, 0), 0);
  assert.ok(total <= 4000, `证据总长该封顶：${total}`);
});

test('没出场的人与空名字都不该报错', () => {
  const p = proj([ch('c1', '林越来了。')]);
  assert.deepEqual(bioEvidence(p, '阿禾'), []);
  assert.deepEqual(bioEvidence(p, ''), []);
  assert.deepEqual(bioEvidence(proj([]), '林越'), []);
});

test('prompt：带上履历流水、关系与文风规则，证据按章排列', () => {
  const p = proj([ch('c1', '林越蹲下来看那道纹。')]);
  const msgs = buildBioMessages(lin, bioEvidence(p, '林越'), '\n\n【写作规则（必须遵守）】\n1. 别写废话');
  assert.equal(msgs.length, 2);
  assert.ok(msgs[0].content.includes('只写证据里有的事'), 'system 要说清不许脑补');
  assert.ok(msgs[0].content.includes('别写废话'), '文风规则要带上');
  assert.ok(msgs[1].content.includes('林越'), 'user 要有角色名');
  assert.ok(msgs[1].content.includes('认出铁锈纹'), '已记的履历流水要喂进去');
  assert.ok(msgs[1].content.includes('欠她一条命'), '已知关系要喂进去');
  assert.ok(msgs[1].content.includes('第1章'), '证据要标章号');
  // 没证据时也要能组出 prompt（UI 会在调用前拦，但函数本身不该炸）
  assert.ok(buildBioMessages(lin, []).length === 2);
});

test('模型回文清洗：去围栏与首尾引号、压空行、限长', () => {
  assert.equal(sanitizeBio('```\n他自幼在码头长大。\n```'), '他自幼在码头长大。');
  assert.equal(sanitizeBio('"他自幼在码头长大。"'), '他自幼在码头长大。');
  assert.equal(sanitizeBio('一。\n\n\n\n二。'), '一。\n\n二。');
  assert.equal(sanitizeBio(''), '');
  assert.equal(sanitizeBio('   '), '');
  assert.ok(sanitizeBio('字'.repeat(900)).length === BIO_MAX, '超长一律截到上限');
});
