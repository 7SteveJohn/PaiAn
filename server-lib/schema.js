// 注：可变进程状态（读盘告警去重、写入队列）留在 server.js，这一层只有纯函数。
export const num0 = (v, max = 1e9) => (Number.isFinite(Number(v)) ? Math.min(Math.max(0, Math.floor(Number(v))), max) : 0);
export function sanitizeBenchmarks(list) {
  const books = Array.isArray(list) ? list : [];
  return books
    .filter((b) => b && typeof b === 'object' && str(b.id, 20))
    .slice(0, 20)
    .map((b) => ({
      id: str(b.id, 20),
      title: str(b.title, 40) || '未命名对标书',
      createdAt: str(b.createdAt, 40),
      chapters: (Array.isArray(b.chapters) ? b.chapters : [])
        .filter((c) => c && typeof c === 'object')
        .slice(0, 2000)
        .map((c) => ({
          n: num0(c.n, 100000),
          title: str(c.title, 40),
          chars: num0(c.chars),
          sentences: num0(c.sentences),
          avgSentence: num0(c.avgSentence, 5000),
          maxSentence: num0(c.maxSentence, 20000),
          dialogueShare: num0(c.dialogueShare, 100),
          pronounOpen: num0(c.pronounOpen, 100000),
          paragraphs: num0(c.paragraphs, 100000),
          opener: str(c.opener, 12),
          endsOnTalk: c.endsOnTalk === true, // 只认真正的 true，字符串不当真
          deslop: strMap(c.deslop),
        })),
    }));
}

// 抽卡账本与卡池的入站校验：数值非负、字符串限长、稀有度与效果白名单
const RARITIES = ['N', 'R', 'SR', 'SSR'];
const EFFECTS = ['beat', 'hook', 'rule', 'constraint', 'cast', 'outline', 'task'];
const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0);
export const str = (v, max = 60) => (typeof v === 'string' ? v.slice(0, max) : '');
export function strMap(v) {
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (typeof k === 'string' && k.length <= 40 && (typeof val === 'number' || typeof val === 'string')) out[k] = val;
    }
  }
  return out;
}
export function sanitizeGacha(v) {
  const o = v && typeof v === 'object' ? v : {};
  const hand = (Array.isArray(o.hand) ? o.hand : []).map((s) => str(s, 40)).filter(Boolean).slice(0, 8);
  return { pulls: num(o.pulls), sincePity: num(o.sincePity), ink: num(o.ink), usedWords: num(o.usedWords), hand, bonusPulls: num(o.bonusPulls), owned: strMap(o.owned), applied: strMap(o.applied), lit: strMap(o.lit) };
}
// 约束类卡片的条件必须原样落盘：掉了 constraints，重启后这张卡就没有达成条件，
// 一张「练笔卡」会退化成零条件卡——打出去直接点亮，白送。
const CONSTRAINT_KINDS = ['any', 'absent', 'maxSentence', 'dialogueShare', 'pronounOpen', 'deslopMax'];
export function sanitizeConstraints(v) {
  if (!Array.isArray(v)) return undefined;
  const words = (arr) => (Array.isArray(arr) ? arr.map((s) => str(s, 20)).filter(Boolean).slice(0, 12) : []);
  const num = (x, lo, hi) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : undefined);
  const out = [];
  for (const c of v.slice(0, 6)) {
    if (!c || typeof c !== 'object') continue;
    const kind = str(c.kind, 16); // 'dialogueShare' 有 13 个字母，截到 12 会把它判成非法 kind
    if (!CONSTRAINT_KINDS.includes(kind)) continue;
    const e = { kind };
    if (kind === 'any' || kind === 'absent') {
      const w = words(c.words);
      if (w.length) e.words = w;
      else continue;
    }
    if (kind === 'maxSentence') {
      const chars = typeof c.chars === 'number' && c.chars >= 2 ? num(c.chars, 2, 500) : undefined;
      if (chars === undefined) continue;
      e.chars = chars;
    }
    if (kind === 'dialogueShare') {
      const min = num(c.min, 0, 100);
      const max = num(c.max, 0, 100);
      if (min === undefined && max === undefined) continue;
      if (min !== undefined) e.min = min;
      if (max !== undefined) e.max = max;
    }
    if (kind === 'pronounOpen') {
      const max = num(c.max, 0, 200);
      if (max === undefined) continue;
      e.max = max;
    }
    if (kind === 'deslopMax') {
      const key = str(c.key, 24);
      const count = num(c.count, 0, 500);
      if (!key || count === undefined) continue;
      e.key = key;
      e.count = count;
    }
    out.push(e);
  }
  return out.length ? out : undefined;
}

