import { useEffect, useRef } from 'react';
import { EditorState, Compartment, StateEffect, StateField, Annotation, type Extension, type Range } from '@codemirror/state';
import { EditorView, keymap, placeholder, Decoration, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import type { TextMark } from '../types';
import { GHOST_SYSTEM, pickGhost } from '../ghost';
import { streamChat } from '../api';

// 与工作台一致的暖纸 + 朱砂配色（使用 CSS 变量，夜间模式自动跟随）
const editorTheme = EditorView.theme({
  '&': {
    fontSize: 'var(--doc-fs, 16.5px)',
    backgroundColor: 'transparent',
    height: '100%',
  },
  '.cm-scroller': {
    fontFamily: "'Noto Serif SC', 'Source Han Serif SC', 'STZhongsong', 'SimSun', serif",
    lineHeight: '2.05',
    minHeight: '52vh',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
    padding: '0',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--accent-soft)',
  },
  '.cm-placeholder': {
    color: 'var(--muted)',
  },
  '.cm-cursor': {
    borderLeftWidth: '2px',
  },
});

// Markdown 元素用柔和的编辑部配色渲染
const highlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.35em', fontWeight: '700' },
  { tag: tags.heading2, fontSize: '1.2em', fontWeight: '700' },
  { tag: [tags.heading3, tags.heading4], fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: 'var(--teal)', textDecoration: 'underline' },
  { tag: tags.quote, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: tags.list },
]);

// ---------- 标记侧线：含锚点的行显示彩色细线（不污染正文） ----------
const setMarks = StateEffect.define<TextMark[]>();
const marksLineClass: Record<string, string> = {
  伏笔: 'mk-line-fb',
  彩蛋: 'mk-line-egg',
  人物: 'mk-line-char',
  场景: 'mk-line-scene',
  碎片: 'mk-line-frag',
};
const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setMarks)) {
        const b: Range<Decoration>[] = [];
        for (const m of e.value) {
          if (m.orphaned || !m.text) continue;
          const pos = Math.min(Math.max(m.start, 0), tr.state.doc.length);
          const line = tr.state.doc.lineAt(pos);
          b.push(Decoration.line({ class: marksLineClass[m.type] ?? 'mk-line-frag' }).range(line.from));
        }
        deco = Decoration.set(b, true);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------- 禁用词练笔：命中词浅灰温和提醒 ----------
const setForbidden = StateEffect.define<string[]>();
const forbiddenWordsField = StateField.define<string[]>({
  create: () => [],
  update(words, tr) {
    for (const e of tr.effects) {
      if (e.is(setForbidden)) return e.value;
    }
    return words;
  },
});
const forbiddenField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let wordsChanged = false;
    for (const e of tr.effects) {
      if (e.is(setForbidden)) wordsChanged = true;
    }
    if (!tr.docChanged && !wordsChanged) return deco;
    deco = deco.map(tr.changes);
    const words = wordsChanged
      ? tr.effects.filter((e): e is ReturnType<typeof setForbidden.of> => e.is(setForbidden)).pop()!.value
      : tr.startState.field(forbiddenWordsField);
    const b: Range<Decoration>[] = [];
    const doc = tr.state.doc.toString();
    for (const w of words) {
      if (!w) continue;
      let idx = doc.indexOf(w);
      while (idx >= 0) {
        b.push(Decoration.mark({ class: 'forbidden-word' }).range(idx, idx + w.length));
        idx = doc.indexOf(w, idx + w.length);
      }
    }
    return Decoration.set(b, true);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------- AI 味提示：命中处细虚线下划线，只在编辑器里提醒，不进正文 ----------
export interface FlavorRange {
  start: number;
  end: number;
}
const setFlavor = StateEffect.define<FlavorRange[]>();
const flavorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let changed = false;
    for (const e of tr.effects) {
      if (e.is(setFlavor)) changed = true;
    }
    // 文档变化时不就地映射：调用方会在防抖后重新下发命中区间
    if (!changed) return tr.docChanged ? Decoration.none : deco;
    const b: Range<Decoration>[] = [];
    const len = tr.state.doc.length;
    for (const r of tr.effects.filter((e): e is ReturnType<typeof setFlavor.of> => e.is(setFlavor)).pop()!.value) {
      if (r.end <= r.start || r.start >= len) continue;
      b.push(Decoration.mark({ class: 'ai-flavor' }).range(r.start, Math.min(r.end, len)));
    }
    return Decoration.set(b, true);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------- 冻结修改：冻结点之前的正文只读 ----------
const setFrozen = StateEffect.define<number | null>();
const frozenField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setFrozen)) value = e.value;
    }
    return value;
  },
});
// 标记「程序化整篇回灌」的外部修改：冻结过滤器需放行（用户手改仍受冻结约束）
const externalChange = Annotation.define<boolean>();

