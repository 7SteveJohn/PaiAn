// 地点层级：给「地点」词条挂一个上级，把散卡的从属关系（雾港 › 码头 › 七号栈桥）串成链。
// 只吃作者自己填的 parent 名字，全确定性；环与悬空不猜、不修，标出来让作者自己改。
import type { WorldItem } from './types';

/** 归属链：从顶层到自己（展示顺序，如 [雾港, 码头, 七号栈桥]）。parent 指向不存在的名字 → 链在那里截断（悬空）；转回自己 → 环，截断。 */
export function placeChain(item: Pick<WorldItem, 'name' | 'parent'>, items: Pick<WorldItem, 'name' | 'parent' | 'kind'>[]): string[] {
  const byName = new Map(items.filter((w) => w.kind === '地点').map((w) => [w.name, w]));
  const chain = [item.name];
  const seen = new Set([item.name]);
  let cur = item;
  while (cur.parent) {
    const parentName = cur.parent.trim();
    if (!parentName || seen.has(parentName)) break; // 悬空（名字不存在或指回自己走过的）就停
    const parent = byName.get(parentName);
    if (!parent) break; // 指向的地点卡不存在：悬空，截断但不报错
    chain.unshift(parentName);
    seen.add(parentName);
    cur = parent;
  }
  return chain;
}

export interface PlaceRow {
  item: WorldItem;
  chain: string[]; // 自上而下：[根, …, 自己]
  depth: number; // 0 = 顶层
  dangling: boolean; // parent 填了个不存在的名字（或成环）——链断在这
}

/** 展示序：同一根的挨在一起、父在子前、悬空的殿后——一眼看出「雾港底下都有什么」。 */
export function placeRows(items: WorldItem[]): PlaceRow[] {
  const places = items.filter((w) => w.kind === '地点');
  const rootIndex = new Map(places.map((w, i) => [w.name, i]));
  const rows = places.map((item) => {
    const chain = placeChain(item, items);
    const top = chain[chain.length - 1];
    const dangling = Boolean(item.parent?.trim()) && (chain.length < 2 || top !== item.parent!.trim());
    // 悬空（根不是任何一张地点卡）的排在所有有根的后面
    const root = rootIndex.has(chain[0]) ? rootIndex.get(chain[0])! : places.length;
    return { item, chain, depth: chain.length - 1, dangling, root };
  });
  return rows
    .sort((a, b) => a.root - b.root || a.chain.length - b.chain.length || (a.chain.join('›') < b.chain.join('›') ? -1 : 1))
    .map(({ item, chain, depth, dangling }) => ({ item, chain, depth, dangling }));
}

/** 碎片/素材的自动关联：文本里出现了哪些实体名（人物、设定、地点）。长名优先，防「雾港」吃掉「雾港码头」。 */
export function fragmentLinks(text: string, names: string[]): string[] {
  const hit = names.filter((n) => n && text.includes(n));
  return hit.filter((n) => !hit.some((m) => m !== n && m.includes(n))).sort((a, b) => b.length - a.length);
}
