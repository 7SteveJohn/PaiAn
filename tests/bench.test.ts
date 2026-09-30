// 拆文对标的纯函数回归：统计口径、对照阈值、掉卡的幂等与合法性。
// 这里最要紧的三件事：不存原文、比不出名堂时别硬比、掉的卡必须真的可判定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBook, cardsFromGaps, chapterStats, compare, myStats, rhythm, splitChapters } from '../src/bench';
import { describe, evaluate } from '../src/constraints';

const 标杆 = [
  '第一章 到港',
  '汽笛响了三声。林越把衣领竖起来。',
  '「你迟到了。」她说。',
  '他没接话，只数着站台的灯。',
  '',
  '第二章 卸货',
  '货箱上的铁锈纹和仓库那道一模一样。',
  '他蹲下去，指腹压过那道纹。',
  '雾隐师说：「别再往前了。」',
  '',
  '第三章 清点',
  '阿禾提着灯跑来，脸色发白。',
  '「他们要卸货，货在……」她没说完。',
  '远处忽然响起一声钟，那是整座雾港从没听过的声音！',
].join('\n');

function mineBook(dialogue: number, longSentences: boolean) {
  const talk = '「走。」她说。「我不送。」';
  const flat = '她把灯挪近一步又放下。';
  const long = '林越沿着码头第七根缆桩往东走，靴底踩着湿木板，心里明白这趟不该来，可他还是来了，因为他没有别的地方可去。';
  const body = (longSentences ? long : '他沿着缆桩走。') + (dialogue > 0 ? talk.repeat(dialogue) : flat);
  return {
    id: 'p1',
    title: '我的书',
    type: '小说',
    status: '写作中',
    deadline: '',
    notes: '',
    draft: '',
    linkedIdeaIds: [],
    createdAt: '',
    updatedAt: '',
    mode: 'chapters' as const,
    chapters: [1, 2, 3].map((i) => ({ id: 'c' + i, title: `第${i}章`, content: body, createdAt: '', updatedAt: '' })),
  };
}

test('分章：认中文章号、数字顿号与【】章，认不出退回空行分段', () => {
  assert.equal(splitChapters(标杆).length, 3);
  assert.equal(splitChapters(标杆)[1].title, '第二章 卸货');
  assert.equal(splitChapters('1、开始\n正文A\n\n2、继续\n正文B').length, 2);
  assert.equal(splitChapters('【第一章 雾】\n正文\n【第二章 港】\n正文').length, 2);
  assert.equal(splitChapters('第一段\n\n第二段\n\n第三段').length, 1, '没有章标题时按「（开篇）」整块返回，仍可用');
  assert.deepEqual(splitChapters(''), []);
  assert.deepEqual(splitChapters('   \n\n  '), []);
});

test('章统计：对白不参与句长，段首人称只数叙述段', () => {
  const talky = '「今天的事说来很长，长到我今晚说不完，明天也说不完，后天还是说不完。」她说完就走了。';
  const s = chapterStats(1, '一章', talky);
  assert.equal(s.maxSentence, '她说完就走了。'.length - 1, `引号里的长句不该算：${s.maxSentence}`);
  assert.ok(s.dialogueShare > 70, `对白占比应很高，实际 ${s.dialogueShare}`);
  // 整段以引号开场，算「用对白开场」，不按人称开头计——这正是鼓励的换法
  assert.equal(s.pronounOpen, 0);
  assert.equal(chapterStats(1, 'x', '「他站起来。」她说。').pronounOpen, 0, '引号开场的段落不算人称开头');
  const threeParas = ['他站起来。', '她没跟。', '「你也去？」他问。'].join('\n');
  assert.equal(chapterStats(1, 'x', threeParas).pronounOpen, 2, '两段叙述以人称开头、第三段引号开场不算');
});

test('章统计：开篇类型与章末落点可分', () => {
  assert.equal(chapterStats(1, 'x', '「你走。」她说。').opener, '对白');
  assert.equal(chapterStats(1, 'x', '他推开门。').opener, '人称');
  assert.equal(chapterStats(1, 'x', '雾漫过缆桩。').opener, '环境或动作');
  assert.equal(chapterStats(1, 'x', '她停在栈桥尽头。最后只留下一句：「别过来……」').endsOnTalk, true, '章末停在一句话上');
  assert.equal(chapterStats(1, 'x', '她停在栈桥尽头：「别过来……」。').endsOnTalk, false, '引号之后又补了叙述句，就不算落在对白上');
  assert.equal(chapterStats(1, 'x', '她回到了屋里，把灯吹灭。').endsOnTalk, false);
});

