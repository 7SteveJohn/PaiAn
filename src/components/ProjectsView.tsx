import { useMemo, useState } from 'react';
import { Plus, ChevronRight, CalendarDays, Upload, Trash2, Bookmark, Sparkles, Import } from 'lucide-react';
import type { ObsidianConfig, Project, ProjectStatus } from '../types';
import { projectWords, uid } from '../util';
import { syncAllToObsidian } from '../api';

const STATUSES: ProjectStatus[] = ['构思', '大纲', '写作中', '已完成', '已发布'];

const ST_CLASS: Record<ProjectStatus, string> = {
  构思: 'st-idea',
  大纲: 'st-outline',
  写作中: 'st-drafting',
  已完成: 'st-done',
  已发布: 'st-published',
};

const TYPE_OPTIONS = ['文章', '小说', '文案', '剧本', '随笔', '其他'];

interface Props {
  projects: Project[];
  obsidian: ObsidianConfig;
  onOpen: (id: string) => void;
  onCreate: (p: Project) => void;
  onUpdate: (id: string, patch: Partial<Project>, opts?: { snapshot?: boolean }) => void;
  onDelete: (id: string) => void;
  onWizard: () => void;
  /** 导入自己已经写好的东西：粘贴 / 本地文件 / 文件夹 / Obsidian 库 */
  onOpenImport: () => void;
  onLoadSample?: () => void;
}

