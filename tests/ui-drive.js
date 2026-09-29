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

    return { ok: true, summary: `《${title}》落库 ${saved.words} 字 / ${saved.chapters} 章，界面已保存`, title, trace };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err), trace, page: snapshot() };
  }
})()
