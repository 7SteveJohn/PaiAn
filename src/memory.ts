// 出场记忆：AI 每写完一章正文，抽取「谁出场、状态怎么变、有没有新角色/新设定」，
// 校验后合并回人物卡与设定卡。纯函数、可单测；解析失败一律静默降级，绝不打扰正文。
import { uid, localStamp } from './util';

export const WORLD_KINDS = ['地点', '道具', '设定', '势力', '功法', '力量体系'] as const;
export type WorldKind = (typeof WORLD_KINDS)[number];

export interface RawMemory {
  name?: unknown;
  isNew?: unknown;
  state?: unknown;
  changeNote?: unknown;
  power?: unknown;
  powerNote?: unknown;
  relations?: unknown;
  world?: unknown;
}

export interface SanitizedMemory {
  name: string;
  isNew: boolean;
  state?: string;
  changeNote?: string;
  power?: string;
  powerNote?: string;
  relations: { with: string; note: string }[];
  world?: { name: string; kind: WorldKind; content: string };
}

export interface ExtractResult {
  ok: boolean;
  text?: string;
  memories: SanitizedMemory[];
  skipped: string[]; // 被清洗丢弃的条目与原因，便于排查（UI 可选展示）
}

const cut = (s: unknown, n: number) => {
  if (typeof s !== 'string') return '';
  const t = s.trim().replace(/\s+/g, ' ');
  return t.slice(0, n);
};

