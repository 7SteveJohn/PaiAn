import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { AppData, AIPublic, Chapter, Idea, IdeaKind, ObsidianConfig, Project, ProjectVersion, StatsData } from './types';
import { appendBeats, beatsLine, gapOf, matchOutlineRows, undoImport, type ImportOutcome, type ImportProjectLite, type ImportRequest, type ImportUndo } from './import-plan';
import { fetchData, fetchObsidianStatus, fetchPromptOverrides, fetchVersions, purgeVaultBook, saveAIConfig, saveBenchmarks, saveChapterContent, saveChat, saveData, savePromptOverride, saveVersions, type RestoreExtras } from './api';
import type { PromptKey, PromptOverrides } from './ai-prompt';
import { useObsidianSync } from './useObsidianSync';
import { flattenVersions, mergeVersionsInto, pickVersionWrites, signatureOf, stripVersions, versionSignatures } from './versions';
import { EMPTY_STATE, EMPTY_USER, activePool, mergeCardRule, pruneHand, type GachaState } from './gacha';
import { countWords, localDate, localStamp, normalizeStats, parseOutlineToChapters, uid } from './util';
import Sidebar from './components/Sidebar';
import IdeasView from './components/IdeasView';
import ImportPanel from './components/ImportPanel';
import ProjectsView from './components/ProjectsView';
import WritingView from './components/WritingView';
import StatsView from './components/StatsView';
import TrashView from './components/TrashView';
import HomeView from './components/HomeView';
import CommandPalette from './components/CommandPalette';

// secondary 视图按需加载：设置页带着 30+ 供应商预设、卡池带着整副牌与动效层、
// 对话与向导带着自己的依赖——首屏不必为它们付解析成本（CodeMirror 已是同样的做法）
// 懒加载留一手「预载」：首屏之后空闲时把大页面的包悄悄拉回来，
// 第一次点「设置 / 卡池 / 对话 / 向导」就不该付网络+解析的账——那一下正是「像网页」的来源
const loadSettings = () => import('./components/SettingsView');
const loadGacha = () => import('./components/GachaView');
const loadChat = () => import('./components/ChatView');
const loadWizard = () => import('./components/ProjectWizard');
const SettingsView = lazy(loadSettings);
const GachaView = lazy(loadGacha);
const ChatView = lazy(loadChat);
const ProjectWizard = lazy(loadWizard);
const preloadHeavy = () => {
  void loadSettings();
  void loadGacha();
  void loadChat();
  void loadWizard();
};

export type View = 'home' | 'ideas' | 'projects' | 'stats' | 'settings' | 'trash' | 'chat' | 'gacha';

const MAX_VERSIONS = 20; // 与 src/versions.ts 同值，由 tests/versions.test.ts 钉住（服务端另有一份）
const LOADING = <div className="view-loading">页面载入中…</div>;

/** 追加到正文末尾：非空才补一个空行做分隔，不让末尾的旧空行越积越多 */
function appendText(base: string, add: string): string {
  const head = base.replace(/\s+$/, '');
  return head ? `${head}\n\n${add}` : add;
}