const freezeFilter: Extension = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(externalChange)) return tr;
  const frozen = tr.startState.field(frozenField, false);
  if (frozen == null) return tr;
  let touchesFrozen = false;
  tr.changes.iterChanges((fromA) => {
    if (fromA < frozen) touchesFrozen = true;
  });
  return touchesFrozen ? [] : tr; // 触及冻结点之前内容的事务整体拒绝
});

const freezeComp = new Compartment();

const baseExtensions: Extension[] = [
  freezeComp.of([freezeFilter]),
  frozenField,
  history(),
  keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
  search({ top: true }),
  highlightSelectionMatches(),
  markdown(),
  EditorView.lineWrapping,
  editorTheme,
  syntaxHighlighting(highlight),
  forbiddenWordsField,
  forbiddenField,
  flavorField,
  marksField,
  EditorView.updateListener.of((u) => {
    if (u.docChanged) {
      onChangeRef.current(u.state.doc.toString());
      ghostDocChangeRef.current(u.view);
    }
    if (u.selectionSet) {
      const range = u.state.selection.main;
      onSelectionRef.current(range.from, range.to, u.view);
    }
  }),
];

interface Props {
  value: string;
  placeholderText: string;
  marks?: TextMark[];
  forbidden?: string[];
  flavor?: FlavorRange[]; // AI 味命中区间（由调用方防抖扫描后下发）
  freezeAt?: number | null;
  initialCursor?: number;
  /** 幽灵字续写建议开关（默认关）；Tab 采纳，任何新按键/失焦/滚动即取消 */
  ghostEnabled?: boolean;
  onChange: (value: string) => void;
  onSelectionChange: (from: number, to: number, view: EditorView) => void;
  onReady?: (view: EditorView) => void;
}

const onChangeRef = { current: (_v: string) => {} };
const onSelectionRef = { current: (_f: number, _t: number, _v: EditorView) => {} };
// 幽灵字续写：文档停变 1.5s 后向模型要一句，Tab 采纳；逻辑全在挂载 effect 里（见下）
const ghostDocChangeRef = { current: (_v: EditorView) => {} };

