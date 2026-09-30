// 取名面板的锚点：同种子必须同结果（「换一批」只是换种子，不是抽签玄学）、
// 一批之内不重复、本书已有名一定绕开、四种风格要真的不一样。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Project } from '../src/types';
import { NAME_CATEGORIES, NAME_STYLES, generateNames, pickToWorldKind, usedNames, type NameCategory, type NameStyle } from '../src/names';

const proj = (over: Partial<Project> = {}): Project =>
  ({ id: 'p', title: 't', type: '小说', status: '写作中', deadline: '', notes: '', draft: '', linkedIdeaIds: [], createdAt: '', updatedAt: '', ...over }) as Project;

test('确定性：同种子同结果，不同种子换一批', () => {
  const a = generateNames({ category: '人物男', style: '玄幻', seed: 7, count: 10 });
  const b = generateNames({ category: '人物男', style: '玄幻', seed: 7, count: 10 });
  assert.deepEqual(a.map((x) => x.name), b.map((x) => x.name), '同种子必须逐条一致');
  const c = generateNames({ category: '人物男', style: '玄幻', seed: 8, count: 10 });
  assert.notDeepEqual(new Set(a.map((x) => x.name)), new Set(c.map((x) => x.name)), '换种子该给出不同的一批');
});

test('每类每风格都能出满一批，且不重复、长度合理、带注', () => {
  for (const style of NAME_STYLES) {
    for (const category of NAME_CATEGORIES) {
      const list = generateNames({ category, style, seed: 20260922, count: 12 });
      assert.equal(list.length, 12, `${style}/${category} 出满 12 个，实际 ${list.length}`);
      const names = list.map((p) => p.name);
      assert.equal(new Set(names).size, 12, `${style}/${category} 一批内有重名：${names.join('、')}`);
      for (const p of list) {
        assert.ok(p.name.length >= 2 && p.name.length <= 9, `名字长度不像样：${style}/${category} → ${p.name}`);
        assert.ok(p.note.trim().length >= 4, `${p.name} 缺一句能看的注`);
        assert.equal(p.category, category);
        assert.ok(p.kind === 'char' || p.worldKind, '设定卡类必须带 worldKind，否则建卡时无处归类');
      }
    }
  }
});

test('风格真的分得开：都市不带古风堂号，西幻走音译', () => {
  const city = generateNames({ category: '势力', style: '都市', seed: 3, count: 12 }).map((p) => p.name);
  assert.ok(city.some((n) => /集团|科技|事务所|实验室|会所|律所|公会|研究院/.test(n)), `都市势力该有现代制名：${city.join('、')}`);
  assert.ok(!city.some((n) => /宗|派|教|殿/.test(n)), `都市不该掉回宗门制：${city.join('、')}`);
  const xh = generateNames({ category: '势力', style: '玄幻', seed: 3, count: 12 }).map((p) => p.name);
  assert.ok(xh.some((n) => /宗|门|派|教|殿|谷|盟/.test(n)), `玄幻势力要像门派：${xh.join('、')}`);
  const west = generateNames({ category: '人物男', style: '西幻', seed: 5, count: 8 });
  assert.ok(west.every((p) => p.name.includes('·')), `西幻人名走音译分段：${west.map((p) => p.name).join('、')}`);
});

test('本书已有的名字一定绕开', () => {
  const banned = ['林照川', '沈亦舟', '裴青澜'];
  const got = new Set<string>();
  for (let seed = 1; seed < 400; seed++) {
    for (const p of generateNames({ category: '人物男', style: '玄幻', seed, count: 12, banned })) {
      assert.ok(!banned.includes(p.name), `banned 里的 ${p.name} 还是被生成了（seed ${seed}）`);
      got.add(p.name);
    }
  }
  assert.ok(got.size > 100, `种子换了 400 次只出 ${got.size} 个别名，词库太窄`);
});

test('usedNames：人物卡、设定卡与章节出场名单都算已用', () => {
  const p = proj({
    characters: [{ id: 'k1', name: '林越', state: '', log: [], relations: [] }],
    worldItems: [{ id: 'w1', name: '夜航船', kind: '地点', content: '' }],
    chapters: [
      { id: 'c1', title: '第一章', content: '', cast: '林越、雾隐师', createdAt: '', updatedAt: '' },
      { id: 'c2', title: '第二章', content: '', cast: '阿禾，阿禾、 ', createdAt: '', updatedAt: '' },
    ],
  });
  const used = usedNames(p);
  assert.deepEqual(used.sort(), ['夜航船', '林越', '阿禾', '雾隐师'].sort(), `已用名收集不对：${used.join('、')}`);
  assert.deepEqual(usedNames(proj()), [], '空作品不该报错');
});

test('单名 / 双名可控，人物与设定卡分类正确', () => {
  const two = generateNames({ category: '人物女', style: '古言', seed: 11, count: 8, twoChar: true });
  const single = generateNames({ category: '人物女', style: '古言', seed: 11, count: 8, twoChar: false });
  assert.ok(two.every((p) => p.name.length >= 3), `双名应至少三字：${two.map((p) => p.name).join('、')}`);
  // 单名 = 姓（1~2 字，复姓占两字）+ 一字，所以最长三字
  assert.ok(single.every((p) => p.name.length <= 3), `单名不该超过三字：${single.map((p) => p.name).join('、')}`);
  assert.notDeepEqual(two.map((p) => p.name), single.map((p) => p.name), '同一颗种子下，单名与双名应拼出不同结果');
  assert.ok(pickToWorldKind(generateNames({ category: '地名', style: '玄幻', seed: 1 })[0]) === '地点');
  assert.equal(pickToWorldKind({ name: 'x', note: 'y', category: '人物男', kind: 'char' }), undefined, '人物不建设定卡');
  assert.equal(pickToWorldKind({ name: 'x', note: 'y', category: '器物', kind: 'world' }), '道具', '缺 worldKind 时按类别兜底');
});

test('参数离谱也不崩：未知类别回落到人物，数量与风格被夹住', () => {
  const weird = generateNames({ category: '没有这一类' as NameCategory, style: '火星' as NameStyle, count: 999, seed: 0 });
  assert.ok(weird.length > 0 && weird.length <= 30, `数量该被夹住：${weird.length}`);
  assert.equal(weird[0].category, '人物男', '未知类别应回落');
  assert.ok(weird[0].name.length >= 2);
});
