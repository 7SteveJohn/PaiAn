// Obsidian 双向同步的纯逻辑层断言：渲染 / 解析 / 三方对比 / 回读映射。
// 这一层没有 IO，所以「该推还是该拉、算不算冲突」全部能在这里逐条钉死。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTES_MARK, applyPatches, applyPull, fingerprint, fnv, linkify, mergeForeignMeta, norm, orphanedBookRoots, parseFile, plan, renderBook } from '../server-lib/obsidian';

const NOW = '2026-09-23T10:00:00.000Z';

const project = (over = {}) =>
  ({
    id: 'p1',
    type: '玄幻',
    title: '雾港',
    status: '写作中',
    deadline: '',
    notes: '一座被雾锁住的港口城。',
    target: 3000,
    draft: '',
    linkedIdeaIds: ['i1'],
    mode: 'chapters',
    chapters: [
      { id: 'c1', title: '到港', content: '林越蹲在第七根缆桩边，阿禾在身后说话。', volume: '第一卷', beats: '认船', cast: '林越、阿禾', places: '雾港码头', hooks: '夜航船', summary: '', timeLabel: '', pending: '', createdAt: NOW, updatedAt: NOW },
      { id: 'c2', title: '黑车', content: '岑九站在灯塔下。', volume: '第一卷', createdAt: NOW, updatedAt: NOW },
      { id: 'c3', title: '起雾', content: '', volume: '', createdAt: NOW, updatedAt: NOW },
    ],
    characters: [
      { id: 'k1', name: '林越', state: '握着半枚铜印', power: '第三境', log: [{ at: '第一章', text: '第一次下海' }], relations: [{ with: '阿禾', note: '欠她一个人情' }], powerLog: [] },
      { id: 'k2', name: '阿禾', state: '不知师父死讯', log: [], relations: [] },
      { id: 'k3', name: '岑九', state: '', log: [], relations: [] },
    ],
    worldItems: [
      { id: 'w1', name: '雾钟', kind: '器物', content: '雾起时自己会响。' },
      { id: 'w2', name: '北窗', kind: '地点', content: '永远不开的窗。' },
    ],
    marks: [],
    ...over,
  }) as never;

const ideas = [{ id: 'i1', content: '船票日期是昨天', kind: '灵感' }] as never;

const relsOf = (r) => Object.keys(r.files).sort();
const diskOf = (files) => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.text]));
const stateOf = (files) => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { id: v.id, kind: v.kind, hash: fnv(norm(v.text)) }]));

test('渲染：一物一文件，frontmatter 带稳定 id 与类型', () => {
  const r = renderBook(project(), ideas);
  const rels = relsOf(r);
  assert.ok(rels.includes('雾港/index.md'), `缺索引页：${rels.join(', ')}`);
  assert.equal(rels.filter((x) => x.startsWith('雾港/章节/')).length, 3, '三章三个文件（未写的也建，方便直接在库里写）');
  assert.equal(rels.filter((x) => x.startsWith('雾港/人物/')).length, 3);
  assert.equal(rels.filter((x) => x.startsWith('雾港/设定/')).length, 2);
  const p = parseFile(r.files['雾港/章节/第1章 到港.md'].text);
  assert.equal(p.meta['wb-id'], 'c1');
  assert.equal(p.meta['wb-kind'], 'chapter');
  assert.equal(p.meta['chapter-no'], 1);
  assert.equal(p.meta.volume, '第一卷');
  assert.ok(p.wb, '应被认成我方文件');
});

test('渲染：正文人物地点成双链，索引页的 wikilink 没有死链', () => {
  const r = renderBook(project(), ideas);
  const chap = parseFile(r.files['雾港/章节/第1章 到港.md'].text);
  assert.ok(chap.prose.includes('[[人物/林越]]'), `人物没成链：${chap.prose}`);
  assert.ok(chap.prose.includes('[[人物/阿禾]]'), `第二个角色没成链：${chap.prose}`);
  const basenames = new Set(relsOf(r).map((x) => x.split('/').pop().replace(/\.md$/, '')));
  const idx = parseFile(r.files['雾港/index.md'].text);
  const links = [...idx.prose.matchAll(/\[\[([^\]|]+)\]\]/g)].map((m) => m[1]);
  assert.ok(links.length >= 8, `索引页链接太少：${links.length}`);
  for (const l of links) assert.ok(basenames.has(l), `索引页死链：[[${l}]]（现有：${[...basenames].join(', ')}）`);
});

