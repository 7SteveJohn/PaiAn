// 章节大纲卡片：memo 化后的单张卡（要点 / 人物 / 地点 / 伏笔 / 草稿与探讨操作）。
// 从 OutlinePanel 拆出来只为一件事——让父级能一眼看出「列表」和「一行卡」是两回事。
import { memo, useState } from 'react';
import { Sparkles, Eye, Check, RotateCcw, Trash2, MessageCircle } from 'lucide-react';
import type { Chapter } from '../types';
import { isThin } from '../gate';
import RichText from './RichText';

export interface OutlineOps {
  patch(c: Chapter, p: Partial<Chapter>, opts?: { snapshot?: boolean }): void;
  toggleSel(id: string): void;
  genDraft(c: Chapter): void;
  adopt(c: Chapter): void;
  refineSummary(c: Chapter): void;
  toggleDiscuss(id: string): void;
  togglePreview(id: string): void;
  sendDiscuss(c: Chapter, text: string): Promise<void>;
  draftBeats(c: Chapter): Promise<string | null>;
  clearDebt(): void;
  /** 把这一章从大纲里删掉（确认框在父级，丢什么由父级说清） */
  remove(c: Chapter): void;
}

interface OutlineCardProps {
  c: Chapter;
  i: number; // 0 起始的全局章号
  cWords: number;
  sel: boolean;
  aiReady: boolean;
  judgeOnly?: boolean; // 「AI 只判不写」：出稿动作按住，理由写在 title 里
  isRunning: boolean; // 任意章生成/批处理进行中
  isCurrent: boolean; // 本卡正在被生成
  previewOpen: boolean;
  sumBusy: boolean;
  discussOpen: boolean;
  debt: { id: string; words: number; pct: number; target: number } | null; // 刚采纳但字数欠账，只在被采纳那张卡上显示
  ops: OutlineOps;
}

