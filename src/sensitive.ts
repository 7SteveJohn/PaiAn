// 「投稿体检」的词库扫描层：各平台的雷区词不一样，所以词库由作者自己贴（存在本机），
// 扫描纯本地、不联网、不改稿——只报告哪里命中了什么，替换与否始终是作者的事。

/** 从粘贴的文本里拆词：换行 / 逗号 / 顿号 / 空格都算分隔，去空去重 */
export function parseWordList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\n,，、;；\s]+/)) {
    const w = raw.trim();
    if (w && !out.includes(w)) out.push(w);
  }
  return out;
}

const KEY = 'ww-sensitive-words';

export function loadWordText(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveWordText(text: string): void {
  try {
    localStorage.setItem(KEY, text);
  } catch {
    // 隐私模式存不进就算了：本次会话里还能用
  }
}

export interface SensitiveHit {
  chapterId: string;
  /** 章内标题（展示用） */
  title: string;
  word: string;
  count: number;
  /** 第一次出现的位置（章内偏移，供跳转） */
  at: number;
}

export interface ScanResult {
  hits: SensitiveHit[];
  /** 实际参与扫描的词数 */
  words: number;
}

/** 逐章逐词数命中：只报数与首处位置，不做任何替换 */
export function scanChapters(chapters: { id: string; title: string; content: string }[], words: string[]): ScanResult {
  const list = words.filter((w) => w.length > 0);
  const hits: SensitiveHit[] = [];
  for (const c of chapters) {
    const text = c.content ?? '';
    if (!text) continue;
    for (const w of list) {
      let count = 0;
      let at = -1;
      let i = text.indexOf(w);
      while (i >= 0) {
        if (count === 0) at = i;
        count += 1;
        i = text.indexOf(w, i + w.length);
      }
      if (count > 0) hits.push({ chapterId: c.id, title: c.title, word: w, count, at });
    }
  }
  return { hits, words: list.length };
}