test('解析：批注区不算正文，再渲染一次还要原样贴回去', () => {
  const r = renderBook(project(), ideas);
  const rel = '雾港/章节/第1章 到港.md';
  const withNotes = r.files[rel].text + `${NOTES_MARK}\n> [!note] 这里节奏太赶\n`;
  const p = parseFile(withNotes);
  assert.ok(p.prose.includes('林越'), `正文丢了：${p.prose}`);
  assert.ok(!p.prose.includes('节奏太赶'), '批注不该混进正文');
  assert.equal(p.notes.trim(), '> [!note] 这里节奏太赶');
  // 批注按实体 id 传回，所以章节改名也不会把批注弄丢
  const again = renderBook(project(), ideas, { c1: p.notes });
  assert.ok(again.files[rel].text.includes('节奏太赶'), '批注在下一趟同步里丢了');
  assert.ok(parseFile(again.files[rel].text).prose.includes('林越'), '贴回批注不能弄坏正文');
});

test('三方对比：首次全推，之后没改动就什么都不做', () => {
  const r = renderBook(project(), ideas);
  const s1 = plan({ rendered: r.files, disk: {}, state: {} });
  assert.equal(s1.push.length, Object.keys(r.files).length, '第一次每篇都要写');
  assert.deepEqual([s1.pull, s1.conflict, s1.prune], [[], [], []]);

  const disk = diskOf(r.files);
  const s2 = plan({ rendered: r.files, disk, state: s1.next });
  assert.deepEqual([s2.push, s2.pull, s2.conflict, s2.prune], [[], [], [], []], `没改动却有事发生：${JSON.stringify(s2)}`);

  // 库里内容与我方一致、却没有祖先记录：补记录，不动文件
  const s3 = plan({ rendered: r.files, disk, state: {} });
  assert.deepEqual([s3.push, s3.pull, s3.conflict], [[], [], []], `不该重写已一致的文件：${JSON.stringify(s3.push)}`);
});

test('三方对比：谁变算谁，两边都变才算冲突', () => {
  const r = renderBook(project(), ideas);
  const disk = diskOf(r.files);
  const st = stateOf(r.files);
  const rel2 = '雾港/章节/第2章 黑车.md';

  // 只改我方
  const p2 = project();
  p2.chapters[1].content = '岑九把半枚印抛进海里。';
  const r2 = renderBook(p2, ideas);
  const s = plan({ rendered: r2.files, disk, state: st });
  assert.ok(s.push.includes(rel2), `我方改了正文该推：${JSON.stringify(s.push)}`);
  assert.equal(s.conflict.length, 0);
  assert.equal(s.pull.length, 0);

  // 只改库里
  const d2 = { ...disk };
  // 注意：渲染后正文里的人名已经是 [[人物/岑九]]，改文本要挑没被链住的那段
  d2[rel2] = d2[rel2].replace('站在灯塔下。', '站在灯塔下，手里多了一只铁盒。');
  const s2 = plan({ rendered: r.files, disk: d2, state: st });
  assert.equal(s2.pull.length, 1, `库里改了该拉回来：${JSON.stringify(s2.pull.map((x) => x.rel))}`);
  assert.equal(s2.pull[0].rel, rel2);
  assert.equal(s2.push.length, 0, '同一篇不该又推又拉');

  // 两边都改 → 冲突，且不许自动偏向任何一边
  const s3 = plan({ rendered: r2.files, disk: d2, state: st });
  assert.ok(s3.conflict.some((x) => x.rel === rel2), '两边都改了必须报冲突');
  assert.equal(s3.push.includes(rel2), false, '冲突项不许被自动推掉');
  assert.equal(s3.pull.some((x) => x.rel === rel2), false, '冲突项不许被自动拉进来');
  assert.equal(s3.next[rel2].hash, st[rel2].hash, '冲突未判定前祖先指纹不许动（否则下一趟就悄悄覆盖了）');
});

