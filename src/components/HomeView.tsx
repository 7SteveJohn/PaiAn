import { ArrowRight, Bookmark, NotebookPen, Sparkles } from 'lucide-react';
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
  /** 有新版本时传版本号（空串=没有）：只在问候行下提一句，去不去看永远是作者的事 */
  updateHint?: string;
  onNavigate: (v: 'ideas' | 'projects' | 'stats' | 'chat' | 'settings') => void;
  onOpenProject: (id: string) => void;
  onWizard: () => void;
}

// 工作台首页：像一张书桌台历，不像产品广告——问候、当日数字、继续写、最近在写的书；
// 功能入口收成底部一行目录（杂志目录式），不再用图标卡片阵列占半屏
export default function HomeView({ projects, ideas, stats, aiReady, updateHint, onNavigate, onOpenProject, onWizard }: Props) {
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

  const figures = [
    { n: projects.length, label: '在写的书', nav: 'projects' as const },
    { n: ideas.length, label: '灵感库存', nav: 'ideas' as const },
    { n: total, label: '累计产出字', nav: 'stats' as const },
    { n: openForeshadows, label: '待回收伏笔', nav: 'projects' as const },
  ];

  const links = [
    { title: 'AI 引导创建', act: onWizard },
    { title: 'AI 对话', act: () => onNavigate('chat') },
    { title: '灵感速记', act: () => onNavigate('ideas') },
    { title: '统计复盘', act: () => onNavigate('stats') },
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
          {updateHint && (
            <button className="home-update" onClick={() => onNavigate('settings')} title="去设置页看发布说明与下载地址">
              新版本 v{updateHint} 已发布 · 去看看 →
            </button>
          )}
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

      <div className="home-figures">
        {figures.map(({ n, label, nav }) => (
          <button key={label} className="figure" onClick={() => onNavigate(nav)}>
            <span className="figure-num">{n}</span>
            <span className="figure-label">{label}</span>
          </button>
        ))}
      </div>

      <section className="home-col home-recent">
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

      <footer className="home-links">
        <span className="home-links-label">常用</span>
        {links.map(({ title, act }) => (
          <button key={title} onClick={act}>
            {title}
          </button>
        ))}
      </footer>
    </>
  );
}
