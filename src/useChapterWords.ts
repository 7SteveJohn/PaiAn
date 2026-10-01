import { useMemo, useRef } from 'react';
import { chapterWordMap } from './util';

// 章节词数增量缓存：chapters 引用变化时只对 content 引用真正变化的那一章重扫
// 正文，其余章节直接复用缓存值——500 章长篇在编辑器每键输入时的重算从
// 「全量扫整本书」降到「只扫当前章」（约千分之一）。
// 返回 id → 字数 的 Map；同一组件内随 chapters 引用自动重建。
export function useChapterWords(chapters: { id: string; content?: string }[]) {
  const cacheRef = useRef(new Map<string, { content: string | undefined; words: number }>());
  return useMemo(() => {
    const r = chapterWordMap(chapters, cacheRef.current);
    cacheRef.current = r.cache;
    return r.map;
  }, [chapters]);
}
