// 复盘栏的「设定守夜人」：境界线、称谓名册、远场沉默。
// 判定全在 src/watchdog.ts（纯函数、确定性）；这里只负责把话说清楚——每条都带章号和原话，
// 因为「你第 7 章写串了」没证据的话，作者是不会信的。
import { useMemo, useState } from 'react';
import { Dices, ScrollText, Users, Wind } from 'lucide-react';
import ShowMore from './ShowMore';
import type { Project } from '../types';
import type { UserCards } from '../gacha';
import { SILENCE_GAP, needsLadderCard, watchdog, watchdogCards } from '../watchdog';

interface Props {
  project: Project;
  cards: UserCards;
  onCards: (next: UserCards) => void;
  onOpenGacha: () => void;
  onAddLadder: () => string;
}

const KIND_LABEL: Record<string, string> = {
  regress: '境界回退',
  flip: '同章打架',
  'card-behind': '卡落后正文',
  near: '近名易串',
  dead: '卡没落地',
  'cast-miss': '名单对不上',
  'relation-dangling': '关系指向空名',
};

const realmText = (f: ReturnType<typeof watchdog>['realm']['findings'][number]) => {
  if (f.kind === 'regress') return `第${f.from.no}章写到「${f.from.term}」，第${f.to.no}章成了「${f.to.term}」：${f.snippet}`;
  if (f.kind === 'flip') return `第${f.no}章里同时写到「${f.terms[0]}」和「${f.terms[1]}」`;
  return `卡上还是「${f.card}」，正文第${f.max.no}章已经写到「${f.max.term}」`;
};

const nameText = (f: ReturnType<typeof watchdog>['names'][number]) => {
  if (f.kind === 'near') return `「${f.names[0]}」与「${f.names[1]}」${f.why}（正文各出现 ${f.counts[0]} / ${f.counts[1]} 次）`;
  if (f.kind === 'cast-miss') return `第${f.no}章：${f.names[0]}——${f.why}`;
  return `${f.names.map((n) => `「${n}」`).join('')}${f.why ? '：' + f.why : ''}`;
};

