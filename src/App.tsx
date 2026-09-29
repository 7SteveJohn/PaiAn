import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { AppData, AIPublic, Chapter, Idea, ObsidianConfig, Project, ProjectVersion, StatsData } from './types';
import { appendBeats, beatsLine, missingTarget, targetCtx, type ImportPlan } from './obsidian-import';
import { fetchData, fetchObsidianStatus, fetchVersions, purgeVaultBook, saveAIConfig, saveData, saveVersions } from './api';
import { useObsidianSync } from './useObsidianSync';
import { flattenVersions, mergeVersionsInto, pickVersionWrites, signatureOf, versionSignatures } from './versions';
import { EMPTY_STATE, EMPTY_USER, activePool, mergeCardRule, pruneHand, type GachaState } from './gacha';
import { countWords, localDate, localStamp, normalizeStats, parseOutlineToChapters, uid } from './util';
import Sidebar from './components/Sidebar';
import IdeasView from './components/IdeasView';
import ProjectsView from './components/ProjectsView';
import WritingView from './components/WritingView';
import StatsView from './components/StatsView';
import TrashView from './components/TrashView';
import HomeView from './components/HomeView';

// secondary 视图按需加载：设置页带着 30+ 供应商预设、卡池带着整副牌与动效层、
// 对话与向导带着自己的依赖——首屏不必为它们付解析成本（CodeMirror 已是同样的做法）
const SettingsView = lazy(() => import('./components/SettingsView'));
const GachaView = lazy(() => import('./components/GachaView'));
const ChatView = lazy(() => import('./components/ChatView'));
const ProjectWizard = lazy(() => import('./components/ProjectWizard'));

export type View = 'home' | 'ideas' | 'projects' | 'stats' | 'settings' | 'trash' | 'chat' | 'gacha';

const MAX_VERSIONS = 20; // 与 src/versions.ts 同值，由 tests/versions.test.ts 钉住（服务端另有一份）
const LOADING = <div className="view-loading">页面载入中…</div>;

