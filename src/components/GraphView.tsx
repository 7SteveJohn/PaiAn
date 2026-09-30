// 牵线画布：把章、人物、设定、伏笔摆成节点，用线把因果牵出来，再沿线「跑一遍」取用上下文。
// 手搓 SVG 而不引图形库：这里的节点量级最多几百，而手感要贴合写作（双击跳章、拖完即存），
// 通用 DAG 编辑器反而把这些做成二开。所有图逻辑都在 src/graph.ts 的纯函数里，可单测。
import { useEffect, useMemo, useRef, useState } from 'react';
import { GitBranchPlus, Wand2, LayoutGrid, StickyNote, ZoomIn, ZoomOut, Crosshair, ArrowRight, Copy, Check, Trash2, RefreshCw, Play, Pause, Square } from 'lucide-react';
import type { GLinkKind, GNode, Project, StoryGraph } from '../types';
import {
  LINK_KINDS,
  LINK_LABEL,
  addLink,
  addNote,
  autoWire,
  contextFor,
  dropLink,
  dropNode,
  graphOf,
  graphStats,
  layout,
  moveNode,
  nodeFlag,
  nodeLabel,
  placeNew,
  playScript,
  problems,
  relinkAs,
  syncCast,
  upstreamChapters,
} from '../graph';

interface Props {
  project: Project;
  onUpdate: (id: string, patch: Partial<Project>) => void;
  onOpenChapter?: (chapterId: string) => void;
}

const W = { chapter: 176, char: 128, world: 128, hook: 150, note: 168 } as const;
const H = { chapter: 50, char: 34, world: 34, hook: 40, note: 44 } as const;

const anchor = (n: GNode, side: 'in' | 'out') => {
  const w = W[n.kind] ?? 140;
  return { x: (n.x ?? 0) + (side === 'out' ? w : 0), y: (n.y ?? 0) + (H[n.kind] ?? 34) / 2 };
};

const path = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
};

const NODE_KIND_TITLE: Record<GNode['kind'], string> = { chapter: '章', char: '人物卡', world: '设定卡', hook: '伏笔标记', note: '便签' };

