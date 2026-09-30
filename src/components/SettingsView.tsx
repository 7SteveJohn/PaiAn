import { useEffect, useRef, useState } from 'react';
import { Download, Upload, Eye, EyeOff, RefreshCw, BookMarked, FolderOpen, Plus, Trash2, ExternalLink, History } from 'lucide-react';
import type { AIPublic, AIRule, AppData, ObsidianConfig } from '../types';
import {
  saveAIConfig,
  saveAppSettings,
  saveObsidianConfig,
  testAI,
  fetchAIModels,
  openDataFolder,
  fetchAiKey,
  fetchAppSettings,
  fetchBackups,
  fetchBackupBundle,
  type BackupBundle,
  type BackupInfo,
  type RestoreExtras,
} from '../api';
import { AUTO_SYNC_MS } from '../util';
import { PROVIDERS, PROVIDER_GROUPS, QUICK_IDS, findPreset, presetOf } from '../providers';
import { PROMPT_DEFS, type PromptKey, type PromptOverrides } from '../ai-prompt';

interface Props {
  aiInfo: AIPublic;
  dataDir: string;
  data: AppData;
  obsidian: ObsidianConfig;
  onConfigSaved: (ai: AIPublic) => void;
  onObsidianSaved: (cfg: ObsidianConfig) => void;
  onRestore: (data: AppData, extras?: RestoreExtras) => Promise<string | void>;
  /** data/prompts/*.md 的提示词覆盖；onSavePrompt 落盘并同步 App 内存 */
  promptOverrides?: PromptOverrides;
  onSavePrompt?: (key: PromptKey, text: string) => Promise<void>;
  /** 幽灵字建议（App 层持有状态，写作页即时生效） */
  ghostEnabled?: boolean;
  onToggleGhost?: (next: boolean) => void;
}

