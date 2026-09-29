// 节奏琴键与对白天平的数据层：把每章的节律与「谁在说话」压成可画、可诊断的形状。
// 全部确定性字符串分析，不调模型——要的是「一眼看出第 40 章开始塌了」，不是又一份数字表格。
import { chapterStats, type ChapterStats } from './bench';
import { quoteRanges } from './deslop';
import type { Project } from './types';

// 找说话人时只看引号前后这点字符：中文的「XX 说」几乎都紧贴着
const WINDOW = 40;
const SPEECH_VERB = /(说|道|问|答|喊|喝|叫|应|笑|骂|开口|低声|高声|沉声|嘟囔|喃喃|补充|重复|打断|叹)/;

export interface Speaker {
  name: string;
  lines: number; // 归到名下的台词行数（含推断）
  words: number; // 这些台词的字数
  inferred: number; // 其中靠连续对话轮替推断出来的行数
}

export interface Roll extends ChapterStats {
  no: number;
  speakers: Speaker[]; // 按行数降序
  spoken: number; // 有归属的台词行数（含推断）
  quoted: number; // 台词总行数
  unknown: number; // 归属不明的行数（引号内但没找到说话人）
  inferred: number; // spoken 里靠轮替推断出来的行数
  top: string; // 话最多的人
}

export interface Silence {
  name: string;
  gap: number; // 最长连续缺席章数
  since: number; // 距最近一次出场/说话过了几章
  lastSpoke: number; // 最后一次说话的章号（0=从没说过）
  inCast: number; // 被列进出场名单的章数
}

/** 引号内的每一行台词（含位置），按出现顺序 */
export function dialogueLines(body: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  for (const [a, b] of quoteRanges(body)) {
    const text = body.slice(a, b);
    if (!text.trim()) continue;
    out.push({ start: a, end: b, text });
  }
  return out.sort((x, y) => x.start - y.start);
}

const byLengthDesc = (names: string[]) => [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length || a.localeCompare(b));

