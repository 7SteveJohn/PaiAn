import { useCallback, useEffect, useRef, useState } from 'react';
import { syncToObsidian } from './api';
import { AUTO_SYNC_MS } from './util';
import type { ObsidianConfig, Project } from './types';

export type SyncConflict = { rel: string; id: string; kind: string; ours: string; theirs: string };

export interface ObsidianSyncState {
  syncMsg: string;
  /** 顶部回执行的内容也归这里管（导出/复制/同步共用同一行） */
  setSyncMsg: (msg: string) => void;
  syncConflicts: SyncConflict[];
  pendingResolve: Record<string, 'app' | 'vault'>;
  sync: () => void;
  decide: (rel: string, side: 'app' | 'vault') => void;
  /** 冲突面板的「先不管」：只收起面板，待判定清单还留着（自动同步继续停手） */
  dismissConflicts: () => void;
  /** 写作页把当前正文喂进来：正文变化就重新武装 12 秒计时。写作页切走后计时器照常活着 */
  touchDoc: (projectId: string, doc: string) => void;
}

/**
 * Obsidian 同步的数据所有者在 App 层：⑤ 的 12 秒计时与冲突「待判定」状态住在这里，
 * 写作页只负责显示与喂正文——切去灵感库 / 统计 / 设置时 WritingView 整个卸载，
 * 计时器不跟着消失，写完直接切走，最后一段改动也会被推出去。
 * 两条底线不变：判据仍然走三方对比（只有我方变了才写文件）；有冲突没判完就停手——
 * 自动的东西绝不自作主张选边，宁可停在原地说「等你点」。
 */
export function useObsidianSync(project: Project | null, obsidian: ObsidianConfig, onUpdate: (id: string, patch: Partial<Project>) => void): ObsidianSyncState {
  const [syncMsg, setSyncMsg] = useState('');
  // 两边都改过的文件：不自动偏向任何一边，列出来让人逐条判
  const [syncConflicts, setSyncConflicts] = useState<SyncConflict[]>([]);
  const [pendingResolve, setPendingResolve] = useState<Record<string, 'app' | 'vault'>>({});
  // ⑤ 自动同步用：上次真的推过的正文（别为同一份内容反复跑），以及还没判完的冲突清单。
  // 待判定用 ref 而不是 syncConflicts 状态——清单上的「先不管」只是收起面板，那不等于没冲突了
  const autoSyncDone = useRef('');
  const unresolved = useRef<string[]>([]);
  const timer = useRef<number | null>(null);
  // 待推的正文挂在它所属的书上：切走页面后 project 参数会变 null，计时到点按这个 id 推
  const lastFed = useRef<{ id: string; doc: string } | null>(null);
  const projectRef = useRef(project);
  projectRef.current = project;

  const clearAll = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    unresolved.current = [];
    autoSyncDone.current = '';
    lastFed.current = null;
    setSyncConflicts([]);
    setPendingResolve({});
    setSyncMsg('');
  };

  // 换到另一本书：上一本的冲突清单与「上次推过的正文」都不该带过来。
  // 切走（project 变 null）不算换书——那正是 P2 要保住的场景，计时器继续走完这一趟。
  const seenBook = useRef<string | undefined>(undefined);
  useEffect(() => {
    const id = project?.id;
    if (id === undefined) return;
    if (seenBook.current === id) return;
    seenBook.current = id;
    if (lastFed.current && lastFed.current.id !== id) clearAll();
  }, [project?.id]);

  const runSyncFor = useCallback(
    (pid: string | undefined, resolve: Record<string, 'app' | 'vault'>, auto = false) => {
      if (!pid) return;
      syncToObsidian(pid, resolve)
        .then((r) => {
          const bits = [`推 ${r.pushed.length}`, `拉 ${r.pulled.length}`];
          if (r.pruned.length) bits.push(`回收 ${r.pruned.length}`);
          if (r.conflicts.length) bits.push(`待你判定 ${r.conflicts.length}`);
          // 自动那一趟若什么都没挪，就别在页面上留一句话占地方（它每 12 秒就来一回）
          if (!(auto && !r.pushed.length && !r.pulled.length && !r.pruned.length && !r.conflicts.length)) {
            setSyncMsg(`${auto ? '自动同步' : '已同步'} → 库内 ${r.root}/（${bits.join(' · ')}）`);
          }
          unresolved.current = r.conflicts.map((c) => c.rel);
          setSyncConflicts(r.conflicts);
          // 判定过的条目若已消失，就从待办里摘掉
          const still = new Set(r.conflicts.map((c) => c.rel));
          setPendingResolve((prev) => Object.fromEntries(Object.entries(prev).filter(([rel]) => !still.has(rel))));
          if (r.nextProject) {
            const np = r.nextProject;
            onUpdate(pid, { chapters: np.chapters, characters: np.characters, worldItems: np.worldItems });
          }
        })
        .catch((e: Error) => setSyncMsg('失败：' + e.message));
    },
    [onUpdate],
  );

  const arm = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    const fed = lastFed.current;
    if (!fed || !fed.doc.trim() || fed.doc === autoSyncDone.current) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (unresolved.current.length) {
        setSyncMsg(`自动同步停在这里：还有 ${unresolved.current.length} 处冲突等你判定（点「同步」把清单再拉出来）`);
        return;
      }
      autoSyncDone.current = fed.doc;
      runSyncFor(fed.id, {}, true);
    }, AUTO_SYNC_MS);
  }, [runSyncFor]);

  const touchDoc = useCallback(
    (projectId: string, doc: string) => {
      lastFed.current = { id: projectId, doc };
      if (!obsidian.autoSync || !obsidian.vaultPath) return;
      arm();
    },
    [obsidian.autoSync, obsidian.vaultPath, arm],
  );

  // 与原实现一致：冲突清单变化（比如刚判定完）也重新武装一次，让停手的自动同步接着跑
  useEffect(() => {
    if (!obsidian.autoSync || !obsidian.vaultPath) return;
    arm();
  }, [syncConflicts, obsidian.autoSync, obsidian.vaultPath, arm]);

  const runSync = useCallback(
    (resolve: Record<string, 'app' | 'vault'>, auto = false) => runSyncFor(projectRef.current?.id, resolve, auto),
    [runSyncFor],
  );

  const sync = useCallback(() => runSync(pendingResolve), [runSync, pendingResolve]);
  const decide = useCallback(
    (rel: string, side: 'app' | 'vault') => {
      const next = { ...pendingResolve, [rel]: side };
      setPendingResolve(next);
      runSync(next);
    },
    [runSync, pendingResolve],
  );
  const dismissConflicts = useCallback(() => setSyncConflicts([]), []);

  return { syncMsg, setSyncMsg, syncConflicts, pendingResolve, sync, decide, dismissConflicts, touchDoc };
}
