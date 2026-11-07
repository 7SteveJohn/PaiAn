// 检查更新的判据层（纯函数）：tag 形如 v1.2.3 / 1.2.3 / v1.2。
// 逐段按数字比，段数不齐短补 0；任何一段不是纯数字（rc/beta/乱写）就判「不可比」——
// 宁可漏提醒一次，也不把读不懂的 tag 误报成新版本。

export function parseTag(tag) {
  const t = String(tag ?? '').trim().replace(/^v/i, '');
  if (!t) return null;
  const nums = [];
  for (const p of t.split('.')) {
    if (!/^\d+$/.test(p)) return null;
    nums.push(Number(p));
  }
  return nums;
}

/** latest 是否真的比 current 新（相等或更旧、或任一 tag 读不懂，都返回 false） */
export function isNewerVersion(current, latest) {
  const a = parseTag(current);
  const b = parseTag(latest);
  if (!a || !b) return false;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (y > x) return true;
    if (y < x) return false;
  }
  return false;
}