export function sanitizeCards(v) {
  const o = v && typeof v === 'object' ? v : {};
  const list = (arr) => (Array.isArray(arr) ? arr.map((s) => str(s, 30)).filter(Boolean).slice(0, 8) : undefined);
  const custom = (Array.isArray(o.custom) ? o.custom : [])
    .filter((c) => c && typeof c === 'object' && str(c.id, 40) && RARITIES.includes(str(c.rarity, 4)) && EFFECTS.includes(str(c.effect, 10)))
    .slice(0, 400)
    .map((c) => {
      const any = list(c.any);
      const absent = list(c.absent);
      const constraints = sanitizeConstraints(c.constraints);
      return {
        id: str(c.id, 40),
        series: str(c.series, 20) || '自建',
        rarity: str(c.rarity, 4),
        name: str(c.name, 30) || '未命名卡',
        effect: str(c.effect, 10),
        payload: str(c.payload, 600),
        ...(any ? { any } : {}),
        ...(absent ? { absent } : {}),
        ...(constraints ? { constraints } : {}),
      };
    });
  return { version: 1, custom, off: (Array.isArray(o.off) ? o.off : []).map((s) => str(s, 40)).filter(Boolean).slice(0, 400) };
}

// 读盘异常攒起来随 GET /api/data 上报界面：数据异常不该只在控制台里默默发生


// versions.json: { "<projectId>": { project: [快照…], chapters: { "<chapterId>": [快照…] } } }
// 正文留在 projects.json，快照留在 versions.json，自动保存才不必反复重写快照全文
// （实测：500 章的书里快照占 payload 的 93%）。

export const MAX_VERSIONS = 20;

// 把带快照的项目数组拆成「可落盘的正文」+「快照表」
export function splitVersions(projects) {
  const store = {};
  const bare = [];
  for (const p of Array.isArray(projects) ? projects : []) {
    if (!p || typeof p !== 'object') {
      bare.push(p);
      continue;
    }
    const entry = {};
    let rest = p;
    if (Array.isArray(p.versions)) {
      entry.project = p.versions;
      rest = { ...p };
      delete rest.versions;
    }
    if (Array.isArray(p.chapters)) {
      const chapters = [];
      for (const c of p.chapters) {
        if (c && Array.isArray(c.versions)) {
          if (!entry.chapters) entry.chapters = {};
          entry.chapters[c.id] = c.versions;
          const copy = { ...c };
          delete copy.versions;
          chapters.push(copy);
        } else {
          chapters.push(c);
        }
      }
      rest = rest === p ? { ...p, chapters } : { ...rest, chapters };
    }
    bare.push(rest);
    if (entry.project || entry.chapters) store[p.id] = entry;
  }
  return { bare, store };
}

// 读侧把快照表并回项目，界面拿到的结构与从前一致
export function attachVersions(projects, store) {
  if (!store || typeof store !== 'object' || !Array.isArray(projects)) return projects;
  return projects.map((p) => {
    const e = p && store[p.id];
    if (!e) return p;
    const next = { ...p };
    if (e.project) next.versions = e.project;
    if (e.chapters && Array.isArray(p.chapters)) {
      next.chapters = p.chapters.map((c) => (c && e.chapters[c.id] ? { ...c, versions: e.chapters[c.id] } : c));
    }
    return next;
  });
}

// 侧车内容按结构校验并裁剪份数，避免异常客户端把它撑爆
export function sanitizeVersions(store) {
  const out = {};
  if (!store || typeof store !== 'object') return out;
  const okList = (list) => (Array.isArray(list) ? list.filter((v) => v && typeof v.text === 'string' && typeof v.at === 'string').slice(-MAX_VERSIONS) : []);
  for (const [pid, e] of Object.entries(store)) {
    if (!e || typeof e !== 'object') continue;
    const entry = {};
    const pv = okList(e.project);
    if (pv.length) entry.project = pv;
    if (e.chapters && typeof e.chapters === 'object') {
      for (const [cid, list] of Object.entries(e.chapters)) {
        const v = okList(list);
        if (v.length) (entry.chapters ||= {})[cid] = v;
      }
    }
    if (entry.project || entry.chapters) out[pid] = entry;
  }
  return out;
}

// ---------- 快照的扁平线格式 ----------
// 磁盘上按作品分组（{ pid: { project, chapters: { cid } } }），线上按 key 寻址
// （pid 或 pid::cid → 快照数组）：谁变了发谁、要哪本读哪本，不必整表来回搬。
export const VERSION_SEP = '::';
export const ownerOfKey = (key) => {
  const i = String(key).indexOf(VERSION_SEP);
  return i < 0 ? String(key) : String(key).slice(0, i);
};