test('节律指纹取中位数，不被个别离群章带跑', () => {
  const even = Array.from({ length: 9 }, (_, i) => chapterStats(i + 1, 't', '他走了。她没跟。'));
  const odd = chapterStats(99, '怪章', '这一章' + '特别特别长的句子'.repeat(40) + '。');
  assert.equal(rhythm(even).avgSentence, rhythm([...even, odd]).avgSentence, '加一章离群值不该改变中位数');
  assert.ok(rhythm([]).chapters === 0 && rhythm([]).avgSentence === 0, '空表要给零而不是 NaN');
});

test('analyzeBook 稳定：同一文本两次拆解 id 与统计一致', () => {
  const a = analyzeBook('标杆书', 标杆, '2026-09-22T00:00:00.000Z');
  const b = analyzeBook('标杆书', 标杆, '2026-09-22T00:00:00.000Z');
  assert.equal(a.id, b.id);
  assert.deepEqual(a.chapters, b.chapters);
  assert.equal(a.chapters.length, 3);
  assert.equal(a.title, '标杆书');
  assert.ok(!JSON.stringify(a).includes('铁锈纹'), '统计里不能带上原文片段');
  const anonymous = analyzeBook('', 标杆);
  assert.ok(anonymous.title, '没填书名也要有个能认出来的标题');
});

test('myStats：章节模式跳过空章，单篇模式给一条', () => {
  assert.equal(myStats(mineBook(1, false)).length, 3);
  const withEmpty = { ...mineBook(1, false), chapters: [...mineBook(1, false).chapters, { id: 'c4', title: '待写', content: '   ', createdAt: '', updatedAt: '' }] };
  assert.equal(myStats(withEmpty).length, 3, '空白章不进对照');
  assert.equal(myStats(withEmpty).every((c) => c.chars > 0), true);
  assert.equal(myStats({ mode: 'single', draft: '一段正文。他走了。' }).length, 1);
  assert.deepEqual(myStats({ mode: 'single', draft: '' }), []);
});

test('compare：样本不足就不比，够量才报差距并标注是否值得学', () => {
  const theirs = analyzeBook('t', 标杆).chapters;
  assert.deepEqual(compare(myStats(mineBook(1, false)).slice(0, 2), theirs), [], '两边各不足 3 章时不给结论');
  const gaps = compare(myStats(mineBook(0, true)), theirs);
  assert.ok(gaps.some((g) => g.key === 'avgSentence'), '长句书应比出句长差');
  assert.ok(gaps.every((g) => Number.isFinite(g.mine) && Number.isFinite(g.theirs)));
  const identical = compare(theirs, theirs);
  assert.ok(identical.every((g) => !g.worth), '自己跟自己比不该产生「值得学」');
});

test('掉卡：只从值得学的差距里长，id 稳定可幂等，条件都能判定', () => {
  const book = analyzeBook('标杆书', 标杆);
  const mine = myStats(mineBook(0, true));
  const gaps = compare(mine, book.chapters);
  const cards = cardsFromGaps(book, gaps);
  assert.ok(cards.length > 0, `标杆对白多、我对白少，至少该掉出卡来：${gaps.map((g) => `${g.key}:${g.mine}/${g.theirs}${g.worth ? '' : '(不值)'}`).join(' ')}`);
  for (const c of cards) {
    assert.equal(c.series, '练笔');
    assert.ok(['N', 'R', 'SR'].includes(c.rarity));
    assert.ok(c.id.startsWith('b-'), `掉出来的卡要有可识别 id：${c.id}`);
    assert.ok(c.payload.includes('标杆书'), '卡面要说明是跟谁学的');
    assert.ok(!/\{(?:char|place|item|hook)\}/.test(c.payload), '对标卡不占用槽位（它带的是具体数字）');
    const list = describe(c);
    assert.ok(list.length >= 1, `${c.id} 没有可判定条件`);
    assert.doesNotThrow(() => evaluate('随便一段正文。', list));
  }
  const again = cardsFromGaps(book, gaps);
  assert.deepEqual(again.map((c) => c.id), cards.map((c) => c.id), '同一份拆解重复掉卡，id 必须一致（幂等）');
  const noGap = cardsFromGaps(book, gaps.map((g) => ({ ...g, worth: false })));
  assert.deepEqual(noGap, [], '没到阈值的差距不该硬凑成卡');
});

test('掉出来的卡真能判达成：写到位亮，没写到位不亮', () => {
  const book = analyzeBook('标杆书', 标杆);
  const cards = cardsFromGaps(book, compare(myStats(mineBook(0, true)), book.chapters));
  const talk = cards.find((c) => c.id.startsWith('b-talk'));
  assert.ok(talk, '对白少的对照组应掉出一张对白卡');
  const list = describe(talk!);
  assert.equal(evaluate('他沿着缆桩走。', list).done, false);
  assert.equal(evaluate('「走。」她说。\n「我不送。」\n「你到底去不去？」她 again。\n「去。」他说。\n「现在就走。」', list).done, true, '把对白写够就该亮');
});