export default function SettingsView({ aiInfo, dataDir, data, obsidian, onConfigSaved, onObsidianSaved, onRestore, promptOverrides, onSavePrompt, ghostEnabled, onToggleGhost }: Props) {
  const [provider, setProvider] = useState(presetOf(aiInfo.provider, aiInfo.protocol, aiInfo.baseUrl)?.id ?? 'custom');
  const [baseUrl, setBaseUrl] = useState(aiInfo.baseUrl);
  const [model, setModel] = useState(aiInfo.model);
  const [apiKey, setApiKey] = useState('');
  const keyLoadedRef = useRef(false);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelsMsg, setModelsMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [rules, setRulesState] = useState<AIRule[]>(aiInfo.rules ?? []);
  const [rulesSaved, setRulesSaved] = useState('');
  const [memoryExtract, setMemoryExtract] = useState(aiInfo.memoryExtract !== false);
  const [gateDraft, setGateDraft] = useState(aiInfo.gateDraft !== false);
  const [judgeOnly, setJudgeOnly] = useState(aiInfo.judgeOnly === true);
  const [judgeSaved, setJudgeSaved] = useState('');
  const [memExtractSaved, setMemExtractSaved] = useState('');
  const [gateSaved, setGateSaved] = useState('');
  // 通用：关 X 行为 / 启动续写 / 正文字号——都是一眼看懂的那种，不给解释文留地方
  const [closeMode, setCloseMode] = useState<'tray' | 'quit'>('tray');
  const [resumeOn, setResumeOn] = useState(() => localStorage.getItem('ww-auto-resume') === '1');
  const [docFs, setDocFs] = useState(() => localStorage.getItem('ww-doc-fs') ?? '16.5px');
  // 旧章回响 / 幽灵字建议：默认都开（localStorage 缺项即开）
  const [echoOn, setEchoOn] = useState(() => localStorage.getItem('ww-echo') !== '0');
  const [ghostOn, setGhostOn] = useState(ghostEnabled ?? true);
  // 提示词编辑：切 key 或覆盖变化时把文本框同步成「当前覆盖或内置默认」
  const [promptKey, setPromptKey] = useState<PromptKey>('advisor');
  const [promptText, setPromptText] = useState('');
  const [promptMsg, setPromptMsg] = useState('');
  useEffect(() => {
    setPromptText(promptOverrides?.[promptKey] ?? PROMPT_DEFS.find((d) => d.key === promptKey)!.fallback);
  }, [promptKey, promptOverrides]);
  const toggleEcho = () => {
    const next = !echoOn;
    setEchoOn(next);
    localStorage.setItem('ww-echo', next ? '1' : '0');
    setGenMsg(next ? '已开：续写时参考旧章片段。' : '已关。');
  };
  const toggleGhost = () => {
    const next = !ghostOn;
    setGhostOn(next);
    localStorage.setItem('ww-ghost', next ? '1' : '0');
    onToggleGhost?.(next);
    setGenMsg(next ? '已开，写作页即时生效。' : '已关，写作页即时生效。');
  };
  const savePrompt = async () => {
    if (!onSavePrompt) return;
    try {
      await onSavePrompt(promptKey, promptText);
      setPromptMsg('已保存。');
    } catch (e) {
      setPromptMsg('保存失败：' + (e as Error).message);
    }
  };
  const resetPrompt = async () => {
    if (!onSavePrompt) return;
    try {
      await onSavePrompt(promptKey, '');
      setPromptMsg('已恢复默认。');
    } catch (e) {
      setPromptMsg('保存失败：' + (e as Error).message);
    }
  };
  const [genMsg, setGenMsg] = useState("");
  useEffect(() => {
    fetchAppSettings()
      .then((s) => setCloseMode(s.closeToTray === false ? 'quit' : 'tray'))
      .catch(() => setCloseMode("tray"));
  }, []);
  const changeCloseMode = async (mode: "tray" | "quit") => {
    setCloseMode(mode);
    try {
      await saveAppSettings({ closeToTray: mode === "tray" });
      setGenMsg(mode === 'tray' ? '已设：点关闭按钮最小化到托盘。' : '已设：点关闭按钮直接退出。');
    } catch (e) {
      setGenMsg('保存失败：' + (e as Error).message);
    }
  };
  const changeDocFs = (v: string) => {
    setDocFs(v);
    localStorage.setItem('ww-doc-fs', v);
    document.documentElement.style.setProperty("--doc-fs", v);
  };
  const [exportMsg, setExportMsg] = useState('');
  const [vaultPath, setVaultPath] = useState(obsidian.vaultPath);
  const [autoSync, setAutoSync] = useState(obsidian.autoSync === true);
  const [autoSaved, setAutoSaved] = useState('');
  const [folder, setFolder] = useState(obsidian.folder);
  const [obsResult, setObsResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [savingObs, setSavingObs] = useState(false);
  const [folderMsg, setFolderMsg] = useState('');
  const [restoring, setRestoring] = useState(false);
  // 自动备份：进这一页就列一次（只是读目录），出事那天不用再去文件夹里翻
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [backupDay, setBackupDay] = useState('');
  const [backupMsg, setBackupMsg] = useState('');
  const [restoringDay, setRestoringDay] = useState('');

  useEffect(() => {
    fetchBackups()
      .then((list) => {
        setBackups(list);
        setBackupDay(list[0]?.day ?? '');
      })
      .catch((e: Error) => {
        setBackups([]);
        setBackupMsg('读不到自动备份列表：' + e.message);
      });
  }, []);

  // 已存 Key 静默载入：密码框显示圆点（******），眼睛睁开才看明文
  useEffect(() => {
    if (!aiInfo.hasKey || keyLoadedRef.current) return;
    keyLoadedRef.current = true;
    fetchAiKey()
      .then((k) => k && setApiKey(k))
      .catch(() => {});
  }, [aiInfo.hasKey]);

  const openFolder = async () => {
    try {
      await openDataFolder();
      setFolderMsg('已在资源管理器中打开数据目录');
    } catch (err) {
      setFolderMsg((err as Error).message);
    }
  };

  const moveDataFolder = async () => {
    const wb = (window as unknown as { wb?: { pickDataDir?: () => Promise<string>; moveDataDir?: (t: string) => Promise<{ ok: boolean; switched?: boolean; error?: string }> } }).wb;
    if (!wb?.pickDataDir || !wb.moveDataDir) {
      setFolderMsg('数据迁移要在桌面版（安装版/便携版）里用。');
      return;
    }
    try {
      const target = await wb.pickDataDir();
      if (!target) return;
      if (!window.confirm(`把全部数据（含备份）迁移到：\n${target}\n\n迁移完成后应用会自动重启并使用新位置。继续？`)) return;
      setFolderMsg('正在迁移数据，马上就好…');
      const r = await wb.moveDataDir(target);
      if (r.ok) setFolderMsg(r.switched ? '已切换到该位置的数据，应用即将重启…' : '数据已迁移，应用即将重启并使用新位置…');
      else setFolderMsg('迁移失败：' + (r.error || '未知错误'));
    } catch (err) {
      setFolderMsg((err as Error).message);
    }
  };

  const activePreset = findPreset(provider) ?? findPreset('custom')!;
  // 订阅制厂商（如 MiMo Token Plan、智谱 Coding Plan）的当前接入点：按 baseUrl 反查
  const activePlan = activePreset.plans?.find((pl) => pl.baseUrl === baseUrl);
  const keyFormat = activePlan?.keyFormat ?? activePreset.keyFormat;
  const keyTest = activePlan?.keyTest ?? activePreset.keyTest;
  // Key 软校验：格式不符只提醒不拦截（用户可能填中转/聚合 Key）
  const keyMismatch = Boolean(apiKey.trim() && keyTest && !keyTest.test(apiKey.trim()));
  // 模型输入框的下拉候选：供应商常用模型 + 从接口拉取到的模型，去重
  const modelOptions = [...new Set([...(activePreset.models ?? []), ...models])];

  const switchProvider = (id: string) => {
    const p = findPreset(id);
    if (!p) return;
    setProvider(id);
    setBaseUrl(p.baseUrl);
    setModel(p.model);
    setApiKey(''); // Key 是跟着供应商走的：不 clears 会让人以为上一家的 Key 还能用
    setModels([]);
    setModelsMsg(null);
    setResult(null);
  };

  const loadModels = () => {
    if (!baseUrl.trim()) {
      setModelsMsg({ ok: false, text: '请先填写接口地址' });
      return;
    }
    setLoadingModels(true);
    setModelsMsg(null);
    // 用表单里正在编辑的值去查：看一眼列表不该顺手把没确认的配置写进盘里
    fetchAIModels({ baseUrl, apiKey: apiKey || undefined, protocol: activePreset.protocol })
      .then((ms) => {
        setModels(ms);
        setModelsMsg(ms.length ? { ok: true, text: `已获取 ${ms.length} 个模型` } : { ok: false, text: '接口未返回任何模型' });
      })
      .catch((e: Error) => setModelsMsg({ ok: false, text: e.message }))
      .finally(() => setLoadingModels(false));
  };

  const saveAndTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const ai = await saveAIConfig({ provider, baseUrl, model, protocol: activePreset.protocol, apiKey: apiKey || undefined });
      onConfigSaved(ai);
      const r = await testAI();
      setResult(r);
    } catch (err) {
      setResult({ ok: false, message: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };

  // 规则改动自动保存：同屏三个开关都是点一下就存，规则却要点「保存规则」——按开关的习惯用规则区，切走就白改了
  const rulesDirty = useRef(false);
  const setRules = (updater: (rs: AIRule[]) => AIRule[]) => {
    rulesDirty.current = true;
    setRulesState(updater);
  };
  useEffect(() => {
    if (!rulesDirty.current) return;
    const t = setTimeout(() => {
      rulesDirty.current = false;
      void saveRules();
    }, 900);
    return () => clearTimeout(t);
  });
  const saveRules = async () => {
    try {
      const ai = await saveAIConfig({ provider, baseUrl, model, protocol: activePreset.protocol, rules });
      onConfigSaved(ai);
      setRulesSaved(`已保存，${ai.rules?.filter((r) => r.on).length ?? 0} 条规则将注入所有 AI 调用`);
    } catch (err) {
      setRulesSaved('保存失败：' + (err as Error).message);
    }
  };

  const toggleMemoryExtract = async () => {
    const next = !memoryExtract;
    // 先本地翻转给即时反馈，失败再回滚
    setMemoryExtract(next);
    setMemExtractSaved('保存中…');
    try {
      const ai = await saveAIConfig({ provider, baseUrl, model, protocol: activePreset.protocol, memoryExtract: next });
      onConfigSaved(ai);
      setMemExtractSaved(next ? '已开启：采纳 AI 正文后会同步更新人物卡' : '已关闭：采纳正文不再自动更新人物卡');
    } catch (err) {
      setMemoryExtract(memoryExtract);
      setMemExtractSaved('保存失败：' + (err as Error).message);
    }
  };

  const toggleGate = async () => {
    const next = !gateDraft;
    setGateDraft(next);
    setGateSaved('保存中…');
    try {
      const ai = await saveAIConfig({ provider, baseUrl, model, protocol: activePreset.protocol, gateDraft: next });
      onConfigSaved(ai);
      setGateDraft(ai.gateDraft !== false);
      setGateSaved(next ? '已开启：批量生成前先查细纲与未采纳草稿' : '已关闭：批量生成不再拦截，直接开跑');
    } catch (err) {
      setGateDraft(gateDraft);
      setGateSaved('保存失败：' + (err as Error).message);
    }
  };

  const toggleJudge = async () => {
    const next = !judgeOnly;
    setJudgeOnly(next);
    setJudgeSaved('保存中…');
    try {
      const ai = await saveAIConfig({ provider, baseUrl, model, protocol: activePreset.protocol, judgeOnly: next });
      onConfigSaved(ai);
      setJudgeOnly(ai.judgeOnly === true);
      setJudgeSaved(next ? '已开启：续写 / 润色 / 扩写 改成给判断，批量出稿按住，结果区不给「插进正文」' : '已关闭：AI 照旧可以直接产出正文草稿');
    } catch (err) {
      setJudgeOnly(judgeOnly);
      setJudgeSaved('保存失败：' + (err as Error).message);
    }
  };

  // 备份由服务端拼装：客户端内存里已经不带历史快照了，自己拼会导出一份缺快照的备份
  const exportBackup = () => {
    setExportMsg('正在打包（含历史快照，书大的要几秒）…');
    const a = document.createElement('a');
    a.href = '/api/export';
    a.download = `workbench-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setExportMsg('已开始下载：备份含正文与历史快照，由服务端直接拼装，不经过界面内存。');
  };

  /** 两条恢复入口（备份文件 / 自动备份）共用：整包交给 App，另外三份资产一起递过去 */
  const runRestore = async (b: BackupBundle) => {
    if (!Array.isArray(b.projects) || !Array.isArray(b.ideas)) throw new Error('这份数据里没有 projects / ideas 数组，不像是本工作台的备份');
    return onRestore(
      {
        ideas: b.ideas,
        projects: b.projects,
        stats: b.stats ?? { daily: {}, reflection: '' },
        // 老备份里没有这两项：用当前值接着，别把抽卡账本清成零
        gacha: b.gacha ?? data.gacha,
        cards: b.cards ?? data.cards,
      },
      { chat: b.chat?.sessions, benchmarks: b.benchmarks, ai: b.ai && typeof b.ai === 'object' ? b.ai : null },
    );
  };

  // 从导出的 JSON 备份恢复：整包覆盖 ideas / projects / stats + 对话、对标、AI 配置
  const restoreBackup = async (file: File) => {
    setFolderMsg('');
    try {
      const parsed = JSON.parse(await file.text()) as BackupBundle;
      if (!Array.isArray(parsed.projects) || !Array.isArray(parsed.ideas)) {
        throw new Error('文件里没有 projects / ideas 数组，不像是本工作台的备份');
      }
      const when = parsed.exportedAt ? `\n备份时间：${parsed.exportedAt.slice(0, 10)}` : '';
      const ok = window.confirm(
        `即将用备份覆盖当前全部数据：\n\n项目 ${parsed.projects.length} 个、灵感 ${parsed.ideas.length} 条${when}\n\n` +
          `当前数据会被替换（服务每天首次启动的自动备份不受影响）。建议先点「导出全部数据备份」留一份现状。\n\n确定继续？`,
      );
      if (!ok) return;
      setRestoring(true);
      const warn = await runRestore(parsed);
      setFolderMsg(`已从备份恢复：项目 ${parsed.projects.length} 个、灵感 ${parsed.ideas.length} 条。${warn ? `（${warn}）` : ''}`);
    } catch (err) {
      setFolderMsg('恢复失败：' + (err as Error).message);
    } finally {
      setRestoring(false);
    }
  };

  /** 从某天的自动备份恢复：服务端把 backups/<日期>/ 那堆分文件拼成整包，走同一条恢复路径 */
  const restoreFromDay = async () => {
    const day = backupDay;
    if (!day) return;
    const rows = backups?.find((b) => b.day === day);
    const size = rows ? `（${rows.files} 个文件，约 ${Math.max(1, Math.round(rows.bytes / 1024))} KB）` : '';
    if (
      !window.confirm(
        `用 ${day} 的自动备份覆盖当前全部数据？${size}\n\n` +
          `项目、灵感、统计、卡池、对话与对标记录都会换成那天首次启动时的样子。\n` +
          `当前数据会被替换（不会先自动反向备份），建议先点「导出全部数据备份」留一份现状。\n\n确定继续？`,
      )
    )
      return;
    setRestoringDay(day);
    setBackupMsg(`正在读取 ${day} 的备份…`);
    try {
      const b = await fetchBackupBundle(day);
      const warn = await runRestore(b);
      setBackupMsg(`已从 ${day} 的自动备份恢复：项目 ${(b.projects ?? []).length} 个、灵感 ${(b.ideas ?? []).length} 条。${warn ? `（${warn}）` : ''}`);
    } catch (err) {
      setBackupMsg('恢复失败：' + (err as Error).message);
    } finally {
      setRestoringDay('');
    }
  };

  // ⑤ 自动同步开关：连同当前填的库路径一起存（这里改了路径没点保存时，别让开关把旧路径写回去）
  const toggleAutoSync = async () => {
    const next = !autoSync;
    setAutoSync(next);
    setAutoSaved('保存中…');
    try {
      const cfg = await saveObsidianConfig({ vaultPath: vaultPath.trim(), folder, autoSync: next });
      onObsidianSaved(cfg);
      setAutoSync(cfg.autoSync === true);
      setAutoSaved(
        cfg.autoSync
          ? `已开启：写作页停下 ${AUTO_SYNC_MS / 1000} 秒自己推一次，遇到冲突会停手等你判定`
          : '已关闭：只有你点「同步 / 全部同步」才会动库里的文件',
      );
    } catch (err) {
      setAutoSync(autoSync);
      setAutoSaved('保存失败：' + (err as Error).message);
    }
  };

  const saveVault = async () => {
    setSavingObs(true);
    setObsResult(null);
    try {
      const cfg = await saveObsidianConfig({ vaultPath, folder });
      onObsidianSaved(cfg);
      setObsResult({ ok: true, message: '已保存，库连接正常。' });
    } catch (err) {
      setObsResult({ ok: false, message: (err as Error).message });
    } finally {
      setSavingObs(false);
    }
  };

  /** 跳转 Obsidian：桌面版走主进程拼的 obsidian:// URI，浏览器模式只能提示手动打开 */
  const openInObsidian = () => {
    const bridge = (
      window as unknown as {
        wb?: { openVault?: (v: { vaultPath: string; vaultName: string; file?: string }) => Promise<{ ok: boolean; folder?: boolean; error?: string }> };
      }
    ).wb;
    if (!bridge?.openVault) {
      setObsResult({ ok: false, message: '只有桌面版能直接跳转 Obsidian；浏览器里请手动打开库文件夹。' });
      return;
    }
    const trimmed = vaultPath.replace(/[\\/]+$/, '');
    bridge
      .openVault({ vaultPath: trimmed, vaultName: trimmed.split(/[\\/]/).pop() ?? '', file: folder.trim() || undefined })
      .then((r) =>
        setObsResult(
          r.ok
            ? { ok: true, message: r.folder ? '没找到 Obsidian，已改为打开库文件夹。' : '已交给 Obsidian。' }
            : { ok: false, message: r.error || '跳转失败' },
        ),
      )
      .catch((e: Error) => setObsResult({ ok: false, message: e.message }));
  };

  return (
    <>
      <header className="view-head">
        <div className="overline">SETTINGS · 本地配置</div>
        <h1>设置</h1>
        <hr className="head-rule" />
      </header>

      <div className="settings-grid">
        <section className="panel">
          <h3>通用</h3>
          <div className="form-rows">
            <label className="field">
              <span className="field-label">点关闭按钮时</span>
              <select
                className="provider-select"
                value={closeMode}
                onChange={(e) => void changeCloseMode(e.target.value as "tray" | "quit")}
              >
                <option value="tray">最小化到托盘（后台照常）</option>
                <option value="quit">退出程序</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">启动时回到上次写到的位置</span>
              <button
                className={'chip' + (resumeOn ? ' on' : '')}
                onClick={() => {
                  const next = !resumeOn;
                  setResumeOn(next);
                  localStorage.setItem('ww-auto-resume', next ? '1' : '0');
                  setGenMsg(next ? '已开：启动后直接打开上次在写的书。' : '已关。');
                }}
              >
                {resumeOn ? '开' : '关'}
              </button>
            </label>
            <label className="field">
              <span className="field-label">正文字号</span>
              <select className="provider-select" value={docFs} onChange={(e) => changeDocFs(e.target.value)}>
                <option value="15px">小</option>
                <option value="16.5px">标准</option>
                <option value="18px">大</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">旧章回响</span>
              <button
                className={'chip' + (echoOn ? ' on' : '')}
                onClick={toggleEcho}
              >
                {echoOn ? '开' : '关'}
              </button>
              <span className="hint">写长篇时自动把相关旧章片段带给 AI 参考</span>
            </label>
            <label className="field">
              <span className="field-label">幽灵字建议</span>
              <button
                className={'chip' + (ghostOn ? ' on' : '')}
                onClick={toggleGhost}
              >
                {ghostOn ? '开' : '关'}
              </button>
              <span className="hint">停手时显示灰字下一句，按 Tab 采纳进正文</span>
            </label>
          </div>
          {genMsg && <p className="hint">{genMsg}</p>}
        </section>

        <section className="panel">
          <h3>提示词</h3>
          <div className="form-rows">
            <label className="field">
              <span className="field-label">要改哪一段</span>
              <select className="provider-select" value={promptKey} onChange={(e) => setPromptKey(e.target.value as PromptKey)}>
                {PROMPT_DEFS.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">内容（占位符会按当前作品回填）</span>
              <textarea rows={8} value={promptText} onChange={(e) => setPromptText(e.target.value)} />
            </label>
          </div>
          <div className="form-actions">
            <button className="btn small primary" onClick={savePrompt}>
              保存
            </button>
            <button className="btn small" onClick={resetPrompt}>
              恢复默认
            </button>
            {promptMsg && <span className="hint">{promptMsg}</span>}
          </div>
        </section>

        <section className="panel">
          <h3>AI 模型服务</h3>
          <p className="hint">
            内置 {PROVIDERS.length} 家供应商（国内云 / 海外 / 聚合中转 / 本地），除 OpenAI 兼容协议外也支持 Anthropic 原生协议。
            云端填 Key，本地模型无需 Key。配置只保存在本机 <code>data/ai.json</code>。
            {aiInfo.ready ? '当前已可用。' : '尚未配置完成。'}
          </p>
          <div className="preset-row">
            {QUICK_IDS.map((id) => {
              const p = findPreset(id);
              if (!p) return null;
              return (
                <button key={p.id} className={'chip' + (provider === p.id ? ' on' : '')} onClick={() => switchProvider(p.id)}>
                  {p.name}
                </button>
              );
            })}
          </div>
          <div className="form-rows">
            <label className="field">
              <span className="field-label">
                供应商（{PROVIDERS.length} 家，下拉按分组查看）
                {activePreset.protocol === 'anthropic' && <em className="proto-tag">Anthropic 协议 · /v1/messages</em>}
              </span>
              <select className="provider-select" value={provider} onChange={(e) => switchProvider(e.target.value)}>
                {PROVIDER_GROUPS.map((g) => (
                  <optgroup key={g} label={g}>
                    {PROVIDERS.filter((p) => p.group === g).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.protocol === 'anthropic' ? '（Anthropic 协议）' : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            {activePreset.note && <p className="hint note-line">{activePreset.note}</p>}
            <label className="field">
              接口地址（Base URL）
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={activePreset.baseUrl || 'https://…/v1'} />
              {activePreset.plans && activePreset.plans.length > 0 && (
                <span className="model-quick">
                  <span className="field-label">计费方案 / 接入点</span>
                  {activePreset.plans.map((pl) => (
                    <button
                      key={pl.baseUrl}
                      className={'chip tiny' + (baseUrl === pl.baseUrl ? ' on' : '')}
                      onClick={() => setBaseUrl(pl.baseUrl)}
                    >
                      {pl.name}
                    </button>
                  ))}
                </span>
              )}
            </label>
            <div className="field">
              <span className="field-label">模型名称</span>
              <span className="model-row">
                <input value={model} onChange={(e) => setModel(e.target.value)} list="model-options" placeholder={activePreset.model || '点右侧「获取模型列表」选择'} />
                <datalist id="model-options">
                  {modelOptions.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <button className="btn small" onClick={loadModels} disabled={loadingModels} title="从接口拉取可用/已安装模型">
                  {loadingModels ? <RefreshCw size={13} className="spin" /> : <><RefreshCw size={13} /> 获取模型列表</>}
                </button>
              </span>
              {modelsMsg && <span className={'field-msg ' + (modelsMsg.ok ? 'ok' : 'fail')}>{modelsMsg.text}</span>}
              {activePreset.models && activePreset.models.length > 0 && (
                <span className="model-quick">
                  <span className="field-label">常用模型</span>
                  {activePreset.models.map((m) => (
                    <button key={m} className={'chip tiny' + (model === m ? ' on' : '')} onClick={() => setModel(m)}>
                      {m}
                    </button>
                  ))}
                </span>
              )}
            </div>
            {activePreset.needKey ? (
              <label className="field">
                <span className="field-label">
                  API Key
                  {activePreset.keyUrl && (
                    <a className="key-link" href={activePreset.keyUrl} target="_blank" rel="noreferrer">
                      去申请 Key <ExternalLink size={11} />
                    </a>
                  )}
                </span>
                <span className="key-row">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={keyFormat || 'sk-…'}
                  />
                  <button
                    className="icon-btn"
                    onClick={async () => {
                      if (!apiKey && aiInfo.hasKey) {
                        try {
                          const k = await fetchAiKey();
                          if (k) {
                            setApiKey(k);
                            setShowKey(true);
                            return;
                          }
                        } catch {
                          /* 回显失败就退回普通切换 */
                        }
                      }
                      setShowKey((v) => !v);
                    }}
                    title={showKey ? '隐藏' : aiInfo.hasKey && !apiKey ? '显示已保存的 Key' : '显示'}>
                    {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </span>
                {keyMismatch && (
                  <span className="field-msg warn">
                    这个 Key 不太像 {activePreset.name} 的格式（{keyFormat}）——检查是否复制错了，或填的是中转/聚合服务的 Key（可忽略本提示继续保存）。
                  </span>
                )}
              </label>
            ) : (
              <div className="local-hint">
                {activePreset.note || '本地模型无需 API Key。'}
                {activePreset.protocol === 'ollama' && (
                  <>
                    {' '}
                    请确保 Ollama 正在运行：命令行执行 <code>ollama serve</code> 或开启 Ollama 桌面端（默认端口 11434）。
                    用 <code>ollama pull 模型名</code> 下载模型后，点上方「获取模型列表」即可选择。
                  </>
                )}
              </div>
            )}
          </div>
          <div className="form-actions">
            <button className="btn primary" onClick={saveAndTest} disabled={testing || !baseUrl.trim() || !model.trim()}>
              {testing ? (
                <>
                  <RefreshCw size={14} className="spin" /> 保存并测试中…
                </>
              ) : (
                '保存并测试连接'
              )}
            </button>
          </div>
          {result && <div className={'test-result ' + (result.ok ? 'ok' : 'fail')}>{result.ok ? `连接成功：${result.message}` : `失败：${result.message}`}</div>}

          <h3 style={{ marginTop: 26 }}>出场记忆（自动抽取）</h3>
          <div className="rule-row">
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>采纳 AI 正文后同步更新人物/设定卡</div>
              <div className="hint">每采纳一章成文，AI 会抽取本章出场人物的状态变化、战力升级、新角色与新设定，自动写回人物卡履历。抽取失败不影响正文。</div>
            </div>
            <button
              className={'chip' + (memoryExtract ? ' on' : '')}
              title={memoryExtract ? '开启中，点击关闭' : '已关闭，点击开启'}
              onClick={toggleMemoryExtract}
            >
              {memoryExtract ? '开启' : '关闭'}
            </button>
          </div>
          {memExtractSaved && <div className="hint" style={{ marginTop: 6 }}>{memExtractSaved}</div>}

          <h3 style={{ marginTop: 26 }}>批量生成前置门禁</h3>
          <div className="rule-row">
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>批量出草稿前先查这一章有没有细纲</div>
              <div className="hint">缺要点或挂着旧草稿的章会被拦下；关掉后直接开跑。</div>
            </div>
            <button
              className={'chip' + (gateDraft ? ' on' : '')}
              title={gateDraft ? '开启中，点击关闭' : '已关闭，点击开启'}
              onClick={toggleGate}
            >
              {gateDraft ? '开启' : '关闭'}
            </button>
          </div>
          {gateSaved && <div className="hint" style={{ marginTop: 6 }}>{gateSaved}</div>}

          <div className="rule-row">
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>AI 只判不写</div>
              <div className="hint">
                只给方向与问题，不产出能粘进稿子的正文；批量「生成草稿」按住，结果区收起「插入文末 / 替换所选」。分析类与游戏改编卡不受影响。
              </div>
            </div>
            <button
              className={'chip' + (judgeOnly ? ' on' : '')}
              title={judgeOnly ? '开启中，点击关闭' : '已关闭，点击开启'}
              onClick={toggleJudge}
            >
              {judgeOnly ? '开启' : '关闭'}
            </button>
          </div>
          {judgeSaved && <div className="hint" style={{ marginTop: 6 }}>{judgeSaved}</div>}

          <h3 style={{ marginTop: 26 }}>写作规则（规则中心）</h3>
          <p className="hint">启用中的规则会自动注入所有 AI 调用（工坊动作与对话）。用来固化文风约束、禁则与世界观红线。</p>
          <div className="rules-list">
            {rules.map((r, i) => (
              <div key={i} className={'rule-row' + (r.on ? ' on' : '')}>
                <input
                  className="drawer-mini-input"
                  style={{ width: 110, flex: 'none' }}
                  value={r.name}
                  placeholder="规则名"
                  onChange={(e) => setRules((rs) => rs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                />
                <textarea
                  className="rule-content"
                  value={r.content}
                  placeholder="规则内容，如：全文禁止出现『突然』；对话必须带潜台词；力量体系只允许使用已设定的境界名。"
                  onChange={(e) => setRules((rs) => rs.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))}
                />
                <button
                  className={'chip' + (r.on ? ' on' : '')}
                  title={r.on ? '启用中，点击停用' : '已停用，点击启用'}
                  onClick={() => setRules((rs) => rs.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))}
                >
                  {r.on ? '启用' : '停用'}
                </button>
                <button className="icon-btn" title="删除规则" onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
          <div className="form-actions" style={{ marginTop: 10 }}>
            <button className="btn small" onClick={() => setRules((rs) => [...rs, { name: '新规则', content: '', on: true }])}>
              <Plus size={13} /> 添加规则
            </button>
            <button className="btn small primary" onClick={saveRules}>
              保存规则
            </button>
            {rulesSaved && <span className="hint">{rulesSaved}</span>}
          </div>
        </section>



        <section className="panel">
          <h3>数据与备份</h3>
          <p className="hint">
            所有内容都以 JSON 明文保存在：
            <br />
            <code className="dir">{dataDir || '（读取中…）'}</code>
          </p>
          <p className="hint">
            想多设备同步？把整个 <code>data</code> 文件夹放进 OneDrive / 坚果云等同步盘，并在启动服务时用环境变量
            <code> DATA_DIR</code> 指向它（见 README）。
          </p>
          <div className="form-actions">
            <button className="btn" onClick={exportBackup}>
              <Download size={14} /> 导出全部数据备份
            </button>
            <button className="btn" onClick={openFolder}>
              <FolderOpen size={14} /> 打开数据目录
            </button>
            <button className="btn" onClick={moveDataFolder} title="把数据整体搬到另一个文件夹（自动复制并重启）">
              <FolderOpen size={14} /> 更改位置…
            </button>
            <label className={'btn' + (restoring ? ' disabled' : '')}>
              <Upload size={14} /> {restoring ? '恢复中…' : '从备份恢复'}
              <input
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                disabled={restoring}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = ''; // 允许连续选同一个文件
                  if (f) void restoreBackup(f);
                }}
              />
            </label>
          </div>
          {exportMsg && <p className="hint">{exportMsg}</p>}

          <div className="form-actions" style={{ marginTop: 14 }}>
            {backups === null ? (
              <span className="hint">正在查自动备份…</span>
            ) : backups.length === 0 ? (
              <span className="hint">
                还没有自动备份。每天首次启动备份一次，保留 7 天。
              </span>
            ) : (
              <>
                <span className="hint">
                  <History size={13} style={{ verticalAlign: -2 }} /> 自动备份（每天首次启动一份，留 7 天）：
                </span>
                <select className="obs-pick" value={backupDay} onChange={(e) => setBackupDay(e.target.value)} title="选一天，把那天启动时的数据整包恢复回来">
                  {backups.map((b) => (
                    <option key={b.day} value={b.day}>
                      {b.day} · {b.files} 个文件 · {Math.max(1, Math.round(b.bytes / 1024))} KB
                    </option>
                  ))}
                </select>
                <button className="btn danger" onClick={restoreFromDay} disabled={!backupDay || !!restoringDay}>
                  <History size={14} /> {restoringDay ? `恢复 ${restoringDay} 中…` : '恢复这一天的备份'}
                </button>
              </>
            )}
          </div>
          {backupMsg && <p className="hint">{backupMsg}</p>}
          <p className="hint">
            「从备份恢复」整包替换当前数据（含快照与对话）；备份不含 API Key，本机 Key 保留。恢复前先导出一份现状。
          </p>
          {folderMsg && <p className="hint">{folderMsg}</p>}
        </section>

        <section className="panel obs-panel">
          <h3>
            <BookMarked size={16} /> Obsidian 知识库
          </h3>
          <p className="hint">
            填写 Obsidian 库（Vault）的文件夹路径后：灵感库可以浏览并导入库内笔记；作品可<strong>双向同步</strong>
            ——一物一文件（书名做目录，章节 / 人物卡 / 设定卡各一篇，外加一张索引页），正文里的人物与地点自动写成
            <code>[[双链]]</code>，Obsidian 的图谱与反向链接直接能用。你在库里改过的内容会被<strong>读回</strong>工作台；
            两边都改过的文件算冲突，会列出来让你逐条判定，不会静默覆盖任何一边。无需安装任何 Obsidian 插件。
            {obsidian.vaultPath ? '当前已连接库。' : '尚未配置。'}
          </p>
          <div className="form-rows">
            <label className="field">
              库路径（Vault 文件夹）
              <input
                value={vaultPath}
                onChange={(e) => setVaultPath(e.target.value)}
                placeholder="例如 D:\Notes\MyVault"
              />
            </label>
            <label className="field">
              库内子文件夹（同步产物放这里，可留空=库根目录）
              <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="创作工作台" />
            </label>
          </div>
          <div className="form-actions">
            <button className="btn primary" onClick={saveVault} disabled={savingObs || !vaultPath.trim()}>
              {savingObs ? (
                <>
                  <RefreshCw size={14} className="spin" /> 保存中…
                </>
              ) : (
                '保存库配置'
              )}
            </button>
            <button className="btn" onClick={openInObsidian} disabled={!vaultPath.trim()}>
              在 Obsidian 里打开
            </button>
          </div>
          <div className="rule-row">
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>自动同步到库</div>
              <div className="hint">
                开着时，写作页停下 {AUTO_SYNC_MS / 1000} 秒就自己把这一本推一次到库里；判据仍走三方对比——只有我方变了的才写文件，
                库里改了这边没动会被读回来。
                <strong>遇到冲突它就停手</strong>：右下角列出来等你逐条判定，自动同步绝不自作主张选哪一边，判完才继续。
                关着时只有你点「同步 / 全部同步」才动库里的文件——后台写盘不是你想要的默认。
              </div>
            </div>
            <button
              className={'chip' + (autoSync ? ' on' : '')}
              title={autoSync ? '开启中，点击关闭' : '已关闭，点击开启'}
              onClick={toggleAutoSync}
              disabled={!vaultPath.trim()}
            >
              {autoSync ? '开启' : '关闭'}
            </button>
          </div>
          {autoSaved && <div className="hint" style={{ marginTop: 6 }}>{autoSaved}</div>}
          {obsResult && (
            <div className={'test-result ' + (obsResult.ok ? 'ok' : 'fail')}>{obsResult.message}</div>
          )}
        </section>
      </div>
    </>
  );
}
