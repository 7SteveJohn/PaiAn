import { Fragment, useMemo, useState } from 'react';
import type { Chapter, Project, ProjectStatus, StatsData } from '../types';
import { countWords, localDate, projectWords } from '../util';

const STATUSES: ProjectStatus[] = ['构思', '大纲', '写作中', '已完成', '已发布'];
const ST_CLASS: Record<ProjectStatus, string> = {
  构思: 'st-idea',
  大纲: 'st-outline',
  写作中: 'st-drafting',
  已完成: 'st-done',
  已发布: 'st-published',
};

interface Props {
  projects: Project[];
  stats: StatsData;
  onReflection: (text: string) => void;
  onDailyGoal: (n: number) => void;
}

export default function StatsView({ projects, stats, onReflection, onDailyGoal }: Props) {
  const total = useMemo(() => Object.values(stats.daily).reduce((a, b) => a + b, 0), [stats]);
  const today = localDate();
  const todayWords = stats.daily[today] ?? 0;
  const goal = stats.dailyGoal ?? 0;
  const goalPct = goal > 0 ? Math.min(Math.round((todayWords / goal) * 100), 100) : 0;

  // 连续创作天数：今天还没写不打断连续，从昨天往前数
  const streak = useMemo(() => {
    let n = 0;
    const d = new Date();
    if (!stats.daily[localDate(d)]) d.setDate(d.getDate() - 1);
    for (;;) {
      if (stats.daily[localDate(d)]) {
        n += 1;
        d.setDate(d.getDate() - 1);
      } else break;
    }
    return n;
  }, [stats]);

  const days14 = useMemo(() => {
    const arr: { date: string; words: number }[] = [];
    const d = new Date();
    d.setDate(d.getDate() - 13);
    for (let i = 0; i < 14; i++) {
      const key = localDate(d);
      arr.push({ date: key, words: stats.daily[key] ?? 0 });
      d.setDate(d.getDate() + 1);
    }
    return arr;
  }, [stats]);

  const maxDay = Math.max(...days14.map((x) => x.words), 1);
  const inProgress = projects.filter((p) => p.status === '构思' || p.status === '大纲' || p.status === '写作中').length;
  const totalDraftWords = projects.reduce((a, p) => a + projectWords(p), 0);
  const recent = [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
  const statusCounts = STATUSES.map((s) => ({ s, n: projects.filter((p) => p.status === s).length }));
  const maxStatus = Math.max(...statusCounts.map((x) => x.n), 1);

  // 近 20 周（140 天）写作热力图
  const heat = useMemo(() => {
    const cells: { date: string; words: number }[] = [];
    const d = new Date();
    d.setDate(d.getDate() - 139);
    for (let i = 0; i < 140; i++) {
      const key = localDate(d);
      cells.push({ date: key, words: stats.daily[key] ?? 0 });
      d.setDate(d.getDate() + 1);
    }
    return cells;
  }, [stats]);
  const heatLevel = (w: number) => (w === 0 ? 0 : w < 100 ? 1 : w < 300 ? 2 : w < 600 ? 3 : 4);

  // 分章字数：只统计章节模式的作品
  const chapterProjects = useMemo(
    () => projects.filter((p) => p.mode === 'chapters' && (p.chapters?.length ?? 0) > 0),
    [projects],
  );
  const [chapterPid, setChapterPid] = useState('');
  const cp = chapterProjects.find((p) => p.id === chapterPid) ?? chapterProjects[0] ?? null;
  const cpChapters: Chapter[] = cp?.chapters ?? [];
  const cpWords = cpChapters.map((c) => countWords(c.content));
  const cpMax = Math.max(...cpWords, 1);
  const cpSum = cpWords.reduce((a, b) => a + b, 0);
  const cpAvg = cpWords.length ? Math.round(cpSum / cpWords.length) : 0;
  const cpEmpty = cpWords.filter((w) => w === 0).length;

  return (
    <>
      <header className="view-head">
        <div className="overline">REVIEW · 看见自己的产出</div>
        <h1>统计复盘</h1>
        <hr className="head-rule" />
      </header>

      <div className="goal-row">
        <span className="goal-label">每日目标</span>
        <input
          className="goal-input"
          type="number"
          min={0}
          step={100}
          value={goal || ''}
          onChange={(e) => onDailyGoal(Math.max(0, Number(e.target.value) || 0))}
          placeholder="0"
        />
        <span className="goal-label">字</span>
        {goal > 0 && (
          <span className="goal-track">
            <span className="goal-bar" style={{ width: `${goalPct}%` }} />
          </span>
        )}
        {goal > 0 && (
          <span className="goal-num">
            今日 {todayWords}/{goal} 字（{goalPct}%）
          </span>
        )}
      </div>

      <section className="heat-sec">
        <h3 className="sec-title">近 20 周节奏</h3>
        <div className="heat-grid">
          {heat.map((c) => (
            <span key={c.date} className={'heat-cell l' + heatLevel(c.words)} title={`${c.date}：${c.words} 字`} />
          ))}
        </div>
        <div className="heat-legend">
          少
          <span className="heat-cell l0" />
          <span className="heat-cell l1" />
          <span className="heat-cell l2" />
          <span className="heat-cell l3" />
          <span className="heat-cell l4" />
          多
        </div>
      </section>

      <div className="stat-row">
        <div className="stat-block">
          <div className="stat-num">
            {total}
            <em>字</em>
          </div>
          <div className="stat-label">累计产出</div>
        </div>
        <div className="stat-block">
          <div className="stat-num accent-num">
            {todayWords}
            <em>字</em>
          </div>
          <div className="stat-label">今日新增</div>
        </div>
        <div className="stat-block">
          <div className="stat-num">
            {streak}
            <em>天</em>
          </div>
          <div className="stat-label">连续创作</div>
        </div>
        <div className="stat-block">
          <div className="stat-num">
            {inProgress}
            <em>篇</em>
          </div>
          <div className="stat-label">进行中项目</div>
        </div>
      </div>

      <div className="stats-grid">
        <div>
          <section className="chart">
            <h3 className="sec-title">近 14 天产出</h3>
            <div className="bars">
              {days14.map((d) => (
                <div key={d.date} className="bar-col" title={`${d.date}：${d.words} 字`}>
                  <div
                    className={'bar' + (d.date === today ? ' today' : '')}
                    style={{ height: `${Math.max((d.words / maxDay) * 100, d.words > 0 ? 4 : 1)}%` }}
                  />
                </div>
              ))}
            </div>
            <div className="bar-labels">
              {days14.map((d) => (
                <span key={d.date} className={'bar-label' + (d.date === today ? ' today' : '')}>
                  {d.date.slice(5)}
                </span>
              ))}
            </div>
          </section>

          <section className="reflection">
            <h3 className="sec-title">复盘笔记</h3>
            <textarea
              value={stats.reflection}
              onChange={(e) => onReflection(e.target.value)}
              placeholder="这一阶段写得顺吗？卡在哪里？下一阶段想试什么…"
            />
          </section>
        </div>

        <div>
          <section className="dist">
            <h3 className="sec-title">项目状态分布</h3>
            {statusCounts.map(({ s, n }) => (
              <div key={s} className="dist-row">
                <span className={'status-pill stc-' + ST_CLASS[s]}>{s}</span>
                <span className="dist-track">
                  <span className={'dist-bar ' + ST_CLASS[s]} style={{ width: `${(n / maxStatus) * 100}%` }} />
                </span>
                <span className="dist-n">{n}</span>
              </div>
            ))}
            <div className="dist-total">正文现存 {totalDraftWords} 字</div>
          </section>

          <section className="recent">
            <h3 className="sec-title">最近更新</h3>
            {recent.length === 0 && <p className="hint">还没有项目记录。</p>}
            {recent.map((p) => (
              <div key={p.id} className="recent-item">
                <span className="recent-title">{p.title || '未命名'}</span>
                <span className="recent-meta">
                  {projectWords(p)} 字 · {p.updatedAt.slice(5, 10).replace('-', '/')}
                </span>
              </div>
            ))}
          </section>
        </div>
      </div>

      {chapterProjects.length > 0 && (
        <section className="ch-len">
          <h3 className="sec-title">章节篇幅</h3>
          <div className="ch-len-head">
            <select
              className="provider-select"
              style={{ width: 220 }}
              value={cp?.id ?? ''}
              onChange={(e) => setChapterPid(e.target.value)}
            >
              {chapterProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title || '未命名'}
                </option>
              ))}
            </select>
            <span className="hint">
              {cpChapters.length} 章 · 共 {cpSum} 字 · 平均 {cpAvg} 字/章
              {cpEmpty > 0 && ` · ${cpEmpty} 章未动笔`}
            </span>
          </div>
          <div className="ch-len-list">
            {cpChapters.map((c, i) => {
              const vol =
                i === 0 || (c.volume ?? '') !== (cpChapters[i - 1].volume ?? '') ? (c.volume ?? '') : null;
              return (
                <Fragment key={c.id}>
                  {vol !== null && <div className="ch-vol">{vol || '未分卷'}</div>}
                  <div className="ch-len-row" title={`第${i + 1}章 ${c.title}：${cpWords[i]} 字`}>
                    <span className="ch-len-name">
                      第{i + 1}章 {c.title}
                    </span>
                    <span className="dist-track">
                      <span
                        className={'dist-bar ' + (cpWords[i] === 0 ? 'st-idea' : 'st-drafting')}
                        style={{ width: `${(cpWords[i] / cpMax) * 100}%` }}
                      />
                    </span>
                    <span className="dist-n">{cpWords[i]}</span>
                  </div>
                </Fragment>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}
