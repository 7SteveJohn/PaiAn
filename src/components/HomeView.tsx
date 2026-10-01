import type { CSSProperties } from 'react';
import { ArrowRight, Bookmark, Lightbulb, MessageSquare, NotebookPen, PanelRight, Sparkles, BarChart3 } from 'lucide-react';
import type { Idea, Project, StatsData } from '../types';
import { localDate, projectWords } from '../util';

export function calcStreak(daily: Record<string, number>): number {
  let n = 0;
  const d = new Date();
  if (!daily[localDate(d)]) d.setDate(d.getDate() - 1);
  for (;;) {
    if (daily[localDate(d)]) {
      n += 1;
      d.setDate(d.getDate() - 1);
    } else break;
  }
  return n;
}

interface Props {
  projects: Project[];
  ideas: Idea[];
  stats: StatsData;
  aiReady: boolean;
  onNavigate: (v: 'ideas' | 'projects' | 'stats' | 'chat' | 'settings') => void;
  onOpenProject: (id: string) => void;
  onWizard: () => void;
}

// 工作台首页：第一屏亮出全部核心能力（对标引导式创作工具的首页）
export default function HomeView({ projects, ideas, stats, aiReady, onNavigate, onOpenProject, onWizard }: Props) {
  const hour = new Date().getHours();
  const greet = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  const today = localDate();
  const todayWords = stats.daily[today] ?? 0;
  const total = Object.values(stats.daily).reduce((a, b) => a + b, 0);
  const streak = calcStreak(stats.daily);
  const openForeshadows = projects.reduce((a, p) => a + (p.marks ?? []).filter((m) => m.type === '伏笔' && m.status !== '回收').length, 0);
  const recent = [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4);
  const bp = [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).find((p) => p.breakpoint);
  const draftsWords = projects.reduce((a, p) => a + projectWords(p), 0);

  // 本周对比：含今天往前数 7 天的产出之和，再往前 7 天是上周——只报数字，不加好坏判断
  const sumDays = (offset: number): number => {
    let sum = 0;
    const d = new Date();
    d.setDate(d.getDate() - offset);
    for (let i = 0; i < 7; i++) {
      sum += stats.daily[localDate(d)] ?? 0;
      d.setDate(d.getDate() - 1);
    }
    return sum;
  };
  const weekWords = sumDays(0);
  const prevWeekWords = sumDays(7);

  const tiles = [
    { icon: NotebookPen, c: '#bc3f2c', n: projects.length, label: '创作项目', v: 'ideas' as const, nav: 'projects' as const },
    { icon: Bookmark, c: '#8a6a1f', n: ideas.length, label: '灵感库存', nav: 'ideas' as const },
    { icon: BarChart3, c: '#4a7a43', n: total, label: '累计产出字', nav: 'stats' as const },
    { icon: PanelRight, c: '#33565e', n: openForeshadows, label: '待回收伏笔', nav: 'projects' as const },
  ];

  const entries = [
    { icon: Sparkles, c: '#bc3f2c', title: 'AI 引导创建', desc: '一句话灵感，AI 生成设定、主角、大纲三选一', act: onWizard, cta: '开始引导' },
    { icon: MessageSquare, c: '#33565e', title: 'AI 对话', desc: '和模型自由聊选题、聊结构，规则自动生效', act: () => onNavigate('chat'), cta: '去对话' },
    { icon: Lightbulb, c: '#8a6a1f', title: '灵感速记', desc: '想法、摘抄、伏笔随手记，可一键转为项目', act: () => onNavigate('ideas'), cta: '去记录' },
    { icon: BarChart3, c: '#4a7a43', title: '统计复盘', desc: '热力图、关键词、伏笔总览，看见自己的产出', act: () => onNavigate('stats'), cta: '去复盘' },
  ];

  return (
    <>
      <header className="view-head">
        <div className="overline">HOME · 工作台</div>
        <h1>{greet}，今天写点什么</h1>
        <p className="home-sub">
          今日已产出 <b>{todayWords}</b> 字 · 连续创作 <b>{streak}</b> 天 · 正文现存 <b>{draftsWords}</b> 字
          {' '}· 本周 <b>{weekWords}</b> 字（上周 {prevWeekWords}）
          {!aiReady && <span className="home-ai-hint"> · AI 尚未配置，去「设置」点亮全部能力</span>}
        </p>
        <hr className="head-rule" />
      </header>

      {bp && (
        <button className="bp-card" onClick={() => onOpenProject(bp.id)}>
          <Bookmark size={16} />
          <span className="bp-main">
            <span className="bp-title">继续写作《{bp.title || '未命名'}》</span>
            <span className="bp-meta">上次写到第 {bp.breakpoint!.cursor} 字 · {bp.breakpoint!.at.slice(5, 16).replace('T', ' ')}</span>
          </span>
          <span className="proj-open">回到现场 →</span>
        </button>
      )}

      <div className="tile-row">
        {tiles.map(({ icon: Icon, c, n, label, nav }) => (
          <button key={label} className="stat-tile" onClick={() => onNavigate(nav)}>
            <span className="tile-icon" style={{ '--c': c } as CSSProperties}>
              <Icon size={17} />
            </span>
            <span className="tile-num">{n}</span>
            <span className="tile-label">{label}</span>
          </button>
        ))}
      </div>

      <div className="home-grid">
        <section className="home-col">
          <h3 className="sec-title">
            <NotebookPen size={14} /> 最近项目
          </h3>
          {recent.length === 0 && (
            <div className="home-empty">
              <p>还没有项目。让 AI 帮你完成冷启动，或手动新建一篇。</p>
              <button className="btn primary" onClick={onWizard}>
                <Sparkles size={14} /> AI 引导创建
              </button>
            </div>
          )}
          {recent.map((p) => (
            <button key={p.id} className="home-proj" onClick={() => onOpenProject(p.id)}>
              <span className="proj-title">{p.title || '未命名'}</span>
              <span className="home-proj-meta">
                {p.status} · {projectWords(p)} 字
              </span>
              <ArrowRight size={14} />
            </button>
          ))}
        </section>

        <section className="home-col">
          <h3 className="sec-title">
            <Sparkles size={14} /> 能力入口
          </h3>
          {entries.map(({ icon: Icon, c, title, desc, act, cta }) => (
            <button key={title} className="feature-card" onClick={act}>
              <span className="tile-icon" style={{ '--c': c } as CSSProperties}>
                <Icon size={16} />
              </span>
              <span className="feature-main">
                <b>{title}</b>
                <span>{desc}</span>
              </span>
              <span className="feature-cta">{cta}</span>
            </button>
          ))}
        </section>
      </div>
    </>
  );
}
