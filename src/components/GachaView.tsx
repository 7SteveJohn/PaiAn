import { useEffect, useMemo, useState } from 'react';
import { Dices, Sparkles, Gem } from 'lucide-react';
import type { GachaCard, GachaState, UserCards } from '../gacha';
import { CHANGE_COST, CHANGE_PRICE, EFFECT_LABEL, RARITY_ORDER, activePool, changeFor, codex, pruneHand, pullsAvailable, chargeForPulls, rollMany, rollOne, takeToHand } from '../gacha';
import { BASE_CARDS, INK_PER_DUP, PITY, RATES, WORDS_PER_PULL } from '../cards';
import { analyzeBook, cardsFromGaps, compare, myStats, rhythm } from '../bench';
import { driftGaps, portrait } from '../style';
import { fetchBenchmarks, saveBenchmarks } from '../api';
import type { BenchBook } from '../bench';
import type { Project } from '../types';
import CardStage from './CardStage';
import { describe, summarize } from '../constraints';

interface Props {
  gacha: GachaState;
  cards: UserCards;
  netWords: number; // 净产出总字数（抽卡货币）
  goalHit: boolean; // 今日目标是否已完成（额外送一次）
  onGacha: (next: GachaState) => void;
  onCards: (next: UserCards) => void;
  onGoWriting: () => void;
  projects: Project[]; // 拿一部自己的书来比节奏
}

const RARITY_CN: Record<string, string> = { N: 'N · 小事', R: 'R · 岔路', SR: 'SR · 破格', SSR: 'SSR · 大局' };

