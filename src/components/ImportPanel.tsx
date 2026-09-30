// 统一导入面板：粘贴 / 本地文件 / 文件夹 / 拖拽 / Obsidian 库 → 拆章预览（可改名·合并·删·拖动）
// → 落到哪里（新建作品 / 追加到已有作品 / 灵感库 / 设定卡 / 并入章要点）。
// 这是全项目唯一的导入入口——原先挂在灵感库的「从 Obsidian 导入」已经并进来，
// 所以它不再要求先配 Obsidian 库，也不再把「导入作品内容」这件事藏在灵感库页里。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Check, Clipboard, FileText, FolderOpen, Import, Loader, Trash2, Upload, X } from 'lucide-react';
import type { Idea, IdeaKind } from '../types';
import { fetchObsidianNote, listObsidianNotes, type ObsidianNote } from '../api';
import { entityNameOf, importedCounts, prepareForImport, previewOf } from '../obsidian-import';
import { filesFromDataTransfer, readAsSources, relativeName, type ImportSource } from '../import-file';
import { isImportable, sortByNaturalName } from '../import-text';
import { countWords } from '../util';
import {
  TARGETS,
  appendNote,
  bookTitleOf,
  buildRequest,
  clashNote,
  draftChapters,
  firstLineOf,
  gapOf,
  intoProject,
  needsChapter,
  type DraftChapter,
  type ImportOutcome,
  type ImportProjectLite,
  type ImportRequest,
  type ImportTarget,
  type ImportUndo,
} from '../import-plan';

type Tab = 'paste' | 'file' | 'obsidian';

const TABS: { key: Tab; label: string; icon: typeof FileText }[] = [
  { key: 'paste', label: '粘贴文本', icon: Clipboard },
  { key: 'file', label: '本地文件', icon: FileText },
  { key: 'obsidian', label: 'Obsidian 库', icon: BookOpen },
];

const KINDS: IdeaKind[] = ['灵感', '素材', '摘抄', '选题'];
/** 预览只渲染前若干章：几百章的稿子全铺出来，面板会卡到没法用 */
const PREVIEW_ROWS = 40;

interface Props {
  onClose: () => void;
  onImport: (req: ImportRequest) => ImportOutcome;
  /** 撤销上一次导入，返回一句话说明撤掉了什么 */
  onUndo: (list: ImportUndo[]) => string;
  onOpenProject?: (id: string) => void;
  projects: ImportProjectLite[];
  ideas: Idea[];
  /** 配了 Obsidian 库路径才显示那一栏 */
  vaultReady: boolean;
}