export default function App() {
  const [view, setView] = useState<View>('home');
  const [data, setData] = useState<AppData | null>(null);
  const [aiInfo, setAiInfo] = useState<AIPublic | null>(null);
  const [dataDir, setDataDir] = useState('');
  const [obsidian, setObsidian] = useState<ObsidianConfig>({ vaultPath: '', folder: '' });
  const [openId, setOpenId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved');
  const [saveError, setSaveError] = useState('');
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;
  // stale 警告的静音窗口：点「已知晓」后 10 分钟内不再重复弹同一次事件，
  // 否则自动保存一跑（800ms）条件还成立就立刻弹回，按钮形同虚设
  const staleMutedUntil = useRef(0);
  const [dataWarnings, setDataWarnings] = useState<string[]>([]);
  const [ideaSearch, setIdeaSearch] = useState({ q: '', n: 0 });
  const [wizardOpen, setWizardOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // 回收站的「连库里副本一起删」要问得出来：进回收站时看一眼同步状态表（轻接口，不扫库）
  const [vaultBooks, setVaultBooks] = useState<{ root: string; book: string; projectId?: string }[]>([]);
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    localStorage.getItem('ww-theme') === 'dark' ? 'dark' : 'light',
  );
  // 通用偏好：正文字号（CodeEditor 主题用 --doc-fs 取值）
  useEffect(() => {
    const fs = localStorage.getItem('ww-doc-fs');
    if (fs) document.documentElement.style.setProperty('--doc-fs', fs);
  }, []);
  // 提示词覆盖：挂载时拉一次 data/prompts/*.md；幽灵字建议读 localStorage（设置里改完即时生效）
  const [promptOverrides, setPromptOverrides] = useState<PromptOverrides>({});
  const [ghostOn, setGhostOn] = useState(() => localStorage.getItem('ww-ghost') !== '0');
  useEffect(() => {
    fetchPromptOverrides()
      .then(setPromptOverrides)
      .catch(() => {});
  }, []);
  const savePrompt = useCallback(async (key: PromptKey, text: string) => {
    await savePromptOverride(key, text);
    setPromptOverrides((prev) => {
      const next = { ...prev };
      if (text.trim()) next[key] = text;
      else delete next[key];
      return next;
    });
  }, []);
  const loaded = useRef(false);
  const dataRef = useRef(data);
  dataRef.current = data;
  // 快照按 key 增量：sentVersions 记「这条 key 上次发出去的内容指纹」，
  // loadedVersions 记「哪本作品的快照真的读进内存了」——没读过的绝不覆盖写回。
  const sentVersions = useRef<Map<string, string>>(new Map());
  const loadedVersions = useRef<Set<string>>(new Set());
  const versionCounts = useRef<Record<string, number>>({});
  const fetchingVersions = useRef<Set<string>>(new Set());

  // 打开哪本就只读哪本的历史快照（实测整表 67MB / 首屏 762ms，没必要一路背着）
  const ensureVersions = useCallback(async (pid: string) => {
    if (!pid || loadedVersions.current.has(pid) || fetchingVersions.current.has(pid)) return;
    fetchingVersions.current.add(pid);
    try {
      const flat = await fetchVersions(pid);
      loadedVersions.current.add(pid);
      for (const [k, list] of Object.entries(flat)) {
        // 指纹必须与 persist 里的算法同源，否则要么白发要么漏发
        sentVersions.current.set(k, signatureOf(list));
        versionCounts.current[k] = list.length;
      }
      setData((prev) => (prev ? { ...prev, projects: mergeVersionsInto(prev.projects, flat) } : prev));
    } catch (err) {
      console.warn('读取历史快照失败，本轮不覆盖磁盘上的快照：', (err as Error).message);
    } finally {
      fetchingVersions.current.delete(pid);
    }
  }, []);

  useEffect(() => {
    fetchData()
      .then(({ ideas, projects, stats, ai, dataDir: dir, obsidian: obs, warnings, gacha, cards, versionCounts: counts }) => {
        const g = gacha ?? EMPTY_STATE;
        const c = cards ?? EMPTY_USER;
        // 手牌可能留着已被勾掉/删掉的卡：开新局先裁一刀，别让僵尸卡占着手牌名额
        const hand = g.hand?.length ? pruneHand(g, activePool(c)) : { state: g, dropped: [] };
        setData({ ideas, projects, stats: normalizeStats(stats), gacha: hand.state, cards: c });
        setAiInfo(ai);
        setDataDir(dir);
        setObsidian(obs);
        setDataWarnings(warnings ?? []);
        // 首屏不带快照，只带份数：据此判断某条 key 服务端有没有东西
        versionCounts.current = counts ?? {};
      })
      .catch((err: Error) => alert('初始化失败：' + err.message));
  }, []);

  // 打开的作品：快照按需读进来（写作页与抽屉里的快照追加都依赖它在内存里）
  useEffect(() => {
    if (openId) void ensureVersions(openId);
  }, [openId, ensureVersions]);

  // 进回收站才需要知道「哪本书在库里还有镜像」（彻底删除时要不要连带问一句）
  useEffect(() => {
    if (view !== 'trash') return;
    fetchObsidianStatus()
      .then((s) => setVaultBooks(s.books))
      .catch(() => setVaultBooks([]));
  }, [view]);

  // 落盘：正文每次都发；历史快照体积可以比正文大一个数量级，按 key 只发变了的那些
  /** 上一次成功落库的数据引用：快路径靠「引用没变 = 没改」判差异，不用反复 stringify 整包 */
  const lastSavedRef = useRef<Pick<AppData, "projects" | "ideas" | "stats" | "gacha" | "cards"> | null>(null);

  // 退出 / 最小化到托盘时把没落库的字冲出去：自动保存有 800ms 去抖，关得快就是丢字。
  // 同步 XHR 在 pagehide 里是允许的（keepalive fetch 对 3MB 级包有 64KB 上限，走不通）
  useEffect(() => {
    const flush = () => {
      const st = saveStateRef.current;
      if (st !== 'dirty' && st !== 'error') return;
      const d = dataRef.current;
      if (!d) return;
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', '/api/data', false);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(JSON.stringify({ ...d, projects: stripVersions(d.projects) }));
      } catch {
        // 服务端已经关了就没什么可救：当日备份还在
      }
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  const persist = useCallback(async () => {
    const d = dataRef.current;
    if (!d) return;
    setSaveState('saving');
    try {
      // 快路径：只改了一章的正文（打字场景）时，别为 3MB 整包付网络与磁盘的账。
      // 判据全靠引用比对：引用变了才算改过，有一点拿不准就退回整包（宁慢勿错）。
      const prev = lastSavedRef.current;
      if (prev && d.projects.length === prev.projects.length && d.ideas === prev.ideas && d.stats === prev.stats && d.gacha === prev.gacha && d.cards === prev.cards) {
        let changed: { pid: string; id: string; content: string } | null = null;
        let ambiguous = false;
        for (let pi = 0; pi < d.projects.length && !ambiguous; pi++) {
          const np = d.projects[pi];
          const pp = prev.projects[pi];
          if (np === pp) continue;
          const strip = (p: Project) => JSON.stringify({ ...p, chapters: [], updatedAt: '' });
          if (np.id !== pp.id || (np.chapters?.length ?? 0) !== (pp.chapters?.length ?? 0) || strip(np) !== strip(pp)) {
            ambiguous = true;
            break;
          }
          const ncs = np.chapters ?? [];
          const pcs = pp.chapters ?? [];
          for (let ci = 0; ci < ncs.length; ci++) {
            if (ncs[ci] === pcs[ci]) continue;
            const sig = (c: Chapter) => JSON.stringify({ ...c, content: '' });
            if (ncs[ci].id !== pcs[ci].id || sig(ncs[ci]) !== sig(pcs[ci]) || changed) {
              ambiguous = true;
              break;
            }
            changed = { pid: np.id, id: ncs[ci].id, content: ncs[ci].content };
          }
        }
        if (changed && !ambiguous) {
          await saveChapterContent(changed.pid, changed.id, changed.content);
          lastSavedRef.current = { projects: d.projects, ideas: d.ideas, stats: d.stats, gacha: d.gacha, cards: d.cards };
          setSaveState('saved');
          setSaveError('');
          return;
        }
      }
      const { stale } = await saveData(d);
      const flat = flattenVersions(d.projects);
      const { changed, need } = pickVersionWrites(flat, sentVersions.current, versionCounts.current, loadedVersions.current);
      if (Object.keys(changed).length) {
        await saveVersions(changed, 'merge');
        const sigs = versionSignatures(changed);
        for (const k of Object.keys(changed)) {
          sentVersions.current.set(k, sigs.get(k)!);
          versionCounts.current[k] = flat[k].length;
        }
      }
      for (const pid of need) void ensureVersions(pid);
      lastSavedRef.current = { projects: d.projects, ideas: d.ideas, stats: d.stats, gacha: d.gacha, cards: d.cards };
      setSaveState('saved');
      setSaveError('');
      if (stale && Date.now() >= staleMutedUntil.current) {
        staleMutedUntil.current = Date.now() + 10 * 60 * 1000;
        // 整包保存模型的唯一丢数据路径：另一个标签页从更旧的状态出发盖了新改动
        setDataWarnings((prev) =>
          prev.some((w) => w.includes("另一个窗口"))
            ? prev
            : [...prev, "这次写入的内容比磁盘上已有的更旧——可能有另一个窗口或标签页的新改动被覆盖了。当日自动备份在数据目录 backups/ 里，可以从「设置 → 从备份恢复」找回。"],
        );
      }
    } catch (err) {
      setSaveState('error');
      setSaveError((err as Error).message);
    }
  }, []);

  // 数据变化后 800ms 自动保存（跳过首次加载）
  useEffect(() => {
    if (!data) return;
    if (!loaded.current) {
      loaded.current = true;
      return;
    }
    setSaveState('dirty');
    const timer = setTimeout(() => void persist(), 800);
    return () => clearTimeout(timer);
  }, [data, persist]);

  // 「启动时回到上次写到的位置」：每次会话只回一次；用户一旦点了别的页面就不抢
  useEffect(() => {
    if (!data || view !== "home" || openId) return;
    if (localStorage.getItem('ww-auto-resume') !== '1') return;
    if (sessionStorage.getItem('ww-resumed') === '1') return;
    sessionStorage.setItem('ww-resumed', '1');
    const bp = [...data.projects]
      .filter((p) => !p.deletedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .find((p) => p.breakpoint);
    if (bp) setOpenId(bp.id);
  }, [data, view, openId]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('ww-theme', theme);
    // 桌面版没有系统标题栏，右上角窗口按钮的底色要跟主题一起翻；preload 只开了这一个通道
    const wb = (window as unknown as { wb?: { desktop?: boolean; titleBarTheme?: (dark: boolean) => void } }).wb;
    if (wb?.desktop) document.documentElement.classList.add('desktop');
    wb?.titleBarTheme?.(theme === 'dark');
  }, [theme]);

  // 桌面版标题栏渐隐遮罩的开关：.main 滚动超过阈值才亮出（CSS 侧 html.desktop body.main-scrolled::after）。
  // scroll 不冒泡但捕获阶段拿得到，委托给 document 一次绑定，视图切换重挂 .main 也不用重绑。
  useEffect(() => {
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Element && t.classList.contains('main')) {
        document.body.classList.toggle('main-scrolled', t.scrollTop > 4);
      }
    };
    document.addEventListener('scroll', onScroll, true);
    return () => document.removeEventListener('scroll', onScroll, true);
  }, []);

  // 立即保存（Ctrl+S / 保存失败后点侧重试）
  const flushSave = useCallback(() => {
    void persist();
  }, [persist]);

  // 首屏数据到位后，空闲时预载大页面的包（首次点击不再出现「载入中…」一闪）
  useEffect(() => {
    const w = window as unknown as { requestIdleCallback?: (f: () => void) => number };
    const idle = w.requestIdleCallback ?? ((f: () => void) => window.setTimeout(f, 1500));
    idle(() => preloadHeavy());
  }, []);

  /** 恢复的附加资产（对话/对标/AI 配置）统一起见：失败收进 bad，由调用方决定怎么说 */
  const applyExtras = useCallback(async (extras: RestoreExtras | undefined, bad: string[]) => {
    if (extras?.chat) await saveChat(extras.chat).catch((e: Error) => bad.push('对话历史' + e.message));
    if (extras?.benchmarks) await saveBenchmarks(extras.benchmarks).catch((e: Error) => bad.push('对标记录' + e.message));
    const ai = extras?.ai;
    if (ai?.provider && ai.baseUrl && ai.model) {
      // apiKey 刻意不传：备份里本来就不含它，传 undefined 等于「不动本机已有的 Key」
      const fresh = await saveAIConfig({
        provider: ai.provider,
        baseUrl: ai.baseUrl,
        model: ai.model,
        protocol: ai.protocol,
        rules: ai.rules,
        memoryExtract: ai.memoryExtract,
        gateDraft: ai.gateDraft,
        judgeOnly: ai.judgeOnly,
      }).catch((e: Error) => {
        bad.push('AI 配置' + e.message);
        return null;
      });
      if (fresh) setAiInfo(fresh);
    }
  }, []);

  // 从备份整包恢复：先落盘再更新内存，写盘失败则保留原数据不动（快照同步覆盖）。
  // 整包之外的对话 / 对标 / AI 配置也一起写回——「全部数据备份」恢复时同样得是全部。
  const restoreAll = useCallback(async (next: AppData, extras?: RestoreExtras): Promise<string | void> => {
    await saveData(next);
    const flat = flattenVersions(next.projects);
    // 备份里一条快照都没有时（老备份/手改过的文件）绝不整表替换——那会把现有的全部历史版本清空
    if (Object.keys(flat).length === 0) {
      const bad: string[] = [];
      await applyExtras(extras, bad);
      return ['备份不含历史快照，已保留现有的历史版本', ...bad].filter(Boolean).join('；') || undefined;
    }
    await saveVersions(flat, 'replace');
    const sigs = versionSignatures(flat);
    sentVersions.current = sigs;
    // 恢复进来的快照就是内存里的事实，后续按 merge 增量发即可
    loadedVersions.current = new Set(next.projects.map((p) => p.id));
    versionCounts.current = {};
    for (const [k, list] of Object.entries(flat)) versionCounts.current[k] = list.length;
    setData({ ...next, gacha: next.gacha ?? EMPTY_STATE, cards: next.cards ?? EMPTY_USER });

    // 附加资产失败不该把已经落好的整包说成「恢复失败」：收成一句说明交回调用方
    const bad: string[] = [];
    await applyExtras(extras, bad);
    return bad.length ? `${bad.join('、')}没写回去` : undefined;
  }, []);

  // 卡池账本（抽数/墨/在手/点亮）：跟着自动保存一起落盘，体积很小
  const updateGacha = useCallback((next: GachaState) => {
    setData((prev) => prev && { ...prev, gacha: next });
  }, []);

  // 卡牌效果「追加到规则中心」：立刻写盘并回读，之后的 AI 调用都会带上它
  // 卡牌效果「追加到规则中心」：同名覆盖、卡牌来源最多留 6 条——
  // 不限量会让之后每一次 AI 调用都越拖越贵。返回一句回执给写作页显示。
  const addRule = useCallback(
    (r: { name: string; content: string }) => {
      if (!aiInfo) return 'AI 配置还没就绪，这条规则没写进去。';
      const merged = mergeCardRule(aiInfo.rules ?? [], r);
      saveAIConfig({ provider: aiInfo.provider, baseUrl: aiInfo.baseUrl, model: aiInfo.model, rules: merged.rules })
        .then(setAiInfo)
        .catch((e: Error) => alert('写入规则中心失败：' + e.message));
      return merged.dropped.length ? `顶掉了早期的卡牌规则：${merged.dropped.join('、')}。` : '';
    },
    [aiInfo],
  );

  // 全局快捷键：Ctrl+K 命令面板、Ctrl+S 保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        flushSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flushSave]);

  // ---------- 灵感 ----------
  const addIdea = useCallback((idea: Idea) => {
    setData((prev) => prev && { ...prev, ideas: [idea, ...prev.ideas] });
  }, []);

  const updateIdea = useCallback((id: string, patch: Partial<Idea>) => {
    setData((prev) => prev && { ...prev, ideas: prev.ideas.map((i) => (i.id === id ? { ...i, ...patch } : i)) });
  }, []);

  // ---------- 项目 ----------
  // 更新项目；正文变化时：字数记入当日统计；每天首次编辑与 AI 改写前自动存历史快照
  const updateProject = useCallback((id: string, patch: Partial<Project>, opts?: { snapshot?: boolean }) => {
    setData((prev) => {
      if (!prev) return prev;
      let stats: StatsData = prev.stats;
      const today = localDate();
      const projects = prev.projects.map((p) => {
        if (p.id !== id) return p;
        const next = { ...p, ...patch, updatedAt: new Date().toISOString() };
        if (patch.draft !== undefined && patch.draft !== p.draft) {
          const oldCount = countWords(p.draft);
          const delta = countWords(next.draft) - oldCount;
          // 净产出口径：删改会回扣，避免反复重写/AI 覆盖导致当日字数虚高（但不低于 0）
          if (delta !== 0) {
            const nextCount = Math.max(0, (stats.daily[today] ?? 0) + delta);
            stats = { ...stats, daily: { ...stats.daily, [today]: nextCount } };
          }
          let versions = p.versions ?? [];
          const last = versions[versions.length - 1];
          const firstEditToday = !last || last.at.slice(0, 10) !== today;
          if (firstEditToday || opts?.snapshot) {
            versions = [...versions, { at: localStamp(), words: oldCount, text: p.draft }];
            if (versions.length > MAX_VERSIONS) versions = versions.slice(-MAX_VERSIONS);
          }
          next.versions = versions;
          // 标记重锚定：正文变化后按原文就近重找位置；找不到则标记失效（在抽屉中提醒）
          if (next.marks?.length) {
            next.marks = next.marks.map((mk) => {
              if (mk.orphaned || !mk.text) return mk;
              const from = Math.max(0, mk.start - 400);
              const idx = next.draft.indexOf(mk.text, from);
              if (idx >= 0) return { ...mk, start: idx, end: idx + mk.text.length };
              return { ...mk, orphaned: true };
            });
          }
        }
        return next;
      });
      return { ...prev, projects, stats };
    });
  }, []);

  const addProject = useCallback((project: Project) => {
    setData((prev) => prev && { ...prev, projects: [project, ...prev.projects] });
  }, []);

  // 载入示例作品：一个普通项目，可随时删除，不触碰任何既有数据。
  // 范文全文只在本地个人构建里包含（VITE_INCLUDE_SAMPLE=1 npm run build），
  // 默认构建（对外分享的安装包 / 开源仓库）不含任何范文文本，按钮也不出现。
  const sampleEnabled = !!import.meta.env.VITE_INCLUDE_SAMPLE;
  const loadSample = useCallback(async () => {
    if (!sampleEnabled) return;
    const { buildSampleProject } = await import('./sample');
    await addProject(buildSampleProject());
  }, [sampleEnabled, addProject]);

  // ---------- 章节模式 ----------
  const updateChapter = useCallback((projectId: string, chapterId: string, patch: Partial<Chapter>, opts?: { snapshot?: boolean }) => {
    setData((prev) => {
      if (!prev) return prev;
      let stats: StatsData = prev.stats;
      const today = localDate();
      const projects = prev.projects.map((p) => {
        if (p.id !== projectId) return p;
        const chapters = (p.chapters ?? []).map((c) => {
          if (c.id !== chapterId) return c;
          const next = { ...c, ...patch, updatedAt: new Date().toISOString() };
          if (patch.content !== undefined && patch.content !== c.content) {
            const oldCount = countWords(c.content);
            const delta = countWords(next.content) - oldCount;
            // 净产出口径：删改会回扣，避免反复重写/AI 覆盖导致当日字数虚高（但不低于 0）
            if (delta !== 0) {
              const nextCount = Math.max(0, (stats.daily[today] ?? 0) + delta);
              stats = { ...stats, daily: { ...stats.daily, [today]: nextCount } };
            }
            let versions = c.versions ?? [];
            const last = versions[versions.length - 1];
            const firstEditToday = !last || last.at.slice(0, 10) !== today;
            if (firstEditToday || opts?.snapshot) {
              versions = [...versions, { at: localStamp(), words: oldCount, text: c.content }];
              if (versions.length > MAX_VERSIONS) versions = versions.slice(-MAX_VERSIONS);
            }
            next.versions = versions;
          }
          return next;
        });
        // 该章正文变化后，重锚定属于这一章的标记
        let marks = p.marks;
        if (patch.content !== undefined) {
          const changed = chapters.find((c) => c.id === chapterId);
          marks = (p.marks ?? []).map((mk) => {
            if (mk.chapterId !== chapterId || mk.orphaned || !mk.text) return mk;
            const from = Math.max(0, mk.start - 400);
            const idx = (changed?.content ?? '').indexOf(mk.text, from);
            if (idx >= 0) return { ...mk, start: idx, end: idx + mk.text.length };
            return { ...mk, orphaned: true };
          });
        }
        return { ...p, chapters, marks, updatedAt: new Date().toISOString() };
      });
      return { ...prev, projects, stats };
    });
  }, []);

  /** 新建一章：不传 afterId 就追加到末尾；传了就插到那一章后面（长篇在中间补章，不该一路「上移」） */
  const addChapter = useCallback((projectId: string, title?: string, summary?: string, afterId?: string) => {
    setData((prev) => {
      if (!prev) return prev;
      const now = new Date().toISOString();
      const projects = prev.projects.map((p) => {
        if (p.id !== projectId) return p;
        const list = p.chapters ?? [];
        const n = list.length + 1;
        const at = afterId ? list.findIndex((c) => c.id === afterId) : -1;
        // 新章继承相邻章的卷：卷末加章自动归入该卷，不会掉进「未分卷」
        const neighbor = at >= 0 ? list[at] : list[list.length - 1];
        const vol = neighbor?.volume ?? '';
        // 卷内默认章名按卷内序号：卷零的第 2 章叫「卷零·第2章」，而不是全局第 9 章
        const volCount = vol ? list.filter((c) => (c.volume ?? '') === vol).length + 1 : n;
        const fresh: Chapter = { id: uid(), title: title?.trim() || (vol ? `${vol}·第${volCount}章` : `第${n}章`), content: '', summary, createdAt: now, updatedAt: now, volume: vol };
        const chapters = at < 0 ? [...list, fresh] : [...list.slice(0, at + 1), fresh, ...list.slice(at + 1)];
        return { ...p, mode: 'chapters' as const, chapters };
      });
      return { ...prev, projects };
    });
  }, []);

  /** 删章：写作页侧栏删单章、大纲页多选批量删，走同一条（孤儿的快照由服务端按最新章清单剪掉） */
  const deleteChapters = useCallback((projectId: string, ids: string | string[]) => {
    const kill = new Set(Array.isArray(ids) ? ids : [ids]);
    if (!kill.size) return;
    setData((prev) => {
      if (!prev) return prev;
      const projects = prev.projects.map((p) => {
        if (p.id !== projectId) return p;
        return { ...p, chapters: (p.chapters ?? []).filter((c) => !kill.has(c.id)), marks: (p.marks ?? []).filter((m) => !kill.has(m.chapterId ?? '')) };
      });
      return { ...prev, projects };
    });
  }, []);

  const moveChapter = useCallback((projectId: string, chapterId: string, dir: -1 | 1) => {
    setData((prev) => {
      if (!prev) return prev;
      const projects = prev.projects.map((p) => {
        if (p.id !== projectId) return p;
        const chapters = [...(p.chapters ?? [])];
        const i = chapters.findIndex((c) => c.id === chapterId);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= chapters.length) return p;
        [chapters[i], chapters[j]] = [chapters[j], chapters[i]];
        return { ...p, chapters };
      });
      return { ...prev, projects };
    });
  }, []);

  // 章节版本回滚：回滚前先把当前内容存为快照
  const restoreChapterVersion = useCallback((projectId: string, chapterId: string, version: ProjectVersion) => {
    setData((prev) => {
      if (!prev) return prev;
      const projects = prev.projects.map((p) => {
        if (p.id !== projectId) return p;
        return {
          ...p,
          chapters: (p.chapters ?? []).map((c) => {
            if (c.id !== chapterId) return c;
            const versions = [...(c.versions ?? []), { at: localStamp(), words: countWords(c.content), text: c.content }];
            return { ...c, content: version.text, versions: versions.slice(-MAX_VERSIONS), updatedAt: new Date().toISOString() };
          }),
        };
      });
      return { ...prev, projects };
    });
  }, []);

  // 回滚到某个历史版本；回滚前的当前内容先存为新快照
  const restoreVersion = useCallback((id: string, version: ProjectVersion) => {
    setData((prev) => {
      if (!prev) return prev;
      const projects = prev.projects.map((p) => {
        if (p.id !== id) return p;
        const versions = [...(p.versions ?? []), { at: localStamp(), words: countWords(p.draft), text: p.draft }];
        return {
          ...p,
          draft: version.text,
          versions: versions.slice(-MAX_VERSIONS),
          updatedAt: new Date().toISOString(),
        };
      });
      return { ...prev, projects };
    });
  }, []);

  // ---------- 统计 ----------
  const setReflection = useCallback((text: string) => {
    setData((prev) => prev && { ...prev, stats: { ...prev.stats, reflection: text } });
  }, []);

  const setDailyGoal = useCallback((n: number) => {
    setData((prev) => prev && { ...prev, stats: { ...prev.stats, dailyGoal: n } });
  }, []);

  // ---------- 跨视图跳转 ----------
  const ideaToProject = useCallback(
    (idea: Idea, opts?: { open?: boolean }) => {
      const project: Project = {
        id: uid(),
        title: idea.content.split('\n')[0].slice(0, 30) || '未命名选题',
        type: '文章',
        status: '构思',
        deadline: '',
        notes: '',
        draft: '',
        linkedIdeaIds: [idea.id],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      addProject(project);
      if (opts?.open === false) return;
      setOpenId(project.id);
      setView('projects');
    },
    [addProject],
  );
  /** 批量转项目：一口气都建成作品，不跳页不抢焦点 */
  const ideasToProjects = useCallback(
    (ideas: Idea[]) => {
      ideas.forEach((idea) => ideaToProject(idea, { open: false }));
    },
    [ideaToProject],
  );

  /**
   * 一次导入的落库：新建作品 / 追加到已有作品 / 灵感库 / 设定卡 / 并进章要点。
   * 返回一句回执给导入面板显示——不跳页：他从面板出发，要看结果自己点开那本书。
   */
  /** 导入预览里标了「转设定」的行：落成这本书的设定卡（资料区标题的去处），并给撤销单补一条 */
  const cardsFromBlocks = (req: ImportRequest, bookId: string, now: string, undo: ImportUndo[]): { id: string; name: string; kind: '设定'; content: string }[] => {
    const fresh = (req.blocks ?? []).filter((b) => b.asWorld && b.content.trim());
    if (!fresh.length) return [];
    const added = fresh.map((b) => ({ id: uid(), name: b.name, kind: '设定' as const, content: b.content }));
    setData(
      (prev) =>
        prev && {
          ...prev,
          projects: prev.projects.map((p) =>
            p.id !== bookId ? p : { ...p, updatedAt: now, worldItems: [...(p.worldItems ?? []), ...added] },
          ),
        },
    );
    undo.push({ kind: 'world', ids: added.map((w) => w.id), projectId: bookId });
    return added;
  };

  const importRun = useCallback(
    (req: ImportRequest): ImportOutcome => {
      const now = new Date().toISOString();

      if (req.target === 'idea') {
        const fresh = req.blocks.filter((b) => b.content.trim());
        if (!fresh.length) return { message: '没有可导入的内容。' };
        const added: Idea[] = fresh.map((b) => ({
          id: uid(),
          content: b.content,
          kind: (req.kind as IdeaKind) || '素材',
          tags: ['导入'],
          pinned: false,
          createdAt: now,
          src: b.src,
        }));
        setData((prev) => prev && { ...prev, ideas: [...prev.ideas, ...added] });
        return {
          message: `已导入 ${added.length} 条到灵感库。`,
          undo: [{ kind: 'idea', ids: added.map((i) => i.id) }],
        };
      }

      if (req.target === 'new-book') {
        const books = req.books.filter((b) => b.chapters.length > 0);
        if (!books.length) return { message: '没有可导入的内容。' };
        const created: Project[] = books.map((b) => {
          // 只有一段、又没有章名的，就是「一整篇正文」：走单篇草稿，别硬塞进章结构
          const flat = b.chapters.length === 1 && !b.chapters[0].title.trim();
          const chapters: Chapter[] = flat
            ? []
            : b.chapters.map((c, i) => ({
                id: uid(),
                title: c.title.trim() || `第${i + 1}章`,
                content: c.body,
                summary: c.summary,
                volume: (c as { volume?: string }).volume ?? '',
                beats: '',
                createdAt: now,
                updatedAt: now,
              }));
          return {
            id: uid(),
            title: b.title.trim() || '未命名作品',
            type: req.type || '小说',
            status: '大纲' as const,
            deadline: '',
            target: 0,
            notes: '',
            draft: flat ? b.chapters[0].body || b.chapters[0].summary : '',
            linkedIdeaIds: [],
            createdAt: now,
            updatedAt: now,
            ...(chapters.length ? { mode: 'chapters' as const, chapters } : {}),
          };
        });
        setData((prev) => prev && { ...prev, projects: [...prev.projects, ...created] });
        const first = created[0];
        const undoBook: ImportUndo[] = [{ kind: 'book', ids: created.map((p) => p.id) }];
        const cards = cardsFromBlocks(req, first.id, now, undoBook);
        return {
          message:
            (created.length === 1
              ? `已建成《${first.title}》：${first.chapters?.length ?? 0} 章，${countWords(first.draft)} 字正文。`
              : `已建成 ${created.length} 部作品。`) + (cards.length ? `另有 ${cards.length} 张设定卡。` : ''),
          projectId: first.id,
          undo: undoBook,
        };
      }

      const target = data?.projects.find((p) => p.id === req.projectId);
      // 与面板同一份判据：界面禁用了不够，落库这一侧自己得再问一次（否则哪天面板改了，这边就漏）
      const gap = gapOf({
        target: req.target,
        projectId: req.projectId ?? '',
        chapterId: req.chapterId ?? '',
        project: target,
        chapterCount: req.books[0]?.chapters.length ?? 0,
      });
      if (gap) return { message: `这次没有导入：${gap}` };
      if (!target) return { message: '那本书找不到了（可能刚被删掉），这次没有导入。' };

      if (req.target === 'world') {
        const fresh = req.blocks.filter((b) => b.content.trim());
        if (!fresh.length) return { message: '没有可导入的内容。' };
        const added = fresh.map((b) => ({ id: uid(), name: b.name, kind: '设定' as const, content: b.content }));
        setData(
          (prev) =>
            prev && {
              ...prev,
              projects: prev.projects.map((p) =>
                p.id !== target.id
                  ? p
                  : { ...p, updatedAt: now, worldItems: [...(p.worldItems ?? []), ...added] },
              ),
            },
        );
        const names = fresh.slice(0, 3).map((b) => `「${b.name}」`).join('');
        return {
          message: `已导进《${target.title}》：设定卡 ${names}${fresh.length > 3 ? ` 等 ${fresh.length} 张` : ''}。`,
          projectId: target.id,
          undo: [{ kind: 'world', ids: added.map((w) => w.id), projectId: target.id }],
        };
      }

      if (req.target === 'outline') {
        // 大纲分发：按章名把各段并进对应章的「剧情要点」；对不上的整段并入备注（可撤销）
        const rows = (req.books[0]?.chapters ?? []).map((c) => ({ title: c.title, body: c.body }));
        const { matched, unmatched } = matchOutlineRows(target.chapters ?? [], rows);
        if (!matched.length && !unmatched.length) return { message: '没有可导入的内容。' };
        const undo: ImportUndo[] = [];
        let beatsHit = 0;
        const prevNotes = target.notes;
        if (matched.length) {
          setData(
            (prev) =>
              prev && {
                ...prev,
                projects: prev.projects.map((p) =>
                  p.id !== target.id
                    ? p
                    : {
                        ...p,
                        updatedAt: now,
                        chapters: (p.chapters ?? []).map((c) => {
                          const m = matched.find((x) => x.chapterId === c.id);
                          if (!m) return c;
                          undo.push({ kind: 'beats', projectId: target.id, chapterId: c.id, beats: c.beats ?? '' });
                          beatsHit++;
                          return { ...c, beats: appendBeats(c.beats, beatsLine(`大纲·${m.chapterTitle}`, m.body)), updatedAt: now };
                        }),
                      },
                ),
              },
          );
        }
        if (unmatched.length) {
          const block = unmatched.map((r) => `【${r.title || '未命名段'}】\n${r.body}`).join('\n\n');
          const nextNotes = appendText(prevNotes, block);
          undo.push({ kind: 'notes', projectId: target.id, notes: prevNotes });
          setData(
            (prev) =>
              prev && {
                ...prev,
                projects: prev.projects.map((p) => (p.id !== target.id ? p : { ...p, updatedAt: now, notes: nextNotes })),
              },
          );
        }
        return {
          message: `已并入《${target.title}》大纲：${beatsHit} 章要点${unmatched.length ? `，${unmatched.length} 段对不上章的并入备注` : ''}。`,
          projectId: target.id,
          undo,
        };
      }


      if (req.target === 'beats') {
        const line = req.blocks.map((b) => beatsLine(b.name, b.content)).join('\n');
        const chapter = target.chapters?.find((c) => c.id === req.chapterId);
        setData(
          (prev) =>
            prev && {
              ...prev,
              projects: prev.projects.map((p) =>
                p.id !== target.id
                  ? p
                  : {
                      ...p,
                      updatedAt: now,
                      chapters: (p.chapters ?? []).map((c) =>
                        c.id === req.chapterId ? { ...c, beats: appendBeats(c.beats, line), updatedAt: now } : c,
                      ),
                    },
              ),
            },
        );
        return {
          message: `已并进《${target.title}》「${chapter?.title || '那一章'}」的剧情要点。`,
          projectId: target.id,
          undo: [{ kind: 'beats', projectId: target.id, chapterId: req.chapterId, beats: chapter?.beats ?? '' }],
        };
      }

      // append：按章的书追加为新章；单篇草稿把内容拼成一段接在正文末尾
      const incoming = req.books[0]?.chapters ?? [];
      if (!incoming.length) return { message: '没有可导入的内容。' };
      if (target.mode === 'chapters') {
        const added: Chapter[] = incoming.map((c, i) => ({
          id: uid(),
          title: c.title.trim() || `第${(target.chapters?.length ?? 0) + i + 1}章`,
          content: c.body,
          summary: c.summary,
          volume: (c as { volume?: string }).volume ?? '',
          beats: '',
          createdAt: now,
          updatedAt: now,
        }));
        setData(
          (prev) =>
            prev && {
              ...prev,
              projects: prev.projects.map((p) =>
                p.id !== target.id ? p : { ...p, updatedAt: now, chapters: [...(p.chapters ?? []), ...added] },
              ),
            },
        );
        const undoChapters: ImportUndo[] = [{ kind: 'chapters', ids: added.map((c) => c.id), projectId: target.id }];
        const cards = cardsFromBlocks(req, target.id, now, undoChapters);
        return {
          message: `已追加到《${target.title}》：${incoming.length} 章。` + (cards.length ? `另有 ${cards.length} 张设定卡。` : ''),
          projectId: target.id,
          undo: undoChapters,
        };
      }
      const merged = incoming.map((c) => [c.title, c.body].filter((x) => x.trim()).join('\n\n')).join('\n\n');
      setData(
        (prev) =>
          prev && {
            ...prev,
            projects: prev.projects.map((p) => (p.id !== target.id ? p : { ...p, updatedAt: now, draft: appendText(p.draft, merged) })),
          },
      );
      const undoDraft: ImportUndo[] = [{ kind: 'draft', projectId: target.id, draft: target.draft }];
      const cards = cardsFromBlocks(req, target.id, now, undoDraft);
      return {
        message: `已追加到《${target.title}》正文末尾（${incoming.length} 段）。` + (cards.length ? `另有 ${cards.length} 张设定卡。` : ''),
        projectId: target.id,
        undo: undoDraft,
      };
    },
    [data],
  );

  /** 撤销一次导入：反着走回执里那张单子，返回一句话告诉面板撤掉了什么 */
  const importUndo = useCallback((list: ImportUndo[]): string => {
    const now = new Date().toISOString();
    setData((prev) => (prev ? undoImport(prev, list, now) : prev));
    const what = list
      .map((u) => {
        switch (u.kind) {
          case 'idea':
            return `拿走 ${u.ids?.length ?? 0} 条灵感`;
          case 'book':
            return `${u.ids?.length ?? 0} 部新作品已进回收站`;
          case 'world':
            return `拿走 ${u.ids?.length ?? 0} 张设定卡`;
          case 'chapters':
            return `删掉刚追加的 ${u.ids?.length ?? 0} 章`;
          case 'beats':
            return '并进的那条要点已撤掉';
          case 'draft':
            return '正文写回导入前那一版';
          case 'notes':
            return '作品备注写回导入前那一版';
        }
      })
      .join('；');
    return `已撤销：${what}。`;
  }, []);

  const openProjectFromSearch = useCallback((id: string) => {
    setOpenId(id);
    setView('projects');
  }, []);

  const searchIdea = useCallback((q: string) => {
    setIdeaSearch((prev) => ({ q, n: prev.n + 1 }));
    setView('ideas');
  }, []);

  // ⑤ 的 12 秒计时与冲突「待判定」住在这里（数据所有者在 App 层）：
  // 写完直接切去灵感库/统计，写作页卸载了，最后一段改动也照样被推出去。
  // hook 必须在下面的 early return 之前调用——hooks 数量每次渲染都要一致
  const openProjectForSync = openId ? (data?.projects.find((p) => p.id === openId) ?? null) : null;
  const obsSync = useObsidianSync(openProjectForSync, obsidian, updateProject);

  if (!data || !aiInfo) {
    return (
      <div className="loading">
        <div className="seal">创</div>
        <p>正在加载工作台…</p>
      </div>
    );
  }

  const activeProjects = data.projects.filter((p) => !p.deletedAt);
  const activeIdeas = data.ideas.filter((i) => !i.deletedAt);
  const trashProjects = data.projects.filter((p) => p.deletedAt);
  const trashIdeas = data.ideas.filter((i) => i.deletedAt);
  const openProject = openId ? (data.projects.find((p) => p.id === openId) ?? null) : null;
  const todayWords = data.stats.daily[localDate()] ?? 0;

  return (
    <div className="shell">
      <Sidebar
        view={view}
        onNavigate={(v) => {
          setOpenId(null);
          setView(v);
        }}
        saveState={saveState}
        saveError={saveError}
        onRetrySave={flushSave}
        aiReady={aiInfo.ready}
        trashCount={trashProjects.length + trashIdeas.length}
        projects={activeProjects}
        ideas={activeIdeas}
        onOpenProject={openProjectFromSearch}
        onSearchIdea={searchIdea}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
      />
      <main className="main">
        {dataWarnings.length > 0 && (
          <div className="data-warn">
            <span>数据目录有异常：{dataWarnings.join('；')}（可从「设置 → 从备份恢复」找回；点「已知晓」后 10 分钟内不再提醒）</span>
            <button
              className="mini-btn"
              onClick={() => {
                setDataWarnings([]);
                staleMutedUntil.current = Date.now() + 10 * 60 * 1000;
              }}
            >
              已知晓
            </button>
          </div>
        )}
        {view === 'home' && (
          <HomeView
            projects={activeProjects}
            ideas={activeIdeas}
            stats={data.stats}
            aiReady={aiInfo.ready}
            onNavigate={(v) => {
              setOpenId(null);
              setView(v);
            }}
            onOpenProject={openProjectFromSearch}
            onWizard={() => setWizardOpen(true)}
          />
        )}
        {view === 'ideas' && (
          <IdeasView
            key={`ideas-${ideaSearch.n}`}
            initialQuery={ideaSearch.q}
            ideas={activeIdeas}
            onAdd={addIdea}
            onUpdate={updateIdea}
            onDelete={(id) => updateIdea(id, { deletedAt: new Date().toISOString() })}
            onToProject={ideaToProject}
            onToProjects={ideasToProjects}
            onOpenImport={() => setImportOpen(true)}
          />
        )}
        {view === 'projects' && !openProject && (
          <ProjectsView
            projects={activeProjects}
            obsidian={obsidian}
            onOpen={setOpenId}
            onCreate={addProject}
            onUpdate={updateProject}
            onDelete={(id) => updateProject(id, { deletedAt: new Date().toISOString() })}
            onWizard={() => setWizardOpen(true)}
            onOpenImport={() => setImportOpen(true)}
            onLoadSample={sampleEnabled ? loadSample : undefined}
          />
        )}
        {view === 'projects' && openProject && (
          <WritingView
            project={openProject}
            ideas={activeIdeas}
            obsidian={obsidian}
            onUpdate={updateProject}
            onRestoreVersion={restoreVersion}
            onUpdateChapter={updateChapter}
            onAddChapter={addChapter}
            onDeleteChapter={deleteChapters}
            onMoveChapter={moveChapter}
            onRestoreChapterVersion={restoreChapterVersion}
            onDelete={(id) => {
              updateProject(id, { deletedAt: new Date().toISOString() });
              setOpenId(null);
            }}
            onBack={() => setOpenId(null)}
            aiInfo={aiInfo}
            onOpenSettings={() => setView('settings')}
            gacha={data.gacha}
            cards={data.cards}
            onGacha={updateGacha}
            onOpenGacha={() => setView('gacha')}
            onAddRule={addRule}
            onCards={(c) => setData((prev) => prev && { ...prev, cards: c })}
            todayWords={todayWords}
            obsSync={obsSync}
            promptOverrides={promptOverrides}
            ghostEnabled={ghostOn && aiInfo.ready}
          />
        )}
        {view === 'stats' && (
          <StatsView
            projects={activeProjects}
            stats={data.stats}
            onReflection={setReflection}
            onDailyGoal={setDailyGoal}
          />
        )}
        {view === 'chat' && (
          <Suspense fallback={LOADING}>
            <ChatView aiInfo={aiInfo} onOpenSettings={() => setView('settings')} promptOverrides={promptOverrides} />
          </Suspense>
        )}
        {view === 'gacha' && (
          <Suspense fallback={LOADING}>
          <GachaView
            gacha={data.gacha}
            cards={data.cards}
            netWords={Object.values(data.stats.daily).reduce((a, b) => a + b, 0)}
            goalHit={Boolean(data.stats.dailyGoal && todayWords >= data.stats.dailyGoal)}
            onGacha={updateGacha}
            onCards={(c) => setData((prev) => prev && { ...prev, cards: c })}
            projects={activeProjects}
            onGoWriting={() => {
              setView('projects');
              setOpenId(openId ?? activeProjects[0]?.id ?? null);
            }}
          />
          </Suspense>
        )}
        {view === 'trash' && (
          <TrashView
            projects={trashProjects}
            ideas={trashIdeas}
            vaultBooks={vaultBooks}
            onRestoreProject={(id) => updateProject(id, { deletedAt: '' })}
            onPurgeProject={deleteHard}
            onRestoreIdea={(id) => updateIdea(id, { deletedAt: '' })}
            onPurgeIdea={deleteIdeaHard}
          />
        )}
        {view === 'settings' && (
          <Suspense fallback={LOADING}>
          <SettingsView
            aiInfo={aiInfo}
            dataDir={dataDir}
            data={data}
            obsidian={obsidian}
            onConfigSaved={setAiInfo}
            onObsidianSaved={setObsidian}
            onRestore={restoreAll}
            promptOverrides={promptOverrides}
            onSavePrompt={savePrompt}
            ghostEnabled={ghostOn}
            onToggleGhost={setGhostOn}
          />
          </Suspense>
        )}
        {importOpen && (
          <ImportPanel
            onClose={() => setImportOpen(false)}
            onImport={importRun}
            onUndo={importUndo}
            onOpenProject={(id) => {
              setImportOpen(false);
              setOpenId(id);
              setView('projects');
            }}
            projects={activeProjects.map(
              (p): ImportProjectLite => ({
                id: p.id,
                title: p.title,
                mode: p.mode,
                chapters: (p.chapters ?? []).map((c) => ({ id: c.id, title: c.title })),
                worldNames: (p.worldItems ?? []).map((w) => w.name),
              }),
            )}
            ideas={activeIdeas}
            vaultReady={!!obsidian.vaultPath}
          />
        )}
        {wizardOpen && (
          <Suspense fallback={LOADING}>
          <ProjectWizard
            aiInfo={aiInfo}
            onClose={() => setWizardOpen(false)}
            onFinish={({ title, type, notes, outline }) => {
              const narrative = ['小说', '剧本', '故事'].includes(type);
              const chapters = narrative && outline.trim() ? parseOutlineToChapters(outline).map((c) => ({ ...c, id: uid(), content: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })) : undefined;
              const project: Project = {
                id: uid(),
                title,
                type,
                status: '大纲',
                deadline: '',
                notes,
                draft: '',
                linkedIdeaIds: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                ...(chapters && chapters.length > 0 ? { mode: 'chapters' as const, chapters } : {}),
              };
              addProject(project);
              setWizardOpen(false);
              setOpenId(project.id);
              setView('projects');
            }}
          />
          </Suspense>
        )}
      </main>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(v) => {
          setOpenId(null);
          setView(v);
        }}
        onOpenLast={() => {
          const bp = [...data.projects]
            .filter((p) => !p.deletedAt)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .find((p) => p.breakpoint);
          if (bp) {
            setOpenId(bp.id);
            setView('projects');
          }
        }}
        onWizard={() => setWizardOpen(true)}
        hasLast={activeProjects.some((p) => p.breakpoint)}
      />
    </div>
  );

  function deleteHard(id: string, vaultRoot: string) {
    setData((prev) => prev && { ...prev, projects: prev.projects.filter((p) => p.id !== id) });
    // 永久删除是故意的：横幅自动消失（删掉的书常带最新时间戳，不清的话 stale 警告会跟着挂 10 分钟）
    setDataWarnings([]);
    staleMutedUntil.current = Date.now() + 10 * 60 * 1000;
    if (!vaultRoot) return;
    // 工作台数据已删，库里那份是用户在确认框里点名要删的；删不成得喊出来，不能装作没事
    purgeVaultBook(vaultRoot).catch((err: unknown) =>
      alert(`工作台数据已删，但 Obsidian 库里那份没删成：${err instanceof Error ? err.message : String(err)}`),
    );
  }
  function deleteIdeaHard(id: string) {
    setData((prev) => prev && { ...prev, ideas: prev.ideas.filter((i) => i.id !== id) });
  }
}
