// 复盘栏的「节律区」：节奏琴键 + 对白天平 + 伏笔利息。
// 三块共用同一批每章统计（src/pitch.ts / src/debt.ts，全确定性）。画出来是为了「一眼看见」：
// 失速、话痨、主角消失、伏笔烂尾——这些看图比看数字表先反应过来。
import { useMemo, useState } from 'react';
import { Activity, Dices, Mic2, Wallet } from 'lucide-react';
import type { Project } from '../types';
import type { UserCards } from '../gacha';
import { DEBT_LABEL, hookDebts, newDebtCards } from '../debt';
import { normalize, rollsOf, silences } from '../pitch';

interface Props {
  project: Project;
  cards: UserCards;
  onCards: (next: UserCards) => void;
  onOpenGacha: () => void;
}

const BAR = 13; // 一章一格
const TALL = 96;
const VISIBLE = 90; // 最多画最近这么多章，再长就截断并说明

const shade = (wet: number) => `rgba(217, 164, 65, ${(0.16 + wet * 0.62).toFixed(3)})`;

export default function PitchPanel({ project, cards, onCards, onOpenGacha }: Props) {
  const [showAll, setShowAll] = useState(false);
  const [msg, setMsg] = useState('');
  const [infer, setInfer] = useState(() => localStorage.getItem('ww-pitch-infer') !== 'off');

  const toggleInfer = () => {
    const next = !infer;
    setInfer(next);
    localStorage.setItem('ww-pitch-infer', next ? 'on' : 'off');
  };

  const rolls = useMemo(() => rollsOf(project, infer), [project, infer]);
  const shown = useMemo(() => (showAll ? rolls : rolls.slice(-VISIBLE)), [rolls, showAll]);
  const { med, bars } = useMemo(() => normalize(shown), [shown]);
  const absent = useMemo(() => silences(project, rolls).filter((s) => s.gap >= 5), [project, rolls]);
  const tally = useMemo(() => {
    const m = new Map<string, { name: string; lines: number; words: number }>();
    let quoted = 0;
    let spoken = 0;
    let unknown = 0;
    let inferred = 0;
    for (const r of shown) {
      quoted += r.quoted;
      spoken += r.spoken;
      unknown += r.unknown;
      inferred += r.inferred;
      for (const s of r.speakers) {
        const cur = m.get(s.name) ?? { name: s.name, lines: 0, words: 0 };
        cur.lines += s.lines;
        cur.words += s.words;
        m.set(s.name, cur);
      }
    }
    const list = [...m.values()].sort((a, b) => b.lines - a.lines || b.words - a.words);
    return { list, quoted, spoken, unknown, inferred, max: list[0]?.lines ?? 1, silent: shown.filter((r) => r.quoted === 0).length };
  }, [shown]);
  const debts = useMemo(() => hookDebts(project), [project]);
  const owed = debts.filter((d) => d.level !== 'ok');

  const drop = () => {
    if (!owed.length) return '眼下没有该收的伏笔：都还没挂过计息线。';
    const add = newDebtCards(debts, cards.custom, 3);
    if (!add.length) return '这几条已经掉过卡了——收线卡的 id 由伏笔标记决定，重复点不堆重复卡。';
    onCards({ ...cards, custom: [...cards.custom, ...add] });
    return `掉进卡池 ${add.length} 张：${add.map((c) => c.name).join('、')}。下次抽取就可能遇到，打出去会把这条挂进本章「伏笔安排」。`;
  };

  if (!rolls.length) return null;

  return (
    <section className="pitch">
      <div className="pitch-grid">
        <div className="pitch-card">
          <h4>
            <Activity size={14} /> 节奏琴键
            <span className="pitch-meta">每章一格：高=句子长短，深浅=对白多少，顶点一点=章末落在对白上，底边暗条=AI 味密度</span>
          </h4>
          <svg className="pk-roll" viewBox={`0 0 ${bars.length * BAR + 8} ${TALL + 16}`} preserveAspectRatio="none">
            <line x1={0} y1={TALL / 2} x2={bars.length * BAR + 8} y2={TALL / 2} className="pk-median" />
            {bars.map((b, i) => {
              const h = Math.max(3, b.pitch * TALL);
              const x = i * BAR + 4; // 一格一章，从 0 开始铺
              return (
                <g key={b.no}>
                  <title>
                    {`第${b.no}章 ${b.title}\n平均句长 ${b.avgSentence} 字（本书中位 ${med}）\n对白 ${b.dialogueShare}% · ${b.chars} 字\n${
                      b.speakers.length ? '说话人：' + b.speakers.map((s) => `${s.name} ${s.lines} 行`).join('、') : '没有可归属的台词'
                    }`}
                  </title>
                  <rect x={x} y={TALL - h} width={BAR - 4} height={h} rx={2} fill={shade(b.wet)} className="pk-bar" />
                  {b.endsOnTalk && <circle cx={x + (BAR - 4) / 2} cy={Math.max(2, TALL - h - 5)} r={2.4} className="pk-dot" />}
                  {b.slop > 0.02 && <rect x={x} y={TALL + 5} width={BAR - 4} height={Math.max(1.5, b.slop * 6)} className="pk-slop" />}
                </g>
              );
            })}
          </svg>
          <p className="hint">
            基准线是本书中位句长 {med} 字；条顶到最上面只代表「明显比中位长」，不是画爆。
            {rolls.length > VISIBLE && !showAll && ` 只画最近 ${VISIBLE} 章（已写 ${rolls.length} 章）。`}{' '}
            <button className="mini-btn" onClick={() => setShowAll((v) => !v)}>
              {showAll ? `只看最近 ${VISIBLE} 章` : '看全本'}
            </button>
          </p>
        </div>

        <div className="pitch-card">
          <h4>
            <Mic2 size={14} /> 对白天平
            <span className="pitch-meta">这段范围里谁在说话</span>
          </h4>
          {!tally.quoted && <p className="hint">这段一句台词都没有。整章不开口也是一种节奏，连着几章都这样就要怀疑在写说明文。</p>}
          {!!tally.quoted && (
            <>
              <ul className="pk-speakers">
                {tally.list.slice(0, 8).map((s) => (
                  <li key={s.name}>
                    <span className="pk-who" title={s.name}>
                      {s.name}
                    </span>
                    <span className="pk-track">
                      <span className="pk-fill" style={{ width: `${Math.max(3, (s.lines / tally.max) * 100)}%` }} />
                    </span>
                    <em>
                      {s.lines} 行 · {s.words} 字
                    </em>
                  </li>
                ))}
              </ul>
              <p className="hint">
                台词 {tally.quoted} 行 · 认得出谁说的 {tally.spoken} 行
                {tally.inferred > 0 && <>（其中 {tally.inferred} 行是连续对话轮替推断）</>} · 归属不明 {tally.unknown} 行（认不出就留白，不摊到谁头上）
                {tally.silent > 0 && <> · {tally.silent} 章零对白</>}{' '}
                <button className="mini-btn" onClick={toggleInfer}>
                  {infer ? '关轮替推断' : '开轮替推断'}
                </button>
              </p>
            </>
          )}
          {absent.length > 0 && (
            <>
              <h4 className="pk-sub">这些人消失了</h4>
              <ul className="pk-absent">
                {absent.slice(0, 6).map((s) => (
                  <li key={s.name}>
                    <b>{s.name}</b>
                    <span>
                      最长连缺 {s.gap} 章 · {s.lastSpoke ? `最后开口在第 ${s.lastSpoke} 章（距今 ${s.since} 章）` : '一次也没开口'}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      <div className="pitch-card">
        <h4>
          <Wallet size={14} /> 伏笔利息
          <span className="pitch-meta">埋点之后又写了多少字，读者就等了多远</span>
        </h4>
        {!debts.length && <p className="hint">没有欠账——要么没埋着没收的，要么都收了。选中正文用悬浮菜单标「伏笔」，账就从那时开始记。</p>}
        {debts.length > 0 && (
          <ul className="pk-debts">
            {debts.slice(0, 8).map((d) => (
              <li key={d.id} className={'pk-debt lv-' + d.level}>
                <em className={'pk-lv pk-lv-' + d.level}>{DEBT_LABEL[d.level]}</em>
                <b>{d.text}</b>
                <span className="pk-when">
                  {d.plantedAt ? `第 ${d.plantedAt} 章埋 · 挂了 ${d.age} 章 / ${d.words} 字` : '埋点章已找不到，算不出账'}
                  {d.expected ? ` · 预期「${d.expected}」` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
        {owed.length > 0 && (
          <div className="pk-debt-acts">
            <button className="btn small" onClick={() => setMsg(drop())}>
              <Dices size={13} /> 把最欠的 {Math.min(3, owed.length)} 条掉成收线卡
            </button>
            <button className="mini-btn" onClick={onOpenGacha}>
              去卡池看
            </button>
            {msg && <span className="hint">{msg}</span>}
          </div>
        )}
      </div>
    </section>
  );
}
