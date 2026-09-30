// 拆文对标：把一本参考书（粘贴进来的文本）按章拆成**纯统计**，与自己的书并排比节奏，
// 再把差距做成卡掉进卡池。全程确定性计算——不调模型、不联网、不存原文。
//
// 为什么只存统计：对标一本 500 章的书如果连正文一起存，等于把刚解决掉的包体问题
// 再买一遍；而节奏对照需要的只是每章几个数字，几十 KB 就够。原文请留在自己的库里。
import { DESLOP_RULES, quoteRanges, scanDeslop } from './deslop';
import { quotedShare } from './constraints';
import type { GachaCard } from './gacha';

const SENT_SPLIT = /[。！？…；\n]+/;
const CHAPTER_HEAD = /^\s*(?:第\s*[0-9零一二三四五六七八九十百千]+\s*章|【.*?章.*?】|[0-9]{1,4}\s*[、.．]\s*\S)/;

export interface ChapterStats {
  n: number;
  title: string;
  chars: number;
  sentences: number;
  avgSentence: number;
  maxSentence: number;
  dialogueShare: number; // 引号内字符占全章比例
  pronounOpen: number; // 以「他/她/它」开头的段数
  paragraphs: number;
  opener: string; // 开篇第一句是什么类型：对白 / 人称 / 名字 / 环境动作
  endsOnTalk: boolean; // 章末落在对白上（追读钩子的常见做法）
  deslop: Record<string, number>; // AI 味句式命中数，按规则 key 计
}

export interface BenchBook {
  id: string;
  title: string;
  createdAt: string;
  chapters: ChapterStats[];
}

export interface Rhythm {
  chapters: number;
  avgSentence: number;
  maxSentenceP90: number;
  dialogueShare: number;
  pronounOpenPerK: number;
  endsOnTalkShare: number;
  deslopPerK: Record<string, number>;
}


// 按章节标题切分；识别不到章标题时退回空行分段，保证任何粘贴都能出结果
export function splitChapters(text: string): { title: string; body: string }[] {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n');
  const out: { title: string; body: string }[] = [];
  let cur: { title: string; lines: string[] } | null = null;
  for (const line of lines) {
    if (CHAPTER_HEAD.test(line)) {
      if (cur) out.push({ title: cur.title, body: cur.lines.join('\n').trim() });
      cur = { title: line.trim().slice(0, 40), lines: [] };
      continue;
    }
    if (!cur) {
      if (!line.trim()) continue;
      cur = { title: '（开篇）', lines: [] };
    }
    cur.lines.push(line);
  }
  if (cur) out.push({ title: cur.title, body: cur.lines.join('\n').trim() });
  return out.filter((c) => c.body.length > 0);
}

const narrationSentences = (body: string) => {
  const ranges = quoteRanges(body);
  let clean = body;
  if (ranges.length) {
    let acc = '';
    let cursor = 0;
    for (const [a, b] of ranges) {
      if (a > cursor) acc += body.slice(cursor, a);
      cursor = Math.max(cursor, b);
    }
    clean = acc + body.slice(cursor);
  }
  return clean
    .split(SENT_SPLIT)
    .map((x) => x.trim())
    .filter(Boolean);
};

function openerOf(body: string): string {
  const first = body.trim().slice(0, 12);
  if (/^[「“‘]/.test(first)) return '对白';
  if (/^(他|她|它)(?![们])/.test(first)) return '人称';
  const hit = narrationSentences(body)[0] ?? '';
  if (/^[A-Za-z\u4e00-\u9fa5]{1,3}[，、]/.test(hit) && /[「“]/.test(body.slice(0, 200))) return '名字';
  return '环境或动作';
}

