import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Trash2,
  Sparkles,
  Square,
  Copy,
  CornerDownRight,
  Replace,
  X,
  Plus,
  History,
  Download,
  RotateCcw,
  Eye,
  PenLine,
  Maximize2,
  Minimize2,
  PanelRight,
  Lock,
  LockOpen,
  Bookmark,
  ChevronUp,
  ChevronDown,
  Pencil,
  Gamepad2,
  Dices,
  GitCompare,
  BookOpen,
} from 'lucide-react';
import { marked } from 'marked';
// 仅类型引用：写成值引用会把整个 CodeMirror 拖回首屏包（见下方懒加载的 CodeEditor）
import type { EditorView } from '@codemirror/view';
import type { AIPublic, Chapter, Idea, MarkType, ObsidianConfig, Project, ProjectStatus, ProjectVersion } from '../types';
import { buildAiContext, buildFullText, countWords, rulesSuffix, uid } from '../util';
import { EFFECT_LABEL, activePool, combineCards, dropFromHand, litCheck, playCard, progress, resolveCard, type GachaCard, type GachaState, type UserCards } from '../gacha';
import { summarizeDeslop, type DeslopReport } from '../deslop';
import { LADDER_SCAFFOLD } from '../watchdog';
import { appendBlock, removeBlockFrom } from '../scenes';
import { diffStat, diffTexts } from '../version-diff';
import { buildVolumeFiles, displayVolumeName, splitByVolume } from '../volumes';
import { evaluate } from '../constraints';
import { useChapterWords } from '../useChapterWords';
import type { ObsidianSyncState } from '../useObsidianSync';
import { streamChat, type ChatMessage, type UsageInfo } from '../api';
import { AI_ACTIONS, buildMessages, buildRunContext, isJudged, type AiAction, type AiContext } from '../ai-prompt';
// CodeMirror 约占产物 519KB，只在真正进入写作时加载，首页/统计页不必为此付费
const CodeEditor = lazy(() => import('./CodeEditor'));
// 画布与图算法只在点开「牵线」时才要，别算进首屏
const GraphView = lazy(() => import('./GraphView'));
// 复盘栏连带琴键、对白天平、伏笔利息与关系图：只在点开「复盘」时才要，别让它进首屏
const ReviewPanel = lazy(() => import('./ReviewPanel'));
// 场景板只在点开「场景」时才要（切块纯函数被上面的搬章用到，本来就在首屏包里）
const SceneBoard = lazy(() => import('./SceneBoard'));
import OutlinePanel from './OutlinePanel';
import ProjectDrawer, { type DrawerTab } from './ProjectDrawer';
import RichText from './RichText';

const STATUSES: ProjectStatus[] = ['构思', '大纲', '写作中', '已完成', '已发布'];
const TYPE_OPTIONS = ['小说', '剧本', '故事', '文章', '文案', '随笔', '其他'];

// 多文件下载时逐个之间的间隔：浏览器一次只认一个 <a download>，连点会被当成同一个下载丢掉。
// 打成一个压缩包当然更省事，但那就要引第三方 zip 库——本项目不新增运行时依赖。
const VOLUME_DOWNLOAD_GAP_MS = 400;

function AiContextCard({ ctx }: { ctx: AiContext }) {
  const kindLabel =
    ctx.kind === 'tail' ? '正文末尾'
    : ctx.kind === 'head' ? '正文开头'
    : ctx.kind === 'chapter' ? '整章正文'
    : '当前选区';
  const snippetLen = ctx.snippet.length;
  const range = ctx.range;
  const pct = ctx.fullLen > 0 ? Math.round((snippetLen / ctx.fullLen) * 100) : 0;
  const rangeText = range
    ? `第 ${range[0] + 1}–${range[1]} 字 / 共 ${ctx.fullLen} 字`
    : `全文为空`;
  // snippet 太长时展示首尾各一段、中间用省略号交代，省得撑爆右侧栏
  const preview =
    snippetLen > 600
      ? ctx.snippet.slice(0, 400) +
        `\n\n⋯⋯（中略，共 ${snippetLen} 字）⋯⋯\n\n` +
        ctx.snippet.slice(-150)
      : ctx.snippet;
  return (
    <details className="ai-ctx">
      <summary>
        <span className="ai-ctx-key">送入 AI 的</span>
        <span className="ai-ctx-val">
          {kindLabel} {snippetLen} 字{pct > 0 ? `（${pct}%）` : ''}
          {ctx.chapterTitle ? ` · 章节《${ctx.chapterTitle}》` : ''}
        </span>
        <span className="ai-ctx-range">{rangeText}</span>
      </summary>
      <pre className="ai-ctx-snippet">{preview || '（正文为空）'}</pre>
    </details>
  );
}

const MARK_TYPES: MarkType[] = ['伏笔', '彩蛋', '人物', '场景', '碎片'];

// 视口断点：Electron 和浏览器都有 matchMedia；SSR（组件测试里 renderToString）没有，当作宽屏
function useNarrow(max: number) {
  const q = '(max-width: ' + (max - 1) + 'px)';
  const [hit, setHit] = useState(() => (typeof matchMedia === 'function' ? matchMedia(q).matches : false));
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(q);
    const on = () => setHit(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return hit;
}

// 浮层的退场动画：React 一卸载元素就没了，CSS 无从过渡——所以晚一点再卸，中途挂 leaving 类
function useLeaveMount(open: boolean, ms = 170) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    const t = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(t);
  }, [open, mounted, ms]);
  return { mounted, leaving: !open && mounted };
}

interface Props {
  project: Project;
  ideas: Idea[];
  obsidian: ObsidianConfig;
  onUpdate: (id: string, patch: Partial<Project>, opts?: { snapshot?: boolean }) => void;
  onRestoreVersion: (id: string, version: ProjectVersion) => void;
  onUpdateChapter: (id: string, chapterId: string, patch: Partial<Chapter>, opts?: { snapshot?: boolean }) => void;
  onAddChapter: (id: string, title?: string, summary?: string) => void;
  onDeleteChapter: (id: string, chapterId: string) => void;
  onMoveChapter: (id: string, chapterId: string, dir: -1 | 1) => void;
  onRestoreChapterVersion: (id: string, chapterId: string, version: ProjectVersion) => void;
  onDelete: (id: string) => void;
  onBack: () => void;
  aiInfo: AIPublic;
  onOpenSettings: () => void;
  gacha: GachaState;
  cards: UserCards;
  onGacha: (next: GachaState) => void;
  onCards: (next: UserCards) => void; // 复盘栏把欠得最多的伏笔掉成收线卡时要能改池子
  onOpenGacha: () => void;
  onAddRule: (rule: { name: string; content: string }) => string; // 返回一句回执（如顶掉了哪条早期规则）
  todayWords: number;
  /** 同步的显示与入口；计时与待判定状态住在 App 层（useObsidianSync），切页不丢 */
  obsSync: ObsidianSyncState;
}

interface AiRunState {
  action: AiAction;
  title?: string; // 覆盖结果区标题（打出卡牌时显示卡名）
  text: string;
  running: boolean;
  error?: string;
  gacha?: boolean;
  slots?: string[];
  active?: number;
  usage?: UsageInfo;
  // 送入 AI 的文本范围（让用户看清续写/分析到底接在哪段上）
  context?: AiContext;
}


