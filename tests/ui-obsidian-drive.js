// Obsidian 冒烟的渲染进程部分：只走作者会走的那条路——同步按钮、冲突面板点边、
// 再推一次时保住他加的属性、设置页回填、项目列表「全部同步」。
// 库里的文件由 tests/ui-obsidian-smoke.mjs 在阶段一改好（换写法 + 加别名 + 追加正文），这里不碰磁盘。
(async () => {
  // sleep/trace/fail/step/btns/has/click/read/snapshot/hunt（等全部等待类）都在 ui-drive-helpers.js，
  // 由冒烟脚本拼在本文件前面；这里只留 Obsidian 冒烟自己的小件。
  const note = async (rel) => (await (await fetch('/api/obsidian/note?path=' + encodeURIComponent(rel))).json()).content || '';
  const msg = () => (document.querySelector('.sync-msg')?.innerText || '').replace(/\s+/g, ' ').trim();
  const cm = () => document.querySelector('.cm-content');
  const body = () => (cm().innerText || '').replace(/\s+/g, ' ');
  const typeIn = async (text) => {
    cm().focus();
    if (!document.execCommand('insertText', false, text)) fail('insertText 没进编辑器');
    await sleep(1500); // 800ms 防抖落盘，多等一拍
  };
  const REL = '工作台/雾港/章节/第1章 到港.md';
  let got = '';
  try {
    const j0 = await api();
    if (!j0.obsidian?.vaultPath) fail('接口没带出库路径：' + JSON.stringify(j0.obsidian));

    await step('写作页认得库：头部该有「同步」按钮', async () => {
      await click('创作项目');
      const row = await hunt(async () => [...document.querySelectorAll('button, tr, li, .proj-row')].find((r) => (r.innerText || '').includes('雾港')), '项目列表里那本书');
      row.click();
      await sleep(1000);
      await hunt(async () => (has('同步').length ? true : null), '写作页没有「同步」按钮（库路径没被认出来）：' + snapshot());
      if (!cm()) fail('没进写作页的编辑器');
    });

    await step('两边都改过：报冲突，判定之前不动库里的文件', async () => {
      await typeIn('工作台补的一句。');
      has('同步')[0].click();
      const panel = await hunt(async () => document.querySelector('.sync-conflicts'), '两边都改了却没弹冲突面板：' + msg());
      const pt = (panel.innerText || '').replace(/\s+/g, ' ');
      if (!/^1 处两边都改过/.test(pt)) fail('冲突该只有 1 处（另一篇只是换了写法，不算改动）：' + pt.slice(0, 180));
      if (!pt.includes('第1章 到港.md')) fail('面板没列出是哪一篇：' + pt.slice(0, 160));
      const v = await note(REL);
      if (!/船没有来/.test(v)) fail('判定之前不许动库里的文件：' + v.slice(0, 140));
      if (/工作台补的一句/.test(v)) fail('未判定的冲突被自动推出去了');
      got = '冲突 1 处、判定前不覆盖';
    });

    await step('选「用 Obsidian 那版」：库里那版进编辑器并落库，我们那句被放弃', async () => {
      const row0 = document.querySelector('.sync-conflicts .sc-row');
      const btn = [...row0.querySelectorAll('button')].find((b) => (b.innerText || '').includes('用 Obsidian 那版'));
      if (!btn) fail('冲突行里没有「用 Obsidian 那版」');
      btn.click();
      await hunt(async () => (!document.querySelector('.sync-conflicts') ? true : null), '判定后冲突面板没收起来');
      await hunt(async () => (/船没有来/.test(body()) ? true : null), '编辑器没跟到库那一版：' + body().slice(0, 140));
      if (/工作台补的一句/.test(body())) fail('选了库那一版，工作台那句还留在编辑器里：' + body().slice(0, 160));
      // 界面上已经跟到了库那一版；落库要等 800ms 防抖的 PUT，等它
      await hunt(async () => {
        const x = await api();
        return /船没有来/.test(x.projects[0].chapters[0].content || '') ? true : null;
      }, '拉回的结果没落库（界面更新了，PUT 没跟上）');
    });

    await step('再改一次工作台：这次只有我方变 → 推出去，且他在库里加的别名保住', async () => {
      await typeIn('工作台第二句。');
      has('同步')[0].click();
      const m = await hunt(async () => (/已同步/.test(msg()) ? msg() : null), '第二次同步没回执：' + msg());
      if (/待你判定/.test(m)) fail('只有我方变了，不该再报冲突：' + m);
      await sleep(800);
      const v = await note(REL);
      if (!/工作台第二句/.test(v)) fail('推出去的内容没进库：' + v.slice(0, 200));
      if (!/aliases:/.test(v) || !/老码头/.test(v)) fail('push 把他在库里加的 aliases 抹掉了：' + v.slice(0, 260));
      if (!/船没有来/.test(v)) fail('库里那版正文被覆盖');
      got += ' · 再推保住别名';
    });

    await step('设置页：库路径回填、「在 Obsidian 里打开」在位', async () => {
      await click('设置');
      const box = await hunt(async () => [...document.querySelectorAll('input')].find((i) => /vault/i.test(i.placeholder || '') && i.value), '设置页没回填库路径');
      if (!box.value) fail('库路径回填为空');
      if (!has('在 Obsidian 里打开').length) fail('缺「在 Obsidian 里打开」按钮');
      await click('创作项目');
    });

    await step('项目列表的「全部同步」有回执', async () => {
      const b = await hunt(async () => has('全部同步')[0], '项目列表没有「全部同步」：' + snapshot());
      b.click();
      await hunt(async () => (/已同步 \d+ 本/.test(document.body.innerText || '') ? true : null), '「全部同步」没回执：' + snapshot());
      got += ' · 全部同步有回执';
    });

    await step('导入面板：库里原创笔记认得出来，导出镜像被标出来，来源与「已导入」看得见', async () => {
      await click('灵感库', 800);
      await click('导入', 900);
      const panel = await hunt(async () => document.querySelector('.import-panel'), '导入面板没开：' + snapshot());
      const ontoVaultTab = async (p) => {
        const tab = await hunt(async () => [...p.querySelectorAll('.imp-tab')].find((b) => /Obsidian/.test(b.innerText || '')), '面板里没有 Obsidian 库这一栏');
        tab.click();
        return hunt(async () => p.querySelector('input.search'), '切到库那一栏后搜索框没出来');
      };
      const type = (v, box) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(box, v);
        box.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const close = async (p) => {
        p.querySelector('.imp-head button[title="关闭"]').click();
        await hunt(async () => (!document.querySelector('.import-panel') ? true : null), '点了关闭，面板还挂着');
      };

      // 「读剪贴板」：桌面版走主进程拿系统剪贴板。冒烟脚本先往里塞了 CLIP_MARK，
      // 塞不进去（没有 PowerShell 之类）就退成「点得动、空剪贴板给一句说明」的软断言
      const clipBtn = await hunt(async () => [...panel.querySelectorAll('button')].find((b) => /读剪贴板/.test(b.innerText || '')), '粘贴栏没有「读剪贴板」按钮：' + panel.innerText.slice(0, 200));
      clipBtn.click();
      const clipSay = () => '文本框=' + JSON.stringify((panel.querySelector('.imp-paste')?.value || '').slice(0, 60)) + ' 提示=' + (panel.querySelector('.ai-error')?.innerText || '(无)');
      await hunt(async () => {
        const got2 = panel.querySelector('.imp-paste')?.value || '';
        if (CLIP_MARK) return got2.includes(CLIP_MARK) && panel.querySelector('.imp-row') ? true : null;
        return /剪贴板/.test(panel.querySelector('.ai-error')?.innerText || '') ? true : null;
      }, '点了「读剪贴板」没把剪贴板里的东西读进来：' + clipSay());
      got += CLIP_MARK ? ' · 读剪贴板' : ' · 读剪贴板（空剪贴板给了说明）';

      const search = await ontoVaultTab(panel);      // 我方导出的那一篇：该明说是镜像
      type('第1章', search);
      const mirror = await hunt(async () => [...panel.querySelectorAll('.obs-item')].find((r) => (r.innerText || '').includes('第1章 到港')), '列表里找不到导出的那一章：' + panel.innerText.slice(0, 160));
      if (!/工作台导出/.test(mirror.innerText || '')) fail('同步产物没被标出来：' + (mirror.innerText || '').replace(/\s+/g, ' '));
      type('码头听来', search);
      const mine = await hunt(async () => [...panel.querySelectorAll('.obs-item')].find((r) => (r.innerText || '').includes('码头听来的')), '库里的原创笔记没被列出来：' + panel.innerText.slice(0, 160));
      if (/工作台导出/.test(mine.innerText || '')) fail('别人的笔记被误标成工作台导出');
      mine.click();
      await hunt(async () => (/on/.test(mine.className) ? true : null), '点选之后没标出选中态：' + mine.className);
      const readBtn = await hunt(async () => [...panel.querySelectorAll('button')].find((b) => /读取所选/.test(b.innerText || '')), '没有「读取所选」按钮');
      readBtn.click();
      // 读进来就该看到来源摘要（带来源路径）与拆章预览。注意：剪贴板那一步已经留下一份摘要了，
      // 所以这里要等摘要换成库里那一篇，不能见到 .imp-summary 就当读完
      const sum = await hunt(async () => {
        const el = panel.querySelector('.imp-summary');
        return el && /素材\/码头听来的\.md/.test(el.innerText || '') ? el.innerText : null;
      }, '读完没把来源换成库里那一篇：' + (panel.querySelector('.imp-summary')?.innerText || '(无)'));
      if (!/· obsidian/.test(sum)) fail('摘要没标出这是库里来的：' + sum);
      await hunt(async () => panel.querySelector('.imp-row input.imp-name'), '没有拆出章节行：' + panel.innerText.slice(0, 200));

      // 落到灵感库
      const toIdea = [...panel.querySelectorAll('.imp-choice')].find((b) => (b.innerText || '').trim() === '灵感库');
      if (!toIdea) fail('落点里没有「灵感库」：' + panel.innerText.slice(0, 240));
      toIdea.click();
      const go = await hunt(async () => [...panel.querySelectorAll('button.btn.primary')].pop(), '没有导入按钮');
      if (!/导入到灵感库/.test(go.innerText || '')) fail('按钮没说实话：' + go.innerText);
      go.click();
      const card = await hunt(async () => [...document.querySelectorAll('.idea-card')].find((c) => /守时/.test(c.innerText || '')), '导入后灵感库里没出现这张卡：' + snapshot());
      const src = (card.querySelector('.idea-src')?.textContent || '').trim();
      if (!/素材\/码头听来的\.md/.test(src)) fail('卡上没记来源路径：' + src);
      got += ` · 已导入并记下来源 ${src}`;

      // 再开一次面板：同一篇该报「已导入 1 条」
      await close(panel);
      await click('导入', 900);
      const again = await hunt(async () => document.querySelector('.import-panel'), '面板没重开');
      type('码头听来', await ontoVaultTab(again));
      const row2 = await hunt(async () => [...again.querySelectorAll('.obs-item')].find((r) => /已导入 1 条/.test(r.innerText || '')), '重开面板没报出「已导入 1 条」：' + again.innerText.slice(0, 200));
      row2.click();
      got += ' · 重复导入看得见';
      await close(again);
    });

    await step('落点：设定卡 / 并入章要点 / 追加到已有作品（含单篇草稿）/ 新建作品', async () => {
      const setVal = (el, v, proto) => {
        Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, v);
        el.dispatchEvent(new Event(proto === HTMLInputElement ? 'input' : 'change', { bubbles: true }));
      };
      // 受控 select 写值：React 装在实例上的 setter 会同步 valueTracker、原生 setter 不会，
      // 而 select 的 change 事件是由 getTargetInstForChangeEvent 无条件接的（不查 tracker）——
      // 两条路都写一遍最稳，最后 DOM 与状态一致
      const setSel = (el, v) => {
        el.value = v;
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, v);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const choice = (scope, t) => [...scope.querySelectorAll('.imp-choice')].find((b) => (b.innerText || '').trim() === t);
      const primary = (scope) => [...scope.querySelectorAll('button.btn.primary')].pop();
      const closePanel = async () => {
        const p = document.querySelector('.import-panel');
        if (!p) return;
        p.querySelector('.imp-head button[title="关闭"]').click();
        await hunt(async () => (!document.querySelector('.import-panel') ? true : null), '面板没收起来');
      };
      // 点下单按钮前先确认它没被禁用——被禁用只会「点了没反应」，不查就白跑一轮
      const pick = async (scope, label) => {
        const b = await hunt(async () => {
          const x = primary(scope);
          return x && label.test(x.innerText || '') ? x : null;
        }, '找不到按钮 ' + label + '；现在最后一个 primary 是：' + (primary(scope)?.innerText || '(无)'));
        if (b.disabled) {
          fail(
            '按钮被禁用（' + label + '）：' +
              [...scope.querySelectorAll('.imp-hint, .obs-warn')].map((x) => (x.innerText || '').replace(/\s+/g, ' ')).join(' / ') +
              '｜下拉现值：' +
              [...scope.querySelectorAll('select.obs-pick')].map((s) => s.value + ' of [' + [...s.options].map((o) => o.value).join(',') + ']').join(' | '),
          );
        }
        return b;
      };
      // 点完落点后 DOM 不一定立刻换过来：认准「含目标作品选项」的那一个，
      // 否则会抓到上一个落点残留的「类型」下拉，写进去的 value 直接变成空串
      const pickProject = (scope, id) =>
        hunt(async () => {
          const sel = scope.querySelector('select.obs-pick');
          return sel && [...sel.options].some((o) => o.value === id) ? sel : null;
        }, '落点下拉里没有「' + id + '」：' + [...scope.querySelectorAll('select.obs-pick')].map((s) => '[' + [...s.options].map((o) => o.value).join(',') + ']').join(' '));
      // 每次落点都从「库里那一篇」重新读一遍，状态干净
      const openOn = async (query = '码头听来', match = '码头听来的') => {
        await closePanel();
        await click('导入', 900);
        const p = await hunt(async () => document.querySelector('.import-panel'), '导入面板没重开：' + snapshot());
        const tab = await hunt(async () => [...p.querySelectorAll('.imp-tab')].find((b) => /Obsidian/.test(b.innerText || '')), '没有 Obsidian 栏');
        tab.click();
        const box = await hunt(async () => p.querySelector('input.search'), '搜索框没出来');
        setVal(box, query, HTMLInputElement);
        const row = await hunt(async () => [...p.querySelectorAll('.obs-item')].find((r) => (r.innerText || '').includes(match)), '列表里找不到那篇笔记：' + match);
        row.click();
        const readBtn = await hunt(async () => [...p.querySelectorAll('button')].find((b) => /读取所选/.test(b.innerText || '')), '没有「读取所选」');
        readBtn.click();
        await hunt(async () => (p.querySelector('.imp-row') ? true : null), '没读出内容：' + p.innerText.slice(0, 200));
        return p;
      };

      // ① 设定卡：卡名预填文件名、可改、回执带卡名
      const a = await openOn();
      choice(a, '设定卡').click();
      const proj = await pickProject(a, 'ob1');
      setSel(proj, 'ob1');
      await hunt(async () => (!primary(a).disabled ? true : null), '选了作品 ob1，下单按钮还是禁用：value=' + JSON.stringify(proj.value) + '｜' + [...a.querySelectorAll('.imp-hint, .obs-warn')].map((x) => (x.innerText || '').replace(/\s+/g, ' ')).join(' / '));
      const named = await hunt(async () => a.querySelector('label.obs-named input'), '没有卡名输入框');
      if ((named.value || '') !== '码头听来的') fail('卡名没预填成文件名：' + JSON.stringify(named.value));
      setVal(named, '码头传闻', HTMLInputElement);
      const go1 = await pick(a, /导入并建成设定卡/);
      go1.click();
      const w = await hunt(async () => {
        const j = await api();
        const p1 = (j.projects || []).find((p) => p.id === 'ob1');
        return (p1.worldItems || []).find((x) => x.name === '码头传闻') || null;
      }, '设定卡没落库｜回执=' + (document.querySelector('.imp-receipt')?.innerText || '(无)') + '｜面板提示=' +
        [...document.querySelectorAll('.imp-hint, .obs-warn')].map((x) => (x.innerText || '').replace(/\s+/g, ' ')).join(' / '));
      if (!/守时/.test(w.content || '')) fail('卡里没有笔记正文：' + JSON.stringify(w.content || '').slice(0, 80));
      if (/tags:|cssclasses/.test(w.content || '')) fail('属性区跟着进了卡：' + w.content.slice(0, 60));
      if (w.kind !== '设定') fail('卡类型不对：' + w.kind);
      const rc = await hunt(async () => (/码头传闻/.test(document.querySelector('.imp-receipt')?.innerText || '') ? document.querySelector('.imp-receipt').innerText : null), '落库后没给一句带卡名的回执：' + snapshot());
      got += ' · ' + rc.replace(/\s+/g, ' ').trim();

      // ①b 撤销：只拿回刚导进来的那一张，原有的卡与原文件都留着；撤完面板还能原地再导一遍
      const undoBtn = await hunt(async () => [...document.querySelectorAll('.imp-receipt button')].find((b) => /撤销这次导入/.test(b.innerText || '')), '回执里没有「撤销这次导入」：' + rc);
      undoBtn.click();
      const back = await hunt(async () => {
        const j = await api();
        const p1 = (j.projects || []).find((p) => p.id === 'ob1');
        return (p1.worldItems || []).some((x) => x.name === '码头传闻') ? null : p1;
      }, '撤销后那张设定卡还在库里：' + snapshot());
      if (!(back.worldItems || []).some((x) => x.name === '雾钟')) fail('撤销把原有的卡也带走了：' + JSON.stringify((back.worldItems || []).map((x) => x.name)));
      await hunt(async () => (/已撤销/.test(document.querySelector('.imp-receipt')?.innerText || '') ? true : null), '撤销后回执没说话：' + (document.querySelector('.imp-receipt')?.innerText || '(无)'));
      got += ' · 撤销只拿走自己那张卡';
      const goAgain = await pick(a, /导入并建成设定卡/);
      goAgain.click();
      await hunt(async () => {
        const j = await api();
        const p1 = (j.projects || []).find((p) => p.id === 'ob1');
        return (p1.worldItems || []).find((x) => x.name === '码头传闻') || null;
      }, '撤销之后原地再导一次没成功：' + snapshot());
      got += ' · 撤完原地再导一次';

      // ② 并入章要点：带来源前缀、压成一行、不动正文
      const b = await openOn();
      choice(b, '并入章要点').click();
      const selB = await pickProject(b, 'ob1');
      setSel(selB, 'ob1');
      const chSel = await hunt(async () => {
        const list = [...b.querySelectorAll('select.obs-pick')];
        return list.length >= 2 ? list[1] : null;
      }, '没出现章节下拉：' + [...b.querySelectorAll('select.obs-pick')].length + ' 个下拉');
      await hunt(async () => (chSel.options.length > 1 ? true : null), '章下拉是空的');
      const target0 = await api();
      const firstCh = (target0.projects || []).find((p) => p.id === 'ob1').chapters[0];
      setSel(chSel, firstCh.id);
      const go2 = await hunt(async () => (/并进/.test(primary(b).innerText || '') ? primary(b) : null), '按钮没改成「并进…」：' + primary(b).innerText);
      if (!new RegExp(firstCh.title || '章').test(go2.innerText)) fail('按钮没说并进哪一章：' + go2.innerText);
      go2.click();
      const c1 = await hunt(async () => {
        const j = await api();
        const p1 = (j.projects || []).find((p) => p.id === 'ob1');
        const c = (p1.chapters || []).find((x) => x.id === firstCh.id);
        return c && /〔导入·码头听来的〕/.test(c.beats || '') ? c : null;
      }, '要点没并进那一章');
      if (!/守时/.test(c1.beats)) fail('要点里没有笔记内容：' + c1.beats.slice(0, 80));
      if (/\n\n/.test(c1.beats)) fail('并进要点的笔记该压成一行：' + JSON.stringify(c1.beats));
      if (c1.content !== firstCh.content) fail('并进要点顺带改了正文');
      got += ' · 并进章要点（正文未动）';

      // ③ 单篇草稿：不再挡门——内容拼成一段接在正文末尾，mode 与章结构都不动
      const c = await openOn();
      choice(c, '追加到已有作品').click();
      const sel3 = await pickProject(c, 'ob2');
      setSel(sel3, 'ob2');
      const why = await hunt(async () => [...c.querySelectorAll('.obs-warn')].find((x) => /拼成一段正文/.test(x.innerText || '')), '选了单篇那本书却没说明会怎么落：' + c.innerText.slice(0, 240));
      if (!/接在现有正文末尾/.test(why.innerText)) fail('没说清落法：' + why.innerText);
      const go3 = await pick(c, /^追加 1 章$/);
      go3.click();
      const d2 = await hunt(async () => {
        const j = await api();
        const p1 = (j.projects || []).find((p) => p.id === 'ob2');
        // 这本书一直在，别把「查到了」当「落库了」：等正文里真的多出那句话
        return p1 && /他管那叫守时/.test(p1.draft || '') ? p1 : null;
      }, '单篇草稿没接到正文末尾：' + snapshot());
      if (!/一篇还没分章的短稿/.test(d2.draft || '')) fail('原正文被覆盖了：' + JSON.stringify(d2.draft));
      if (d2.mode !== 'single') fail('单篇书的 mode 被动了：' + d2.mode);
      if ((d2.chapters || []).length) fail('单篇书被塞了章');
      got += ' · 追加到单篇草稿（拼进正文，mode 未动）';

      // ④ 按章的书：追加为新章
      const d = await openOn();
      choice(d, '追加到已有作品').click();
      const sel4 = await pickProject(d, 'ob1');
      setSel(sel4, 'ob1');
      const go4 = await pick(d, /^追加 1 章$/);
      go4.click();
      const grown = await hunt(async () => {
        const j = await api();
        const ps = (j.projects || []).find((p) => p.id === 'ob1');
        return (ps.chapters || []).find((x) => /守时/.test(x.content || '')) || null;
      }, '追加的新章没落库');
      if (!/他管那叫守时/.test(grown.content || '')) fail('新章正文不是那篇笔记：' + JSON.stringify(grown.content || '').slice(0, 90));
      if (/tags:|cssclasses/.test(grown.content)) fail('属性区跟着进了章：' + grown.content.slice(0, 60));
      got += ' · 追加新章到按章的书（' + grown.title + '）';

      // ④b 资料区标题不是章：两卷 + 一份资料，机器该自动把「核心设定」标成转设定
      const wrow = await openOn('晚星大纲', '晚星大纲');
      choice(wrow, '追加到已有作品').click();
      const selW = await pickProject(wrow, 'ob1');
      setSel(selW, 'ob1');
      const rows = await hunt(
        async () => ([...wrow.querySelectorAll('.imp-row')].length === 3 ? [...wrow.querySelectorAll('.imp-row')] : null),
        '晚星大纲没拆成 3 行：' + wrow.innerText.slice(0, 300),
      );
      // 自动标记要在落库按钮的账上看得见：2 章 + 1 张设定卡
      const sheOf = (i) => [...(rows[i]?.querySelectorAll('button') ?? [])].find((b) => (b.innerText || '').trim() === '设');
      await hunt(async () => (/追加 2 章 [++] 1 张设定卡/.test(primary(wrow)?.innerText || '') ? true : null), '核心设定没被自动标成转设定：' + (primary(wrow)?.innerText || '(无)'));
      if (!sheOf(2).className.includes(' on')) fail('第三行没亮「设」');
      if (sheOf(0).className.includes(' on') || sheOf(1).className.includes(' on')) fail('卷被误标了');
      // 人工改判的口子也验一遍：点掉 → 3 章；再点上 → 2 章 + 1 卡
      sheOf(2).click();
      await hunt(async () => (/追加 3 章$/.test(primary(wrow)?.innerText || '') ? true : null), '点掉「设」后账没变：' + (primary(wrow)?.innerText || '(无)'));
      sheOf(2).click();
      await hunt(async () => (/追加 2 章 [++] 1 张设定卡/.test(primary(wrow)?.innerText || '') ? true : null), '再点上后账没变：' + (primary(wrow)?.innerText || '(无)'));
      const goW = await pick(wrow, /追加 2 章 [++] 1 张设定卡/);
      goW.click();
      const wAfter = await hunt(async () => {
        const j = await api();
        const p1 = (j.projects || []).find((p) => p.id === 'ob1');
        const hasCard = (p1.worldItems || []).some((x) => x.name === '核心设定');
        const hasChs = ['卷零《旧厂区》', '卷一《进城》'].every((t) => (p1.chapters || []).some((x) => x.title === t));
        return hasCard && hasChs ? p1 : null;
      }, '「转设定」的行没落成设定卡：' + snapshot());
      if ((wAfter.chapters || []).some((x) => /核心设定/.test(x.title || ''))) fail('资料区标题还是进了章');
      got += ' · 资料行转设定卡';


      // ⑤ 新建作品：书名预填文件名；一整篇没有章名 → 单篇草稿
      const e = await openOn();
      // 「设定卡」落点也有一个 label.obs-named 输入（卡名）——按 placeholder 认准书名框
      const nameBox = await hunt(async () => {
        const el = e.querySelector('label.obs-named input');
        return el && /取文件名|正文首行/.test(el.placeholder || '') ? el : null;
      }, '新建作品没有书名框：' + [...e.querySelectorAll('label.obs-named input')].map((i) => i.placeholder).join('|'));
      if ((nameBox.value || '') !== '码头听来的') fail('书名没预填成文件名：' + JSON.stringify(nameBox.value));
      const go5 = await pick(e, /导入并建成一部作品/);
      go5.click();
      const nb = await hunt(async () => {
        const j = await api();
        return (j.projects || []).find((p) => p.title === '码头听来的') || null;
      }, '新建的作品没落库：' + snapshot());
      if (!/他管那叫守时/.test(nb.draft || '')) fail('新建作品的正文不对：' + JSON.stringify((nb.draft || '').slice(0, 80)));
      if ((nb.chapters || []).length) fail('一整篇没有章名的内容该走单篇草稿，不该硬塞进章');
      if (nb.mode === 'chapters') fail('单篇草稿的 mode 不该是按章：' + nb.mode);
      got += ' · 新建作品（书名取自文件名）';
      await closePanel();
    });

    await step('⑤ 自动同步：默认关着；开了之后停下十二秒自己推、撞上冲突就停手等判定', async () => {
      await click('设置', 900);
      const row = await hunt(
        async () => [...document.querySelectorAll('.rule-row')].find((r) => (r.innerText || '').includes('自动同步到库')),
        '设置页没有「自动同步到库」那条：' + snapshot(),
      );
      const sw = row.querySelector('button.chip');
      if (!sw) fail('那条开关没渲染出来');
      if (!/关闭/.test(sw.innerText)) fail('默认不该是开着：' + sw.innerText);
      if (sw.disabled) fail('库已经配好了，开关还是灰的');
      sw.click();
      await hunt(async () => ((document.body.innerText || '').includes('已开启：写作页停下') ? true : null), '点了开启没回执：' + row.innerText.slice(0, 80));
      got += ' · 开关从关到开';

      await click('创作项目', 700);
      const row2 = await hunt(
        async () => [...document.querySelectorAll('.proj-row, .project-row, tr, li')].find((r) => (r.innerText || '').includes('雾港')),
        '项目列表里找不到那本书：' + snapshot(),
      );
      row2.click();
      await sleep(1100);
      await hunt(async () => (cm() ? true : null), '没回到写作页的编辑器：' + snapshot());
      await typeIn('自动同步该把这句推出去。');
      // 静默期是 12 秒，这里等到 34 秒为止：判的是「有没有自己推」，不是掐秒表
      const m = await hunt(async () => (/自动同步 → 库内/.test(msg()) ? msg() : null), '停下十二秒后没自己推：' + msg(), 34000);
      got += ' · ' + m.replace(/\s+/g, ' ');

      // —— 冲突分支：先打个标记让进程外去改第二章，再在这边改同一章
      await typeIn('自动同步撞车标记');
      // 立刻按 Ctrl+S 落盘：进程外那半在等 projects.json 出现这个标记，别把握手拖到超时
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
      await sleep(1200);
      // 换章要点 .chap-item（那是 div，不是 button）
      const chap = await hunt(
        async () => [...document.querySelectorAll('.chap-item')].find((x) => (x.innerText || '').includes('黑车')),
        '章节栏里没有第二章：' + [...document.querySelectorAll('.chap-item')].map((x) => (x.innerText || '').replace(/\s+/g, ' ')).join('|'),
      );
      chap.click();
      await sleep(1300);
      await typeIn('工作台这边也改了第二章。');
      // 自动那一趟撞上两边都改过：报冲突、列清单，两边都不许被动
      const stop = await hunt(async () => (/待你判定/.test(msg()) ? msg() : null), '撞上冲突却没报「待你判定」：' + msg(), 60000);
      if (!/自动同步/.test(stop)) fail('这句话不是自动那一趟说的：' + stop);
      const panel = await hunt(async () => document.querySelector('.sync-conflicts'), '报了冲突却没列出清单：' + msg());
      if (!(panel.innerText || '').includes('第2章 黑车.md')) fail('清单没说是哪一篇：' + (panel.innerText || '').replace(/\s+/g, ' ').slice(0, 160));
      const disk = await note('工作台/雾港/章节/第2章 黑车.md');
      if (!/库里这一句是撞车时加的/.test(disk)) fail('停手期间还改了库里的文件：' + disk.slice(-120));
      if (/工作台这边也改了/.test(disk)) fail('未判定的冲突被自动推出去了');
      const here = await api();
      if (!/工作台这边也改了/.test(here.projects[0].chapters[1].content || '')) fail('编辑器里的字被自动拉回冲掉了');
      got += ' · 撞冲突停手（两边未动）';

      // 「先不管」只是把清单收起来：下一趟自动同步必须仍然停手，不许趁他看不见把库里的改动推掉
      has('先不管')[0].click();
      await hunt(async () => (!document.querySelector('.sync-conflicts') ? true : null), '点了先不管，清单还挂着');
      await typeIn('收起来之后也不许推。');
      const stop2 = await hunt(async () => (/自动同步停在这里/.test(msg()) ? msg() : null), '收起清单后自动同步照旧推了：' + msg(), 60000);
      if (!/点「同步」把清单再拉出来/.test(stop2)) fail('停手了却没说怎么把清单叫回来：' + stop2);
      const disk2 = await note('工作台/雾港/章节/第2章 黑车.md');
      if (/收起来之后也不许推/.test(disk2)) fail('收起清单后自动把新的改动推进了库');
      got += ' · 收起清单也照样停手';

      // 把清单叫回来、判定，然后两边收到同一版
      await click('同步', 2500);
      const scRow = await hunt(async () => document.querySelector('.sync-conflicts .sc-row'), '点「同步」没把清单再拉出来：' + msg());
      const pick = [...scRow.querySelectorAll('button')].find((b) => (b.innerText || '').includes('用工作台这版'));
      if (!pick) fail('冲突行里没有「用工作台这版」：' + [...scRow.querySelectorAll('button')].map((b) => b.innerText.trim()).join('|'));
      pick.click();
      await hunt(async () => (!document.querySelector('.sync-conflicts') ? true : null), '判定后清单没收起来');
      const after = await hunt(async () => {
        const v = await note('工作台/雾港/章节/第2章 黑车.md');
        return /收起来之后也不许推/.test(v) ? v : null;
      }, '判完工作台这版，库里那篇却没跟上');
      if (/库里这一句是撞车时加的/.test(after)) fail('判定之后库里那版还留着，等于没推');
      if (/待你判定/.test(msg())) fail('判完了还在报待判定：' + msg());
      got += ' · 判完就收口';

    });

    await step('⑤ 切走也不丢：打完字立刻切灵感库，计时器在 App 层照常把最后一段推出去', async () => {
      // 上一个 step 结束时停在第二章（黑车）的编辑器里
      await hunt(async () => (cm() ? true : null), '没回到写作页的编辑器：' + snapshot());
      await typeIn('切走之前留下的这句。');
      // 写完直接切走：侧栏会关掉书，WritingView 整个卸载——计时器不该跟着一起没了
      await click('灵感库', 800);
      // 人已不在写作页：断言只认库里的文件（12 秒静默期发生在灵感库里）
      await hunt(
        async () => ((await note('工作台/雾港/章节/第2章 黑车.md')).includes('切走之前留下的这句。') ? true : null),
        '切到灵感库后最后一段改动没被推出去',
        40000,
      );
      got += ' · 切走后照样推（最后一段不丢）';
    });

    return { ok: true, summary: '客户端接线通过（' + got + '）', trace };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), trace, page: snapshot() };
  }
})()