const BOUNDARY = /[「」『』“”‘’\n。！？?]/;
// 只看紧邻这段台词的叙述：越过引号、换行、句读就不算，否则会把上一行的「XX 问」误认成这一行的
const tailNarration = (s: string) => {
  let cut = -1;
  for (let i = 0; i < s.length; i++) if (BOUNDARY.test(s[i])) cut = i;
  return cut < 0 ? s : s.slice(cut + 1);
};
const headNarration = (s: string) => {
  for (let i = 0; i < s.length; i++) if (BOUNDARY.test(s[i])) return s.slice(0, i);
  return s;
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 给一行台词找说话人：引号前后紧贴的那点叙述里，「名字 + 说话动词」或「名字 + 冒号」才算。
 * 两边都命中时取离引号更近的那个；都不命中就留白——宁可空着也不摊到某个角色头上。
 */
export function attributeSpeaker(body: string, line: { start: number; end: number }, names: string[]): string {
  const before = tailNarration(body.slice(Math.max(0, line.start - WINDOW), line.start));
  const after = headNarration(body.slice(line.end, line.end + WINDOW));
  let best = '';
  let bestDist = 1e9;
  for (const n of names) {
    const mB = new RegExp(esc(n) + '[^\\n]{0,8}$').exec(before);
    if (mB) {
      const seg = before.slice(mB.index + n.length);
      // 「林越说：」「阿禾摇头：」——名字到引号之间只要收在冒号上，就是他在说
      if (SPEECH_VERB.test(seg) || /[：:]\s*$/.test(seg)) {
        const d = before.length - mB.index;
        if (d < bestDist) {
          best = n;
          bestDist = d;
        }
      }
    }
    const mA = new RegExp('^\\s{0,3}' + esc(n)).exec(after);
    if (mA) {
      const seg = after.slice(mA.index + n.length);
      if (SPEECH_VERB.test(seg.slice(0, 6)) || /^[：:，,]/.test(seg.trim())) {
        const dist = mA.index; // 名字离引号多远：与 before 侧同一把尺子
        if (dist < bestDist) {
          best = n;
          bestDist = dist;
        }
      }
    }
  }
  return best;
}

const countWords = (s: string) => s.replace(/[\s「」“”‘’『』]/g, '').length;

// 「短引号」的字数上限：一问一答的短台词轮替才稳，长独白推错了代价太高——留白但仍占一个轮替位
const INFER_MAX = 60;

/**
 * 连续对话轮替推断：两行台词之间只隔着空白算同一条对话链；链内确定归属的说话人恰好两人时，
 * 没锚的行按「跟上一句换人」顶上。推断要过三道闸，过不了就留白：
 * ① 链首没锚不推（不知道是独白还是对话）；② 长过 INFER_MAX 的行不推；
 * ③ 段末推出来的与下一个确定锚点对不上，整段作废。
 */
function inferAlternating(body: string, lines: { start: number; end: number; text: string }[], who: string[], names: string[]): Map<number, string> {
  const out = new Map<number, string>();
  // 两行台词之间算不算连续对话：纯空白算；隔着「阿禾摇头：」这类紧贴锚语也算——
  // 前挂式锚（阿禾摇头：「…」）天然和上一行台词隔几个字，不能因此断链。
  const gapAnchor = (gap: string) =>
    names.some((n) => {
      const m = new RegExp(esc(n) + '.{0,8}$').exec(gap);
      if (!m) return false;
      const seg = gap.slice(m.index + n.length);
      return SPEECH_VERB.test(seg) || /[：:]\s*$/.test(seg);
    });
  const chainBreak = (gap: string) => {
    if (!gap.trim()) return false;
    const tail = tailNarration(gap); // 最后句读/换行之后、紧贴下一行引号的那段
    if (gap.slice(0, gap.length - tail.length).trim()) return true; // 紧邻段之外还隔着叙述：断
    return tail.length > 0 && !gapAnchor(tail); // 紧邻段不是锚语也不是空：断
  };
  let chainStart = 0;
  const closeChain = (from: number, to: number) => {
    const certain = [...new Set(who.slice(from, to).filter(Boolean))];
    if (certain.length !== 2) return; // 不是恰好两人的一问一答：认不出就留白
    let expect = '';
    let seg: { i: number; guess: string }[] = [];
    const flush = (anchor: string) => {
      if (anchor && expect !== anchor) seg = []; // 推出的与锚点冲突：整段作废，认不出就留白
      for (const { i, guess } of seg) out.set(i, guess);
      seg = [];
    };
    for (let k = from; k < to; k++) {
      if (who[k]) {
        flush(who[k]);
        expect = who[k];
        continue;
      }
      if (!expect) continue; // 链首没锚不推
      const guess = certain.find((n) => n !== expect);
      if (!guess) continue; // expect 不在两人里（理论到不了，兜住）
      expect = guess;
      if (countWords(lines[k].text) <= INFER_MAX) seg.push({ i: k, guess });
    }
    flush(''); // 链尾段没有下一个锚可校验，两人锚定过就直接生效
  };
  for (let i = 1; i <= lines.length; i++) {
    const broken = i === lines.length || chainBreak(body.slice(lines[i - 1].end, lines[i].start));
    if (broken) {
      closeChain(chainStart, i);
      chainStart = i;
    }
  }
  return out;
}

/** 一章：节奏统计 + 对白天平 */
export function rollOf(no: number, title: string, body: string, names: string[], infer = true): Roll {
  const base = chapterStats(no, title, body);
  const lines = dialogueLines(body);
  const who = lines.map((l) => attributeSpeaker(body, l, names));
  const guesses = infer ? inferAlternating(body, lines, who, names) : new Map<number, string>();
  const tally = new Map<string, Speaker>();
  let unknown = 0;
  let inferred = 0;
  const add = (name: string, words: number, guess: boolean) => {
    const cur = tally.get(name) ?? { name, lines: 0, words: 0, inferred: 0 };
    cur.lines++;
    cur.words += words;
    if (guess) cur.inferred++;
    tally.set(name, cur);
  };
  lines.forEach((l, i) => {
    const words = countWords(l.text);
    const guess = guesses.get(i);
    if (who[i]) {
      add(who[i], words, false);
      return;
    }
    if (guess) {
      inferred++;
      add(guess, words, true);
      return;
    }
    unknown++;
  });
  const speakers = [...tally.values()].sort((a, b) => b.lines - a.lines || b.words - a.words || a.name.localeCompare(b.name));
  return {
    ...base,
    no,
    speakers,
    spoken: speakers.reduce((s, x) => s + x.lines, 0),
    quoted: lines.length,
    unknown,
    inferred,
    top: speakers[0]?.name ?? '',
  };
}

/** 整本书的琴键：只统计有正文的章 */
export function rollsOf(project: Project, infer = true): Roll[] {
  const names = byLengthDesc((project.characters ?? []).map((c) => c.name));
  const chapters = (project.chapters ?? []).filter((c) => (c.content ?? '').trim());
  return chapters.map((c, i) => rollOf(i + 1, c.title, c.content ?? '', names, infer));
}

const castOf = (project: Project, chapterId: string) => {
  const c = (project.chapters ?? []).find((x) => x.id === chapterId);
  return (c?.cast ?? '')
    .split(/[、,，;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
};

/**
 * 谁消失了：连续多少章没说话（且没被列进出场名单），以及最后一次说话距今几章。
 * 「列了名单却没台词」不算说话——那只说明作者记得他在这，不说明他在演。
 */
export function silences(project: Project, rolls: Roll[]): Silence[] {
  const names = byLengthDesc((project.characters ?? []).map((c) => c.name));
  const castByNo = new Map<number, string[]>();
  const written = (project.chapters ?? []).filter((c) => (c.content ?? '').trim());
  written.forEach((c, i) => castByNo.set(i + 1, castOf(project, c.id)));
  const total = rolls.length;
  const out: Silence[] = [];
  for (const name of names) {
    const spoke: number[] = [];
    let inCast = 0;
    rolls.forEach((r) => {
      if (r.speakers.some((s) => s.name === name)) spoke.push(r.no);
      if ((castByNo.get(r.no) ?? []).includes(name)) inCast++;
    });
    const absent = (n: number) => !spoke.includes(n) && !(castByNo.get(n) ?? []).includes(name);
    let gap = 0;
    let run = 0;
    for (let n = 1; n <= total; n++) {
      run = absent(n) ? run + 1 : 0;
      gap = Math.max(gap, run);
    }
    const last = spoke[spoke.length - 1] ?? 0;
    out.push({ name, gap, since: total - last, lastSpoke: last, inCast });
  }
  return out.sort((a, b) => b.gap - a.gap || b.since - a.since);
}

/** 中位数：琴键的基准线用它，不被个别长章带跑 */
export function median(values: number[]): number {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** 琴键的取数：句长按中位数归一，超过上限就截（条子再高也只是更长的一句话） */
export function normalize(rolls: Roll[]) {
  const med = median(rolls.map((r) => r.avgSentence));
  return {
    med,
    bars: rolls.map((r) => ({
      ...r,
      pitch: Math.min(1, med > 0 ? r.avgSentence / (med * 2.2) : 0),
      wet: Math.min(1, r.dialogueShare / 60),
      slop: Math.min(1, (Object.values(r.deslop).reduce((a, b) => a + b, 0) / Math.max(1, r.chars)) * 1000 / 6),
    })),
  };
}