// 章节大纲卡片：memo 化后，大纲字段每键编辑只重渲被编辑的那张卡；
// 其余 499 张在 500 章长书下经 props 浅比较直接跳过（从每键 ~200ms 降到 ~1ms）。
// 讨论/提炼/草稿输入的本地状态放卡内，避免把高频输入顶到父级连累整表。
const OutlineCard = memo(function OutlineCard({ c, i, cWords, sel, aiReady, judgeOnly, isRunning, isCurrent, previewOpen, sumBusy, discussOpen, debt, ops }: OutlineCardProps) {
  const [discText, setDiscText] = useState('');
  const [discBusy, setDiscBusy] = useState(false);
  const [beatsText, setBeatsText] = useState<string | null>(null);
  const [refineBusy, setRefineBusy] = useState(false);
  const st = c.content ? { text: '已写', cls: 'done' } : c.pending ? { text: '草稿待审', cls: 'draft' } : { text: '待写', cls: 'todo' };

  const sendDisc = async () => {
    const t = discText.trim();
    if (!t || discBusy) return;
    setDiscBusy(true);
    try {
      await ops.sendDiscuss(c, t);
      setDiscText('');
    } finally {
      setDiscBusy(false);
    }
  };

  const askBeats = async () => {
    if (refineBusy) return;
    setRefineBusy(true);
    try {
      const text = await ops.draftBeats(c);
      setBeatsText(text);
    } finally {
      setRefineBusy(false);
    }
  };

  const applyBeats = (mode: 'replace' | 'append') => {
    if (!beatsText) return;
    ops.patch(c, { beats: mode === 'replace' ? beatsText : (c.beats ? c.beats + '\n' : '') + beatsText });
    setBeatsText(null);
  };

  return (
    <div key={c.id} className={'ol-card' + (isCurrent ? ' running' : '')}>
      <div className="ol-row">
        <input
          type="checkbox"
          checked={sel}
          onChange={() => ops.toggleSel(c.id)}
        />
        <span className="ol-idx">{i + 1}</span>
        <input
          className="ol-title"
          value={c.title}
          onChange={(e) => ops.patch(c, { title: e.target.value })}
          placeholder="章节名"
        />
        <em className={'ol-badge ' + st.cls}>{st.text}</em>
        {cWords > 0 && <span className="ol-words">{cWords}字</span>}
        <button className="icon-btn ol-del" title="把这一章从大纲里删掉" onClick={() => ops.remove(c)}>
          <Trash2 size={13} />
        </button>
      </div>
      <div className="ol-fields">
        <label>
          剧情要点
          <textarea
            id={'ol-beats-' + c.id}
            className={isThin(c) && !c.content ? 'ol-thin' : undefined}
            rows={2}
            value={c.beats ?? ''}
            onChange={(e) => ops.patch(c, { beats: e.target.value })}
            placeholder="本章写什么：目标、冲突、转折…"
            title={isThin(c) ? '还没有剧情要点：批量生成前建议先补一句，AI 才不会替你定剧情' : undefined}
          />
        </label>
        <div className="ol-field-row">
          <label>
            所属卷
            <input
              value={c.volume ?? ''}
              onChange={(e) => ops.patch(c, { volume: e.target.value })}
              placeholder="留空=未分卷"
              list="volume-options"
            />
          </label>
          <label>
            出场人物
            <input value={c.cast ?? ''} onChange={(e) => ops.patch(c, { cast: e.target.value })} placeholder="顿号分隔" />
          </label>
          <label>
            出场地点
            <input value={c.places ?? ''} onChange={(e) => ops.patch(c, { places: e.target.value })} placeholder="如：废弃车站" />
          </label>
        </div>
        <label>
          伏笔安排
          <input value={c.hooks ?? ''} onChange={(e) => ops.patch(c, { hooks: e.target.value })} placeholder="本章要埋 / 要推进的伏笔" />
        </label>
        {c.summary && <div className="ol-summary">梗概：{c.summary}</div>}
      </div>
      <div className="ol-ops">
        {!isRunning && (
          <button
            className="mini-btn"
            disabled={!aiReady || judgeOnly}
            title={judgeOnly ? '「AI 只判不写」开着：这一条会产出成品正文，先按住（设置里可关）' : '按本章大纲生成一版草稿（覆盖旧草稿）'}
            onClick={() => ops.genDraft(c)}
          >
            <Sparkles size={12} /> 生成草稿
          </button>
        )}
        {c.pending && (
          <>
            <button className="mini-btn" onClick={() => ops.togglePreview(c.id)}>
              <Eye size={12} /> {previewOpen ? '收起草稿' : '看草稿'}
            </button>
            <button className="mini-btn ok" title="用草稿替换本章正文（原正文先存快照）" onClick={() => ops.adopt(c)}>
              <Check size={12} /> 采纳为正文
            </button>
            <button className="mini-btn" title="丢弃这份草稿" onClick={() => ops.patch(c, { pending: undefined })}>
              <Trash2 size={12} /> 弃用
            </button>
          </>
        )}
        {(c.content || c.pending) && (
          <button className="mini-btn" disabled={!aiReady || sumBusy} onClick={() => ops.refineSummary(c)} title="AI 用一句话概括本章，自动更新前情提要">
            <RotateCcw size={12} /> {sumBusy ? '提炼中…' : '提炼摘要'}
          </button>
        )}
        {!isRunning && (
          <button
            className="mini-btn"
            onClick={() => ops.toggleDiscuss(c.id)}
            title="写前和 AI 敲定本章剧情（只讨论，不写正文）"
          >
            <MessageCircle size={12} /> 探讨{c.discuss?.length ? `（${c.discuss.length}）` : ''}
          </button>
        )}
      </div>
      {debt && (
        <div className="gate-note">
          刚采纳的正文 {debt.words} 字，只有目标 {debt.target} 字的 {debt.pct}%——{debt.pct < 40 ? '这章多半没写完，' : ''}接着往下补，或「生成草稿」再来一版。
          <button className="mini-btn" onClick={ops.clearDebt}>
            知道了
          </button>
        </div>
      )}
      {discussOpen && (
        <div className="discuss-box">
          <div className="discuss-list">
            {(c.discuss ?? []).length === 0 && <div className="hint">和 AI 聊聊本章怎么写——只敲定剧情，不产生正文；聊完可把结论落为要点。</div>}
            {(c.discuss ?? []).map((m, idx) => (
              <div key={idx} className={'discuss-msg ' + m.role}>
                <span className="discuss-who">{m.role === 'user' ? '你' : '策划'}</span>
                <div className="discuss-text">
                  <RichText text={m.content} />
                </div>
              </div>
            ))}
            {discBusy && <div className="hint">策划思考中…</div>}
          </div>
          <div className="discuss-input">
            <input
              value={discText}
              placeholder="说说你的想法，或问剧情怎么安排…"
              onChange={(e) => setDiscText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendDisc()}
              disabled={discBusy}
            />
            <button className="btn small primary" disabled={discBusy || !discText.trim()} onClick={sendDisc}>
              发送
            </button>
          </div>
          <div className="discuss-ops">
            <button className="mini-btn" disabled={!aiReady || refineBusy || !(c.discuss ?? []).length} onClick={askBeats}>
              <Sparkles size={12} /> {refineBusy ? '提炼中…' : '把结论落为要点'}
            </button>
            {(c.discuss ?? []).length > 0 && (
              <button
                className="mini-btn"
                onClick={() => {
                  if (confirm('清空本章探讨记录？')) ops.patch(c, { discuss: [] });
                }}
              >
                <Trash2 size={12} /> 清空记录
              </button>
            )}
          </div>
          {beatsText && (
            <div className="beats-draft">
              <div className="ol-summary">拟要点：{beatsText}</div>
              <div className="discuss-ops">
                <button className="mini-btn ok" onClick={() => applyBeats('replace')}>
                  <Check size={12} /> 替换要点
                </button>
                <button className="mini-btn" onClick={() => applyBeats('append')}>
                  追加到要点
                </button>
                <button className="mini-btn" onClick={() => setBeatsText(null)}>
                  取消
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {previewOpen && c.pending && (
        <div className="ol-pending">
          <RichText text={c.pending} />
        </div>
      )}
    </div>
  );
});

// 时间线视图：把章节挂上故事内时间轴（timeLabel），可 AI 批量推断补齐，防时序混乱
export default OutlineCard;
