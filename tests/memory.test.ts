// 出场记忆核心逻辑单测：解析 / 清洗 / 合并 / prompt 组装
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, sanitizeMemories, applyMemories, buildExtractMessages } from '../src/memory';

const TEXT = '林越蹲在锈轨城北的断轨旁。阿禾从背后喊他：“三不拾。”铁鸦在不远处冷笑。';

test('extractJson：容忍 ```json 围栏与前后废话', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('好的，结果如下：\n\n{"memories":[{"name":"林越"}]}\n\n以上。'), { memories: [{ name: '林越' }] });
  assert.deepEqual(extractJson('{"a":1} {"b":2}'), { a: 1 }); // 取第一对花括号
  assert.equal(extractJson('完全不是 JSON'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson('{"a":}'), null); // 非法 JSON
});

test('清洗：正文没出场的新角色被丢弃（防脑补）', () => {
  const raw = { memories: [{ name: '苏晚', isNew: true, state: '城主的女儿' }] };
  const r = sanitizeMemories(raw, TEXT, []);
  assert.equal(r.memories.length, 0);
  assert.ok(r.skipped.some((s) => s.includes('苏晚')));
});

test('清洗：已建档的老角色允许不进正文（名册兜底），且自动标记非新角色', () => {
  const raw = { memories: [{ name: '林越', changeNote: '对阿禾说了实话' }] };
  const r = sanitizeMemories(raw, TEXT, ['林越']);
  assert.equal(r.memories.length, 1);
  assert.equal(r.memories[0].isNew, false);
});

test('清洗：新角色必须在正文真实出场', () => {
  const raw = { memories: [{ name: '阿禾', isNew: true, changeNote: '救了林越一命' }] };
  const r = sanitizeMemories(raw, TEXT, []);
  assert.equal(r.memories.length, 1);
  assert.ok(r.memories[0].isNew);
});

test('清洗：字段限长与空值剔除', () => {
  const longNote = '长'.repeat(500);
  const raw = { memories: [{ name: '林越', state: '  ', changeNote: longNote }] };
  const r = sanitizeMemories(raw, TEXT, ['林越']);
  assert.equal(r.memories.length, 1);
  assert.equal(r.memories[0].changeNote?.length, 200);
  assert.equal(r.memories[0].state, undefined);
});

test('清洗：world 只收白名单 kind 且必须出现在正文', () => {
  const good = { memories: [{ name: '林越', isNew: true, changeNote: 'x', world: { name: '锈轨城', kind: '地点', content: '末法时代的边陲废城' } }] };
  const badKind = { memories: [{ name: '林越', isNew: true, changeNote: 'x', world: { name: '锈轨城', kind: '随便什么', content: 'x' } }] };
  const offstage = { memories: [{ name: '林越', isNew: true, changeNote: 'x', world: { name: '云顶城', kind: '地点', content: '没在正文出现' } }] };
  assert.equal(sanitizeMemories(good, TEXT, []).memories[0].world?.name, '锈轨城');
  assert.equal(sanitizeMemories(badKind, TEXT, []).memories[0].world, undefined);
  assert.equal(sanitizeMemories(offstage, TEXT, []).memories[0].world, undefined);
});

test('清洗：同章同名去重、总量封顶 8', () => {
  const list = Array.from({ length: 20 }, (_, i) => ({ name: i % 2 ? '林越' : '阿禾', isNew: true, changeNote: 'x' + i }));
  const r = sanitizeMemories({ memories: list }, TEXT, []);
  assert.equal(r.memories.length, 2);
});

test('合并：老角色状态/战力/关系/履历全部走不可变合并', () => {
  const proj = {
    characters: [
      {
        id: 'c1', name: '林越', state: '停滞在炼气二层', log: [{ at: 't0', text: '开篇' }],
        relations: [{ with: '阿禾', note: '救命恩人' }], power: '炼气二层', powerLog: [],
      },
    ],
    worldItems: [{ id: 'w1', name: '锈轨城', kind: '地点' as const, content: '旧城' }],
  };
  const mems = [
    {
      name: '林越', isNew: false, state: '刚突破炼气三层', changeNote: '掌心发烫，气机松动',
      power: '炼气三层', powerNote: '突破小境界', relations: [{ with: '铁鸦', note: '立场对立' }],
    },
  ];
  const out = applyMemories(proj, mems as never, 'ch9');
  assert.notEqual(out.characters, proj.characters); // 不可变
  assert.equal(proj.characters[0].state, '停滞在炼气二层'); // 原对象未被污染
  const c = out.characters[0];
  assert.equal(c.state, '刚突破炼气三层');
  assert.equal(c.log.length, 2);
  assert.equal(c.log[1].text, '掌心发烫，气机松动');
  assert.equal(c.power, '炼气三层');
  assert.deepEqual(c.powerLog, [{ chapterId: 'ch9', text: '突破小境界' }]);
  assert.equal(c.relations.length, 2); // 既有保留 + 新增
  assert.equal(out.touched, 1);
});

test('合并：同名同 note 的关系不重复追加', () => {
  const proj = {
    characters: [{ id: 'c1', name: '林越', state: 'a', log: [], relations: [{ with: '阿禾', note: '救命恩人' }] }],
    worldItems: [],
  };
  const mems = [{ name: '林越', isNew: false, changeNote: 'x', relations: [{ with: '阿禾', note: '救命恩人' }] }];
  const out = applyMemories(proj, mems as never, 'ch1');
  assert.equal(out.characters[0].relations.length, 1);
});

test('合并：新角色建档需要实质内容，空壳不入库', () => {
  const proj = { characters: [], worldItems: [] };
  const empty = applyMemories(proj, [{ name: '阿禾', isNew: true }] as never, 'ch1');
  assert.equal(empty.characters.length, 0);
  const real = applyMemories(proj, [{ name: '阿禾', isNew: true, changeNote: '登场救下林越' }] as never, 'ch1');
  assert.equal(real.characters.length, 1);
  assert.equal(real.characters[0].state, '');
  assert.equal(real.characters[0].log[0].text, '登场救下林越');
});

test('合并：世界设定去重且只加不删', () => {
  const proj = {
    characters: [],
    worldItems: [{ id: 'w1', name: '锈轨城', kind: '地点' as const, content: '旧城' }],
  };
  const mems = [
    { name: '林越', isNew: true, changeNote: 'x', world: { name: '锈轨城', kind: '地点' as const, content: '重复' } },
    { name: '铁鸦', isNew: true, changeNote: 'y', world: { name: '黑车帮', kind: '势力' as const, content: '地头蛇' } },
  ];
  const out = applyMemories(proj, mems as never, 'ch1');
  assert.equal(out.worldItems.length, 2);
  assert.equal(out.worldItems[1].name, '黑车帮');
});

test('prompt：包含既有名册、正文与硬性 JSON 约束', () => {
  const msgs = buildExtractMessages('拾荒人的规矩', TEXT, {
    characters: [{ id: 'c1', name: '林越', state: 'x', log: [], relations: [], power: '炼气二层' }],
    worldItems: [{ id: 'w1', name: '锈轨城', kind: '地点' as const, content: 'x' }],
  });
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[0].content.includes('只输出 JSON'));
  assert.ok(msgs[1].content.includes('林越（炼气二层）'));
  assert.ok(msgs[1].content.includes('锈轨城'));
  assert.ok(msgs[1].content.includes(TEXT));
});