export default function ProjectsView({ projects, obsidian, onOpen, onCreate, onUpdate, onDelete, onWizard, onOpenImport, onLoadSample }: Props) {
  const [statusFilter, setStatusFilter] = useState<ProjectStatus | '全部'>('全部');
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [type, setType] = useState('文章');
  const [status, setStatus] = useState<ProjectStatus>('构思');
  const [deadline, setDeadline] = useState('');
  const [target, setTarget] = useState('');
  const [syncMsg, setSyncMsg] = useState('');

  const syncAll = () => {
    syncAllToObsidian()
      .then((r) => {
        // 库里改过的内容服务端不代写盘——交回这里走正常保存路径，避免和防抖自动保存抢文件
        for (const b of r.books) {
          const np = b.nextProject;
          if (np) onUpdate(b.projectId, { chapters: np.chapters, characters: np.characters, worldItems: np.worldItems });
        }
        const bits = [`推 ${r.pushed}`, `拉 ${r.pulled}`];
        if (r.conflicts) bits.push(`${r.conflicts} 处冲突（打开那本书逐条判定）`);
        if (r.errors.length) bits.push(`${r.errors.length} 本失败`);
        setSyncMsg(`已同步 ${r.count} 本（${bits.join(' · ')}）`);
      })
      .catch((e: Error) => setSyncMsg('失败：' + e.message));
  };

  const filtered = useMemo(
    () =>
      projects
        .filter((p) => statusFilter === '全部' || p.status === statusFilter)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [projects, statusFilter],
  );

  const create = () => {
    if (!title.trim()) return;
    onCreate({
      id: uid(),
      title: title.trim(),
      type: type.trim() || '其他',
      status,
      deadline,
      target: Math.max(0, Number(target) || 0),
      notes: '',
      draft: '',
      linkedIdeaIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    setTitle('');
    setDeadline('');
    setTarget('');
    setCreating(false);
  };

  const today = new Date().toISOString().slice(0, 10);
  const isOverdue = (p: Project) =>
    p.deadline !== '' && p.status !== '已完成' && p.status !== '已发布' && p.deadline < today;

  return (
    <>
      <header className="view-head with-action">
        <div>
          <div className="overline">PROJECTS · 选题与进度</div>
          <h1>创作项目</h1>
        </div>
        <span className="head-actions">
          <button className="btn" onClick={onOpenImport} title="已经写好的正文或大纲，直接导进来成书">
            <Import size={14} /> 导入已有内容
          </button>
          <button className="btn primary" onClick={onWizard} title="AI 分步生成设定、主角与大纲，点选采纳后一键建项目">
            <Sparkles size={14} /> AI 引导创建
          </button>
          {obsidian.vaultPath && (
            <>
              {syncMsg && <span className={'sync-msg' + (syncMsg.startsWith('失败') ? ' error' : '')}>{syncMsg}</span>}
              <button className="btn" onClick={syncAll} title="把所有项目同步为 Markdown 到 Obsidian 库">
                <Upload size={14} /> 全部同步
              </button>
            </>
          )}
          {onLoadSample && projects.length === 0 && (
            <button className="btn" onClick={onLoadSample} title="载入一部 5 章的示例作品，先看看工作台能做什么；随时可删">
              <Bookmark size={14} /> 载入示例作品
            </button>
          )}
          <button className="btn primary" onClick={() => setCreating((v) => !v)}>
            <Plus size={15} /> 新建项目
          </button>
        </span>
      </header>
      <hr className="head-rule" />

      {creating && (
        <section className="inline-form">
          <label className="field">
            标题
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="这篇要写什么？" autoFocus />
          </label>
          <label className="field">
            类型
            <input value={type} onChange={(e) => setType(e.target.value)} list="type-options" />
            <datalist id="type-options">
              {TYPE_OPTIONS.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <label className="field">
            状态
            <select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            截稿日期
            <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </label>
          <label className="field">
            字数目标
            <input type="number" min={0} step={500} value={target} onChange={(e) => setTarget(e.target.value)} placeholder="可选" />
          </label>
          <button className="btn primary" onClick={create} disabled={!title.trim()} title={title.trim() ? '' : '先给作品起个标题'}>
            创建
          </button>
          {!title.trim() && <span className="hint">先给作品起个标题，「创建」才会亮。</span>}
          <button className="btn" onClick={() => setCreating(false)}>
            取消
          </button>
        </section>
      )}

      {(() => {
        const bp = [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).find((p) => p.breakpoint);
        if (!bp) return null;
        return (
          <button className="bp-card" onClick={() => onOpen(bp.id)}>
            <Bookmark size={16} />
            <span className="bp-main">
              <span className="bp-title">继续写作《{bp.title || '未命名'}》</span>
              <span className="bp-meta">
                上次写到第 {bp.breakpoint!.cursor} 字 · {bp.breakpoint!.at.slice(5, 16).replace('T', ' ')}
              </span>
            </span>
            <span className="proj-open">回到现场 →</span>
          </button>
        );
      })()}

      <div className="filters">
        {(['全部', ...STATUSES] as const).map((s) => (
          <button key={s} className={'chip' + (statusFilter === s ? ' on' : '')} onClick={() => setStatusFilter(s)}>
            {s}
          </button>
        ))}
        <span className="filter-count">共 {filtered.length} 篇</span>
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          {projects.length === 0 ? (
            <>
              <span className="empty-line">还没有项目。从灵感库把选题「转为项目」，点右上角新建一篇，或者——</span>
              {onLoadSample && (
                <button className="btn primary" onClick={onLoadSample} style={{ marginTop: 12 }}>
                  <Bookmark size={14} /> 载入示例作品，先逛一圈
                </button>
              )}
              <span className="empty-sub">示例带 5 章正文、人物战力线、伏笔锚点与全书梗概，可随时删除。</span>
            </>
          ) : (
            '这个状态下还没有项目。'
          )}
        </div>
      ) : (
        <div className="proj-list">
          {filtered.map((p, idx) => (
            <button key={p.id} className="proj-row" onClick={() => onOpen(p.id)} style={{ animationDelay: `${Math.min(idx, 8) * 40}ms` }}>
              <span className={'spine ' + ST_CLASS[p.status]} />
              <span className="proj-main">
                <span className="proj-title">{p.title || '未命名'}</span>
                <span className="proj-meta">
                  <span className={'status-pill stc-' + ST_CLASS[p.status]}>{p.status}</span>
                  <span>{p.type}</span>
                  <span>{projectWords(p)} 字</span>
                  {p.deadline && (
                    <span className={isOverdue(p) ? 'proj-overdue' : ''}>
                      <CalendarDays size={12} /> 截稿 {p.deadline}
                      {isOverdue(p) ? '（已逾期）' : ''}
                    </span>
                  )}
                </span>
                {p.target ? (
                  <span className="proj-target">
                    <span className="proj-target-track">
                      <span
                        className="proj-target-bar"
                        style={{ width: `${Math.min(Math.round((projectWords(p) / p.target) * 100), 100)}%` }}
                      />
                    </span>
                    <span className="proj-target-num">
                      {projectWords(p)}/{p.target}
                    </span>
                  </span>
                ) : null}
              </span>
              <span className="proj-open">
                <button
                  className="icon-btn"
                  title="删除（可在回收站恢复）"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(p.id);
                  }}
                >
                  <Trash2 size={14} />
                </button>
                打开 <ChevronRight size={14} />
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
