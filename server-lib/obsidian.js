/**
 * Obsidian 双向同步的纯逻辑层：渲染、解析、三方对比、把库里的改动映射回作品结构。
 *
 * 这里不放任何 IO、不读时间、不碰进程状态——server.js 负责读写磁盘并把结果传进来，
 * 于是「谁改了、该推还是该拉、算不算冲突」这套判定可以在 npm test 里逐条断言。
 *
 * 三个关键约定：
 *  1. 每篇文件 frontmatter 带 wb-id（作品/章/人物卡/设定卡的稳定 id）与 wb-kind，
 *     认文件只认这个，不靠文件名——改名不会造成孤儿文件，也不会误删别人的笔记。
 *  2. 状态表记的是「上次同步时我方写入内容的指纹」，拿它当共同祖先：
 *     只有我方变 → 推；只有库里变 → 拉；两边都变 → 冲突，交给人选，绝不静默覆盖。
 *     没有祖先记录（第一次见这个路径）时一律不猜：内容与我方一致就什么都不做，
 *     不一致就判冲突——那说明那个位置上是别人写的东西。
 *  3. 我方维护的批注区（NOTES_MARK 之后）在推的时候原样贴回去，拉的时候不当正文——
 *     否则「导出 → 在 Obsidian 里批注 → 回读」两趟就把批注吃进正文了。
 */

const NOTES_MARK = '<!-- wb-notes -->';

const KIND = { book: 'book', chapter: 'chapter', character: 'character', world: 'world' };

// ---------- 基础工具 ----------

/** FNV-1a 32 位：够短、纯函数、不依赖 node:crypto，跨进程稳定 */
function fnv(str) {
  let h = 0x811c9dc5;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 比对前先归一：Obsidian 与 git 都可能换行不同，不该因此判成「那边改了」 */
function norm(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

/** YAML 单行标量：一律带引号，避免书名里的冒号、井号把 frontmatter 撑坏 */
function y(v) {
  return JSON.stringify(String(v ?? ''));
}

function slug(name) {
  return String(name ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 同名文件不能撞车：撞了就补上 id 的短哈希，保证两趟渲染结果一致 */
function uniquePath(used, dir, base, id) {
  const clean = slug(base) || '未命名';
  let p = `${dir}/${clean}.md`;
  if (used.has(p)) p = `${dir}/${clean}-${fnv(id).slice(0, 4)}.md`;
  used.add(p);
  return p;
}

/** 一行的值：数字、带引号的串、流式数组，其余按裸字符串——Obsidian 保存时不带引号也得认 */
function scalar(v) {
  if (/^-?[0-9]+(\.[0-9]+)?$/.test(v)) return Number(v);
  if (/^\[.*\]$/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      try {
        return JSON.parse('[' + v.slice(1, -1).split(',').map((x) => JSON.stringify(x.trim())).join(',') + ']');
      } catch {
        return v; // 手写的非法值：当字符串留着
      }
    }
  }
  if (/^".*"$/.test(v) || /^'.*'$/.test(v)) return v.slice(1, -1);
  return v;
}

function frontmatter(meta) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null) continue;
    // 数字保持裸写：Obsidian 的属性视图 / Dataview 要的是数字而不是字符串
    lines.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : typeof v === 'number' ? String(v) : y(v)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

// ---------- 双链 ----------

/**
 * 把已建档的人物 / 地点名写成 [[人物/名字]]、[[设定/名字]]。
 * 中文没有词边界，所以只做两件保守的事：已经在 [[…]] 里的不再动；
 * 一次扫描按名字长度从长到短匹配，避免「林越」把「林越舟」切成两半后再套一层。
 */
function linkify(content, charNames, placeNames) {
  const s = String(content ?? '');
  const dirOf = new Map([...(charNames ?? []).map((n) => [n, '人物']), ...(placeNames ?? []).map((n) => [n, '设定'])]);
  const names = [...new Set([...dirOf.keys()])].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length || !s) return s;
  // 先标出已有的 [[…]] 区间，落在里面的一律跳过
  const linked = [];
  for (const m of s.matchAll(/\[\[[^\]]*\]\]/g)) {
    const start = m.index ?? 0;
    linked.push([start, start + m[0].length]);
  }
  const inside = (i) => linked.some(([a, b]) => i >= a && i < b);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const hit = !inside(i) ? names.find((n) => s.startsWith(n, i)) : undefined;
    if (hit) {
      out += `[[${dirOf.get(hit)}/${hit}]]`;
      i += hit.length;
    } else {
      out += s[i];
      i += 1;
    }
  }
  return out;
}