export default function LorePanel({ project, cards, onCards, onOpenGacha, onAddLadder }: Props) {
  const [msg, setMsg] = useState('');
  const w = useMemo(() => watchdog(project), [project]);
  const sk = w.realm.skipped;

  if (!(project.characters?.length ?? 0) && !(project.worldItems?.length ?? 0)) return null;

  // 掉卡只在点击时算：整本扫一遍不该发生在每次渲染里
  const drop = () => {
    const add = watchdogCards(project, cards.custom);
    if (!add.length) return '没有可掉的新卡了：守夜人只把「回退 / 没落地 / 沉默」掉成卡，名单与近名这类得你自己动手改。';
    onCards({ ...cards, custom: [...cards.custom, ...add] });
    return `掉进卡池 ${add.length} 张：${add.map((c) => c.name).join('、')}。下次抽取就可能遇到，打出去挂进本章剧情要点。`;
  };

  return (
    <section className="pitch wd">
      <div className="pitch-grid">
        <div className="pitch-card">
          <h4>
            <ScrollText size={14} /> 境界线
            <span className="pitch-meta">按 {w.realm.ladderLabel} 排；只认叙述里唯一归属的境界词</span>
          </h4>
          {!w.numbered && <p className="hint">单篇模式没有章序，只能看同一篇内部的矛盾，跨章回退要改用章节模式才判得出。</p>}
          {w.realm.findings.length === 0 && (
            <p className="hint">
              {w.realm.obs.length ? `检出 ${w.realm.obs.length} 处境界描写，线是顺的。` : '正文里没认出可归属的境界词——境界名写进了「力量体系」词条才判得准。'}
            </p>
          )}
          <ul className="pk-debts">
            <ShowMore items={w.realm.findings} cap={6} render={(f, i) => (
              <li key={i} className={'pk-debt lv-' + (f.kind === 'flip' ? 'late' : 'lost')}>
                <em className={'pk-lv pk-lv-' + (f.kind === 'flip' ? 'late' : 'lost')}>{KIND_LABEL[f.kind]}</em>
                <b>{f.name}</b>
                <span className="pk-when">{realmText(f)}</span>
              </li>
            )} />
          </ul>
          {needsLadderCard(project) && (
            <div className="pk-debt-acts">
              <button className="btn small" onClick={() => setMsg(onAddLadder())}>
                <ScrollText size={13} /> 补一张力量体系卡
              </button>
              {msg && <span className="hint">{msg}</span>}
            </div>
          )}
          {(sk.dialogue || sk.hedged || sk.ambiguous) > 0 && (
            <p className="hint wd-skip">
              另有 {sk.dialogue} 处在台词里、{sk.hedged} 处跟着「还没／当年」这类说法、{sk.ambiguous} 处一句话里挨着两个人名——都不算到谁头上，宁缺勿滥。
            </p>
          )}
        </div>

        <div className="pitch-card">
          <h4>
            <Users size={14} /> 称谓与名册
            <span className="pitch-meta">写得像的名字、从没出场的卡、名单与正文对不上</span>
          </h4>
          {w.names.length === 0 && <p className="hint">没检出问题。名字挨太近、卡建了不用，这两样最容易在几十章之后咬你一口。</p>}
          <ul className="pk-debts">
            <ShowMore items={w.names} cap={7} render={(f, i) => (
              <li key={i} className={'pk-debt lv-' + (f.kind === 'dead' ? 'late' : 'soon')}>
                <em className={'pk-lv pk-lv-' + (f.kind === 'dead' ? 'late' : 'soon')}>{KIND_LABEL[f.kind]}</em>
                <span className="pk-when">{nameText(f)}</span>
              </li>
            )} />
            <ShowMore items={w.exits} cap={4} render={(f, i) => (
              <li key={'x' + i} className="pk-debt lv-soon">
                <em className="pk-lv pk-lv-soon">{f.no > 0 ? '离场复现' : '离场待核'}</em>
                <span className="pk-when">
                  {f.no > 0
                    ? `「${f.name}」卡上写着「${f.state}」（第${f.anchor}章起），第${f.no}章的出场名单仍点名他出场。在回忆 / 闪回里就说一声：名单里注「回忆」即可。`
                    : `「${f.name}」卡上写着「${f.state}」，但没写发生在第几章——补一句章号（如「第7章死去」），守夜人才能对账后面还有没有他出场。`}
                </span>
              </li>
            )} />
          </ul>
        </div>
      </div>

      <div className="pitch-card">
        <h4>
          <Wind size={14} /> 远场沉默
          <span className="pitch-meta">上次露面之后又写了多少章多少字——第 1 章的物件到第 28 章还在不在，这本账人人有份</span>
        </h4>
        {w.rows.length === 0 && <p className="hint">没有沉默超过 {SILENCE_GAP} 章的人或物——只被别人在台词里提起不算露面。</p>}
        <ul className="pk-debts">
          <ShowMore items={w.rows} cap={8} render={(r) => (
            <li key={r.id} className={'pk-debt lv-' + (r.gap >= SILENCE_GAP * 3 ? 'late' : 'soon')}>
              <em className={'pk-lv pk-lv-' + (r.gap >= SILENCE_GAP * 3 ? 'late' : 'soon')}>{r.offstage ? '只在嘴上' : r.kind}</em>
              <b>{r.name}</b>
              <span className="pk-when">
                第{r.first}章首次出现 · {r.offstage ? '一次也没进场' : `上次进场第${r.last}章`} · 已隔 {r.gap} 章 / 约 {r.words} 字
                {r.mentionsAfter > 0 && `（其间只在台词里被提起 ${r.mentionsAfter} 次，最后第${r.lastAny}章）`}
              </span>
            </li>
          )} />
        </ul>
        {w.total > 0 && (
          <div className="pk-debt-acts">
            <button className="btn small" onClick={() => setMsg(drop())}>
              <Dices size={13} /> 把守夜人的发现掉成卡
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
