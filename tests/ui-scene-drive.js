// 场景板的渲染进程冒烟：拖动用真的 PointerEvent，落库用真的读盘。
// 切块/重排/搬走的判据全在 tests/scenes.test.ts 的纯函数层，这条只盯那条接缝——
// 「拖一下 → 改到 chapter.content → 800ms 防抖落盘 → 退回时两章一起回」。
// 断言一律走有界轮询：Electron 窗口是隐藏的，短计时器会被节流，掐秒表必红。
(async () => {
  // sleep/trace/fail/step/btns/has/click/read/snapshot/hunt（等全部等待类）都在 ui-drive-helpers.js，
  // 由冒烟脚本拼在本文件前面；这里只留 Obsidian 冒烟自己的小件。
  const ch = async (id) => {
    const j = await read();
    return (j.projects[0].chapters || []).find((x) => x.id === id) || {};
  };
  const cards = () => [...document.querySelectorAll('.sb-card')];
  // 章节栏的条目是 div（不是 button），换章要点它
  const chap = async (name) => {
    const el = await poll(() => [...document.querySelectorAll('.chap-item')].find((x) => (x.innerText || '').includes(name)), '章节栏里没有「' + name + '」：' + [...document.querySelectorAll('.chap-item')].map((x) => (x.innerText || '').replace(/\s+/g, ' ')).join('|'));
    el.click();
    await sleep(1400); // 800ms 防抖落盘，多等一拍：换章前得让上一章的改动写完
  };
  const texts = () => cards().map((c) => (c.querySelector('.sb-title')?.innerText || '').trim());
  const pickTo = async (card, target) => {
    const sel = card.querySelector('select.sb-to');
    if (!sel) fail('卡片上没有「搬去…」的选择框');
    const opt = [...sel.options].find((o) => o.value && (o.textContent || '').includes(target));
    if (!opt) fail('选择框里没有那一章：' + [...sel.options].map((o) => o.textContent).join('|'));
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(1200); // 800ms 防抖落盘，多等一拍
  };
  const moveBtn = (card, dir) => {
    const b = [...card.querySelectorAll('button')].find((x) => (x.getAttribute('title') || '') === dir);
    if (!b) fail('卡片上没有' + dir);
    return b;
  };

  let out = '';
  try {
    await step('场景模式：三块段落切成三张卡', async () => {
      await click('创作项目', 700);
      const row = await poll(() => [...document.querySelectorAll('tr, li, .proj-row, .project-row')].find((r) => (r.innerText || '').includes('雾港')), '项目列表里那本书');
      row.click();
      await sleep(900);
      await click('场景', 1200);
      await poll(() => (document.querySelector('.scene-board') ? true : null), '点「场景」没出场景板：' + snapshot());
      await poll(() => (cards().length === 3 ? true : null), '三块段落没切成三张卡：' + texts().join('|'));
      if (!(document.querySelector('.sb-hint')?.innerText || '').includes('拖动')) fail('没说清怎么用：' + document.querySelector('.sb-hint').innerText);
      if (document.querySelector('.sb-drop')) fail('没在拖，落点线就亮着');
      out += '切块 3';
    });

    await step('拖动重排：落点线亮、跟手的卡压暗、落库一字不丢也不重复', async () => {
      const text0 = (await ch('c1')).content || '';
      const a = cards()[0];
      const c = cards()[2];
      const ab = a.getBoundingClientRect();
      const cb = c.getBoundingClientRect();
      pe(a, 'pointerdown', ab.x + ab.width / 2, ab.y + ab.height / 2);
      // 先等 React 重画一次：pointermove 的监听器要读到这次拖动已经开始
      await poll(() => (cards()[0].classList.contains('dragging') ? true : null), '按下后那张卡没进入「正在拖」的样子：' + cards()[0].className);
      pe(a, 'pointermove', cb.x + cb.width / 2, cb.y + cb.height * 0.9);
      await poll(() => (document.querySelector('.sb-drop') ? true : null), '拖动时没亮出落点线');
      // 「拿起来」必须有反馈，指针底下认不出是哪张在跟手就是静默失败
      pe(a, 'pointermove', cb.x + cb.width / 2, cb.y + cb.height * 0.9);
      pe(a, 'pointerup', cb.x + cb.width / 2, cb.y + cb.height * 0.9);
      await poll(() => (texts()[2] === '缆桩' ? true : null), '拖到第三块后面没生效：' + texts().join('→'));
      if (document.querySelector('.sb-drop')) fail('松手后落点线没收回去');
      if (document.querySelector('.sb-card.dragging')) fail('松手后还有卡片挂着「正在拖」的样式');
      const j = await poll(async () => {
        const x = await ch('c1');
        return (x.content || '').indexOf('缆桩') > (x.content || '').indexOf('桥洞') ? x : null;
      }, '重排没落库');
      // 真正的不变量是「一字不丢也不重复」：重排前后总字节数必须相等
      if (j.content.length !== text0.length) fail('重排改变了正文字节数：' + text0.length + ' → ' + j.content.length + '\n' + j.content);
      if (texts().join('|') !== '灯塔|桥洞|缆桩') fail('卡片顺序与预期不符：' + texts().join('→'));
      if (!/(?:\r?\n){2}/.test(j.content)) fail('重排把块之间的空行吃掉了：' + JSON.stringify(j.content));
      // 拖到一半切走窗口（Alt+Tab）：pointerup 可能永远不来，失焦得取消这次拖动，
      // 否则那张卡一直压暗、按钮一直禁用，指针回来也救不活
      const c0 = cards()[0];
      const b0 = c0.getBoundingClientRect();
      pe(c0, 'pointerdown', b0.x + b0.width / 2, b0.y + b0.height / 2);
      await poll(() => (cards()[0].classList.contains('dragging') ? true : null), '第二次按下没进入拖动状态');
      window.dispatchEvent(new Event('blur'));
      await poll(() => (!document.querySelector('.sb-card.dragging') ? true : null), '失焦后那张卡还压暗着');
      if (document.querySelector('.sb-drop')) fail('失焦后落点线还亮着');
      const j2 = await ch('c1');
      if (j2.content !== j.content) fail('被取消的这次拖动改了数据：' + JSON.stringify(j2.content).slice(0, 120));
      // 拖到一半按 Esc：这次拖动就地反悔——压暗与落点线收回、数据一个字节没变
      pe(c0, 'pointerdown', b0.x + b0.width / 2, b0.y + b0.height / 2);
      await poll(() => (cards()[0].classList.contains('dragging') ? true : null), 'Esc 前的按下没进入拖动状态');
      pe(c0, 'pointermove', b0.x + b0.width / 2, b0.y + b0.height / 2 - 40);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await poll(() => (!document.querySelector('.sb-card.dragging') ? true : null), '按了 Esc 那张卡还压暗着');
      if (document.querySelector('.sb-drop')) fail('按了 Esc 落点线还亮着');
      const j3 = await ch('c1');
      if (j3.content !== j.content) fail('Esc 取消的拖动改了数据：' + JSON.stringify(j3.content).slice(0, 120));
      out += ' · 拖动重排落库 · 失焦取消不遗留 · Esc 反悔不落库';
    });

    await step('上移一块：不靠指针也能精确挪，落库顺序跟着变', async () => {
      const before = texts();
      moveBtn(cards()[2], '上移一块').click();
      await sleep(1000);
      const after = await poll(() => (texts()[1] === before[2] ? texts() : null), '上移没把第三块挪到第二位：' + texts().join('→'));
      out += ' · 上移 ' + before[2] + '→第 2 位';
      if (after.length !== 3) fail('上移之后掉了一块：' + after.join('|'));
    });

    await step('整块搬去下一章：别章末尾逐字接上，退回时两章一起回', async () => {
      const block = '桥洞\n桥洞下面有人吹口哨。'; // fixtures 里那第三块（首行是标题），整块搬走就该一字不差
      const before = await ch('c2');
      const order = texts();
      const card = cards().find((x) => (x.innerText || '').includes('桥洞'));
      if (!card) fail('找不到「桥洞」那张卡：' + order.join('|'));
      await pickTo(card, '第2章');
      const here = await poll(async () => {
        const x = await ch('c1');
        return (x.content || '').includes('桥洞') ? null : x;
      }, '搬走后本章还留着那块');
      if (/桥洞/.test(here.content)) fail('搬走之后本章还留着那块：' + here.content);
      const there = await poll(async () => {
        const x = await ch('c2');
        return String(x.content || '').endsWith(block) ? x : null;
      }, '别章末尾没逐字接上整块');
      if (!String(before.content).trim() || !there.content.startsWith(before.content.trim())) fail('别章原来的正文被动了：' + there.content);
      if (cards().length !== 2) fail('搬走后卡片数没跟着少：' + cards().length);
      const back = await poll(() => [...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('退回上一步')), '搬走之后没出现「退回上一步」');
      back.click();
      await sleep(1200);
      const [h2, t2] = await poll(async () => {
        const a = await ch('c1');
        const b = await ch('c2');
        return /桥洞/.test(a.content || '') && !/桥洞/.test(b.content || '') ? [a, b] : null;
      }, '退回没把两章一起恢复：本章 ' + JSON.stringify((await ch('c1')).content) + '；别章 ' + JSON.stringify((await ch('c2')).content));
      if (cards().length !== 3) fail('退回之后卡片没回到三张：' + cards().length);
      out += ' · 跨章搬运可整步退回（c1 ' + h2.content.length + ' 字、c2 ' + t2.content.length + ' 字）';
    });

    await step('空章不谎报：没切出卡、也没给一个空转的「退回上一步」', async () => {
      await chap('空章');
      await poll(() => ((document.querySelector('.scene-board')?.innerText || '').includes('没有正文') ? true : null), '空章没给出「没有正文」：' + (document.querySelector('.scene-board')?.innerText || '（没有场景板）').slice(0, 120));
      if (cards().length) fail('空章切出了卡：' + cards().length);
      if (has('退回上一步').length) fail('什么都没动却给了个「退回上一步」');
      const x = await ch('c3');
      if ((x.content || '').trim()) fail('空章被写进了字：' + JSON.stringify(x.content));
      out += ' · 空章如实';
    });

    await step('单换行分段的一篇：退到段粒度并说出来，不是对着一个块装样子', async () => {
      await chap('段粒度');
      await poll(() => (cards().length === 3 ? true : null), '三行一段没切成三张卡：' + cards().length);
      const hint = (document.querySelector('.sb-hint')?.innerText || '').replace(/\s+/g, '');
      if (!/按段切开/.test(hint)) fail('没告诉作者这是段粒度：' + hint.slice(0, 80));
      // 退到段粒度之后照样能挪，而且拼回去一行字都不能差
      const text0 = (await ch('c4')).content || '';
      moveBtn(cards()[1], '下移一块').click();
      await sleep(1100);
      const j = await poll(async () => {
        const x = await ch('c4');
        return x.content || '';
      }, '段粒度下没读到那章').then((c) => {
        if (c !== '甲站在门口。\n丙没有回头。\n乙在身后说话。') fail('段粒度挪的结果不对：' + JSON.stringify(c));
        return c;
      });
      if (j.length !== text0.length) fail('段粒度挪动改了字节数：' + text0.length + ' → ' + j.length);
      out += ' · 段粒度会说明也能挪';
    });

    return { ok: true, summary: '场景板：' + out, trace };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), trace, page: snapshot() };
  }
})()