export default function GraphView({ project, onUpdate, onOpenChapter }: Props) {
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [sel, setSel] = useState<{ type: 'node' | 'link'; id: string } | null>(null);
  const [linkKind, setLinkKind] = useState<GLinkKind>('free');
  const [noteText, setNoteText] = useState('');
  const [depth, setDepth] = useState(3);
  const [msg, setMsg] = useState('');
  // 演一遍：走到第几拍（-1 = 没在演）、每拍停多久
  const [beat, setBeat] = useState(-1);
  const [speed, setSpeed] = useState(2600);
  const [playing, setPlaying] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ mode: 'pan' | 'node' | 'link'; id?: string; sx: number; sy: number; wx: number; wy: number; ox: number; oy: number } | null>(null);
  // 拖动中只画本地位置，松手才写回：一帧一次 setData 会让整页跟着抖
  const [dragPos, setDragPos] = useState<{ id: string; x: number; y: number } | null>(null);
  const [ghost, setGhost] = useState<{ from: string; x: number; y: number } | null>(null);

  const g = useMemo(() => graphOf(project), [project]);
  const nodes = useMemo(() => (dragPos ? g.nodes.map((n) => (n.id === dragPos.id ? { ...n, x: dragPos.x, y: dragPos.y } : n)) : g.nodes), [g.nodes, dragPos]);
  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const stats = useMemo(() => graphStats(g), [g]);
  const diag = useMemo(() => problems(project, g), [project, g]);
  const selNodeEarly = sel?.type === 'node' ? g.nodes.find((n) => n.id === sel.id) : undefined;
  const chainChapter = selNodeEarly?.kind === 'chapter' ? selNodeEarly.ref ?? '' : '';
  const chapterChips = chainChapter ? upstreamChapters(project, g, chainChapter, depth) : [];
  const script = useMemo(() => playScript(project, g), [project, g]);
  const now = beat >= 0 && beat < script.length ? script[beat] : null;
  const lit = new Set(now ? [now.nodeId] : []);

  const write = (next: StoryGraph) => onUpdate(project.id, { graph: next });

  const toWorld = (e: { clientX: number; clientY: number }) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    return { x: (e.clientX - box.left - view.x) / view.k, y: (e.clientY - box.top - view.y) / view.k };
  };

  // 镜头只把当前这一拍搬到视野中间，缩放不动：一放大就看不见上一拍讲到哪儿了
  const focusOn = (nodeId: string) => {
    const n = nodesById.get(nodeId);
    const box = svgRef.current?.getBoundingClientRect();
    if (!n || !box) return;
    const w = W[n.kind] ?? 140;
    const h = H[n.kind] ?? 34;
    setView((v) => ({ ...v, x: Math.round(box.width / 2 - ((n.x ?? 0) + w / 2) * v.k), y: Math.round(box.height / 2 - ((n.y ?? 0) + h / 2) * v.k) }));
  };
  const stepBeat = (delta: number) => {
    if (!script.length) return;
    const i = Math.min(script.length - 1, Math.max(0, (beat < 0 ? 0 : beat) + delta));
    setBeat(i);
    setSel({ type: 'node', id: script[i].nodeId });
    focusOn(script[i].nodeId);
  };
  const stopPlay = () => {
    setPlaying(false);
    setBeat(-1);
  };
  const togglePlay = () => {
    if (!script.length) {
      setMsg('图上还没有章节点：先点「一键牵线」把章连起来，才有戏可演。');
      return;
    }
    if (playing) {
      setPlaying(false);
      return;
    }
    const i = beat >= script.length - 1 || beat < 0 ? 0 : beat;
    setBeat(i);
    setSel({ type: 'node', id: script[i].nodeId });
    focusOn(script[i].nodeId);
    setPlaying(true);
  };
  // 走到最后一拍自己停：循环播放会变成背景噪音，没人伴着它写东西
  useEffect(() => {
    if (!playing || !script.length) return;
    if (beat >= script.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => stepBeat(1), speed);
    return () => clearTimeout(t);
  }, [playing, beat, speed, script]);
  useEffect(() => {
    if (!playing) return;
    const onEsc = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      stopPlay(); // Esc 在这页是「收」，不是「暂停」——暂停有按钮
      setMsg('演收了；再点「演一遍」从头走。');
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [playing, beat]);
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Delete' && ev.key !== 'Backspace') return;
      const t = ev.target as HTMLElement | null;
      if (t && /INPUT|TEXTAREA|SELECT/.test(t.tagName)) return;
      if (!sel) return;
      ev.preventDefault();
      write(sel.type === 'node' ? dropNode(g, sel.id) : dropLink(g, sel.id));
      setSel(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, g, write]);

  const startPan = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, wx: 0, wy: 0, ox: 0, oy: 0 };
    setSel(null);
  };
  const startNodeDrag = (e: React.PointerEvent, n: GNode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const w = toWorld(e);
    dragRef.current = { mode: 'node', id: n.id, sx: 0, sy: 0, wx: w.x, wy: w.y, ox: n.x ?? 0, oy: n.y ?? 0 };
    setSel({ type: 'node', id: n.id });
  };
  const startConnect = (e: React.PointerEvent, n: GNode) => {
    e.stopPropagation();
    const p = anchor(n, 'out');
    dragRef.current = { mode: 'link', id: n.id, sx: p.x, sy: p.y, wx: 0, wy: 0, ox: 0, oy: 0 };
    setGhost({ from: n.id, x: p.x, y: p.y });
  };
  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.mode === 'pan') {
      setView((v) => ({ ...v, x: v.x + (e.clientX - d.sx), y: v.y + (e.clientY - d.sy) }));
      d.sx = e.clientX;
      d.sy = e.clientY;
      return;
    }
    const w = toWorld(e);
    if (d.mode === 'node' && d.id) setDragPos({ id: d.id, x: Math.round(d.ox + (w.x - d.wx)), y: Math.round(d.oy + (w.y - d.wy)) });
    if (d.mode === 'link') setGhost({ from: d.id!, x: w.x, y: w.y });
  };
  const onUp = () => {
    const d = dragRef.current;
    if (d?.mode === 'node' && d.id && dragPos) write(moveNode(g, d.id, dragPos.x, dragPos.y));
    dragRef.current = null;
    setDragPos(null);
    setGhost(null);
  };

  const zoom = (f: number) => setView((v) => ({ ...v, k: Math.min(2.4, Math.max(0.35, Math.round((v.k * f) * 100) / 100)) }));
  const fit = () => {
    if (!g.nodes.length) return setView({ x: 20, y: 10, k: 1 });
    const xs = g.nodes.map((n) => n.x ?? 0);
    const ys = g.nodes.map((n) => n.y ?? 0);
    const box = svgRef.current?.getBoundingClientRect();
    const w = Math.max(...xs) + 200 - Math.min(...xs);
    const h = Math.max(...ys) + 90 - Math.min(...ys);
    const k = Math.min(1.4, Math.max(0.35, Math.min((box?.width ?? 900) / w, (box?.height ?? 600) / h)));
    setView({ x: 20 - Math.min(...xs) * k + 10, y: 20 - Math.min(...ys) * k + 10, k: Math.round(k * 100) / 100 });
  };

  const selNode = sel?.type === 'node' ? nodesById.get(sel.id) : undefined;
  const chapterIdOf = selNode?.kind === 'chapter' ? selNode.ref : undefined;
  const ctx = chapterIdOf ? contextFor(project, g, chapterIdOf, { depth, withNotes: true }) : '';

  return (
    <div className="gv">
      <div className="gv-bar">
        <button className="btn small" onClick={() => write(placeNew(project, autoWire(project, g)))} title="按已有数据把能确定的线牵上（重复点不会堆重复线）">
          <Wand2 size={13} /> 一键牵线
        </button>
        <button className="btn small" onClick={() => write(layout(project, g))} title="按阅读顺序重摆节点">
          <LayoutGrid size={13} /> 整理布局
        </button>
        <button className="btn small" onClick={togglePlay} title="沿「推动」线一拍拍走，镜头跟着走；Esc 停">
          {playing ? <Pause size={13} /> : <Play size={13} />} {playing ? '暂停' : '演一遍'}
        </button>
        {beat >= 0 && (
          <>
            <span className="gv-zoom">
              {beat + 1}/{script.length}
            </span>
            <select className="gv-kind gv-speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="每拍停多久">
              <option value={4200}>慢</option>
              <option value={2600}>中</option>
              <option value={1500}>快</option>
            </select>
            <button className="icon-btn" onClick={stopPlay} title="停下（Esc）">
              <Square size={13} />
            </button>
          </>
        )}
        <button
          className="btn small"
          onClick={() => {
            const r = syncCast(project, g);
            if (r.changed) onUpdate(project.id, { chapters: r.project.chapters });
            setMsg(r.changed ? `已把 ${r.changed} 章的出场名单补齐。` : '图上没有可补的出场名单——把章点连到人物点再试。');
          }}
          title="线上牵好的人物写回该章「出场人物」字段"
        >
          <RefreshCw size={13} /> 同步出场名单
        </button>
        <span className="gv-sep" />
        <select value={linkKind} onChange={(e) => setLinkKind(e.target.value as GLinkKind)} title="新牵的线算什么关系" className="gv-kind">
          {LINK_KINDS.map((k) => (
            <option key={k} value={k}>
              {LINK_LABEL[k]}
            </option>
          ))}
        </select>
        <span className="hint gv-tip">从节点右边的小圆点拖到另一个节点上松手＝牵一条「{LINK_LABEL[linkKind]}」线；点节点看详情，Del 删除，拖动即存位置。</span>
        <span className="foot-spacer" />
        <button className="icon-btn" onClick={() => zoom(1 / 1.2)} title="缩小">
          <ZoomOut size={14} />
        </button>
        <span className="gv-zoom">{Math.round(view.k * 100)}%</span>
        <button className="icon-btn" onClick={() => zoom(1.2)} title="放大">
          <ZoomIn size={14} />
        </button>
        <button className="icon-btn" onClick={fit} title="全部装进视野">
          <Crosshair size={14} />
        </button>
      </div>

      {now && (
        <div className="gv-narr" key={now.nodeId}>
          <em>
            第 {beat + 1} / {script.length} 拍 · {now.title}
            {now.written ? '' : ' · 还没写'}
          </em>
          <span className="gv-narr-line">{now.gist || '（这一章还是空的，剧本里是个空拍）'}</span>
          <span className="gv-narr-meta">
            {now.cast.length ? '在场 ' + now.cast.join('、') : '没牵出场人物'}
            {now.hooks.length ? ` · 挂着 ${now.hooks.length} 条伏笔` : ''}
          </span>
        </div>
      )}

      <div className="gv-main">
        <svg
          ref={svgRef}
          className="gv-canvas"
          onPointerDown={startPan}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={onUp}
          onDoubleClick={() => zoom(1.2)}
        >
          <defs>
            {LINK_KINDS.map((k) => (
              <marker key={k} id={`gv-arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" className={`gv-arrow gv-a-${k}`} />
              </marker>
            ))}
          </defs>
          // 镜头平移用 CSS transform 而不是属性：属性变化不走过渡，播放时是硬跳
          <g className="gv-world" style={{ transform: `translate(${view.x}px,${view.y}px) scale(${view.k})`, transition: playing ? 'transform 0.45s ease' : 'none' }}>
            {g.links.map((l) => {
              const a = nodesById.get(l.from);
              const b = nodesById.get(l.to);
              if (!a || !b) return null;
              const p1 = anchor(a, 'out');
              const p2 = anchor(b, 'in');
              return (
                <path
                  key={l.id}
                  d={path(p1, p2)}
                  className={'gv-link gv-l-' + l.kind + ((sel?.type === 'link' && sel.id === l.id) || lit.has(l.from) || lit.has(l.to) ? ' on' : '')}
                  markerEnd={`url(#gv-arrow-${l.kind})`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setSel({ type: 'link', id: l.id });
                  }}
                />
              );
            })}
            {ghost && <path d={path({ x: ghost.x, y: ghost.y }, anchor(nodesById.get(ghost.from)!, 'out'))} className="gv-link gv-ghost" />}
            {nodes.map((n) => {
              const label = nodeLabel(project, n);
              const flag = nodeFlag(project, n);
              const on = sel?.type === 'node' && sel.id === n.id;
              const dim = !!now && n.id !== now.nodeId;
              return (
                <g
                  key={n.id}
                  className={'gv-node gv-n-' + n.kind + (on ? ' on' : '') + (dim ? ' dim' : '') + (now?.nodeId === n.id ? ' now' : '')}
                  transform={`translate(${n.x ?? 0},${n.y ?? 0})`}
                  onPointerDown={(e) => startNodeDrag(e, n)}
                  onPointerUp={(e) => {
                    if (dragRef.current?.mode === 'link' && dragRef.current.id && dragRef.current.id !== n.id) {
                      write(addLink(g, dragRef.current.id, n.id, linkKind));
                      setMsg(`牵了一条「${LINK_LABEL[linkKind]}」：${nodeLabel(project, nodesById.get(dragRef.current.id)!)} → ${label}`);
                    }
                    onUp();
                    e.stopPropagation();
                  }}
                  onDoubleClick={() => {
                    if (n.kind === 'chapter' && n.ref) onOpenChapter?.(n.ref);
                  }}
                >
                  <title>{n.kind === 'note' ? n.note : `${NODE_KIND_TITLE[n.kind]}：${label}`}</title>
                  <rect width={W[n.kind] ?? 140} height={H[n.kind] ?? 34} rx={n.kind === 'note' ? 3 : 6} />
                  <text className="gv-label" x={10} y={n.kind === 'chapter' ? 21 : 21}>
                    {label.slice(0, n.kind === 'chapter' ? 14 : 11)}
                  </text>
                  {flag && (
                    <text className="gv-flag" x={10} y={n.kind === 'chapter' ? 38 : 31}>
                      {flag.slice(0, 18)}
                    </text>
                  )}
                  {n.kind === 'note' && n.note && (
                    <text className="gv-flag" x={10} y={36}>
                      {n.note.slice(0, 22)}
                    </text>
                  )}
                  <circle className="gv-port" cx={W[n.kind] ?? 140} cy={(H[n.kind] ?? 34) / 2} r={5} onPointerDown={(e) => startConnect(e, n)} />
                  <circle className="gv-port-in" cx={0} cy={(H[n.kind] ?? 34) / 2} r={4} />
                </g>
              );
            })}
            {!g.nodes.length && (
              <text className="gv-empty" x={40} y={70}>
                {project.mode === 'chapters' && (project.chapters ?? []).length ? '画布是空的：点上方「一键牵线」把章与人物连起来。' : '先在大纲页写几章、在抽屉里建几张人物卡，再回来牵线。'}
              </text>
            )}
          </g>
        </svg>

        <aside className="gv-side">
          <div className="gv-block">
            <h4>
              <GitBranchPlus size={13} /> 这张图
            </h4>
            <p className="hint">
              节点 {stats.nodes}（章 {stats.byKind.chapter} · 人物 {stats.byKind.char} · 设定 {stats.byKind.world} · 伏笔 {stats.byKind.hook} · 便签 {stats.byKind.note}）
              <br />
              线 {stats.links}（推动 {stats.byLink.next} · 出场 {stats.byLink.cast} · 关系 {stats.byLink.kin} · 伏笔 {stats.byLink.hook} · 手牵 {stats.byLink.free}）
            </p>
          </div>

          <div className="gv-block">
            <h4>断线诊断</h4>
            {!diag.length && <p className="hint">没牵出来的线、没收的伏笔、没连上的实体——都干净。</p>}
            {diag.length > 0 && (
              <ul className="gv-diag">
                {diag.map((d) => (
                  <li key={d.kind + d.nodeId + d.label}>
                    <em className={'gv-dk gv-dk-' + d.kind.replace('未收伏笔', 'hook').replace('孤立节点', 'note').replace('断头章', 'next')}>{d.kind}</em>
                    <button className="gv-jump" onClick={() => setSel({ type: 'node', id: d.nodeId })} title="在图上选中它">
                      {d.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="gv-block">
            <h4>加一块便签</h4>
            <div className="gv-note">
              <input value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="一句话记着，之后拖去连线" onKeyDown={(e) => e.key === 'Enter' && addSticky()} />
              <button className="mini-btn" onClick={addSticky} disabled={!noteText.trim()}>
                <StickyNote size={12} /> 钉上
              </button>
            </div>
          </div>

          {selNode && (
            <div className="gv-block gv-detail">
              <h4>选中：{nodeLabel(project, selNode)}</h4>
              <p className="hint">
                类型 {NODE_KIND_TITLE[selNode.kind]}
                {selNode.ref ? ` · 引自已有实体（改实体不用回来同步）` : ''}
              </p>
              <div className="gv-ops">
                {selNode.kind === 'chapter' && selNode.ref && (
                  <button className="mini-btn" onClick={() => onOpenChapter?.(selNode.ref!)} title="跳到写作页写这一章">
                    <ArrowRight size={12} /> 去写这章
                  </button>
                )}
                <button
                  className="mini-btn danger"
                  onClick={() => {
                    write(dropNode(g, selNode.id));
                    setSel(null);
                    setMsg('节点已取下（实体本身没删，只是不在图上）。');
                  }}
                >
                  <Trash2 size={12} /> 从图上取下
                </button>
              </div>
            </div>
          )}

          {!selNode && sel?.type === 'link' && (
            <div className="gv-block gv-detail">
              <h4>选中一条线</h4>
              <select
                className="gv-kind"
                value={g.links.find((l) => l.id === sel.id)?.kind ?? 'free'}
                onChange={(e) => write(relinkAs(g, sel.id, e.target.value as GLinkKind))}
              >
                {LINK_KINDS.map((k) => (
                  <option key={k} value={k}>
                    算作「{LINK_LABEL[k]}」
                  </option>
                ))}
              </select>
              <button
                className="mini-btn danger"
                onClick={() => {
                  write(dropLink(g, sel.id));
                  setSel(null);
                }}
              >
                <Trash2 size={12} /> 删掉这条线
              </button>
            </div>
          )}

          {chapterIdOf && (
            <div className="gv-block">
              <h4>沿链取用</h4>
              <p className="hint">
                往回追 {depth} 章：{chapterChips.length ? chapterChips.map((id) => (project.chapters ?? []).find((c) => c.id === id)?.title ?? '?').join(' → ') : '（链上还没有前章）'}
              </p>
              <div className="gv-depth">
                <label>
                  深度
                  <input type="number" min={1} max={8} value={depth} onChange={(e) => setDepth(Math.min(8, Math.max(1, Number(e.target.value) || 3)))} />
                </label>
              </div>
              <pre className="gv-ctx">{ctx}</pre>
              <div className="gv-ops">
                <button
                  className="mini-btn"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(ctx);
                      setMsg('上下文已复制到剪贴板。');
                    } catch {
                      setMsg('剪贴板不可用，选中文本手动复制即可。');
                    }
                  }}
                >
                  <Copy size={12} /> 复制
                </button>
                <button
                  className="mini-btn"
                  onClick={() => {
                    const c = (project.chapters ?? []).find((x) => x.id === chapterIdOf);
                    const line = '· 牵线：' + ctx.split('\n').filter((s) => s.startsWith('·')).map((s) => s.replace(/^·\s*/, '')).join(' / ');
                    if (!c) return;
                    onUpdate(project.id, { chapters: (project.chapters ?? []).map((x) => (x.id === c.id ? { ...x, beats: [(x.beats ?? '').trim(), line].filter(Boolean).join('\n') } : x)) });
                    setMsg('已把这份牵线摘要写进该章「剧情要点」。');
                  }}
                >
                  <Check size={12} /> 写进本章要点
                </button>
              </div>
            </div>
          )}
          {now && (
            <div className="gv-block">
              <h4>
                <Play size={13} /> 这一拍
              </h4>
              {!!now.hooks.length && <p className="hint">挂着：{now.hooks.join('；')}</p>}
              {!!now.notes.length && <p className="hint">便签：{now.notes.join(' / ')}</p>}
              {now.via === 'order' && <p className="hint">这一拍前面没牵「推动」线过来，剧本是按目录顺序把它补上的。</p>}
              <div className="gv-ops">
                <button className="mini-btn" onClick={() => stepBeat(-1)} disabled={beat <= 0}>
                  上一拍
                </button>
                <button className="mini-btn" onClick={() => stepBeat(1)} disabled={beat >= script.length - 1}>
                  下一拍
                </button>
                <button className="mini-btn" onClick={() => onOpenChapter?.(now.chapterId)}>
                  <ArrowRight size={12} /> 去写这章
                </button>
                <button className="mini-btn" onClick={stopPlay}>
                  停
                </button>
              </div>
            </div>
          )}
          {msg && <p className="hint gv-msg">{msg}</p>}
        </aside>
      </div>
    </div>
  );

  function addSticky() {
    const t = noteText.trim();
    if (!t) return;
    const box = svgRef.current?.getBoundingClientRect();
    const at = box ? { x: (box.width / 2 - view.x) / view.k, y: (box.height / 2 - view.y) / view.k } : undefined;
    write(addNote(g, t, at));
    setNoteText('');
    setMsg('便签已钉在画布中央，拖到合适位置再牵线。');
  }
}

