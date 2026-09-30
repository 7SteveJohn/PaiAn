// 取名面板：本地词库翻牌。三秒一批、顺眼就钉住，钉够了一次性建成卡片。
// 刻意不叫 AI——等的是一次网络往返，看到的是一批可以马上挑的字。
import { useMemo, useState } from 'react';
import { Dices, Pin, Copy, Check, X } from 'lucide-react';
import type { Project } from '../types';
import { NAME_CATEGORIES, NAME_STYLES, generateNames, pickToWorldKind, usedNames, type NameCategory, type NamePick, type NameStyle } from '../names';

interface Props {
  project: Project;
  onCommit: (picks: NamePick[]) => string; // 返回一句回执（建了几张、跳过几张重名）
  /** 钉住的名单放外面：面板是切页签就卸载的，钉住放本地态等于「切一下全白挑」 */
  pinned: NamePick[];
  setPinned: (updater: (prev: NamePick[]) => NamePick[]) => void;
}

const CAT_LABEL: Record<NameCategory, string> = {
  人物男: '人物·男',
  人物女: '人物·女',
  别号: '别号/称号',
  势力: '势力/门派',
  功法: '功法/武学',
  地名: '地名',
  器物: '器物/法宝',
};

const seed0 = () => Math.floor(Math.random() * 900000) + 100000;

// 作品类型能对上气质档就顺着它，省得每次手动切
const styleOf = (project: Project): NameStyle => {
  const t = (project.type || '').trim();
  if (NAME_STYLES.includes(t as NameStyle)) return t as NameStyle;
  if (t.includes('都市') || t.includes('现代') || t.includes('言情')) return '都市';
  if (t.includes('西幻') || t.includes('奇幻')) return '西幻';
  if (t.includes('古') || t.includes('仙侠') || t.includes('武侠')) return '古言';
  return '玄幻';
};

export default function NamesPanel({ project, onCommit, pinned, setPinned }: Props) {
  const [category, setCategory] = useState<NameCategory>('人物男');
  const [style, setStyle] = useState<NameStyle>(() => styleOf(project));
  const [twoChar, setTwoChar] = useState(true);
  const [count, setCount] = useState(10);
  const [seed, setSeed] = useState(seed0);
  const [msg, setMsg] = useState('');

  const banned = useMemo(() => [...usedNames(project), ...pinned.map((p) => p.name)], [project, pinned]);
  const picks = useMemo(
    () => generateNames({ category, style, seed, count, twoChar, banned }),
    // banned 只用来避开重名，不必因为它重算一批（否则钉住一个就整批换掉）
    [category, style, seed, count, twoChar] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const isPerson = category === '人物男' || category === '人物女';

  const copy = async (name: string) => {
    try {
      await navigator.clipboard.writeText(name);
      setMsg(`已复制「${name}」。`);
    } catch {
      setMsg('剪贴板不可用，手动选中即可。');
    }
  };
  const togglePin = (p: NamePick) => {
    setPinned((prev) => (prev.some((x) => x.name === p.name) ? prev.filter((x) => x.name !== p.name) : [...prev, p]));
    setMsg('');
  };
  const commit = (list: NamePick[]) => {
    if (!list.length) return;
    setMsg(onCommit(list));
    if (list.every((p) => !pinned.some((x) => x.name === p.name))) return;
    setPinned((prev) => prev.filter((x) => !list.some((p) => p.name === x.name)));
  };

  return (
    <div className="names-panel">
      <p className="hint">本地词库拼装，不联网、不叫 AI：换一批只是换个种子。挑中的先钉住，钉够了一次性建成人物卡 / 设定卡。</p>

      <div className="np-row">
        <span className="np-label">要什么</span>
        <div className="np-chips">
          {NAME_CATEGORIES.map((c) => (
            <button key={c} className={'chip' + (category === c ? ' on' : '')} onClick={() => setCategory(c)}>
              {CAT_LABEL[c]}
            </button>
          ))}
        </div>
      </div>
      <div className="np-row">
        <span className="np-label">气质</span>
        <div className="np-chips">
          {NAME_STYLES.map((s) => (
            <button key={s} className={'chip' + (style === s ? ' on' : '')} onClick={() => setStyle(s)}>
              {s}
            </button>
          ))}
        </div>
        {isPerson && (
          <button className="chip" onClick={() => setTwoChar((v) => !v)} title="人物名几个字">
            {twoChar ? '双名' : '单名'}
          </button>
        )}
        <select className="np-count" value={count} onChange={(e) => setCount(Number(e.target.value))} title="一次出几个">
          {[6, 10, 16, 24].map((n) => (
            <option key={n} value={n}>
              一次 {n} 个
            </option>
          ))}
        </select>
      </div>

      <div className="np-acts">
        <button className="btn small primary" onClick={() => setSeed(seed0())}>
          <Dices size={13} /> 换一批
        </button>
        <span className="hint">种子 {seed}</span>
        <span className="foot-spacer" />
        <button className="mini-btn" disabled={!pinned.length} onClick={() => commit(pinned)} title="把钉住的全部建成卡片">
          <Check size={12} /> 把钉住的 {pinned.length} 个建卡
        </button>
      </div>

      {pinned.length > 0 && (
        <div className="np-pinbar">
          {pinned.map((p) => (
            <span key={p.name} className="np-pinned" title={p.note}>
              {p.name}
              <button className="np-unpin" onClick={() => togglePin(p)} title="取消钉住">
                <X size={11} />
              </button>
              <button className="np-single" onClick={() => commit([p])} title="只建这一张">
                <Check size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="np-grid">
        {picks.map((p) => {
          const on = pinned.some((x) => x.name === p.name);
          return (
            <div key={p.name + p.category} className="np-item">
              <b className="np-name">{p.name}</b>
              <span className="np-note" title={p.note}>
                {p.note}
              </span>
              <span className="np-ops">
                <button className={'mini-btn' + (on ? ' ok' : '')} onClick={() => togglePin(p)} title={on ? '取消钉住' : '钉住，稍后一起建卡'}>
                  <Pin size={12} /> {on ? '已钉' : '钉住'}
                </button>
                <button
                  className="mini-btn"
                  onClick={() => commit([p])}
                  title={`直接建卡：${p.kind === 'char' ? '人物卡' : pickToWorldKind(p)}`}
                >
                  建卡
                </button>
                <button className="icon-btn" onClick={() => copy(p.name)} title="复制这个名字">
                  <Copy size={12} />
                </button>
              </span>
            </div>
          );
        })}
      </div>

      <p className="hint np-foot">
        本书已用 {usedNames(project).length} 个名字，生成时自动避开（钉住的也算）。重名一定不出现，但同姓、同尾字还会撞——那正是要挑的时候看一眼的。
      </p>
      {msg && <div className="hint np-msg">{msg}</div>}
    </div>
  );
}
