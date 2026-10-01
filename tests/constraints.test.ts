// 约束求值的回归锚点：达成率必须可解释（每项给当前值）、对白不参与叙述类判定、
// 空正文一律算没达成（不能因为「没有超长句」就白送一张点亮）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe, evaluate, mergeConstraints, summarize, asRuleText, type Constraint } from '../src/constraints';
import { DESLOP_RULES } from '../src/deslop';
import { BASE_CARDS } from '../src/cards';

const kinds = (list: Constraint[]) => list.map((c) => c.kind);
const item = (list: Constraint[], text: string, label: string) => {
  const found = evaluate(text, list).items.find((i) => i.label.includes(label));
  assert.ok(found, `报告里应有「${label}」，实际：${evaluate(text, list).items.map((i) => i.label).join(' / ')}`);
  return found!;
};

test('any / absent：与 litCheck 共用的两种基础条件', () => {
  const list = describe({ name: 'x', any: ['放下', '留在'], absent: ['很多'] });
  assert.deepEqual(kinds(list), ['any', 'absent']);
  assert.equal(item(list, '他放下了包。', '写出').ok, true);
  assert.equal(item(list, '他走了。', '写出').ok, false);
  assert.equal(item(list, '他走了。', '不出现').ok, true);
  assert.equal(item(list, '那里有很多人。', '不出现').ok, false);
  assert.match(item(list, '那里有很多人。', '不出现').detail, /还留着/);
});

test('maxSentence：只量叙述句，对白里的长句不算；空正文不给通过', () => {
  const list: Constraint[] = [{ kind: 'maxSentence', chars: 18 }];
  assert.equal(item(list, '雾来了。船在汽笛里靠岸。', '18 字').ok, true);
  assert.equal(item(list, '雾从海面一路漫过来，漫过缆桩，漫过湿透的缆绳，最后停在栈桥尽头。', '18 字').ok, false);
  const quoted = item(list, '她抬起头说：「我今晚不想再听你解释这一整晚为什么迟迟不肯靠岸的缘由了。」', '18 字');
  assert.equal(quoted.ok, true, `对白里的长句不该算：${quoted.detail}`);
  assert.equal(item(list, '', '18 字').ok, false, '空正文不能白送达成');
  assert.match(item(list, '他把话说得太长了这一句明显超过了十八个字的限制所以应当被挑出来。', '18 字').detail, /1 句超长/);
});

test('dialogueShare：区间两端都算边界内，空正文不达成', () => {
  const min: Constraint[] = [{ kind: 'dialogueShare', min: 50 }];
  const max: Constraint[] = [{ kind: 'dialogueShare', max: 10 }];
  const talk = '「你走。」她说。「我今晚不送。」'.repeat(6) + '雾很厚。';
  assert.equal(item(min, talk, '50%').ok, true);
  assert.equal(item(max, talk, '10%').ok, false);
  assert.equal(item(max, '汽笛响了三声，她把灯挪近一步。', '10%').ok, true);
  assert.equal(item(min, '', '50%').ok, false);
});

test('pronounOpen：段首「他/她」按段计数，引号开场的段落不算', () => {
  const list: Constraint[] = [{ kind: 'pronounOpen', max: 1 }];
  const text = '他站起来。\n她也站起来。\n「他说的不算。」她补了一句。\n码头上的灯次第灭了。';
  const got = item(list, text, '≤ 1 段');
  assert.equal(got.ok, false);
  assert.match(got.detail, /现在 2 段/);
  assert.equal(item(list, '他站起来。\n雾把灯吞了。', '≤ 1 段').ok, true);
});

test('deslopMax：计数口径与 AI 味扫描完全一致', () => {
  const text = '他不是不怕，是没有时间怕。她笑了一下。';
  const list: Constraint[] = [{ kind: 'deslopMax', key: 'not-but', count: 0 }];
  assert.equal(item(list, text, '不是A，而是B').ok, false);
  assert.equal(item(list, '他站起来，走了。', '不是A，而是B').ok, true);
  assert.equal(item(list, '不是走，是跑。', '不是A，而是B').ok, false);
});

test('零条件卡：evaluate 与 litCheck 必须同一口径（落地即达成），否则永远挂在「进行中」', () => {
  const empty = evaluate('随便什么正文。', []);
  assert.equal(empty.total, 0);
  assert.equal(empty.done, true, '没有条件就是已经达成——这个判据和 litCheck 的「落地即点亮」必须一致');
  const r = evaluate('', [{ kind: 'maxSentence', chars: 20 }]);
  assert.equal(r.done, false, '正文为空时不能因为「没有超长句」白送达成');
});

test('未知条件：不抛异常，明确说不认识', () => {
  const r = evaluate('随便一句。', [{ kind: '会读心术' } as unknown as Constraint]);
  assert.equal(r.total, 1);
  assert.equal(r.items[0].ok, false);
  assert.match(r.items[0].detail, /不认识/);
});