// ---------- 解析（库里的文件 → 结构） ----------

/** 拆出 frontmatter、正文、我方批注区。解析不动内容，推的时候原样贴回。 */
function parseFile(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const meta = {};
  let body = s;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(s);
  if (m) {
    let lastKey = '';
    for (const line of m[1].split(/\r?\n/)) {
      const item = /^\s+-\s*(.*)$/.exec(line);
      // 空值先当空串存着（`summary:` 与 `summary: ""` 是同一样东西），真出现「- 项」才升成数组
      const blank = meta[lastKey] === undefined || meta[lastKey] === "";
      if (item && lastKey && (blank || Array.isArray(meta[lastKey]))) {
        // 块式列表：Obsidian 把 tags / aliases 这类属性存成「- 值」的行
        const cur = Array.isArray(meta[lastKey]) ? meta[lastKey] : [];
        cur.push(scalar(item[1].trim()));
        meta[lastKey] = cur;
        continue;
      }
      const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (!kv) continue;
      lastKey = kv[1];
      const raw = kv[2].trim();
      meta[lastKey] = raw === '' ? '' : scalar(raw);
    }
    body = s.slice(m[0].length);
  }
  const at = body.indexOf(NOTES_MARK);
  const prose = at < 0 ? body : body.slice(0, at);
  const notes = at < 0 ? '' : body.slice(at + NOTES_MARK.length).replace(/^\r?\n/, '');
  return { meta, prose: prose.replace(/\s+$/, ''), notes, wb: Boolean(meta['wb-id']) };
}

/**
 * 我方渲染时会写进属性区的键。判「谁改了」只看这些键 + 正文 + 批注区：
 * 作者在 Obsidian 里加的 aliases / cssclasses / 自己发明的属性，改了不该惊动同步，
 * 我们推的时候也不许把它们抹掉（见 mergeForeignMeta）。
 */
const OUR_KEYS = ['wb', 'wb-id', 'wb-kind', 'wb-book', 'title', 'type', 'status', 'deadline', 'words', 'chapters', 'updated', 'tags', 'chapter-no', 'volume', 'summary', 'beats', 'cast', 'places', 'hooks', 'name', 'state', 'power', 'kind'];

/** 正文指纹：写法变了（引号、块式列表、键序）不算改动，内容变了才算 */
function fingerprint(text) {
  const { meta, prose, notes } = parseFile(text);
  const mine = Object.keys(meta)
    .filter((k) => OUR_KEYS.includes(k))
    .sort()
    .map((k) => k + '=' + JSON.stringify(meta[k]))
    .join('|');
  return fnv(norm(prose) + '\n' + norm(notes) + '\n' + mine);
}

/** 把我方不认识的属性原样贴回要写的文件：他加的东西得活着，同名的键以我方为准 */
function mergeForeignMeta(oursText, diskText) {
  if (!diskText || diskText === oursText) return oursText;
  const head = /^---[ \t]*\r?\n/.exec(oursText);
  if (!head) return oursText;
  const ours = parseFile(oursText).meta;
  const foreign = Object.entries(parseFile(diskText).meta).filter(([k, v]) => ours[k] === undefined && !OUR_KEYS.includes(k) && v !== undefined);
  if (!foreign.length) return oursText;
  const close = /^---[ \t]*$/gm;
  close.lastIndex = head.index + head[0].length;
  const end = close.exec(oursText);
  if (!end) return oursText;
  const lines = foreign.map(([k, v]) => (Array.isArray(v) ? k + ':\n' + v.map((i) => '  - ' + i).join('\n') : k + ': ' + v));
  return oursText.slice(0, end.index) + lines.join('\n') + '\n' + oursText.slice(end.index);
}

