import { useCallback, useMemo, useRef, useState } from 'react';
import { Sparkles, Square, Eye, Check, Trash2, Copy, Layers, BookOpen, ChevronDown, ChevronRight, Undo2 } from 'lucide-react';
import type { AIPublic, Chapter, ChatMessage as DiscussMsg, Project } from '../types';
import { buildAiContext, chapterBriefLine, countWords, localStamp, rulesSuffix, uid } from '../util';
import { streamChat, askText, type UsageInfo } from '../api';
import { buildDraftMessages } from '../ai-prompt';
import { analyzeHealth } from '../health';
import { gateSummary, hasGatework, preflight, quotaGap, type GateReport } from '../gate';
import { applyMemories, buildExtractMessages, extractJson, sanitizeMemories } from '../memory';
import { useChapterWords } from '../useChapterWords';
import RichText from './RichText';
import OutlineCard from './OutlineCard';
import TimelineView from './TimelineView';
import type { OutlineOps } from './OutlineCard';
import HealthCard from './HealthCard';

interface Props {
  project: Project;
  aiInfo: AIPublic;
  onUpdate: (id: string, patch: Partial<Project>) => void;
  onUpdateChapter: (id: string, chapterId: string, patch: Partial<Chapter>, opts?: { snapshot?: boolean }) => void;
  onAddChapter: (id: string, title?: string, summary?: string) => void;
}

type OutlineItem = Pick<Chapter, 'title' | 'beats' | 'cast' | 'places' | 'hooks'>;

// 从 AI 返回文本里解析章节大纲 JSON；容忍 markdown 代码块包裹
function parseOutline(raw: string): OutlineItem[] | null {
  const s = raw.indexOf('[');
  const e = raw.lastIndexOf(']');
  if (s < 0 || e <= s) return null;
  try {
    const arr = JSON.parse(raw.slice(s, e + 1)) as unknown;
    if (!Array.isArray(arr)) return null;
    const items = arr
      .filter((x) => x && typeof (x as OutlineItem).title === 'string')
      .map((x) => {
        const o = x as OutlineItem;
        return { title: o.title.trim(), beats: (o.beats ?? '').trim(), cast: (o.cast ?? '').trim(), places: (o.places ?? '').trim(), hooks: (o.hooks ?? '').trim() };
      })
      .filter((o) => o.title);
    return items.length ? items : null;
  } catch {
    return null;
  }
}

