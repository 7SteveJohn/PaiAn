import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Undo2 } from 'lucide-react';
import { blockExcerpt, dropBlock, escCancelsDrag, joinScenes, moveBlock, splitScenes, swapBlocks } from '../scenes';
import { countWords } from '../util';

/** 能整块搬去的章节（按书的顺序）；单篇模式没有别的章，传空数组即可 */
export interface SceneTarget {
  id: string;
  title: string;
}

interface Props {
  /** 当前这一篇的正文：唯一的真身，切块结果每次从它算出来，不留第二份状态 */
  text: string;
  onText: (next: string) => void;
  /** 能整块搬去的章节（不含本篇） */
  targets: SceneTarget[];
  /** 把一块追加到别章末尾——本组件负责从本篇摘掉，父层负责写那一章 */
  onMoveOut: (targetId: string, block: string) => void;
  /** 「退回」要把跨章那一步整个收回来：本篇恢复之外，还得从别章取回这一块 */
  onMoveBack: (targetId: string, block: string) => void;
  /** 父层补充的一句说明（单篇模式没有别章可去）；空列表时显示 */
  note?: string;
}

/** 撤销栈里存的是「一步」，不是一段文本：跨章那步还动过别章 */
interface Step {
  text: string;
  out?: { id: string; block: string };
}

/**
 * 场景板：把整章按空行切成卡片，用来改结构——重排顺序、整块搬去下一章。
 * 这里不编辑字句（那是写作模式的事），所以卡片只给摘录与字数，改文还是回编辑器。
 */