export default function WritingView({
  project,
  ideas,
  obsidian,
  onUpdate,
  onRestoreVersion,
  onUpdateChapter,
  onAddChapter,
  onDeleteChapter,
  onMoveChapter,
  onRestoreChapterVersion,
  onDelete,
  onBack,
  aiInfo,
  onOpenSettings,
  gacha,
  cards,
  onGacha,
  onCards,
  onOpenGacha,
  onAddRule,
  todayWords,
  obsSync,
}: Props) {
  const isChapter = project.mode === 'chapters';
  const chapters = project.chapters ?? [];

  const [activeId, setActiveId] = useState<string | null>(null);
  const [sel, setSel] = useState({ start: 0, end: 0 });
  const [ai, setAi] = useState<AiRunState | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [diffFor, setDiffFor] = useState<ProjectVersion | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null); // 只读对照的另一章 id；null = 收起
  const [previewOn, setPreviewOn] = useState(false);
  const [focusOn, setFocusOn] = useState(false);
  const [gachaOn, setGachaOn] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 窄窗口放不下「章节栏 + 正文 + 工坊 + 抽屉」四块：正文优先，工坊退成图标竖栏
  const narrow = useNarrow(1440);
  const [railOpen, setRailOpen] = useState(false);
  const railMount = useLeaveMount(railOpen);
  const drawerMount = useLeaveMount(drawerOpen);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('伏笔');
  const [mode, setMode] = useState<'write' | 'scenes' | 'outline' | 'graph' | 'review'>('write');
  const [flavorOn, setFlavorOn] = useState(() => localStorage.getItem('ww-flavor') !== 'off');
  const [flavor, setFlavor] = useState<DeslopReport | null>(null);
  const [flavorOpen, setFlavorOpen] = useState(false);
  const [selMenu, setSelMenu] = useState<{ x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const cmViewRef = useRef<EditorView | null>(null);
  const cursorRef = useRef(0);
  const activeIdRef = useRef<string | null>(null);
  const pendingJumpRef = useRef<number | null>(null);
  const projectIdRef = useRef(project.id);
  projectIdRef.current = project.id;
  activeIdRef.current = activeId;

  // 章节模式：默认选中断点所在章或第一章
  useEffect(() => {
    if (!isChapter) return;
    if (activeId && chapters.some((c) => c.id === activeId)) return;
    const bpChapter = project.breakpoint?.chapterId;
    setActiveId(chapters.find((c) => c.id === bpChapter)?.id ?? chapters[0]?.id ?? null);
  }, [isChapter, chapters, activeId, project.breakpoint]);

  // 退出写作现场时保存断点（光标 + 所在章节）
  useEffect(() => {
    return () => {
      onUpdateRef.current(projectIdRef.current, {
        breakpoint: { cursor: cursorRef.current, chapterId: isChapter ? activeIdRef.current ?? undefined : undefined, at: new Date().toISOString() },
      });
    };
  }, []);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  // 专注模式 + Esc（退出专注/关闭抽屉与浮层菜单）
  useEffect(() => {
    document.body.classList.toggle('focus-mode', focusOn);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFocusOn(false);
        setDrawerOpen(false);
        setRailOpen(false);
        setSelMenu(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.classList.remove('focus-mode');
      window.removeEventListener('keydown', onKey);
    };
  }, [focusOn]);

  // 窄窗口的工坊面板是浮在正文上的：Esc 之外，点它外面任意处就收回——不然它会一直压着字
  useEffect(() => {
    if (!narrow || !railOpen) return;
    const onDown = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('.ai-rail') || t.closest('.ai-strip'))) return;
      setRailOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [narrow, railOpen]);

  const chapter = chapters.find((c) => c.id === activeId) ?? null;
  const doc = isChapter ? (chapter?.content ?? '') : project.draft;
  // 每章字数增量缓存：编辑器每键只重扫当前章正文，其余章命中缓存（500 章下避免逐键全量扫书）
  const wordsMap = useChapterWords(chapters);
  // 当前正文喂给 App 层的同步计时器：切去灵感库/统计后 WritingView 卸载，计时照常走完
  useEffect(() => {
    obsSync.touchDoc(project.id, doc);
  }, [doc, project.id, obsSync.touchDoc]);
  const patchDoc = (content: string, opts?: { snapshot?: boolean }) => {
    if (isChapter && chapter) onUpdateChapter(project.id, chapter.id, { content }, opts);
    else onUpdate(project.id, { draft: content }, opts);
  };

  // AI 味自检：防抖扫描当前章。整本百万字实测 35ms、单章 0.1ms，防抖只为超长单文档也不卡手
  useEffect(() => {
    localStorage.setItem('ww-flavor', flavorOn ? 'on' : 'off');
  }, [flavorOn]);
  useEffect(() => {
    if (!flavorOn) {
      setFlavor(null);
      return;
    }
    const t = setTimeout(() => setFlavor(summarizeDeslop(doc)), 250);
    return () => clearTimeout(t);
  }, [doc, flavorOn]);
  const flavorRanges = useMemo(() => (flavor?.hits ?? []).map((h) => ({ start: h.start, end: h.end })), [flavor]);
  const aiFlavor = useMemo(
    () => (ai && !ai.running && ai.text ? summarizeDeslop(ai.text) : null),
    [ai?.running, ai?.text],
  );

  const marks = (project.marks ?? []).filter((m) => (isChapter ? m.chapterId === activeId : !m.chapterId));
  const forbidden = project.game?.forbidden ?? [];
  const allMarks = project.marks ?? [];
  const openForeshadows = allMarks.filter((m) => m.type === '伏笔' && m.status !== '回收').length;
  const orphaned = allMarks.filter((m) => m.orphaned).length;
  const drawerBadge = openForeshadows + orphaned;
  const versions = isChapter ? (chapter?.versions ?? []) : (project.versions ?? []);
  // 版本对比：拿选中的快照和当前编辑器正文比，随正文实时重算；纯函数在 src/version-diff.ts
  const diffSpans = useMemo(() => (diffFor ? diffTexts(diffFor.text, doc) : []), [diffFor, doc]);
  const diffStatInfo = useMemo(() => diffStat(diffSpans), [diffSpans]);
  const freezeAt = isChapter ? (chapter?.freezeAt ?? null) : (project.freezeAt ?? null);

  // 复盘栏的守夜人还在吃内置境界表时，给一个把体系写下来的落点：建一张设定卡，不猜内容
  const addLadderCard = () => {
    const list = project.worldItems ?? [];
    if (list.some((w) => w.kind === '力量体系')) return '这本书已经有力量体系词条了：把里面的境界按高低排成一行、用 → 分隔，守夜人就认得。';
    onUpdate(project.id, { worldItems: [...list, { id: uid(), ...LADDER_SCAFFOLD }] }, { snapshot: false });
    return '已建一张「力量体系」设定卡：把里面那串境界换成你自己那套（用 → 分隔），下一趟同步与 AI 上下文就用你的线。';
  };

  // 场景板要把整块搬去别章：那边只接正文，拼接走纯函数（appendBlock），别在组件里手搓字符串
  const sceneTargets = isChapter
    ? chapters.filter((c) => c.id !== activeId).map((c) => ({ id: c.id, title: `第${chapters.indexOf(c) + 1}章 ${c.title || '未命名'}` }))
    : [];
  const moveBlockTo = (id: string, block: string) => {
    const t = chapters.find((c) => c.id === id);
    if (!t) return;
    onUpdateChapter(project.id, id, { content: appendBlock(t.content ?? '', block) }, { snapshot: true });
  };
  // 「退回」跨章那一步时，别章也得把这块取回来——只回滚一半会把同一段留在两章里
  const moveBlockBack = (id: string, block: string) => {
    const t = chapters.find((c) => c.id === id);
    if (!t) return;
    onUpdateChapter(project.id, id, { content: removeBlockFrom(t.content ?? '', block) }, { snapshot: false });
  };

  const jumpToNow = (pos: number) => {
    const view = cmViewRef.current;
    if (!view) return;
    setPreviewOn(false);
    const safe = Math.min(pos, view.state.doc.length);
    // 自己算居中滚动，避免为了 EditorView.scrollIntoView 这个静态方法引入整个 CodeMirror
    const coords = view.coordsAtPos(safe);
    if (coords) {
      const box = view.scrollDOM.getBoundingClientRect();
      view.scrollDOM.scrollTop += coords.top - box.top - box.height / 2;
    }
    view.dispatch({ selection: { anchor: safe } });
    view.focus();
  };

  const jumpTo = (pos: number, chapterId?: string) => {
    if (chapterId && chapterId !== activeId) {
      pendingJumpRef.current = pos;
      setActiveId(chapterId);
    } else {
      jumpToNow(pos);
    }
  };

  // 切章后待跳转的光标（等正文回灌完成；用 ref 存放避免 effect 重跑清掉定时器）
  useEffect(() => {
    if (pendingJumpRef.current == null) return;
    const p = pendingJumpRef.current;
    pendingJumpRef.current = null;
    const t1 = setTimeout(() => jumpToNow(p), 120);
    const t2 = setTimeout(() => jumpToNow(p), 400);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [activeId]);

  const insertAtCursor = (text: string) => {
    if (!text) return;
    const pos = Math.min(sel.end, doc.length);
    patchDoc(doc.slice(0, pos) + text + doc.slice(pos), { snapshot: true });
  };

  const addMark = (type: MarkType) => {
    const text = doc.slice(sel.start, sel.end);
    if (!text.trim()) return;
    const mark = {
      id: uid(),
      type,
      start: sel.start,
      end: sel.end,
      text,
      chapterId: isChapter ? activeId ?? undefined : undefined,
      createdAt: new Date().toISOString(),
    };
    onUpdate(project.id, { marks: [...allMarks, mark] });
    setSelMenu(null);
  };

  const toggleFreeze = () => {
    const pos = sel.start > 0 ? sel.start : doc.length;
    if (isChapter && chapter) {
      onUpdateChapter(project.id, chapter.id, { freezeAt: chapter.freezeAt != null ? undefined : pos });
    } else {
      onUpdate(project.id, { freezeAt: project.freezeAt != null ? undefined : pos });
    }
  };

  // 三路并行出签：抽卡模式与「打出 R 卡」共用这一条
  const stream3 = async (messages: ChatMessage[], title: string, ctx: AiContext) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setAi({ action: 'continue', title, text: '', running: true, gacha: true, slots: ['', '', ''], active: 0, context: ctx });
    const one = (i: number) =>
      streamChat(messages, (t) => setAi((s) => s && { ...s, slots: (s.slots ?? ['', '', '']).map((x, j) => (j === i ? x + t : x)) }), controller.signal).catch(
        (e: Error) => setAi((s) => s && { ...s, slots: (s.slots ?? ['', '', '']).map((x, j) => (j === i ? x || `（生成失败：${e.message}）` : x)) }),
      );
    await Promise.all([one(0), one(1), one(2)]);
    setAi((s) => s && { ...s, running: false });
  };

  const run = async (action: AiAction) => {
    // 从图标竖栏点出来的动作，结果要落在面板里——顺手把面板浮出来（窄窗口一次只浮一个）
    setRailOpen(true);
    setDrawerOpen(false);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const selectionText = doc.slice(sel.start, sel.end);
    const messages = buildMessages(action, project, selectionText, aiInfo.rules, chapter, aiInfo.judgeOnly === true);
    // 算出"本次送进 AI 的具体范围"，结果区头部展示给用户看
    const ctx = buildRunContext(action, doc, sel, chapter?.title);
    if (gachaOn) {
      await stream3(messages, AI_ACTIONS.find((a) => a.key === action)?.label ?? '', ctx);
      return;
    }
    setAi({ action, text: '', running: true, context: ctx });
    try {
      await streamChat(messages, (t) => setAi((s) => s && { ...s, text: s.text + t }), controller.signal, (u) =>
        setAi((s) => s && { ...s, usage: u }),
      );
      setAi((s) => s && { ...s, running: false });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError') setAi((s) => s && { ...s, running: false });
      else setAi((s) => s && { ...s, running: false, error: e.message });
    }
  };

  const stop = () => abortRef.current?.abort();
  const adoptSlot = (i: number) => setAi((s) => s && { ...s, active: i, text: s.slots?.[i] ?? '' });

  const insertEnd = () => {
    if (!ai?.text) return;
    patchDoc(doc + (doc ? '\n\n' : '') + ai.text, { snapshot: true });
  };

  const replaceSel = () => {
    if (!ai?.text) return;
    patchDoc(doc.slice(0, sel.start) + ai.text + doc.slice(sel.end), { snapshot: true });
  };

  const copyResult = async () => {
    if (ai?.text) await navigator.clipboard.writeText(ai.text);
  };

  const useAsTitle = () => {
    if (!ai?.text) return;
    const firstLine = ai.text.split('\n').find((l) => l.trim());
    if (!firstLine) return;
    if (isChapter && chapter) onUpdateChapter(project.id, chapter.id, { title: firstLine.replace(/^[\d.、\s《》]+/, '').trim() });
    else onUpdate(project.id, { title: firstLine.replace(/^[\d.、\s《》]+/, '').trim() });
  };

  const toNotes = () => {
    if (!ai?.text) return;
    onUpdate(project.id, { notes: project.notes ? `${project.notes}\n\n${ai.text}` : ai.text });
  };

  // ---------- 在手卡牌：打出即真的改到数据（章节要点/伏笔/出场名单/禁用词/规则/后续章） ----------
  const pool = useMemo(() => activePool(cards), [cards]);
  const hand = useMemo(
    () => (gacha.hand ?? []).map((id) => pool.find((c) => c.id === id)).filter((c): c is GachaCard => Boolean(c)),
    [gacha.hand, pool],
  );
  const gachaRef = useRef(gacha);
  gachaRef.current = gacha;
  const [handMsg, setHandMsg] = useState('');

  // 打过但还没达成的卡：从 applied/lit 推导，重开这本书也照样提醒，并实时算达成率
  const ongoing = useMemo(() => {
    const open = Object.entries(gacha.applied ?? {})
      .filter(([id]) => !gacha.lit[id] && pool.some((c) => c.id === id))
      .map(([id, at]) => ({ card: pool.find((c) => c.id === id)!, at }))
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, 3);
    return open.map((o) => ({ ...o, report: progress(o.card, doc) }));
  }, [gacha.applied, gacha.lit, pool, doc]);

  // 写到位的那一刻自动点亮（防抖，避免每键都改账本）
  useEffect(() => {
    const done = ongoing.filter((o) => o.report.done);
    if (!done.length) return;
    const t = setTimeout(() => {
      const cur = gachaRef.current;
      const lit = { ...cur.lit };
      for (const o of done) if (!lit[o.card.id]) lit[o.card.id] = new Date().toISOString();
      const next = { ...cur, lit };
      gachaRef.current = next;
      onGacha(next);
      setHandMsg(`「${done[done.length - 1].card.name}」达成，图鉴已点亮。`);
    }, 700);
    return () => clearTimeout(t);
  }, [ongoing, onGacha]);

  // 两张在手卡并成一个本章任务：不消耗卡、不给抽，达成才白送一次奖励抽
  const combo = project.combo ?? null;
  const comboReport = useMemo(() => (combo && !combo.litAt ? evaluate(doc, combo.constraints) : null), [combo, doc]);

  const makeCombo = () => {
    if (hand.length < 2) return;
    const c = combineCards(hand[0], hand[1], project, chapter);
    onUpdate(project.id, { combo: { ...c, createdAt: new Date().toISOString() } });
    setHandMsg(`立成本章任务「${c.name}」${c.yielded.length ? '（' + c.yielded.join('；') + '）' : ''}，写到位送一次抽。`);
  };

  const dropCombo = () => {
    onUpdate(project.id, { combo: undefined });
    setHandMsg('放下了这个组合任务，两张卡还在手上。');
  };

  useEffect(() => {
    if (!combo || combo.litAt || !comboReport?.done) return;
    const t = setTimeout(() => {
      onUpdate(project.id, { combo: { ...combo, litAt: new Date().toISOString() } });
      const cur = gachaRef.current;
      const next = { ...cur, bonusPulls: (cur.bonusPulls ?? 0) + 1 };
      gachaRef.current = next;
      onGacha(next);
      setHandMsg(`「${combo.name}」达成，白送一次抽。`);
    }, 700);
    return () => clearTimeout(t);
  }, [combo, comboReport, onGacha, onUpdate, project.id]);

  const play = (card: GachaCard) => {
    const res = resolveCard(card, project, chapter);
    const out = playCard(res, project, chapter);
    if (out.projectPatch) onUpdate(project.id, out.projectPatch);
    if (out.chapterPatch && chapter) onUpdateChapter(project.id, chapter.id, out.chapterPatch);
    if (out.chapterPatches?.length) {
      const map = new Map(out.chapterPatches.map((p) => [p.id, p.patch]));
      onUpdate(project.id, { chapters: (project.chapters ?? []).map((c) => (map.has(c.id) ? { ...c, ...map.get(c.id)! } : c)) });
    }
    const ruleNote = out.rule ? onAddRule(out.rule) : '';
    const cur = gachaRef.current;
    const at = new Date().toISOString();
    const lit = litCheck(card, doc);
    const applied = { ...cur.applied, [card.id]: at };
    const litMap = lit.ok ? { ...cur.lit, [card.id]: at } : cur.lit;
    const next = { ...dropFromHand(cur, card.id), applied, lit: litMap };
    gachaRef.current = next;
    onGacha(next);
    setHandMsg(`${out.note}${lit.ok ? ' 已点亮。' : ` 还差一步才算点亮：${lit.why}`}${ruleNote ? ' ' + ruleNote : ''}`);
    if (out.task) {
      const context = buildAiContext(project, chapter?.id);
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            `你是一位专业的中文写作助手，正在协助创作者完成${project.type}《${project.title}》。遵守「辅助而不替代」：给方向、给备选，不替作者定稿；只输出正文可用的段落，不要解释。` +
            context +
            rulesSuffix(aiInfo.rules),
        },
        { role: 'user', content: `${out.task}\n\n当前正文结尾（可接可不接）：\n"""${doc.slice(-1200)}"""` },
      ];
      void stream3(messages, '卡·' + card.name, buildRunContext('continue', doc, sel, chapter?.title));
    }
  };

  const linked = ideas.filter((i) => project.linkedIdeaIds.includes(i.id));  const unlinked = ideas.filter((i) => !project.linkedIdeaIds.includes(i.id));
  const linkIdea = (id: string) => onUpdate(project.id, { linkedIdeaIds: [...project.linkedIdeaIds, id] });
  const unlinkIdea = (id: string) => onUpdate(project.id, { linkedIdeaIds: project.linkedIdeaIds.filter((x) => x !== id) });

  const remove = () => {
    if (confirm(`确定删除《${project.title}》？可在回收站恢复。`)) onDelete(project.id);
  };

  const restore = (v: ProjectVersion) => {
    if (confirm(`回滚到 ${v.at}（${v.words} 字）？当前内容会先自动存为快照。`)) {
      if (isChapter && chapter) onRestoreChapterVersion(project.id, chapter.id, v);
      else onRestoreVersion(project.id, v);
    }
  };

  // 按连续相同卷名分卷，供导出插入卷标题
  const volumeOf = (c: { volume?: string }, i: number, arr: { volume?: string }[]) =>
    i === 0 || (c.volume ?? '') !== (arr[i - 1].volume ?? '') ? (c.volume ?? '') : null;

  // 本书现在能分成几卷：给「分卷导出」按钮算标题说明与是否真值得拆。只取卷名不拼正文——
  // 拼全文会跟着每一次按键重算，改一个字就把整本书重扫一遍
  const volumeSlices = useMemo(() => splitByVolume(project.chapters ?? []), [project.chapters]);

  const downloadFull = (annotated = false, fmt: 'md' | 'txt' = 'md') => {
    const isTxt = fmt === 'txt';
    let body = buildFullText(project);
    if (isChapter) {
      // 章节模式：逐章拼装，卷名变化时插入卷标题
      const cs = project.chapters ?? [];
      body = cs
        .map((c, i) => {
          let t = c.content;
          if (annotated) {
            const ce = allMarks
              .filter((m) => m.type === '彩蛋' && !m.orphaned && m.chapterId === c.id)
              .sort((a, b) => b.start - a.start);
            for (const m of ce) t = t.slice(0, m.end) + `〔彩蛋：${m.note || '无注释'}〕` + t.slice(m.end);
          }
          const vol = volumeOf(c, i, cs);
          const volHead = vol ? (isTxt ? `${vol}\r\n\r\n` : `# ${vol}\n\n`) : '';
          const head = isTxt ? `第${i + 1}章 ${c.title}` : `## 第${i + 1}章 ${c.title}`;
          return `${volHead}${head}\n\n${t}`;
        })
        .join(isTxt ? '\r\n\r\n' : '\n\n');
    } else if (annotated) {
      let t = project.draft;
      const ce = allMarks.filter((m) => m.type === '彩蛋' && !m.orphaned).sort((a, b) => b.start - a.start);
      for (const m of ce) t = t.slice(0, m.end) + `〔彩蛋：${m.note || '无注释'}〕` + t.slice(m.end);
      body = t;
    }
    const name = (project.title || '未命名').replace(/[\\/:*?"<>|]/g, '_');
    const text = isTxt
      ? `${project.title || '未命名'}${annotated ? '（带彩蛋注释阅读版）' : ''}\r\n\r\n${body}`
      : `# ${project.title || '未命名'}${annotated ? '（带彩蛋注释阅读版）' : ''}\n\n${body}`;
    const blob = new Blob([text], { type: isTxt ? 'text/plain;charset=utf-8' : 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}${annotated ? '-annotated' : ''}.${fmt}`;
    a.click();
    URL.revokeObjectURL(url);
    obsSync.setSyncMsg(
      annotated
        ? '已导出带注释阅读版'
        : isTxt
          ? '已导出 TXT 分章版（Windows 换行，可直接投稿/手机阅读）'
          : '已导出 Markdown（含卷/章标题，内部标记自动清除）',
    );
  };

  // 按卷分文件导出：一卷一个「<书名>-<卷名>.md/.txt」，逐个触发下载（间隔见 VOLUME_DOWNLOAD_GAP_MS）。
  // 切分与拼装的判据全在 volumes.ts，这里只负责把结果送去磁盘
  const downloadByVolume = (fmt: 'md' | 'txt') => {
    const files = buildVolumeFiles({ title: project.title, chapters: project.chapters, marks: allMarks, fmt });
    // 不足两卷（含单文档模式）时不硬凑成一个莫名其妙的分卷文件：直接走既有的单文件导出
    if (files.length <= 1) {
      downloadFull(false, fmt);
      return;
    }
    files.forEach((f, i) => {
      setTimeout(() => {
        const blob = new Blob([f.text], { type: fmt === 'txt' ? 'text/plain;charset=utf-8' : 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = f.name;
        a.click();
        // 下一个文件的 URL 还没开始下载就回收上一个，容易把连下载打断：留一拍再收
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }, i * VOLUME_DOWNLOAD_GAP_MS);
    });
    obsSync.setSyncMsg(`已按卷导出 ${files.length} 个文件：${files.map((f) => f.name).join("、")}`);
  };

  // 当前章字数（章节模式取缓存；单文档模式正文即全文）
  const docWords = isChapter ? (chapter ? (wordsMap.get(chapter.id) ?? 0) : 0) : countWords(doc);
  // 全书正文字数：目标完成度用正文口径（不含「第N章」标题），且走增量缓存而非每次拼接全量
  const totalWords = isChapter ? [...wordsMap.values()].reduce((a, b) => a + b, 0) : docWords;

  return (
    <>
      <header className="view-head writer-head">
        <button className="icon-btn back-btn" onClick={onBack} title="返回项目列表">
          <ArrowLeft size={18} />
        </button>
        {isChapter && <span className="proj-crumb" title={project.title}>{project.title}</span>}
        <input
          className="title-input"
          value={isChapter ? (chapter?.title ?? '') : project.title}
          onChange={(e) => {
            const v = e.target.value;
            if (isChapter && chapter) onUpdateChapter(project.id, chapter.id, { title: v });
            else onUpdate(project.id, { title: v });
          }}
          placeholder={isChapter ? '本章标题' : '未命名'}
        />
        <div className="mode-seg">
          <button className={mode === 'write' ? 'on' : ''} onClick={() => setMode('write')}>
            写作
          </button>
          <button className={mode === 'scenes' ? 'on' : ''} onClick={() => setMode('scenes')} title="把本章按空行切成场景块：拖着重排顺序，或整块搬去下一章">
            场景
          </button>
          <button className={mode === 'outline' ? 'on' : ''} onClick={() => setMode('outline')}>
            大纲
          </button>
          <button className={mode === 'graph' ? 'on' : ''} onClick={() => setMode('graph')} title="把章、人物、伏笔牵成一张因果网，再沿网取用上下文">
            牵线
          </button>
          <button className={mode === 'review' ? 'on' : ''} onClick={() => setMode('review')}>
            复盘
          </button>
        </div>
        {obsidian.vaultPath && (
          <>
            {obsSync.syncMsg && <span className={'sync-msg' + (obsSync.syncMsg.startsWith('失败') ? ' error' : '')}>{obsSync.syncMsg}</span>}
            <button className="btn small" onClick={obsSync.sync} title="把这部作品同步为 Markdown 到 Obsidian 库">
              同步
            </button>
          </>
        )}
        <button
          className={'btn small drawer-btn' + (drawerOpen ? ' on' : '')}
          onClick={() => {
            setDrawerOpen((v) => !v);
            setRailOpen(false); // 窄窗口两个浮层不叠着开，稿纸才留得住
            setMode('write');
          }}
          title="伏笔 / 碎片 / 人物 / 设定 / 彩蛋 / 分支 / 禁用词 / 取名（Esc 收起）"
        >
          <PanelRight size={13} /> 素材抽屉
          {drawerBadge > 0 && <em className="btn-badge">{drawerBadge}</em>}
        </button>
        <button className="icon-btn" onClick={() => setPreviewOn((v) => !v)} title={previewOn ? '返回编辑' : '预览 Markdown 渲染效果'}>
          {previewOn ? <PenLine size={16} /> : <Eye size={16} />}
        </button>
        <button className="icon-btn" onClick={() => setFocusOn((v) => !v)} title={focusOn ? '退出专注模式（Esc）' : '专注模式：隐藏界面杂音'}>
          {focusOn ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button
          className="icon-btn"
          onClick={toggleFreeze}
          title={freezeAt != null ? '解除冻结：恢复全文可编辑' : '冻结修改：锁定光标之前的正文，只能向下续写'}
        >
          {freezeAt != null ? <Lock size={16} /> : <LockOpen size={16} />}
        </button>
        <button className="icon-btn" onClick={remove} title="删除项目">
          <Trash2 size={16} />
        </button>
      </header>
      <div className="writer-meta">
        <label className="meta-field">
          状态
          <select value={project.status} onChange={(e) => onUpdate(project.id, { status: e.target.value as ProjectStatus })}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="meta-field">
          类型
          <input value={project.type} onChange={(e) => onUpdate(project.id, { type: e.target.value })} list="writer-types" />
          <datalist id="writer-types">
            {TYPE_OPTIONS.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <label className="meta-field">
          截稿
          <input type="date" value={project.deadline} onChange={(e) => onUpdate(project.id, { deadline: e.target.value })} />
        </label>
        <label className="meta-field">
          目标字数
          <input
            type="number"
            min={0}
            step={500}
            value={project.target || ''}
            onChange={(e) => onUpdate(project.id, { target: Math.max(0, Number(e.target.value) || 0) })}
            placeholder="0"
          />
        </label>
        <label className="meta-field grow">
          备注
          <input
            value={project.notes}
            onChange={(e) => onUpdate(project.id, { notes: e.target.value })}
            placeholder="选题理由、风格要求、素材线索…"
          />
        </label>
        {freezeAt != null && (
          <span className="frozen-badge">
            <Lock size={11} /> 冻结中 · 第 {freezeAt} 字之前只读
          </span>
        )}
      </div>

      <div className="hand-strip">
        <span className="hs-label">
          <Dices size={13} /> 在手
        </span>
        {hand.length === 0 && (
          <span className="hs-empty">
            没有手牌。
            <button className="mini-btn" onClick={onOpenGacha}>
              去卡池抽一张
            </button>
          </span>
        )}
        {hand.map((c) => (
          <span key={c.id} className={'hs-card r-' + c.rarity}>
            <b>{c.name}</b>
            <em>{c.rarity}</em>
            <span className="hs-text" title={c.payload}>
              {resolveCard(c, project, chapter).text}
            </span>
            <button className="hs-play" onClick={() => play(c)} title={EFFECT_LABEL[c.effect] ?? '打出这张卡'}>
              打出
            </button>
            <button
              className="icon-btn"
              onClick={() => {
                const next = dropFromHand(gachaRef.current, c.id);
                gachaRef.current = next;
                onGacha(next);
              }}
              title="丢掉（回到图鉴，可再从「上手」拿回来）"
            >
              <X size={11} />
            </button>
          </span>
        ))}
        {hand.length >= 2 &&
          (combo ? (
            <span className={'hs-card hs-combo' + (combo.litAt || comboReport?.done ? ' done' : '')} title={combo.task}>
              <b>合 · {combo.name}</b>
              <em>{comboReport ? comboReport.passed + '/' + comboReport.total : '已达成'}</em>
              <span className="hs-text">{combo.litAt ? '奖励已发' : (comboReport?.items.find((i) => !i.ok)?.label ?? '写到位送一次抽')}</span>
              <button className="icon-btn" onClick={dropCombo} title="放下组合任务（两张卡仍留在手上）">
                <X size={11} />
              </button>
            </span>
          ) : (
            <button className="hs-combo-btn" onClick={makeCombo} title="把最左边两张在手卡并成一个本章任务，达成送一次抽">
              合成两卡
            </button>
          ))}
        {ongoing.map((o) => (
          <span key={o.card.id} className={'hs-card hs-ongoing' + (o.report.done ? ' done' : '')} title={o.report.items.map((i) => (i.ok ? '✓ ' : '○ ') + i.label + '｜' + i.detail).join('  ')}>
            <b>{o.card.name}</b>
            <em>
              {o.report.passed}/{o.report.total}
            </em>
            <span className="hs-text">{o.report.items.find((i) => !i.ok)?.label ?? '已达成，正在记账'}</span>
            <button
              className="icon-btn"
              onClick={() => {
                const cur = gachaRef.current;
                const applied = { ...cur.applied };
                delete applied[o.card.id];
                const next = { ...cur, applied };
                gachaRef.current = next;
                onGacha(next);
                setHandMsg(`放下了「${o.card.id ? o.card.name : ''}」的达成要求，卡退回图鉴，不再追着提醒。`);
              }}
              title="放弃这条要求（卡仍算已抽到）"
            >
              <X size={11} />
            </button>
          </span>
        ))}
        {handMsg && <span className="hs-msg">{handMsg}</span>}
      </div>

      <div className={'writer' + (mode === 'review' || mode === 'graph' || mode === 'scenes' ? ' review-mode' : '')}>
        {isChapter && (mode === 'write' || mode === 'scenes') && (
          <aside className="chap-side">
            <div className="chap-side-head">
              <span>章节（{chapters.length}）</span>
              <button className="icon-btn" title="新建章节" onClick={() => onAddChapter(project.id)}>
                <Plus size={14} />
              </button>
            </div>
            <div className="chap-list">
              {chapters.map((c, i) => (
                <div
                  key={c.id}
                  className={'chap-item' + (c.id === activeId ? ' on' : '')}
                  onClick={() => setActiveId(c.id)}
                >
                  {renamingId === c.id ? (
                    <input
                      className="chap-rename"
                      value={renameText}
                      autoFocus
                      onChange={(e) => setRenameText(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={() => {
                        onUpdateChapter(project.id, c.id, { title: renameText.trim() || c.title });
                        setRenamingId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                      }}
                    />
                  ) : (
                    <>
                      <span className="chap-idx">{i + 1}</span>
                      <span className="chap-title" title={c.summary || c.title}>
                        {c.title || '未命名'}
                      </span>
                      <span className="chap-words">{wordsMap.get(c.id) ?? 0}</span>
                    </>
                  )}
                  {c.id === activeId && renamingId !== c.id && (
                    <span className="chap-ops" onClick={(e) => e.stopPropagation()}>
                      <button title="上移" onClick={() => onMoveChapter(project.id, c.id, -1)}>
                        <ChevronUp size={12} />
                      </button>
                      <button title="下移" onClick={() => onMoveChapter(project.id, c.id, 1)}>
                        <ChevronDown size={12} />
                      </button>
                      <button
                        title="重命名"
                        onClick={() => {
                          setRenamingId(c.id);
                          setRenameText(c.title);
                        }}
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        title="删除章节"
                        onClick={() => {
                          if (confirm(`删除「${c.title}」？本章正文与快照将一并删除。`)) {
                            onDeleteChapter(project.id, c.id);
                            if (activeId === c.id) setActiveId(null);
                          }
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>
            {chapter?.summary && <div className="chap-summary">{chapter.summary}</div>}
          </aside>
        )}

        <div className="writer-main">
          {mode === 'graph' ? (
            <Suspense fallback={<div className="view-loading">画布载入中…</div>}>
              <GraphView project={project} onUpdate={onUpdate} onOpenChapter={(id) => { setActiveId(id); setMode('write'); }} />
            </Suspense>
          ) : mode === 'review' ? (
            <Suspense fallback={<div className="view-loading">复盘栏载入中…</div>}>
              <ReviewPanel project={project} text={buildFullText(project)} cards={cards} onCards={onCards} onOpenGacha={onOpenGacha} onAddLadder={addLadderCard} />
            </Suspense>
          ) : mode === 'scenes' ? (
            <Suspense fallback={<div className="view-loading">场景板载入中…</div>}>
              {/* key 按章：撤销栈是「这一章的栈」，换章不重挂就会把上一章的中间态倒进来 */}
              <SceneBoard
                key={activeId ?? project.id}
                text={doc}
                onText={(next) => patchDoc(next, { snapshot: true })}
                targets={sceneTargets}
                onMoveOut={moveBlockTo}
                onMoveBack={moveBlockBack}
                note={isChapter ? undefined : '这是单篇草稿，没有「下一章」可搬，这里只能重排顺序；要切出更多块，先用空行把场景分开。'}
              />
            </Suspense>
          ) : mode === 'outline' ? (
            <OutlinePanel project={project} aiInfo={aiInfo} onUpdate={onUpdate} onUpdateChapter={onUpdateChapter} onAddChapter={onAddChapter} />
          ) : (
            <>
              <div className="paper">
                {previewOn ? (
                  <div
                    className="md-body preview"
                    dangerouslySetInnerHTML={{ __html: marked.parse(doc || '*（正文为空）*') as string }}
                  />
                ) : (
                  <Suspense fallback={<div className="editor-loading">编辑器加载中…</div>}>
                    <CodeEditor
                      key={project.id + (activeId ?? '')}
                      value={doc}
                      placeholderText={isChapter && chapter ? `开始写「${chapter.title}」…` : `开始写《${project.title}》…`}
                      marks={marks}
                      forbidden={forbidden}
                      flavor={flavorRanges}
                      freezeAt={freezeAt}
                      initialCursor={isChapter ? undefined : project.breakpoint?.cursor}
                      onChange={(v) => patchDoc(v)}
                      onSelectionChange={(from, to, view) => {
                        setSel({ start: from, end: to });
                        cursorRef.current = from;
                        if (to > from) {
                          const coords = view.coordsAtPos(from);
                          const rect = view.dom.getBoundingClientRect();
                          setSelMenu(coords ? { x: coords.left - rect.left, y: coords.bottom - rect.top } : null);
                        } else {
                          setSelMenu(null);
                        }
                      }}
                      onReady={(view) => {
                        cmViewRef.current = view;
                      }}
                    />
                    {selMenu && (
                      <div className="sel-menu" style={{ left: selMenu.x, top: selMenu.y + 6 }}>
                        <span className="sel-menu-label">标记为</span>
                        {MARK_TYPES.map((t) => (
                          <button key={t} onClick={() => addMark(t)}>
                            {t}
                          </button>
                        ))}
                        <button className="sel-menu-close" title="关闭" onClick={() => setSelMenu(null)}>
                          <X size={11} />
                        </button>
                      </div>
                    )}
                  </Suspense>
                )}
              </div>
              <div className="writer-foot">
                <span>
                  {docWords} 字
                  {project.target ? ` / 目标 ${Math.min(Math.round((totalWords / project.target) * 100), 100)}%` : ''}
                  {todayWords > 0 && ` · 今日 +${todayWords}`}
                </span>
                <span className="foot-actions">
                  <button
                    className={'mini-btn' + (flavorOpen ? ' on' : '') + (flavorOn && (flavor?.hits.length ?? 0) > 0 ? ' hit' : '')}
                    onClick={() => {
                      if (!flavorOn) setFlavorOn(true);
                      setFlavorOpen((v) => !v);
                    }}
                    title={flavorOn ? 'AI 味自检：模板句式命中处（只提醒，不动你的正文）' : '重新开启 AI 味自检'}
                  >
                    <Sparkles size={13} /> {flavorOn ? `AI 味（${flavor?.hits.length ?? 0}）` : 'AI 味自检·已关'}
                  </button>
                  <button className="mini-btn" onClick={() => { setVersionsOpen((v) => !v); setDiffFor(null); }} title="历史版本快照，可回滚">
                    <History size={13} /> 历史版本（{versions.length}）
                  </button>
                  {isChapter && (
                    <button
                      className={'mini-btn' + (compareId ? ' on' : '')}
                      onClick={() => setCompareId((v) => (v ? null : (project.chapters ?? []).find((c) => c.id !== chapter?.id)?.id ?? null))}
                      title="开一个只读小窗对照另一章：写闪回、伏笔呼应、对齐细节时不用来回翻页"
                    >
                      <BookOpen size={13} /> 对照
                    </button>
                  )}
                  <button
                    className="mini-btn"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(buildFullText(project));
                        obsSync.setSyncMsg('全文已复制到剪贴板');
                      } catch {
                        obsSync.setSyncMsg('复制失败：浏览器未授权剪贴板');
                      }
                    }}
                    title="复制全文到剪贴板"
                  >
                    <Copy size={13} /> 复制全文
                  </button>
                  <button className="mini-btn" onClick={() => downloadFull(false)} title="下载为 .md 文件（含卷/章标题）">
                    <Download size={13} /> 导出 .md
                  </button>
                  <button className="mini-btn" onClick={() => downloadFull(false, 'txt')} title="下载为 .txt 分章版，适合投稿或手机阅读">
                    <Download size={13} /> 导出 .txt
                  </button>
                  {isChapter && volumeSlices.length > 1 && (
                    <>
                      <button
                        className="mini-btn"
                        onClick={() => downloadByVolume('md')}
                        title={`按卷拆成 ${volumeSlices.length} 个 .md 文件：${volumeSlices.map((s) => displayVolumeName(s.volume)).join('、')}`}
                      >
                        <Download size={13} /> 分卷 .md
                      </button>
                      <button
                        className="mini-btn"
                        onClick={() => downloadByVolume('txt')}
                        title={`按卷拆成 ${volumeSlices.length} 个 .txt 文件：${volumeSlices.map((s) => displayVolumeName(s.volume)).join('、')}（Windows 换行）`}
                      >
                        <Download size={13} /> 分卷 .txt
                      </button>
                    </>
                  )}
                  <span>自动保存已开启</span>
                </span>
              </div>

              {flavorOn && flavorOpen && flavor && (
                <div className="flavor-panel">
                  <div className="versions-head">
                    <h4>
                      AI 味自检 · 本章 {flavor.hits.length} 处（{flavor.per1k} 处/千字）
                    </h4>
                    <span className="foot-actions">
                      <button
                        className="mini-btn"
                        onClick={() => {
                          setFlavorOn(false);
                          setFlavorOpen(false);
                        }}
                        title="关掉后编辑区不再画虚线，点底部按钮随时恢复"
                      >
                        写作时不再提醒
                      </button>
                      <button className="mini-btn" onClick={() => setFlavorOpen(false)}>
                        <X size={12} /> 收起
                      </button>
                    </span>
                  </div>
                  {flavor.hits.length === 0 && <p className="hint">这一章没命中模板句式。命中处会在正文里画细虚线，不改一个字。</p>}
                  {flavor.groups.map((g) => (
                    <div key={g.key} className="flavor-grp">
                      <span className="flavor-lv" title={`毒级 ${g.level}/5`}>
                        {'★'.repeat(g.level - 1)}
                      </span>
                      <b>{g.label}</b>
                      <em>×{g.count}</em>
                      <span className="flavor-fix">{g.fix}</span>
                    </div>
                  ))}
                  {flavor.hits.length > 0 && (
                    <div className="flavor-hits">
                      {flavor.hits.slice(0, 12).map((h, i) => (
                        <button key={`${h.start}-${i}`} className="flavor-hit" onClick={() => jumpToNow(h.start)} title="跳到正文此处">
                          <span className="flavor-hit-key">{h.label}</span>
                          <span className="flavor-hit-text">{h.text}</span>
                        </button>
                      ))}
                      {flavor.hits.length > 12 && <p className="hint">另有 {flavor.hits.length - 12} 处未列出，正文里已画虚线。</p>}
                    </div>
                  )}
                </div>
              )}

              {compareId && isChapter && (() => {
                const target = (project.chapters ?? []).find((c) => c.id === compareId);
                const options = (project.chapters ?? []).filter((c) => c.id !== chapter?.id);
                return (
                  <div className="versions-panel compare-panel">
                    <div className="versions-head">
                      <h4>对照 · 只读</h4>
                      <span className="foot-actions">
                        <select className="tl-input" value={compareId} onChange={(e) => setCompareId(e.target.value)}>
                          {options.map((c, i) => (
                            <option key={c.id} value={c.id}>
                              第{i + 1}章 {c.title}
                            </option>
                          ))}
                        </select>
                        <button className="mini-btn" onClick={() => setCompareId(null)}>
                          <X size={12} /> 收起
                        </button>
                      </span>
                    </div>
                    <div className="compare-body">{target?.content || '（这一章还没有正文）'}</div>
                  </div>
                );
              })()}

              {versionsOpen && (
                <div className="versions-panel">
                  <div className="versions-head">
                    <h4>历史版本（最多保留 20 份{isChapter ? ' · 按章保存' : ''}）</h4>
                    <button className="mini-btn" onClick={() => { setVersionsOpen(false); setDiffFor(null); }}>
                      <X size={12} /> 收起
                    </button>
                  </div>
                  {diffFor && (
                    <div className="version-diff">
                      <div className="version-diff-head">
                        <h4>与当前正文对比</h4>
                        <span className="version-diff-meta">
                          {diffFor.at} · <span className="vd-del-stat">−{diffStatInfo.del} 字</span>·<span className="vd-ins-stat">＋{diffStatInfo.ins} 字</span>
                        </span>
                        <button className="mini-btn" title="把这一版全文复制出来，随便粘去哪" onClick={() => void navigator.clipboard.writeText(diffFor.text)}>
                          <Copy size={12} /> 复制这版全文
                        </button>
                        <button className="mini-btn" onClick={() => setDiffFor(null)}>
                          <X size={12} /> 收起对比
                        </button>
                      </div>
                      <p className="hint">红底删除线＝这一版有、现在没有；绿底＝这一版没有、现在新写。被删的内容可以选中复制走。</p>
                      <div className="version-diff-body">
                        {diffSpans.map((s, i) => (
                          <span key={i} className={'vd-' + s.t}>{s.text}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {versions.length === 0 && <p className="hint">还没有快照。每天首次编辑正文、以及 AI 改写前，都会自动保存一份；也可随时从这里回滚。</p>}
                  {[...versions].reverse().map((v, idx) => (
                    <div key={v.at + idx} className="version-row">
                      <span className="version-at">{v.at}</span>
                      <span className="version-words">{v.words} 字</span>
                      <span className="version-preview">{v.text.slice(0, 42) || '（空）'}</span>
                      <button className="mini-btn" title="与当前正文对比：找回被删的段落、看清这版改了哪" onClick={() => setDiffFor(diffFor?.at === v.at ? null : v)}>
                        <GitCompare size={12} /> 对比
                      </button>
                      <button className="mini-btn" onClick={() => restore(v)}>
                        <RotateCcw size={12} /> 回滚到此
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* 窄窗口：工坊收成右侧一条图标竖栏，点一个字就跑动作；完整面板浮出来，不占正文宽度 */}
        {mode === 'write' && narrow && !railMount.mounted && (
          <aside className="ai-strip">
            {aiInfo.ready &&
              AI_ACTIONS.map((a) => (
                <button
                  key={a.key}
                  className={'ai-strip-btn' + (a.game ? ' game' : '')}
                  title={a.label + '：' + (isJudged(a.key, aiInfo.judgeOnly) ? '「只判不写」开着——这条只给判断与方向，不产出正文' : a.hint)}
                  disabled={ai?.running || (a.needSelection && sel.end - sel.start === 0)}
                  onClick={() => run(a.key)}
                >
                  {a.label.slice(0, 1)}
                </button>
              ))}
            <button
              className="ai-strip-btn expand"
              title="展开 AI 工坊面板"
              onClick={() => {
                setRailOpen(true);
                setDrawerOpen(false);
              }}
            >
              <PanelRight size={14} />
            </button>
          </aside>
        )}

        {mode === 'write' && (!narrow || railMount.mounted) && (
          <aside className={'ai-rail' + (narrow ? ' floating' : '') + (narrow && railMount.leaving ? ' leaving' : '')}>
            <h3>
              <Sparkles size={16} /> AI 工坊
              <button
                className={'chip gacha-chip' + (gachaOn ? ' on' : '')}
                title="开启后每次生成 3 个方案并排对比，点选采纳"
                onClick={() => setGachaOn((v) => !v)}
              >
                抽卡{gachaOn ? '开' : '关'}
              </button>
              {narrow && (
                <button className="icon-btn rail-close" title="收起工坊面板，回到图标竖栏" onClick={() => setRailOpen(false)}>
                  <X size={14} />
                </button>
              )}
            </h3>

            {!aiInfo.ready ? (
              <div className="ai-empty">
                <p>配置模型服务后，这里可以帮你续写、润色，也能做联想、感官检视、视角校验等「只给方向不给成品」的分析。AI 会自动携带作品设定、人物与前情。</p>
                <button className="btn" onClick={onOpenSettings}>
                  去设置
                </button>
              </div>
            ) : (
              <>
                <div className="acts-sec">
                  <div className="acts-label">
                    <PenLine size={12} /> 创作与打磨（小说用）
                    {aiInfo.judgeOnly === true && <span className="pitch-meta">只判不写：续写 / 润色 / 扩写 改成给判断</span>}
                  </div>
                  <div className="ai-actions">
                    {AI_ACTIONS.filter((a) => !a.game).map((a) => (
                      <button
                        key={a.key}
                        className="ai-act"
                        title={isJudged(a.key, aiInfo.judgeOnly) ? '「只判不写」开着：这条只给判断、方向与代价，不产出可以粘进稿子的正文（设置里可关）' : a.hint}
                        disabled={ai?.running || (a.needSelection && sel.end - sel.start === 0)}
                        onClick={() => run(a.key)}
                      >
                        {a.label}
                        {isJudged(a.key, aiInfo.judgeOnly) ? '（判）' : ''}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="acts-sec game">
                  <div className="acts-label game">
                    <Gamepad2 size={13} /> 游戏脚本改编（做游戏用）
                  </div>
                  <p className="acts-desc">把本章正文改写成游戏可直接使用的脚本格式，输出与小说正文不同、不会插回章节。</p>
                  <div className="ai-actions game-acts">
                    {AI_ACTIONS.filter((a) => a.game).map((a) => (
                      <button
                        key={a.key}
                        className="ai-act"
                        title={isJudged(a.key, aiInfo.judgeOnly) ? '「只判不写」开着：这条只给判断、方向与代价，不产出可以粘进稿子的正文（设置里可关）' : a.hint}
                        disabled={ai?.running || (a.needSelection && sel.end - sel.start === 0)}
                        onClick={() => run(a.key)}
                      >
                        {a.label}
                        {isJudged(a.key, aiInfo.judgeOnly) ? '（判）' : ''}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="sel-hint">{sel.end - sel.start > 0 ? `已选中 ${sel.end - sel.start} 字` : '未选中文字（分析类动作需先选中）'}</div>

                {ai && (
                  <div className="ai-result-wrap">
                    <div className="ai-result-head">
                      <span>
                        {ai.title ? (
                          <span className="game-badge">
                            <Dices size={12} /> {ai.title}
                          </span>
                        ) : AI_ACTIONS.find((a) => a.key === ai.action)?.game ? (
                          <span className="game-badge">
                            <Gamepad2 size={12} /> 游戏脚本 · {AI_ACTIONS.find((a) => a.key === ai.action)?.label}
                          </span>
                        ) : (
                          AI_ACTIONS.find((a) => a.key === ai.action)?.label
                        )}
                        结果{ai.gacha ? '（三选一，点卡片采纳）' : ''}
                      </span>
                      {ai.running ? (
                        <button className="mini-btn" onClick={stop}>
                          <Square size={12} /> 停止
                        </button>
                      ) : (
                        <button className="mini-btn" onClick={() => setAi(null)}>
                          <X size={12} /> 关闭
                        </button>
                      )}
                    </div>
                    {ai.context && ai.context.kind !== 'none' && (
                      <AiContextCard ctx={ai.context} />
                    )}
                    {ai.error ? (
                      <div className="ai-error">调用失败：{ai.error}</div>
                    ) : ai.gacha ? (
                      <div className="gacha-wrap">
                        {(ai.slots ?? ['', '', '']).map((slot, i) => (
                          <button key={i} className={'gacha-card' + (ai.active === i ? ' on' : '')} onClick={() => adoptSlot(i)}>
                            <span className="gacha-head">
                              方案 {i + 1}
                              {ai.active === i && <em>已采纳</em>}
                            </span>
                            <span className={'gacha-body' + (ai.running ? ' cursor-blink' : '')}>
                              <RichText text={slot} />
                              {!slot && ai.running && '生成中…'}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className={'ai-result' + (ai.running ? ' cursor-blink' : '')}>
                        <RichText text={ai.text} />
                        {ai.running && !ai.text && '正在思考…'}
                      </div>
                    )}
                    {!ai.running && !ai.error && ai.text && (
                      <div className="ai-btns">
                        {ai.action === 'title' && (
                          <button className="btn small" onClick={useAsTitle}>
                            用作标题
                          </button>
                        )}
                        {ai.action === 'outline' && (
                          <button className="btn small" onClick={toNotes}>
                            写入备注
                          </button>
                        )}
                        {!isJudged(ai.action, aiInfo.judgeOnly) && (ai.action === 'continue' || ai.action === 'expand') && (
                          <button className="btn small" onClick={insertEnd}>
                            <CornerDownRight size={13} /> 插入文末
                          </button>
                        )}
                        {!isJudged(ai.action, aiInfo.judgeOnly) && (ai.action === 'polish' || ai.action === 'expand') && (
                          <button className="btn small" onClick={replaceSel}>
                            <Replace size={13} /> 替换所选
                          </button>
                        )}
                        {isJudged(ai.action, aiInfo.judgeOnly) && (
                          <span className="hint">只判不写：这段是判断，不给「插进正文」的入口——正文得你自己写。要代写就去设置里关掉。</span>
                        )}
                        <button className="btn small" onClick={copyResult}>
                          <Copy size={13} /> 复制
                        </button>
                      </div>
                    )}
                    {!ai.running && aiFlavor && aiFlavor.hits.length > 0 && (
                      <div className="hint" style={{ marginTop: 4 }}>
                        这段的 AI 味：{aiFlavor.hits.length} 处（{aiFlavor.per1k} 处/千字），最毒「{aiFlavor.groups[0].label}」×{aiFlavor.groups[0].count} —— {aiFlavor.groups[0].fix}
                      </div>
                    )}
                    {!ai.running && ai.usage && ai.usage.total > 0 && (
                      <div className="hint" style={{ marginTop: 6 }}>
                        缓存命中 {Math.round((ai.usage.hit / ai.usage.total) * 100)}%（{ai.usage.hit}/{ai.usage.total} tokens）
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
            <div className="link-sec">
              <h4>
                <Bookmark size={13} /> 关联素材（{linked.length}）
              </h4>
              {linked.length === 0 && <p className="hint">从灵感库关联素材，也可在抽屉「碎片」页查看与插入。</p>}
              {linked.map((i) => (
                <div key={i.id} className="link-item">
                  <span>{i.content.length > 80 ? i.content.slice(0, 80) + '…' : i.content}</span>
                  <span className="link-ops">
                    <button className="icon-btn" title="取消关联" onClick={() => unlinkIdea(i.id)}>
                      <X size={12} />
                    </button>
                  </span>
                </div>
              ))}
              {unlinked.length > 0 && (
                <button className="mini-btn add-link" onClick={() => linkIdea(unlinked[0].id)} title={unlinked[0].content.slice(0, 30)}>
                  <Plus size={12} /> 关联最新灵感
                </button>
              )}
            </div>
          </aside>
        )}

        {obsSync.syncConflicts.length > 0 && (
          <div className="sync-conflicts">
            <h4>
              {obsSync.syncConflicts.length} 处两边都改过
              <button className="mini-btn" onClick={obsSync.dismissConflicts}>
                先不管
              </button>
            </h4>
            <p className="hint">我不替你决定哪版算数——逐条选，选完立刻再同步一次。</p>
            {obsSync.syncConflicts.map((c) => (
              <div className={'sc-row' + (obsSync.pendingResolve[c.rel] ? ' done' : '')} key={c.rel}>
                <span className="sc-name" title={c.rel}>
                  {c.rel.split('/').pop()}
                </span>
                <button className={'mini-btn' + (obsSync.pendingResolve[c.rel] === 'app' ? ' on' : '')} onClick={() => obsSync.decide(c.rel, 'app')}>
                  用工作台这版
                </button>
                <button className={'mini-btn' + (obsSync.pendingResolve[c.rel] === 'vault' ? ' on' : '')} onClick={() => obsSync.decide(c.rel, 'vault')}>
                  用 Obsidian 那版
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 窄窗口抽屉是浮层，垫一层底：看得见「它在上面」，点空白处就收 */}
        {narrow && drawerMount.mounted && mode === 'write' && (
          <div className={'drawer-scrim' + (drawerMount.leaving ? ' leaving' : '')} onClick={() => setDrawerOpen(false)} />
        )}
        {(narrow ? drawerMount.mounted : drawerOpen) && mode === 'write' && (
          <ProjectDrawer
            leaving={narrow && drawerMount.leaving}
            project={project}
            ideas={ideas}
            aiInfo={aiInfo}
            tab={drawerTab}
            onTab={setDrawerTab}
            onClose={() => setDrawerOpen(false)}
            onUpdate={onUpdate}
            onJump={jumpTo}
            onInsert={insertAtCursor}
          />
        )}
      </div>
    </>
  );
}
