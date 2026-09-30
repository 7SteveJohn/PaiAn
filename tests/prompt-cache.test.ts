// 前缀缓存契约：供应商的上下文缓存只认可「整段公共前缀」，所以提示词的块序就是成本。
// 这里锁两件事——罕变块必须排在按章重排的【人物】之前，规则（与章完全无关）必须排在语境块之前。
// 反面用例同样重要：数据真变了就得允许断点前移，否则这几条断言是空的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Chapter, Project } from '../src/types';
import { buildDraftMessages, buildMessages } from '../src/ai-prompt';
import { buildAiContext, rulesSuffix } from '../src/util';

const rules = [{ name: '文风', content: '句子要短，多用动词', on: true }];

const prose = (n: number, tag: string) => {
  const s = `${tag}的雨从夜里开始下，屋檐的水声把整条街都泡软了。他站在门口，手里那点热气一直没散。`;
  return (s + s + s).slice(0, n);
};

function book(): Project {
  const chapters: Chapter[] = Array.from({ length: 6 }, (_, i) => ({
    id: `c${i + 1}`,
    title: `第${i + 1}章`,
    content: i === 0 ? prose(500, `章${i + 1}`) : '',
    beats: `主角查清第${i + 1}条线索，结尾留一个未解的疑问`,
    cast: i % 2 === 0 ? '林越、阿禾' : '阿禾',
    summary: i === 0 ? '第1章发生了什么的一行摘要' : '',
    createdAt: '',
    updatedAt: '',
  })) as Chapter[];
  return {
    id: 'p1',
    type: '玄幻',
    title: '雾港',
    status: '写作中',
    deadline: '',
    notes: '一座终年被雾锁住的港口城，主角回来替师父收尾。',
    draft: '',
    linkedIdeaIds: [],
    mode: 'chapters',
    chapters,
    characters: [
      { id: 'k1', name: '林越', role: '主角', state: '握着半枚铜印', notes: '' },
      { id: 'k2', name: '阿禾', role: '同伴', state: '还不知师父死讯', notes: '' },
    ],
    worldItems: [{ id: 'w1', name: '雾钟', kind: '器物', content: '雾起时自己会响' }],
    marks: [{ id: 'm1', type: '伏笔', text: '半枚铜印的另一半在谁手上', status: '埋下', chapterId: 'c1' }],
    createdAt: '',
    updatedAt: '',
  } as unknown as Project;
}

// 第 1 章正文里写清境界，守夜人才算得出「已写到的最高境界」
const realmBook = (): Project => {
  const p = book();
  p.chapters![0].content = '林越一步踏入金丹，全场无人说话。\n' + p.chapters![0].content;
  p.chapters![1].content = '阿禾终于筑基。';
  return p;
};

const lcp = (a: string, b: string) => {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
};

const draftSystem = (p: Project, id: string) => buildDraftMessages(p, p.chapters!.find((c) => c.id === id)!, 500, rules)[0].content;

test('块序：设定/世界观/伏笔排在按章重排的【人物】之前', () => {
  const ctx = buildAiContext(book(), 'c3');
  const at = (head: string) => ctx.indexOf(head);
  assert.ok(at('【世界观词条】') < at('【人物】'), '世界观排在人物之后，批量连写时每章都要按未命中重算');
  assert.ok(at('【未回收伏笔') < at('【人物】'), '未回收伏笔要赶在人物块之前');
  assert.ok(at('【人物】') < at('【前情提要'), '人物块后面就该是每章都变的前情');
});

test('规则与章无关，必须排在语境块之前（否则永远吃不到缓存）', () => {
  const sys = draftSystem(book(), 'c3');
  assert.ok(sys.indexOf('句子要短') < sys.indexOf('【作品设定与备注】'), '规则要紧贴身份句，排在所有语境块之前');
  const r = rulesSuffix(rules).trim();
  assert.ok(sys.indexOf(r.slice(0, 12)) > 0 && sys.indexOf(r) > 0, '规则整段进了 system');
  const game = buildMessages('gdialog', book(), '', rules, book().chapters![0])[0].content;
  assert.ok(game.indexOf('句子要短') < game.indexOf('【作品设定与备注】'), '游戏改编类同样把规则提前');
});