// ---------- 渲染（作品 → 该写哪些文件） ----------

function notesTail(notes) {
  return notes && notes.trim() ? `\n\n${NOTES_MARK}\n${notes.trim()}\n` : '\n';
}

/**
 * 把一部作品摊成「相对路径 → 该写的文件」。必须是作品状态的纯函数：绝不能嵌当前时间，
 * 否则每同步一次都算「我方改过」，会把没动过的文件反复重写。
 * notesById：上次同步后库里已有的批注区，按实体 id 传进来（改名不丢批注），贴回文件末尾。
 */
function renderBook(project, ideas, notesById = {}) {
  const book = slug(project.title) || '未命名作品';
  const root = book;
  const used = new Set();
  const files = {};
  const chars = project.characters ?? [];
  const world = project.worldItems ?? [];
  const charNames = chars.map((c) => c.name);
  const placeNames = world.filter((w) => w.kind === '地点').map((w) => w.name);
  const chapters = project.chapters ?? [];
  const put = (rel, id, kind, text) => {
    files[rel] = { id, kind, text };
  };

  // 章节（未写的也建一个空文件，方便直接在库里写）
  const chapLinks = [];
  chapters.forEach((c, i) => {
    const rel = uniquePath(used, `${root}/章节`, `第${i + 1}章 ${c.title}`, c.id);
    const meta = {
      wb: 'writing-workbench',
      'wb-id': c.id,
      'wb-kind': KIND.chapter,
      'wb-book': book,
      title: c.title,
      'chapter-no': i + 1,
      volume: c.volume || '',
      words: (c.content ?? '').replace(/\s+/g, '').length,
      summary: c.summary || '',
      beats: c.beats || '',
      cast: c.cast || '',
      places: c.places || '',
      hooks: c.hooks || '',
      updated: c.updatedAt || '',
      tags: ['创作工作台/章节'],
    };
    put(rel, c.id, KIND.chapter, frontmatter(meta) + linkify(c.content ?? '', charNames, placeNames) + notesTail(notesById[c.id]));
    chapLinks.push({ rel, label: `第${i + 1}章 ${c.title}`, written: !!(c.content ?? '').trim(), volume: c.volume || '' });
  });

  for (const c of chars) {
    const rel = uniquePath(used, `${root}/人物`, c.name, c.id);
    const meta = {
      wb: 'writing-workbench',
      'wb-id': c.id,
      'wb-kind': KIND.character,
      'wb-book': book,
      name: c.name,
      state: c.state || '',
      power: c.power || '',
      updated: project.updatedAt || '',
      tags: ['创作工作台/人物'],
    };
    const lines = [`当前状态：${c.state || '未记录'}`, ''];
    if (c.power) lines.push(`境界 / 战力：${c.power}`, '');
    if (c.relations?.length) {
      lines.push('## 关系', '');
      for (const r of c.relations) lines.push(`- ${r.with ? `[[人物/${r.with}]]` : '（未建档）'}：${r.note || ''}`);
      lines.push('');
    }
    if (c.log?.length) {
      lines.push('## 情绪履历', '');
      for (const l of c.log) lines.push(`- ${l.at ? `${l.at}：` : ''}${l.text}`);
      lines.push('');
    }
    put(rel, c.id, KIND.character, frontmatter(meta) + lines.join('\n') + notesTail(notesById[c.id]));
  }

  for (const w of world) {
    const rel = uniquePath(used, `${root}/设定`, w.name, w.id);
    const meta = {
      wb: 'writing-workbench',
      'wb-id': w.id,
      'wb-kind': KIND.world,
      'wb-book': book,
      name: w.name,
      kind: w.kind,
      updated: project.updatedAt || '',
      tags: ['创作工作台/设定', w.kind],
    };
    put(rel, w.id, KIND.world, frontmatter(meta) + (w.content || '') + notesTail(notesById[w.id]));
  }

  // 索引页（MOC）：链接用 wikilink 的文件名形式，Obsidian 能直接解析并计入反向链接
  const idx = [
    frontmatter({
      wb: 'writing-workbench',
      'wb-id': project.id,
      'wb-kind': KIND.book,
      'wb-book': book,
      title: project.title,
      type: project.type,
      status: project.status,
      words: chapters.reduce((s, c) => s + (c.content ?? '').replace(/\s+/g, '').length, 0),
      chapters: chapters.length,
      updated: project.updatedAt || '',
      tags: ['创作工作台'],
    }),
    `# ${project.title}`,
    '',
  ];
  if (project.notes) idx.push(`> ${String(project.notes).replace(/\r?\n/g, '\n> ')}`, '');
  idx.push(`## 章节（${chapters.length}）`, '', ...chapLinks.map((c) => `- [[${slug(c.label)}]]${c.volume ? ` <small>${c.volume}</small>` : ''}${c.written ? '' : ' — 未写'}`), '');
  if (chars.length) idx.push(`## 人物（${chars.length}）`, '', ...chars.map((c) => `- [[${slug(c.name)}]] — ${c.state || '未记录状态'}`), '');
  if (world.length) idx.push(`## 设定（${world.length}）`, '', ...world.map((w) => `- [[${slug(w.name)}]]（${w.kind}）`), '');
  const linked = (ideas ?? []).filter((i) => (project.linkedIdeaIds ?? []).includes(i.id));
  if (linked.length) idx.push('## 关联素材', '', ...linked.map((i) => `> ${String(i.content).replace(/\r?\n/g, '\n> ')}`), '');
  put(`${root}/index.md`, project.id, KIND.book, idx.join('\n'));

  return { root, files };
}

