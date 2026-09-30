// 牵线工作流的纯逻辑层：图规整、一键牵线、布局、沿链取用与「跑一遍」的上下文拼装。
// 全确定性、不联网、不调模型——画布只是把这些函数结果显示出来，所以单测能钉死行为。
import type { GLink, GLinkKind, GNode, GNodeKind, Project, StoryGraph } from './types';
import { uid } from './util';

export const GRAPH_NODE_CAP = 600;
export const GRAPH_LINK_CAP = 2000;
export const NODE_KINDS: GNodeKind[] = ['chapter', 'char', 'world', 'hook', 'note'];
export const LINK_KINDS: GLinkKind[] = ['next', 'cast', 'kin', 'hook', 'free'];

export const NODE_LABEL: Record<GNodeKind, string> = { chapter: '章', char: '人物', world: '设定', hook: '伏笔', note: '便签' };
export const LINK_LABEL: Record<GLinkKind, string> = { next: '推动', cast: '出场', kin: '关系', hook: '伏笔', free: '手牵' };

/** 引用型节点的 id 由「类别 + 实体 id」决定：同一实体永远只有一个影子，重复牵线不会堆节点 */
export const refNodeId = (kind: GNodeKind, ref: string) => `${kind}:${ref}`;

export function emptyGraph(): StoryGraph {
  return { version: 1, nodes: [], links: [] };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** 读盘/读进来的图先规整一遍：去重、截断、指向不存在实体的节点与断头线一律清掉 */
export function normalizeGraph(project: Project, raw: unknown): StoryGraph {
  const o = raw && typeof raw === 'object' ? (raw as Partial<StoryGraph>) : {};
  const kinds = new Set<string>(NODE_KINDS);
  const linkKinds = new Set<string>(LINK_KINDS);
  const alive = new Set<string>();
  for (const c of project.chapters ?? []) alive.add(refNodeId('chapter', c.id));
  for (const c of project.characters ?? []) alive.add(refNodeId('char', c.id));
  for (const w of project.worldItems ?? []) alive.add(refNodeId('world', w.id));
  for (const m of project.marks ?? []) if (m.type === '伏笔') alive.add(refNodeId('hook', m.id));

  const nodes: GNode[] = [];
  const seen = new Set<string>();
  for (const n of Array.isArray(o.nodes) ? o.nodes : []) {
    if (!n || typeof n !== 'object') continue;
    const id = String(n.id ?? '');
    const kind = String(n.kind ?? '');
    if (!id || seen.has(id) || !kinds.has(kind) || nodes.length >= GRAPH_NODE_CAP) continue;
    if (kind !== 'note' && !alive.has(id)) continue; // 实体已删，影子不留
    const node: GNode = { id, kind: kind as GNodeKind };
    if (kind === 'note' && typeof n.note === 'string') node.note = n.note.slice(0, 300);
    if (Number.isFinite(n.x) && Number.isFinite(n.y)) {
      node.x = Math.round(Math.min(20000, Math.max(-20000, n.x as number)));
      node.y = Math.round(Math.min(20000, Math.max(-20000, n.y as number)));
    }
    if (typeof n.ref === 'string') node.ref = n.ref;
    nodes.push(node);
    seen.add(id);
  }
  const links: GLink[] = [];
  const seenLink = new Set<string>();
  for (const l of Array.isArray(o.links) ? o.links : []) {
    if (!l || typeof l !== 'object') continue;
    const from = String(l.from ?? '');
    const to = String(l.to ?? '');
    const kind = String(l.kind ?? 'free');
    if (!from || !to || from === to || !seen.has(from) || !seen.has(to)) continue;
    if (!linkKinds.has(kind)) continue;
    const id = String(l.id || `${kind}|${from}->${to}`);
    if (seenLink.has(id) || links.length >= GRAPH_LINK_CAP) continue;
    seenLink.add(id);
    links.push({ id, from, to, kind: kind as GLinkKind, ...(typeof l.label === 'string' && l.label ? { label: l.label.slice(0, 40) } : {}) });
  }
  return { version: 1, nodes, links };
}

export function graphOf(project: Project): StoryGraph {
  return project.graph?.nodes?.length || project.graph?.links?.length ? normalizeGraph(project, project.graph) : emptyGraph();
}

/** 把所有实体补成节点（不动已有坐标与便签）。第一次进画布、或新写了章之后都靠它。 */
export function ensureEntityNodes(project: Project, g: StoryGraph): StoryGraph {
  const have = new Set(g.nodes.map((n) => n.id));
  const add = (id: string, kind: GNodeKind) => {
    if (have.has(id) || g.nodes.length + 1 > GRAPH_NODE_CAP) return;
    have.add(id);
    g.nodes.push({ id, kind, ref: id.split(':')[1] });
  };
  for (const c of project.chapters ?? []) add(refNodeId('chapter', c.id), 'chapter');
  for (const c of project.characters ?? []) add(refNodeId('char', c.id), 'char');
  for (const w of project.worldItems ?? []) add(refNodeId('world', w.id), 'world');
  for (const m of project.marks ?? []) if (m.type === '伏笔') add(refNodeId('hook', m.id), 'hook');
  return g;
}

const nameIndex = (project: Project) => {
  const byName = new Map<string, string>();
  for (const c of project.characters ?? []) byName.set(c.name.trim(), refNodeId('char', c.id));
  for (const w of project.worldItems ?? []) if (!byName.has(w.name.trim())) byName.set(w.name.trim(), refNodeId('world', w.id));
  return byName;
};

const castNames = (cast?: string) =>
  (cast ?? '')
    .split(/[、,，;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

const push = (links: GLink[], have: Set<string>, from: string, to: string, kind: GLinkKind) => {
  const id = `${kind}|${from}->${to}`;
  if (have.has(id)) return;
  have.add(id);
  links.push({ id, from, to, kind });
};

/**
 * 一键牵线：从已有数据里长出能确定的那几条。
 * 章→章按顺序、章→人物按出场名单、人物→人物按关系卡、伏笔按埋点章。幂等：重复点不堆重复线。
 */
export function autoWire(project: Project, g: StoryGraph): StoryGraph {
  const next = ensureEntityNodes(project, structuredClone(g));
  const ids = new Set(next.nodes.map((n) => n.id));
  const byName = nameIndex(project);
  const links = [...next.links];
  const have = new Set(links.map((l) => l.id));
  const chapters = project.chapters ?? [];
  for (let i = 0; i < chapters.length; i++) {
    const a = refNodeId('chapter', chapters[i].id);
    if (i + 1 < chapters.length) push(links, have, a, refNodeId('chapter', chapters[i + 1].id), 'next');
    for (const name of castNames(chapters[i].cast)) {
      const t = byName.get(name);
      if (t && ids.has(t)) push(links, have, a, t, 'cast');
    }
  }
  for (const c of project.characters ?? []) {
    const from = refNodeId('char', c.id);
    for (const rel of c.relations ?? []) {
      const t = byName.get(rel.with.trim());
      if (t && t !== from && ids.has(t)) push(links, have, from, t, 'kin');
    }
  }
  for (const m of project.marks ?? []) {
    if (m.type !== '伏笔') continue;
    const hook = refNodeId('hook', m.id);
    if (m.chapterId && ids.has(refNodeId('chapter', m.chapterId))) push(links, have, refNodeId('chapter', m.chapterId), hook, 'hook');
  }
  return { version: 1, nodes: next.nodes.slice(0, GRAPH_NODE_CAP), links: links.slice(0, GRAPH_LINK_CAP) };
}

const GAP_X = 208;
const GAP_Y = 118;
const PER_ROW = 6;

/** 只给「还没坐标」的节点补位置（一键牵线用它：手动摆过的不该被挪走） */
export function placeNew(project: Project, g: StoryGraph): StoryGraph {
  const laid = layout(project, g);
  return { ...g, nodes: g.nodes.map((n, i) => (Number.isFinite(n.x) && Number.isFinite(n.y) ? n : laid.nodes[i])) };
}

/** 确定性布局：章按阅读顺序铺网格，其余实体排在下面一条带里，一次摆齐 */
export function layout(project: Project, g: StoryGraph): StoryGraph {
  const order = new Map((project.chapters ?? []).map((c, i) => [refNodeId('chapter', c.id), i]));
  const rows = Math.max(1, Math.ceil((order.size || 1) / PER_ROW));
  let j = 0;
  return {
    version: 1,
    nodes: g.nodes.map((n) => {
      const k = order.get(n.id);
      if (k !== undefined) return { ...n, x: 40 + (k % PER_ROW) * GAP_X, y: 40 + Math.floor(k / PER_ROW) * GAP_Y };
      const pos = { ...n, x: 40 + (j % PER_ROW) * GAP_X, y: 60 + (rows + 1) * GAP_Y + Math.floor(j / PER_ROW) * GAP_Y };
      j++;
      return pos;
    }),
    links: g.links,
  };
}

export function nodeLabel(project: Project, n: GNode): string {
  const [kind, ref] = [n.kind, n.ref ?? n.id.split(':')[1] ?? ''];
  if (kind === 'chapter') return (project.chapters ?? []).find((c) => c.id === ref)?.title || '（章已删）';
  if (kind === 'char') return (project.characters ?? []).find((c) => c.id === ref)?.name || '（人物已删）';
  if (kind === 'world') return (project.worldItems ?? []).find((w) => w.id === ref)?.name || '（设定已删）';
  if (kind === 'hook') {
    const m = (project.marks ?? []).find((x) => x.id === ref);
    return m ? m.text.slice(0, 24) || '伏笔' : '（伏笔已删）';
  }
  return n.note?.split('\n')[0].slice(0, 24) || '便签';
}

/** 画布上的状态：这一类节点该不该亮「未回收」的小标 */
export function nodeFlag(project: Project, n: GNode): string {
  if (n.kind === 'chapter') {
    const c = (project.chapters ?? []).find((x) => x.id === (n.ref ?? ''));
    if (!c) return '';
    return (c.content ?? '').trim() ? `${(c.content ?? '').length} 字` : '待写';
  }
  if (n.kind === 'hook') {
    const m = (project.marks ?? []).find((x) => x.id === (n.ref ?? ''));
    return m ? (m.status === '回收' ? '已收' : '未收') : '';
  }
  if (n.kind === 'char') return (project.characters ?? []).find((x) => x.id === (n.ref ?? ''))?.state?.slice(0, 12) || '';
  return '';
}

export interface GraphStats {
  nodes: number;
  links: number;
  byKind: Record<GNodeKind, number>;
  byLink: Record<GLinkKind, number>;
}

export function graphStats(g: StoryGraph): GraphStats {
  const byKind = { chapter: 0, char: 0, world: 0, hook: 0, note: 0 };
  const byLink = { next: 0, cast: 0, kin: 0, hook: 0, free: 0 };
  for (const n of g.nodes) byKind[n.kind]++;
  for (const l of g.links) byLink[l.kind]++;
  return { nodes: g.nodes.length, links: g.links.length, byKind, byLink };
}

/** 断线诊断：作者真正会忘的是「埋了没收」和「谁都没连上」 */
export function problems(project: Project, g: StoryGraph): { kind: '未收伏笔' | '孤立节点' | '断头章'; label: string; nodeId: string }[] {
  const out: { kind: '未收伏笔' | '孤立节点' | '断头章'; label: string; nodeId: string }[] = [];
  const touched = new Set<string>();
  for (const l of g.links) {
    touched.add(l.from);
    touched.add(l.to);
  }
  for (const n of g.nodes) {
    if (n.kind === 'hook') {
      const m = (project.marks ?? []).find((x) => x.id === (n.ref ?? ''));
      if (m && m.status !== '回收') out.push({ kind: '未收伏笔', label: nodeLabel(project, n), nodeId: n.id });
    }
  }
  for (const n of g.nodes) {
    if (n.kind === 'note') continue; // 便签本来就常常单着
    if (!touched.has(n.id)) out.push({ kind: '孤立节点', label: `${NODE_LABEL[n.kind]}·${nodeLabel(project, n)}`, nodeId: n.id });
  }
  const hasOut = new Set(g.links.filter((l) => l.kind === 'next').map((l) => l.from));
  const chapters = project.chapters ?? [];
  chapters.forEach((c, i) => {
    if (i < chapters.length - 1 && !hasOut.has(refNodeId('chapter', c.id))) out.push({ kind: '断头章', label: c.title || `第${i + 1}章`, nodeId: refNodeId('chapter', c.id) });
  });
  return out.slice(0, 60);
}

const incoming = (g: StoryGraph, id: string, kind?: GLinkKind) => g.links.filter((l) => l.to === id && (!kind || l.kind === kind));
const outgoing = (g: StoryGraph, id: string, kind?: GLinkKind) => g.links.filter((l) => l.from === id && (!kind || l.kind === kind));

export interface PlayBeat {
  nodeId: string;
  chapterId: string;
  no: number; // 目录里的第几章（1 起）
  title: string;
  gist: string; // 讲什么：梗概 → 要点 → 正文开头，谁先用谁
  cast: string[]; // 在场人物：牵的线与章字段取并集
  hooks: string[]; // 本章挂着的伏笔
  notes: string[]; // 牵到这一章的便签
  written: boolean;
  via: 'first' | 'link' | 'order'; // 这一拍是开头、沿线接上、还是断链后按目录补
}

/**
 * 「演一遍」的剧本：沿「推动」线把章一拍拍走下去。
 * 起点是没有入线的那一章（读者从哪儿开始就从哪儿播）；线断了不猜，
 * 按目录顺序把没走到的章补在后面并标成 order；有环靠 visited 集合挡住。
 */
export function playScript(project: Project, g: StoryGraph): PlayBeat[] {
  const order = new Map((project.chapters ?? []).map((c, i) => [c.id, i]));
  const noOf = (id: string) => (order.has(id) ? (order.get(id) as number) + 1 : 0);
  const chapters = g.nodes.filter((n) => n.kind === 'chapter' && n.ref);
  if (!chapters.length) return [];
  const ids = new Set(chapters.map((n) => n.id));

  const head =
    chapters
      .filter((n) => !incoming(g, n.id, 'next').some((l) => ids.has(l.from)))
      .sort((a, b) => noOf(a.ref as string) - noOf(b.ref as string))[0] ?? chapters[0];

  const walked: { node: GNode; via: PlayBeat['via'] }[] = [];
  const seen = new Set<string>();
  const walkFrom = (start: GNode, headVia: PlayBeat['via']) => {
    let cur: GNode | undefined = start;
    let via = headVia;
    // 有环靠 seen 挡住：手滑把线牵回去，不能把播放挂死
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      walked.push({ node: cur, via });
      const onward = outgoing(g, cur.id, 'next')
        .filter((l) => ids.has(l.to) && !seen.has(l.to))
        .map((l) => chapters.find((nn) => nn.id === l.to))
        .filter((nn): nn is GNode => !!nn)
        .sort((a, b) => noOf(a.ref as string) - noOf(b.ref as string));
      cur = onward[0];
      via = 'link';
    }
  };
  walkFrom(head, 'first');
  // 没牵进链的章不丢：按目录补在末尾，段首标 order（播放时会明说这一段没线接过来），段内照线走
  for (const n of chapters.filter((x) => !seen.has(x.id)).sort((a, b) => noOf(a.ref as string) - noOf(b.ref as string))) walkFrom(n, 'order');

  return walked.map(({ node, via: how }) => {
    const cid = node.ref as string;
    const c = (project.chapters ?? []).find((x) => x.id === cid);
    const body = (c?.content ?? '').replace(/\s+/g, ' ').trim();
    const cast = new Set((c?.cast ?? '').split(/[、，,；;\n]+/).map((s) => s.replace(/[（(][^）)]*[）)]?/g, '').trim()).filter(Boolean));
    for (const l of g.links) {
      if (l.from !== node.id || (l.kind !== 'cast' && l.kind !== 'free')) continue;
      const target = g.nodes.find((n) => n.id === l.to);
      if (target?.kind === 'char') cast.add(nodeLabel(project, target));
    }
    const notes: string[] = [];
    for (const l of g.links) {
      if (l.from !== node.id && l.to !== node.id) continue;
      const other = g.nodes.find((n) => n.id === (l.from === node.id ? l.to : l.from));
      if (other?.kind === 'note' && (other.note ?? '').trim()) notes.push(other.note!.trim());
    }
    return {
      nodeId: node.id,
      chapterId: cid,
      no: noOf(cid),
      title: c?.title ?? nodeLabel(project, node),
      gist: (c?.summary ?? '').trim() || (c?.beats ?? '').trim() || body.slice(0, 90),
      cast: [...cast],
      hooks: (project.marks ?? [])
        .filter((m) => m.type === '伏笔' && m.chapterId === cid && m.status !== '回收' && m.text.trim())
        .slice(0, 3)
        .map((m) => m.text.trim().slice(0, 40)),
      notes: [...new Set(notes)].slice(0, 3),
      written: !!body,
      via: how,
    };
});
}

/** 沿链往前追几章：next 反向走，别处手牵进来的章也算前章；结果按全书顺序排 */
export function upstreamChapters(project: Project, g: StoryGraph, chapterId: string, depth = 3): string[] {
  const start = refNodeId('chapter', chapterId);
  const seen = new Set<string>([start]);
  const got: string[] = [];
  let frontier = [start];
  for (let d = 0; d < Math.max(1, depth) && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      const back = [...incoming(g, id, 'next'), ...incoming(g, id, 'free').filter((l) => l.from.startsWith('chapter:'))];
      for (const l of back) {
        if (!l.from.startsWith('chapter:') || seen.has(l.from)) continue;
        seen.add(l.from);
        got.push(l.from.split(':')[1]);
        next.push(l.from);
      }
    }
    frontier = next;
  }
  const order = new Map((project.chapters ?? []).map((c, i) => [c.id, i]));
  return got.sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
}

