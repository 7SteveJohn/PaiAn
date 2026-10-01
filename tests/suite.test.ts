// 常驻回归套件（npm test）
// 覆盖历年真实 bug 高危区：三层前情上下文、rollingSummary 优先级、草稿标记、
// 字数口径（分章/单文档）、伏笔过滤、战力线排序、示例数据自洽性。
// 运行方式见 tests/run.mjs（esbuild 打包后由 node --test 执行，零新增依赖）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAiContext,
  projectWords,
  countWords,
  buildFullText,
  chapterBriefLine,
  openForeshadowLines,
  powerChangeLines,
  parseOutlineToChapters,
  rulesSuffix,
  uid,
  chapterWordMap,
} from '../src/util';
import { buildSampleProject } from '../src/sample';
import { analyzeHealth } from '../src/health';

type Ch = {
  id: string;
  title: string;
  content: string;
  summary?: string;
  beats?: string;
  cast?: string;
  places?: string;
  hooks?: string;
  pending?: string;
};

function makeChapters(n: number): Ch[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `ch-${i}`,
    title: `场景${i + 1}`,
    content: `正文内容占位${i + 1}，人物走动，天色渐暗。`.repeat((i % 3) + 1),
    summary: i % 5 === 0 ? `本章梗概${i + 1}号` : undefined,
    beats: i % 2 === 0 ? `要点A推向要点B（第${i + 1}章）` : undefined,
    cast: i % 3 === 0 ? '林越、阿禾' : '阿禾',
  }));
}

test('uid 不重复', () => {
  assert.equal(new Set(Array.from({ length: 200 }, () => uid())).size, 200);
});

test('countWords：中文按字、英文数字串按词', () => {
  assert.equal(countWords(''), 0);
  assert.equal(countWords('你好世界abc 123'), 6); // 4 字 + abc + 123
  assert.equal(countWords('hello world'), 2);
  assert.equal(countWords('   \n\t  '), 0);
});

test('chapterWordMap：首建全量、改一章只重扫一章（增量缓存）', () => {
  const mk = (n: number, content: string) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, content: i % 2 ? content : '' }));
  const chs = mk(500, '晨光漫过旧站台。'.repeat(50));
  const r1 = chapterWordMap(chs);
  assert.equal(r1.map.size, 500);
  assert.equal(r1.misses, 500, '首建需要逐章计数');
  const expected = chs.reduce((a, c) => a + countWords(c.content), 0);
  assert.equal([...r1.map.values()].reduce((a, b) => a + b, 0), expected, '与逐章口径一致');

  // 模拟只 patch 第 7 章（该章有正文）：其余章 content 字符串引用不变
  const ch7Words = countWords(chs[7].content);
  const next = chs.map((c, i) => (i === 7 ? { ...c, content: c.content + '又添一句。' } : c));
  const r2 = chapterWordMap(next, r1.cache);
  assert.equal(r2.misses, 1, '只重扫被改动的一章');
  assert.equal(r2.map.get('c7'), countWords(next[7].content));
  assert.equal(countWords(next[7].content), ch7Words + 4, '该章新词数 = 旧词数 + 新增汉字');

  // 标题/卷名等非正文改动（content 引用不变）→ 零 miss（从 next 派生，保证与 r2 后缓存基线一致）
  const renamed = next.map((c, i) => (i === 3 ? { ...c, title: '改名' } : c));
  const r3 = chapterWordMap(renamed, r2.cache);
  assert.equal(r3.misses, 0, '非正文改动全部命中缓存');

  // 删除章节后缓存被修剪（不无限增长）
  const trimmed = next.slice(10);
  const r4 = chapterWordMap(trimmed, r2.cache);
  assert.equal(r4.map.size, trimmed.length);
  assert.ok(r4.cache.size <= trimmed.length * 2 + 64, '缓存有界');
});

