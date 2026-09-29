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

    await step('导入侧：库里的原创笔记认得出来，属性区不进灵感库，来源与「已导入」看得见', async () => {
      await click('灵感库', 800);
      await click('从 Obsidian 导入', 900);
      const panel = await hunt(async () => document.querySelector('.obsidian-panel'), '导入面板没开：' + snapshot());
      const search = panel.querySelector('input.search') || panel.querySelector('input');
      const type = (v) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(search, v);
        search.dispatchEvent(new Event('input', { bubbles: true }));
      };
      // 我方导出的那一篇：该沉在下面并明说是镜像
      type('第1章');
      const mirror = await hunt(async () => [...panel.querySelectorAll('.obs-item')].find((r) => (r.innerText || '').includes('第1章 到港')), '列表里找不到导出的那一章：' + panel.innerText.slice(0, 160));
      if (!/工作台导出/.test(mirror.innerText || '')) fail('同步产物没被标出来：' + (mirror.innerText || '').replace(/\s+/g, ' '));
      type('码头听来');
      const mine = await hunt(async () => [...panel.querySelectorAll('.obs-item')].find((r) => (r.innerText || '').includes('码头听来的')), '库里的原创笔记没被列出来：' + panel.innerText.slice(0, 160));
      if (/工作台导出/.test(mine.innerText || '')) fail('别人的笔记被误标成工作台导出');
      mine.click();
      // 选完就该看到路径、属性区被剥掉的说明，预览里没有 tags: 那几行
      const detail = await hunt(async () => {
        const el = panel.querySelector('.obs-content');
        return el && /守时/.test(el.textContent || '') ? el : null;
      }, '预览里没出现笔记正文：' + (panel.querySelector('.obs-content')?.textContent || '').slice(0, 80));
      if (/tags:|cssclasses/.test(detail.textContent || '')) fail('属性区漏进了预览：' + (detail.textContent || '').slice(0, 80));
      if (!/素材\/码头听来的\.md/.test(panel.querySelector('.obs-path')?.textContent || '')) fail('没告诉你要导的是哪个路径：' + (panel.querySelector('.obs-path')?.textContent || '（无）'));
      const btn = [...panel.querySelectorAll('button')].find((b) => (b.innerText || '').includes('导入到灵感库'));
      if (!btn) fail('导入按钮不见了');
      if (/镜像/.test(btn.innerText)) fail('原创笔记不该被当成镜像：' + btn.innerText);
      btn.click();
      const card = await hunt(async () => [...document.querySelectorAll('.idea-card')].find((c) => /守时/.test(c.innerText || '')), '导入后灵感库里没出现这张卡：' + snapshot());
      const src = (card.querySelector('.idea-src')?.textContent || '').trim();
      if (!/素材\/码头听来的\.md/.test(src)) fail('卡上没记来源路径：' + src);
      got += ` · 已导入并记下来源 ${src}`;
      // 再开一次面板：同一篇该报「已导入 1 条」，按钮也跟着说实话
      await click('从 Obsidian 导入', 900);
      const again = await hunt(async () => document.querySelector('.obsidian-panel'), '面板没重开');
      const box2 = again.querySelector('input.search') || again.querySelector('input');
      const type2 = (v) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(box2, v);
        box2.dispatchEvent(new Event('input', { bubbles: true }));
      };
      type2('码头听来');
      const row2 = await hunt(async () => [...again.querySelectorAll('.obs-item')].find((r) => /已导入 1 条/.test(r.innerText || '')), '重开面板没报出「已导入 1 条」：' + again.innerText.slice(0, 160));
      row2.click();
      const btn2 = await hunt(async () => [...again.querySelectorAll('button')].find((b) => /再导一条/.test(b.innerText || '')), '按钮没说实话（看不出这篇导过）：' + again.innerText.slice(-120));
      got += ` · 重复导入看得见（${btn2.innerText.trim()}）`;
      // 收起面板：那是个只有图标的按钮，按 title 找，别按文字
      again.querySelector('.obs-head button[title="关闭"]').click();
      await hunt(async () => (!document.querySelector('.obsidian-panel') ? true : null), '点了关闭，面板还挂着');
    });

    await step('④ 落点可选：同一篇笔记能变成设定卡、并进某一章的要点', async () => {
      const setVal = (el, v, proto) => {
        Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, v);
        el.dispatchEvent(new Event(proto === HTMLInputElement ? 'input' : 'change', { bubbles: true }));
      };
      const chip = (scope, t) => [...scope.querySelectorAll('button.chip')].find((b) => (b.innerText || '').trim() === t);
      const primary = (scope) => [...scope.querySelectorAll('button.btn.primary')].pop();
      const openOn = async () => {
        await click('从 Obsidian 导入', 900);
        const p = await hunt(async () => document.querySelector('.obsidian-panel'), '导入面板没重开');
        setVal(p.querySelector('input.search'), '码头听来', HTMLInputElement);
        const row = await hunt(async () => [...p.querySelectorAll('.obs-item')].find((r) => (r.innerText || '').includes('码头听来的')), '列表里找不到那篇笔记');
        row.click();
        await hunt(async () => (/守时/.test(p.querySelector('.obs-content')?.textContent || '') ? true : null), '预览没出正文');
        return p;
      };

      // 设定卡：作品下拉 + 可改名的「叫作」+ 按钮跟着改口
      const a = await openOn();
      chip(a, '设定卡').click();
      const proj = await hunt(async () => a.querySelector('select.obs-pick'), '选了「设定卡」却没出现作品下拉');
      if (proj.options.length < 2) fail('作品下拉是空的：' + [...proj.options].map((o) => o.text).join('|'));
      setVal(proj, proj.options[1].value, HTMLSelectElement);
      const named = await hunt(async () => a.querySelector('label.obs-named input'), '没有「叫作」输入框');
      if ((named.value || '') !== '码头听来的') fail('卡名没预填成文件名：' + JSON.stringify(named.value));
      setVal(named, '码头传闻', HTMLInputElement);
      const go1 = await hunt(async () => (/建成设定卡「码头传闻」/.test(primary(a).innerText || '') ? primary(a) : null), '按钮没说实话：' + primary(a).innerText);
      go1.click();
      const w = await hunt(async () => {
        const j = await api();
        return (j.projects[0].worldItems || []).find((x) => x.name === '码头传闻') || null;
      }, '设定卡没落库');
      if (!/守时/.test(w.content || '')) fail('卡里没有笔记正文：' + JSON.stringify(w.content || '').slice(0, 80));
      if (/tags:|cssclasses/.test(w.content || '')) fail('属性区跟着进了卡：' + w.content.slice(0, 60));
      if (w.kind !== '设定') fail('卡类型不对：' + w.kind);
      const rc = await hunt(async () => ((document.querySelector('.import-msg')?.innerText || '').includes('码头传闻') ? document.querySelector('.import-msg').innerText : null), '落库后没给一句回执（要的是 .import-msg 那行）');
      got += ' · ' + rc.replace(/\s+/g, ' ').trim();

      // 并入章要点：要点是短行，所以带来源前缀、压成一行，且不动正文
      const b = await openOn();
      chip(b, '并入章要点').click();
      const sels = await hunt(async () => (b.querySelectorAll('select.obs-pick').length >= 2 ? [...b.querySelectorAll('select.obs-pick')] : null), '没出现章节下拉');
      setVal(sels[0], sels[0].options[1].value, HTMLSelectElement);
      const chSel = sels[1];
      await hunt(async () => (chSel.options.length > 1 ? true : null), '章下拉是空的');
      const target0 = await api();
      const firstCh = target0.projects[0].chapters[0];
      setVal(chSel, [...chSel.options].find((o) => o.value === firstCh.id).value, HTMLSelectElement);
      const go2 = await hunt(async () => (/并进/.test(primary(b).innerText || '') ? primary(b) : null), '按钮没改成「并进…」：' + primary(b).innerText);
      if (!new RegExp(firstCh.title || '章').test(go2.innerText)) fail('按钮没说并进哪一章：' + go2.innerText);
      go2.click();
      const c1 = await hunt(async () => {
        const j = await api();
        const c = j.projects[0].chapters.find((x) => x.id === firstCh.id);
        return /〔库·码头听来的〕/.test(c.beats || '') ? c : null;
      }, '要点没并进那一章');
      if (!/守时/.test(c1.beats)) fail('要点里没有笔记内容：' + c1.beats.slice(0, 80));
      if (/\n\n/.test(c1.beats)) fail('并进要点的笔记该压成一行，不该留空行：' + JSON.stringify(c1.beats));
      if (c1.content !== firstCh.content) fail('并进要点顺带改了正文：' + JSON.stringify(c1.content).slice(0, 80));
      got += ' · 并进章要点（正文未动）';

      // 「新章节」这一档：单篇草稿的书必须挡住——一旦为它建章，那篇 draft 就没有显示的地方面且切不回去
      const c = await openOn();
      chip(c, '新章节').click();
      const sels3 = await hunt(async () => (c.querySelector('select.obs-pick') ? [...c.querySelectorAll('select.obs-pick')] : null), '选「新章节」没出现作品下拉');
      setVal(sels3[0], 'ob2', HTMLSelectElement);
      const why = await hunt(
        async () => [...c.querySelectorAll('.obs-hint')].find((x) => /切回去/.test(x.innerText || '')),
        '选了单篇那本书却没说明为什么不能建章：下拉现值=' + sels3[0].value + '｜可选=' + [...sels3[0].options].map((o) => o.value + ':' + o.text).join(',') + '｜提示=' + [...c.querySelectorAll('.obs-hint')].map((x) => x.innerText.slice(0, 40)).join(' / ') + '｜书=' + JSON.stringify((await api()).projects.map((x) => [x.id, x.mode, (x.chapters || []).length])),
      );
      if (!/看不见|没有切回去/.test(why.innerText)) fail('理由没说清后果：' + why.innerText.replace(/\s+/g, ' '));
      const go3 = primary(c);
      if (!go3.disabled) fail('理由给了、按钮却还能点');
      const before3 = await api();
      const draft3 = (before3.projects.find((p) => p.id === 'ob2') || {}).draft || '';
      if (!draft3) fail('夹具里那本单篇稿该有正文：' + JSON.stringify(before3.projects.map((p) => p.id)));

      // 换成本来就有章的书：同样的动作就该放行，并且新章末尾一字不差是这篇笔记
      setVal(sels3[0], 'ob1', HTMLSelectElement);
      const go4 = await hunt(async () => (/新建章节/.test(primary(c).innerText || '') && !primary(c).disabled ? primary(c) : null), '换成按章的书之后还是不能下单');
      go4.click();
      const grown = await hunt(async () => {
        const j = await api();
        const ps = (j.projects || []).find((p) => p.id === 'ob1');
        return (ps.chapters || []).find((x) => x.title === '码头听来的') || null;
      }, '新章没落库');
      if (!/守时/.test(grown.content || '')) fail('新章正文不是那篇笔记：' + JSON.stringify(grown.content || '').slice(0, 90));
      if (/tags:|cssclasses/.test(grown.content)) fail('属性区跟着进了章：' + grown.content.slice(0, 60));
      const still = await api();
      const ob2 = (still.projects || []).find((p) => p.id === 'ob2');
      if ((ob2.chapters || []).length) fail('被挡住那次还是给单篇书建了章');
      if (ob2.mode !== 'single') fail('单篇书的 mode 被动了：' + ob2.mode);
      got += ' · 新章节：单篇挡住、按章放行';
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
