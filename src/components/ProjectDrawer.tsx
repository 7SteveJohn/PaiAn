import { lazy, Suspense, useState, type ReactNode } from 'react';
import { Plus, Trash2, X, LocateFixed, CornerUpLeft, RotateCcw, Wand2, Sparkles } from 'lucide-react';
import type { AIPublic, Character, Chapter, Project, StoryBranch, TextMark, WorldItem } from '../types';
import { countWords, localStamp, rulesSuffix, uid } from '../util';
import { askText, streamChat } from '../api';
import { bioEvidence, buildBioMessages, sanitizeBio } from '../bio';
import { placeChain, fragmentLinks } from '../geo';
// 词库与面板按需加载：不打开「取名」页签就不该把这堆汉字算进首屏包
const NamesPanel = lazy(() => import('./NamesPanel'));
import type { NamePick } from '../names'; // 只引类型：词库跟着懒加载的面板走，不进首屏包

export type DrawerTab = '伏笔' | '碎片' | '人物' | '设定' | '彩蛋' | '分支' | '玩法' | '取名';

const TABS: DrawerTab[] = ['伏笔', '碎片', '人物', '设定', '彩蛋', '分支', '玩法', '取名'];

const WORLD_KINDS: WorldItem['kind'][] = ['地点', '道具', '设定', '势力', '功法', '力量体系'];

// 设定卡模板：按类型快速建卡，脚手架提示该卡应填什么
const WORLD_TEMPLATES: { kind: WorldItem['kind']; label: string; scaffold: string }[] = [
  { kind: '势力', label: '势力卡', scaffold: '立场：\n据点：\n关键人物：\n与主角的关系：' },
  { kind: '功法', label: '功法卡', scaffold: '品阶：\n修炼条件：\n效果：\n副作用：' },
  { kind: '力量体系', label: '力量体系', scaffold: '等级划分（低→高）：\n突破条件：\n当前版本战力上限：' },
  { kind: '地点', label: '地点卡', scaffold: '方位：\n特征：\n关联事件：' },
  { kind: '道具', label: '道具卡', scaffold: '品阶：\n能力：\n当前持有者：' },
  { kind: '设定', label: '自由设定', scaffold: '' },
];

// AI 整理导入返回的结构化设定卡
interface ParsedWorldItem {
  name: string;
  kind: WorldItem['kind'];
  content: string;
}

function parseWorldItems(raw: string): ParsedWorldItem[] | null {
  const s = raw.indexOf('[');
  const e = raw.lastIndexOf(']');
  if (s < 0 || e <= s) return null;
  try {
    const arr = JSON.parse(raw.slice(s, e + 1)) as unknown;
    if (!Array.isArray(arr)) return null;
    const items = arr
      .filter((x) => x && typeof (x as ParsedWorldItem).name === 'string' && (x as ParsedWorldItem).name.trim())
      .map((x) => {
        const o = x as ParsedWorldItem;
        const kind = WORLD_KINDS.includes(o.kind) ? o.kind : '设定';
        return { name: o.name.trim().slice(0, 30), kind, content: (o.content ?? '').toString().trim().slice(0, 600) };
      });
    return items.length ? items : null;
  } catch {
    return null;
  }
}

// 战力变更的「新增记录」行：章节下拉 + 变更文本，回车或点加号记录
function PowerAddRow({ chapters, onAdd }: { chapters: Chapter[]; onAdd: (chapterId: string | undefined, text: string) => void }) {
  const [cid, setCid] = useState('');
  const [text, setText] = useState('');
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onAdd(cid || undefined, t);
    setText('');
  };
  return (
    <div className="char-rel-row">
      <select className="drawer-mini-input" style={{ width: 86 }} value={cid} onChange={(e) => setCid(e.target.value)} title="绑定到哪一章">
        <option value="">未绑章节</option>
        {chapters.map((c, i) => (
          <option key={c.id} value={c.id}>
            第{i + 1}章
          </option>
        ))}
      </select>
      <input
        className="drawer-mini-input grow"
        value={text}
        placeholder="变更内容，如：突破筑基后期"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <button className="icon-btn" title="记录战力变更" onClick={submit}>
        <Plus size={12} />
      </button>
    </div>
  );
}