test('rulesSuffix：只注入开启且有内容的规则', () => {
  assert.equal(rulesSuffix(), '');
  assert.equal(rulesSuffix([]), '');
  const out = rulesSuffix([
    { name: 'r1', content: '对话要短。', on: true },
    { name: 'r2', content: '这条不该出现', on: false },
    { name: 'r3', content: '   ', on: true },
  ]);
  assert.ok(out.includes('对话要短。'));
  assert.ok(!out.includes('不该出现'));
  assert.ok(out.startsWith('\n\n【写作规则'));
});

test('chapterBriefLine：有内容才输出，且带完整维度', () => {
  assert.equal(chapterBriefLine({ title: 'x' }), '');
  const line = chapterBriefLine({ title: 'x', beats: 'A→B', cast: '林越', places: '锈轨城', hooks: '残片' });
  assert.ok(line.startsWith('  └ '));
  for (const k of ['要点：A→B', '人物：林越', '地点：锈轨城', '伏笔：残片']) assert.ok(line.includes(k));
});

test('openForeshadowLines：回收/孤立/非伏笔全部排除', () => {
  const marks = [
    { type: '伏笔', status: '埋下', text: '长夜倒计时' },
    { type: '伏笔', status: '回收', text: '已回收的不该出现' },
    { type: '伏笔', orphaned: true, text: '孤立的不该出现' },
    { type: '背景', status: '埋下', text: '非伏笔类型不该出现' },
    { type: '伏笔', status: '埋下', text: '玉扣认主' },
  ] as const;
  const out = openForeshadowLines(marks as never);
  assert.ok(out.includes('长夜倒计时'));
  assert.ok(out.includes('玉扣认主'));
  assert.ok(!out.includes('不该出现'));
  assert.equal(out.split('\n').length, 2);
});

test('powerChangeLines：按章节号排序，无章号标待定', () => {
  const chapters = makeChapters(6);
  const lines = powerChangeLines(
    [
      {
        name: '林越',
        powerLog: [
          { chapterId: 'ch-4', text: '突破炼气三层' },
          { chapterId: 'ch-1', text: '引动玉扣，境界松动' },
        ],
      },
      { name: '路人', powerLog: [{ text: '伏笔中' }] },
    ],
    chapters,
  );
  assert.ok(lines.indexOf('第2章 林越') < lines.indexOf('第5章 林越'));
  assert.ok(lines.includes('路人：伏笔中（章节待定）'));
});

test('parseOutlineToChapters：剥章号、切冒号、滤分隔线', () => {
  const out = parseOutlineToChapters('第一章 风起：林越出场\n第2章 雨落：铁鸦现身\n---\n\n主角独自赶路');
  assert.deepEqual(out, [
    { title: '风起', summary: '林越出场' },
    { title: '雨落', summary: '铁鸦现身' },
    { title: '主角独自赶路', summary: '' },
  ]);
});

test('projectWords：章节模式累加各章，忽略空 draft', () => {
  const chapters = makeChapters(3);
  const total = chapters.reduce((a, c) => a + countWords(c.content), 0);
  const p = { mode: 'chapters' as const, draft: '不该计入', chapters };
  assert.equal(projectWords(p), total);
  assert.ok(total > 0);
  assert.equal(projectWords({ mode: 'single' as const, draft: '你好abc' }), 3);
  assert.equal(projectWords({ mode: 'single' as const, draft: '' }), 0);
});

test('buildFullText：章节模式带卷标拼接，单文档原样', () => {
  const chapters = makeChapters(2);
  const out = buildFullText({ mode: 'chapters', draft: 'x', chapters });
  assert.ok(out.startsWith('【第1章 场景1】'));
  assert.ok(out.includes('【第2章 场景2】'));
  assert.equal(buildFullText({ mode: 'single', draft: 'raw', chapters }), 'raw');
});

// —— buildAiContext：长篇 120 章时早期剧情不丢、总量有界（回归：曾只留 30 章标题索引）——
test('buildAiContext：第 100 章时第 1 章仍在、前情三层齐全、总量有界', () => {
  const chapters = makeChapters(120);
  const ctx = buildAiContext({ notes: '', mode: 'chapters', chapters }, 'ch-99');
  assert.ok(ctx.includes('【前情提要（最近 5 章）】'), '近场 5 章');
  assert.ok(ctx.includes('第95章 场景95'), '近场含第 95 章');
  assert.ok(ctx.includes('【中段剧情】'), '中场存在');
  assert.ok(ctx.includes('【早期剧情（按批聚合）】'), '远场兜底存在');
  assert.ok(ctx.includes('场景1'), '第 1 章标题保留');
  assert.ok(ctx.includes('【当前章节】第100章 场景100'));
  assert.ok(ctx.length < 4000, `上下文总量有界（实际 ${ctx.length}）`);
});