export function chapterStats(n: number, title: string, body: string): ChapterStats {
  const sentences = narrationSentences(body);
  const lens = sentences.map((x) => x.length);
  const paras = body.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const hits = scanDeslop(body);
  const deslop: Record<string, number> = {};
  for (const h of hits) deslop[h.key] = (deslop[h.key] ?? 0) + 1;
  const tail = body.trim().slice(-24);
  return {
    n,
    title,
    chars: body.length,
    sentences: sentences.length,
    avgSentence: sentences.length ? Math.round(lens.reduce((a, b) => a + b, 0) / sentences.length) : 0,
    maxSentence: lens.length ? Math.max(...lens) : 0,
    dialogueShare: quotedShare(body),
    pronounOpen: paras.filter((p) => !/^[「“‘]/.test(p) && /^(他|她|它)(?![们])/.test(p)).length,
    paragraphs: paras.length,
    opener: openerOf(body),
    endsOnTalk: /[」”’…！?？]/.test(tail.slice(-1)) || /[」”’]$/.test(tail),
    deslop,
  };
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h).toString(36).slice(0, 6);
};

// 一本书的节律指纹：全部取中位数或千分位比，避免被个别超长章带跑
export function rhythm(chapters: ChapterStats[]): Rhythm {
  if (!chapters.length) return { chapters: 0, avgSentence: 0, maxSentenceP90: 0, dialogueShare: 0, pronounOpenPerK: 0, endsOnTalkShare: 0, deslopPerK: {} };
  const sorted = [...chapters].sort((a, b) => a.avgSentence - b.avgSentence);
  const med = sorted[Math.floor(sorted.length / 2)].avgSentence;
  const maxes = [...chapters].sort((a, b) => a.maxSentence - b.maxSentence);
  const totalChars = chapters.reduce((a, c) => a + c.chars, 0) || 1;
  const deslopPerK: Record<string, number> = {};
  for (const r of DESLOP_RULES) {
    const n = chapters.reduce((a, c) => a + (c.deslop[r.key] ?? 0), 0);
    deslopPerK[r.key] = Math.round((n / totalChars) * 10000) / 10;
  }
  return {
    chapters: chapters.length,
    avgSentence: med,
    maxSentenceP90: maxes[Math.floor(maxes.length * 0.9)]?.maxSentence ?? 0,
    dialogueShare: Math.round(chapters.reduce((a, c) => a + c.dialogueShare, 0) / chapters.length),
    pronounOpenPerK: Math.round((chapters.reduce((a, c) => a + c.pronounOpen, 0) / totalChars) * 1000) / 1,
    endsOnTalkShare: Math.round((chapters.filter((c) => c.endsOnTalk).length / chapters.length) * 100),
    deslopPerK,
  };
}

export function analyzeBook(title: string, text: string, now = new Date().toISOString()): BenchBook {
  const parts = splitChapters(text);
  return {
    id: 'b' + hash(title + '|' + parts.length + '|' + (parts[0]?.body.length ?? 0)),
    title: title.trim() || parts[0]?.title || '未命名对标书',
    createdAt: now,
    chapters: parts.map((p, i) => chapterStats(i + 1, p.title, p.body)),
  };
}

export function myStats(project: { chapters?: { id: string; title: string; content: string }[]; draft?: string; mode?: string }): ChapterStats[] {
  if (project.mode === 'chapters' && project.chapters?.length) {
    return project.chapters.filter((c) => (c.content || '').trim()).map((c, i) => chapterStats(i + 1, c.title, c.content || ''));
  }
  const body = (project.draft || '').trim();
  return body ? [chapterStats(1, '全文', body)] : [];
}

export interface Gap {
  key: string;
  label: string;
  mine: number;
  theirs: number;
  unit: string;
  worth: boolean; // 差距是否值得做一张卡
}

const gap = (key: string, label: string, mine: number, theirs: number, unit: string, minDiff: number): Gap => ({
  key,
  label,
  mine,
  theirs,
  unit,
  worth: Math.abs(theirs - mine) >= minDiff,
});