test('三方对比：换行差异不算改动；回收只碰我方文件', () => {
  const r = renderBook(project(), ideas);
  const rel = '雾港/章节/第1章 到港.md';
  const state = { [rel]: { id: 'c1', kind: 'chapter', hash: fnv(norm(r.files[rel].text)) } };
  const crlf = r.files[rel].text.replace(/\n/g, '\r\n');
  const s = plan({ rendered: { [rel]: r.files[rel] }, disk: { [rel]: crlf }, state });
  assert.deepEqual([s.push, s.pull, s.conflict], [[], [], []], `CRLF 被判成改动：${JSON.stringify(s)}`);

  // 我方删了章节 → 回收；库里别人写的同名/其它文件 → 一个字节都不碰
  const mine = r.files[rel].text;
  const gone = plan({ rendered: {}, disk: { [rel]: mine, '别人的笔记.md': '随手写的' }, state: { [rel]: state[rel], '别人的笔记.md': { id: '', kind: '', hash: fnv('随手写的') } } });
  assert.deepEqual(gone.prune, [rel], `只该回收我方文件：${JSON.stringify(gone.prune)}`);
});

test('回读：章节正文与人物状态落回原字段，索引页不回读，双链还原成文本', () => {
  const r = renderBook(project(), ideas);
  const chapRel = '雾港/章节/第1章 到港.md';
  const charRel = '雾港/人物/林越.md';
  const disk = diskOf(r.files);
  // 库里最常见的动作就是往下续写：整段替换容易被双链挡住，这里直接追加
  disk[chapRel] = disk[chapRel].replace(/\s+$/, '') + '\n\n' + '他决定明天再问一次。';
  disk[charRel] = disk[charRel].replace('当前状态：握着半枚铜印', '当前状态：已经知道船票是昨天的');
  const s = plan({ rendered: r.files, disk, state: stateOf(r.files) });
  assert.equal(s.pull.length, 2, `只该拉这两篇：${JSON.stringify(s.pull.map((x) => x.rel))}`);
  const { patches, skipped } = applyPull(s.pull);
  assert.equal(patches.length, 2);
  assert.equal(skipped.length, 0);
  const got = applyPatches(project(), patches);
  assert.equal(
    got.chapters[0].content,
    '林越蹲在第七根缆桩边，阿禾在身后说话。' + '\n\n' + '他决定明天再问一次。',
    `章节正文没回读对（或双链没还原成文本）：${JSON.stringify(got.chapters[0].content)}`,
  );
  assert.equal(got.characters[0].state, '已经知道船票是昨天的', `人物状态没回读对：${got.characters[0].state}`);
  assert.equal(got.chapters[1].content, '岑九站在灯塔下。', '没改的章节不许被动');
  assert.equal(got.characters[1].state, '不知师父死讯', '没改的人物卡不许被动');
});

test('回读：认不出实体的文件只报告，不乱写', () => {
  const { patches, skipped } = applyPull([
    { rel: 'a.md', id: '', kind: 'chapter', prose: 'x', notes: '' },
    { rel: 'b.md', id: 'p1', kind: 'book', prose: 'x', notes: '' },
  ]);
  assert.equal(patches.length, 0);
  assert.equal(skipped.length, 2, `两条都该被跳过：${JSON.stringify(skipped)}`);
  assert.ok(skipped[1].因为.includes('索引页'), skipped[1].因为);
});

test('linkify：不套第二层方括号，长名字优先', () => {
  const once = linkify('林越看着阿禾', ['林越', '阿禾'], []);
  assert.equal(once, '[[人物/林越]]看着[[人物/阿禾]]');
  assert.equal(linkify(once, ['林越', '阿禾'], []), once, '第二次渲染不该套上第二层方括号');
  assert.equal(linkify('北窗下', [], ['北窗']), '[[设定/北窗]]下', '地点要链到设定目录');
  assert.equal(linkify('林越舟', ['林越', '林越舟'], []), '[[人物/林越舟]]', '两个名字都能匹配时取长的');
});