/**
 * 「跑一遍」：把牵好的线读成一份可贴给 AI（或自己看）的上下文。
 * 章沿链往前追，出场人物带当前状态，挂着的伏笔按埋点/回收分列。
 */
export function contextFor(project: Project, g: StoryGraph, chapterId: string, opts: { depth?: number; withNotes?: boolean } = {}): string {
  const chapter = (project.chapters ?? []).find((c) => c.id === chapterId);
  if (!chapter) return '';
  const lines: string[] = [];
  const up = upstreamChapters(project, g, chapterId, Math.max(1, Math.min(8, opts.depth ?? 3)));
  if (up.length) {
    lines.push('【牵线上的前章】');
    for (const id of up) {
      const c = (project.chapters ?? []).find((x) => x.id === id);
      if (!c) continue;
      const brief = (c.beats || c.summary || '').trim().split('\n')[0] || (c.content || '').slice(0, 60);
      lines.push(`· ${c.title}：${brief || '（空）'}`);
    }
  }
  const self = refNodeId('chapter', chapterId);
  // 人物不只看本章的出场名单：链上前几章牵着的人也要在场上，否则续写时会「失忆」
  const onChain = new Set([self, ...up.map((id) => refNodeId('chapter', id))]);
  type Char = NonNullable<Project['characters']>[number];
  const byId = new Map<string, Char>((project.characters ?? []).map((c) => [refNodeId('char', c.id), c]));
  const cast: Char[] = [];
  for (const l of g.links) {
    if (!onChain.has(l.from) || (l.kind !== 'cast' && l.kind !== 'free')) continue;
    const c = byId.get(l.to);
    if (c && !cast.includes(c)) cast.push(c);
  }
  if (cast.length) {
    lines.push('【链上人物】');
    for (const c of cast) lines.push(`· ${c.name}${c.state ? '：' + c.state : ''}`);
  }
  const byMark = new Map((project.marks ?? []).map((m) => [refNodeId('hook', m.id), m]));
  const marked: ReturnType<typeof byMark.get>[] = [];
  for (const l of g.links) {
    if (l.kind !== 'hook' || !onChain.has(l.from)) continue;
    const m = byMark.get(l.to);
    if (m && !marked.includes(m)) marked.push(m);
  }
  if (marked.length) {
    lines.push('【链上伏笔】');
    for (const m of marked) lines.push(`· ${m!.text.slice(0, 40)}（${m!.status === '回收' ? '已收' : '未收'}${m!.expected ? ' · 期望' + m!.expected : ''}）`);
  }
  if (opts.withNotes) {
    const notes = g.nodes.filter((n) => n.kind === 'note' && n.note && [...incoming(g, n.id), ...outgoing(g, n.id)].some((l) => l.from === self || l.to === self));
    if (notes.length) {
      lines.push('【便签】');
      for (const n of notes) lines.push(`· ${n.note}`);
    }
  }
  lines.push(`【落点】现在要写：${chapter.title || '本章'}${chapter.beats ? ' —— 要点：' + chapter.beats.trim().split('\n')[0] : ''}`);
  return lines.join('\n');
}

