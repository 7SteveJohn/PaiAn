// UI 驱动公共助手片段——注意：这份文件是**源码文本**，不是可执行模块。
// 驱动脚本被 electron/main.cjs 当字符串读进去 executeJavaScript，不能 import，
// 所以共享只能由各冒烟脚本在启动前把这段源码拼在驱动前面（tests/ui-drive-bundle.mjs）。
// 各驱动里不要再抄这些实现；等待上限（cap）一律显式默认值，别让「等多久」变成隐式差异。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trace = [];
const fail = (m) => {
  throw new Error(m);
};
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    await fn();
    trace.push('ok ' + name + ' (' + (Date.now() - t0) + 'ms)');
  } catch (e) {
    trace.push('fail ' + name + ' -> ' + (e && e.message));
    throw e;
  }
};
const btns = () => [...document.querySelectorAll('button')];
const has = (t) => btns().filter((b) => (b.innerText || '').includes(t));
const exact = (t) => btns().filter((b) => (b.innerText || '').trim() === t);
const btn = (t) => [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim().includes(t));
const exactBtn = (t) => [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === t);
// 先精确匹配再包含匹配：DOM 里有「AI 引导创建」这类带同名前缀的按钮时不会点错
const click = async (t, wait = 700) => {
  const pool = exact(t).length ? exact(t) : has(t);
  const b = pool[0];
  if (!b) fail('没找到按钮：' + t + '；现有：' + btns().slice(0, 26).map((x) => (x.innerText || '').trim()).join('|'));
  b.click();
  await sleep(wait);
};
const snapshot = () => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400);
const read = async () => {
  const r = await fetch('/api/data');
  const j = await r.json();
  if (!j || !Array.isArray(j.projects)) fail('读 /api/data 失败（HTTP ' + r.status + '）：' + JSON.stringify(j).slice(0, 140));
  return j;
};
const api = read; // 同一个东西的旧叫法，别再新造
// 有界轮询（断言的唯一姿势）：Electron 窗口是隐藏的，短计时器会被节流，掐秒表必红。
// 等不到就 fail 并把现场带上，绝不静默返回 null——真要看耗时/自行处理，用 goneIn。
const hunt = async (fn, label = '条件', cap = 9000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > cap) fail('等待超时（' + cap + 'ms）：' + label);
    await sleep(120);
  }
};
const poll = hunt; // 同一语义的旧叫法，别再自造第三种
const assertEl = (fn, label = '条件') => hunt(fn, label);
const present = (sel, label = '元素出现', cap = 9000) => hunt(() => document.querySelector(sel), label, cap);
// 等元素消失，返回耗时（供 summary 报实测数字）；超时返回 -1，怎么报错由调用方定
const goneIn = async (sel, cap = 2600) => {
  const t0 = Date.now();
  for (;;) {
    if (!document.querySelector(sel)) return Date.now() - t0;
    if (Date.now() - t0 > cap) return -1;
    await sleep(120);
  }
};
const pe = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1 }));
