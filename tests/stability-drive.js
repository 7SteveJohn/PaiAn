// 稳定性压测驱动：在真实渲染进程里反复横跳 + 高频操作，全程量时延 / 数 DOM / 收未捕获异常。
// 预算给得宽（本机真实窗口，不是精度竞赛）：破预算说明真的卡，不破就当回归哨兵。
(async () => {
  const errors = [];
  const onErr = (e) => errors.push('error: ' + String(e.message));
  const onRej = (e) => errors.push('rejection: ' + String(e.reason));
  window.addEventListener('error', onErr);
  window.addEventListener('unhandledrejection', onRej);

  const domCount = () => document.getElementsByTagName('*').length;
  const heapMB = () => {
    const m = performance.memory;
    return m ? Math.round(m.usedJSHeapSize / 1048576) : -1;
  };
  const domStart = domCount();
  const heapStart = heapMB();

  const stat = {};
  // budget 单位 ms；超了记一条错误（压测红就红在真实体验的账上）
  const timed = async (label, budget, fn) => {
    const s = performance.now();
    await fn();
    const ms = Math.round(performance.now() - s);
    const r = (stat[label] = stat[label] || { n: 0, max: 0, avg: 0, over: 0 });
    r.n += 1;
    r.avg = Math.round((r.avg * (r.n - 1) + ms) / r.n);
    if (ms > r.max) r.max = ms;
    if (ms > budget) {
      r.over += 1;
      errors.push(`${label} 超预算：${ms}ms > ${budget}ms`);
    }
    return ms;
  };
  const budgets = { mode: 800, reopen: 1500, chapter: 700, outline: 2200 };

  const chapterSig = (c) => `第${c}章第0段`;
  // 章节栏/工具条只在「写作」模式存在：这些步骤开工前先回写作页
  // 计时段里不能用 click()——它自带 sleep，会把真实时延撑成假超预算
  const clickNow = (label) => {
    const b = [...document.querySelectorAll('.mode-seg button')].find((x) => (x.innerText || '').trim() === label);
    if (!b) fail('模式按钮没了：' + label);
    b.click();
  };

  const gotoWrite = async () => {
    await click('写作', 1500);
    await hunt(async () => (document.querySelector(".cm-content") ? true : null), "回写作页没看到编辑器：" + snapshot());
  };

  const clickChapter = async (n) => {
    const row = await hunt(
      async () => [...document.querySelectorAll('.chap-item')].find((x) => (x.innerText || '').includes(`压测第${n}章`)) || null,
      `章节栏没有「压测第${n}章」：` + snapshot(),
    );
    row.click();
    await hunt(
      async () => (document.querySelector('.cm-content')?.innerText || '').includes(chapterSig(n)) ? true : null,
      `切到第${n}章后正文没跟上：` + snapshot(),
    );
  };

  await step('种子书打开：120 章的编辑器就位', async () => {
    // 桌面感探针：drag 区与选中行为要用计算样式说话
    const probe = {
      desktop: document.documentElement.classList.contains('desktop'),
      brandRegion: getComputedStyle(document.querySelector('.brand')).webkitAppRegion,
      brandSelect: getComputedStyle(document.querySelector('.brand-name')).userSelect,
    };
    globalThis.__probe = probe;
    if (!probe.desktop) errors.push('html.desktop 没挂上（拖拽/主题全失效）');
    if (probe.brandRegion !== 'drag') errors.push('品牌区不是拖拽把手：' + probe.brandRegion);
    if (probe.brandSelect !== 'none') errors.push('壳文字仍可选中（网页感）：' + probe.brandSelect);
    await click('创作项目', 1200);
    const row = await hunt(async () => [...document.querySelectorAll('button.proj-row')].find((b) => (b.innerText || '').includes('压测长书')) || null, '项目列表没有压测长书');
    await timed('reopen', budgets.reopen, async () => {
      row.click();
      await hunt(async () => (document.querySelector('.cm-content') || document.querySelector('.chap-list')) ? true : null, '打开书没有进写作页');
      await clickChapter(1);
    });
  });

  await step('模式往返 ×20：写作/大纲/复盘来回切', async () => {
    const seq = ['大纲', '复盘', '写作'];
    for (let i = 0; i < 20; i++) {
      const t = seq[i % seq.length];
      await timed('mode', budgets.mode, async () => {
        clickNow(t);
        if (t === '大纲') await hunt(async () => (document.querySelectorAll('.imp-row, .ol-card, .outline-head').length ? true : null), '大纲页没渲染');
        if (t === '复盘') await hunt(async () => (document.querySelector('.pk-speakers, .pk-debts') || (document.body.innerText || '').includes('节奏琴键')) ? true : null, '复盘页没渲染');
        if (t === '写作') await hunt(async () => document.querySelector('.cm-content'), '写作页没回来');
      });
    }
  });

  await step('随机切章 ×40：正文跟手，不串章', async () => {
    await gotoWrite();
    for (let i = 0; i < 40; i++) {
      const n = i % 2 === 0 ? 1 + (i * 7) % 120 : 120 - ((i * 11) % 120);
      await timed('chapter', budgets.chapter, () => clickChapter(Math.min(120, Math.max(1, n))));
    }
  });

  await step('大纲页 120 卡渲染：预热一次再量第二次', async () => {
    await click('大纲', 2500);
    await hunt(async () => document.querySelector('.outline-head') ? true : null, '大纲页没开');
    await click('写作', 1200);
    await timed('outline', budgets.outline, async () => {
      clickNow('大纲');
      await hunt(async () => (document.querySelectorAll('.ol-card').length >= 100 ? true : null), '120 章的卡没出全：' + snapshot());
    });
    await click('写作', 1200);
  });

  await step('打字洪峰：150 连击后自动保存不丢不重', async () => {
    await gotoWrite();
    await clickChapter(1);
    const cm = await hunt(async () => document.querySelector('.cm-content'), '编辑器没了');
    cm.focus();
    const marker = `压测洪峰${Date.now().toString().slice(-6)} `;
    const burst = Array.from({ length: 150 }, (_, i) => `${marker}${i} `).join('');
    await timed('typing', 20000, async () => {
      // 全选后一次替换：正文被洪峰文本接管，落库断言才有唯一口径
      cm.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true, cancelable: true }));
      await sleep(80);
      document.execCommand('insertText', false, burst);
    });
    const saved = await hunt(
      async () => {
        const j = await api();
        const p = (j.projects || []).find((x) => x.id === 'stab1');
        const c1 = (p.chapters || []).find((x) => x.id === 'sc1');
        return c1 && c1.content.includes(marker) && c1.content.includes('149') && (document.body.innerText || '').includes('已保存') ? p : null;
      },
      '打字洪峰没落库（或保存态没回来）：' + snapshot(),
    );
    if (saved.chapters.length !== 120) fail('洪峰后章数变了：' + saved.chapters.length);
    const c2 = saved.chapters.find((x) => x.id === 'sc2');
    if (!c2 || !c2.content.includes(chapterSig(2))) fail('别的章被殃及：' + JSON.stringify((c2?.content || '').slice(0, 40)));
  });

  await step('浮层开关 ×20 + DOM/内存哨兵', async () => {
    await gotoWrite();
    const before = domCount();
    for (let i = 0; i < 20; i++) {
      const act = ['对照', '历史版本', '投稿体检'][i % 3];
      // 历史版本按钮带计数（「历史版本（1）」），得按前缀认
      const b = await hunt(
        async () => [...document.querySelectorAll('button')].find((x) => (act === '历史版本' ? (x.innerText || '').trim().startsWith('历史版本') : (x.innerText || '').trim() === act)) || null,
        `找不到「${act}」按钮：` + snapshot(),
      );
      b.click();
      await sleep(60);
      b.click();
      await sleep(40);
    }
    await sleep(300);
    const delta = domCount() - before;
    if (delta > 800) errors.push(`浮层开关 20 轮后 DOM 多了 ${delta} 个节点（泄漏嫌疑）`);
    stat.dom = { n: delta, max: delta, avg: delta, over: 0 };
    const heap = heapMB();
    if (heapStart > 0 && heap > 0 && heap - heapStart > 200) errors.push(`堆内存涨了 ${heap - heapStart} MB（泄漏嫌疑）`);
  });

  if (errors.length) fail('压测发现问题：\n- ' + errors.slice(0, 12).join('\n- '));

  const statLine = Object.entries(stat)
    .map(([k, r]) => `${k}:${r.n}次 平均${r.avg}ms 最慢${r.max}ms${r.over ? ` 超预算${r.over}次` : ''}`)
    .join(' · ');
  const heapLine = heapStart > 0 && heapMB() > 0 ? ` · 堆 ${heapStart}→${heapMB()}MB` : '';
  const domLine = ` · DOM ${domStart}→${domCount()}`;
  return { ok: true, summary: `稳定性压测通过：${statLine}${heapLine}${domLine} · 桌面感 ${JSON.stringify(globalThis.__probe ?? {})}` };
})()
