// 设定守夜人的锚点：境界线必须「有唯一归属才算」，认不出就留白；
// 回退要报得出章号与原话，称谓/名单要报得准，掉出来的卡必须幂等。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Character, Project, WorldItem } from '../src/types';
import { BUILTIN_LADDERS, SILENCE_GAP, loreRedlines, laddersOf, nameReport, rankOfTerm, realmFloors, realmReport, silences, stemsFromText, unitsOf, watchdog, watchdogCards } from '../src/watchdog';

const proj = (over: Partial<Project> = {}): Project =>
  ({
    id: 'p',
    title: 't',
    type: '玄幻',
    status: '写作中',
    deadline: '',
    notes: '',
    draft: '',
    linkedIdeaIds: [],
    createdAt: '',
    updatedAt: '',
    mode: 'chapters',
    chapters: [],
    characters: [],
    worldItems: [],
    ...over,
  }) as Project;

let seq = 0;
const chap = (body: string, extra: { cast?: string } = {}) => ({
  id: 'c' + ++seq,
  title: '章' + seq,
  content: body,
  createdAt: '',
  updatedAt: '',
  ...(extra.cast ? { cast: extra.cast } : {}),
});

const char = (name: string, over: Partial<Character> = {}): Character => ({
  id: 'k-' + name,
  name,
  state: '',
  log: [],
  relations: [],
  ...over,
});

const world = (name: string, kind: WorldItem['kind'], content: string): WorldItem => ({ id: 'w-' + name, name, kind, content });

const filler = (n: number) => '细节。'.repeat(n);

test('境界表：先吃作者自己写的力量体系词条，认不出序列才退到内置', () => {
  assert.deepEqual(
    stemsFromText('炼气 → 筑基 → 金丹 → 元婴……灵气枯竭后，越往上越难，多数人终生卡在炼气。突破需灵石，代价因人而异。'),
    ['炼气', '筑基', '金丹', '元婴'],
  );
  const got = laddersOf(proj({ worldItems: [world('末法九境', '力量体系', '炼气 → 筑基 → 金丹 → 元婴')] }));
  assert.equal(got.length, 1, `有词条就只该用词条：${JSON.stringify(got)}`);
  assert.equal(got[0].source, '词条');
  assert.equal(got[0].label, '末法九境');
  assert.deepEqual(laddersOf(proj({ worldItems: [world('两条腿', '力量体系', '炼气 → 筑基')] })), BUILTIN_LADDERS, '只列出两个境界不算序列，退回内置');
});

test('境界刻度：长名优先，前后与层数都排在同一根线上', () => {
  const qi = BUILTIN_LADDERS[1]; // 斗气线：大斗师 不能被 斗师 吃掉半截
  assert.equal(rankOfTerm('大斗师', [qi])!.term, '大斗师');
  assert.ok(rankOfTerm('大斗师', [qi])!.rank > rankOfTerm('斗师', [qi])!.rank);
  const li = BUILTIN_LADDERS[0];
  assert.ok(rankOfTerm('筑基后期', [li])!.rank > rankOfTerm('筑基中期', [li])!.rank);
  assert.ok(rankOfTerm('筑基中期', [li])!.rank > rankOfTerm('筑基前期', [li])!.rank);
  assert.ok(rankOfTerm('炼气四层', [li])!.rank > rankOfTerm('炼气二层', [li])!.rank);
  assert.ok(rankOfTerm('炼气十层', [li])!.rank > rankOfTerm('炼气九层', [li])!.rank, '中文层数要认');
  assert.ok(rankOfTerm('金丹', [li])!.rank > rankOfTerm('筑基大圆满', [li])!.rank, '跨境优先于境内的圆满');
  assert.equal(rankOfTerm('他只是累了', [li]), null);
});

test('一路向上无事，往回走要报得出章号与原话', () => {
  const up = realmReport(
    proj({
      characters: [char('林越')],
      chapters: [chap('林越终于摸到炼气四层的门槛。'), chap('林越站在井边，气息却是筑基中期。'), chap('林越一步踏入金丹，全场无人说话。')],
    }),
  );
  assert.equal(up.findings.length, 0, `递进不该报：${JSON.stringify(up.findings)}`);
  assert.deepEqual(up.obs.map((o) => o.term), ['炼气四层', '筑基中期', '金丹']);

  const down = realmReport(
    proj({
      characters: [char('林越')],
      chapters: [chap('林越一步踏入金丹，全场无人说话。'), chap(filler(3)), chap('林越的气息掉回筑基中期，掌心发烫。')],
    }),
  );
  const reg = down.findings.filter((f) => f.kind === 'regress');
  assert.equal(reg.length, 1, `只该报这一条：${JSON.stringify(down.findings)}`);
  const f = reg[0];
  assert.ok(f.kind === 'regress');
  assert.deepEqual([f.from.no, f.from.term], [1, '金丹']);
  assert.deepEqual([f.to.no, f.to.term], [3, '筑基中期']);
  assert.match(f.snippet, /筑基中期/, '原话要能拿去让作者对着改');
});

