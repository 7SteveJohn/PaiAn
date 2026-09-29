import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { EFFECT_LABEL, type GachaCard } from '../gacha';
import { describe, summarize } from '../constraints';

interface Props {
  cards: GachaCard[]; // 本次抽到的卡（1 或 10 张）
  onClose: () => void;
}

const RANK: Record<string, number> = { N: 0, R: 1, SR: 2, SSR: 3 };

// 抽卡动效层：卡背逐张翻开，稀有度决定描边与光柱；SSR 另加全屏金光与轻微震屏。
// 纯 CSS 动画（见 index.css 的 gacha-* 段），不引动画库；点任意处立刻全部翻开。
export default function CardStage({ cards, onClose }: Props) {
  const [shown, setShown] = useState(0);
  const best = cards.reduce((a, c) => ((RANK[c.rarity] ?? 0) > (RANK[a?.rarity ?? 'N'] ?? 0) ? c : a), cards[0]);
  const done = shown >= cards.length;

  useEffect(() => {
    const t = setInterval(() => setShown((s) => (s >= cards.length ? s : s + 1)), cards.length > 1 ? 240 : 420);
    return () => clearInterval(t);
  }, [cards.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className={'gacha-stage' + (best && best.rarity === 'SSR' ? ' has-ssr' : '')}
      onClick={() => (done ? onClose() : setShown(cards.length))}
      role="dialog"
      aria-label="抽卡结果"
    >
      <div className={'gacha-beam r-' + (best?.rarity ?? 'N')} />
      <div className="gacha-inner">
        <div className="gacha-head">
          <span className="gacha-title">{cards.length > 1 ? '十连' : '一抽'} · {best?.rarity ?? 'N'}</span>
          <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onClose(); }} title="关闭（Esc）">
            <X size={16} />
          </button>
        </div>
        <div className={'gacha-cards' + (cards.length > 1 ? ' many' : ' one')}>
          {cards.map((c, i) => (
            <div key={c.id + i} className={'gacha-card r-' + c.rarity + (i < shown ? ' flipped' : '')} style={{ animationDelay: i * 90 + 'ms' }}>
              <div className="gc-face gc-back">
                <span className="gc-seal">创</span>
              </div>
              <div className="gc-face gc-front">
                <span className="gc-rarity">{c.rarity}</span>
                <span className="gc-series">{c.series}</span>
                <b className="gc-name">{c.name}</b>
                <p className="gc-text">{c.payload}</p>
                {summarize(describe(c)) && <span className="gc-cond">{summarize(describe(c))}</span>}
                <span className="gc-effect">{EFFECT_LABEL[c.effect] ?? c.effect}</span>
              </div>
            </div>
          ))}
        </div>
        <p className="gacha-hint">{done ? '点任意处收下（新卡进手牌，重复卡转「墨」）' : '点击立刻全部翻开'}</p>
      </div>
    </div>
  );
}

