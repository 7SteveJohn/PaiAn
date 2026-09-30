// 历史版本快照的线格式与内存态换算：全部纯函数，不碰网络。
//
// 为什么是「扁平 + 按 key 增量」：快照体积可以比正文大一个数量级（实测 500 章的书里
// 快照占 payload 的 93%）。整表重发意味着改一章就重发 67MB，整包读回来也是同一个数——
// 所以线格式按 key（pid 或 pid::cid）寻址，谁变了发谁，读也按本读。
import type { Project, ProjectVersion } from './types';

// 份数上限在客户端与服务端各写一份（server.js 不能 import TS 源码），
// 两边漂了不会有报错，只表现为「界面显示 20 份、落盘被截成更少」，由回归测试钉住。
export const MAX_VERSIONS = 20;

// key：整本一层用 pid，单章一层用 pid::cid。id 由 uid() 生成为 base36，不含冒号
export const VERSION_SEP = '::';
export type FlatStore = Record<string, ProjectVersion[]>;

export const chapterKey = (projectId: string, chapterId: string) => projectId + VERSION_SEP + chapterId;
export const ownerOf = (key: string) => key.slice(0, key.indexOf(VERSION_SEP) < 0 ? key.length : key.indexOf(VERSION_SEP));

const has = (v?: ProjectVersion[]) => Boolean(v && v.length);

// 自动保存只发正文：把快照从待发送的项目里剥出来（无快照的对象保持原引用）
export function stripVersions(projects: Project[]): Project[] {
  return projects.map((p) => {
    if (!has(p.versions) && !(p.chapters ?? []).some((c) => has(c.versions))) return p;
    const next: Project = { ...p };
    delete next.versions;
    if (p.chapters?.some((c) => has(c.versions))) {
      next.chapters = p.chapters.map((c) => {
        if (!has(c.versions)) return c;
        const copy = { ...c };
        delete copy.versions;
        return copy;
      });
    }
    return next;
  });
}

// 内存态 → 线格式。only 传「已经读过快照的那些作品」，没读过的作品一律不出现在结果里，
// 免得凭半截数据把服务端已有的 20 份覆盖成一两份。
export function flattenVersions(projects: Project[], only?: Set<string>): FlatStore {
  const out: FlatStore = {};
  for (const p of projects) {
    if (only && !only.has(p.id)) continue;
    if (p.versions?.length) out[p.id] = p.versions;
    for (const c of p.chapters ?? []) {
      if (c.versions?.length) out[chapterKey(p.id, c.id)] = c.versions;
    }
  }
  return out;
}

// 每个 key 的廉价指纹（份数 + 字数合计 + 最新时间）：变了才值得重发那一条。
// 回滚会把当前内容追加为快照（份数可能被上限截断而不变），所以带上时间与字数。
export function signatureOf(list: ProjectVersion[]): string {
  let words = 0;
  let last = '';
  for (const v of list) {
    words += v.words || 0;
    if (v.at > last) last = v.at;
  }
  return `${list.length}|${words}|${last}`;
}

export function versionSignatures(flat: FlatStore): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, list] of Object.entries(flat)) out.set(k, signatureOf(list));
  return out;
}

// 同一 key 的并集：按 at+字数去重、时间升序、裁到上限。
// 读回来的时候内存里可能刚追加了一条（服务端还没收到），谁都不能被无声丢掉。
export function unionVersions(a: ProjectVersion[] = [], b: ProjectVersion[] = []): ProjectVersion[] {
  const seen = new Set<string>();
  const out: ProjectVersion[] = [];
  for (const v of [...a, ...b]) {
    const k = v.at + '|' + (v.words || 0);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  out.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  return out.slice(-MAX_VERSIONS);
}

// 线格式 → 内存态：把读回的快照并进对应作品/章节，保留没被覆盖的对象引用
export function mergeVersionsInto(projects: Project[], flat: FlatStore): Project[] {
  return projects.map((p) => {
    const own = flat[p.id];
    const chapters = flatOwnedChapters(p, flat);
    if (!own && !chapters) return p;
    const next: Project = { ...p };
    if (own) next.versions = unionVersions(p.versions, own);
    if (chapters) {
      next.chapters = (p.chapters ?? []).map((c) => {
        const list = flat[chapterKey(p.id, c.id)];
        return list ? { ...c, versions: unionVersions(c.versions, list) } : c;
      });
    }
    return next;
  });
}

function flatOwnedChapters(p: Project, flat: FlatStore): boolean {
  return (p.chapters ?? []).some((c) => Boolean(flat[chapterKey(p.id, c.id)]));
}

// 首屏带回来的只有份数，据此判断「这个 key 服务端有没有东西」——
// 空 key 才允许在没读过的情况下直接写，否则必须先读后写。
export function countOf(counts: Record<string, number> | undefined, key: string): number {
  return counts?.[key] ?? 0;
}

export interface VersionWrites {
  changed: FlatStore; // 这次该发出去的 key（增量）
  need: string[]; // 有变化但还没读过服务端那份，得先去拉的作品 id
}

// 这次落盘要发哪些快照：指纹变了才发；没读过的绝不发——顶多漏掉自己新写的一条，
// 而凭半截数据把磁盘上已有的 20 份顶掉是不可接受的。
export function pickVersionWrites(
  flat: FlatStore,
  sent: Map<string, string>,
  counts: Record<string, number>,
  loaded: Set<string>,
): VersionWrites {
  const sigs = versionSignatures(flat);
  const changed: FlatStore = {};
  const need: string[] = [];
  for (const [k, list] of Object.entries(flat)) {
    const owner = ownerOf(k);
    const allowed = loaded.has(owner) || countOf(counts, k) === 0;
    if (!allowed) {
      if (!need.includes(owner)) need.push(owner);
      continue;
    }
    if (sent.get(k) !== sigs.get(k)) changed[k] = list;
  }
  return { changed, need };
}
