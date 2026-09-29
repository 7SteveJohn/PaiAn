/**
 * 场景块：把一章正文按空行切成可重排的块，纯函数层。
 *
 * 唯一的硬约束是**拼回去必须与原稿逐字节相等**——切块只是看结构的手段，不是重排格式的机会。
 * 所以块与块之间的空隙原样存进 gaps（含块末那个换行、所有空行、以及首尾空白），
 * 一个字节都不规整：CRLF、段间两个空行、结尾没有换行，这些都必须能原样回来。
 * 重排只动 items 的顺序、gaps 按位置保持不动，于是「挪一块」绝不会顺带改掉全章的空行形状。
 */

export type SceneUnit = '场' | '段';

export interface SceneSplit {
  items: string[];
  /** 长度恒为 items.length + 1：gaps[0] 是首块之前的空白，gaps[i] 是第 i-1 块之后到第 i 块之前 */
  gaps: string[];
  /** 切分依据：空行（场）还是单换行（段）——用哪种取决于作者的分段习惯 */
  unit: SceneUnit;
}

const blank = (line: string) => line.trim() === '';

/** 逐行偏移：空隙要用「原文里的那一段」表示，所以全程带下标切片，不重组字符串 */
function lineOffsets(text: string) {
  const offs: { start: number; end: number; blank: boolean }[] = [];
  let pos = 0;
  for (const line of text.split('\n')) {
    offs.push({ start: pos, end: pos + line.length, blank: blank(line) });
    pos += line.length + 1;
  }
  return offs;
}

function spansOf(offs: { start: number; end: number; blank: boolean }[], perLine: boolean) {
  const spans: [number, number][] = [];
  for (let i = 0; i < offs.length; i++) {
    if (offs[i].blank) continue;
    if (perLine) {
      spans.push([offs[i].start, offs[i].end]);
      continue;
    }
    const st = offs[i].start;
    let j = i;
    let e = offs[j].end;
    // 往后吃到连续的非空行为止；空行留给「块与块之间的空隙」，不进块
    while (j + 1 < offs.length && !offs[j + 1].blank) {
      j++;
      e = offs[j].end;
    }
    i = j;
    spans.push([st, e]);
  }
  return spans;
}

function pack(text: string, spans: [number, number][], unit: SceneUnit): SceneSplit {
  if (!spans.length) return { items: [], gaps: [text], unit };
  const gaps: string[] = [text.slice(0, spans[0][0])];
  for (let i = 0; i < spans.length - 1; i++) gaps.push(text.slice(spans[i][1], spans[i + 1][0]));
  gaps.push(text.slice(spans[spans.length - 1][1]));
  return { items: spans.map(([a, b]) => text.slice(a, b)), gaps, unit };
}

/**
 * 切块。默认按空行切（网文里一个空行多半就是一个场景的边界）；
 * 只切出一块而这块又有多行，说明作者用单换行分段——退一段粒度，别让他对着一张卡发呆。
 */
export function splitScenes(text: string): SceneSplit {
  const t = String(text ?? '');
  const offs = lineOffsets(t);
  const byBlank = spansOf(offs, false);
  if (byBlank.length >= 2) return pack(t, byBlank, '场');
  const byLine = spansOf(offs, true);
  if (byLine.length >= 2) return pack(t, byLine, '段');
  return pack(t, byBlank, '场');
}

/** 拼回正文：与 splitScenes 的输入逐字节相等（tests/scenes.test.ts 拿真稿样本钉这条） */
export function joinScenes(s: { items: string[]; gaps: string[] }): string {
  let out = '';
  for (let i = 0; i < s.items.length; i++) out += (s.gaps[i] ?? '') + s.items[i];
  return out + (s.gaps[s.items.length] ?? '');
}

/**
 * 把第 from 块挪到「结果里的第 to 个位置」。to 允许越界，夹紧即可；
 * gaps 一动不动，所以全章空行形状与换行风格都不会被这次挪动影响。
 */
export function moveBlock(s: SceneSplit, from: number, to: number): SceneSplit {
  const n = s.items.length;
  if (from < 0 || from >= n) return s;
  const items = s.items.slice();
  const [b] = items.splice(from, 1);
  const at = Math.max(0, Math.min(to > from ? to - 1 : to, items.length));
  items.splice(at, 0, b);
  return { ...s, items };
}

/** 相邻两块换位置（卡片上的 ↑↓：不依赖指针，键盘与冒烟测试都走这条） */
export function swapBlocks(s: SceneSplit, a: number, b: number): SceneSplit {
  if (b < 0 || b >= s.items.length) return s;
  const items = s.items.slice();
  const t = items[a];
  items[a] = items[b];
  items[b] = t;
  return { ...s, items };
}

/**
 * 摘走第 at 块（整块搬去别处）。它两侧各有一条空隙，只留一条：
 * 摘的是中间块就留前面那条（分隔形状照旧），摘的是最后一块就留结尾那条——
 * 否则「搬走末尾一块」会在章末留下两行空行，EOF 越长越肥。
 */
export function dropBlock(s: SceneSplit, at: number): SceneSplit {
  if (at < 0 || at >= s.items.length) return s;
  const items = s.items.slice();
  items.splice(at, 1);
  const gaps = s.gaps.slice();
  gaps.splice(at === s.items.length - 1 ? at : at + 1, 1);
  return { ...s, items, gaps };
}

/**
 * 往另一篇正文末尾接一块：两块之间要有一个空行，
 * 结尾已经空过行就不重复补，换行风格跟目标那篇走。
 */
export function appendBlock(text: string, block: string): string {
  const t = String(text ?? '');
  if (!t.trim()) return block;
  const trimmed = t.replace(/[ \t\r\n]+$/, '');
  const tail = t.slice(trimmed.length);
  const brk = tail.includes('\r\n') || trimmed.includes('\r\n') ? '\r\n' : '\n';
  const breaks = (tail.match(/\n/g) ?? []).length;
  return trimmed + tail + brk.repeat(Math.max(0, 2 - breaks)) + block;
}

/**
 * 从一篇正文里取回指定块（appendBlock 的反向，用来「退回」跨章搬运）。
 * 只按整块精确匹配、从后往前找——搬过去时是一字不动追加的，找不到就是不该动，
 * 宁可原样返回也不拿子串去猜：正文里引用过同一句话很常见。
 */
export function removeBlockFrom(text: string, block: string): string {
  const s = splitScenes(text);
  for (let i = s.items.length - 1; i >= 0; i--) {
    if (s.items[i] === block) return joinScenes(dropBlock(s, i));
  }
  return text;
}

/** 卡片标题：块内第一行去 markdown 记号后的前 40 字 */
export function blockExcerpt(item: string, cap = 40): string {
  const line = String(item ?? '').split('\n').find((l) => !blank(l)) ?? '';
  const clean = line.replace(/^\s*(#{1,6}\s*|>\s*|[-*+]\s+|\d+\.\s+)/, '').trim();
  return clean.length > cap ? clean.slice(0, cap) + '…' : clean;
}

/**
 * Esc 在场景板只认一种情况：拖动进行中 = 「这次拖动反悔」，收回压暗与落点线、数据不动。
 * 没在拖的 Esc 与场景板无关，透传给全局的「收工」语义（收抽屉/收浮层/退专注）——不吞事件。
 */
export function escCancelsDrag(key: string | undefined, dragging: boolean): boolean {
  return dragging && key === 'Escape';
}
