import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, X } from 'lucide-react';
import type { IdeaKind } from '../types';
import { fetchObsidianNote, listObsidianNotes, type ObsidianNote } from '../api';
import {
  TARGETS,
  clashNote,
  entityNameOf,
  missingTarget,
  prepareForImport,
  targetCtx,
  previewOf,
  type ImportPlan,
  type ImportProjectLite,
  type ImportTarget,
} from '../obsidian-import';

const KINDS: IdeaKind[] = ['灵感', '素材', '摘抄', '选题'];

function sizeOf(n: number): string {
  return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
}

interface Props {
  onClose: () => void;
  /** 落点与内容都在这里定好，调用方只负责分发到灵感库或某部作品 */
  onImport: (plan: ImportPlan) => void;
  /** 每篇笔记已导入灵感库几条（库内路径 → 条数） */
  imported: Map<string, number>;
  projects: ImportProjectLite[];
}

export default function ObsidianImport({ onClose, onImport, imported, projects }: Props) {
  const [query, setQuery] = useState('');
  const [notes, setNotes] = useState<ObsidianNote[] | null>(null);
  const [listWarn, setListWarn] = useState('');
  const [selected, setSelected] = useState<ObsidianNote | null>(null);
  const [content, setContent] = useState('');
  const [dropped, setDropped] = useState({ frontmatter: false, notes: false });
  const [isMirror, setIsMirror] = useState(false);
  const [kind, setKind] = useState<IdeaKind>('素材');
  const [target, setTarget] = useState<ImportTarget>('idea');
  // 只有一部书时替他选好，多了必须自己点：导错书比多点一下贵得多
  const [projectId, setProjectId] = useState(projects.length === 1 ? projects[0].id : '');
  const [chapterId, setChapterId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      listObsidianNotes(query)
        .then((r) => {
          setNotes(r.notes);
          setListWarn(r.warning);
          setError('');
        })
        .catch((e: Error) => setError(e.message));
    }, 300);
    return () => window.clearTimeout(timer.current);
  }, [query]);

  const project = useMemo(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId]);
  // 换了作品，选中的章要失效：不能把 A 书的章 id 用到 B 书上
  useEffect(() => {
    if (chapterId && !(project?.chapters ?? []).some((c) => c.id === chapterId)) setChapterId('');
  }, [project, chapterId]);

  const open = async (note: ObsidianNote) => {
    setSelected(note);
    setContent('读取中…');
    setError('');
    setName(entityNameOf(note.path));
    try {
      const res = await fetchObsidianNote(note.path);
      const prep = prepareForImport(res.content);
      setContent(prep.content);
      setDropped({ frontmatter: prep.droppedFrontmatter, notes: prep.droppedNotes });
      setIsMirror(res.wb);
    } catch (e) {
      setError((e as Error).message);
      setContent('');
    }
  };

  const seen = selected ? imported.get(selected.path) ?? 0 : 0;
  const preview = previewOf(content);
  const body = content.trim();
  const gap = missingTarget(target, targetCtx(project, chapterId));
  const meta = TARGETS.find((t) => t.key === target)!;
  const chosen = entityNameOf(selected?.path ?? '');
  const clash =
    selected && project && (target === 'world' || target === 'chapter')
      ? clashNote(name.trim() || chosen, target === 'world' ? project.worldNames : project.chapters.map((c) => c.title))
      : '';
  const chapterTitle = project?.chapters.find((c) => c.id === chapterId)?.title || '选中的章';
  const label =
    target === 'world'
      ? `建成设定卡「${name.trim() || chosen}」`
      : target === 'chapter'
        ? `新建章节「${name.trim() || chosen}」`
        : target === 'beats'
          ? `并进「${chapterTitle}」的要点`
          : isMirror
            ? '仍要导入这份镜像'
            : seen
              ? `再导一条（已导 ${seen} 条）`
              : '导入到灵感库';

  return (
    <section className="obsidian-panel">
      <div className="obs-head">
        <h3>
          <FileText size={15} /> 从 Obsidian 库导入
        </h3>
        <button className="icon-btn" onClick={onClose} title="关闭">
          <X size={15} />
        </button>
      </div>
      <input
        className="search"
        style={{ flex: 'none', width: 320 }}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="按文件名搜索库内笔记…"
      />
      {error && <div className="ai-error">{error}</div>}
      {listWarn && <div className="obs-warn">{listWarn}</div>}
      <div className="obs-body">
        <div className="obs-list">
          {notes === null && <p className="hint">搜索中…</p>}
          {notes !== null && notes.length === 0 && <p className="hint">没有匹配的笔记。</p>}
          {notes?.map((n) => {
            const seenN = imported.get(n.path) ?? 0;
            return (
              <button key={n.path} className={'obs-item' + (selected?.path === n.path ? ' on' : '')} onClick={() => open(n)}>
                <span className="obs-main">
                  <span className="obs-name">{n.name.replace(/\.md$/, '')}</span>
                  {(n.wb || seenN > 0) && (
                    <span className="obs-flags">
                      {n.wb && <em className="obs-flag">工作台导出</em>}
                      {seenN > 0 && <em className="obs-flag done">已导入 {seenN} 条</em>}
                    </span>
                  )}
                </span>
                <span className="obs-time">
                  <span>{sizeOf(n.bytes)}</span>
                  <span>{new Date(n.mtime).toISOString().slice(0, 10)}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="obs-detail">
          {!selected && <p className="hint">在左侧选择一篇笔记，预览后决定它落到哪里。</p>}
          {selected && (
            <>
              <div className="obs-detail-head">
                <strong>{selected.name.replace(/\.md$/, '')}</strong>
                <span className="sel-hint">{sizeOf(selected.bytes)}</span>
              </div>
              <div className="obs-path" title={selected.path}>
                {selected.path}
              </div>
              {isMirror && target === 'idea' && (
                <div className="obs-warn">
                  这篇带着 wb-id，是工作台自己同步出去的镜像：导进灵感库等于把自己的导出再抄一份。要导自己写的东西，请在 Obsidian 里另建一篇。
                </div>
              )}
              {(dropped.frontmatter || dropped.notes) && (
                <div className="obs-hint">
                  导入时已去掉{dropped.frontmatter ? ' 属性区' : ''}
                  {dropped.notes ? ' 批注区（你在库里写的旁注，不算正文）' : ''}。
                </div>
              )}
              {preview.truncated && <div className="obs-hint">正文太长，预览只显示前 {preview.text.length} 字，导入的是全文。</div>}
              <pre className="obs-content">{preview.text}</pre>

              <div className="capture-row">
                <span className="obs-to-label">落到</span>
                {TARGETS.map((t) => (
                  <button key={t.key} className={'chip' + (target === t.key ? ' on' : '')} onClick={() => setTarget(t.key)} title={t.hint}>
                    {t.label}
                  </button>
                ))}
              </div>
              <div className="obs-hint">{meta.hint}</div>

              {target !== 'idea' && (
                <div className="capture-row">
                  <select className="obs-pick" value={projectId} onChange={(e) => setProjectId(e.target.value)} title="导进哪本书">
                    <option value="">选择作品…</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        《{p.title}》
                      </option>
                    ))}
                  </select>
                  {meta.needsChapter && (
                    <select className="obs-pick" value={chapterId} onChange={(e) => setChapterId(e.target.value)} disabled={!project} title="并进哪一章">
                      <option value="">选择章节…</option>
                      {(project?.chapters ?? []).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title || '未命名'}
                        </option>
                      ))}
                    </select>
                  )}
                  {target !== 'beats' && (
                    <label className="obs-named">
                      叫作
                      <input className="obs-pick" value={name} onChange={(e) => setName(e.target.value)} placeholder={chosen} />
                    </label>
                  )}
                </div>
              )}
              {clash && <div className="obs-warn">{clash}</div>}
              {gap && <div className="obs-hint">{gap}</div>}

              {target === 'idea' && (
                <div className="capture-row">
                  {KINDS.map((k) => (
                    <button key={k} className={'chip' + (kind === k ? ' on' : '')} onClick={() => setKind(k)}>
                      {k}
                    </button>
                  ))}
                </div>
              )}
              <div className="capture-row">
                <button
                  className="btn primary"
                  disabled={!body || !!gap}
                  onClick={() =>
                    onImport({
                      target,
                      projectId: target === 'idea' ? '' : projectId,
                      chapterId: chapterId || undefined,
                      name: name.trim() || chosen,
                      content: body,
                      kind,
                      src: selected.path,
                    })
                  }
                >
                  {label}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