test('buildAiContext：rollingSummary 优先于远场兜底', () => {
  const chapters = makeChapters(60);
  const ctx = buildAiContext(
    {
      notes: '',
      mode: 'chapters',
      chapters,
      rollingSummary: { upTo: 3, text: 'ROLLING_MARKER 远场梗概标记文本' },
    },
    'ch-30',
  );
  assert.ok(ctx.includes('ROLLING_MARKER'), '用了全书梗概');
  assert.ok(ctx.includes('【全书梗概（第 1–3 章）】'), '标注覆盖范围');
  assert.ok(!ctx.includes('【早期剧情（按批聚合）】'), '不退化到按批兜底');
});

test('buildAiContext：草稿章节带标记，未写章节不硬凑', () => {
  const chapters = makeChapters(8);
  chapters[6] = { ...chapters[6], content: '', pending: '一段待审的草稿文字' };
  const ctx = buildAiContext({ notes: '', mode: 'chapters', chapters }, 'ch-7');
  assert.ok(ctx.includes('（草稿）'), '近场草稿有标记');
  assert.ok(ctx.includes('第7章 场景7'), '近场包含草稿章标题');
});

test('buildAiContext：cast 命中者排前（注入顺序稳定）', () => {
  const chapters = makeChapters(6); // ch-0 的 cast = 林越、阿禾
  const characters = [
    { name: '林越', state: '炼气三层' },
    { name: '阿禾', state: '左臂旧伤' },
    { name: '铁鸦', state: '筑基中期' },
  ];
  const ctx = buildAiContext({ notes: '', mode: 'chapters', chapters, characters }, 'ch-0');
  const iLin = ctx.indexOf('林越（当前状态');
  const iYa = ctx.indexOf('阿禾（当前状态');
  const iTie = ctx.indexOf('铁鸦（当前状态');
  assert.ok(iLin >= 0 && iYa >= 0 && iTie >= 0);
  assert.ok(iLin < iYa && iYa < iTie, 'cast 角色排在无关角色前');
});

test('buildAiContext：single 模式不带前情，只带备注', () => {
  const ctx = buildAiContext({ notes: '备注X', mode: 'single', chapters: makeChapters(6) });
  assert.ok(ctx.includes('备注X'));
  assert.ok(!ctx.includes('【前情提要'));
});

// —— 示例作品：数据必须自洽，否则空状态载入即坏 ——
test('示例作品：5 章跨 2 卷，内容/大纲字段齐全', () => {
  const p = buildSampleProject();
  assert.equal(p.chapters.length, 5);
  assert.equal(new Set(p.chapters.map((c) => c.volume)).size, 2);
  for (const c of p.chapters) {
    assert.ok(c.content.length > 100, `${c.title} 有正文`);
    assert.ok(c.summary && c.beats && c.cast && c.places && c.hooks, `${c.title} 大纲字段齐全`);
  }
  assert.equal(p.characters.length, 3);
  assert.equal(p.worldItems.length, 6);
  assert.equal(p.branches.length, 2);
});

test('示例作品：3 个伏笔锚点全部命中正文（slice===text）', () => {
  const p = buildSampleProject();
  assert.equal(p.marks.length, 3);
  for (const m of p.marks) {
    const ch = p.chapters.find((c) => c.id === m.chapterId);
    assert.ok(ch, `伏笔「${m.text}」有归属章节`);
    assert.equal(ch.content.slice(m.start, m.end), m.text, `「${m.text}」锚点坐标正确`);
  }
});