interface Props {
  project: Project;
  ideas: { id: string; content: string; kind: string }[];
  aiInfo: AIPublic;
  tab: DrawerTab;
  onTab: (t: DrawerTab) => void;
  onClose: () => void;
  onUpdate: (id: string, patch: Partial<Project>, opts?: { snapshot?: boolean }) => void;
  onJump: (pos: number, chapterId?: string) => void;
  onInsert: (text: string) => void;
  leaving?: boolean; // 外层晚 170ms 卸载，用来播退场动画；宽屏并排时不用
}

// 右侧窄抽屉（约占 25%）：伏笔 / 碎片 / 人物 / 设定 / 彩蛋 / 分支 / 禁用词，ESC 收回由外层处理
export default function ProjectDrawer({ project, ideas, aiInfo, tab, onTab, onClose, onUpdate, onJump, onInsert, leaving }: Props) {
  const marks = project.marks ?? [];
  const chapters = project.chapters ?? [];
  const isChapter = project.mode === 'chapters';
  const [charName, setCharName] = useState('');
  const [branchTitle, setBranchTitle] = useState('');
  const [forbiddenInput, setForbiddenInput] = useState((project.game?.forbidden ?? []).join('，'));
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<(ParsedWorldItem & { skip: boolean })[] | null>(null);
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [bioId, setBioId] = useState<string | null>(null); // 正在提炼人生经历的人物卡 id
  const [bioMsg, setBioMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const chapterBadge = (m: TextMark) => {
    if (!isChapter || !m.chapterId) return null;
    const i = chapters.findIndex((c) => c.id === m.chapterId);
    return i >= 0 ? <em className="orphan-tag">{i + 1}章</em> : null;
  };

  const patchMarks = (fn: (m: TextMark[]) => TextMark[]) => onUpdate(project.id, { marks: fn(marks) });
  const patchChars = (fn: (c: Character[]) => Character[]) => onUpdate(project.id, { characters: fn(project.characters ?? []) });
  const patchWorld = (fn: (w: WorldItem[]) => WorldItem[]) => onUpdate(project.id, { worldItems: fn(project.worldItems ?? []) });
  const patchBranches = (fn: (b: StoryBranch[]) => StoryBranch[]) => onUpdate(project.id, { branches: fn(project.branches ?? []) });

  // 取名面板建卡：人物进人物卡，其余进设定卡；同名一律跳过，不覆盖已有卡
  const commitPicks = (picks: NamePick[]): string => {
    const chars = picks.filter((p) => p.kind === 'char');
    const worlds = picks.filter((p) => p.kind !== 'char');
    const hasChar = new Set((project.characters ?? []).map((c) => c.name));
    const hasWorld = new Set((project.worldItems ?? []).map((w) => w.name));
    const freshChars = chars.filter((p) => !hasChar.has(p.name));
    const freshWorlds = worlds.filter((p) => !hasWorld.has(p.name));
    const skipped = picks.length - freshChars.length - freshWorlds.length;
    if (freshChars.length) patchChars((cs) => [...cs, ...freshChars.map((p) => ({ id: uid(), name: p.name, state: '', log: [], relations: [] }))]);
    if (freshWorlds.length)
      patchWorld((ws) => [...ws, ...freshWorlds.map((p) => ({ id: uid(), name: p.name, kind: p.worldKind ?? '设定', content: '' }))]);
    if (!freshChars.length && !freshWorlds.length) return `都重名，没建卡（跳过 ${skipped} 个）——换一批或改个字。`;
    const bits = [freshChars.length ? `人物卡 ${freshChars.length} 张` : '', freshWorlds.length ? `设定卡 ${freshWorlds.length} 张` : '', skipped ? `跳过重名 ${skipped}` : ''].filter(Boolean);
    return `已建 ${bits.join('，')}。可以在「人物 / 设定」页签里补状态与设定。`;
  };

  // ---------- AI 整理导入：混乱资料 → 结构化设定卡 ----------
  const organizeImport = async () => {
    const src = importText.trim();
    if (!src) return;
    setImportBusy(true);
    setImportMsg(null);
    try {
      const existNames = (project.worldItems ?? []).map((w) => w.name);
      let raw = '';
      await streamChat(
        [
          {
            role: 'system',
            content:
              '你是网文设定整理助手。把作者提供的混乱资料整理成结构化设定卡。只输出 JSON 数组，不要解释，不要 markdown 代码块。' +
              '元素格式：{"name":"名称","kind":"势力|功法|力量体系|地点|道具|设定","content":"该设定的关键信息，120字内"}。' +
              '资料里没有的信息不要编造；零散的句子要归并到最相关的卡里。' + rulesSuffix(aiInfo.rules),
          },
          {
            role: 'user',
            content:
              (existNames.length ? `已有设定（不要重复收录，同名归并进资料即可）：${existNames.join('、')}\n\n` : '') +
              `请整理以下资料：\n\n"""${src.slice(0, 3000)}"""`,
          },
        ],
        (t) => (raw += t),
      );
      const items = parseWorldItems(raw);
      if (!items) {
        setImportMsg({ ok: false, text: 'AI 返回内容无法解析为设定卡，请重试或换模型。' });
        return;
      }
      setImportResult(items.map((it) => ({ ...it, skip: false })));
      setImportMsg({ ok: true, text: `整理出 ${items.length} 条设定卡，检查后点「导入所选」。` });
    } catch (e) {
      setImportMsg({ ok: false, text: '整理失败：' + (e as Error).message });
    } finally {
      setImportBusy(false);
    }
  };

  const applyImport = () => {
    const picked = (importResult ?? []).filter((it) => !it.skip);
    if (!picked.length) return;
    const exist = new Set((project.worldItems ?? []).map((w) => w.name));
    const fresh = picked.filter((it) => !exist.has(it.name));
    const dup = picked.length - fresh.length;
    patchWorld((ws) => [...ws, ...fresh.map((it) => ({ id: uid(), name: it.name, kind: it.kind, content: it.content }))]);
    setImportResult(null);
    setImportText('');
    setImportOpen(false);
    setImportMsg({ ok: true, text: `已导入 ${fresh.length} 条${dup ? `，跳过重名 ${dup} 条` : ''}。` });
  };

  // ---------- 人生经历提炼：散在各章的出场 → 一段连贯经历 ----------
  // 与「出场记忆」的分工：那是按章逐条记流水（log），这是跨章汇总成一段（bio）；证据只取真的提了他名字的章。
  const refineBio = async (c: Character) => {
    const evidence = bioEvidence(project, c.name);
    if (!evidence.length) {
      setBioMsg({ ok: false, text: `正文和出场名单里都找不到「${c.name}」，先写一段再提炼。` });
      return;
    }
    setBioId(c.id);
    setBioMsg(null);
    try {
      const raw = await askText(buildBioMessages(c, evidence, rulesSuffix(aiInfo.rules)), 0.4);
      const bio = sanitizeBio(raw);
      if (!bio) {
        setBioMsg({ ok: false, text: 'AI 没给出可用的经历，换个模型或再试一次。' });
        return;
      }
      patchChars((cs) => cs.map((x) => (x.id === c.id ? { ...x, bio } : x)));
      setBioMsg({ ok: true, text: `已把「${c.name}」的经历写进卡里（${evidence.length} 章证据），可随手改。` });
    } catch (e) {
      setBioMsg({ ok: false, text: '提炼失败：' + (e as Error).message });
    } finally {
      setBioId(null);
    }
  };

  const foreshadows = marks.filter((m) => m.type === '伏笔');
  const fragments = marks.filter((m) => m.type === '碎片');
  const characterMarks = marks.filter((m) => m.type === '人物');
  const sceneMarks = marks.filter((m) => m.type === '场景');
  const eggs = marks.filter((m) => m.type === '彩蛋');

  const MarkRow = ({ m, extra, children }: { m: TextMark; extra?: ReactNode; children?: ReactNode }) => (
    <>
      <div className={'drawer-row' + (m.orphaned ? ' orphaned' : '')}>
        <button
          className="drawer-row-text"
          title={m.orphaned ? '原文已变，锚点失效' : '点击跳转到正文位置'}
          onClick={() => !m.orphaned && onJump(m.start, m.chapterId)}
        >
          {m.text.slice(0, 26) || '（空）'}
          {chapterBadge(m)}
          {m.orphaned && <em className="orphan-tag">原文已变</em>}
        </button>
        {extra}
        <button className="icon-btn" title="删除标记" onClick={() => patchMarks((ms) => ms.filter((x) => x.id !== m.id))}>
          <Trash2 size={13} />
        </button>
      </div>
      {children}
    </>
  );

  // 导出带彩蛋注释的阅读版（注释按章插入，正文本身始终干净）
  const exportAnnotated = () => {
    let text: string;
    if (isChapter) {
      text = chapters
        .map((c, i) => {
          let t = c.content;
          const ce = marks
            .filter((m) => m.type === '彩蛋' && !m.orphaned && m.chapterId === c.id)
            .sort((a, b) => b.start - a.start);
          for (const m of ce) t = t.slice(0, m.end) + `〔彩蛋：${m.note || '无注释'}〕` + t.slice(m.end);
          return `## 第${i + 1}章 ${c.title}\n\n${t}`;
        })
        .join('\n\n');
    } else {
      let t = project.draft;
      const ce = marks.filter((m) => m.type === '彩蛋' && !m.orphaned).sort((a, b) => b.start - a.start);
      for (const m of ce) t = t.slice(0, m.end) + `〔彩蛋：${m.note || '无注释'}〕` + t.slice(m.end);
      text = t;
    }
    const blob = new Blob([`# ${project.title || '未命名'}（带彩蛋注释阅读版）\n\n${text}`], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(project.title || '未命名').replace(/[\\/:*?"<>|]/g, '_')}-annotated.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <aside className={'drawer' + (leaving ? ' leaving' : '')}>
      <div className="drawer-tabs">
        {TABS.map((t) => (
          <button key={t} className={'drawer-tab' + (tab === t ? ' on' : '')} onClick={() => onTab(t)}>
            {t}
            {t === '伏笔' && foreshadows.some((m) => m.status !== '回收') && <em className="tab-dot" />}
          </button>
        ))}
        <button className="icon-btn" onClick={onClose} title="收起（Esc）">
          <X size={15} />
        </button>
      </div>

      <div className="drawer-body">
        {tab === '伏笔' && (
          <>
            <p className="hint">选中正文用悬浮菜单标「伏笔」；回收后点状态切换。未回收的伏笔会在页签上亮小点。</p>
            {foreshadows.length === 0 && <div className="empty" style={{ marginTop: 24 }}>还没有伏笔标记。</div>}
            {foreshadows.map((m) => (
              <MarkRow
                key={m.id}
                m={m}
                extra={
                  <>
                    <button
                      className={'status-pill ' + (m.status === '回收' ? 'stc-done' : 'stc-drafting')}
                      title="点击切换 埋下/回收"
                      onClick={() => patchMarks((ms) => ms.map((x) => (x.id === m.id ? { ...x, status: x.status === '回收' ? '埋下' : '回收' } : x)))}
                    >
                      {m.status ?? '埋下'}
                    </button>
                    <input
                      className="drawer-mini-input"
                      value={m.expected ?? ''}
                      placeholder="预期章节"
                      list="drawer-chapters"
                      onChange={(e) => patchMarks((ms) => ms.map((x) => (x.id === m.id ? { ...x, expected: e.target.value } : x)))}
                    />
                  </>
                }
              />
            ))}
            <datalist id="drawer-chapters">
              {chapters.map((c, i) => (
                <option key={c.id} value={`第${i + 1}章`} />
              ))}
            </datalist>
          </>
        )}

        {tab === '碎片' && (
          <>
            <p className="hint">标「碎片」的原文片段与关联素材都在这里，可插回正文。碎片里提到的角色 / 设定会自动标出来。</p>
            {fragments.map((m) => {
              const links = fragmentLinks(`${m.text} ${m.note ?? ''}`, [
                ...(project.characters ?? []).map((c) => c.name),
                ...(project.worldItems ?? []).map((w) => w.name),
              ]);
              return (
                <MarkRow
                  key={m.id}
                  m={m}
                  extra={
                    <button className="icon-btn" title="插入到正文光标处" onClick={() => onInsert(m.text)}>
                      <CornerUpLeft size={13} />
                    </button>
                  }
                >
                  {links.length > 0 && (
                    <div className="frag-links" title="碎片文本里提到的实体，点「设定」页签去看对应的卡">
                      提到：{links.map((n) => (
                        <em key={n}>{n}</em>
                      ))}
                    </div>
                  )}
                </MarkRow>
              );
            })}
            <h4 className="drawer-h4">关联素材</h4>
            {(project.linkedIdeaIds ?? []).length === 0 && <p className="hint">还没有关联灵感库素材。</p>}
            {ideas
              .filter((i) => project.linkedIdeaIds.includes(i.id))
              .map((i) => (
                <div key={i.id} className="drawer-row">
                  <span className="drawer-row-text">{i.content.slice(0, 26)}</span>
                  <button className="icon-btn" title="插入到正文光标处" onClick={() => onInsert(i.content)}>
                    <CornerUpLeft size={13} />
                  </button>
                </div>
              ))}
          </>
        )}

        {tab === '人物' && (
          <>
            <div className="drawer-add-row">
              <input
                value={charName}
                onChange={(e) => setCharName(e.target.value)}
                placeholder="新人物名字"
                className="drawer-mini-input grow"
              />
              <button
                className="btn small"
                onClick={() => {
                  const name = charName.trim();
                  if (!name) return;
                  patchChars((cs) => [...cs, { id: uid(), name, state: '', log: [], relations: [] }]);
                  setCharName('');
                }}
              >
                <Plus size={13} /> 添加
              </button>
            </div>
            {(project.characters ?? []).length === 0 && <p className="hint">添加主要人物，记录每个阶段的心理状态，避免 OOC。</p>}
            {bioMsg && <div className={'field-msg ' + (bioMsg.ok ? 'ok' : 'fail')}>{bioMsg.text}</div>}
            {characterMarks.length > 0 && (
              <>
                <h4 className="drawer-h4">正文已标记人名</h4>
                {characterMarks.map((m) => (
                  <MarkRow key={m.id} m={m} />
                ))}
              </>
            )}
            {(project.characters ?? []).map((c) => (
              <div key={c.id} className="char-card">
                <div className="char-head">
                  <b>{c.name}</b>
                  <button className="icon-btn" title="删除人物" onClick={() => patchChars((cs) => cs.filter((x) => x.id !== c.id))}>
                    <Trash2 size={12} />
                  </button>
                </div>
                <input
                  className="drawer-mini-input"
                  value={c.state}
                  placeholder="当前心理状态，如：隐忍、起疑"
                  onChange={(e) => patchChars((cs) => cs.map((x) => (x.id === c.id ? { ...x, state: e.target.value } : x)))}
                />
                <input
                  className="drawer-mini-input"
                  value={c.power ?? ''}
                  placeholder="当前境界 / 战力，如：筑基后期"
                  onChange={(e) => patchChars((cs) => cs.map((x) => (x.id === c.id ? { ...x, power: e.target.value } : x)))}
                />
                <div className="char-bio">
                  <div className="char-bio-head">
                    <span>人生经历</span>
                    <button
                      className="mini-btn"
                      disabled={!aiInfo.ready || bioId === c.id}
                      title={aiInfo.ready ? '按各章出场证据，把他迄今的经历汇总成一段' : '先在设置页配好 AI'}
                      onClick={() => void refineBio(c)}
                    >
                      <Sparkles size={12} /> {bioId === c.id ? '提炼中…' : 'AI 提炼'}
                    </button>
                  </div>
                  <textarea
                    className="drawer-mini-input char-bio-text"
                    value={c.bio ?? ''}
                    placeholder="他迄今经历了什么（可 AI 按出场证据提炼，也可自己写）"
                    onChange={(e) => patchChars((cs) => cs.map((x) => (x.id === c.id ? { ...x, bio: e.target.value } : x)))}
                  />
                </div>
                {(c.powerLog ?? []).length > 0 && (
                  <div className="char-log">
                    {(c.powerLog ?? []).map((pl, i) => (
                      <div key={i} className="char-rel-row">
                        <select
                          className="drawer-mini-input"
                          style={{ width: 86 }}
                          value={pl.chapterId ?? ''}
                          title="变更发生的章节"
                          onChange={(e) =>
                            patchChars((cs) =>
                              cs.map((x) =>
                                x.id === c.id
                                  ? { ...x, powerLog: (x.powerLog ?? []).map((p2, j) => (j === i ? { ...p2, chapterId: e.target.value || undefined } : p2)) }
                                  : x,
                              ),
                            )
                          }
                        >
                          <option value="">未绑章节</option>
                          {chapters.map((ch, j) => (
                            <option key={ch.id} value={ch.id}>
                              第{j + 1}章
                            </option>
                          ))}
                        </select>
                        <input
                          className="drawer-mini-input grow"
                          value={pl.text}
                          placeholder="变更内容"
                          onChange={(e) =>
                            patchChars((cs) =>
                              cs.map((x) => (x.id === c.id ? { ...x, powerLog: (x.powerLog ?? []).map((p2, j) => (j === i ? { ...p2, text: e.target.value } : p2)) } : x)),
                            )
                          }
                        />
                        <button
                          className="icon-btn"
                          title="删除该记录"
                          onClick={() => patchChars((cs) => cs.map((x) => (x.id === c.id ? { ...x, powerLog: (x.powerLog ?? []).filter((_, j) => j !== i) } : x)))}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <PowerAddRow
                  chapters={chapters}
                  onAdd={(chapterId, text) =>
                    patchChars((cs) => cs.map((x) => (x.id === c.id ? { ...x, powerLog: [...(x.powerLog ?? []), { chapterId, text }] } : x)))
                  }
                />
                <div className="char-log">
                  {(c.log ?? []).map((l, i) => (
                    <div key={i} className="char-log-row">
                      <span className="char-log-at">{l.at}</span>
                      <span>{l.text}</span>
                    </div>
                  ))}
                </div>
                <input
                  className="drawer-mini-input"
                  placeholder="履历：这一阶段经历了什么，回车记录"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const el = e.currentTarget;
                      const text = el.value.trim();
                      if (!text) return;
                      patchChars((cs) => cs.map((x) => (x.id === c.id ? { ...x, log: [...(x.log ?? []), { at: localStamp(), text }] } : x)));
                      el.value = '';
                    }
                  }}
                />
                <input
                  className="drawer-mini-input"
                  placeholder="关系：对方名字"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const el = e.currentTarget;
                      const who = el.value.trim();
                      if (!who) return;
                      patchChars((cs) => cs.map((x) => (x.id === c.id ? { ...x, relations: [...(x.relations ?? []), { with: who, note: '' }] } : x)));
                      el.value = '';
                    }
                  }}
                />
                {(c.relations ?? []).map((r, i) => (
                  <div key={i} className="char-rel-row">
                    <b>{r.with}</b>
                    <input
                      className="drawer-mini-input grow"
                      value={r.note}
                      placeholder="关系备注（对手戏/关键事件）"
                      onChange={(e) =>
                        patchChars((cs) =>
                          cs.map((x) =>
                            x.id === c.id ? { ...x, relations: x.relations.map((rr, j) => (j === i ? { ...rr, note: e.target.value } : rr)) } : x,
                          ),
                        )
                      }
                    />
                    <button
                      className="icon-btn"
                      title="删除关系"
                      onClick={() =>
                        patchChars((cs) => cs.map((x) => (x.id === c.id ? { ...x, relations: x.relations.filter((_, j) => j !== i) } : x)))
                      }
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}

        {tab === '设定' && (
          <>
            <p className="hint">地点 / 道具 / 势力 / 功法 / 力量体系卡片，会被注入 AI 上下文。选中正文标「场景」可快速登记地点。</p>
            <datalist id="place-parent-options">
              {(project.worldItems ?? []).filter((x) => x.kind === '地点' && x.name.trim()).map((x) => (
                <option key={x.id} value={x.name} />
              ))}
            </datalist>
            {sceneMarks.length > 0 && (
              <>
                <h4 className="drawer-h4">已标记场景</h4>
                {sceneMarks.map((m) => (
                  <MarkRow key={m.id} m={m} />
                ))}
              </>
            )}
            <h4 className="drawer-h4">设定卡</h4>
            <div className="tpl-row">
              {WORLD_TEMPLATES.map((t) => (
                <button
                  key={t.kind}
                  className="chip tiny"
                  title={t.scaffold ? '按模板建卡' : '空白卡'}
                  onClick={() => patchWorld((ws) => [...ws, { id: uid(), name: `新${t.kind}`, kind: t.kind, content: t.scaffold }])}
                >
                  <Plus size={10} /> {t.label}
                </button>
              ))}
            </div>
            <button className="btn small" style={{ marginTop: 8 }} onClick={() => setImportOpen((v) => !v)}>
              <Wand2 size={13} /> {importOpen ? '收起 AI 整理导入' : 'AI 整理导入'}
            </button>
            {importOpen && (
              <div className="import-box">
                <textarea
                  className="drawer-mini-textarea"
                  rows={5}
                  value={importText}
                  placeholder="把随手记的混乱设定贴进来（聊天记录、备忘、灵感碎片都行），AI 会整理成结构化设定卡。"
                  onChange={(e) => setImportText(e.target.value)}
                />
                <button className="btn small primary" disabled={!aiInfo.ready || importBusy || !importText.trim()} onClick={organizeImport}>
                  {importBusy ? '整理中…' : 'AI 整理'}
                </button>
                {!aiInfo.ready && <span className="hint" style={{ marginLeft: 8 }}>需先在「设置」配置 AI。</span>}
              </div>
            )}
            {importMsg && <div className={'field-msg ' + (importMsg.ok ? 'ok' : 'fail')}>{importMsg.text}</div>}
            {importResult && (
              <div className="import-preview">
                {importResult.map((it, i) => (
                  <div key={i} className={'import-card' + (it.skip ? ' skipped' : '')}>
                    <div className="char-head">
                      <input
                        type="checkbox"
                        checked={!it.skip}
                        onChange={(e) => setImportResult((rs) => rs!.map((x, j) => (j === i ? { ...x, skip: !e.target.checked } : x)))}
                      />
                      <input
                        className="drawer-mini-input"
                        value={it.name}
                        onChange={(e) => setImportResult((rs) => rs!.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                      />
                      <select
                        className="drawer-mini-input"
                        style={{ width: 88 }}
                        value={it.kind}
                        onChange={(e) => setImportResult((rs) => rs!.map((x, j) => (j === i ? { ...x, kind: e.target.value as WorldItem['kind'] } : x)))}
                      >
                        {WORLD_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {k}
                          </option>
                        ))}
                      </select>
                    </div>
                    <textarea
                      className="drawer-mini-textarea"
                      rows={2}
                      value={it.content}
                      onChange={(e) => setImportResult((rs) => rs!.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))}
                    />
                  </div>
                ))}
                <button className="btn small ok" onClick={applyImport}>
                  导入所选（{importResult.filter((x) => !x.skip).length}）
                </button>
              </div>
            )}
            {(project.worldItems ?? []).map((w) => {
              const chain = w.kind === '地点' ? placeChain(w, project.worldItems ?? []) : null;
              return (
              <div key={w.id} className="world-card">
                <div className="char-head">
                  <input
                    className="drawer-mini-input"
                    value={w.name}
                    onChange={(e) => patchWorld((ws) => ws.map((x) => (x.id === w.id ? { ...x, name: e.target.value } : x)))}
                  />
                  <select
                    value={w.kind}
                    className="drawer-mini-input"
                    style={{ width: 92 }}
                    onChange={(e) => patchWorld((ws) => ws.map((x) => (x.id === w.id ? { ...x, kind: e.target.value as WorldItem['kind'] } : x)))}
                  >
                    {WORLD_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                  <button className="icon-btn" title="删除" onClick={() => patchWorld((ws) => ws.filter((x) => x.id !== w.id))}>
                    <Trash2 size={12} />
                  </button>
                </div>
                <textarea
                  className="drawer-mini-textarea"
                  value={w.content}
                  placeholder="这条设定的内容…"
                  onChange={(e) => patchWorld((ws) => ws.map((x) => (x.id === w.id ? { ...x, content: e.target.value } : x)))}
                />
                {w.kind === '地点' && (
                  <>
                    {chain && chain.length > 1 && (
                      <div className="place-chain" title="按上级地点逐级归属">
                        {chain.map((n, i) => (
                          <span key={i}>
                            {i > 0 && <em>›</em>}
                            {n}
                          </span>
                        ))}
                      </div>
                    )}
                    <input
                      className="drawer-mini-input"
                      list="place-parent-options"
                      value={w.parent ?? ''}
                      placeholder="上级地点（如：雾港）——串出「雾港 › 码头」的层级"
                      onChange={(e) => patchWorld((ws) => ws.map((x) => (x.id === w.id ? { ...x, parent: e.target.value } : x)))}
                    />
                  </>
                )}
              </div>
            );
            })}
          </>
        )}

        {tab === '彩蛋' && (
          <>
            <p className="hint">标「彩蛋」并写注释；导出的阅读版会在彩蛋位置自动附注，正文始终干净。</p>
            {eggs.length === 0 && <div className="empty" style={{ marginTop: 24 }}>还没有彩蛋标记。</div>}
            {eggs.map((m) => (
              <div key={m.id} className={'drawer-col' + (m.orphaned ? ' orphaned' : '')}>
                <div className="drawer-row">
                  <button className="drawer-row-text" onClick={() => !m.orphaned && onJump(m.start, m.chapterId)}>
                    {m.text.slice(0, 24)}
                    {chapterBadge(m)}
                    {m.orphaned && <em className="orphan-tag">原文已变</em>}
                  </button>
                  <button className="icon-btn" title="删除" onClick={() => patchMarks((ms) => ms.filter((x) => x.id !== m.id))}>
                    <Trash2 size={13} />
                  </button>
                </div>
                <input
                  className="drawer-mini-input"
                  value={m.note ?? ''}
                  placeholder="彩蛋注释（只在导出阅读版时出现）"
                  onChange={(e) => patchMarks((ms) => ms.map((x) => (x.id === m.id ? { ...x, note: e.target.value } : x)))}
                />
              </div>
            ))}
            {eggs.length > 0 && (
              <button className="btn small" style={{ marginTop: 10 }} onClick={exportAnnotated}>
                导出带注释阅读版
              </button>
            )}
          </>
        )}

        {tab === '分支' && (
          <>
            <p className="hint">把当前正文存为一条剧情分支（不同走向/结局互不覆盖），之后可整篇搬回主稿。</p>
            <div className="drawer-add-row">
              <input
                value={branchTitle}
                onChange={(e) => setBranchTitle(e.target.value)}
                placeholder="分支名，如：结局A-她留下"
                className="drawer-mini-input grow"
              />
              <button
                className="btn small"
                onClick={() => {
                  const title = branchTitle.trim() || `分支 ${(project.branches?.length ?? 0) + 1}`;
                  patchBranches((bs) => [
                    ...bs,
                    { id: uid(), title, tag: '备选', text: project.draft, updatedAt: new Date().toISOString() },
                  ]);
                  setBranchTitle('');
                }}
              >
                <Plus size={13} /> 存当前正文
              </button>
            </div>
            {(project.branches ?? []).length === 0 && <div className="empty" style={{ marginTop: 24 }}>还没有分支。</div>}
            {(project.branches ?? []).map((b) => (
              <div key={b.id} className="branch-card">
                <div className="char-head">
                  <b>{b.title}</b>
                  <select
                    value={b.tag}
                    className="drawer-mini-input"
                    style={{ width: 84 }}
                    onChange={(e) => patchBranches((bs) => bs.map((x) => (x.id === b.id ? { ...x, tag: e.target.value as StoryBranch['tag'] } : x)))}
                  >
                    <option value="备选">备选</option>
                    <option value="待扩写">待扩写</option>
                    <option value="废弃">废弃</option>
                  </select>
                  <button className="icon-btn" title="删除分支" onClick={() => patchBranches((bs) => bs.filter((x) => x.id !== b.id))}>
                    <Trash2 size={12} />
                  </button>
                </div>
                <div className="branch-meta">
                  {countWords(b.text)} 字 · {b.updatedAt.slice(5, 16).replace('T', ' ')}
                </div>
                <div className="branch-ops">
                  <button className="btn small" onClick={() => onInsert(b.text)} title="把分支内容插入到正文光标处">
                    <CornerUpLeft size={13} /> 插入光标处
                  </button>
                  <button
                    className="btn small danger"
                    onClick={() => {
                      if (confirm(`用「${b.title}」替换当前正文？当前内容会先自动存为快照。`)) {
                        onUpdate(project.id, { draft: b.text }, { snapshot: true });
                      }
                    }}
                  >
                    <RotateCcw size={13} /> 搬回主稿
                  </button>
                </div>
              </div>
            ))}
          </>
        )}

        {tab === '玩法' && (
          <>
            <p className="hint">
              限制写作小游戏：设置禁用词（逗号分隔），正文命中会显示为浅灰温和提醒，不强制删除，锻炼换一种表达的文笔。
            </p>
            <textarea
              className="drawer-mini-textarea"
              value={forbiddenInput}
              placeholder="例如：突然，非常，露出微笑，深吸一口气"
              onChange={(e) => setForbiddenInput(e.target.value)}
            />
            <button
              className="btn small"
              style={{ marginTop: 8 }}
              onClick={() =>
                onUpdate(project.id, {
                  game: { forbidden: forbiddenInput.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean) },
                })
              }
            >
              应用禁用词
            </button>
            <p className="hint" style={{ marginTop: 14 }}>
              当前生效：{(project.game?.forbidden ?? []).length ? project.game!.forbidden.join('、') : '无'}
            </p>
          </>
        )}
        {tab === '取名' && (
          <Suspense fallback={<p className='hint'>取名面板载入中…</p>}>
            <NamesPanel project={project} onCommit={commitPicks} />
          </Suspense>
        )}
      </div>

      <div className="drawer-foot">
        <button className="mini-btn" onClick={() => onJump(0)}>
          <LocateFixed size={12} /> 回到开头
        </button>
      </div>
    </aside>
  );
}