export default function ImportPanel({ onClose, onImport, onUndo, onOpenProject, projects, ideas, vaultReady }: Props) {
  const [tab, setTab] = useState<Tab>('paste');
  const [pasteText, setPasteText] = useState('');
  const [sources, setSources] = useState<ImportSource[]>([]);
  const [chapters, setChapters] = useState<DraftChapter[]>([]);
  const [mode, setMode] = useState<'merge' | 'separate' | ''>('merge');
  const [target, setTarget] = useState<ImportTarget>('new-book');
  const [title, setTitle] = useState('');
  const [type, setType] = useState('小说');
  const [projectId, setProjectId] = useState(projects.length === 1 ? projects[0].id : '');
  const [chapterId, setChapterId] = useState('');
  const [kind, setKind] = useState<IdeaKind>('素材');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [warn, setWarn] = useState('');
  const [receipt, setReceipt] = useState<ImportOutcome | null>(null);
  const [undoMsg, setUndoMsg] = useState('');
  const [dragging, setDragging] = useState(false);

  const [noteQuery, setNoteQuery] = useState('');
  const [notes, setNotes] = useState<ObsidianNote[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);

  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const dragFrom = useRef<number | null>(null);

  const imported = useMemo(() => importedCounts(ideas), [ideas]);
  const project = useMemo(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId]);

  // 换了作品，选中的章要失效：不能把 A 书的章 id 用到 B 书上
  useEffect(() => {
    if (chapterId && !(project?.chapters ?? []).some((c) => c.id === chapterId)) setChapterId('');
  }, [project, chapterId]);

  // Obsidian 库列表：输入停下 300ms 再查，避免每个字符打一次
  useEffect(() => {
    if (tab !== 'obsidian' || !vaultReady) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      listObsidianNotes(noteQuery)
        .then((r) => {
          if (!alive) return;
          setNotes(r.notes);
          if (r.warning) setWarn(r.warning);
        })
        .catch((e: Error) => {
          if (alive) {
            setError(e.message);
            setNotes([]);
          }
        });
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [tab, noteQuery, vaultReady]);

  const applySources = useCallback((list: ImportSource[]) => {
    setSources(list);
    setChapters(draftChapters(list));
    setMode(list.length > 1 ? '' : 'merge');
    setTitle(list.length === 1 ? bookTitleOf(list[0].name, firstLineOf(list[0].text)) : '');
    setReceipt(null);
    setUndoMsg('');
    setError('');
  // 来源文件名/首行带着「大纲」字样时，类型自动预选「大纲」——作者不用在类型表里找
  if (list.some((s) => s.name.includes("大纲") || s.text.slice(0, 200).includes("大纲"))) setType("大纲");
  }, []);

  const loadFiles = useCallback(
    async (files: File[]) => {
      const usable = sortByNaturalName(files.map((f) => ({ name: relativeName(f), file: f })));
      if (!usable.length) {
        setError('没有可读的文件（支持 .md / .markdown / .txt / .docx / .html）。');
        return;
      }
      setBusy(true);
      setError('');
      setWarn('');
      const r = await readAsSources(usable.map((x) => x.file));
      setBusy(false);
      if (r.failed.length) setWarn(`${r.failed.length} 个文件读不了，已跳过：${r.failed.map((f) => `${f.name}（${f.error}）`).join('；')}`);
      applySources(r.sources);
    },
    [applySources],
  );

  const acceptPaste = () => {
    const text = pasteText.replace(/\r\n?/g, '\n').trim();
    if (!text) {
      setError('先粘贴一点内容，再点「读取这段文本」。');
      return;
    }
    applySources([{ name: '', path: '粘贴的内容', text, encoding: '粘贴' }]);
  };

  /**
   * 读剪贴板：桌面版走主进程（navigator.clipboard 要求文档处于焦点，窗口在后面时会直接失败），
   * Web 版退回浏览器 API。读到的原文同时留在文本框里，看得见也改得动。
   */
  const readClip = async () => {
    setError('');
    setWarn('');
    try {
      const bridge = (window as unknown as { wb?: { readClipboard?: () => Promise<string> } }).wb;
      const raw = bridge?.readClipboard ? await bridge.readClipboard() : await navigator.clipboard.readText();
      const text = String(raw ?? '').replace(/\r\n?/g, '\n').trim();
      if (!text) {
        setError('剪贴板里没有文字——先复制一段再来（或者在下面按 Ctrl+V）。');
        return;
      }
      setPasteText(text);
      applySources([{ name: '', path: '剪贴板', text, encoding: '剪贴板' }]);
    } catch (e) {
      setError(`读不到剪贴板（${(e as Error).message}）——在下面按 Ctrl+V 也一样。`);
    }
  };

  const loadNotes = async () => {
    if (!picked.length) {
      setError('先在列表里点选要导入的笔记。');
      return;
    }
    setBusy(true);
    setError('');
    setWarn('');
    const list: ImportSource[] = [];
    const failed: string[] = [];
    for (const path of picked) {
      try {
        const res = await fetchObsidianNote(path);
        const prep = prepareForImport(res.content);
        list.push({ name: path.split('/').pop() ?? path, path, text: prep.content, encoding: 'obsidian' });
      } catch (e) {
        failed.push(`${path}（${(e as Error).message}）`);
      }
    }
    setBusy(false);
    if (failed.length) setWarn(`${failed.length} 篇没读成，已跳过：${failed.join('；')}`);
    applySources(sortByNaturalName(list.map((s) => ({ name: s.path, source: s }))).map((x) => x.source));
  };

  // ---------- 预览编辑 ----------

  const patchTitle = (id: string, value: string) => setChapters((prev) => prev.map((c) => (c.id === id ? { ...c, title: value } : c)));

  /** 这一行不是章：标成「转设定」后落库时进这本书的设定卡，内容不丢 */
  const markWorld = (id: string) =>
    setChapters((prev) => prev.map((c) => (c.id === id ? { ...c, asWorld: !c.asWorld } : c)));

  const removeAt = (i: number) => setChapters((prev) => prev.filter((_, k) => k !== i));

  const mergeIntoPrev = (i: number) =>
    setChapters((prev) => {
      if (i <= 0 || i >= prev.length) return prev;
      const out = [...prev];
      const before = out[i - 1];
      const cur = out[i];
      out[i - 1] = {
        ...before,
        summary: before.summary || cur.summary,
        body: [before.body, cur.title, cur.body].filter((x) => x.trim()).join('\n\n'),
      };
      out.splice(i, 1);
      return out;
    });

  const moveTo = (from: number, to: number) =>
    setChapters((prev) => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
      const out = [...prev];
      const [item] = out.splice(from, 1);
      out.splice(to, 0, item);
      return out;
    });

  /** 整篇一章：把当前拆出来的章按顺序拼成一段——拆错了不想逐条删时用这个 */
  const flattenToOne = () =>
    setChapters((prev) =>
      prev.length <= 1
        ? prev
        : [
            {
              ...prev[0],
              summary: '',
              body: prev.map((c) => [c.title, c.body].filter((x) => x.trim()).join('\n\n')).join('\n\n'),
            },
          ],
    );

  // ---------- 落点 ----------

  const alive = chapters.filter((c) => c.title.trim() || c.body.trim());
  const cardRows = alive.filter((c) => c.asWorld);
  const chapterRows = alive.filter((c) => !c.asWorld);
  const needMode = sources.length > 1 && target === 'new-book' && !mode;
  const gap = gapOf({ target, projectId, chapterId, project, chapterCount: chapterRows.length });
  const blocked = gap || (needMode ? '分了多个来源：先选「合成一本」还是「各自成书」。' : '');
  const chosen = project?.chapters.find((c) => c.id === chapterId)?.title ?? '选中的章';
  const appendWarn = target === 'append' ? appendNote(project?.mode, alive.length) : '';
  const clash = target === 'world' && project ? clashNote(title.trim() || entityNameOf(sources[0]?.name ?? ''), project.worldNames) : '';

  const submit = () => {
    if (blocked) return;
    const outcome = onImport(
      buildRequest({ target, sources, chapters, mode: mode || 'merge', title, type, projectId, chapterId, kind }),
    );
    setReceipt(outcome);
    setUndoMsg('');
    setError('');
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = await filesFromDataTransfer(e.dataTransfer);
    if (files.length) await loadFiles(files);
    else setError('拖进来的东西里没有可读的文件（支持 .md / .markdown / .txt / .docx / .html）。');
  };

  const togglePick = (path: string) => setPicked((prev) => (prev.includes(path) ? prev.filter((x) => x !== path) : [...prev, path]));

  const totalWords = chapterRows.reduce((a, c) => a + countWords(c.body), 0);
  const submitLabel =
    target === 'new-book'
      ? mode === 'separate' && sources.length > 1
        ? `导入并建成 ${new Set(alive.map((c) => c.from)).size} 部作品`
        : `导入并建成一部作品（${chapterRows.length} 章${cardRows.length ? ` + ${cardRows.length} 张设定卡` : ""}）`
      : target === 'append'
        ? `追加 ${chapterRows.length} 章${cardRows.length ? ` + ${cardRows.length} 张设定卡` : ""}`
        : target === 'world'
          ? '导入并建成设定卡'
          : target === 'beats'
            ? `并进「${chosen}」的要点`
          : target === 'outline'
            ? `并入大纲（${chapterRows.length} 段按章名分发）`
            : '导入到灵感库';

  return (
    <section
      className={'import-panel' + (dragging ? ' dragging' : '')}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="imp-head">
        <h3>
          <Import size={15} /> 导入已有内容
        </h3>
        <button className="icon-btn" onClick={onClose} title="关闭">
          <X size={15} />
        </button>
      </div>

      {receipt && (
        <div className="imp-receipt">
          <Check size={14} />
          <span>{receipt.message}</span>
          {receipt.projectId && onOpenProject && (
            <button className="btn small" onClick={() => onOpenProject(receipt.projectId!)}>
              打开这本
            </button>
          )}
          {receipt.undo?.length ? (
            undoMsg ? (
              <span className="imp-undone">{undoMsg}</span>
            ) : (
              <button className="btn small" onClick={() => setUndoMsg(onUndo(receipt.undo!))}>
                撤销这次导入
              </button>
            )
          ) : null}
        </div>
      )}
      {error && <div className="ai-error">{error}</div>}
      {warn && <div className="obs-warn">{warn}</div>}

      <div className="imp-tabs">
        {TABS.map(({ key, label, icon: Icon }) =>
          key === 'obsidian' && !vaultReady ? (
            <span key={key} className="imp-tab off" title="到「设置」填上 Obsidian 库文件夹后即可从这里导入">
              <Icon size={13} /> {label}
            </span>
          ) : (
            <button key={key} className={'imp-tab' + (tab === key ? ' on' : '')} onClick={() => setTab(key)}>
              <Icon size={13} /> {label}
            </button>
          ),
        )}
        <span className="imp-drop-hint">也可以把文件或文件夹直接拖进来</span>
      </div>

      <div className="imp-source">
        {tab === 'paste' && (
          <>
            <textarea
              className="imp-paste"
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={'把已经写好的一段贴进来——可以是整篇正文，也可以是一行一章的大纲，例如：\n第1章 落水：主角被推下河，发现水下石门\n第2章 古玉：捡到会吞噬骨头的玉'}
              rows={5}
            />
            <div className="capture-row">
              <button className="btn primary" onClick={acceptPaste} disabled={!pasteText.trim()}>
                读取这段文本
              </button>
              <button className="btn" onClick={readClip} disabled={busy}>
                <Clipboard size={14} /> 读剪贴板
              </button>
              <span className="imp-tip">识别规则：第N章 / # 第N章 / Chapter N / 3. / --- ；都没命中就整篇一章</span>
            </div>
          </>
        )}

        {tab === 'file' && (
          <div className="capture-row">
            <button className="btn" onClick={() => fileInput.current?.click()}>
              <Upload size={14} /> 选文件（可多选）
            </button>
            <button className="btn" onClick={() => dirInput.current?.click()}>
              <FolderOpen size={14} /> 选整个文件夹
            </button>
            <span className="imp-tip">支持 .md / .txt / .docx / .html；文件夹会自动跳过 .git、.obsidian、node_modules 与图片附件</span>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept=".md,.markdown,.txt,.text,.docx,.html,.htm"
              style={{ display: 'none' }}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []).filter((f) => isImportable(f.name));
                e.target.value = '';
                void loadFiles(files);
              }}
            />
            <input
              ref={dirInput}
              type="file"
              multiple
              style={{ display: 'none' }}
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []).filter((f) => isImportable(f.name));
                e.target.value = '';
                void loadFiles(files);
              }}
            />
          </div>
        )}

        {tab === 'obsidian' && vaultReady && (
          <>
            <div className="capture-row">
              <input className="search" value={noteQuery} onChange={(e) => setNoteQuery(e.target.value)} placeholder="按文件名搜索库内笔记…" />
              <button className="btn primary" onClick={loadNotes} disabled={!picked.length}>
                {busy ? <Loader size={14} className="spin" /> : <Upload size={14} />} 读取所选 {picked.length ? `(${picked.length})` : ''}
              </button>
            </div>
            <div className="imp-notes">
              {notes === null && <p className="hint">搜索中…</p>}
              {notes !== null && notes.length === 0 && <p className="hint">没有匹配的笔记。</p>}
              {notes?.map((n) => {
                const seen = imported.get(n.path) ?? 0;
                return (
                  <button key={n.path} className={'obs-item' + (picked.includes(n.path) ? ' on' : '')} onClick={() => togglePick(n.path)}>
                    <span className="obs-main">
                      <span className="obs-name">{n.name.replace(/\.md$/i, '')}</span>
                      {(n.wb || seen > 0) && (
                        <span className="obs-flags">
                          {n.wb && <em className="obs-flag">工作台导出</em>}
                          {seen > 0 && <em className="obs-flag done">已导入 {seen} 条</em>}
                        </span>
                      )}
                    </span>
                    <span className="obs-time">{new Date(n.mtime).toISOString().slice(0, 10)}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {sources.length > 0 && (
        <>
          <div className="imp-summary">
            <span>
              读到 <b>{sources.length}</b> 个来源（{sources.map((s) => s.path || '粘贴的内容').join('、')}）
              {sources[0]?.encoding === 'docx' ? ' · 按 Word 标题样式解析' : ` · ${sources[0]?.encoding}`}
            </span>
            {totalWords > 0 && <span>正文合计 {totalWords} 字</span>}
            {sources.length === 1 && previewOf(sources[0].text).truncated && <span>来源较长，预览只显示前面部分，导入的是全文</span>}
          </div>

          <div className="imp-body">
            <div className="imp-preview">
              <div className="imp-preview-head">
                <span>
                  识别到 <b>{alive.length}</b> 章{alive.length === 0 ? '（没有可导入的内容）' : ''}
                </span>
                {chapters.length > 1 && (
                  <button className="btn small" onClick={flattenToOne} title="把拆出来的章按顺序拼成一段，适合「我这就是一整篇，不该分章」">
                    整篇一章
                  </button>
                )}
              </div>
              <div className="imp-rows">
                {chapters.slice(0, PREVIEW_ROWS).map((c, i) => (
                  <div key={c.id} className="imp-row-wrap">
                    <div
                      className="imp-row"
                      draggable
                      onDragStart={() => {
                        dragFrom.current = i;
                      }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.stopPropagation();
                        if (dragFrom.current !== null) moveTo(dragFrom.current, i);
                        dragFrom.current = null;
                      }}
                    >
                      <span className="imp-grip" title="拖动排序">
                        ≡
                      </span>
                      <input className="imp-name" value={c.title} onChange={(e) => patchTitle(c.id, e.target.value)} placeholder={`第${i + 1}章`} />
                      <span className="imp-words">{countWords(c.body)} 字</span>
                      <button className="imp-act" onClick={() => mergeIntoPrev(i)} disabled={i === 0} title="与上一章合并">
                        合
                      </button>
                      {(target === 'new-book' || target === 'append') && (
                        <button
                          className={'imp-act' + (c.asWorld ? ' on' : '')}
                          onClick={() => markWorld(c.id)}
                          title={c.asWorld ? '这行将转成设定卡（再点一下取消）' : '这不是章（设定/铁律/总览…）：转成这本书的设定卡'}
                        >
                          设
                        </button>
                      )}
                      <button className="icon-btn" onClick={() => removeAt(i)} title="删掉这一章">
                        <Trash2 size={13} />
                      </button>
                    </div>
                    {c.summary && <div className="imp-sum">{c.summary}</div>}
                  </div>
                ))}
                {chapters.length > PREVIEW_ROWS && <div className="imp-more">还有 {chapters.length - PREVIEW_ROWS} 章…（导入后会全部进去）</div>}
                {cardRows.length > 0 && (
                  <div className="imp-more">
                    其中 {cardRows.length} 行标了「转设定」：不进章，落库时成为设定卡（核心设定 / 执行铁律 / …总览这类内容放这儿）。
                  </div>
                )}
              </div>
            </div>

            <div className="imp-target">
              <div className="imp-target-head">落到哪里</div>
              <div className="imp-target-list">
                {TARGETS.map((t) => (
                  <button key={t.key} className={'imp-choice' + (target === t.key ? ' on' : '')} onClick={() => setTarget(t.key)} title={t.hint}>
                    <span className="imp-dot" />
                    {t.label}
                  </button>
                ))}
              </div>
              <div className="imp-hint">{TARGETS.find((t) => t.key === target)?.hint}</div>

              {target === 'new-book' && (
                <>
                  {sources.length > 1 && (
                    <div className="capture-row">
                      <button className={'chip' + (mode === 'merge' ? ' on' : '')} onClick={() => setMode('merge')}>
                        合成一本
                      </button>
                      <button className={'chip' + (mode === 'separate' ? ' on' : '')} onClick={() => setMode('separate')}>
                        各自成书
                      </button>
                    </div>
                  )}
                  {(mode === 'merge' || sources.length === 1) && (
                    <div className="capture-row">
                      <label className="obs-named">
                        作品名
                        <input className="obs-pick" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="取文件名或正文首行" />
                      </label>
                      <select className="obs-pick" value={type} onChange={(e) => setType(e.target.value)} title="作品类型">
                        {['小说', '大纲', '剧本', '故事', '短篇', '文章'].map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </>
              )}

              {intoProject(target) && (
                <>
                  <div className="capture-row">
                    <select className="obs-pick" value={projectId} onChange={(e) => setProjectId(e.target.value)} title="落到哪本书">
                      <option value="">选择作品…</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          《{p.title}》
                        </option>
                      ))}
                    </select>
                    {needsChapter(target) && (
                      <select className="obs-pick" value={chapterId} onChange={(e) => setChapterId(e.target.value)} disabled={!project} title="并进哪一章">
                        <option value="">选择章节…</option>
                        {(project?.chapters ?? []).map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.title || '未命名'}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  {target === 'world' && (
                    <div className="capture-row">
                      <label className="obs-named">
                        卡名
                        <input
                          className="obs-pick"
                          value={title}
                          onChange={(e) => setTitle(e.target.value)}
                          placeholder={entityNameOf(sources[0]?.name ?? '')}
                        />
                      </label>
                    </div>
                  )}
                  {appendWarn && <div className="obs-warn">{appendWarn}</div>}
                  {clash && <div className="obs-warn">{clash}</div>}
                </>
              )}

              {target === 'idea' && (
                <div className="capture-row">
                  {KINDS.map((k) => (
                    <button key={k} className={'chip' + (kind === k ? ' on' : '')} onClick={() => setKind(k)}>
                      {k}
                    </button>
                  ))}
                </div>
              )}

              {blocked && <div className="imp-hint">{blocked}</div>}
            </div>
          </div>

          <div className="imp-foot">
            <span className="imp-tip">
              {target === 'new-book' && mode === 'separate' && sources.length > 1
                ? '每个来源各成一部作品：书名取文件名，各文件内再按章拆'
                : target === 'idea'
                  ? '每个来源进灵感库一条，带来源标识（下次导入会提示「已导入过」）'
                  : '拆章只影响落进作品的形态；灵感库与设定卡收的是整篇原文'}
            </span>
            <button className="btn primary" onClick={submit} disabled={!!blocked || busy}>
              {submitLabel}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
