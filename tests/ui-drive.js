// AI-free UI 主路径驱动脚本：在 Electron 渲染进程里执行（由 tests/ui-smoke.mjs 注入）。
// 走真实点击与真实输入：新建项目 → 打开 → 新建章节 → 写正文 → 等自动保存 → 回读接口校验落库。
(async () => {
// sleep/trace/fail/step/hunt/btns/click 等公共助手在 ui-drive-helpers.js，由冒烟脚本拼在本文件前面
  // DOM 里存在「AI 引导创建」等包含「创建」字样的按钮，创建按钮必须限定在新建表单内精确匹配
  const createBtn = () => [...document.querySelectorAll('.inline-form button')].find((b) => (b.innerText || '').trim() === '创建');
  const clickBtn = (text) => { const b = btn(text); if (!b) fail('未找到按钮：' + text); b.click(); };
  const setInput = (el, value) => {
    if (!el) fail('未找到输入框');
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const title = '冒烟书' + Date.now().toString().slice(-6);
  const body = '雾港的夜航开始了，潮声在船舷下翻涌，像是有人在暗处数着节拍。';

  try {
    await step('进入创作项目页', async () => {
      clickBtn('创作项目');
      await sleep(400);
      if (!btn('新建项目')) fail('未渲染新建项目按钮，页面文本：' + snapshot());
    });

    await step('打开新建表单并填标题', async () => {
      clickBtn('新建项目');
      await sleep(300);
      const input = document.querySelector('input[placeholder="这篇要写什么？"]');
      if (!input) fail('未渲染标题输入框，页面文本：' + snapshot());
      setInput(input, title);
      await sleep(200);
      if (!input.value.includes(title)) fail('受控输入未生效（React 未收到 input 事件）');
    });

    await step('创建项目', async () => {
      const create = createBtn();
      if (!create) fail('未找到创建按钮（应在新建表单内）');
      if (create.disabled) fail('创建按钮仍禁用，说明标题未进入 state');
      create.click();
      await sleep(400);
    });

    await step('打开新建的作品', async () => {
      const row = await hunt(
        () => [...document.querySelectorAll('button.proj-row')].find((b) => (b.innerText || '').includes(title)),
        '项目列表出现新作品',
        4000,
      );
      row.click();
      await sleep(900);
    });

    // 普通「新建项目」产出的是单文档模式（草稿），章节模式要走 AI 向导；这里走最基础的主路径：直接写正文
    await step('确认落在写作页且编辑器就绪', async () => {
      await hunt(() => document.querySelector('.cm-content'), '写作页编辑器', 4000);
    });

    await step('在编辑器里写正文', async () => {
      const cm = document.querySelector('.cm-content');
      if (!cm) fail('未找到编辑器，页面文本：' + snapshot());
      cm.focus();
      const written = document.execCommand('insertText', false, body);
      if (!written) fail('insertText 未生效（编辑器可能未聚焦）');
      await sleep(300);
      if (!(cm.innerText || '').includes('雾港的夜航')) fail('编辑器未接收到文本，实际内容：' + (cm.innerText || '').slice(0, 100));
    });

    let saved = null;
    await step('等待自动保存并回读接口', async () => {
      await sleep(2200); // App 是数据变化后 800ms 落盘，多等一拍更稳
      const j = await fetch('/api/data').then((r) => r.json());
      const p = (j.projects || []).find((x) => x.title === title);
      if (!p) fail('接口里没有这部作品');
      const text = (p.chapters || []).map((c) => c.content || '').join('\n') + (p.draft || '');
      if (!text.includes('雾港的夜航')) fail('正文未落库，章节内容：' + text.slice(0, 120));
      saved = { words: text.replace(/\s/g, '').length, chapters: (p.chapters || []).length };
    });

    await step('界面显示已保存', async () => {
      if (!(document.body.innerText || '').includes('已保存')) fail('侧栏未显示已保存，页面文本：' + snapshot());
    });

    // 大纲页的删章：AI 一生成就是十几章，删不掉等于只增不减。
    // 真 confirm 在隐藏窗口里会挂住整条驱动，所以临时换掉；取消那一档也得验（确认框不是摆设）。
    const notes = [];
    await step('大纲页：不要的章删得掉（取消不删 · 勾选批量删 · 卡面单删）', async () => {
      const realConfirm = window.confirm;
      let answer = false;
      window.confirm = () => answer;
      try {
        await click('大纲', 900);
        const toChapters = await hunt(
          async () => [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '转为章节模式'),
          '空大纲没有「转为章节模式」：' + snapshot(),
        );
        toChapters.click();
        await hunt(async () => (document.querySelectorAll('.ol-card').length === 1 ? true : null), '点「转为章节模式」没长出章节：' + snapshot());

        const all = await hunt(async () => document.querySelector('.batch-check input'), '批量栏没有「全选待写章」');
        all.click();
        const del = await hunt(
          async () => [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '删除选中（1）'),
          '勾上之后没有「删除选中（1）」：' + snapshot(),
        );
        if (del.disabled) fail('勾了章，「删除选中」却还是禁用的');
        del.click();
        await sleep(300);
        if (document.querySelectorAll('.ol-card').length !== 1) fail('确认框按了取消，章却没了：' + snapshot());
        notes.push('取消不删');

        answer = true;
        del.click();
        await hunt(async () => (document.querySelectorAll('.ol-card').length === 0 ? true : null), '批量删完卡片还在：' + snapshot());
        const after = await api();
        const p1 = (after.projects || []).find((x) => x.title === title);
        if ((p1.chapters || []).length !== 0) fail('批量删没落到接口，还剩 ' + (p1.chapters || []).length + ' 章');
        notes.push('批量删');

        // 再长出一章：删空之后按钮是重建的 DOM，拿旧引用点不动
        const again = await hunt(
          async () => [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '转为章节模式'),
          '删空之后没回到「转为章节模式」：' + snapshot(),
        );
        again.click();
        await hunt(async () => (document.querySelectorAll('.ol-card').length === 1 ? true : null), '再转一次没长出章节');
        const oneDel = await hunt(async () => document.querySelector('.ol-card .ol-del'), '卡面上没有删章按钮');
        oneDel.click();
        await hunt(async () => (document.querySelectorAll('.ol-card').length === 0 ? true : null), '卡面单删没生效：' + snapshot());
        notes.push('卡面单删');
      } finally {
        window.confirm = realConfirm;
      }
    });

    // 章节模式下顶部那个输入框绑的是「本章标题」，书名曾经没有任何入口能改
    await step('章节模式下书名改得动（点顶部书名→输入→回车）', async () => {
      const crumb = await hunt(async () => document.querySelector('button.proj-crumb'), '章节模式顶部没有可点的书名：' + snapshot());
      if ((crumb.innerText || '').trim() !== title) fail('书名显示不对：' + JSON.stringify(crumb.innerText));
      crumb.click();
      const box = await hunt(async () => document.querySelector('input.proj-crumb-edit'), '点了书名没变成输入框：' + snapshot());
      if (box.value !== title) fail('输入框没预填当前书名：' + JSON.stringify(box.value));
      const renamed = title + '改名';
      setInput(box, renamed);
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await hunt(async () => (!document.querySelector('input.proj-crumb-edit') ? true : null), '按了回车输入框没收起来：' + snapshot());
      await hunt(async () => {
        const j = await api();
        return (j.projects || []).some((p) => p.title === renamed) ? true : null;
      }, '改名没落库：' + JSON.stringify(((await api()).projects || []).map((p) => p.title)));
      const after = await api();
      const p = (after.projects || []).find((x) => x.title === renamed);
      if ((p.chapters || []).some((c) => c.title === renamed)) fail('改书名把章标题也改了');
      notes.push('书名可改');
    });

    // 切章不带走上一章的选区：不然「润色所选 / 替换所选」会按上一章的偏移量改新章的正文
    await step('切章后选区清空（需要选区的按钮重新禁用）', async () => {
      const toChapters = await hunt(
        async () => [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '转为章节模式'),
        '空大纲没有「转为章节模式」：' + snapshot(),
      );
      toChapters.click();
      await click('写作', 700); // 「转为章节模式」不切模式，编辑器在「写作」页里
      await hunt(async () => document.querySelector('.cm-content'), '章节模式没进编辑器：' + snapshot());
      await click('写作', 700);
      const addBtn = await hunt(
        async () => [...document.querySelectorAll('.chap-side-head button')].find((b) => (b.title || '') === '新建章节'),
        '章节栏没有「新建章节」：' + snapshot(),
      );
      addBtn.click();
      await hunt(async () => (document.querySelectorAll('.chap-item').length === 2 ? true : null), '没加到两章：' + snapshot());
      // 第一章写一段并全选：需要选区的动作该解禁（窄窗口下没有选区指示器，直接看按钮）。
      // CodeMirror 不认 DOM 选区，全选走它自己的键位（Ctrl+A = selectAll，合成 keydown 它照收）
      const polishBtns = () => [...document.querySelectorAll('button')].filter((b) => (b.title || '').startsWith('润色所选'));
      const cm1 = await hunt(async () => document.querySelector('.cm-content'), '编辑器没了');
      cm1.focus();
      if (!document.execCommand('insertText', false, '第一章要有一段能选中的正文，好让选区有东西可指。')) fail('insertText 没进编辑器');
      await sleep(300);
      cm1.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true, cancelable: true }));
      await hunt(
        async () => (polishBtns().length && polishBtns().some((b) => !b.disabled) ? true : null),
        '全选后「润色所选」没有解禁：' + polishBtns().map((b) => 'disabled=' + b.disabled).join(',') + '｜' + snapshot(),
      );
      // 切到第二章：选区该清空，需要选区的按钮该重新禁用
      const items = [...document.querySelectorAll('.chap-item')];
      items[1].click();
      await hunt(
        async () => (polishBtns().length && polishBtns().every((b) => b.disabled) ? true : null),
        '切章后「润色所选」仍可点——上一章的选区还在生效：' + polishBtns().map((b) => 'disabled=' + b.disabled).join(','),
      );
      notes.push('切章清选区');
    });

    return { ok: true, summary: `《${title}》落库 ${saved.words} 字 / ${saved.chapters} 章，界面已保存 · ${notes.join(' · ')}`, title, trace };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err), trace, page: snapshot() };
  }
})()