// ---------- 时间线推断 ----------
export default function OutlinePanel({ project, aiInfo, onUpdate, onUpdateChapter, onAddChapter }: Props) {
  const chapters = project.chapters ?? [];
  const projectRef = useRef(project);
  projectRef.current = project;
  const aiInfoRef = useRef(aiInfo);
  aiInfoRef.current = aiInfo;
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  // 出场记忆抽取串行队列：多章连续采纳时按触发顺序逐个抽取，避免并发写回互相覆盖
  const extractTailRef = useRef<Promise<void>>(Promise.resolve());

  const [genCount, setGenCount] = useState('10');
  const [genRunning, setGenRunning] = useState(false);
  const [genMsg, setGenMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [batchWords, setBatchWords] = useState(1000);
  const batchWordsRef = useRef(batchWords);
  batchWordsRef.current = batchWords;
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState<{ running: boolean; currentId: string | null; ok: string[]; fail: string[]; usage: UsageInfo } | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [sumId, setSumId] = useState<string | null>(null);
  // 批量生成前置门禁：null=没拦住；非空=正等作者决定怎么处理
  const [gate, setGate] = useState<GateReport | null>(null);
  // 采纳后的字数欠账，记在章上（换章采纳会自动挪走）
  const [debt, setDebt] = useState<{ id: string; words: number; pct: number; target: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [view, setView] = useState<'outline' | 'timeline'>('outline');
  const [discussId, setDiscussId] = useState<string | null>(null);

  // ---------- 全书梗概（滚动摘要）----------
  const [arcBusy, setArcBusy] = useState(false);
  const [arcMsg, setArcMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [arcOpen, setArcOpen] = useState(false);
  const [arcPrev, setArcPrev] = useState<{ upTo: number; text: string } | null>(null); // 覆盖前的旧值，供一键撤销
  const arcAbortRef = useRef<AbortController | null>(null);

  const patch = useCallback((c: Chapter, p: Partial<Chapter>, opts?: { snapshot?: boolean }) => onUpdateChapter(project.id, c.id, p, opts), [project.id, onUpdateChapter]);

  // 健康度：全由作品数据纯函数算出，实时反映正文/草稿/梗概/伏笔状态。
  // 字数走增量缓存（wordsMap），大纲字段每键编辑时不再全量扫整本书正文。
  const wordsMap = useChapterWords(chapters);
  const health = useMemo(() => analyzeHealth(project, (c) => wordsMap.get(c.id) ?? countWords(c.content ?? '')), [project, wordsMap]);

  // 全局章号查表：渲染 500 章时避免每张卡 chapters.indexOf(c) 的 O(n²) 扫描
  const idxById = useMemo(() => new Map(chapters.map((c, i) => [c.id, i])), [chapters]);

  // 分卷：按「连续相同卷名」分组。改卷名即改文字，不引入卷实体；改中间某章的卷即可拆卷
  const groups = useMemo(() => {
    const out: { key: string; name: string; items: Chapter[] }[] = [];
    chapters.forEach((c, idx) => {
      const name = c.volume ?? '';
      const last = out[out.length - 1];
      if (last && last.name === name) last.items.push(c);
      else out.push({ key: `${idx}#${name}`, name, items: [c] });
    });
    return out;
  }, [chapters]);

  const renameVolume = (key: string, to: string) => {
    const g = groups.find((x) => x.key === key);
    if (!g) return;
    const ids = new Set(g.items.map((c) => c.id));
    onUpdate(project.id, { chapters: chapters.map((c) => (ids.has(c.id) ? { ...c, volume: to } : c)) });
  };

  // 卷名候选：给「所属卷」输入框的 datalist 用（每张卡共享同一份，放在外层一次）
  const volumeOptions = useMemo(() => [...new Set(chapters.map((x) => x.volume).filter(Boolean))], [chapters]);

  const arc = project.rollingSummary;

  // ---------- AI 生成章节大纲 ----------
  const genOutline = async () => {
    const n = Math.max(1, Math.min(60, Number(genCount) || 10));
    const abort = new AbortController();
    abortRef.current = abort;
    setGenRunning(true);
    setGenMsg(null);
    try {
      const p = projectRef.current;
      const list = p.chapters ?? [];
      const exist = list.length
        ? '【已有章节大纲（请顺着续拟，不要重复）】\n' + list.map((c, i) => `第${i + 1}章 ${c.title}${chapterBriefLine(c)}`).join('\n')
        : '';
      const system =
        `你是专业的长篇${p.type}大纲策划。只输出 JSON 数组，不要解释，不要 markdown 代码块标记。` +
        `数组元素格式：{"title":"章节名","beats":"本章剧情要点，60字内","cast":"出场人物，顿号分隔","places":"出场地点","hooks":"本章要埋或推进的伏笔"}。` +
        rulesSuffix(aiInfo.rules);
      const user = [`为长篇${p.type}《${p.title}》规划接下来的 ${n} 章章节大纲。`, p.notes ? `作品设定与备注：${p.notes.slice(0, 800)}` : '', exist, '剧情要有因果推进与钩子，伏笔安排要有埋设与回收的节奏。只输出 JSON 数组。']
        .filter(Boolean)
        .join('\n\n');
      let raw = '';
      await streamChat(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        (t) => (raw += t),
        abort.signal,
      );
      const items = parseOutline(raw);
      if (!items) {
        setGenMsg({ ok: false, text: 'AI 返回的内容无法解析为大纲 JSON，请重试或换模型。' });
        return;
      }
      const now = new Date().toISOString();
      const next: Chapter[] = items.map((o) => ({ id: uid(), title: o.title, content: '', beats: o.beats, cast: o.cast, places: o.places, hooks: o.hooks, createdAt: now, updatedAt: now }));
      onUpdate(p.id, { chapters: [...list, ...next], mode: 'chapters' });
      setGenMsg({ ok: true, text: `已追加 ${items.length} 章大纲（现共 ${list.length + items.length} 章）。` });
    } catch (e) {
      const err = e as Error;
      if (err.name !== 'AbortError') setGenMsg({ ok: false, text: '生成失败：' + err.message });
    } finally {
      setGenRunning(false);
    }
  };

  // ---------- 全书梗概（滚动摘要）----------
  // 长篇写到几十章后，远古章节只靠这份压缩梗概进入 AI 上下文，避免「只记得最近 20 章」
  const genArc = async () => {
    const p = projectRef.current;
    const list = p.chapters ?? [];
    const prev = p.rollingSummary;
    // 只归并到「倒数第 3 章」之前：最近几章由前情的近场层完整携带，不必重复压进摘要
    const last = list.reduce((acc, c, i) => ((c.summary ?? '').trim() || (c.content ?? '').trim() ? i : acc), -1);
    const target = Math.min(last + 1, Math.max(0, list.length - 3));
    if (target < 1) {
      setArcMsg({ ok: false, text: '还没有已写章节或章节梗概，先写几章再来生成。' });
      return;
    }
    if (prev && prev.upTo >= target) {
      setArcMsg({ ok: false, text: `全书梗概已覆盖到第 ${prev.upTo} 章，暂无新增内容可并入。` });
      return;
    }
    const from = prev ? Math.min(prev.upTo, target) : 0;
    const fresh = list
      .slice(from, target)
      .map((c, i) => {
        const g = (c.summary ?? '').trim() || (c.content ?? '').replace(/\s+/g, ' ').slice(0, 120);
        return `第${from + i + 1}章 ${c.title}：${g || '（无梗概）'}`;
      })
      .join('\n');
    const system =
      `你是长篇${p.type}《${p.title}》的连续性编辑，负责维护一份「全书至今梗概」，供后续章节创作时保持剧情连贯。` +
      (p.notes ? `\n\n【作品设定】\n${p.notes.slice(0, 400)}` : '') +
      rulesSuffix(aiInfo.rules);
    const user =
      (prev ? `【既有梗概（第 1–${prev.upTo} 章）】\n${prev.text}\n\n` : '') +
      `【本次需要并入的章节梗概（第 ${from + 1}–${target} 章）】\n${fresh}\n\n` +
      `请把以上内容合并成一份覆盖第 1–${target} 章的「全书至今梗概」，要求：\n` +
      `1. 控制在 700 字以内，按时间顺序写成连续段落，不要分条列点；\n` +
      `2. 保留关键转折、人物关系变化、战力或境界进展，以及尚未解决的悬念；\n` +
      `3. 保留具体专有名词（人名、地名、势力、功法、物品），不要泛化成「某人」「某地」；\n` +
      `4. 只输出梗概正文，不要标题、不要解释。`;
    const abort = new AbortController();
    arcAbortRef.current = abort;
    setArcBusy(true);
    setArcMsg(null);
    try {
      let text = '';
      await streamChat(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        (t) => (text += t),
        abort.signal,
      );
      const clean = text.trim();
      if (!clean) throw new Error('AI 返回内容为空');
      setArcPrev(prev ? { upTo: prev.upTo, text: prev.text } : null);
      onUpdate(p.id, { rollingSummary: { upTo: target, text: clean, at: localStamp() } });
      setArcMsg({ ok: true, text: `已更新全书梗概，覆盖第 1–${target} 章（${clean.length} 字）。` });
      setArcOpen(true);
    } catch (e) {
      const err = e as Error;
      if (err.name !== 'AbortError') setArcMsg({ ok: false, text: '生成失败：' + err.message });
    } finally {
      setArcBusy(false);
    }
  };

  // 撤销上一次覆盖：只在本次会话内有效（刷新后旧值不再保留）
  const undoArc = () => {
    if (!arcPrev) return;
    onUpdate(project.id, { rollingSummary: arcPrev });
    setArcPrev(null);
    setArcMsg({ ok: true, text: '已还原为上一版全书梗概。' });
  };

  // ---------- 章节草稿生成（单章 / 批量共用 src/ai-prompt 的同一份拼法） ----------

  const genOne = async (c: Chapter, words: number, signal: AbortSignal): Promise<{ text: string; usage?: UsageInfo }> => {
    let text = '';
    let usage: UsageInfo | undefined;
    await streamChat(
      buildDraftMessages(projectRef.current, c, words, aiInfo.rules),
      (t) => (text += t),
      signal,
      (u) => (usage = u),
    );
    return { text: text.trim(), usage };
  };

  // 批量生成：逐章顺序生成到 pending，等作者审核采纳，不直接进正文
  const runBatch = async (list: Chapter[]) => {
    if (!list.length) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setBatch({ running: true, currentId: list[0].id, ok: [], fail: [], usage: { hit: 0, total: 0 } });
    for (const c of list) {
      if (abort.signal.aborted) break;
      setBatch((b) => b && { ...b, currentId: c.id });
      try {
        const { text, usage } = await genOne(c, batchWords, abort.signal);
        if (!text) throw new Error('模型未返回内容');
        patch(c, { pending: text, summary: c.summary || text.slice(0, 120) });
        setBatch((b) => b && { ...b, ok: [...b.ok, c.id], usage: { hit: b.usage.hit + (usage?.hit ?? 0), total: b.usage.total + (usage?.total ?? 0) } });
      } catch (e) {
        const err = e as Error;
        if (err.name === 'AbortError' || abort.signal.aborted) break;
        setBatch((b) => b && { ...b, fail: [...b.fail, c.id] });
      }
    }
    setBatch((b) => b && { ...b, running: false, currentId: null });
  };

  // 生成前先过门禁：只拦批量（≥2 章），单章「让 AI 随意发挥一下」是正当用法。
  // 关掉开关（设置页「批量生成前查细纲」）后与从前完全一致。
  const pickedChapters = () => chapters.filter((c) => sel.has(c.id));
  const requestBatch = () => {
    const list = pickedChapters();
    if (!list.length) return;
    if (aiInfo.gateDraft === false || list.length < 2) return runBatch(list);
    const rep = preflight(chapters, list.map((c) => c.id), project);
    if (!hasGatework(rep)) return runBatch(list);
    setGate(rep);
  };
  const batchWith = (mode: 'all' | 'outlined') => {
    const rep = preflight(chapters, sel, project); // 面板挂着时作者可能顺手补了要点，按当下重算
    setGate(null);
    const thin = new Set(rep.thin.map((h) => h.id));
    runBatch(pickedChapters().filter((c) => mode === 'all' || !thin.has(c.id)));
  };
  const jumpToBeats = (id: string) => {
    const el = document.getElementById('ol-beats-' + id);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    (el as HTMLTextAreaElement).focus({ preventScroll: true });
  };

  const stopAll = () => {
    abortRef.current?.abort();
    setGenRunning(false);
    setBatch((b) => b && { ...b, running: false, currentId: null });
  };

  const copyOutline = async () => {
    const text = chapters.map((c, i) => `第${i + 1}章 ${c.title}${chapterBriefLine(c) ? '\n' + chapterBriefLine(c) : ''}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 剪贴板不可用时静默
    }
  };

  // 章节卡片操作集：全部稳定引用（useMemo 只依赖 patch 与 aiInfo，二者引用长期不变），
  // 使 OutlineCard 的 memo 浅比较在 500 章长书上每键编辑只重渲被编辑的那一张卡。
  // 可变中间态一律走 ref（batchWordsRef/projectRef/abortRef），杜绝闭包过期。
  const ops = useMemo<OutlineOps>(() => {
    return {
      patch,
      clearDebt: () => setDebt(null),
      toggleSel: (id) =>
        setSel((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        }),
      genDraft: async (c) => {
        const words = batchWordsRef.current;
        const abort = new AbortController();
        abortRef.current = abort;
        setBatch({ running: true, currentId: c.id, ok: [], fail: [], usage: { hit: 0, total: 0 } });
        try {
          let text = '';
          let usage: UsageInfo | undefined;
          await streamChat(buildDraftMessages(projectRef.current, c, words, aiInfo.rules), (t) => (text += t), abort.signal, (u) => (usage = u));
          const clean = text.trim();
          if (!clean) throw new Error('模型未返回内容');
          patch(c, { pending: clean, summary: c.summary || clean.slice(0, 120) });
          setBatch((b) => b && { ...b, ok: [...b.ok, c.id], usage: { hit: b.usage.hit + (usage?.hit ?? 0), total: b.usage.total + (usage?.total ?? 0) } });
        } catch (e) {
          const err = e as Error;
          if (err.name !== 'AbortError') setBatch((b) => b && { ...b, fail: [...b.fail, c.id] });
        } finally {
          setBatch((b) => b && { ...b, running: false, currentId: null });
        }
      },
      adopt: (c) => {
        if (!c.pending) return;
        const accepted = c.pending;
        patch(c, { content: accepted, pending: undefined }, { snapshot: true });
        const target = batchWordsRef.current;
        const gap = quotaGap(accepted, target);
        setDebt(gap ? { id: c.id, words: gap.words, pct: gap.pct, target } : null);
        // 出场记忆：采纳成文后异步抽取「谁出场、状态/战力/关系怎么变、有无新角色新设定」写回人物卡
        // 开关在设置页；任何失败都静默跳过，绝不打断采纳与写作
        if (aiInfoRef.current.memoryExtract !== false && accepted.trim().length >= 200) {
          const title = c.title || '未命名章节';
          const chapterId = c.id;
          extractTailRef.current = extractTailRef.current.then(async () => {
            try {
              const proj = projectRef.current;
              const msgs = buildExtractMessages(title, accepted, proj);
              const raw = await askText(msgs, 0.2);
              const known = (proj.characters ?? []).map((x) => x.name);
              const { memories } = sanitizeMemories(extractJson(raw), accepted, known);
              if (!memories.length) return;
              const merged = applyMemories(
                { characters: proj.characters ?? [], worldItems: proj.worldItems ?? [] },
                memories,
                chapterId,
              );
              if (merged.touched > 0) {
                onUpdateRef.current(proj.id, {
                  characters: merged.characters,
                  worldItems: merged.worldItems,
                });
              }
            } catch (err) {
              console.debug('[出场记忆] 本章抽取失败，已跳过（不影响正文）：', err);
            }
          });
        }
      },
      // AI 提炼本章摘要（覆盖自动截取的版本）
      refineSummary: async (c) => {
        const src = (c.content || c.pending || '').slice(0, 2400);
        if (!src.trim()) return;
        setSumId(c.id);
        try {
          let text = '';
          await streamChat(
            [
              { role: 'system', content: '你是中文网文编辑。只输出一句话剧情梗概，不超过 60 字，不要解释，不要引号。' + rulesSuffix(aiInfo.rules) },
              { role: 'user', content: `请概括以下章节内容：\n\n"""${src}"""` },
            ],
            (t) => (text += t),
          );
          const s = text.trim().replace(/^["「『]|["」』]$/g, '');
          if (s) patch(c, { summary: s });
        } catch {
          // 摘要失败不打断：保留自动截取版本
        } finally {
          setSumId(null);
        }
      },
      toggleDiscuss: (id) => setDiscussId((cur) => (cur === id ? null : id)),
      togglePreview: (id) => setPreviewId((cur) => (cur === id ? null : id)),
      // 章节剧情探讨：卡片内持有输入框，这里负责流式对话与落盘
      sendDiscuss: async (c, text) => {
        const p = projectRef.current;
        const history: DiscussMsg[] = [...(c.discuss ?? []), { role: 'user', content: text, at: localStamp() }];
        patch(c, { discuss: history }); // 先落用户消息
        try {
          let reply = '';
          await streamChat(
            [
              {
                role: 'system',
                content:
                  `你是长篇${p.type}《${p.title}》的剧情策划，正在和作者探讨「${c.title}」一章的剧情。只讨论、给方案与建议，不要输出正文。` +
                  '建议要具体：冲突怎么起、转折落在哪、伏笔怎么处理；作者没定论的地方给两个可选走向。' +
                  buildAiContext(p, c.id) +
                  rulesSuffix(aiInfo.rules),
              },
              ...history.map((m) => ({ role: m.role, content: m.content })),
            ],
            (t) => (reply += t),
          );
          const r = reply.trim();
          if (r) patch(c, { discuss: [...history, { role: 'assistant', content: r, at: localStamp() }] });
        } catch (e) {
          const err = e as Error;
          if (err.name !== 'AbortError') {
            patch(c, { discuss: [...history, { role: 'assistant', content: `（出错了：${err.message}）`, at: localStamp() }] });
          }
        }
      },
      // 把探讨结论提炼成「本章剧情要点」，返回文本由卡片展示确认
      draftBeats: async (c) => {
        const disc = (c.discuss ?? []).slice(-12);
        if (!disc.length) return null;
        try {
          let text = '';
          await streamChat(
            [
              { role: 'system', content: '你是剧情策划。根据探讨记录提炼「本章剧情要点」，80字内，只输出要点文本本身，不要解释，不要引号。' + rulesSuffix(aiInfo.rules) },
              {
                role: 'user',
                content: `本章：${c.title}\n当前要点：${c.beats || '（无）'}\n探讨记录：\n${disc
                  .map((m) => (m.role === 'user' ? '作者：' : '策划：') + m.content)
                  .join('\n')}`,
              },
            ],
            (t) => (text += t),
          );
          const s = text.trim().replace(/^["「『]+|["」』]+$/g, '');
          return s || null;
        } catch {
          // 提炼失败静默：探讨记录还在，可重试
          return null;
        }
      },
    };
  }, [patch, aiInfo]);

  const selectable = chapters.filter((c) => !c.content);
  const allPicked = selectable.length > 0 && selectable.every((c) => sel.has(c.id));

  return (
    <div className="outline-wrap">
      <div className="outline-head">
        <div className="ol-head-row">
          <h3>
            <Layers size={15} /> 章节大纲与批量写作
          </h3>
          <div className="mode-seg">
            <button className={view === 'outline' ? 'on' : ''} onClick={() => setView('outline')}>
              大纲
            </button>
            <button className={view === 'timeline' ? 'on' : ''} onClick={() => setView('timeline')}>
              时间线
            </button>
          </div>
        </div>
        <span className="hint">
          大纲是每章的结构化设定（要点 / 人物 / 地点 / 伏笔）；批量生成只产「草稿」，由你逐章审核采纳，不直接进正文。时间线视图管理故事内时序。
        </span>
      </div>

      {!aiInfo.ready && <div className="ai-error">尚未配置 AI 模型，生成功能不可用——先到「设置」完成配置。</div>}

      {health && <HealthCard report={health} />}

      {/* 全书梗概：长篇写到 20 章以上后，远古章节靠它进入 AI 上下文，不至于「只记得最近 20 章」 */}
      <div className="arc-card">
        <button className="arc-head" onClick={() => setArcOpen((v) => !v)}>
          {arcOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <BookOpen size={14} />
          <span className="arc-name">全书梗概</span>
          {arc?.upTo ? <span className="chip">第 1–{arc.upTo} 章</span> : <span className="chip dim">未生成</span>}
        </button>
        <div className="arc-body">
          {arcBusy ? (
            <button className="btn small" onClick={() => arcAbortRef.current?.abort()}>
              <Square size={12} /> 停止
            </button>
          ) : (
            <button
              className="btn small primary"
              onClick={genArc}
              disabled={!aiInfo.ready}
              title="把已写章节的梗概归并成一份「全书至今梗概」；写到 20 章以上后，远古章节由它替代进入 AI 上下文"
            >
              <Sparkles size={12} /> {arc?.text ? '并入新章' : '生成'}
            </button>
          )}
          {arc?.text && (
            <button className="btn small" onClick={() => setArcOpen((v) => !v)}>
              <Eye size={12} /> {arcOpen ? '收起' : '查看'}
            </button>
          )}
          {arcPrev && (
            <button className="btn small" onClick={undoArc} title="还原为上一次覆盖前的版本">
              <Undo2 size={12} /> 撤销
            </button>
          )}
          {arc?.text && (
            <button
              className="btn small danger"
              onClick={() => {
                if (!confirm('删除全书梗概？远古章节将回退为按批聚合，可随时重新生成。')) return;
                setArcPrev({ upTo: arc.upTo, text: arc.text });
                onUpdate(project.id, { rollingSummary: undefined });
              }}
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
        {arcMsg && <div className={'field-msg ' + (arcMsg.ok ? 'ok' : 'fail')}>{arcMsg.text}</div>}
        {arcOpen && arc?.text && (
          <div className="arc-text">
            <RichText text={arc.text} />
            {arc.at && <div className="arc-at">生成于 {arc.at}</div>}
          </div>
        )}
      </div>

      {view === 'timeline' ? (
        chapters.length ? (
          <TimelineView project={project} aiInfo={aiInfo} patch={(c, p) => patch(c, p)} />
        ) : (
          <div className="hint" style={{ padding: '18px 4px' }}>
            还没有章节。先切回「大纲」视图生成或创建章节，再回来标注时间线。
          </div>
        )
      ) : (
        <>
      <div className="outline-gen">
        <label>
          AI 拟章数
          <input type="number" min={1} max={60} value={genCount} onChange={(e) => setGenCount(e.target.value)} style={{ width: 64 }} />
        </label>
        <button className="btn small primary" onClick={genOutline} disabled={!aiInfo.ready || genRunning}>
          {genRunning ? (
            <>
              <Square size={12} /> 停止
            </>
          ) : (
            <>
              <Sparkles size={12} /> 生成章节大纲{chapters.length ? '（追加）' : ''}
            </>
          )}
        </button>
        <button className="mini-btn" onClick={copyOutline} title="复制全书大纲为纯文本">
          <Copy size={12} /> 复制大纲
        </button>
        {genRunning && <span className="hint">生成中…</span>}
      </div>
      {genMsg && <div className={'field-msg ' + (genMsg.ok ? 'ok' : 'fail')}>{genMsg.text}</div>}

      {chapters.length === 0 ? (
        <div className="hint" style={{ padding: '18px 4px' }}>
          还没有章节。小说类项目可在「AI 向导」创建时自动生成章节；已有的单文档项目可点
          <button className="mini-btn" style={{ margin: '0 6px' }} onClick={() => onAddChapter(project.id)}>
            转为章节模式
          </button>
          后在这里规划大纲。
        </div>
      ) : (
        <>
          <div className="batch-bar">
            <label className="batch-check">
              <input
                type="checkbox"
                checked={allPicked}
                onChange={(e) => setSel(e.target.checked ? new Set(selectable.map((c) => c.id)) : new Set())}
              />
              全选待写章
            </label>
            <label>
              每章约
              <input type="number" min={300} max={5000} step={100} value={batchWords} onChange={(e) => setBatchWords(Math.max(300, Math.min(5000, Number(e.target.value) || 1000)))} style={{ width: 70 }} />
              字
            </label>
            {batch?.running ? (
              <button className="btn small" onClick={stopAll}>
                <Square size={12} /> 停止批量
              </button>
            ) : (
              <button
                className="btn small primary"
                disabled={!aiInfo.ready || sel.size === 0 || aiInfo.judgeOnly === true}
                title={aiInfo.judgeOnly === true ? '「AI 只判不写」开着：批量出草稿会产出成品正文，这里直接按住（设置里可关）' : '把选中的章按细纲各出一稿，落在「待审草稿」里，采纳才进正文'}
                onClick={requestBatch}
              >
                <Sparkles size={12} /> 批量生成草稿（{sel.size}）
              </button>
            )}
            {batch && (
              <span className="hint">
                {batch.running ? `正在生成：${chapters.find((c) => c.id === batch.currentId)?.title ?? '…'}` : '批次结束'}
                {` · 成功 ${batch.ok.length} · 失败 ${batch.fail.length}`}
                {batch.usage.total > 0 && ` · 缓存命中 ${Math.round((batch.usage.hit / batch.usage.total) * 100)}%（${batch.usage.hit}/${batch.usage.total} tokens）`}
              </span>
            )}
          </div>

          {gate && (
            <div className="gate-panel">
              <div className="gate-text">
                {gateSummary(gate)}。{gate.thin.length ? '这几章的剧情此刻由模型替你定，掉回默认桥段的概率很高。' : ''}
              </div>
              {gate.lore.length > 0 && (
                <ul className="gate-lore">
                  {gate.lore.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
              {gate.lore.length > 0 && <div className="hint">境界是守夜人从已写正文里算的：这几处若是笔误，先回头改正文；不改也能生成——提示词里已经注入了「正文写到的最高境界」当红线，AI 续写不会自愿往回退。</div>}
              <div className="discuss-ops">
                {gate.thin.length > 0 && (
                  <button className="mini-btn ok" onClick={() => jumpToBeats(gate.thin[0].id)}>
                    <Check size={12} /> 先补第{gate.thin[0].no}章要点
                    {gate.thin.length > 1 ? `（还有 ${gate.thin.length - 1} 章）` : ''}
                  </button>
                )}
                {gate.thin.length > 0 && gate.safe > 0 && (
                  <button className="mini-btn" onClick={() => batchWith('outlined')}>
                    只生成有细纲的 {gate.safe} 章
                  </button>
                )}
                <button className="mini-btn" onClick={() => batchWith('all')}>
                  <Sparkles size={12} /> 照常全部生成（{sel.size}）
                </button>
                <button className="mini-btn" onClick={() => setGate(null)}>
                  先不生成
                </button>
              </div>
              {gate.draft.length > 0 && <div className="hint">草稿没有快照，覆盖前可先「看草稿 → 采纳/弃用」清掉。这个提醒能在设置页关掉。</div>}
            </div>
          )}

          <datalist id="volume-options">
            {volumeOptions.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <div className="ol-list">
            {groups.map((g) => {
              const vWords = g.items.reduce((a, c) => a + (wordsMap.get(c.id) ?? 0), 0);
              return (
                <div key={g.key} className="vol-group">
                  <div className="vol-head">
                    <input
                      className="vol-name"
                      value={g.name}
                      placeholder="未分卷"
                      title="重命名整卷（只影响本组连续章节）；改中间某章的「卷」即可拆卷"
                      onChange={(e) => renameVolume(g.key, e.target.value)}
                    />
                    <span className="vol-meta">
                      {g.items.length} 章 · {vWords} 字
                    </span>
                  </div>
                  {g.items.map((c) => {
                    const i = idxById.get(c.id) ?? 0;
                    return (
                      <OutlineCard
                        key={c.id}
                        c={c}
                        i={i}
                        cWords={wordsMap.get(c.id) ?? 0}
                        sel={sel.has(c.id)}
                        aiReady={aiInfo.ready}
                        judgeOnly={aiInfo.judgeOnly === true}
                        isRunning={!!batch?.running}
                        isCurrent={batch?.currentId === c.id}
                        previewOpen={previewId === c.id}
                        sumBusy={sumId === c.id}
                        discussOpen={discussId === c.id}
                        debt={debt && debt.id === c.id ? debt : null}
                        ops={ops}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </>
      )}
        </>
      )}
    </div>
  );
}