test('示例作品：滚动梗概覆盖到第 3 章；战力线落在真实章节', () => {
  const p = buildSampleProject();
  assert.equal(p.rollingSummary.upTo, 3);
  assert.ok(p.rollingSummary.text.length > 100);
  const ids = new Set(p.chapters.map((c) => c.id));
  const lin = p.characters.find((c) => c.name === '林越');
  assert.equal(lin.powerLog.length, 2);
  for (const pl of lin.powerLog) assert.ok(ids.has(pl.chapterId as string));
  const pl = powerChangeLines(p.characters as never, p.chapters as never);
  assert.ok(pl.indexOf('第3章 林越') < pl.indexOf('第5章 林越'));
});

test('示例作品：字数口径一致，上下文可注入第 5 章', () => {
  const p = buildSampleProject();
  assert.equal(projectWords(p), p.chapters.reduce((a, c) => a + countWords(c.content), 0));
  const ctx = buildAiContext(p as never, p.chapters[4].id);
  assert.ok(ctx.includes('【当前章节】第5章'));
  assert.ok(ctx.includes('【未回收伏笔'));
  const iLin = ctx.indexOf('林越（当前状态');
  const iTie = ctx.indexOf('铁鸦（当前状态');
  assert.ok(iLin >= 0 && iTie >= 0 && iLin < iTie, '第 5 章出场角色在前');
});

// —— 作品健康度 analyzeHealth：大纲页状态条的数据源（规则纯函数，可整体断言）——
type LiteCh = { id: string; title: string; content: string; pending?: string };
interface LiteProj {
  mode: 'chapters' | 'single';
  chapters: LiteCh[];
  marks: { type: string; status?: string; orphaned?: boolean; text: string }[];
  rollingSummary?: { upTo: number; text: string };
  target?: number;
}

// 章节模式健康测试工程：前 written 章写正文（shortAt 命中的章只给 50 字残章），
// 紧接 pending 章挂草稿，可配 rollingSummary / 悬空伏笔 / 字数目标。
function healthProject(cfg: { n: number; written?: number; shortAt?: number[]; pending?: number; rsUpTo?: number; openMarks?: number; target?: number }): LiteProj {
  const { n, shortAt = [], target = 0 } = cfg;
  const written = cfg.written ?? n;
  const chapters: LiteCh[] = Array.from({ length: n }, (_, i) => {
    const no = i + 1;
    const id = `ch-${no}`;
    if (no <= written) {
      const w = shortAt.includes(no) ? 50 : 900;
      return { id, title: `第${no}章`, content: '好'.repeat(w) };
    }
    if (no <= written + (cfg.pending ?? 0)) return { id, title: `第${no}章`, content: '', pending: '草稿文字占位'.repeat(20) };
    return { id, title: `第${no}章`, content: '' };
  });
  const marks: LiteProj['marks'] = Array.from({ length: cfg.openMarks ?? 0 }, (_, i) => ({ type: '伏笔', status: '埋下', text: `悬空伏笔${i}` }));
  if (cfg.openMarks) marks.push({ type: '伏笔', status: '回收', text: '已回收不计数' });
  return { mode: 'chapters', chapters, marks, ...(cfg.rsUpTo ? { rollingSummary: { upTo: cfg.rsUpTo, text: '梗概'.repeat(80) } } : {}), target };
}

const hasKey = (r: ReturnType<typeof analyzeHealth>, key: string) => !!r && r.issues.some((i) => i.key === key);
const levelOf = (r: ReturnType<typeof analyzeHealth>, key: string) => r?.issues.find((i) => i.key === key)?.level;

test('analyzeHealth：注入 wordOf 查表与逐章 countWords 结果一致', () => {
  const p = healthProject({ n: 30, rsUpTo: 30, shortAt: [7], openMarks: 2, target: 30000 });
  const plain = analyzeHealth(p as never);
  const viaMap = analyzeHealth(p as never, (c) => countWords(c.content ?? ''));
  assert.ok(plain && viaMap);
  assert.equal(viaMap.words, plain.words);
  assert.equal(viaMap.written, plain.written);
  assert.deepEqual(viaMap.issues, plain.issues, 'wordOf 只影响计算路径，不改变结论');
});