// ---------- Obsidian 自己会怎么写回去 ----------
/** 模仿 Obsidian 属性视图保存后的样子：标量不带引号、数组写成块式列表、键序被打乱 */
const obsidianRewrite = (text: string) => {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return text;
  const groups: string[][] = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv && kv[2].trim().startsWith('[')) {
      const items = JSON.parse(kv[2].trim()) as unknown[];
      groups.push([kv[1] + ':', ...items.map((i) => '  - ' + String(i))]);
    } else if (kv) {
      groups.push([kv[1] + ': ' + kv[2].trim().replace(/^"(.*)"$/, '$1')]);
    } else if (groups.length && /^\s+-\s/.test(line)) {
      groups[groups.length - 1].push(line);
    } else {
      groups.push([line]);
    }
  }
  groups.reverse();
  return '---\n' + groups.flat().join('\n') + '\n---' + text.slice(m[0].length);
};

/** v2 祖先记录：拿正文指纹当共同祖先（与 stateOf 的 v1 原始指纹区分开） */
const stateV2 = (files: Record<string, { id: string; kind: string; text: string }>) =>
  Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { id: v.id, kind: v.kind, v: 2, hash: fingerprint(v.text) }]));

test('解析：块式列表与不带引号的标量都认得（Obsidian 的写法）', () => {
  const r = renderBook(project(), ideas);
  const rel = '雾港/章节/第1章 到港.md';
  const p = parseFile(obsidianRewrite(r.files[rel].text));
  assert.equal(p.meta['wb-id'], 'c1', '重写后还要认得出是哪一篇');
  assert.deepEqual(p.meta.tags, ['创作工作台/章节'], 'tags 的块式写法要读成数组');
  assert.equal(typeof p.meta['chapter-no'], 'number', '裸数字仍是数字');
  assert.ok(p.wb && !p.prose.includes('wb-id'), '正文不该被属性区污染');
});

test('Obsidian 重写属性区之后不算「库里改了」，祖先记录静默升级', () => {
  const r = renderBook(project(), ideas);
  const disk = diskOf(r.files);
  for (const k of Object.keys(disk)) disk[k] = obsidianRewrite(disk[k]);
  const first = plan({ rendered: r.files, disk, state: stateOf(r.files) });
  const acts = { push: first.push, pull: first.pull.map((x) => x.rel), conflict: first.conflict.map((x) => x.rel) };
  assert.deepEqual([first.push.length, first.pull.length, first.conflict.length, first.prune.length], [0, 0, 0, 0], '只动了写法不该有动作：' + JSON.stringify(acts));
  assert.ok(Object.values(first.next).every((v: any) => v.v === 2), '这一趟要把记录升级成正文指纹');
  const second = plan({ rendered: r.files, disk, state: first.next });
  assert.deepEqual([second.push.length, second.pull.length, second.conflict.length], [0, 0, 0], '第二趟照旧什么都不做');
});

test('升级不吞真改动：属性区被重写、正文也被改过，仍要拉回来', () => {
  const r = renderBook(project(), ideas);
  const rel = '雾港/章节/第1章 到港.md';
  const disk = diskOf(r.files);
  disk[rel] = obsidianRewrite(disk[rel]).replace(/缆桩边，/, '缆桩边，终于');
  const s = plan({ rendered: r.files, disk, state: stateOf(r.files) });
  assert.equal(s.pull.length, 1, JSON.stringify(s.pull.map((x) => x.rel)));
  assert.equal(s.pull[0].rel, rel);
  assert.match(s.pull[0].prose, /终于/, '拉回来的得是改过的正文');
});

test('库里加的其它属性必须活过 push：我们只写自己那几个键', () => {
  const r = renderBook(project(), ideas);
  const rel = '雾港/章节/第1章 到港.md';
  const disk = diskOf(r.files);
  disk[rel] = disk[rel].replace(/^---\n/, '---\naliases:\n  - 老雾\nlegibility: small\n');
  const p = project();
  p.chapters[0].content = '改写过的正文，缆桩换成了第九根。';
  const r2 = renderBook(p, ideas);
  const s = plan({ rendered: r2.files, disk, state: stateV2(r.files) });
  // 索引页的 words 是全书字数，正文一变它就跟着变——它一起推是对的，别的一律不许动
  assert.deepEqual(s.push.slice().sort(), [rel, '雾港/index.md'].sort(), '该推的就这两篇：' + JSON.stringify({ push: s.push, pull: s.pull.map((x) => x.rel), conflict: s.conflict.map((x) => x.rel) }));
  const merged = mergeForeignMeta(r2.files[rel].text, disk[rel]);
  assert.match(merged, /aliases:\n {2}- 老雾/, '他在库里加的 aliases 要原样留着：' + merged.slice(0, 220));
  assert.match(merged, /legibility: small/);
  assert.match(merged, /改写过的正文/, '我方改的正文要写得进去');
  assert.equal(parseFile(merged).meta.legibility, 'small');
  assert.equal(parseFile(merged).meta['wb-id'], 'c1', '我方键不许被覆盖');
  assert.equal(mergeForeignMeta(r2.files[rel].text, undefined), r2.files[rel].text, '库里没有旧文件时原样返回');
});