test('同一章既金丹又筑基：报打架，而不是当成回退', () => {
  const got = realmReport(proj({ characters: [char('林越')], chapters: [chap('林越已经是金丹。' + filler(2) + '林越到底是筑基中期。')] }));
  const flip = got.findings.filter((x) => x.kind === 'flip');
  assert.equal(flip.length, 1, JSON.stringify(got.findings));
  assert.ok(flip[0].kind === 'flip');
  assert.deepEqual(flip[0].terms, ['金丹', '筑基中期']);
  assert.equal(got.findings.filter((x) => x.kind === 'regress').length, 0);
});

test('认不出就留白：台词、 hedge、两个人名挨着、隔太远，都不算到谁头上', () => {
  const talk = realmReport(proj({ characters: [char('林越')], chapters: [chap('「林越已经是金丹了。」她说。')] }));
  assert.equal(talk.obs.length, 0, '台词里说到的境界不进账');
  assert.equal(talk.skipped.dialogue, 1, '但要说清挡掉了几处，别让人以为没写');

  const hedge = realmReport(proj({ characters: [char('林越')], chapters: [chap('林越还没有筑基。' + filler(1) + '当年他炼气二层，日子很轻。')] }));
  assert.equal(hedge.obs.length, 0);
  assert.equal(hedge.skipped.hedged, 2, '否定与回忆都不算他此刻的境界');

  const two = realmReport(proj({ characters: [char('林越'), char('阿禾')], chapters: [chap('林越与阿禾都停在筑基。')] }));
  assert.equal(two.obs.length, 0, '一句话里两个人名挨着同一个境界：不猜');
  assert.equal(two.skipped.ambiguous, 1);

  const far = realmReport(proj({ characters: [char('林越')], chapters: [chap('林越推开门。' + '屋里空无一人风从破窗灌进来'.repeat(2) + '案上那盏灯晃了晃，气息仍是筑基。')] }));
  assert.equal(far.obs.length, 0, '隔太远就是两句话，不是他');
  assert.equal(far.skipped.ambiguous, 0);

  // 这两条是从示例书第 5 章与出场名单「铁鸦（未露面）」上量出来的：跨句换主语、作者自己标过故意没露面
  const cross = realmReport(proj({ characters: [char('林越'), char('阿禾')], chapters: [chap('林越撞破了那层膜。炼气三层。\n阿禾在身后咳嗽了一声。')] }));
  assert.equal(cross.obs.length, 0, '境界词单独成句时，别把它算到下一句的人身上');
  assert.equal(cross.skipped.ambiguous, 0, '本句内没有人名就是没有，不算歧义');
});

test('名单里作者自己标了「未露面」，就当他知道', () => {
  const list = nameReport(proj({ characters: [char('林越'), char('铁鸦')], chapters: [chap('林越推门进去。', { cast: '林越、铁鸦（未露面）' })] }));
  assert.equal(list.filter((f) => f.kind === 'cast-miss').length, 0, JSON.stringify(list));
});

test('卡落后于正文：正文已金丹，卡还写着炼气', () => {
  const got = realmReport(proj({ characters: [char('林越', { power: '炼气三层' })], chapters: [chap('林越一步踏入金丹，全场无人说话。')] }));
  const f = got.findings.find((x) => x.kind === 'card-behind');
  assert.ok(f && f.kind === 'card-behind');
  assert.equal(f.card, '炼气三层');
  assert.deepEqual([f.max.no, f.max.term], [1, '金丹']);
});

test('境界地板：取正文写到的最高处，注入段按行封顶', () => {
  const p = proj({
    characters: [char('林越'), char('阿禾')],
    chapters: [chap('林越一步踏入金丹。'), chap('阿禾还停在炼气三层，握不稳刀。'), chap('林越的气息退回筑基中期。'), chap('阿禾终于筑基。')],
  });
  assert.deepEqual(
    realmFloors(p).map((f) => `${f.name}=${f.term}#${f.no}`),
    ['林越=金丹#1', '阿禾=筑基#4'],
    '地板取最高点（回退过的林越仍按金丹算），并按境界高低排',
  );
  assert.match(loreRedlines(p), /· 林越：不低于「金丹」（正文第1章已写到）\n· 阿禾：不低于「筑基」（正文第4章已写到）/);
  const many = proj({
    characters: Array.from({ length: 12 }, (_, i) => char('人' + i)),
    chapters: [chap(Array.from({ length: 12 }, (_, i) => `人${i}一步踏入金丹。`).join(''))],
  });
  assert.equal(realmFloors(many).length, 8, '注入段封顶 8 行，别把上下文撑成第二本设定集');
  assert.equal(loreRedlines(proj({ characters: [], chapters: [chap('无。')] })), '', '没人可报就别塞段落——空块也在花 token');
});