export function storeToFlat(store) {
  const flat = {};
  for (const [pid, e] of Object.entries(store && typeof store === 'object' ? store : {})) {
    if (!e || typeof e !== 'object') continue;
    if (Array.isArray(e.project) && e.project.length) flat[pid] = e.project;
    for (const [cid, list] of Object.entries(e.chapters && typeof e.chapters === 'object' ? e.chapters : {})) {
      if (Array.isArray(list) && list.length) flat[pid + VERSION_SEP + cid] = list;
    }
  }
  return flat;
}

export function flatKeysToStore(flat) {
  const store = {};
  for (const key of Object.keys(flat && typeof flat === 'object' ? flat : {})) {
    const i = key.indexOf(VERSION_SEP);
    if (i < 0) {
      (store[key] ||= {}).project = flat[key];
      continue;
    }
    const pid = key.slice(0, i);
    const entry = (store[pid] ||= {});
    (entry.chapters ||= {})[key.slice(i + VERSION_SEP.length)] = flat[key];
  }
  return store;
}

// 把一份扁平增量并进现有侧车：空数组表示删掉这条 key，其它按 key 覆盖
export function mergeFlatIntoStore(store, flat) {
  const next = structuredClone(store ?? {});
  for (const [key, list] of Object.entries(flat && typeof flat === 'object' ? flat : {})) {
    const arr = Array.isArray(list) ? list : [];
    const i = key.indexOf(VERSION_SEP);
    if (i < 0) {
      if (arr.length) (next[key] ||= {}).project = arr;
      else if (next[key]) delete next[key].project;
      continue;
    }
    const pid = key.slice(0, i);
    const cid = key.slice(i + VERSION_SEP.length);
    if (arr.length) {
      const entry = (next[pid] ||= {});
      (entry.chapters ||= {})[cid] = arr;
    } else if (next[pid]?.chapters) {
      delete next[pid].chapters[cid];
    }
  }
  return sanitizeVersions(next);
}

// 只保留还存在的作品/章节的快照：删书、删章之后不该继续背着旧快照
export function pruneVersions(store, projects) {
  const byId = new Map();
  for (const p of Array.isArray(projects) ? projects : []) if (p && typeof p === 'object' && p.id) byId.set(p.id, p);
  const out = {};
  for (const [pid, e] of Object.entries(store && typeof store === 'object' ? store : {})) {
    const p = byId.get(pid);
    if (!p || !e || typeof e !== 'object') continue;
    const keep = {};
    if (Array.isArray(e.project) && e.project.length) keep.project = e.project;
    const live = new Set((Array.isArray(p.chapters) ? p.chapters : []).map((c) => c && c.id).filter(Boolean));
    for (const [cid, list] of Object.entries(e.chapters && typeof e.chapters === 'object' ? e.chapters : {})) {
      if (live.has(cid) && Array.isArray(list) && list.length) (keep.chapters ||= {})[cid] = list;
    }
    if (keep.project || keep.chapters) out[pid] = keep;
  }
  return out;
}

// 首屏不必把快照全文搬回去，但要知道每条 key 有几份：
// 客户端据此判断「这条我还没读过，不能凭半截数据覆盖」
export function versionsCountMap(store) {
  const flat = storeToFlat(store);
  const out = {};
  for (const [k, list] of Object.entries(flat)) out[k] = list.length;
  return out;
}

// 响应里的项目一律不带快照（结构与从前一致，只是空手），界面按 key 懒读
export function dropVersions(projects) {
  if (!Array.isArray(projects)) return projects;
  return projects.map((p) => {
    if (!p || typeof p !== 'object') return p;
    const had = Array.isArray(p.versions) && p.versions.length;
    const chapHit = Array.isArray(p.chapters) && p.chapters.some((c) => c && Array.isArray(c.versions) && c.versions.length);
    if (!had && !chapHit) return p;
    const next = { ...p };
    delete next.versions;
    if (chapHit) next.chapters = p.chapters.map((c) => (c && Array.isArray(c.versions) ? (({ versions: _v, ...rest }) => rest)(c) : c));
    return next;
  });
}// 本地服务的数据形状层：入站 JSON 的校验/裁剪，以及历史快照侧车的结构换算。
// 只放纯函数——带磁盘状态与进程缓存的部分留在 server.js，这样这层可以单独读懂、单独测。


