// 新功能冒烟的渲染进程驱动：点真按钮、读真 DOM，mock 大模型的回执从 .ai-result 里等出来。
// 断言一律走有界轮询（hunt），等待上限显式写——掐秒表在隐藏窗口里必红。
(async () => {
  const bodyText = () => (document.body.innerText || '').replace(/\s+/g, ' ');
  // 步骤名带上错误：主进程只透传异常文本，不带名字就不知道崩在哪一步
  const namedStep = (name, fn) =>
    step(name, fn).catch((e) => {
      throw new Error(name + '：' + ((e && e.message) || e));
    });
  const tab = (name) => [...document.querySelectorAll('.check-tabs button')].find((b) => (b.innerText || '').trim() === name);

  await namedStep('打开书进入写作页', async () => {
    await click('创作项目', 700);
    const row = await poll(() => [...document.querySelectorAll('tr, li, .proj-row, .project-row')].find((r) => (r.innerText || '').includes('雾港')), '项目列表里没有《雾港》：' + snapshot());
    row.click();
    await sleep(900);
    await poll(() => (document.querySelector('.cm-editor') ? true : null), '编辑器没挂载：' + snapshot());
  });

  // 冒烟窗口是窄窗：工坊先收成图标竖栏，展开成完整面板才能按全名点动作
  const openRail = async () => {
    if (document.querySelector('.ai-act')) return;
    const expand = document.querySelector('.ai-strip-btn.expand');
    if (!expand) fail('窄窗下没有「展开工坊」按钮：' + snapshot());
    expand.click();
    await sleep(600);
  };

  await namedStep('OOC 检查：点动作 → mock 流式回执渲染到结果区', async () => {
    await openRail();
    const act = await poll(() => [...document.querySelectorAll('.ai-act')].find((b) => (b.innerText || '').includes('OOC 检查')), 'AI 工坊里没有「OOC 检查」按钮：' + snapshot());
    if (act.disabled) fail('OOC 检查按钮是禁用的（AI 配置没就绪？）：' + snapshot());
    act.click();
    const out = await poll(() => {
      const el = document.querySelector('.ai-result');
      return el && el.innerText.includes('MOCK-OOC-结论') ? el.innerText : null;
    }, 'OOC 回执没渲染出来', 25000);
    if (!out.includes('老烟')) fail('回执内容不对（应为 mock 的罐头话）：' + out.slice(0, 120));
  });

  await namedStep('钩子体检：同一个结果区接住第二份回执', async () => {
    await openRail();
    const act = await poll(() => [...document.querySelectorAll('.ai-act')].find((b) => (b.innerText || '').includes('钩子体检')), '没有「钩子体检」按钮');
    act.click();
    const out = await poll(() => {
      const el = document.querySelector('.ai-result');
      return el && el.innerText.includes('MOCK-HOOK-评级') ? el.innerText : null;
    }, '钩子体检回执没渲染出来', 25000);
    if (!out.includes('开头')) fail('钩子回执丢了开头部分：' + out.slice(0, 120));
  });

  await namedStep('体检·口头禅页签：高频片段上榜且带次数', async () => {
    await click('体检', 500);
    await present('.check-panel', '体检面板没开');
    tab('口头禅').click();
    const hit = await poll(() => [...document.querySelectorAll('.check-hit')].find((x) => (x.innerText || '').includes('码头')), '口头禅页签没列出「码头」：' + bodyText().slice(0, 200));
    if (!(hit.innerText || '').includes('× 3')) fail('「码头」的次数不对（应 ×3）：' + hit.innerText);
  });

  await namedStep('体检·平台惯例页签：短章告警在列', async () => {
    tab('平台惯例').click();
    const hit = await poll(() => [...document.querySelectorAll('.check-hit')].find((x) => (x.innerText || '').includes('章长')), '平台惯例页签没报章长：' + bodyText().slice(0, 200));
    if (!(hit.innerText || '').includes('建议处理')) fail('章长该是「建议处理」级：' + hit.innerText);
  });

  await namedStep('体检·本章页签：禁用词与本章汇总聚合出现', async () => {
    tab('本章').click();
    const hit = await poll(() => [...document.querySelectorAll('.check-hit')].find((x) => (x.innerText || '').includes('禁用词')), '本章页签没报禁用词：' + bodyText().slice(0, 220));
    if (!(hit.innerText || '').includes('瞬间')) fail('禁用词行没列出词面「瞬间」：' + hit.innerText);
  });

  await namedStep('冲刺计时：起跑出钟、提前结束落小结', async () => {
    await click('冲刺', 400);
    await present('.sprint-panel', '冲刺面板没开');
    const run15 = [...document.querySelectorAll('.sprint-choices button')].find((b) => (b.innerText || '').includes('15'));
    if (!run15) fail('没有 15 分钟档：' + bodyText().slice(0, 160));
    run15.click();
    await poll(() => (btns().some((b) => /^\d\d:\d\d$/.test((b.innerText || '').trim())) ? true : null), '起跑后按钮没变成倒计时');
    const stop = await poll(() => [...document.querySelectorAll('.sprint-choices button')].find((b) => (b.innerText || '').includes('提前结束')), '没有「提前结束」按钮');
    stop.click();
    await poll(() => (bodyText().includes('提前收工') ? true : null), '提前结束没出小结');
    await sleep(1600); // 800ms 自动保存，多等一拍让 stats.sprints 落盘
  });

  await namedStep('选中即查：选区菜单出现「查一查」，带词打开搜索', async () => {
    // 拦下 window.open：冒烟里不该真开浏览器
    let opened = null;
    window.open = (u) => {
      opened = u;
      return null;
    };
    const view = window.__cmView;
    if (!view) fail('编辑器调试钩子 __cmView 不在');
    view.dispatch({ selection: { anchor: 0, head: 4 } });
    const look = await poll(() => [...document.querySelectorAll('.sel-menu button')].find((b) => (b.innerText || '').includes('查一查')), '选区菜单里没有「查一查」：' + bodyText().slice(0, 160));
    look.click();
    await sleep(300);
    if (!opened || !opened.includes('baidu.com/s?wd=')) fail('查一查没走到搜索：' + opened);
    if (!opened.includes(encodeURIComponent('雾还没散'))) fail('搜索词不是选中的正文：' + opened);
  });

  // main.cjs 认这个返回值：ok !== true 一律算失败（summary 拼进通过摘要）
  return { ok: true, summary: 'OOC 与钩子回执渲染 · 体检四页签（口头禅/平台惯例/本章）· 冲刺起停 · 查一查带词' };
})();