// 对标书 vs 我的书：只报有把握的差距，样本太小（<3 章）时全部不报
export function compare(mine: ChapterStats[], theirs: ChapterStats[]): Gap[] {
  if (mine.length < 3 || theirs.length < 3) return [];
  const a = rhythm(mine);
  const b = rhythm(theirs);
  const per = (x: ChapterStats[]) => x.reduce((s, c) => s + c.chars, 0) / x.length;
  return [
    gap('avgSentence', '叙述平均句长', a.avgSentence, b.avgSentence, '字', 4),
    gap('dialogueShare', '对白占比', a.dialogueShare, b.dialogueShare, '%', 12),
    gap('pronounOpen', '段首人称密度', a.pronounOpenPerK, b.pronounOpenPerK, '处/千字', 2),
    gap('endsOnTalk', '章末落在对白', a.endsOnTalkShare, b.endsOnTalkShare, '%的章', 25),
    gap('chars', '单章篇幅', Math.round(per(mine)), Math.round(per(theirs)), '字', 300),
    ...DESLOP_RULES.filter((r) => r.level >= 4).map((r) => gap('deslop:' + r.key, `AI 味·${r.label}`, a.deslopPerK[r.key] ?? 0, b.deslopPerK[r.key] ?? 0, '处/千字', 0.4)),
  ];
}

// 掉卡：从「它常做而你不做」的特征里长出一张卡。id 由差距键决定，重复拆解不会堆重复卡。
// self=true 时对照物是作者自己的惯常笔触（style.ts），卡面把「学它」换成「找回」。
export function cardsFromGaps(book: BenchBook, gaps: Gap[], self = false): GachaCard[] {
  const src = self ? '你惯常的笔触' : `《${book.title}》`;
  const they = self ? '你那时' : '它';
  const pre = self ? '找回' : '学它';
  const dslLead = self ? '你惯常的笔触里几乎不用这个句式' : `对标${src}全章几乎不用这个句式`;
  const out: GachaCard[] = [];
  for (const g of gaps) {
    if (!g.worth) continue;
    const lower = g.theirs < g.mine;
    if (g.key === 'avgSentence' && lower) {
      out.push({
        id: 'b-sent-' + hash(book.id),
        series: '练笔',
        rarity: 'N',
        name: `${pre}：句长压到 ${g.theirs} 字`,
        effect: 'constraint',
        payload: `对标${src}——${they}的叙述平均 ${g.theirs} 字一句，你 ${g.mine} 字。本章把句子拆短，宁可多分段也别用逗号拖。`,
        constraints: [{ kind: 'maxSentence', chars: Math.max(12, Math.round(g.theirs * 1.3)) }],
      });
    }
    if (g.key === 'dialogueShare' && !lower) {
      out.push({
        id: 'b-talk-' + hash(book.id),
        series: '练笔',
        rarity: 'R',
        name: `${pre}：对白占到 ${g.theirs}%`,
        effect: 'constraint',
        payload: `对标${src}——${they}靠对白推进（约 ${g.theirs}%），你只有 ${g.mine}%。本章把至少两处叙述改成开口，别替读者解释。`,
        constraints: [{ kind: 'dialogueShare', min: Math.max(8, g.theirs - 10) }],
      });
    }
    if (g.key === 'pronounOpen' && !lower) {
      out.push({
        id: 'b-open-' + hash(book.id),
        series: '练笔',
        rarity: 'N',
        name: `${pre}：换掉段首人称`,
        effect: 'constraint',
        payload: `对标${src}——${they}每千字 ${g.theirs} 处以人物名开头，你 ${g.mine} 处。本章段首换成物件、动作、声音或地点。`,
        constraints: [{ kind: 'pronounOpen', max: 1 }],
      });
    }
    if (g.key === 'endsOnTalk' && !lower) {
      out.push({
        id: 'b-tail-' + hash(book.id),
        series: '练笔',
        rarity: 'R',
        name: `${pre}：章末留一句话`,
        effect: 'constraint',
        payload: `对标${src}——${they} ${g.theirs}% 的章停在对白上，你 ${g.mine}%。本章结尾停在一句没说完的话上，别总结。`,
        constraints: [{ kind: 'any', words: ['——', '…', '「'] }],
      });
    }
    if (g.key.startsWith('deslop:') && lower) {
      const key = g.key.slice(7);
      out.push({
        id: 'b-dsl-' + key + '-' + hash(book.id),
        series: '练笔',
        rarity: 'SR',
        name: `戒掉：${g.label.replace('AI 味·', '')}`,
        effect: 'constraint',
        payload: `${dslLead}（${g.theirs} 处/千字），你有 ${g.mine} 处。本章一处都别出现。`,
        constraints: [{ kind: 'deslopMax', key, count: 0 }],
      });
    }
  }
  return out;
}