export default function SceneBoard({ text, onText, targets, onMoveOut, onMoveBack, note }: Props) {
  const split = useMemo(() => splitScenes(text), [text]);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [undo, setUndo] = useState<Step[]>([]);
  const [msg, setMsg] = useState('');
  const cards = useRef<(HTMLDivElement | null)[]>([]);

  const commit = (next: string, say: string, out?: { id: string; block: string }) => {
    if (next === text) return;
    setUndo((u) => [...u.slice(-19), { text, out }]);
    onText(next);
    setMsg(say);
  };

  // 指针落在哪两条卡之间：拿中点判，插到该卡之前或之后
  const gapAt = (y: number) => {
    const n = split.items.length;
    for (let i = 0; i < n; i++) {
      const el = cards.current[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return n;
  };

  // 按下即开始拖动。move/up 不在这里挂——见下面那个 window 上的 effect：
  // 手指滑出卡片外也要接得住，卡片自己已经 touch-action:none，不会再被页面滚走抢走手势
  const startDrag = (e: React.PointerEvent, i: number) => {
    if (e.button !== 0) return;
    setDragFrom(i);
    setDropAt(null);
  };
  // 拖动期间把 move/up 挂到 window：指针滑出卡片也接得住。
  // 只挂在卡片上有个真 bug——松手在卡片外就结束不了这次拖动，卡会一直「粘」着指针，
  // 下次再按下去之前落点线也不会动。故意不写依赖数组：每次渲染重挂，闭包永远看到最新的 split/dropAt。
  useEffect(() => {
    if (dragFrom === null) return;
    const move = (ev: PointerEvent) => setDropAt(gapAt(ev.clientY));
    const up = (ev: PointerEvent) => {
      const to = dropAt ?? gapAt(ev.clientY);
      const from = dragFrom;
      setDragFrom(null);
      setDropAt(null);
      if (to === from || to === from + 1) return; // 落在自己边上：什么都没挪，别留一条假回执
      commit(joinScenes(moveBlock(split, from, to)), `第 ${from + 1} 块挪到第 ${to > from + 1 ? to : to + 1} 位`);
    };
    const cancel = () => {
      setDragFrom(null);
      setDropAt(null);
    };
    // 拖到一半按 Esc：这次拖动就地反悔，不落库。全局的「Esc 收工」（收抽屉/退专注）
    // 与它不冲突——两边都是「收」，各自收各自的。
    const onKey = (ev: KeyboardEvent) => {
      if (escCancelsDrag(ev.key, dragFrom !== null)) cancel();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', onKey);
    // 失焦（Alt+Tab 走开）时 pointerup 可能永远不来，那张卡会一直「粘」着压暗
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', cancel);
    };
  });

  const totalWords = countWords(text);
  const n = split.items.length;

  return (
    <section className="scene-board">
      <div className="sb-head">
        <h3>场景板 · {n} 块</h3>
        <span className="sb-hint">
          {n === 0
            ? '这一章还没有正文。'
            : split.unit === '段'
              ? '按空行切不出多块（你大概用单换行分段），这里按段切开；重排只换顺序，不动你的换行。'
              : '按空行切块。拖动卡片改顺序，或整块搬去下一章。'}
        </span>
        <span className="sb-words">全章 {totalWords} 字</span>
        {undo.length > 0 && (
          <button
            className="btn small"
            onClick={() => {
              const step = undo[undo.length - 1];
              setUndo((u) => u.slice(0, -1));
              onText(step.text);
              if (step.out) {
                onMoveBack(step.out.id, step.out.block);
                const t = targets.find((x) => x.id === step.out?.id);
                setMsg(`已退回：本篇恢复，「${t?.title ?? step.out.id}」里那块也取回来了`);
              } else setMsg('已退回上一步');
            }}
          >
            <Undo2 size={13} /> 退回上一步（{undo.length}）
          </button>
        )}
      </div>
      {msg && <div className="sb-msg">{msg}</div>}

      {n === 0 && <p className="hint">{note ?? '没有可排的块——先去「写作」模式写点什么，或到大纲模式补细纲。'}</p>}
      {n === 1 && <p className="hint">整章只有一块：没有空行也没有单换行分段，那就没什么可重排的。</p>}

      <ol className="sb-list">
        {split.items.map((item, i) => (
          <li className="sb-row" key={i}>
            {dropAt === i && dragFrom !== null && <div className="sb-drop" />}
            <div
              ref={(el) => {
                cards.current[i] = el;
              }}
              className={'sb-card' + (dragFrom === i ? ' dragging' : '')}
              onPointerDown={(e) => {
                if ((e.target as HTMLElement).closest('button,select')) return;
                startDrag(e, i);
              }}
            >
              <span className="sb-idx">{i + 1}</span>
              <span className="sb-body">
                <span className="sb-title">{blockExcerpt(item) || '（空白块）'}</span>
                <span className="sb-meta">
                  {countWords(item)} 字 · {(item.match(/\n/g) ?? []).length + 1} 行
                </span>
              </span>
              <span className="sb-ops">
                <button className="icon-btn" title="上移一块" disabled={i === 0 || dragFrom !== null} onClick={() => commit(joinScenes(swapBlocks(split, i, i - 1)), `第 ${i + 1} 块上移`)}>
                  <ChevronUp size={14} />
                </button>
                <button className="icon-btn" title="下移一块" disabled={i === n - 1 || dragFrom !== null} onClick={() => commit(joinScenes(swapBlocks(split, i, i + 1)), `第 ${i + 1} 块下移`)}>
                  <ChevronDown size={14} />
                </button>
                <select
                  className="sb-to"
                  value=""
                  disabled={!targets.length || dragFrom !== null}
                  title={targets.length ? '把这一块整块搬到别的章末尾' : '单篇模式没有别的章'}
                  onChange={(e) => {
                    const id = e.target.value;
                    if (!id) return;
                    const t = targets.find((x) => x.id === id);
                    commit(joinScenes(dropBlock(split, i)), `这块已搬去「${t?.title ?? id}」（原处已摘掉，回写作模式可见）`, { id, block: item });
                    onMoveOut(id, item);
                  }}
                >
                  <option value="">{targets.length ? '搬去…' : '没有别的章'}</option>
                  {targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </select>
              </span>
            </div>
          </li>
        ))}
        {dropAt === n && dragFrom !== null && n > 0 && <div className="sb-drop last" />}
      </ol>
    </section>
  );
}
