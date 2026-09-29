// 时间线视图：把章节挂上故事内时间轴，可 AI 批量推断补齐，防时序混乱。
// 与大纲卡互不相干，所以单独成一个文件；解析函数也留在这里。
import { useState } from 'react';
import { Sparkles, Clock, Check } from 'lucide-react';
import type { AIPublic, Chapter, Project } from '../types';
import { rulesSuffix } from '../util';
import { streamChat } from '../api';
import { repeatedLabels, runText, trackLayout } from '../timeline';

interface TlItem {
  i: number;
  time: string;
}

function parseTimeline(raw: string): TlItem[] | null {
  const s = raw.indexOf('[');
  const e = raw.lastIndexOf(']');
  if (s < 0 || e <= s) return null;
  try {
    const arr = JSON.parse(raw.slice(s, e + 1)) as unknown;
    if (!Array.isArray(arr)) return null;
    return arr
      .map((x) => ({ i: Number((x as TlItem).i), time: String((x as TlItem).time ?? '').trim() }))
      .filter((x) => Number.isInteger(x.i) && x.i >= 1 && x.time);
  } catch {
    return null;
  }
}

// 卡片操作集合：全部稳定引用（经 useMemo 只建一次），供 OutlineCard memo 浅比较
export default function TimelineView({ project, aiInfo, patch }: { project: Project; aiInfo: AIPublic; patch: (c: Chapter, p: Partial<Chapter>) => void }) {
  const chapters = project.chapters ?? [];
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState<Record<string, string> | null>(null); // chapterId → AI 推断标签

  const missing = chapters.filter((c) => !(c.timeLabel ?? '').trim()).length;
  const repeats = repeatedLabels(chapters);
  const track = trackLayout(chapters);

  const infer = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const list = chapters.slice(0, 60);
      const body = list
        .map((c, i) => `第${i + 1}章 ${c.title}${c.summary ? `｜梗概：${c.summary.slice(0, 60)}` : ''}${c.timeLabel ? `｜现有标注：${c.timeLabel}` : ''}`)
        .join('\n');
      let raw = '';
      await streamChat(
        [
          {
            role: 'system',
            content:
              '你是网文连续性编辑。根据章节标题与梗概推断每章的故事内时间标签（如「入历327年九月」「穿越第三日」），' +
              '各章先后顺序必须一致，粒度统一；已有标注合理的保留原值。只输出 JSON 数组，不要解释，不要 markdown 代码块：' +
              '[{"i":1,"time":"…"}]，i 为章节序号。' + rulesSuffix(aiInfo.rules),
          },
          { role: 'user', content: `全书 ${chapters.length} 章，章节如下：\n\n${body}` },
        ],
        (t) => (raw += t),
      );
      const items = parseTimeline(raw);
      if (!items) {
        setMsg({ ok: false, text: 'AI 返回内容无法解析，请重试或换模型。' });
        return;
      }
      const next: Record<string, string> = {};
      for (const it of items) {
        const c = list[it.i - 1];
        if (c) next[c.id] = it.time;
      }
      setPreview(next);
      setMsg({ ok: true, text: `已推断 ${Object.keys(next).length} 章，逐条检查（可直接改）后点「应用预览」。` });
    } catch (e) {
      setMsg({ ok: false, text: '推断失败：' + (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    if (!preview) return;
    let n = 0;
    for (const c of chapters) {
      const t = preview[c.id];
      if (t && t !== c.timeLabel) {
        patch(c, { timeLabel: t });
        n++;
      }
    }
    setPreview(null);
    setMsg({ ok: true, text: `已更新 ${n} 章时间标签。` });
  };

  return (
    <div className="tl-wrap">
      <div className="tl-bar">
        <span className="hint">
          <Clock size={12} style={{ verticalAlign: -2 }} /> {chapters.length} 章 · {missing ? `${missing} 章未标注时间` : '全部已标注'}
        </span>
        <button className="btn small primary" disabled={!aiInfo.ready || busy || !chapters.length} onClick={infer}>
          {busy ? '推断中…' : <><Sparkles size={12} /> AI 推断时间标签</>}
        </button>
        {preview && (
          <button className="mini-btn ok" onClick={apply}>
            <Check size={12} /> 应用预览
          </button>
        )}
      </div>
      {msg && <div className={'field-msg ' + (msg.ok ? 'ok' : 'fail')}>{msg.text}</div>}
      {chapters.length > 0 && (
        <div className="tl-track-wrap">
          <svg className="tl-track" viewBox="0 0 680 88" preserveAspectRatio="none" role="img" aria-label="章节序与故事内时间双轨图">
            {/* 上轨：章节序，每章一点 */}
            <line x1={0} y1={16} x2={680} y2={16} className="tl-rail" />
            {track.dots.map((d, i) => (
              <circle key={i} cx={d.x * 680} cy={16} r={2.2} className={'tl-dot' + (d.labeled ? '' : ' tl-dot-miss')} />
            ))}
            {/* 下轨：连续同标签并成一带；跨区间复现的标签描红——那条长回线就是疑似闪回 */}
            <line x1={0} y1={64} x2={680} y2={64} className="tl-rail" />
            {track.blocks.map((b, i) => {
              const w = Math.max(2, (b.x1 - b.x0) * 680);
              return (
                <rect
                  key={i}
                  x={b.x0 * 680}
                  y={58}
                  width={w}
                  height={12}
                  rx={2}
                  className={'tl-band' + (b.repeated ? ' tl-band-repeat' : b.label ? '' : ' tl-band-miss')}
                >
                  <title>
                    {`${b.label || '（未标注）'}：${runText(b)}${b.repeated ? '（这个时间在别处也出现过，若非有意闪回就查一下）' : ''}`}
                  </title>
                </rect>
              );
            })}
          </svg>
          <div className="tl-track-legend">
            <span>上轨：章节序</span>
            <span>下轨：故事内时间（连续同标签并成一带）</span>
            {repeats.length > 0 && <span className="tl-repeat">疑似闪回：{repeats.map((g) => `「${g.label}」出现在 ${g.runs.map(runText).join(' 与 ')}`).join('；')}——有意写的就没事</span>}
          </div>
        </div>
      )}
      <div className="tl-list">
        {chapters.map((c, i) => {
          const val = preview?.[c.id] ?? c.timeLabel ?? '';
          return (
            <div key={c.id} className={'tl-row' + (preview?.[c.id] !== undefined ? ' changed' : '')}>
              <span className="ol-idx">{i + 1}</span>
              <span className="tl-title" title={c.title}>
                {c.title}
              </span>
              <input
                className="drawer-mini-input tl-input"
                value={val}
                placeholder="故事内时间，如：入历327年九月"
                onChange={(e) => {
                  const v = e.target.value;
                  patch(c, { timeLabel: v });
                  setPreview((p) => {
                    if (!p || !(c.id in p)) return p;
                    const next = { ...p };
                    delete next[c.id];
                    return next;
                  });
                }}
              />
              {c.summary && (
                <span className="tl-gist" title={c.summary}>
                  {c.summary.slice(0, 26)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