test('称谓：只报都出过场的近名对，长名不会把短名挤成死卡', () => {
  const list = nameReport(
    proj({
      characters: [char('林越'), char('林越舟'), char('阿禾'), char('路人丁'), char('铁鸦')],
      chapters: [chap('林越舟先动手，林越在后面看着。' + filler(2)), chap('阿禾没有回头。她认得铁鸦。'), chap('第三个人在门外。')],
    }),
  );
  const near = list.filter((f) => f.kind === 'near');
  assert.equal(near.length, 1, `只该报这一对：${JSON.stringify(near)}`);
  assert.ok(near[0].kind === 'near');
  assert.equal(near[0].names.join(), '林越,林越舟');
  assert.match(near[0].why, /一部分/);
  assert.deepEqual(
    list.filter((f) => f.kind === 'dead').map((f) => (f.kind === 'dead' ? f.names[0] : '')),
    ['路人丁'],
    '正文没出现过的卡才算死卡',
  );
});

test('称谓：同前缀的两个人、名单写了正文却没有、关系指向空名', () => {
  const list = nameReport(
    proj({
      characters: [char('张小砚', { relations: [{ with: '恩人甲', note: '救过他一命' }] }), char('张小晴'), char('旧识')],
      chapters: [chap('张小砚点头。' + filler(1) + '张小晴没有说话。'), chap('张小砚走了。', { cast: '张小砚、张小晴、阿吉（新人）' })],
    }),
  );
  const near = list.find((f) => f.kind === 'near');
  assert.ok(near && near.kind === 'near' && near.why.includes('开头'), `同前缀该报：${JSON.stringify(near)}`);
  const miss = list.filter((f) => f.kind === 'cast-miss');
  assert.equal(miss.length, 2, JSON.stringify(miss));
  assert.ok(miss.some((f) => f.kind === 'cast-miss' && f.names[0] === '阿吉' && f.why.includes('没有对应的人物卡')), '括号注释要剥掉，别把「阿吉（新人）」当名字');
  assert.ok(miss.some((f) => f.kind === 'cast-miss' && f.names[0] === '张小晴'), '名单里写了正文却没出现');
  assert.ok(list.some((f) => f.kind === 'relation-dangling'), '恩人甲只活在别人关系栏里');
  assert.ok(list.some((f) => f.kind === 'dead' && f.names[0] === '旧识'));
});

test('出场名单里的斜杠写法不当成两个人', () => {
  const list = nameReport(
    proj({
      characters: [char('林越'), char('阿禾')],
      chapters: [chap('林越独自走了。', { cast: '林越／阿禾' })],
    }),
  );
  const miss = list.filter((f) => f.kind === 'cast-miss');
  assert.deepEqual(miss.map((f) => (f.kind === 'cast-miss' ? f.names[0] : '')), ['阿禾'], JSON.stringify(miss));
});

test('同姓不同名不算近名：一个字的公共前缀不值得报警', () => {
  const list = nameReport(proj({ characters: [char('林越'), char('林晚')], chapters: [chap('林越走了。' + filler(1) + '林晚没送。')] }));
  assert.equal(list.filter((f) => f.kind === 'near').length, 0, JSON.stringify(list));
});

test('沉默分「进场」与「只在台词里被提起」：被提到不算露面', () => {
  const rows = silences(
    proj({
      characters: [char('林越'), char('阿禾'), char('铁鸦')],
      worldItems: [world('铜铃', '道具', 'x')],
      chapters: [
        chap('林越提着铜铃进门。'),
        chap('「铁鸦来了。」阿禾说。'),
        chap('阿禾数着缆桩。' + filler(3)),
        chap('阿禾把灯芯挑亮。' + filler(3)),
        chap('「林越那人不错。」阿禾说。' + filler(3)),
        chap('阿禾睡了。' + filler(3)),
        chap('阿禾醒来。' + filler(3)),
        chap('阿禾出门。' + filler(3)),
      ],
    }),
  );
  const lin = rows.find((r) => r.name === '林越');
  assert.ok(lin, `林越该被记一笔：${JSON.stringify(rows)}`);
  assert.equal(lin.offstage, false);
  assert.equal(lin.last, 1, '上次进场是第 1 章');
  assert.equal(lin.lastAny, 5, '第 5 章别人还提过他');
  assert.equal(lin.mentionsAfter, 1, '进场之后只在台词里露过一次');
  assert.equal(lin.gap, 7, '账按进场算：不是第 5 章之后的 3 章，而是第 1 章之后的 7 章');
  const tie = rows.find((r) => r.name === '铁鸦');
  assert.ok(tie && tie.offstage, '只在别人嘴里的名字，标成「一次也没进场」');
  assert.equal(tie.last, 0);
  assert.deepEqual([tie.first, tie.lastAny, tie.gap], [2, 2, 6], '从没进过场的按最后一次被提起算账');
  assert.ok(!rows.some((r) => r.name === '阿禾'), '一直在场的人不该出现');
});