// ---------- 画布上的增删 ----------
export function addNote(g: StoryGraph, text: string, at?: { x: number; y: number }): StoryGraph {
  if (g.nodes.length >= GRAPH_NODE_CAP) return g;
  const node: GNode = { id: `note:${uid()}`, kind: 'note', note: text.slice(0, 300), ...(at ? { x: Math.round(at.x), y: Math.round(at.y) } : {}) };
  return { ...g, nodes: [...g.nodes, node] };
}

export function moveNode(g: StoryGraph, id: string, x: number, y: number): StoryGraph {
  return { ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, x: Math.round(x), y: Math.round(y) } : n)) };
}

export function dropNode(g: StoryGraph, id: string): StoryGraph {
  return { ...g, nodes: g.nodes.filter((n) => n.id !== id), links: g.links.filter((l) => l.from !== id && l.to !== id) };
}

/** 手牵一条线：同一对节点换类别也算新线，但同类别重复牵会被忽略 */
export function addLink(g: StoryGraph, from: string, to: string, kind: GLinkKind = 'free'): StoryGraph {
  if (!from || !to || from === to) return g;
  if (!g.nodes.some((n) => n.id === from) || !g.nodes.some((n) => n.id === to)) return g;
  if (g.links.length >= GRAPH_LINK_CAP) return g;
  const id = `${kind}|${from}->${to}`;
  if (g.links.some((l) => l.id === id)) return g;
  return { ...g, links: [...g.links, { id, from, to, kind }] };
}

