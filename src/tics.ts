// 口头禅雷达：找出作者自己意识不到的高频重复片段（2–4 字组合 + 拉丁词）。
// 纯本地、不改稿——只报频次与首处位置，改与不改始终是作者的事。
// 与「AI 味自检」的分工：那边是固定套路词表，这边是你自己笔下长出来的词。
//
// 判重用「极大性」：一个片段若每次出现都能向左/右扩展成同样高频的更长串
// （比如「试试」永远长成「试试看」），它自己就不上榜，只报最长的那个。
// 相比计数扣减法，这个判法不怕片段互相重叠。

export interface TicInput {
  id: string;
  title: string;
  content: string;
}

export interface TicHit {
  /** 重复片段（2–4 字组合，或一个拉丁词） */
  text: string;
  /** 全书出现次数 */
  count: number;
  /** 每千字次数（不同篇幅之间可比） */
  per1k: number;
  /** 首次出现的位置（章内偏移，供跳转） */
  at: number;
  chapterId: string;
  title: string;
}

// 全部由这些虚字组成的片段不算口头禅——「的了」「是和」这类组合纯属噪声。
// 只挡「全虚字」，「的时候」这类含实字的真口头禅照常上榜。
const STOP_CHARS = new Set('的了是在有和就不人都一也到说要他她它这那个上着呢吧啊吗么呀哦嘛之乎其把被从会对给让向跟同如比或与及但'.split(''));

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
const LATIN_RE = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;

export interface TicOptions {
  /** 上榜门槛（全书出现次数）；缺省按篇幅自适应：max(3, 总字数/8000) */
  minCount?: number;
  /** 最多返回几条 */
  top?: number;
}

interface Acc {
  count: number;
  at: number;
  chapterId: string;
  title: string;
  /** 首次出现时的前/后一个中文字符（'' 表示边界或标点，无法再扩展） */
  firstPrev: string;
  firstNext: string;
  /** 后续出现的前/后字符是否与首次不同——一旦变过，这个方向就是「极大」的 */
  prevVaries: boolean;
  nextVaries: boolean;
}

/** 数出全部候选片段，按极大性过滤后返回按次数排序的高频片段 */
export function findTics(inputs: TicInput[], opts?: TicOptions): TicHit[] {
  const total = inputs.reduce((a, c) => a + (c.content?.length ?? 0), 0);
  const minCount = Math.max(1, opts?.minCount ?? Math.max(3, Math.round(total / 8000)));
  const top = opts?.top ?? 30;
  const acc = new Map<string, Acc>();
  const bump = (g: string, at: number, input: TicInput, prev: string, next: string) => {
    const rec = acc.get(g);
    if (rec) {
      rec.count += 1;
      if (prev !== rec.firstPrev) rec.prevVaries = true;
      if (next !== rec.firstNext) rec.nextVaries = true;
    } else {
      acc.set(g, { count: 1, at, chapterId: input.id, title: input.title, firstPrev: prev, firstNext: next, prevVaries: false, nextVaries: false });
    }
  };

  for (const input of inputs) {
    const text = input.content ?? '';
    if (!text) continue;
    // 拉丁词按整词计数（缩回小写，「OK」和「ok」是同一个词）；词边界就是极大性
    for (const m of text.matchAll(LATIN_RE)) {
      const w = m[0].toLowerCase();
      if (w.length >= 2) bump(w, m.index ?? 0, input, '', '');
    }
    // 中文按 2–4 字组合滑窗计数；先用标志数组把非中文字符排除，免得三种长度各判一遍
    const n = text.length;
    const cjk = new Array<boolean>(n);
    for (let i = 0; i < n; i++) cjk[i] = CJK_RE.test(text[i]);
    for (let L = 2; L <= 4; L++) {
      for (let i = 0; i + L <= n; i++) {
        if (!cjk[i] || !cjk[i + L - 1]) continue;
        let ok = true;
        for (let k = 1; k < L - 1; k++) {
          if (!cjk[i + k]) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        // 前/后紧邻字符只有是中文才可能扩展出更长串；边界与标点都按「可极大」处理
        const prev = i > 0 && cjk[i - 1] ? text[i - 1] : '';
        const next = i + L < n && cjk[i + L] ? text[i + L] : '';
        bump(text.slice(i, i + L), i, input, prev, next);
      }
    }
  }

  const hits: TicHit[] = [];
  for (const [text, rec] of acc) {
    if (rec.count < minCount) continue;
    // 极大性：左/右只要有一次「不是同一个中文字符」就说明存在独立出现，可以上榜
    const maximal = (rec.prevVaries || !rec.firstPrev) && (rec.nextVaries || !rec.firstNext);
    if (!maximal) continue;
    let allStop = true;
    for (const ch of text) {
      if (!STOP_CHARS.has(ch)) {
        allStop = false;
        break;
      }
    }
    if (allStop) continue;
    hits.push({
      text,
      count: rec.count,
      per1k: Math.round((rec.count / Math.max(1, total)) * 10000) / 10,
      at: rec.at,
      chapterId: rec.chapterId,
      title: rec.title,
    });
  }
  hits.sort((a, b) => b.count - a.count || (a.text < b.text ? -1 : 1));
  return hits.slice(0, top);
}
