import { useMemo, useState } from 'react';
import { Pin, PinOff, Trash2, ArrowRight, Check, X, Import } from 'lucide-react';
import type { Idea, IdeaKind, ObsidianConfig, Project } from '../types';
import { uid } from '../util';
import { importedCounts, type ImportPlan, type ImportProjectLite } from '../obsidian-import';
import ObsidianImport from './ObsidianImport';

const KINDS: IdeaKind[] = ['灵感', '素材', '摘抄', '选题'];

const KIND_CLASS: Record<IdeaKind, string> = {
  灵感: 'kind-inspiration',
  素材: 'kind-material',
  摘抄: 'kind-quote',
  选题: 'kind-topic',
};

interface Props {
  ideas: Idea[];
  obsidian: ObsidianConfig;
  /** ④ 导入可选目标：面板要知道能导进哪几本书、每本有哪些章 */
  projects: Project[];
  onImportEntity: (plan: ImportPlan) => string;
  initialQuery?: string;
  onAdd: (idea: Idea) => void;
  onUpdate: (id: string, patch: Partial<Idea>) => void;
  onDelete: (id: string) => void;
  onToProject: (idea: Idea) => void;
}

export default function IdeasView({ ideas, obsidian, projects, onImportEntity, initialQuery, onAdd, onUpdate, onDelete, onToProject }: Props) {
  const [draft, setDraft] = useState('');
  const [kind, setKind] = useState<IdeaKind>('灵感');
  const [tags, setTags] = useState('');
  const [query, setQuery] = useState(initialQuery ?? '');
  const [kindFilter, setKindFilter] = useState<IdeaKind | '全部'>('全部');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importMsg, setImportMsg] = useState('');

  const importFromVault = (plan: ImportPlan) => {
    setImportOpen(false);
    if (plan.target === 'idea') {
      onAdd({
        id: uid(),
        content: plan.content,
        kind: (plan.kind as IdeaKind) || '素材',
        tags: ['obsidian'],
        pinned: false,
        createdAt: new Date().toISOString(),
        src: plan.src,
      });
      return;
    }
    setImportMsg(onImportEntity(plan));
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

  const filtered = useMemo(() => {
    const q = query.trim();
    return ideas
      .filter((i) => (kindFilter === '全部' ? true : i.kind === kindFilter))
      .filter((i) => !q || i.content.includes(q) || i.tags.some((t) => t.includes(q)) || (i.src ?? '').includes(q))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt));
  }, [ideas, query, kindFilter]);

  // 每篇笔记导入过几条：面板靠它把「已经导过了」显出来，而不是让人凭记忆数
  const imported = useMemo(() => importedCounts(ideas), [ideas]);

  // 只把面板用得到的字段传下去（含已有设定卡名，用来提醒重名）
  const lite: ImportProjectLite[] = useMemo(
    () =>
      projects.map((p) => ({
        id: p.id,
        title: p.title,
        mode: p.mode ?? 'single',
        chapters: (p.chapters ?? []).map((c) => ({ id: c.id, title: c.title })),
        worldNames: (p.worldItems ?? []).map((w) => w.name),
      })),
    [projects],
  );

  return (
    <>
      <header className="view-head with-action">
        <div>
          <div className="overline">IDEA BANK · 随手记，随时取</div>
          <h1>灵感库</h1>
        </div>
        <button
          className="btn"
          onClick={() => {
            if (obsidian.vaultPath) {
              setImportMsg(''); // 上一条回执说完就收，重开面板别还挂着
              setImportOpen(true);
            }
            else alert('请先到「设置」配置 Obsidian 库路径');
          }}
        >
          <Import size={14} /> 从 Obsidian 导入
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
      </div>

      {importOpen && <ObsidianImport onClose={() => setImportOpen(false)} onImport={importFromVault} imported={imported} projects={lite} />}
      {/* 回执在面板关掉之后才显示——导进作品不跳页，总得说一句「进去了什么」 */}
      {!importOpen && importMsg && <div className="import-msg">{importMsg}</div>}

      {filtered.length === 0 ? (
        <div className="empty">还没有符合条件的内容，随手记一条吧。</div>
      ) : (
        <div className="masonry">
          {filtered.map((idea, idx) => (
            <article key={idea.id} className={'idea-card' + (idea.pinned ? ' pinned' : '')} style={{ animationDelay: `${Math.min(idx, 8) * 40}ms` }}>
              <div className="idea-top">
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
                    <button
                      className="mini-btn accent"
                      onClick={() => {
                        const text = editText.trim();
                        if (text) onUpdate(idea.id, { content: text });
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