// CodeMirror 6 封装：Obsidian 同款编辑器内核。
// 组件仅挂载时创建实例；外部传入的 value 变化（如 AI 插入/替换）通过 effect 回灌文档。
export default function CodeEditor({
  value,
  placeholderText,
  marks,
  forbidden,
  flavor,
  freezeAt,
  initialCursor,
  ghostEnabled,
  onChange,
  onSelectionChange,
  onReady,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const ghostEnabledRef = useRef(ghostEnabled ?? false);
  ghostEnabledRef.current = ghostEnabled ?? false;
  onChangeRef.current = onChange;
  onSelectionRef.current = onSelectionChange;

  useEffect(() => {
    const state = EditorState.create({
      doc: value,
      selection: initialCursor ? { anchor: Math.min(initialCursor, value.length) } : undefined,
      extensions: [...baseExtensions, placeholder(placeholderText)],
    });
    const view = new EditorView({ state, parent: hostRef.current! });
    viewRef.current = view;
    view.dispatch({
      effects: [setMarks.of(marksRef.current ?? []), setForbidden.of(forbidden ?? []), setFlavor.of(flavor ?? []), setFrozen.of(freezeAt ?? null)],
    });
    onReady?.(view);
    // 调试/扩展钩子：控制台或测试可直接访问编辑器实例
    (window as unknown as Record<string, unknown>).__cmView = view;
    (window as unknown as Record<string, unknown>).__cmDebug = { setFrozen, frozenField, setMarks, setForbidden, setFlavor };
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // 挂载时创建一次；文档/标记/禁用词/冻结点同步由下方 effect 处理
  }, []);

  // ---------- 幽灵字续写：停笔 1.5s 后要一句，Tab 采纳；不进 CM state，浮在 document.body 上 ----------
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let timer: number | undefined;
    let abort: AbortController | null = null;
    let inflight = false;
    let ghost = '';
    let el: HTMLSpanElement | null = null;
    let composing = false;

    const hideGhost = () => {
      el?.remove();
      el = null;
      ghost = '';
    };
    const abortGhost = () => {
      abort?.abort();
      abort = null;
      inflight = false;
      hideGhost();
    };
    // 用 coordsAtPos 把幽灵字钉在光标旁；滚动/重绘由对应事件直接丢弃
    const showGhost = () => {
      if (!ghost) return;
      const coords = view.coordsAtPos(view.state.selection.main.head);
      if (!coords) {
        hideGhost();
        return;
      }
      if (!el) {
        el = document.createElement('span');
        el.className = 'ghost-text';
        document.body.appendChild(el);
      }
      el.textContent = ghost;
      el.style.left = `${coords.left}px`;
      el.style.top = `${coords.top}px`;
    };

    const requestGhost = async () => {
      if (!ghostEnabledRef.current || composing || inflight) return;
      const sel = view.state.selection.main;
      if (!sel.empty) return;
      const docText = view.state.doc.toString();
      if (docText.length <= 300) return;
      const tail = docText.slice(Math.max(0, sel.head - 500), sel.head);
      inflight = true;
      const controller = new AbortController();
      abort = controller;
      let acc = '';
      try {
        await streamChat(
          [
            { role: 'system', content: GHOST_SYSTEM },
            { role: 'user', content: tail },
          ],
          (t) => {
            acc += t;
            const g = pickGhost(acc, tail);
            if (g) {
              ghost = g;
              showGhost();
            }
          },
          controller.signal,
        );
        const g = pickGhost(acc, tail);
        if (g && !controller.signal.aborted && ghostEnabledRef.current) {
          ghost = g;
          showGhost();
        }
      } catch {
        // 静默失败：幽灵字只是建议，不该为它打扰写作
      } finally {
        inflight = false;
        abort = null;
      }
    };

    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void requestGhost();
      }, 1500);
    };

    ghostDocChangeRef.current = () => {
      abortGhost();
      schedule();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (ghost && e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const pos = view.state.selection.main.head;
        const text = ghost;
        hideGhost();
        view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
        return;
      }
      if (ghost || inflight) abortGhost();
    };
    const onCompositionStart = () => {
      composing = true;
      abortGhost();
    };
    const onCompositionEnd = () => {
      composing = false;
    };
    const onScroll = () => abortGhost();
    const onBlur = () => abortGhost();

    const dom = view.dom;
    dom.addEventListener('keydown', onKeyDown);
    dom.addEventListener('compositionstart', onCompositionStart);
    dom.addEventListener('compositionend', onCompositionEnd);
    view.scrollDOM.addEventListener('scroll', onScroll);
    dom.addEventListener('blur', onBlur, true); // blur 不冒泡，捕获阶段抓
    return () => {
      window.clearTimeout(timer);
      abortGhost();
      ghostDocChangeRef.current = () => {};
      dom.removeEventListener('keydown', onKeyDown);
      dom.removeEventListener('compositionstart', onCompositionStart);
      dom.removeEventListener('compositionend', onCompositionEnd);
      view.scrollDOM.removeEventListener('scroll', onScroll);
      dom.removeEventListener('blur', onBlur, true);
    };
  }, []);

  // 文档回灌（AI 插入/替换等外部修改）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value === current) return;
    const anchor = Math.min(view.state.selection.main.anchor, value.length);
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: { anchor },
      annotations: externalChange.of(true),
    });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setMarks.of(marks ?? []) });
  }, [marks]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setForbidden.of(forbidden ?? []) });
  }, [forbidden]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setFlavor.of(flavor ?? []) });
  }, [flavor]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setFrozen.of(freezeAt ?? null) });
  }, [freezeAt]);

  return <div className="editor-host" ref={hostRef} />;
}
