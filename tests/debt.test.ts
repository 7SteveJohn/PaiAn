// 伏笔利息的锚点：账要算在「埋点章 → 最新已写章」这段真实的写作进程上，
// 新书不该被催、锚点丢了不该乱计息、掉出来的卡必须能被卡池正常消化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Project } from '../src/types';
import { DEBT_AGE, DEBT_LABEL, debtCards, hookDebts } from '../src/debt';

const mark = (id: string, over: Partial<{ text: string; chapterId: string; status: '埋下' | '回收'; expected: string; orphaned: boolean }> = {}) => ({
  id,
  type: '伏笔' as const,
  start: 0,
  end: 2,
  text: over.text ?? '铁锈纹的来处',
  status: over.status ?? '埋下',
  ...(over.chapterId ? { chapterId: over.chapterId } : {}),
  ...(over.expected ? { expected: over.expected } : {}),
  ...(over.orphaned ? { orphaned: true } : {}),
  createdAt: '',
});

const proj = (n: number, written: number, marks: Project['marks']): Project =>
  ({
    id: 'p',
    title: 't',
    type: '小说',
    status: '写作中',
    deadline: '',
    notes: '',
    draft: '',
    linkedIdeaIds: [],
    mode: 'chapters',
    createdAt: '',
    updatedAt: '',
    marks: marks as Project['marks'],
    chapters: Array.from({ length: n }, (_, i) => ({
      id: 'c' + (i + 1),
      title: '第' + (i + 1) + '章',
      content: i < written ? '字'.repeat(1000) : '',
      createdAt: '',
      updatedAt: '',
    })),
  }) as Project;

test('账按「埋点章 → 最新已写章」算，字数是读者真正等了多远', () => {
  const debts = hookDebts(proj(12, 12, [mark('m1', { chapterId: 'c2' })]));
  assert.equal(debts.length, 1);
  const d = debts[0];
  assert.equal(d.plantedAt, 2);
  assert.equal(d.age, 10, '第 2 章埋、写到第 12 章 = 挂了 10 章');
  assert.equal(d.words, 10000, '埋点之后写了第 3–12 章共 10 章 × 1000 字');
  assert.equal(d.level, 'late', `挂了 10 章该是「${DEBT_LABEL.late}」，实际 ${d.level}`);
});

test('已回收、空文本、新书不催账', () => {
  assert.deepEqual(hookDebts(proj(12, 12, [mark('m1', { chapterId: 'c2', status: '回收' })])), [], '回收过的不该再计息');
  assert.deepEqual(hookDebts(proj(12, 12, [mark('m1', { text: '   ', chapterId: 'c2' })])), [], '空文本不算一条伏笔');
  const fresh = hookDebts(proj(6, 1, [mark('m1', { chapterId: 'c1' })]));
  assert.equal(fresh[0].age, 0, '整本才写到埋点那一章，不该催');
  assert.equal(fresh[0].level, 'ok');
  assert.equal(hookDebts(proj(3, 3, [])).length, 0);
});

test('埋点章被删：算不出账就直说，不拿 0 章冒充新鲜', () => {
  const d = hookDebts(proj(10, 10, [mark('m1', { chapterId: 'c99' })]))[0];
  assert.equal(d.plantedAt, null);
  assert.equal(d.age, 0);
  assert.equal(d.words, 0);
  assert.equal(d.unanchored, true, '该带上「锚点丢了」的标记');
});

test('按严重程度排，越欠的越靠前', () => {
  const debts = hookDebts(
    proj(
      30,
      30,
      [mark('a', { text: '挂了二十章', chapterId: 'c1' }), mark('b', { text: '挂了五章', chapterId: 'c25' }), mark('c', { text: '刚埋', chapterId: 'c29' })]
    )
  );
  assert.deepEqual(debts.map((x) => x.level), ['lost', 'soon', 'ok'], debts.map((x) => x.level + x.age).join(' / '));
  assert.deepEqual(debts.map((x) => x.id), ['a', 'b', 'c']);
});

test('掉卡：只给该收的，id 稳定可去重，卡面说清挂了多久', () => {
  const debts = hookDebts(
    proj(
      30,
      30,
      [
        mark('a', { text: '铁锈纹的来处', chapterId: 'c1', expected: '第十二章揭一半' }),
        mark('b', { text: '钟声', chapterId: 'c26' }),
        mark('c', { text: '刚埋的', chapterId: 'c29' }),
      ]
    )
  );
  const cards = debtCards(debts, 3);
  assert.equal(cards.length, 2, `刚埋的该出局：${cards.map((c) => c.name).join(' / ')}`);
  assert.deepEqual(cards.map((c) => c.id), ['debt-a', 'debt-b'], 'id 必须由标记 id 决定，重复点不堆重复卡');
  assert.deepEqual(debtCards(debts, 3).map((c) => c.id), cards.map((c) => c.id));
  for (const c of cards) {
    assert.equal(c.effect, 'hook', '收线卡该落到本章「伏笔安排」，才会随前情注入 AI');
    assert.equal(c.series, '小事');
    assert.ok(c.name.startsWith('收线：') && c.name.length <= 30, c.name);
    assert.ok(/挂了 \d+ 章、约 \d+ 字/.test(c.payload), c.payload);
  }
  assert.ok(cards[0].payload.includes('第十二章揭一半'), '作者自己写的预期要带回卡面');
  assert.ok(!cards[1].payload.includes('预期'), '没写预期就别编');
  assert.equal(debtCards(debts, 1).length, 1, 'limit 要生效');
});