// ---------- 三方对比 ----------

/**
 * rendered: 我方现在想写的 { rel: { id, kind, text } }
 * disk:     库里现有的   { rel: text }（缺 = 那边没有这个文件）
 * state:    上次同步记录 { rel: { id, kind, hash } }，hash = 上次我方写入内容的指纹
 */
function plan({ rendered, disk = {}, state = {} }) {
  const push = [];
  const pull = [];
  const conflict = [];
  const prune = [];
  const next = {};

  const rels = new Set([...Object.keys(rendered), ...Object.keys(state)]);
  for (const rel of rels) {
    const ours = rendered[rel];
    if (!ours) {
      // 我方已经没有这篇（删了章或卡）：只回收带我方标记的文件，别人的笔记一个字节都不碰
      const onDisk = disk[rel];
      if (onDisk !== undefined && parseFile(onDisk).wb) prune.push(rel);
      continue;
    }
    const anc = state[rel];
    const prevHash = anc?.hash ?? '';
    const v2 = anc?.v === 2;
    const oursHash = fingerprint(ours.text);
    const theirs = disk[rel];
    const missing = theirs === undefined;
    const theirHash = missing ? '' : fingerprint(theirs);
    // 旧记录（v1）存的是整文件指纹：Obsidian 一改写法，两边就都「像被改过」。
    // 所以先看正文指纹——两边一致就当什么都没动，顺手把记录升级成 v2；
    // 真不一致才退回 v1 的老算法判这一次，别把老数据一上来全判成冲突。
    const sameContent = !missing && theirHash === oursHash;
    const weChanged = missing ? true : v2 ? oursHash !== prevHash : !sameContent && fnv(norm(ours.text)) !== prevHash;
    const theyChanged = missing || !prevHash ? false : v2 ? theirHash !== prevHash : sameContent ? false : fnv(norm(theirs)) !== prevHash;

    if (missing) push.push(rel);
    else if (sameContent && !prevHash) {
      // 库里内容与我方一致、又没有祖先记录：什么都不做，只把祖先补上
    } else if (weChanged && !theyChanged) push.push(rel);
    else if (theyChanged && !weChanged) {
      const parsed = parseFile(theirs);
      pull.push({ rel, id: parsed.meta['wb-id'] ?? anc.id, kind: parsed.meta['wb-kind'] ?? anc.kind, prose: parsed.prose, notes: parsed.notes });
    } else if (weChanged && theyChanged) {
      conflict.push({ rel, id: ours.id, kind: ours.kind, ours: ours.text, theirs });
    }
    // 两边都没变：什么都不做（这是绝大多数情况）

    // 祖先指纹：推了记刚写进去的；拉了记库里那一份（下一趟重渲染多半只变 words/updated，
    // 那是「我方又改了」→ 补一次推，不该被当成两边都改）；冲突保持原状，等人工判定
    const wrote = push.includes(rel);
    const pulled = theyChanged && !weChanged;
    next[rel] = { id: ours.id, kind: ours.kind, v: 2, hash: wrote ? oursHash : pulled ? theirHash : sameContent ? oursHash : v2 ? prevHash : prevHash || oursHash };
  }

  return { push, pull, conflict, prune, next };
}

