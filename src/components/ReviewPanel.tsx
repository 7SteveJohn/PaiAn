import { useMemo } from 'react';
import type { Project } from '../types';
import type { UserCards } from '../gacha';
import { summarizeDeslop } from '../deslop';
import PitchPanel from './PitchPanel';
import LorePanel from './LorePanel';

// 高频停用词（最小集，避免大词表）
const STOP = ['我们', '他们', '自己', '什么', '这个', '那个', '一个', '没有', '不是', '就是', '还是', '可以', '因为', '所以', '但是', '如果', '现在', '时候', '已经', '起来', '出来', '知道', '觉得', '一样', '这样', '那样', '他的', '她的', '我的'];

// 简易基调词表：负面事件 vs 正面事件（粗粒度统计，辅助把握基调）
const DARK_WORDS = ['死', '离别', '牺牲', '背叛', '眼泪', '葬', '诀别', '绝望', '尸', '血', '恨'];
const LIGHT_WORDS = ['和解', '重逢', '拥抱', '笑着', '团圆', '希望', '阳光', '释然', '婚', '新生'];

function topKeywords(text: string): { word: string; count: number }[] {
  const cleaned = text.replace(/[#>*\-\n\r\s，。！？；：""''（）【】、…!.?;:"'()\[\]]+/g, ' ');
  const counts = new Map<string, number>();
  // 中文二元分词（简单有效的近义词统计）
  const tokens = cleaned.split(/\s+/).flatMap((seg) => {
    const out: string[] = [];
    for (let i = 0; i < seg.length; i++) {
      if (/[\u3400-\u9fff]/.test(seg[i])) {
        if (i + 1 < seg.length && /[\u3400-\u9fff]/.test(seg[i + 1])) out.push(seg.slice(i, i + 2));
        if (i + 2 < seg.length && /[\u3400-\u9fff]/.test(seg[i + 2])) out.push(seg.slice(i, i + 3));
      } else {
        const m = seg.slice(i).match(/^[A-Za-z]+/);
        if (m) {
          out.push(m[0]);
          i += m[0].length - 1;
        }
      }
    }
    return out;
  });
  for (const t of tokens) {
    if (t.length < 2 || STOP.includes(t)) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 18);
}

// 人物关系简易图谱：环形布局，有关系的人物之间连线
function RelationGraph({ project }: { project: Project }) {
  const chars = project.characters ?? [];
  if (chars.length === 0) return <p className="hint">还没有人物。选中正文中的人名，用悬浮菜单标记「人物」，或到抽屉「人物」页签添加。</p>;
  const size = 340;
  const cx = size / 2;
  const cy = size / 2;
  const r = 120;
  const pos = chars.map((c, i) => {
    const angle = (i / chars.length) * Math.PI * 2 - Math.PI / 2;
    return { c, x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  });
  const edges: { a: number; b: number; note: string }[] = [];
  pos.forEach(({ c }, i) => {
    for (const rel of c.relations ?? []) {
      const j = pos.findIndex(({ c: other }) => other.name === rel.with);
      if (j > i) edges.push({ a: i, b: j, note: rel.note });
    }
  });
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="graph-svg">
      {edges.map((e, i) => (
        <g key={i}>
          <line x1={pos[e.a].x} y1={pos[e.a].y} x2={pos[e.b].x} y2={pos[e.b].y} className="graph-edge" />
          <text x={(pos[e.a].x + pos[e.b].x) / 2} y={(pos[e.a].y + pos[e.b].y) / 2 - 4} textAnchor="middle" className="graph-edge-label">
            {e.note.slice(0, 6)}
          </text>
        </g>
      ))}
      {pos.map(({ c, x, y }) => (
        <g key={c.id}>
          <circle cx={x} cy={y} r={17} className="graph-node" />
          <text x={x} y={y + 4} textAnchor="middle" className="graph-node-label">
            {c.name.slice(0, 3)}
          </text>
        </g>
      ))}
    </svg>
  );
}

interface Props {
  project: Project;
  text: string; // 全文口径（章节模式为按章拼接）
  cards: UserCards;
  onCards: (next: UserCards) => void;
  onOpenGacha: () => void;
  onAddLadder: () => string; // 守夜人还在吃内置境界表时，一键补一张力量体系设定卡
}

export default function ReviewPanel({ project, text, cards, onCards, onOpenGacha, onAddLadder }: Props) {
  const marks = project.marks ?? [];
  const foreshadows = marks.filter((m) => m.type === '伏笔');
  const openForeshadows = foreshadows.filter((m) => m.status !== '回收');
  const orphaned = marks.filter((m) => m.orphaned);
  const keywords = useMemo(() => topKeywords(text), [text]);
  const maxKw = Math.max(...keywords.map((k) => k.count), 1);
  const dark = DARK_WORDS.reduce((a, w) => a + (text.split(w).length - 1), 0);
  const light = LIGHT_WORDS.reduce((a, w) => a + (text.split(w).length - 1), 0);
  const toneTotal = dark + light;

  // AI 味：按章扫确定性句式表，聚合出全书面板与「最重的几章」。纯本地，不叫 AI 也不联网。
  const flavor = useMemo(() => {
    const chapters = project.mode === 'chapters' ? project.chapters ?? [] : [];
    const agg = new Map<string, { key: string; label: string; level: number; fix: string; count: number }>();
    const perCh: { no: number; title: string; hits: number; per1k: number }[] = [];
    let chars = 0;
    let hits = 0;
    const feed = (body: string, no = 0, title = '') => {
      const r = summarizeDeslop(body);
      chars += r.chars;
      hits += r.hits.length;
      for (const g of r.groups) {
        const cur = agg.get(g.key);
        if (cur) cur.count += g.count;
        else agg.set(g.key, { key: g.key, label: g.label, level: g.level, fix: g.fix, count: g.count });
      }
      if (no > 0 && r.hits.length > 0) perCh.push({ no, title, hits: r.hits.length, per1k: r.per1k });
    };
    if (chapters.length > 0) chapters.forEach((c, i) => feed(c.content ?? '', i + 1, c.title));
    else feed(text);
    perCh.sort((a, b) => b.per1k - a.per1k || b.hits - a.hits);
    return {
      hits,
      per1k: chars > 0 ? Math.round((hits / (chars / 1000)) * 10) / 10 : 0,
      groups: [...agg.values()].sort((a, b) => b.level - a.level || b.count - a.count),
      worst: perCh.slice(0, 6),
    };
  }, [text, project]);

  return (
    <div className="review-panel">
      <PitchPanel project={project} cards={cards} onCards={onCards} onOpenGacha={onOpenGacha} />
      <LorePanel project={project} cards={cards} onCards={onCards} onOpenGacha={onOpenGacha} onAddLadder={onAddLadder} />
      <div className="review-col">
        <h4>伏笔追踪</h4>
        <p className="hint">
          共 {foreshadows.length} 条 · 未回收 <b className={openForeshadows.length ? 'warn-num' : ''}>{openForeshadows.length}</b> 条
          {orphaned.length > 0 && <> · 原文已变的标记 {orphaned.length} 条</>}
        </p>
        {foreshadows.length === 0 && <p className="hint">选中正文用悬浮菜单标「伏笔」，埋点与回收都会汇总到这里。</p>}
        {foreshadows.slice(0, 8).map((m) => (
          <div key={m.id} className="review-row">
            <span className={'status-pill ' + (m.status === '回收' ? 'stc-done' : 'stc-drafting')}>{m.status ?? '埋下'}</span>
            <span className="review-text">{m.text.slice(0, 20)}{m.expected ? ` · 期望${m.expected}` : ''}</span>
          </div>
        ))}
      </div>

      <div className="review-col">
        <h4>主题关键词</h4>
        {keywords.length === 0 && <p className="hint">正文还太短，写多一些再看高频词。</p>}
        <div className="kw-list">
          {keywords.map((k) => (
            <span key={k.word} className="kw-item" title={`${k.word} 出现 ${k.count} 次`}>
              <span className="kw-word">{k.word}</span>
              <span className="kw-track">
                <span className="kw-bar" style={{ width: `${(k.count / maxKw) * 100}%` }} />
              </span>
              <span className="kw-n">{k.count}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="review-col">
        <h4>简易基调</h4>
        <p className="hint">按负面/正面事件词粗略计数，把握整体基调倾向。</p>
        <div className="tone-row">
          <span>沉</span>
          <span className="tone-track">
            <span className="tone-dark" style={{ flexGrow: Math.max(dark, 0.001) }} />
            <span className="tone-light" style={{ flexGrow: Math.max(light, 0.001) }} />
          </span>
          <span>扬</span>
        </div>
        <p className="hint">
          负面词 {dark} 处 · 正面词 {light} 处{toneTotal === 0 && ' · 暂未检出'}
        </p>
        <h4 style={{ marginTop: 18 }}>人物关系</h4>
        <RelationGraph project={project} />
      </div>

      <div className="review-col">
        <h4>AI 味（模板句式）</h4>
        <p className="hint">
          全书 {flavor.hits} 处 · <b className={flavor.per1k >= 3 ? 'warn-num' : ''}>{flavor.per1k}</b> 处/千字。按确定性句式表统计，只提醒不改正文。
        </p>
        {flavor.groups.length === 0 && <p className="hint">一处没命中。写作页底部可随时关掉这个提醒。</p>}
        {flavor.groups.slice(0, 6).map((g) => (
          <div key={g.key} className="flavor-grp">
            <span className="flavor-lv" title={`毒级 ${g.level}/5`}>
              {'★'.repeat(g.level - 1)}
            </span>
            <b>{g.label}</b>
            <em>×{g.count}</em>
          </div>
        ))}
        {flavor.worst.length > 0 && (
          <>
            <h4 style={{ marginTop: 18 }}>密度最高的章</h4>
            {flavor.worst.map((c) => (
              <div key={c.no} className="flavor-ch">
                <span className="review-text">
                  第{c.no}章 {c.title}
                </span>
                <b>
                  {c.per1k}/千字 · {c.hits} 处
                </b>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
