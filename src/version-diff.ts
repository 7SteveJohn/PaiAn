// 版本对比的纯函数层：段落对齐 + 段内字符级精比。全部本地计算，不碰网络、不改正文。
//
// 为什么两级：整篇直接做字符 diff，在「大段重写」时会把改动撒成满屏碎屑，读不出
// 「哪一段没了」；只做段落对齐又看不出「这一段里到底改了哪个词」。所以先按行对齐，
// 配得上的一对（旧段↔新段）再在段内做字符级精比，相似度不够就整段成块——
// 宁可粗，不撒碎屑。所有降级路径都只是变粗，不会变错。
//
// 算法用 jsdiff（成熟实现），并给它两道闸：maxEditLength 超限返回 undefined、
// timeout 超时就地停——两条都只让结果退化成整段 del+ins，绝不会卡死界面。
import { diffArrays, diffChars } from 'diff';

export type DiffSpanType = 'same' | 'del' | 'ins';
export interface DiffSpan {
  t: DiffSpanType;
  text: string;
}

// 配对两段合计超过这个字数就不做段内精比（散文一段几十到几百字，6000 已经是极端重排）
const PAIR_MAX_CHARS = 6000;
// 段内编辑距离上限：超过说明这对段落基本是「换了一段」，精比只会撒碎屑
const INNER_MAX_EDIT = 3000;
// 段内精比的兜底停表
const INNER_TIMEOUT_MS = 300;
// 段内相同字符占比低于这个数，就不值得逐字标红绿，整段成块更可读
const INNER_MIN_SIMILARITY = 0.42;
// 行对齐的编辑距离上限（单位：行）。一首 20 章的书全部重排也到不了这个数；
// 超限说明两份文本基本无关，直接整篇成块
const LINES_MAX_EDIT = 40000;

function push(out: DiffSpan[], t: DiffSpanType, text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.t === t) last.text += text;
  else out.push({ t, text });
}

// 一行占一个 span；行尾一律带 \n，渲染时靠 pre-wrap 折行——删行和增行各占一行，
// 这是复盘时最好读的形状。行内精比的 span 不带换行，配对块结束后补一个结构性的 \n。
function emitLines(out: DiffSpan[], lines: string[], t: DiffSpanType) {
  for (const line of lines) push(out, t, line + '\n');
}

// 配对做段内精比；返回 null 表示这对不值得精比（调用方退成整段成块）
function innerSpans(d: string, s: string): DiffSpan[] | null {
  if (!d || !s) return null;
  if (d.length + s.length > PAIR_MAX_CHARS) return null;
  let parts;
  try {
    parts = diffChars(d, s, { maxEditLength: INNER_MAX_EDIT, timeout: INNER_TIMEOUT_MS });
  } catch {
    return null;
  }
  if (!parts) return null;
  let same = 0;
  for (const p of parts) if (!p.added && !p.removed) same += p.count;
  if (same / Math.max(d.length, s.length, 1) < INNER_MIN_SIMILARITY) return null;
  const out: DiffSpan[] = [];
  for (const p of parts) push(out, p.added ? 'ins' : p.removed ? 'del' : 'same', p.value);
  push(out, 'same', '\n');
  return out;
}

export function diffTexts(oldText: string, newText: string): DiffSpan[] {
  if (oldText === newText) return oldText ? [{ t: 'same', text: oldText }] : [];
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const parts = diffArrays(a, b, { maxEditLength: LINES_MAX_EDIT });
  if (!parts) return [{ t: 'del', text: oldText }, { t: 'ins', text: newText }];
  const out: DiffSpan[] = [];
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (!p.added && !p.removed) {
      emitLines(out, p.value, 'same');
      i++;
      continue;
    }
    const dels: string[][] = [];
    const inss: string[][] = [];
    while (i < parts.length && parts[i].removed) dels.push(parts[i++].value);
    while (i < parts.length && parts[i].added) inss.push(parts[i++].value);
    const pairs = Math.min(dels.length, inss.length);
    for (let k = 0; k < pairs; k++) {
      const inner = innerSpans(dels[k].join('\n'), inss[k].join('\n'));
      if (inner) for (const sp of inner) push(out, sp.t, sp.text);
      else {
        emitLines(out, dels[k], 'del');
        emitLines(out, inss[k], 'ins');
      }
    }
    for (let k = pairs; k < dels.length; k++) emitLines(out, dels[k], 'del');
    for (let k = pairs; k < inss.length; k++) emitLines(out, inss[k], 'ins');
  }
  return out;
}

// 对比头的一行摘要：这版比现在多多少、少多少（按字符，不是按字数口径——只是个量级感）
export function diffStat(spans: DiffSpan[]): { del: number; ins: number } {
  let del = 0;
  let ins = 0;
  for (const s of spans) {
    if (s.t === 'del') del += s.text.length;
    else if (s.t === 'ins') ins += s.text.length;
  }
  return { del, ins };
}