/** 从模型返回文本里取出第一段合法 JSON（容忍 ```json 围栏与前后废话）。 */
export function extractJson(text: string): unknown {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // 花括号深度配对：取第一个 { 起、匹配到的最外层 }，避免截到模型废话里的花括号
  let depth = 0;
  let start = -1;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 出现在正文里的名字才算数：防模型脑补没出场的人。 */
function appearsIn(name: string, chapterText: string, knownNames: string[]): boolean {
  return name.length > 0 && (chapterText.includes(name) || knownNames.includes(name));
}

/** 规范化 + 双向校验：新角色必须真在正文出场；状态/备注限长；只保留白名单 kind。 */
export function sanitizeMemories(raw: unknown, chapterText: string, knownNames: string[]): ExtractResult {
  const memories: SanitizedMemory[] = [];
  const skipped: string[] = [];
  if (!raw || typeof raw !== 'object') return { ok: false, memories, skipped };
  const list = (raw as { memories?: unknown }).memories;
  if (!Array.isArray(list) || !list.length) return { ok: true, memories, skipped };

  for (const item of list) {
    if (!item || typeof item !== 'object') {
      skipped.push('(非对象条目)');
      continue;
    }
    const r = item as RawMemory;
    const name = cut(r.name, 24);
    if (!name) {
      skipped.push('(缺名字)');
      continue;
    }
    const onStage = appearsIn(name, chapterText, knownNames);
    if (!onStage) {
      skipped.push(`${name}：未出场`);
      continue;
    }

    const rels: { with: string; note: string }[] = [];
    if (Array.isArray(r.relations)) {
      for (const rel of r.relations) {
        const w = rel && typeof rel === 'object' ? cut((rel as { with?: unknown }).with, 24) : '';
        const note = rel && typeof rel === 'object' ? cut((rel as { note?: unknown }).note, 120) : '';
        if (w && note) rels.push({ with: w, note });
      }
    }

    let world: SanitizedMemory['world'];
    if (r.world && typeof r.world === 'object') {
      const wName = cut((r.world as { name?: unknown }).name, 24);
      const kind = cut((r.world as { kind?: unknown }).kind, 8) as WorldKind;
      const content = cut((r.world as { content?: unknown }).content, 220);
      if (wName && WORLD_KINDS.includes(kind) && content && appearsIn(wName, chapterText, [])) {
        world = { name: wName, kind, content };
      }
    }

    memories.push({
      name,
      isNew: r.isNew === true || !knownNames.includes(name),
      state: cut(r.state, 140) || undefined,
      changeNote: cut(r.changeNote, 200) || undefined,
      power: cut(r.power, 40) || undefined,
      powerNote: cut(r.powerNote, 200) || undefined,
      relations: rels,
      world,
    });
  }

  // 同章同名只留一条：后出现的优先（信息更全）
  const seen = new Map<string, SanitizedMemory>();
  for (const m of memories) seen.set(m.name, m);
  return { ok: true, memories: [...seen.values()].slice(0, 8), skipped };
}

interface CharLike {
  id: string;
  name: string;
  state: string;
  log: { at: string; text: string }[];
  relations: { with: string; note: string }[];
  power?: string;
  powerLog?: { chapterId?: string; text: string }[];
}

interface WorldLike {
  id: string;
  name: string;
  kind: WorldKind;
  content: string;
}

/** 把清洗后的记忆不可变地合并进 project（返回新对象；不动原文、不触碰正文）。 */
export function applyMemories(
  project: {
    characters?: CharLike[];
    worldItems?: WorldLike[];
  },
  memories: SanitizedMemory[],
  chapterId?: string,
): { characters: CharLike[]; worldItems: WorldLike[]; touched: number } {
  let chars = project.characters ?? [];
  const worldItems = project.worldItems ?? [];
  const addWorld: WorldLike[] = [];
  let touched = 0;

  for (const m of memories) {
    const idx = chars.findIndex((c) => c.name === m.name);
    if (idx >= 0) {
      const c = chars[idx];
      const next: CharLike = { ...c };
      const log = [...(c.log ?? [])];
      const powerLog = [...(c.powerLog ?? [])];
      let changed = false;
      if (m.state && m.state !== c.state) {
        next.state = m.state;
        changed = true;
      }
      if (m.changeNote) {
        log.push({ at: localStamp(), text: m.changeNote });
        changed = true;
      }
      if (m.power && m.power !== c.power) {
        next.power = m.power;
        changed = true;
      }
      if (m.powerNote) {
        powerLog.push({ chapterId, text: m.powerNote });
        changed = true;
      }
      const existingRel = new Set((c.relations ?? []).map((r) => r.with));
      const addRel = (m.relations ?? []).filter((r) => !existingRel.has(r.with));
      const relations = [...(c.relations ?? []), ...addRel];
      if (addRel.length) changed = true;

      if (changed) {
        chars = chars.map((x, i) => (i === idx ? { ...next, log, powerLog, relations } : x));
        touched++;
      }
    } else if (m.isNew) {
      // 建档需要最低限度的实质内容，避免一堆空壳卡
      if (!m.state && !m.changeNote && !m.powerNote && !(m.relations ?? []).length) continue;
      const log: { at: string; text: string }[] = [];
      if (m.changeNote) log.push({ at: localStamp(), text: m.changeNote });
      const card: CharLike = {
        id: uid(),
        name: m.name,
        state: m.state || (m.changeNote ? '' : ''),
        log,
        relations: m.relations ?? [],
        ...(m.power ? { power: m.power } : {}),
        ...(m.powerNote ? { powerLog: [{ chapterId, text: m.powerNote }] } : {}),
      };
      chars = [...chars, card];
      touched++;
    }

    if (m.world && !worldItems.some((w) => w.name === m.world!.name) && !addWorld.some((w) => w.name === m.world!.name)) {
      addWorld.push({ id: uid(), ...m.world });
    }
  }

  return { characters: chars, worldItems: [...worldItems, ...addWorld], touched };
}

/** 组抽取 prompt：给模型看本章正文 + 现有角色/设定名册，要它只回 JSON。 */
export function buildExtractMessages(
  chapterTitle: string,
  chapterText: string,
  project: { characters?: CharLike[]; worldItems?: WorldLike[] },
): { role: 'system' | 'user'; content: string }[] {
  const roster = (project.characters ?? []).map((c) => (c.power ? `${c.name}（${c.power}）` : c.name)).join('、') || '（暂无）';
  const worldRoster = (project.worldItems ?? []).slice(0, 12).map((w) => w.name).join('、') || '（暂无）';
  const system =
    '你是网文连载的「出场记忆」抽取器。输入刚定稿的一章正文与既有角色/设定名册，' +
    '抽取需要更新到作品资料库的记忆。只输出 JSON，不要任何解释或围栏。\n' +
    '规则：\n' +
    '1. 只记录正文里实际出场或明确提及的角色/设定，禁止脑补正文没有的东西。\n' +
    '2. 老角色：状态有实质变化才给 state（最新状态全文）+ changeNote（本章变化，供履历追加）；没变化就别输出它。\n' +
    '3. 新角色：本章首次出现、值得长期记住才输出，isNew=true。\n' +
    '4. 战力体系（升级/跌落/觉醒）变化：给 power（新等级）与 powerNote（怎么变的）。\n' +
    '5. 关系出现新变化：给 relations=[{with:对方名,note:关系现状或变化}]。\n' +
    '6. 正文明确刻画、后续会复用的新设定（地点/势力/道具/功法/力量体系）：给 world={name,kind,content}。\n' +
    '7. 宁可少给，不要编造；全部用中文，备注克制。\n' +
    '输出格式：{"memories":[{"name":"角色名","isNew":false,"state":"…","changeNote":"…","power":"…","powerNote":"…","relations":[{"with":"…","note":"…"}],"world":null}]}';
  const user =
    `【既有角色】${roster}\n` +
    `【既有设定】${worldRoster}\n` +
    `【本章】${chapterTitle}\n` +
    `【本章正文】\n${chapterText.slice(0, 6000)}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
