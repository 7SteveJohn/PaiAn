// 主进程源码哨兵：托盘重写时曾把 showMain 的定义弄丢（ReferenceError 被 try/catch 吞成
// tray=null），门禁全是 SMOKE 模式根本不碰托盘，于是「关 X 直接退出」的回归漏网。
// 这里钉两件静态事实：showMain 必须先定义后使用；close 处理必须有 preventDefault（进托盘）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../electron/main.cjs'), 'utf-8');

test('托盘：showMain 在 setupTray 内有定义（菜单与单击图标都用它）', () => {
  const useAt = src.indexOf('click: showMain');
  const defAt = src.indexOf('const showMain = () =>');
  assert.ok(defAt >= 0, '找不到 showMain 定义');
  assert.ok(useAt > defAt, 'showMain 必须先定义后使用');
});

test('关闭处理：进托盘的 preventDefault 必须存在', () => {
  const closeAt = src.indexOf("win.on('close'");
  const seg = src.slice(closeAt, closeAt + 900);
  assert.ok(seg.includes('e.preventDefault()'), 'close 处理丢了 preventDefault，关 X 会直接退出');
  assert.ok(seg.includes('closeToTray'), 'close 处理应读 app.json 的偏好');
});
