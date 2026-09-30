import { useMemo, useState } from 'react';
import { Pin, PinOff, Trash2, ArrowRight, Check, X, Import, Copy, Download } from 'lucide-react';
import type { Idea, IdeaKind } from '../types';
import { uid } from '../util';

const KINDS: IdeaKind[] = ['灵感', '素材', '摘抄', '选题'];

const KIND_CLASS: Record<IdeaKind, string> = {
  灵感: 'kind-inspiration',
  素材: 'kind-material',
  摘抄: 'kind-quote',
  选题: 'kind-topic',
};

interface Props {
  ideas: Idea[];
  /** 打开统一的导入面板——导入不再由本页承担，这里只留一个入口 */
  onOpenImport: () => void;
  initialQuery?: string;
  onAdd: (idea: Idea) => void;
  onUpdate: (id: string, patch: Partial<Idea>) => void;
  onDelete: (id: string) => void;
  onToProject: (idea: Idea) => void;
  /** 批量转项目：不跳页，一次把选中的都建成作品 */
  onToProjects: (ideas: Idea[]) => void;
}

export default function IdeasView({ ideas, onOpenImport, initialQuery, onAdd, onUpdate, onDelete, onToProject, onToProjects }: Props) {
  const [draft, setDraft] = useState('');
  const [kind, setKind] = useState<IdeaKind>('灵感');
  const [tags, setTags] = useState('');
  const [query, setQuery] = useState(initialQuery ?? '');
  const [kindFilter, setKindFilter] = useState<IdeaKind | '全部'>('全部');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editKind, setEditKind] = useState<IdeaKind>('灵感');
  const [editTags, setEditTags] = useState('');
  const [copyMsg, setCopyMsg] = useState('');
  // 批量模式：灵感库是最容易堆积的地方，一条条删太磨人
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const togglePick = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const exitPick = () => {
    setPicking(false);
    setPicked([]);
  };

  const submit = () => {
    const content = draft.trim();
    if (!content) return;
    onAdd({
      id: uid(),
      content,
      kind,
      tags: tags
        .split(/[,，\s]+/)
        .map((t) => t.trim())
        .filter(Boolean),
      pinned: false,
      createdAt: new Date().toISOString(),
    });
    setDraft('');
    setTags('');
  };

  const exportText = () =>
    filtered
      .map((i) => {
        const head = `【${i.kind}】${i.tags.map((t) => '#' + t).join(' ')}　${i.createdAt.slice(0, 10)}${i.src ? ` ← ${i.src}` : ''}`;
        return `${head}\n${i.content}`;
      })
      .join('\n\n———\n\n');

  const copyAll = async () => {
    if (!filtered.length) return;
    try {
      await navigator.clipboard.writeText(exportText());
      setCopyMsg(`已复制 ${filtered.length} 条到剪贴板`);
    } catch (e) {
      setCopyMsg('复制失败：' + (e as Error).message);
    }
  };

  const downloadAll = () => {
    if (!filtered.length) return;
    const blob = new Blob([exportText()], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `灵感库-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setCopyMsg(`已导出 ${filtered.length} 条（.txt）`);
  };

  const filtered = useMemo(() => {
    const q = query.trim();
    return ideas
      .filter((i) => (kindFilter === '全部' ? true : i.kind === kindFilter))
      .filter((i) => !q || i.content.includes(q) || i.tags.some((t) => t.includes(q)) || (i.src ?? '').includes(q))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt));
  }, [ideas, query, kindFilter]);
  const pickedIdeas = filtered.filter((i) => picked.includes(i.id));

  return (
    <>
      <header className="view-head with-action">
        <div>
          <div className="overline">IDEA BANK · 随手记，随时取</div>
          <h1>灵感库</h1>
        </div>
        <button className="btn" onClick={onOpenImport} title="粘贴文本 / 本地文件 / 文件夹 / Obsidian 库，都能进来">
        <button className="btn" onClick={copyAll} disabled={!filtered.length} title="把当前筛选下的全部灵感复制成纯文本">
          <Copy size={14} /> 复制
        </button>
        <button className="btn" onClick={downloadAll} disabled={!filtered.length} title="把当前筛选下的全部灵感导出为 .txt">
          <Download size={14} /> 导出
        </button>
          <Import size={14} /> 导入
        </button>
      </header>
      <hr className="head-rule" />

      <section className="capture">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={ideas.length === 0 ? '第一次使用：把脑子里冒出的念头写下来——一个选题、一段素材、一句摘抄都行…' : '记一条灵感、素材、摘抄或选题…'}
        />
        <div className="capture-row">
          {KINDS.map((k) => (
            <button key={k} className={'chip' + (kind === k ? ' on' : '')} onClick={() => setKind(k)}>
              {k}
            </button>
          ))}
          <input
            className="tag-input"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="标签（逗号分隔，可留空）"
          />
          <button className="btn primary" onClick={submit} disabled={!draft.trim()}>
            收进灵感库
          </button>
        </div>
      </section>

      <div className="filters">
        <input className="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索内容或标签…" />
        {(['全部', ...KINDS] as const).map((k) => (
          <button key={k} className={'chip' + (kindFilter === k ? ' on' : '')} onClick={() => setKindFilter(k)}>
            {k}
          </button>
        ))}
        <span className="filter-count">共 {filtered.length} 条</span>
        <span className="filter-acts">
          {!picking && (
            <button className="chip" onClick={() => setPicking(true)} disabled={!filtered.length}>
              批量管理
            </button>
          )}
          {picking && (
            <>
              <span className="hint">已选 {picked.length} 条</span>
              <button
                className="chip"
                onClick={() => setPicked(picked.length === filtered.length ? [] : filtered.map((i) => i.id))}
              >
                {picked.length === filtered.length ? "取消全选" : "全选当前"}
              </button>
              <button
                className="chip"
                disabled={!picked.length}
                onClick={() => {
                  if (!window.confirm(`删掉选中的 ${picked.length} 条灵感？可在回收站恢复。`)) return;
                  picked.forEach((id) => onDelete(id));
                  setPicked([]);
                }}
              >
                删除
              </button>
              <button
                className="chip"
                disabled={!picked.length}
                onClick={() => {
                  if (!window.confirm(`把选中的 ${picked.length} 条各自建成一部作品？`)) return;
                  onToProjects(pickedIdeas);
                  setPicked([]);
                  exitPick();
                }}
              >
                转为项目
              </button>
              <button className="chip" onClick={exitPick}>
                完成
              </button>
            </>
          )}
        </span>
        {copyMsg && <span className="hint">{copyMsg}</span>}
      </div>

      {filtered.length === 0 ? (
        <div className="empty">还没有符合条件的内容，随手记一条吧。</div>
      ) : (
        <div className="masonry">
          {filtered.map((idea, idx) => (
            <article key={idea.id} className={'idea-card' + (idea.pinned ? ' pinned' : '')} style={{ animationDelay: `${Math.min(idx, 8) * 40}ms` }}>
              <div className="idea-top">
                  {picking && (
                    <input
                      type="checkbox"
                      className="idea-check"
                      checked={picked.includes(idea.id)}
                      onChange={() => togglePick(idea.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  )}
                <span className={'kind-tag ' + KIND_CLASS[idea.kind]}>{idea.kind}</span>
                <span className="idea-actions">
                  <button className="icon-btn" title={idea.pinned ? '取消置顶' : '置顶'} onClick={() => onUpdate(idea.id, { pinned: !idea.pinned })}>
                    {idea.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                  </button>
                  <button className="icon-btn" title="删除（可在回收站恢复）" onClick={() => onDelete(idea.id)}>
                    <Trash2 size={14} />
                  </button>
                </span>
              </div>
              {editingId === idea.id ? (
                <>
                  <textarea className="idea-edit" value={editText} onChange={(e) => setEditText(e.target.value)} rows={4} autoFocus />
                  <div className="idea-edit-bar">
                    {KINDS.map((k) => (
                      <button key={k} className={'chip tiny' + (editKind === k ? ' on' : '')} onClick={() => setEditKind(k)}>
                        {k}
                      </button>
                    ))}
                    <input className="tag-input" value={editTags} onChange={(e) => setEditTags(e.target.value)} placeholder="标签（逗号分隔）" />
                  </div>
                  <div className="idea-edit-bar">
                    <button
                      className="mini-btn accent"
                      onClick={() => {
                        const text = editText.trim();
                        if (text) onUpdate(idea.id, { content: text, kind: editKind, tags: editTags.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean) });
                        setEditingId(null);
                      }}
                    >
                      <Check size={13} /> 保存
                    </button>
                    <button className="mini-btn" onClick={() => setEditingId(null)}>
                      <X size={13} /> 取消
                    </button>
                  </div>
                </>
              ) : (
                <p
                  className="idea-content"
                  title="双击编辑"
                  onDoubleClick={() => {
                    setEditingId(idea.id);
                    setEditText(idea.content);
                    setEditKind(idea.kind);
                    setEditTags(idea.tags.join('，'));
                  }}
                >
                  {idea.content}
                </p>
              )}
              {idea.tags.length > 0 && (
                <div className="idea-tags">
                  {idea.tags.map((t) => (
                    <span key={t}>#{t}</span>
                  ))}
                </div>
              )}
              <div className="idea-foot">
                <span>
                  {idea.createdAt.slice(0, 10)}
                  {/* 来源只报路径，不配图标：一张卡上出现两个 Import 图标会分不出哪个是「记时间」哪个是「哪来的」 */}
                  {idea.src && <span className="idea-src" title={idea.src}> ← {idea.src}</span>}
                </span>
                <button className="mini-btn to-project" onClick={() => onToProject(idea)}>
                  转为项目 <ArrowRight size={13} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
