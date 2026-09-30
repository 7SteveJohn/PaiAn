// 作品健康度状态条：大纲页顶部的「体检」汇总。
// 状态行 + 字数/进度 + 问题清单（按严重级排序，每条带下一步动作建议）。
import { HeartPulse } from 'lucide-react';
import type { HealthReport } from '../health';

interface Props {
  report: HealthReport;
}

export default function HealthCard({ report }: Props) {
  const warnCount = report.issues.filter((i) => i.level === 'warn').length;
  const infoCount = report.issues.length - warnCount;
  // 状态词：有问题看问题，没问题亮绿灯
  const state = warnCount > 0
    ? { cls: 'warn', text: `${warnCount} 项需处理` }
    : report.issues.length > 0
      ? { cls: 'info', text: `${infoCount} 条建议` }
      : { cls: 'ok', text: '状态良好' };

  const pct = Math.max(0, Math.min(100, report.targetPct ?? 0));

  return (
    <div className={`health-card s-${state.cls}`}>
      <div className="health-head">
        <span className="health-title">
          <HeartPulse size={13} style={{ verticalAlign: -2 }} /> 作品健康度
        </span>
        <span className={`health-state ${state.cls}`}>{state.text}</span>
      </div>

      <div className="health-stats">
        <span>
          已写 <b>{report.written}</b>/{report.total} 章
        </span>
        {report.drafting > 0 && (
          <span>
            草稿 <b>{report.drafting}</b>
          </span>
        )}
        {report.todo > 0 && (
          <span>
            待写 <b>{report.todo}</b>
          </span>
        )}
        <span>
          正文 <b>{report.words.toLocaleString()}</b> 字
        </span>
        {report.target > 0 && (
          <span title={`目标 ${report.target.toLocaleString()} 字`}>
            目标进度 <b>{report.targetPct}%</b>
          </span>
        )}
      </div>

      {report.target > 0 && (
        <div className="health-progress" title={`${report.targetPct}% / 目标 ${report.target.toLocaleString()} 字`}>
          <i style={{ width: `${pct}%` }} />
        </div>
      )}

      {report.issues.length > 0 && (
        <div className="health-issues">
          {report.issues.map((it) => (
            <div key={it.key} className={'health-issue ' + it.level}>
              <span className="health-dot" />
              <div className="health-body">
                <div className="health-text">{it.text}</div>
                <div className="health-act">→ {it.act}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
