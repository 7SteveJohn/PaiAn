// 「共 N 条，只显示前 cap 条」的通用小件：结论算出来了就该让人看得见，
// 硬截断又不报总数的清单等于白算（守夜人跑了几十章的账，界面上只露 8 条）。
import { useState, type ReactNode } from 'react';

export default function ShowMore<T>({ items, cap, render }: { items: T[]; cap: number; render: (item: T, index: number) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, cap);
  const hidden = items.length - shown.length;
  return (
    <>
      {shown.map(render)}
      {hidden > 0 && !open && (
        <button className="mini-btn" onClick={() => setOpen(true)}>
          展开其余 {hidden} 条（共 {items.length} 条）
        </button>
      )}
      {open && items.length > cap && (
        <button className="mini-btn" onClick={() => setOpen(false)}>
          收起（只看前 {cap} 条）
        </button>
      )}
    </>
  );
}