test('批量连写：数据没动时命中段要一直盖到【人物】之前', () => {
  const p = book();
  const a = draftSystem(p, 'c2');
  const b = draftSystem(p, 'c3');
  const shared = lcp(a, b);
  assert.ok(a !== b, '两章的提示词当然不同');
  assert.ok(shared >= a.indexOf('【人物】'), `公共前缀只到 ${shared}，没盖住人物块之前的罕变段（人物块起于 ${a.indexOf('【人物】')}）`);
  // 命中段里必须真的含有那几个罕变块——只比数字会被 fixture 大小糊弄
  const hit = a.slice(0, shared);
  assert.ok(hit.includes('【作品设定与备注】') && hit.includes('【世界观词条】') && hit.includes('【未回收伏笔'), '罕变块没整段落进命中段：' + hit.slice(-40));
});

test('反面用例：数据真变了就允许断点前移，别把断言写成恒真', () => {
  const p = book();
  const before = draftSystem(p, 'c3');
  p.marks!.push({ id: 'm9', type: '伏笔', text: '灯塔 keeper 的脸', status: '埋下', chapterId: 'c2' });
  const after = draftSystem(p, 'c3');
  assert.ok(lcp(before, after) < before.indexOf('【人物】'), '埋了新伏笔后断点应前移到伏笔块，说明上面那条断言是活的');
});

test('设定红线排在【人物】之前，批量连写时整段落进命中段', () => {
  const p = realmBook();
  const ctx = buildAiContext(p, 'c3');
  const at = ctx.indexOf('【设定红线');
  assert.ok(at > 0, '正文写到了金丹，上下文里该有红线：' + ctx.slice(0, 80));
  assert.ok(/· 林越：不低于「金丹」（正文第1章已写到）/.test(ctx), ctx.slice(at, at + 120));
  assert.ok(/· 阿禾：不低于「筑基」（正文第2章已写到）/.test(ctx), '每个人物都该有自己的地板');
  assert.ok(at < ctx.indexOf('【人物】'), '红线与章无关，必须赶在按章重排的人物块之前');
  const a = draftSystem(p, 'c2');
  const b = draftSystem(p, 'c3');
  const shared = lcp(a, b);
  assert.ok(shared >= a.indexOf('【人物】'), `两章的公共前缀只到 ${shared}，红线没被缓存盖住`);
  assert.ok(a.slice(0, shared).includes('【设定红线'), '红线整段要在命中段里，不然每章都重算');
});

test('反面用例：正文境界一涨，断点必须落进红线段内（数据变了就允许掉缓存）', () => {
  const p = realmBook();
  const before = draftSystem(p, 'c3');
  p.chapters![2].content = '林越又往上走了一步，气息已是元婴。';
  const after = draftSystem(p, 'c3');
  const cut = lcp(before, after);
  assert.ok(cut > before.indexOf('【设定红线'), '红线段之前不该有变化：' + cut);
  assert.ok(cut < before.indexOf('【人物】'), '境界涨了，断点该停在红线段里而不是白吃整段罕变区');
  assert.match(after.slice(cut - 12, cut + 20), /金丹|元婴/, '断开的位置就该是那条境界');
});

// 「AI 只判不写」这句话是恒定的，插错位置就会把整段罕变区推下命中名单
test('只判不写的说明插在规则之后、语境之前，不断公共前缀', () => {
  const p = realmBook();
  const a = buildMessages('continue', p, '', rules, p.chapters![1], true)[0].content;
  const b = buildMessages('continue', p, '', rules, p.chapters![2], true)[0].content;
  const at = a.indexOf('【只判不写】');
  assert.ok(at > 0, '开关开着，system 里该有那句约束：' + a.slice(0, 120));
  assert.ok(at > a.indexOf('句子要短'), '它要排在写作规则之后');
  assert.ok(at < a.indexOf('【人物】'), '它要在按章变化的语境块之前，否则每章都要重算');
  assert.ok(lcp(a, b) >= a.indexOf('【人物】'), '两章之间的公共前缀必须整段盖住这句约束');
});

test('同一章重复拼装逐字节稳定（缓存命中的前提）', () => {
  const p = book();
  assert.equal(draftSystem(p, 'c4'), draftSystem(p, 'c4'), '同输入必须一字不差');
  const m = buildMessages('continue', p, '', rules, p.chapters![0]);
  assert.deepEqual(buildMessages('continue', p, '', rules, p.chapters![0]), m);
});
