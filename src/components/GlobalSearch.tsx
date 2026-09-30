import { useMemo, useRef, useState } from 'react';
import { FileText, Lightbulb, Search } from 'lucide-react';
import type { Idea, Project } from '../types';

interface Props {
  projects: Project[];
  ideas: Idea[];
  onOpenProject: (id: string) => void;
  onSearchIdea: (q: string) => void;
  onExpand: (open: boolean) => void;
}

interface ProjectHit {
  project: Project;
  source: string; // 命中来源，如「第12章 正文」「人物卡」
}

// 在项目内定位关键词：章节模式的正文在 chapters 里（draft 为空），必须逐章找
function findHit(p: Project, term: string): string | null {
  if (p.title.includes(term)) return '标题';
  const chapters = p.chapters ?? [];
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i].title.includes(term)) return `第${i + 1}章 标题`;
    if (chapters[i].content.includes(term)) return `第${i + 1}章 正文`;
  }
  if (p.draft.includes(term)) return '正文';
  if (p.notes.includes(term)) return '备注';
  if ((p.characters ?? []).some((c) => c.name.includes(term) || (c.state ?? '').includes(term))) return '人物卡';
  if ((p.worldItems ?? []).some((w) => w.name.includes(term) || (w.content ?? '').includes(term))) return '设定卡';
  if ((p.branches ?? []).some((b) => b.title.includes(term) || (b.text ?? '').includes(term))) return '分支';
  if ((p.marks ?? []).some((m) => m.text.includes(term) || (m.note ?? '').includes(term))) return '标记';
  return null;
}

// 侧边栏全局搜索：项目按标题/章节正文/人物/设定/伏笔匹配，灵感匹配后跳灵感库并带入关键词
export default function GlobalSearch({ projects, ideas, onOpenProject, onSearchIdea, onExpand }: Props) {
  const [q, setQ] = useState('');
  const blurTimer = useRef<number | undefined>(undefined);

  const { projectHits, projectTotal, ideaHits, ideaTotal } = useMemo(() => {
    const term = q.trim();
    if (!term) return { projectHits: [] as ProjectHit[], projectTotal: 0, ideaHits: [] as Idea[], ideaTotal: 0 };
    // 命中项目按最近改过的排前面：一个词命中十几本书时，前 6 个不该由「存的先后」决定
    const all = projects
      .map((p) => ({ p, source: findHit(p, term) }))
      .filter((x): x is { p: Project; source: string } => x.source !== null)
      .sort((a, b) => (a.p.updatedAt < b.p.updatedAt ? 1 : -1));
    const ideaAll = ideas.filter((i) => i.content.includes(term) || i.tags.some((t) => t.includes(term)));
    return {
      projectHits: all.slice(0, 6).map((x) => ({ project: x.p, source: x.source })),
      projectTotal: all.length,
      ideaHits: ideaAll.slice(0, 5),
      ideaTotal: ideaAll.length,
    };
  }, [q, projects, ideas]);

  const close = () => {
    setQ('');
    onExpand(false);
  };

  const pickProject = (id: string) => {
    close();
    onOpenProject(id);
  };

  const pickIdea = () => {
    const term = q.trim();
    close();
    onSearchIdea(term);
  };

  const hasResults = projectHits.length > 0 || ideaHits.length > 0;

  return (
    <div className="gs-wrap">
      <span className="gs-icon">
        <Search size={14} />
      </span>
      <input
        className="gs-input"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => onExpand(true)}
        onBlur={() => {
          window.clearTimeout(blurTimer.current);
          blurTimer.current = window.setTimeout(() => onExpand(false), 150);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
          if (e.key === 'Enter' && projectHits.length > 0) pickProject(projectHits[0].project.id);
        }}
        placeholder="搜索正文 / 章节 / 人物 / 设定…"
      />
      {q.trim() && (
        <div className="gs-pop">
          {hasResults ? (
            <>
              {projectHits.length > 0 && <div className="gs-sec">项目{projectTotal > projectHits.length ? `（共 ${projectTotal} 本，只列最近改的 ${projectHits.length} 本）` : ""}</div>}
              {projectHits.map(({ project, source }) => (
                <button
                  key={project.id}
                  className="gs-item"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickProject(project.id)}
                >
                  <FileText size={13} />
                  <span className="gs-title">{project.title || '未命名'}</span>
                  <span className="gs-sub">{source}</span>
                </button>
              ))}
              {ideaHits.length > 0 && <div className="gs-sec">灵感{ideaTotal > ideaHits.length ? `（共 ${ideaTotal} 条，只列前 ${ideaHits.length} 条）` : ""}</div>}
              {ideaHits.map((i) => (
                <button key={i.id} className="gs-item" onMouseDown={(e) => e.preventDefault()} onClick={pickIdea}>
                  <Lightbulb size={13} />
                  <span className="gs-title">{i.content.slice(0, 24)}</span>
                  <span className="gs-sub">{i.kind}</span>
                </button>
              ))}
            </>
          ) : (
            <div className="gs-empty">没有匹配的项目或灵感（只搜标题 / 正文 / 人物 / 设定 / 标记，不含历史快照与对话）</div>
          )}
        </div>
      )}
    </div>
  );
}
