import { useState, type CSSProperties } from 'react';
import { Home, Lightbulb, NotebookPen, BarChart3, Settings2, Trash2, Moon, Sun, MessageSquare, Dices } from 'lucide-react';
import type { View } from '../App';
import GlobalSearch from './GlobalSearch';
import type { Idea, Project } from '../types';

// 每个模块一个专属色（导航磁贴与首页磁贴一致）
const NAV: { key: View; label: string; icon: typeof Home; c: string }[] = [
  { key: 'home', label: '首页', icon: Home, c: '#8d8474' },
  { key: 'ideas', label: '灵感库', icon: Lightbulb, c: '#8a6a1f' },
  { key: 'projects', label: '创作项目', icon: NotebookPen, c: '#bc3f2c' },
  { key: 'chat', label: 'AI 对话', icon: MessageSquare, c: '#33565e' },
  { key: 'gacha', label: '卡池', icon: Dices, c: '#7c3aed' },
  { key: 'stats', label: '统计复盘', icon: BarChart3, c: '#4a7a43' },
  { key: 'settings', label: '设置', icon: Settings2, c: '#5f5849' },
];

interface Props {
  view: View;
  onNavigate: (v: View) => void;
  saveState: 'saved' | 'dirty' | 'saving' | 'error';
  saveError?: string; // 保存失败的具体原因（服务端给的），悬在状态点上可直接读
  onRetrySave: () => void;
  aiReady: boolean;
  trashCount: number;
  projects: Project[];
  ideas: Idea[];
  onOpenProject: (id: string) => void;
  onSearchIdea: (q: string) => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

export default function Sidebar({
  view,
  onNavigate,
  saveState,
  saveError,
  onRetrySave,
  aiReady,
  trashCount,
  projects,
  ideas,
  onOpenProject,
  onSearchIdea,
  theme,
  onToggleTheme,
}: Props) {
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="seal">拍</div>
        <div className="brand-name">拍案</div>
        <div className="brand-sub">PAIAN WORKBENCH</div>
      </div>

      <GlobalSearch
        projects={projects}
        ideas={ideas}
        onOpenProject={onOpenProject}
        onSearchIdea={onSearchIdea}
        onExpand={(open) => setSearchOpen(open)}
      />

      <nav className={searchOpen ? 'nav-shifted' : ''}>
        {NAV.map(({ key, label, icon: Icon, c }) => (
          <button key={key} className={'nav-item' + (view === key ? ' active' : '')} onClick={() => onNavigate(key)} style={{ '--c': c } as CSSProperties}>
            <span className="nav-tile">
              <Icon size={15} strokeWidth={2} />
            </span>
            <span>{label}</span>
            {key === 'settings' && !aiReady && <em className="nav-dot" title="AI 尚未配置" />}
          </button>
        ))}
        <button className={'nav-item' + (view === 'trash' ? ' active' : '')} onClick={() => onNavigate('trash')} style={{ '--c': '#8d8474' } as CSSProperties}>
          <span className="nav-tile">
            <Trash2 size={15} strokeWidth={2} />
          </span>
          <span>回收站</span>
          {trashCount > 0 && <em className="nav-count">{trashCount}</em>}
        </button>
      </nav>

      <div className="sidebar-foot">
        <button className="icon-btn theme-btn" onClick={onToggleTheme} title={theme === 'light' ? '切换到夜间模式' : '切换到日间模式'}>
          {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
        </button>
        <div
          className={'save-state' + (saveState === 'error' ? ' err clickable' : '')}
          onClick={saveState === 'error' ? onRetrySave : undefined}
          title={saveState === 'error' ? (saveError ? `数据未写入磁盘：${saveError}\n点击重试` : '数据未写入磁盘，点击重试') : undefined}
        >
          <span className={'dot ' + saveState} />
          {saveState === 'saved'
            ? '已保存'
            : saveState === 'saving'
              ? '保存中…'
              : saveState === 'error'
                ? '保存失败·重试'
                : '有改动待保存'}
        </div>
      </div>
    </aside>
  );
}