export default function App() {
  const [view, setView] = useState<View>('home');
  const [data, setData] = useState<AppData | null>(null);
  const [aiInfo, setAiInfo] = useState<AIPublic | null>(null);
  const [dataDir, setDataDir] = useState('');
  const [obsidian, setObsidian] = useState<ObsidianConfig>({ vaultPath: '', folder: '' });
  const [openId, setOpenId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved');
  const [saveError, setSaveError] = useState('');
  const [dataWarnings, setDataWarnings] = useState<string[]>([]);
  const [ideaSearch, setIdeaSearch] = useState({ q: '', n: 0 });
  const [wizardOpen, setWizardOpen] = useState(false);
  // 回收站的「连库里副本一起删」要问得出来：进回收站时看一眼同步状态表（轻接口，不扫库）
  const [vaultBooks, setVaultBooks] = useState<{ root: string; book: string }[]>([]);
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    localStorage.getItem('ww-theme') === 'dark' ? 'dark' : 'light',
  );
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
  const persist = useCallback(async () => {
    const d = dataRef.current;
    if (!d) return;
    setSaveState('saving');
    try {
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
      setSaveState('saved');
      setSaveError('');
      if (stale) {
        // 整包保存模型的唯一丢数据路径：另一个标签页从更旧的状态出发盖了新改动
        setDataWarnings((prev) =>
          prev.some((w) => w.includes('另一个窗口'))
            ? prev
            : [...prev, '这次写入的内容比磁盘上已有的更旧——可能有另一个窗口或标签页的新改动被覆盖了。当日自动备份在数据目录 backups/ 里，可以从「设置 → 从备份恢复」找回。'],
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

  // 从备份整包恢复：先落盘再更新内存，写盘失败则保留原数据不动（快照同步覆盖）
  const restoreAll = useCallback(async (next: AppData) => {
    await saveData(next);
    const flat = flattenVersions(next.projects);
    await saveVersions(flat, 'replace');
    const sigs = versionSignatures(flat);
    sentVersions.current = sigs;
    // 恢复进来的快照就是内存里的事实，后续按 merge 增量发即可
    loadedVersions.current = new Set(next.projects.map((p) => p.id));
    versionCounts.current = {};
    for (const [k, list] of Object.entries(flat)) versionCounts.current[k] = list.length;
    setData({ ...next, gacha: next.gacha ?? EMPTY_STATE, cards: next.cards ?? EMPTY_USER });
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

  // 全局快捷键：Ctrl+K 搜索、Ctrl+S 保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('.gs-input')?.focus();
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

  const addChapter = useCallback((projectId: string, title?: string, summary?: string) => {
    setData((prev) => {
      if (!prev) return prev;
      const now = new Date().toISOString();
      const projects = prev.projects.map((p) => {
        if (p.id !== projectId) return p;
        const n = (p.chapters?.length ?? 0) + 1;
        return {
          ...p,
          mode: 'chapters' as const,
          chapters: [...(p.chapters ?? []), { id: uid(), title: title?.trim() || `第${n}章`, content: '', summary, createdAt: now, updatedAt: now }],
        };
      });
      return { ...prev, projects };
    });
  }, []);

  const deleteChapter = useCallback((projectId: string, chapterId: string) => {
    setData((prev) => {
      if (!prev) return prev;
      const projects = prev.projects.map((p) => {
        if (p.id !== projectId) return p;
        return { ...p, chapters: (p.chapters ?? []).filter((c) => c.id !== chapterId), marks: (p.marks ?? []).filter((m) => m.chapterId !== chapterId) };
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
    (idea: Idea) => {
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
      setOpenId(project.id);
      setView('projects');
    },
    [addProject],
  );

  /**
   * ④ 一次「导进作品」的落库：设定卡 / 新章 / 并进某章要点。
   * 返回一句回执给灵感库显示——不跳页：他从灵感库出发，就该停在那里，要看结果自己点开那本书。
   */
  const importEntity = useCallback(
    (plan: ImportPlan): string => {
      const target = data?.projects.find((p) => p.id === plan.projectId);
      if (!target) return '那本书找不到了（可能刚被删掉），这次没有导入。';
      // 与面板同一份判据：界面禁用了不够，落库这一侧自己得再问一次（否则哪天面板改了，这边就漏）
      const gap = missingTarget(plan.target, targetCtx(target, plan.chapterId ?? ''));
      if (gap) return `这次没有导入：${gap}`;
      const now = new Date().toISOString();
      setData((prev) => {
        if (!prev) return prev;
        const projects = prev.projects.map((p) => {
          if (p.id !== plan.projectId) return p;
          if (plan.target === 'world') {
            return { ...p, updatedAt: now, worldItems: [...(p.worldItems ?? []), { id: uid(), name: plan.name, kind: '设定' as const, content: plan.content }] };
          }
          if (plan.target === 'chapter') {
            const n = (p.chapters?.length ?? 0) + 1;
            return {
              ...p,
              updatedAt: now,
              mode: 'chapters' as const,
              chapters: [...(p.chapters ?? []), { id: uid(), title: plan.name || `第${n}章`, content: plan.content, volume: '', beats: '', createdAt: now, updatedAt: now }],
            };
          }
          if (plan.target === 'beats') {
            return {
              ...p,
              updatedAt: now,
              chapters: (p.chapters ?? []).map((c) =>
                c.id === plan.chapterId ? { ...c, beats: appendBeats(c.beats, beatsLine(plan.name, plan.content)), updatedAt: now } : c,
              ),
            };
          }
          return p;
        });
        return { ...prev, projects };
      });
      const where =
        plan.target === 'world'
          ? `设定卡「${plan.name}」`
          : plan.target === 'chapter'
            ? `新章「${plan.name}」（${plan.content.length} 字）`
            : `${target.chapters?.find((c) => c.id === plan.chapterId)?.title || '那一章'}的要点`;
      return `已导进《${target.title}》：${where}`;
    },
    [data],
  );

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
            <span>数据目录有异常：{dataWarnings.join('；')}（先别继续写，可从「设置 → 从备份恢复」找回）</span>
            <button className="mini-btn" onClick={() => setDataWarnings([])}>
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
            obsidian={obsidian}
            onAdd={addIdea}
            onUpdate={updateIdea}
            projects={activeProjects}
            onImportEntity={importEntity}
            onDelete={(id) => updateIdea(id, { deletedAt: new Date().toISOString() })}
            onToProject={ideaToProject}
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
            onDeleteChapter={deleteChapter}
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
            <ChatView aiInfo={aiInfo} onOpenSettings={() => setView('settings')} />
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
          />
          </Suspense>
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
    </div>
  );

  function deleteHard(id: string, vaultRoot: string) {
    setData((prev) => prev && { ...prev, projects: prev.projects.filter((p) => p.id !== id) });
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