test('汇总文本：卡面摘要与注入 AI 的规则各管一半', () => {
  const list = describe({ name: 'x', any: ['放下'], constraints: [{ kind: 'maxSentence', chars: 20 }, { kind: 'dialogueShare', min: 55 }] });
  assert.equal(summarize(list), '需出现：放下 · 叙述句≤20字 · 对白≥55%');
  const rule = asRuleText(list);
  assert.match(rule, /叙述句控制在 20 字以内/);
  assert.match(rule, /对白要占到全章 55%/);
  assert.ok(!rule.includes('放下'), '词表类条件不进规则文本（正文已有浅灰提醒）');
  assert.equal(asRuleText(describe({ name: 'y', absent: ['很多'] })), '', '纯词表卡不必打扰 AI');
});

test('全卡池自洽：每条约束都能求值，引用到的 AI 味规则真实存在', () => {
  const ruleKeys = new Set(DESLOP_RULES.map((r) => r.key));
  const legal = ['any', 'absent', 'maxSentence', 'dialogueShare', 'pronounOpen', 'deslopMax'];
  for (const card of BASE_CARDS) {
    const list = describe(card);
    for (const c of list) {
      assert.ok(legal.includes(c.kind), `${card.id} 用了不支持的条件类型 ${c.kind}`);
      if (c.kind === 'deslopMax') assert.ok(ruleKeys.has(c.key), `${card.id} 引用了不存在的 AI 味规则 ${c.key}`);
      if (c.kind === 'maxSentence') assert.ok(c.chars >= 8 && c.chars <= 120, `${card.id} 句长上限不合理`);
      if (c.kind === 'dialogueShare') assert.ok(c.min !== undefined || c.max !== undefined, `${card.id} 对白占比没给边界`);
    }
    assert.doesNotThrow(() => evaluate('雾来了。他不是不怕，是没有时间怕。', list), `${card.id} 求值抛异常`);
  }
  const 练笔 = BASE_CARDS.filter((c) => c.series === '练笔');
  assert.ok(练笔.length >= 6, '练笔系列要有份量，否则达成率只是点缀');
  for (const c of 练笔) assert.ok(describe(c).length >= 1, `练笔卡 ${c.id} 没有可判定条件，不配进这个系列`);
});

test('性能：一页纸正文跑全套条件仍在亚毫秒级', () => {
  const chapter = ('雾从海面漫过来，漫过缆桩。'.repeat(80) + '他不是不怕，是没有时间怕。\n').slice(0, 2500);
  const list = describe({ name: 'all', any: ['雾'], absent: ['很多'], constraints: [{ kind: 'maxSentence', chars: 20 }, { kind: 'dialogueShare', min: 10 }, { kind: 'pronounOpen', max: 2 }, { kind: 'deslopMax', key: 'not-but', count: 0 }] });
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) evaluate(chapter, list);
  const ms = (performance.now() - t0) / 50;
  assert.ok(ms < 3, `单章一次求值应在亚毫秒级，实测 ${ms.toFixed(2)}ms`);
});

test('两卡条件下酒：同维度取宽松一侧并说明谁让了步，不同维度全部保留', () => {
  const a: Constraint[] = [{ kind: 'maxSentence', chars: 18 }, { kind: 'dialogueShare', min: 55 }, { kind: 'any', words: ['放下'] }];
  const b: Constraint[] = [{ kind: 'maxSentence', chars: 24 }, { kind: 'dialogueShare', max: 8 }, { kind: 'absent', words: ['很多'] }, { kind: 'deslopMax', key: 'not-but', count: 0 }];
  const m = mergeConstraints(a, b);
  assert.equal(m.list.filter((c) => c.kind === 'maxSentence').length, 1);
  assert.equal((m.list.find((c) => c.kind === 'maxSentence') as { chars: number }).chars, 24, '句长取更宽的一侧');
  const share = m.list.find((c) => c.kind === 'dialogueShare') as { min: number; max: number };
  assert.equal(share.min, 0);
  assert.equal(share.max, 100, '一张要话多一张要话少 → 取两头并集');
  assert.equal(m.yielded.length, 2, '两处让步都要回传给卡面');
  assert.ok(m.yielded.some((y) => y.includes('话多')));
  assert.equal(m.list.filter((c) => c.kind === 'any').length, 1);
  assert.equal(m.list.filter((c) => c.kind === 'absent').length, 1);
  assert.equal(m.list.filter((c) => c.kind === 'deslopMax').length, 1);
  // 合并后的组合必须整体可达成：把每一项逐个满足一遍就该点亮
  const done = evaluate('她放下了包。那里三个人，两里地。', m.list);
  assert.equal(done.total, 5, `条件应全部带上，实际 ${done.items.map((i) => i.label).join(' / ')}`);
});

test('同向条件不冲突时不该谎报让步', () => {
  const m = mergeConstraints([{ kind: 'maxSentence', chars: 20 }], [{ kind: 'maxSentence', chars: 20 }, { kind: 'pronounOpen', max: 1 }]);
  assert.deepEqual(m.yielded, []);
  assert.equal(m.list.length, 2);
});
