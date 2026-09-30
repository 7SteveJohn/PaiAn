// 旧章回响：用 BM25（CJK 相邻二字组 + 拉丁词）在旧章里检索与当前章最相关的片段，
// 以「仅参考、禁止复述」的片段注入续写提示。纯函数零依赖；量级按 120 章 × 2KB 设计，
// 每次调用重建索引即可，不做缓存也不进 worker。

export interface EchoDoc {
  id: string;
  title: string;
  text: string;
}

export interface EchoHit {
  id: string;
  title: string;
  score: number;
  snippet: string;
}

export interface EchoIndex {
  N: number; // 参与检索的文档数（空文本已剔除）
  avgLen: number; // 文档平均 token 长度
  tf: Map<string, Map<string, number>>; // docId -> token -> 词频
  df: Map<string, number>; // token -> 含该词的文档数
  len: Map<string, number>; // docId -> token 总数
  docs: EchoDoc[];
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const LATIN = /[a-z0-9]/;

/** CJK 相邻二字组 + 连续 latin/digit 词（小写） */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const chars = Array.from(text.toLowerCase());
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (CJK.test(ch)) {
      const next = chars[i + 1] ?? '';
      if (CJK.test(next)) tokens.push(ch + next);
    } else if (LATIN.test(ch)) {
      let word = '';
      while (i < chars.length && LATIN.test(chars[i])) {
        word += chars[i];
        i++;
      }
      i--;
      tokens.push(word);
    }
  }
  return tokens;
}

/** 建索引：空文本（trim 后为空）的文档直接跳过 */
export function buildEcho(docs: EchoDoc[]): EchoIndex {
  const tf = new Map<string, Map<string, number>>();
  const df = new Map<string, number>();
  const len = new Map<string, number>();
  const kept: EchoDoc[] = [];
  let total = 0;
  for (const d of docs) {
    if (!d.text || !d.text.trim()) continue;
    kept.push(d);
    const counts = new Map<string, number>();
    for (const t of tokenize(d.text)) counts.set(t, (counts.get(t) ?? 0) + 1);
    let n = 0;
    for (const c of counts.values()) n += c;
    tf.set(d.id, counts);
    len.set(d.id, n);
    total += n;
    for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return { N: kept.length, avgLen: kept.length ? total / kept.length : 0, tf, df, len, docs: kept };
}

/** 片段：命中位置附近取 ≤140 字符，前后各扩到换行/句末边界 */
function makeSnippet(text: string, hit: number): string {
  const MAX = 140;
  // 起点向前收束到行首/句首（命中前最多回看 70 字），尽量不切在半句上
  let start = Math.max(0, hit - 70);
  const before = text.slice(start, hit);
  const bs = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('。'), before.lastIndexOf('！'), before.lastIndexOf('？'), before.lastIndexOf('…'));
  if (bs >= 0) start += bs + 1;
  let end = Math.min(text.length, start + MAX);
  // 末边停在命中之后最后一个句末/换行边界（窗口内找不到就硬切 140）
  const window = text.slice(hit, end);
  let be = -1;
  for (let i = 0; i < window.length; i++) {
    if (window[i] === '\n' || '。！？…'.includes(window[i])) be = i;
  }
  if (be >= 0) end = hit + be + 1;
  return text.slice(start, Math.min(end, start + MAX));
}

/** BM25（k1=1.2, b=0.75）取前 k 条；score>0 才收；excludeId 用来排除当前章自己 */
export function echoTop(index: EchoIndex, query: string, k: number, excludeId?: string): EchoHit[] {
  if (k <= 0 || index.N === 0) return [];
  const qTokens = [...new Set(tokenize(query))];
  if (!qTokens.length) return [];
  const k1 = 1.2;
  const b = 0.75;
  const hits: EchoHit[] = [];
  for (const d of index.docs) {
    if (excludeId && d.id === excludeId) continue;
    const counts = index.tf.get(d.id)!;
    const dl = index.len.get(d.id) || 1;
    let score = 0;
    for (const qt of qTokens) {
      const f = counts.get(qt);
      if (!f) continue;
      const df = index.df.get(qt) ?? 0;
      const idf = Math.log(1 + (index.N - df + 0.5) / (df + 0.5));
      score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * dl) / (index.avgLen || 1)));
    }
    if (score <= 0) continue;
    // 片段锚点：第一次命中任一查询词的位置（latin 词 tokenize 时小写过，原文里按不区分大小写找）
    let hit = -1;
    const low = d.text.toLowerCase();
    for (const qt of qTokens) {
      if (!counts.has(qt)) continue;
      const i = low.indexOf(qt);
      if (i >= 0 && (hit < 0 || i < hit)) hit = i;
    }
    hits.push({ id: d.id, title: d.title, score, snippet: hit >= 0 ? makeSnippet(d.text, hit) : d.text.slice(0, 140) });
  }
  hits.sort((a, b2) => b2.score - a.score);
  return hits.slice(0, k);
}

/** 拼成注入文本；总长硬上限 700 字符，超了从后往前丢 */
export function renderEcho(hits: EchoHit[]): string {
  if (!hits.length) return '';
  const head = '\n\n【回响·旧章片段（仅参考，禁止复述原文）】';
  const lines = hits.map((h) => `- 《${h.title}》${h.snippet}…`);
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const candidate = head + '\n' + lines.slice(0, i + 1).join('\n');
    if (candidate.length > 700) break;
    out = candidate;
  }
  return out;
}