test('远场沉默：按章数与字数记账，隔得不够不催，从未出现的交给死卡', () => {
  const rows = silences(
    proj({
      characters: [char('铁鸦')],
      worldItems: [world('玉扣', '道具', '认主不认人')],
      chapters: Array.from({ length: 12 }, (_, i) => chap(`第${i}章。` + filler(20) + (i === 0 ? '玉扣发烫。' : i === 9 ? '铁鸦走了。' : ''))),
    }),
  );
  assert.deepEqual(rows.map((r) => r.name), ['玉扣'], `只该有久没露面那条：${JSON.stringify(rows)}`);
  assert.deepEqual([rows[0].first, rows[0].last, rows[0].gap], [1, 1, 11]);
  assert.ok(rows[0].words > 400, '还要说清这段沉默里写了多少字');
  const edge = (n: number) =>
    silences(
      proj({
        worldItems: [world('灯', '道具', 'x')],
        chapters: Array.from({ length: n + 1 }, (_, i) => chap(i === 0 ? '灯亮着。' : '别人。')),
      }),
    ).length;
  assert.equal(edge(SILENCE_GAP), 1, '刚够线就该报');
  assert.equal(edge(SILENCE_GAP - 1), 0, '差一章不该催');
});

test('单篇模式：没有章序就不判沉默，同篇内打架照判', () => {
  const p = proj({ mode: 'single', draft: '林越已是金丹。' + filler(4) + '林越身上是筑基中期的气息。', characters: [char('林越')], chapters: undefined });
  assert.equal(unitsOf(p).length, 1);
  assert.equal(realmReport(p).findings.filter((f) => f.kind === 'flip').length, 1);
  assert.equal(silences(p).length, 0, '单篇没有章序，别乱报沉默');
  assert.equal(nameReport(p).length, 0);
  assert.equal(watchdog(p).numbered, false);
});

test('换行符不影响结论：同一本书 CRLF 与 LF 的发现必须一致', () => {
  const bodies = ['林越踏入金丹。', '风来了。', '林越退回筑基中期。'];
  const mk = (eol: string) => proj({ characters: [char('林越')], chapters: bodies.map((b) => chap(b + eol)) });
  const a = realmReport(mk(''));
  const b = realmReport(mk('\r\n'));
  assert.ok(a.findings.some((f) => f.kind === 'regress'), '这条用例本身要真能检出回退');
  assert.deepEqual(b.findings, a.findings, `CRLF 不该改变结论：${JSON.stringify(b.findings)}`);
});

test('掉卡：只从回退/死卡/沉默里出，id 稳定且重复点不堆重复卡', () => {
  const p = proj({
    characters: [char('林越'), char('路人丁')],
    worldItems: [world('玉扣', '道具', '认主不认人')],
    chapters: [chap('林越一步踏入金丹。' + filler(6)), chap('玉扣发烫。'), chap('无人开口。'), chap('林越的气息掉回筑基。'), chap('又是一章。'), chap('再写一章。'), chap('还在写。')],
  });
  const first = watchdogCards(p, []);
  assert.ok(first.length >= 2 && first.length <= 4, `该掉 2–4 张：${JSON.stringify(first.map((c) => c.id))}`);
  assert.ok(first.every((c) => c.id.startsWith('wd-')), 'id 命名空间要和 debt- / b- 分开');
  assert.ok(first.every((c) => c.effect === 'beat' && c.payload && c.name && c.any?.length), '卡要真能落地，点亮条件就是这个名字出现在正文');
  assert.equal(watchdogCards(p, first).length, 0, `重复点不掉新卡：${JSON.stringify(watchdogCards(p, first).map((c) => c.id))}`);
  assert.equal(watchdogCards(p, first.map((c) => ({ id: c.id }))).length, 0, '只认 id');
  const w = watchdog(p);
  assert.ok(w.total > 0);
  assert.match(w.realm.ladderLabel, /内置/, '面板要说清用的是哪张境界表');
});