test('analyzeHealth：单文档模式与无章节项目不产出报告', () => {
  assert.equal(analyzeHealth({ mode: 'single', chapters: healthProject({ n: 3 }).chapters } as never), null);
  assert.equal(analyzeHealth({ mode: 'chapters', chapters: [] } as never), null);
});

test('analyzeHealth：全新大纲给开工引导，不判问题', () => {
  const r = analyzeHealth(healthProject({ n: 10, written: 0 }) as never);
  assert.ok(r);
  assert.equal(r.written, 0);
  assert.equal(r.todo, 10);
  assert.equal(r.issues.some((i) => i.level === 'warn'), false);
  assert.equal(hasKey(r, 'fresh'), true);
  assert.ok(r.issues[0].text.includes('正文还没有开写'));
});

test('analyzeHealth：写作进度健康时零问题', () => {
  const r = analyzeHealth(healthProject({ n: 20, rsUpTo: 20, openMarks: 0, target: 20000 }) as never);
  assert.ok(r);
  assert.equal(r.total, 20);
  assert.equal(r.written, 20);
  assert.equal(r.words, 20 * 900);
  assert.equal(r.targetPct, 90);
  assert.equal(r.issues.length, 0);
});

test('analyzeHealth：已写残章标记为 warn（第 3 章 50 字）', () => {
  const r = analyzeHealth(healthProject({ n: 12, rsUpTo: 12, shortAt: [3] }) as never);
  assert.equal(levelOf(r, 'short-ch'), 'warn');
  assert.ok(r!.issues[0].text.includes('第3章'));
});

test('analyzeHealth：写满 12 章未生成全书梗概 → warn', () => {
  const r = analyzeHealth(healthProject({ n: 12 }) as never);
  assert.equal(levelOf(r, 'arc-missing'), 'warn');
  // 11 章以内属于正常节奏，不催
  assert.equal(hasKey(analyzeHealth(healthProject({ n: 11 }) as never), 'arc-missing'), false);
});

test('analyzeHealth：全书梗概落后正文 ≥3 章 → warn', () => {
  const r = analyzeHealth(healthProject({ n: 12, rsUpTo: 9 }) as never);
  assert.equal(levelOf(r, 'arc-stale'), 'warn');
  // 落后 2 章以内仍在正常写作节奏，不催
  assert.equal(hasKey(analyzeHealth(healthProject({ n: 12, rsUpTo: 10 }) as never), 'arc-stale'), false);
});

test('analyzeHealth：草稿 ≥2 章提示积压，1 章不催', () => {
  assert.equal(hasKey(analyzeHealth(healthProject({ n: 12, written: 10, pending: 2, rsUpTo: 10 }) as never), 'pending'), true);
  assert.equal(hasKey(analyzeHealth(healthProject({ n: 12, written: 11, pending: 1, rsUpTo: 11 }) as never), 'pending'), false);
});

test('analyzeHealth：悬空伏笔按未回收计数，回收的不算', () => {
  const r = analyzeHealth(healthProject({ n: 12, rsUpTo: 12, openMarks: 3 }) as never);
  assert.equal(levelOf(r, 'open-marks'), 'info');
  assert.ok(r!.issues.find((i) => i.key === 'open-marks')!.text.startsWith('3 条伏笔'));
});

test('analyzeHealth：同时多类问题时 warn 全部排在 info 前', () => {
  const r = analyzeHealth(healthProject({ n: 12, written: 11, pending: 1, shortAt: [4], openMarks: 1 }) as never);
  assert.ok(r);
  const levels = r.issues.map((i) => i.level);
  const firstInfo = levels.indexOf('info');
  const lastWarn = levels.lastIndexOf('warn');
  assert.ok(firstInfo === -1 || lastWarn < firstInfo, `warn 全在 info 前（实际 ${levels.join(',')}）`);
  assert.equal(r.issues[0].key, 'short-ch');
});

test('analyzeHealth：未启用字数目标时 targetPct 为 null', () => {
  const r = analyzeHealth(healthProject({ n: 12, rsUpTo: 12 }) as never);
  assert.equal(r!.target, 0);
  assert.equal(r!.targetPct, null);
});