export function dropLink(g: StoryGraph, id: string): StoryGraph {
  return { ...g, links: g.links.filter((l) => l.id !== id) };
}

export function relinkAs(g: StoryGraph, id: string, kind: GLinkKind): StoryGraph {
  const l = g.links.find((x) => x.id === id);
  if (!l || l.kind === kind) return g;
  const nextId = `${kind}|${l.from}->${l.to}`;
  if (g.links.some((x) => x.id === nextId)) return dropLink(g, id);
  return { ...g, links: g.links.map((x) => (x.id === id ? { ...x, kind, id: nextId } : x)) };
}

/** 出场名单的反向写回：图上牵了「这章有这人」，就别让章的 cast 字段空着 */
export function syncCast(project: Project, g: StoryGraph): { project: Project; changed: number } {
  const byName = new Map((project.characters ?? []).map((c) => [refNodeId('char', c.id), c.name]));
  let changed = 0;
  const chapters = (project.chapters ?? []).map((c) => {
    const self = refNodeId('chapter', c.id);
    const adds = [...new Set(g.links.filter((l) => l.from === self && l.kind === 'cast').map((l) => byName.get(l.to)).filter(Boolean))] as string[];
    if (!adds.length) return c;
    const cur = castNames(c.cast);
    const missing = adds.filter((n) => !cur.includes(n));
    if (!missing.length) return c;
    changed++;
    return { ...c, cast: [...cur, ...missing].join('、') };
  });
  return { project: changed ? { ...project, chapters } : project, changed };
}

export function isSameGraph(a: StoryGraph, b: StoryGraph): boolean {
  if (a.nodes.length !== b.nodes.length || a.links.length !== b.links.length) return false;
  const key = (n: GNode) => `${n.id}@${n.x ?? ''},${n.y ?? ''}`;
  if (!sameSet(a.nodes.map(key), b.nodes.map(key))) return false;
  return sameSet(a.links.map((l) => l.id), b.links.map((l) => l.id));
}