export default function GachaView({ gacha, cards, netWords, goalHit, onGacha, onCards, onGoWriting, projects }: Props) {
  const pool = useMemo(() => activePool(cards), [cards]);
  const book = useMemo(() => codex(cards, gacha), [cards, gacha]);
  const left = pullsAvailable(gacha, netWords, goalHit);
  const toNext = Math.max(0, (gacha.usedWords + (left + 1) * WORDS_PER_PULL - netWords));
  const [drawn, setDrawn] = useState<GachaCard[] | null>(null);
  const [flash, setFlash] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', series: '自建', rarity: 'N', effect: 'beat', payload: '' });

  // ---- 拆文对标：只存每章统计，不存原文 ----
  const [books, setBooks] = useState<BenchBook[]>([]);
  const [benchPick, setBenchPick] = useState('');
  const [minePick, setMinePick] = useState('');
  const [benchText, setBenchText] = useState('');
  const [benchTitle, setBenchTitle] = useState('');
  const [benchMsg, setBenchMsg] = useState('');

  useEffect(() => {
    fetchBenchmarks()
      .then(setBooks)
      .catch((e: Error) => setBenchMsg('读取对标书失败：' + e.message));
  }, []);

  const mine = useMemo(() => {
    const first = projects.find((x) => x.id === minePick) ?? projects[0];
    return first ? { project: first, stats: myStats(first) } : null;
  }, [projects, minePick]);
  const bench = useMemo(() => books.find((b) => b.id === benchPick) ?? books[0] ?? null, [books, benchPick]);
  const gaps = useMemo(() => (mine && bench ? compare(mine.stats, bench.chapters) : []), [mine, bench]);
  const cardable = useMemo(() => (bench ? cardsFromGaps(bench, gaps) : []), [bench, gaps]);

  // ---- 笔触漂移：对照物换成「你自己」，卡面从「学它」变成「找回」 ----
  const selfPortrait = useMemo(() => portrait(projects, mine?.project.id ?? ''), [projects, mine]);
  const selfBook = useMemo<BenchBook | null>(
    () => (selfPortrait.ok && mine ? { id: 'self-' + mine.project.id, title: '我的惯常笔触', createdAt: '', chapters: selfPortrait.base } : null),
    [selfPortrait, mine]
  );
  const selfGaps = useMemo(() => driftGaps(selfPortrait), [selfPortrait]);
  const selfCardable = useMemo(() => (selfBook ? cardsFromGaps(selfBook, selfGaps, true) : []), [selfBook, selfGaps]);

  const runBench = async () => {
    if (benchText.trim().length < 200) {
      setBenchMsg('贴进来的正文太短（不足 200 字），至少给几章才看得出节奏。');
      return;
    }
    const book = analyzeBook(benchTitle, benchText);
    const merged = [book, ...books.filter((b) => b.id !== book.id)];
    // 上限挤掉的统计找不回来（原文没存），所以挤谁必须先问一声
    if (merged.length > 20 && !window.confirm(`拆解最多存 20 本：最早的《${merged[20].title}》会被挤掉，找不回来。继续吗？`)) return;
    const next = merged.slice(0, 20);
    setBooks(next);
    setBenchPick(book.id);
    setBenchText('');
    setBenchTitle('');
    setBenchMsg('已拆完《' + book.title + '》：' + book.chapters.length + ' 章。只存了统计，原文没进数据目录。');
    await saveBenchmarks(next).catch((e: Error) => setBenchMsg('落库失败：' + e.message));
  };

  const dropBenchAsk = (id: string) => {
    const b = books.find((x) => x.id === id);
    return window.confirm(`删掉《${b?.title || '这本'}》的拆文统计？\n原文没有保存，删了要重新找原文整本再拆一遍。`);
  };

  const dropBench = async (id: string) => {
    const next = books.filter((b) => b.id !== id);
    setBooks(next);
    await saveBenchmarks(next).catch((e: Error) => setBenchMsg('落库失败：' + e.message));
  };

  const dropCards = (list: GachaCard[], already: string) => {
    const add = list.filter((c) => !cards.custom.some((x) => x.id === c.id));
    if (!add.length) {
      setBenchMsg(already);
      return;
    }
    setCards({ ...cards, custom: [...cards.custom, ...add] });
    setBenchMsg('掉进卡池 ' + add.length + ' 张：' + add.map((c) => c.name).join('、') + '。下次抽取就可能遇到。');
  };
  const GAP_ALREADY = '这些差距已经掉过卡了——同一次拆解的卡 id 固定，重复点不会堆重复卡。';

  const doDraw = (n: number) => {
    if (left < n) {
      setFlash(`还差 ${Math.ceil((n * WORDS_PER_PULL - (netWords - gacha.usedWords)) / 1000) * 1000} 字净产出才够${n > 1 ? '十连' : '一抽'}——先写一段再来。`);
      return;
    }
    const r = n > 1 ? rollMany(pool, gacha, n) : rollOne(pool, gacha);
    const state = chargeForPulls(r.state, netWords, n);
    const got = 'cards' in r ? (r.cards as GachaCard[]) : r.card ? [r.card] : [];
    const hand = takeToHand(state, got.map((c) => c.id), pool);
    onGacha(hand.state);
    setDrawn(got);
    setFlash(hand.overflow.length ? `手牌已满 3 张，多出来的 ${hand.overflow.length} 张先躺在图鉴里，用掉一张后可以从图鉴「上手」。` : '');
  };

  const takeFromCodex = (cardId: string) => {
    const r = takeToHand(gacha, [cardId], pool);
    if (r.overflow.length) setFlash('手牌满了 3 张——先在写作页打出一张。');
    onGacha(r.state);
  };

  const changeTo = (cardId: string) => {
    // 「换」是给已经拥有的人再来一张：能不能换只看墨够不够、卡在不在池里。
    // changeFor 的 ok 是「这是不是张新卡」——拿来当成败判据，这个按钮就永远失败。
    if (gacha.ink < CHANGE_COST) {
      setFlash(`墨不够（一张 ${CHANGE_PRICE} 墨，现有 ${gacha.ink}）——写满字就有。`);
      return;
    }
    if (!pool.some((c) => c.id === cardId)) {
      setFlash('这张卡不在池里。');
      return;
    }
    const r = changeFor(gacha, cardId, pool);
    onGacha(r.state);
    setDrawn([pool.find((c) => c.id === cardId)!]);
    setFlash('已用墨定向换来一张——这条是给脸黑时的救济通道，不是商店。');
  };

  // 改池子（勾掉内置卡 / 删自建卡）时顺带裁手牌，否则被移除的卡会以看不见的形式占着手牌名额
  const setCards = (next: UserCards) => {
    onCards(next);
    const pruned = pruneHand(gacha, activePool(next));
    if (pruned.dropped.length) {
      onGacha(pruned.state);
      setFlash(`手牌里 ${pruned.dropped.length} 张已不在池子里，退回图鉴了。`);
    }
  };

  const toggleOff = (cardId: string) => {
    const off = cards.off.includes(cardId) ? cards.off.filter((x) => x !== cardId) : [...cards.off, cardId];
    setCards({ ...cards, off });
  };

  const addCustom = () => {
    const name = draft.name.trim();
    const payload = draft.payload.trim();
    if (!name || !payload) {
      setFlash('卡名与卡面任务都要填。');
      return;
    }
    const card: GachaCard = {
      id: 'u' + Date.now().toString(36),
      series: draft.series.trim() || '自建',
      rarity: (RARITY_ORDER.includes(draft.rarity as never) ? draft.rarity : 'N') as GachaCard['rarity'],
      name: name.slice(0, 30),
      effect: draft.effect as GachaCard['effect'],
      payload: payload.slice(0, 600),
    };
    setCards({ ...cards, custom: [...cards.custom, card] });
    setDraft({ name: '', series: '自建', rarity: 'N', effect: 'beat', payload: '' });
    setAdding(false);
    setFlash(`已把「${card.name}」放进池子，下次抽取就可能遇到。`);
  };

  const litCount = Object.keys(gacha.lit).length;
  const ownedCount = Object.keys(gacha.owned).length;

  return (
    <>
      <header className="view-head">
        <h2>
          <Dices size={18} /> 卡池
        </h2>
        <p className="view-sub">抽的是「下一步写什么」。货币是净产出字数：写 {WORDS_PER_PULL} 字换一抽，删改会回扣。</p>
        <span className="head-spacer" />
        <button className="btn small" onClick={onGoWriting}>
          去写作页用卡
        </button>
      </header>

      <div className="gacha-body">
        <section className="gacha-wallet">
          <div className="gw-tile">
            <span>可抽</span>
            <b>{left}</b>
            <em>{gacha.bonusPulls ? `含组合/日目标奖励 ${gacha.bonusPulls} 次` : toNext > 0 ? `再写 ${toNext} 字 +1` : '—'}</em>
          </div>
          <div className="gw-tile">
            <span>墨（重复卡转化）</span>
            <b>{gacha.ink}</b>
            <em>定向换一张 {CHANGE_PRICE} 墨</em>
          </div>
          <div className="gw-tile">
            <span>累计抽取</span>
            <b>{gacha.pulls}</b>
            <em>
              在手 {gacha.hand.length} / 3 · 图鉴 {ownedCount} / {pool.length} · 点亮 {litCount}
            </em>
          </div>
          <div className="gw-pity">
            <span>
              保底进度 {gacha.sincePity} / {PITY}
            </span>
            <span className="gw-track">
              <span className="gw-fill" style={{ width: `${Math.min(100, (gacha.sincePity / PITY) * 100)}%` }} />
            </span>
          </div>
          <div className="gw-acts">
            <button className="btn" disabled={left < 1} onClick={() => doDraw(1)}>
              <Sparkles size={14} /> 抽一张
            </button>
            <button className="btn" disabled={left < 10} onClick={() => doDraw(10)}>
              {left < 10 ? `十连（还差 ${10 - left} 抽）` : '十连'}
            </button>
          </div>
          {flash && <p className="hint gacha-flash">{flash}</p>}
        </section>

        <section className="gacha-codex">
          {book.map(({ series, rows }) => (
            <div key={series} className="gacha-series">
              <h4>
                {series} · {rows.filter((r) => r.owned > 0).length}/{rows.length} 已收
              </h4>
              <p className="hint">{SERIES_NOTE[series] ?? '你自己加的卡都在这里。'}</p>
              <div className="gacha-grid">
                {rows.map(({ card, owned, litAt }) => (
                  <div key={card.id} className={'mini-card' + (owned ? ' owned' : '') + (litAt ? ' lit' : '') + ' r-' + card.rarity}>
                    <span className="mc-r">{card.rarity}</span>
                    <b className="mc-name">{owned ? card.name : '？？？'}</b>
                    <p className="mc-text">{owned ? card.payload.slice(0, 46) + (card.payload.length > 46 ? '…' : '') : '抽到才知道破的是哪条规矩'}</p>
                    {owned && summarize(describe(card)) && <p className="mc-cond">{summarize(describe(card))}</p>}
                    <span className="mc-foot">
                      {litAt ? '已点亮' : owned ? '待达成' : '未收'}
                      {owned > 1 && <em>×{owned}</em>}
                    </span>
                    {owned > 0 && (
                      <span className="mc-acts">
                        {!gacha.hand.includes(card.id) && (
                          <button className="mc-change" onClick={() => takeFromCodex(card.id)} title="拿进手牌（最多三张）">
                            上手
                          </button>
                        )}
                        {!litAt && (
                          <button className="mc-change" onClick={() => changeTo(card.id)} title={`用 ${CHANGE_PRICE} 墨再定向换一张这张卡`}>
                            <Gem size={11} /> 换
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>

        <section className="gacha-rates bench">
          <h4>拆文对标</h4>
          <p className="hint">
            贴一本参考书进来，按章拆成<b>纯统计</b>：句长、对白占比、段首人称、章末落点、AI 味句式密度。
            跟自己这部并排比节奏，差距大的地方直接掉成卡。原文不进数据目录，也不联网、不花 token。
          </p>
          <div className="bench-form">
            <input value={benchTitle} onChange={(e) => setBenchTitle(e.target.value)} placeholder="对标书叫什么（如：某本公认标杆）" />
            <textarea
              value={benchText}
              onChange={(e) => setBenchText(e.target.value)}
              rows={4}
              placeholder="把参考书正文贴这里：认得出「第N章」就按章切，认不出按空行切"
            />
            <div className="form-acts">
              <button className="btn small" onClick={runBench}>
                拆开看
              </button>
              {books.length > 0 && (
                <select value={bench?.id ?? ''} onChange={(e) => setBenchPick(e.target.value)}>
                  {books.map((b) => (
                    <option key={b.id} value={b.id}>
                      对照：{b.title}（{b.chapters.length} 章）
                    </option>
                  ))}
                </select>
              )}
              {projects.length > 1 && (
                <select value={mine?.project.id ?? ''} onChange={(e) => setMinePick(e.target.value)}>
                  {projects.map((pr) => (
                    <option key={pr.id} value={pr.id}>
                      我的：{pr.title || '未命名'}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
          {benchMsg && <p className="hint bench-msg">{benchMsg}</p>}

          {mine && bench && (
            <div className="bench-cmp">
              <div className="bc-head">
                <span>节奏对照</span>
                <span>《{mine.project.title || '未命名'}》</span>
                <span>《{bench.title}》</span>
                <span>差</span>
              </div>
              {gaps.map((g) => (
                <div key={g.key} className={'bc-row' + (g.worth ? ' worth' : '')}>
                  <span className="bc-label">{g.label}</span>
                  <b>{g.mine}</b>
                  <b>{g.theirs}</b>
                  <span className="bc-diff">
                    {g.theirs > g.mine ? '+' : ''}
                    {Math.round((g.theirs - g.mine) * 10) / 10} {g.unit}
                    {g.worth && <em>值得学</em>}
                  </span>
                </div>
              ))}
              {!gaps.length && (
                <p className="hint">
                  {mine?.project.mode !== 'chapters'
                    ? '这本书是单篇模式，按一整篇算一条、拆不出「每章的节奏」——按章对照要用章节模式的书。'
                    : `两边各至少 3 章才比得出名堂（现在我的 ${mine.stats.length} 章 / 对标 ${bench.chapters.length} 章）。`}
                </p>
              )}
              {cardable.length > 0 && (
                <button className="btn small" onClick={() => dropCards(cardable, GAP_ALREADY)}>
                  把 {cardable.length} 条差距掉成卡
                </button>
              )}
            </div>
          )}

          <div className="self-drift">
            <h4 style={{ marginTop: 18 }}>
              <Gem size={13} /> 笔触漂移（对照的是你自己）
            </h4>
            {!selfPortrait.ok ? (
              <p className="hint">{selfPortrait.note}</p>
            ) : (
              <>
                <p className="hint">
                  底：{selfPortrait.baseLabel}；看：{selfPortrait.recentLabel}（{mine?.project.title || '未命名'}）。长篇最怕的不是像别人，是写着自己变了——这条基准就是你自己的尺子。
                </p>
                <div className="bc-head">
                  <span>节奏</span>
                  <span>惯常</span>
                  <span>现在</span>
                  <span>偏了多少</span>
                </div>
                {selfGaps.map((g) => (
                  <div key={g.key} className={'bc-row' + (g.worth ? ' worth' : '')}>
                    <span className="bc-label">{g.label}</span>
                    <b>{g.theirs}</b>
                    <b>{g.mine}</b>
                    <span className="bc-diff">
                      {g.mine > g.theirs ? '+' : ''}
                      {Math.round((g.mine - g.theirs) * 10) / 10} {g.unit}
                      {g.worth && <em>偏了</em>}
                    </span>
                  </div>
                ))}
                {selfCardable.length > 0 && (
                  <button className="btn small" onClick={() => dropCards(selfCardable, '这几条漂移已经掉过卡了，重复点不会堆重复卡。')}>
                    把 {selfCardable.length} 条漂移掉成「找回」卡
                  </button>
                )}
              </>
            )}
          </div>

          {books.length > 0 && (
            <div className="bench-list">
              {books.map((b) => {
                const r = rhythm(b.chapters);
                return (
                  <div key={b.id} className={'bench-row' + (bench?.id === b.id ? ' on' : '')}>
                    <button className="br-pick" onClick={() => setBenchPick(b.id)} title="用它做对照">
                      <b>{b.title}</b>
                      <span className="br-stat">
                        {b.chapters.length} 章 · 句长 {r.avgSentence} 字 · 对白 {r.dialogueShare}% · 章末落对白 {r.endsOnTalkShare}%
                      </span>
                    </button>
                    <button className="icon-btn" onClick={() => dropBenchAsk(b.id) && dropBench(b.id)} title="删掉这本统计（会先问你）">
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="gacha-rates">
          <h4>概率公示（本地明文，无暗箱）</h4>
          <p className="hint">
            {RARITY_ORDER.map((r) => `${r} ${Math.round(RATES[r] * 100)}%`).join(' · ')}；{PITY} 抽内必出 SSR；重复卡每张转 {INK_PER_DUP} 墨；墨可定向换卡。全部写死在代码里，没有后台调率。
          </p>
          <h4 style={{ marginTop: 16 }}>卡池内容（{pool.length} 张，内置 {BASE_CARDS.length}）</h4>
          <div className="pool-list">
            {BASE_CARDS.map((c) => (
              <label key={c.id} className={'pool-row' + (cards.off.includes(c.id) ? ' off' : '')}>
                <input type="checkbox" checked={!cards.off.includes(c.id)} onChange={() => toggleOff(c.id)} />
                <span className={'pr-r r-' + c.rarity}>{c.rarity}</span>
                <b>{c.name}</b>
                <span className="pr-eff">{EFFECT_LABEL[c.effect] ?? c.effect}</span>
              </label>
            ))}
          </div>
          <p className="hint">勾掉的卡不进池子——某张卡老是干扰你，就让它先不出。</p>

          <h4 style={{ marginTop: 16 }}>自建卡（{cards.custom.length}）</h4>
          {adding ? (
            <div className="inline-form">
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="卡名，如「让海先说话」" />
              <select value={draft.rarity} onChange={(e) => setDraft({ ...draft, rarity: e.target.value })}>
                {RARITY_ORDER.map((r) => (
                  <option key={r} value={r}>
                    {RARITY_CN[r]}
                  </option>
                ))}
              </select>
              <select value={draft.effect} onChange={(e) => setDraft({ ...draft, effect: e.target.value })}>
                {Object.entries(EFFECT_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              <textarea value={draft.payload} onChange={(e) => setDraft({ ...draft, payload: e.target.value })} placeholder="卡面任务；可用槽位 {char} {place} {item} {hook} {num}" rows={2} />
              <div className="form-acts">
                <button className="btn small" onClick={addCustom}>
                  放进池子
                </button>
                <button className="btn small ghost" onClick={() => setAdding(false)}>
                  算了
                </button>
              </div>
            </div>
          ) : (
            <button className="btn small" onClick={() => setAdding(true)}>
              加一张自建卡
            </button>
          )}
          {cards.custom.length > 0 && (
            <div className="pool-list">
              {cards.custom.map((c) => (
                <div key={c.id} className="pool-row">
                  <span className={'pr-r r-' + c.rarity}>{c.rarity}</span>
                  <b>{c.name}</b>
                  <span className="pr-eff">{c.payload.slice(0, 40)}</span>
                  <button className="icon-btn" onClick={() => { if (window.confirm(`删掉自建卡「${c.name}」？`)) setCards({ ...cards, custom: cards.custom.filter((x) => x.id !== c.id) }); }} title="删掉这张（会先问你）">
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {drawn && drawn.length > 0 && <CardStage cards={drawn} onClose={() => setDrawn(null)} />}
    </>
  );
}

const SERIES_NOTE: Record<string, string> = {
  小事: '一句就能落地：一个动作、一件东西、一条硬约束。',
  岔路: '两个你已经写过的元素被迫相撞。',
  破格: '一次叙事手法，专门用来破「顺着写」。',
  大局: '跨卷局面，打出后自动铺进后续未写章。',
  练笔: '条件本身就是奖品：句长、对白占比、段首人称、AI 味句式——写到达标才点亮。',
};

