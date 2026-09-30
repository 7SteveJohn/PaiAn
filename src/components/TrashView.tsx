import { useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import type { Idea, Project } from '../types';

interface Props {
  projects: Project[];
  ideas: Idea[];
  /** 库里还有镜像的书（root + 上次同步时的书名/作品id）：彻底删除时用来问「连库里的目录一起删吗」 */
  vaultBooks: { root: string; book: string; projectId?: string }[];
  onRestoreProject: (id: string) => void;
  onPurgeProject: (id: string, vaultRoot: string) => void;
  onRestoreIdea: (id: string) => void;
  onPurgeIdea: (id: string) => void;
}

export default function TrashView({ projects, ideas, vaultBooks, onRestoreProject, onPurgeProject, onRestoreIdea, onPurgeIdea }: Props) {
  const [tab, setTab] = useState<'projects' | 'ideas'>(projects.length > 0 || ideas.length === 0 ? 'projects' : 'ideas');

  const purgeProject = (p: Project) => {
    if (!confirm(`彻底删除《${p.title || '未命名'}》？正文与历史版本将无法找回。`)) return;
    // 库里的镜像是作者可能要留的素材：连不连库一起删，必须他亲口说，不静默删库。
    // 优先按作品 id 认领（书改过名也不失配）；老状态表没有 id 才退回按书名。
    const inVault = vaultBooks.find((b) => (b.projectId ? b.projectId === p.id : b.book === p.title));
    if (inVault && confirm(`Obsidian 库里还有这本书的同步副本（${inVault.root}/），连库里的目录一起删吗？\n取消 = 只删工作台数据，库里的笔记保留。`)) {
      onPurgeProject(p.id, inVault.root);
      return;
    }
    onPurgeProject(p.id, '');
  };

  const purgeIdea = (i: Idea) => {
    if (confirm('彻底删除这条灵感？无法找回。')) onPurgeIdea(i.id);
  };

  return (
    <>
      <header className="view-head">
        <div className="overline">TRASH · 删除的内容保留在此，可随时恢复</div>
        <h1>回收站</h1>
        <hr className="head-rule" />
      </header>

      <div className="filters">
        <button className={'chip' + (tab === 'projects' ? ' on' : '')} onClick={() => setTab('projects')}>
          项目（{projects.length}）
        </button>
        <button className={'chip' + (tab === 'ideas' ? ' on' : '')} onClick={() => setTab('ideas')}>
          灵感（{ideas.length}）
        </button>
      </div>

      {tab === 'projects' && (
        <div className="trash-list">
          {projects.length === 0 && <div className="empty">回收站里没有项目。</div>}
          {projects.map((p) => (
            <div key={p.id} className="trash-row">
              <span className="trash-main">
                <span className="trash-title">{p.title || '未命名'}</span>
                <span className="trash-meta">删除于 {p.deletedAt?.slice(0, 10)} · {p.type}</span>
              </span>
              <button className="btn small" onClick={() => onRestoreProject(p.id)}>
                <RotateCcw size={13} /> 恢复
              </button>
              <button className="btn small danger" onClick={() => purgeProject(p)}>
                <Trash2 size={13} /> 彻底删除
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === 'ideas' && (
        <div className="trash-list">
          {ideas.length === 0 && <div className="empty">回收站里没有灵感。</div>}
          {ideas.map((i) => (
            <div key={i.id} className="trash-row">
              <span className="trash-main">
                <span className="trash-title">{i.content.slice(0, 50)}</span>
                <span className="trash-meta">删除于 {i.deletedAt?.slice(0, 10)} · {i.kind}</span>
              </span>
              <button className="btn small" onClick={() => onRestoreIdea(i.id)}>
                <RotateCcw size={13} /> 恢复
              </button>
              <button className="btn small danger" onClick={() => purgeIdea(i)}>
                <Trash2 size={13} /> 彻底删除
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