// ---------- 回读：库里的改动 → 作品补丁 ----------

/**
 * 只回读「能安全落回原字段」的东西：章节 → content（批注区已摘掉）、
 * 人物卡 → state / power、设定卡 → content。索引页与未知类型不回读。
 */
function applyPull(pullList) {
  const patches = [];
  const skipped = [];
  for (const p of pullList) {
    if (!p.id) {
      skipped.push({ rel: p.rel, 因为: 'frontmatter 里没有 wb-id，认不出对应哪个实体' });
      continue;
    }
    if (p.kind === KIND.chapter) patches.push({ id: p.id, kind: p.kind, rel: p.rel, content: p.prose });
    else if (p.kind === KIND.character) {
      const state = /^当前状态：(.*)$/m.exec(p.prose)?.[1]?.trim() ?? '';
      const power = /^境界 \/ 战力：(.*)$/m.exec(p.prose)?.[1]?.trim() ?? '';
      patches.push({ id: p.id, kind: p.kind, rel: p.rel, state, power: power || undefined });
    } else if (p.kind === KIND.world) patches.push({ id: p.id, kind: p.kind, rel: p.rel, content: p.prose });
    else skipped.push({ rel: p.rel, 因为: `类型「${p.kind || '未知'}」是索引页或不是本工具建的，不回读` });
  }
  return { patches, skipped };
}

/** 把回读补丁落到一个 project 上（纯函数，返回新对象；双链在落回前被还原成纯文本） */
function applyPatches(project, patches) {
  const byId = new Map(patches.map((p) => [p.id, p]));
  const plain = (s) => String(s ?? '').replace(/\[\[(?:人物\/|设定\/)?([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1');
  const next = { ...project };
  if (next.chapters) next.chapters = next.chapters.map((c) => (byId.has(c.id) ? { ...c, content: plain(byId.get(c.id).content ?? '') } : c));
  if (next.characters)
    next.characters = next.characters.map((c) => {
      const p = byId.get(c.id);
      if (!p) return c;
      const out = { ...c };
      if (p.state) out.state = p.state;
      if (p.power) out.power = p.power;
      return out;
    });
  if (next.worldItems) next.worldItems = next.worldItems.map((w) => (byId.has(w.id) && byId.get(w.id).content !== undefined ? { ...w, content: plain(byId.get(w.id).content) } : w));
  return next;
}

// ---------- 彻底删除一本书后的孤儿判定 ----------

/**
 * 状态表里哪些条目的书已经不在 projects 里（= 被彻底删除；软删的书还在数组里，不算孤儿）。
 * 认条目优先用 index 页的实体 id（= project.id，改名也不跟丢）；
 * 老数据没有 index 记录时退化按书名（slug 后）匹配。
 * 同名书还活着时不判孤儿——宁可少清一条状态，也不能误删别人库里的目录。
 */
function orphanedBookRoots(store, projects) {
  const aliveIds = new Set((projects ?? []).map((p) => p.id));
  const aliveRoots = new Set((projects ?? []).map((p) => slug(p.title) || '未命名作品'));
  const orphans = [];
  for (const [root, entry] of Object.entries(store ?? {})) {
    const idxId = entry?.files?.[`${root}/index.md`]?.id;
    if (idxId ? aliveIds.has(idxId) : aliveRoots.has(root)) continue;
    orphans.push(root);
  }
  return orphans;
}

export { KIND, NOTES_MARK, fingerprint, fnv, mergeForeignMeta, norm, orphanedBookRoots, parseFile, renderBook, plan, applyPull, applyPatches, slug, linkify };