test('外来属性自己变了不算内容改动：既不用拉也不用推', () => {
  const r = renderBook(project(), ideas);
  const rel = '雾港/章节/第1章 到港.md';
  const disk = diskOf(r.files);
  disk[rel] = disk[rel].replace(/^---\n/, '---\nlegibility: large\n');
  const s = plan({ rendered: r.files, disk, state: stateV2(r.files) });
  assert.deepEqual([s.push.length, s.pull.length, s.conflict.length], [0, 0, 0], JSON.stringify({ push: s.push, pull: s.pull.map((x) => x.rel), conflict: s.conflict.map((x) => x.rel) }));
});

test('指纹只对我方认识的键敏感：正文与结构化字段一动就必须被发现', () => {
  const r = renderBook(project(), ideas);
  const rel = '雾港/章节/第1章 到港.md';
  const base = fingerprint(r.files[rel].text);
  assert.equal(base, fingerprint(obsidianRewrite(r.files[rel].text)), '写法不同、内容相同 → 指纹相同');
  const p = project();
  p.chapters[0].beats = '认船，并且看见了票';
  assert.notEqual(base, fingerprint(renderBook(p, ideas).files[rel].text), '改了细纲字段必须换指纹');
  const q = project();
  q.chapters[0].content += '多了一句。';
  assert.notEqual(base, fingerprint(renderBook(q, ideas).files[rel].text), '改了正文必须换指纹');
});

test('孤儿判定：书彻底删除才算孤儿，软删与同名幸存者都不算', () => {
  const r = renderBook(project(), ideas);
  const entry = (over = {}) => ({ files: stateOf(r.files), book: '雾港', syncedAt: NOW, ...over });
  const store = { 雾港: entry() };
  // 书活着（含软删：deletedAt 的书还在数组里）→ 不算孤儿
  assert.deepEqual(orphanedBookRoots(store, [project()]), []);
  assert.deepEqual(orphanedBookRoots(store, [project({ deletedAt: '2026-09-23T00:00:00.000Z' })]), [], '软删的书还能恢复，条目必须留着');
  // 彻底删除（数组里没有它）→ 孤儿
  assert.deepEqual(orphanedBookRoots(store, []), ['雾港']);
  // 改过名后条目 key 还是旧 root，但 index 页的 id 认得出：书活着 → 不算孤儿
  assert.deepEqual(orphanedBookRoots(store, [project({ title: '雾港改' })]), [], '改名不跟丢：id 还在就不算孤儿');
  // 老数据没有 index 记录：退化按书名匹配
  const legacy = { 雾港: entry({ files: { '雾港/章节/第1章 到港.md': stateOf(r.files)['雾港/章节/第1章 到港.md'] } }) };
  assert.deepEqual(orphanedBookRoots(legacy, [project()]), [], '按书名能对上就不算孤儿');
  assert.deepEqual(orphanedBookRoots(legacy, []), ['雾港'], '书名也对不上才算孤儿');
  // 同名幸存者（只能按书名认的老数据）：另一本同名书活着，条目分不清是谁的 → 宁可不清
  const other = project({ id: 'p2' });
  assert.deepEqual(orphanedBookRoots(legacy, [other]), [], '同名书还活着时不判孤儿（老数据无法区分是谁的）');
  // 新数据用 id 认：同名救不了已经删掉的那本
  assert.deepEqual(orphanedBookRoots(store, [other]), ['雾港'], 'id 对不上就该判孤儿，同名书救不了它');
  assert.deepEqual(orphanedBookRoots({}, [project()]), []);
  assert.deepEqual(orphanedBookRoots(undefined, undefined), []);
});
