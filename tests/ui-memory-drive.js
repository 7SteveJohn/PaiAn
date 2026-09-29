// 出场记忆闭环驱动：在 Electron 渲染进程里执行（由 tests/ui-memory-smoke.mjs 注入）。
// 预置「章节模式 + 待采纳草稿 + 老角色卡」，真实点击：打开作品 → 大纲 → 采纳为正文，
// 等服务端把 AI 抽取的记忆合并写回，回读 /api/data 校验人物卡更新（老角色状态变更 +
// 新角色建档 + 幻觉角色被清洗 + 无关角色不动）。
(async () => {
  // sleep/trace/fail/step/btn/exactBtn/read/snapshot/hunt/poll/present/goneIn 都在
  // ui-drive-helpers.js，由冒烟脚本拼在本文件前面；waitFor 是旧名的兼容桥。
  const waitFor = (fn, cap = 5000, label = '条件') => hunt(fn, label, cap);
  try {
    await step('进入创作项目列表', async () => {
      const nav = exactBtn('创作项目');
      if (!nav) fail('未找到侧栏「创作项目」，页面文本：' + snapshot());
      nav.click();
      await sleep(500);
    });

    await step('打开预置的记忆冒烟作品', async () => {
      const row = await waitFor(
        () => [...document.querySelectorAll('button.proj-row')].find((b) => (b.innerText || '').includes('记忆冒烟')),
        5000,
        '列表出现预置作品'
      );
      row.click();
      await sleep(1000);
      await waitFor(() => exactBtn('大纲'), 5000, '写作页模式切换栏');
    });

    await step('切到大纲视图', async () => {
      exactBtn('大纲').click();
      await sleep(800);
    });

    let debt = '';
    await step('点击「采纳为正文」，顺带核对字数欠账提示', async () => {
      const adopt = await waitFor(
        () => document.querySelector('button[title="用草稿替换本章正文（原正文先存快照）"]'),
        5000,
        '采纳按钮'
      );
      adopt.click();
      await sleep(500);
      // 预置草稿 ~370 字，批量目标默认 1000 字，6 成以下该提一句（能一键关掉）
      const note = document.querySelector('.gate-note');
      if (!note) fail('采纳了不足 6 成的草稿，却没提字数欠账');
      debt = (note.innerText || '').replace(/\s+/g, ' ');
      if (!/只有目标 1000 字的 \d+%/.test(debt)) fail('欠账提示没带上目标与成数：' + debt.slice(0, 80));
      const okBtn = [...note.querySelectorAll('button')].find((b) => (b.innerText || '').includes('知道了'));
      if (!okBtn) fail('欠账提示该能一键关掉');
      okBtn.click();
      await sleep(300);
      if (document.querySelector('.gate-note')) fail('点「知道了」后提示条还在');
      debt = debt.slice(0, 46);
    });

    let verified = null;
    await step('等待记忆抽取写回并回读接口', async () => {
      await sleep(3500); // 抽取(假上游即时) + 合并写回 + 800ms 自动保存
      const j = await fetch('/api/data').then((r) => r.json());
      const p = (j.projects || []).find((x) => (x.title || '').includes('记忆冒烟'));
      if (!p) fail('接口里没有预置作品');

      const chars = p.characters || [];
      const lin = chars.find((c) => c.name === '林越');
      const yun = chars.find((c) => c.name === '雾隐师');
      const he = chars.find((c) => c.name === '阿禾');
      const ghost = chars.find((c) => c.name === '幽灵船长'); // mock 故意给的噪声，必须被清洗

      if (!lin) fail('老角色「林越」卡丢失');
      if (!lin.state || !lin.state.includes('锈纹')) fail('老角色状态未更新，实际 state：' + JSON.stringify(lin.state));
      if (!(lin.log || []).length || lin.log.length < 2) fail('老角色履历未追加，log=' + JSON.stringify(lin.log));

      if (!yun) fail('新角色「雾隐师」未建档');
      if (!(yun.log || []).length) fail('新角色建档但无履历');
      const rel = (yun.relations || [])[0];
      if (!rel || rel.with !== '林越') fail('新角色关系未写入：' + JSON.stringify(yun.relations));

      if (!he) fail('无关角色「阿禾」卡不应丢失');
      if (ghost) fail('幻觉角色「幽灵船长」未被清洗，出现在：' + JSON.stringify(ghost));

      const disk = chars.length;
      verified = {
        disk,
        linLog: lin.log.length,
        linState: lin.state.slice(0, 12) + '…',
        yunLog: yun.log.length,
        rel: rel.with + '：' + rel.note.slice(0, 12) + '…',
      };
    });

    let lazy = '';
    let nameMsg = '';
    let nameMade = '';
    await step('历史快照走懒读：首屏不带快照，面板却列得出来、也能回滚', async () => {
      const j0 = await fetch('/api/data').then((r) => r.json());
      const book0 = (j0.projects || []).find((x) => (x.title || '').includes('记忆冒烟'));
      if (!book0) fail('接口里没有预置作品');
      if (book0.versions || (book0.chapters || []).some((c) => c.versions)) fail('GET /api/data 不该再把快照全文塞回首屏（懒读没生效）');
      exactBtn('写作').click();
      await sleep(600);
      const btn = await waitFor(() => [...document.querySelectorAll('button')].find((b) => /历史版本（[0-9]+）/.test(b.innerText || '')), 5000, '历史版本按钮');
      const n = Number((btn.innerText || '').match(/历史版本（(\d+)）/)[1]);
      if (n < 1) fail('采纳时该留下一份快照，按钮上却是 ' + n);
      btn.click();
      await sleep(400);
      const rows = [...document.querySelectorAll('.versions-panel .version-row')];
      if (rows.length !== n) fail(`面板列出 ${rows.length} 条，与按钮上的 ${n} 对不上`);
      if (!/20[0-9]{2}-/.test(rows[0].innerText || '')) fail('快照行要有时间戳：' + (rows[0].innerText || '').replace(/\s+/g, ' ').slice(0, 50));
      lazy = `懒读 ${n} 条`;
      // 回滚有确认框，隐藏窗口里原生对话框会把脚本卡死——这里直接放行
      const realConfirm = window.confirm;
      window.confirm = () => true;
      try {
        // 快照行里有「对比」「回滚」多个按钮，按文本找回滚那个，别赌行内顺序
        const restoreBtn = [...rows[0].querySelectorAll('button')].find((b) => /回滚/.test(b.innerText || ''));
        if (!restoreBtn) fail('快照行里找不到回滚按钮');
        restoreBtn.click();
      } finally {
        window.confirm = realConfirm;
      }
      const api = () => fetch('/api/data').then((r) => r.json());
      let back = null;
      for (let i = 0; i < 40 && !back; i++) {
        const x = await api();
        const book = (x.projects || []).find((y) => (y.title || '').includes('记忆冒烟'));
        const ch = (book.chapters || [])[0];
        if (ch && !(ch.content || '').trim()) back = x;
        else await sleep(250);
      }
      if (!back) fail('回滚后的空正文没落库');
      await sleep(600);
      const n2 = document.querySelectorAll('.versions-panel .version-row').length;
      if (n2 < n + 1) fail(`回滚本身要留下一份新快照：${n} → ${n2}`);
      // 份数表比正文晚一拍落库（增量 PUT 只发变了的那些）：拿轮询时抓到的旧包断言会随机红
      back = await api();
      const counts = Object.values(back.versionCounts || {}).map(Number);
      if (!counts.some((v) => v >= 2)) fail('首屏份数表没体现回滚后的快照：' + JSON.stringify(back.versionCounts));
      lazy += ` → 回滚后 ${n2} 条`;
    });

    await step('取名面板：换一批、钉住、建卡落库，并且真的避开已有名', async () => {
      const chars0 = ((await read()).projects[0].characters || []).length;
      btn('素材抽屉').click();
      await sleep(500);
      exactBtn('取名').click();
      const panel = await present('.names-panel', '抽屉里的取名面板');
      const items = () => [...panel.querySelectorAll('.np-item')];
      const names = () => items().map((i) => (i.querySelector('.np-name')?.innerText || '').trim());
      if (names().length < 6) fail('一批至少出 6 个候选，实际 ' + names().length);
      const before = names().join(',');
      const roll = [...panel.querySelectorAll('button')].find((b) => (b.innerText || '').includes('换一批'));
      roll.click();
      await sleep(400);
      if (names().join(',') === before) fail('换了种子却没换内容');
      // 钉住第一个，再直接给第二个建卡
      const picked = names()[0];
      const direct = names()[1];
      items()[0].querySelector('.mini-btn').click();
      await present('.np-pinbar', '钉住条');
      const mk = [...items()[1].querySelectorAll('button')].find((b) => (b.innerText || '').includes('建卡'));
      mk.click();
      await sleep(400);
      const commitBtn = [...panel.querySelectorAll('button')].find((b) => /把钉住的/.test(b.innerText || ''));
      commitBtn.click();
      // 回执也是异步渲染：等它写出来，别拿 400ms 撞运气
      let msg = '';
      for (let i = 0; i < 24 && !/已建/.test(msg); i++) {
        await sleep(120);
        msg = (panel.querySelector('.np-msg')?.innerText || '').replace(/\s+/g, ' ');
      }
      if (!/已建/.test(msg)) fail('建卡回执没出来：' + JSON.stringify(msg));
      nameMsg = msg.slice(0, 40);
      // 这个文件里的 waitFor 是同步轮询，异步条件得自己循环（否则拿到的是 Promise / null）
      let after = null;
      for (let i = 0; i < 36 && !after; i++) {
        const x = await read();
        const cs = x.projects[0].characters || [];
        if (cs.length === chars0 + 2 && cs.some((c) => c.name === picked) && cs.some((c) => c.name === direct)) after = x;
        else await sleep(250);
      }
      if (!after) fail('两张新人卡没落库');
      const cs = (after.projects[0].characters || []).map((c) => c.name);
      // 已用名要真的进避重表：再猛摇 20 批都不该出现这两个
      for (let i = 0; i < 20; i++) {
        roll.click();
        await sleep(120);
        if (names().some((n) => n === picked || n === direct)) fail(`第 ${i + 1} 批又摇出了已有名`);
      }
      nameMade = `${picked} / ${direct}`;
    });

    let wired = '';
    await step('牵线画布：一键牵线 → 拖动存坐标 → 手牵一条线 → 沿链取用写回要点', async () => {
      exactBtn('牵线').click();
      await sleep(700);
      const canvas = document.querySelector('.gv-canvas');
      if (!canvas) fail('「牵线」模式没画出画布：' + snapshot());
      if (document.querySelectorAll('.gv-node').length) fail('新书的图应该是空的，不该凭空有节点');
      const btnIn = (scope, t) => [...scope.querySelectorAll('button')].find((b) => (b.innerText || '').includes(t));
      const nodes = () => [...document.querySelectorAll('.gv-node')];
      const linkEls = () => [...document.querySelectorAll('.gv-link')];
      btnIn(document.querySelector('.gv-bar'), '一键牵线').click();
      await sleep(600);
      wired = `节点 ${nodes().length} · 线 ${linkEls().length}`;
      if (nodes().length < 6) fail('一键牵线该把 3 章 + 3 人物 + 1 伏笔摆出来，实际 ' + nodes().length);
      if (linkEls().length < 4) fail('推动线 2 条 + 出场线若干 + 伏笔线 1 条，实际 ' + linkEls().length);
      const side = document.querySelector('.gv-side');
      if (!/未收伏笔/.test(side.innerText || '')) fail('侧栏该点名未回收的伏笔：' + (side.innerText || '').replace(/\\s+/g, ' ').slice(0, 90));
      // 先等这一波结果落盘，再取坐标基线——基线若是空的，后面永远比不出差异
      const landed = await poll(async () => {
        const j = await read();
        const ns = ((j.projects[0].graph || {}).nodes || []).filter((n) => n.kind === 'chapter');
        return ns.length >= 3 ? ns : null;
      }, '一键牵线的结果没落库');
      if (landed.some((n) => !Number.isFinite(n.x))) fail('牵完线节点仍无坐标，画布会全堆在左上角：' + JSON.stringify(landed.map((n) => [n.id, n.x])));
      const before = landed.map((n) => [n.id, n.x, n.y]);
      const pe = (el2, type, x, y) => el2.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1 }));
      // 拖动第二章那颗：松手后坐标必须回到磁盘上
      const drag = nodes().find((n) => (n.textContent || '').includes('第二章'));
      const from = drag.getBoundingClientRect();
      pe(drag, 'pointerdown', from.x + from.width / 2, from.y + from.height / 2);
      pe(canvas, 'pointermove', from.x + from.width / 2 + 96, from.y + from.height / 2 + 58);
      await sleep(90); // 先让 React 把 setDragPos flush 出来，松手时才拿得到新位置
      pe(canvas, 'pointerup', from.x + from.width / 2 + 96, from.y + from.height / 2 + 58);
      const moved = await poll(async () => {
        const j = await read();
        const now = ((j.projects[0].graph || {}).nodes || []).map((n) => [n.id, n.x, n.y]);
        const diff = now.find(([id, x, y]) => {
          const o = before.find(([oid]) => oid === id);
          return o && (o[1] !== x || o[2] !== y);
        });
        return diff ? diff : null;
      }, '拖动后的坐标没落库');
      wired += ` · 拖动存坐标 ${moved[0]}→(${moved[1]},${moved[2]})`;
      // 手牵一条：从第一章的输出点拖到第三章
      const beforeLinks = linkEls().length;
      const a = nodes().find((n) => (n.textContent || '').includes('第一章'));
      const b = nodes().find((n) => (n.textContent || '').includes('第三章'));
      const port = a.querySelector('.gv-port').getBoundingClientRect();
      const bBox = b.getBoundingClientRect();
      pe(a.querySelector('.gv-port'), 'pointerdown', port.x + 3, port.y + 3);
      pe(canvas, 'pointermove', bBox.x + bBox.width / 2, bBox.y + bBox.height / 2);
      await sleep(90);
      pe(b, 'pointerup', bBox.x + bBox.width / 2, bBox.y + bBox.height / 2);
      await sleep(400);
      if (linkEls().length !== beforeLinks + 1) fail(`手牵一条线后应从 ${beforeLinks} 条变成 ${beforeLinks + 1} 条，实际 ${linkEls().length}`);
      wired += ' · 手牵 +1';
      // 选中第三章 → 沿链取用 → 写回本章要点
      pe(b, 'pointerdown', bBox.x + 6, bBox.y + 6);
      pe(canvas, 'pointerup', bBox.x + 6, bBox.y + 6);
      await sleep(500);
      const ctx = side.querySelector('.gv-ctx');
      if (!ctx || !/【落点】/.test(ctx.textContent || '')) fail('选中章点后没给沿链取用的上下文：' + (ctx ? String(ctx.textContent).slice(0, 60) : '（无）'));
      if (!/第一章|第二章/.test(ctx.textContent || '')) fail('上下文里该有链上前章：' + String(ctx.textContent).slice(0, 80));
      btnIn(side, '写进本章要点').click();
      await poll(async () => {
        const j = await read();
        const c = (j.projects[0].chapters || []).find((x) => (x.title || '').includes('第三章'));
        return c && /牵线：/.test(c.beats || '') ? true : null;
      }, '写回本章要点没落库');
      wired += ' · 已写回要点';
    });

    await step('演一遍：镜头一拍拍走、其余压暗、字幕不遮画布，Esc 说停就停', async () => {
      const bar = document.querySelector('.gv-bar');
      const inBar = (t) => [...bar.querySelectorAll('button')].find((b) => (b.innerText || '').includes(t));
      const narr = () => document.querySelector('.gv-narr');
      const cam = () => (document.querySelector('.gv-world') || { getAttribute: () => '' }).getAttribute('style') || '';
      const read = async () => (await fetch('/api/data')).json();
      const play = inBar('演一遍');
      if (!play) fail('工具条上没有「演一遍」：' + [...bar.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).join('|'));
      play.click();
      const first = await hunt(async () => narr(), '点了演一遍，4s 内没出字幕条：' + snapshot(), 4000);
      const text = () => (narr()?.innerText || '').replace(/\s+/g, ' ');
      const total = Number((text().match(/\/ *(\d+)/) || [])[1]);
      const chapters = (await read()).projects[0].chapters.length;
      if (total !== chapters) fail(`剧本该 ${chapters} 拍（一章一拍），实际 ${total}：${text()}`);
      if (!/第 1 \//.test(text()) || !/第一章/.test(text())) fail('字幕条要报现在是第几拍、哪一章：' + text());
      if (document.querySelectorAll('.gv-node.now').length !== 1) fail('当前节点只许描一个金：' + document.querySelectorAll('.gv-node.now').length);
      const all = document.querySelectorAll('.gv-node').length;
      const dimmed = document.querySelectorAll('.gv-node.dim').length;
      if (all < 5 || dimmed !== all - 1) fail(`其余节点都该压暗：${dimmed}/${all}`);
      // 字幕条占流里的一行，不许压在画布上——盖住节点就是盖住内容
      const nb = first.getBoundingClientRect();
      const cb = document.querySelector('.gv-canvas').getBoundingClientRect();
      const area = Math.max(0, Math.min(nb.bottom, cb.bottom) - Math.max(nb.top, cb.top)) * Math.max(0, Math.min(nb.right, cb.right) - Math.max(nb.left, cb.left));
      // 1px² 以内是亚像素贴边（浮点取整噪音），真压住是几十上百 px²——别为渲染噪音误报
      if (area > 1) fail(`字幕条压住画布 ${Math.round(area)}px²：narr=${Math.round(nb.top)}-${Math.round(nb.bottom)} canvas=${Math.round(cb.top)}-${Math.round(cb.bottom)}`);
      if (cb.height < 300) fail(`为了放字幕把画布压到 ${Math.round(cb.height)}px，太矮`);
      const cam1 = cam();
      const side = () => document.querySelector('.gv-side');
      const inSide = (t) => [...side().querySelectorAll('button')].find((b) => (b.innerText || '').includes(t));
      inSide('下一拍').click();
      await hunt(async () => (/第 2 \//.test(text()) ? true : null), '点下一拍没走下去：' + text());
      if (cam() === cam1) fail('镜头没动：播放时画面该跟着这一拍走');
      const spd = document.querySelector('.gv-speed');
      if (!spd) fail('播放时工具条该有每拍时长的选择器');
      spd.value = '1500';
      spd.dispatchEvent(new Event('change', { bubbles: true }));
      const auto = await hunt(async () => {
        const n = Number((text().match(/第 (\d+) \//) || [])[1]);
        return n >= 3 ? n : null;
      }, '换成最快后 6s 没见自己前进', 6000);
      const at = auto;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await hunt(async () => (narr() ? null : true), 'Esc 之后 4s 字幕条还在，说明没真停', 4000);
      if (document.querySelectorAll('.gv-node.now, .gv-node.dim').length) fail('停下后还留着描金与压暗');if (document.querySelectorAll('.gv-node.now, .gv-node.dim').length) fail('停下后还留着描金与压暗，看着像还在演');
      wired += ` · 演 ${total} 拍，自动走到第 ${at} 拍`;
    });

    let layout = '';
    await step('布局回归：窄窗口正文不被挤扁，工坊退成图标竖栏', async () => {
      document.querySelectorAll('.mode-seg button')[0].click();
      await sleep(700);
      // 先把可能开着的面板收回，量到的才是「纯写作态」的正文宽度
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await sleep(400);
      const mw = Math.round((document.querySelector('.writer-main') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width);
      // 章节栏与图标竖栏都是 sticky，而它们的包含块是整行——一旦哪天又允许换行，
      // 粘住的侧栏会一路滑下去压在稿纸上。这里滚两段量，重叠面积必须为 0。
      const sc = document.querySelector('.main');
      const hit = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      for (const y of [700, 1600]) {
        sc.scrollTop = y;
        await sleep(250);
        const p = document.querySelector('.paper').getBoundingClientRect();
        for (const s of ['.chap-side', '.ai-strip']) {
          const e = document.querySelector(s);
          if (e && hit(e.getBoundingClientRect(), p) > 0) fail(`滚到 ${y}px 时 ${s} 压在稿纸上（重叠 ${hit(e.getBoundingClientRect(), p)}px²）`);
        }
      }
      sc.scrollTop = 0;
      await sleep(200);
      const narrow = innerWidth < 1440;
      if (narrow) {
        const strip = document.querySelector('.ai-strip');
        if (!strip) fail(`视口 ${innerWidth} 该把工坊退成图标竖栏，却没找到 .ai-strip`);
        if (document.querySelector('.ai-rail')) fail('窄窗口默认就该展开整块面板，它会盖住正文');
        if (strip && strip.querySelectorAll('button').length < 13) fail('图标竖栏少了动作，只剩 ' + strip.querySelectorAll('button').length + ' 个');
        layout = `竖栏 ${strip.querySelectorAll('button').length} 键`;
        document.querySelector('.ai-strip-btn.expand').click();
        await sleep(500);
        const rail = document.querySelector('.ai-rail');
        if (!rail) fail('点展开没浮出工坊面板');
        if (rail && getComputedStyle(rail).position !== 'fixed') fail('窄窗口的工坊面板该浮起来，实际 ' + getComputedStyle(rail).position);
        // 浮层不许盖住稿纸：稿纸右缘必须停在面板左缘之前
        if (rail) {
          const paper = document.querySelector('.paper').getBoundingClientRect();
          const rrail = rail.getBoundingClientRect();
          if (paper.right > rrail.left + 1) fail(`工坊面板盖住了稿纸：paper.right=${Math.round(paper.right)} > rail.left=${Math.round(rrail.left)}`);
          if (paper.width < 260) fail(`面板浮着时稿纸被挤到 ${Math.round(paper.width)}px，太窄`);
          layout += ` · 稿纸浮层下 ${Math.round(paper.width)}px`;
        }
        // 浮层不能赖在正文上：点正文任意处就该收回。
        // 隐藏窗口里浏览器会节流渲染，收回落在哪一帧不稳——等它、并把耗时量出来，而不是掐死 400ms
        document.querySelector('.writer-main').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        // 收回是异步的（退场动画 + 隐藏窗口里被节流的短计时器）：等它真消失，别掐死固定 sleep
        const goneMs = await goneIn('.ai-rail');
        if (goneMs < 0) {
          const stuck = document.querySelector('.ai-rail');
          fail('点面板外面 2.6s 还没收回工坊浮层（类名 ' + String(stuck?.className) + '；没挂 leaving 就是压根没收到点击）');
        }
        layout += ` · 收回 ${goneMs}ms`;
        if (!document.querySelector('.ai-strip')) fail('收回浮层后图标竖栏该回来');
        // 退场不该是「啪」地消失：点 × 之后元素要还挂着 leaving 类把动画播完
        document.querySelector('.ai-strip-btn.expand').click();
        await sleep(400);
        const rail2 = document.querySelector('.ai-rail');
        if (!rail2) fail('第二次展开没浮出面板');
        if (rail2) {
          rail2.querySelector('.rail-close').click();
          await sleep(60);
          const mid = document.querySelector('.ai-rail');
          if (!mid) fail('收起时元素被直接卸载，没有退场动画');
          else if (!/\bleaving\b/.test(String(mid.className))) fail('退场时没挂 leaving 类：' + mid.className);
          await sleep(450);
          if (document.querySelector('.ai-rail')) fail('退场动画播完后仍没卸载');
        }
        // 抽屉是浮层，该有垫底且点垫底就关（前面取名那步可能已经把它开着了）
        if (!document.querySelector('.drawer')) {
          document.querySelector('.drawer-btn').click();
          await sleep(600);
        }
        const drawer = document.querySelector('.drawer');
        if (drawer && getComputedStyle(drawer).position !== 'fixed') fail('窄窗口的抽屉该浮起来，实际 ' + getComputedStyle(drawer).position);
        if (drawer) {
          const pd = document.querySelector('.paper').getBoundingClientRect();
          if (pd.right > drawer.getBoundingClientRect().left + 1) fail(`抽屉盖住了稿纸：paper.right=${Math.round(pd.right)} > drawer.left=${Math.round(drawer.getBoundingClientRect().left)}`);
        }
        const scrim = document.querySelector('.drawer-scrim');
        if (!scrim) fail('窄窗口抽屉没垫底，看不出它压在正文上');
        // 抽屉浮着时竖栏必须整个让位（1244 那档稿纸已缩到保底，露半截会被抽屉压住）
        const stripNow = document.querySelector('.ai-strip');
        if (stripNow && getComputedStyle(stripNow).display !== 'none') fail('抽屉浮着时图标竖栏该让位，实际还占着');
        layout += ' · 浮层可收';
        if (scrim) {
          scrim.click();
          const scrimMs = await goneIn('.drawer-scrim');
          if (scrimMs < 0 || document.querySelector('.drawer')) fail('点垫底没关掉抽屉（垫底 ' + scrimMs + 'ms 没消失）');
          layout += ` · 抽屉收回 ${scrimMs}ms`;
          await sleep(300);
          const back = document.querySelector('.ai-strip');
          if (!back || getComputedStyle(back).display === 'none') fail('抽屉收回后图标竖栏没回来');
        }
      } else if (!document.querySelector('.ai-rail')) {
        fail('宽窗口该照旧并排显示工坊面板');
      }
      if (mw < 400) fail(`正文只剩 ${mw}px（视口 ${innerWidth}），又被挤扁了`);
      layout += ` · 正文 ${mw}px @${innerWidth}`;
    });

    let reviewed = '';
    await step('节律区：琴键一章一格、对白天平如实报归属不明、伏笔利息掉成收线卡', async () => {
      const read3 = async () => {
        const r = await fetch('/api/data');
        const j = await r.json();
        if (!j || !Array.isArray(j.projects)) fail('读 /api/data 失败：' + JSON.stringify(j).slice(0, 120));
        return j;
      };
      const wait3 = async (fn, label, ms = 12000) => {
        const t0 = Date.now();
        for (;;) {
          const v = await fn();
          if (v) return v;
          if (Date.now() - t0 > ms) fail('等待超时：' + label);
          await sleep(250);
        }
      };
      exactBtn('复盘').click();
      const panel2 = () => document.querySelector('.pitch');
      const panel = await wait3(async () => document.querySelector('.pitch'), '复盘栏的节律区（懒加载块）');
      const book0 = (await read3()).projects[0];
      const written = (book0.chapters || []).filter((c) => (c.content || '').trim()).length;
      const bars = panel.querySelectorAll('.pk-bar').length;
      if (written < 3) fail('前面几步该留下至少三章正文，实际 ' + written);
      if (bars !== written) fail(`琴键该一章一格：已写 ${written} 章，画了 ${bars} 格`);
      if (!panel.querySelector('.pk-median')) fail('缺了本书中位句长的基准线');
      const who = [...panel.querySelectorAll('.pk-who')].map((e) => (e.textContent || '').trim());
      reviewed = `琴键 ${bars} 格 · 天平 ${who.join('/')}`;
      if (!who.includes('林越') && !who.includes('阿禾')) fail('天平该列出认得出的说话人：' + JSON.stringify(who));
      if (!/归属不明/.test(panel.innerText || '')) fail('认不出谁说的行该如实报，不该摊给某个角色');
      const debtRows = [...panel.querySelectorAll('.pk-debt')];
      if (!debtRows.length) fail('埋在第 1 章、已写到第 5 章的伏笔该出现在利息里');
      if (!/挂了 \d+ 章 \/ \d+ 字/.test(debtRows[0].textContent || '')) fail('利息要给出挂了多久：' + debtRows[0].textContent.trim());
      const btn = [...panel.querySelectorAll('button')].find((b) => (b.innerText || '').includes('掉成收线卡'));
      if (!btn) fail('有该收的伏笔却没给掉卡按钮');
      btn.click();
      const after = await wait3(async () => {
        const j = await read3();
        const c = ((j.cards || {}).custom || []).find((x) => (x.id || '').startsWith('debt-'));
        return c ? j : null;
      }, '收线卡没落库');
      if (!(after.cards.custom || []).every((x) => !(x.name || '').startsWith('收线：') || x.effect === 'hook')) fail('收线卡该走 hook 效果，才会挂进本章伏笔安排');
      reviewed += ` · 掉卡 ${after.cards.custom.filter((x) => (x.id || '').startsWith('debt-')).length} 张`;
      panel2().querySelectorAll('button').forEach((b) => { if ((b.innerText || '').includes('掉成收线卡')) b.click(); });
      const again = await wait3(async () => {
        const t = [...document.querySelectorAll('.pk-debt-acts .hint')].map((e) => e.textContent || '').join(' ');
        return /已经掉过卡/.test(t) ? t : null;
      }, '重复点掉卡没有幂等回执', 6000);
      if ((await read3()).cards.custom.filter((x) => (x.id || '').startsWith('debt-')).length !== 1) fail('重复点堆了重复卡');
      reviewed += ` · 再点幂等（${again.replace(/\s+/g, ' ').slice(0, 18)}…）`;
    });

    await step('守夜人：复盘栏检出埋进去的境界回退，证据不被省略号吃掉，掉卡幂等', async () => {
      const wait4 = async (fn, label, ms = 12000) => {
        const t0 = Date.now();
        for (;;) {
          const v = await fn();
          if (v) return v;
          if (Date.now() - t0 > ms) fail('等待超时：' + label);
          await sleep(250);
        }
      };
      const wd = await wait4(async () => document.querySelector('.pitch.wd'), '复盘栏里没有守夜人那一屏');
      const read4 = async () => (await (await fetch('/api/data')).json());
      // 夹具在第二章写「金丹」、第三章写「筑基中期」，这里必须报出这一条并带章号
      const rows = [...wd.querySelectorAll('.pk-debt')];
      const hit = rows.find((e) => /金丹/.test(e.textContent || '') && /筑基/.test(e.textContent || ''));
      if (!hit) fail('守夜人没检出埋进去的回退：' + rows.map((r) => (r.textContent || '').replace(/\s+/g, ' ').slice(0, 40)).join(' | '));
      if (!/第2章写到「金丹」，第3章/.test(hit.textContent || '')) fail('回退要说清从哪章掉到哪章：' + (hit.textContent || '').replace(/\s+/g, ' '));
      if (/补一张力量体系卡/.test(wd.innerText || '')) fail('这本书自带力量体系词条，不该再劝建卡');
      if (!/词条/.test(wd.innerText || '')) fail('面板要说清这条境界线来自作者的词条：' + (wd.innerText || '').replace(/\s+/g, ' ').slice(0, 120));
      // 证据要能整行读完：.wd 把 .pk-when 改成换行，横向不许溢出、长句必须占两行以上
      const why = [...wd.querySelectorAll('.pk-when')];
      const clipped = why.filter((e) => e.scrollWidth > e.clientWidth + 1);
      if (clipped.length) fail('有 ' + clipped.length + ' 条证据被省略号吃掉：' + (clipped[0].textContent || '').slice(0, 40));
      // 22px 是两行的临界值，字体渲染微差就翻转——放行到 20px，单行铁定到不了 20
      const tall = why.filter((e) => (e.innerText || '').length > 24 && e.getBoundingClientRect().height > 20).length;
      if (!tall) fail('长证据没换成多行，还是被压成一行了');
      if (document.documentElement.scrollWidth > window.innerWidth + 1) fail('复盘栏撑出了横向滚动：' + document.documentElement.scrollWidth + ' > ' + window.innerWidth);
      const dropBtn = [...wd.querySelectorAll('button')].find((b) => (b.innerText || '').includes('掉成卡'));
      if (!dropBtn) fail('有发现却没给掉卡按钮');
      dropBtn.click();
      const dropped = await wait4(async () => {
        const j = await read4();
        const c = ((j.cards || {}).custom || []).filter((x) => (x.id || '').startsWith('wd-'));
        return c.length ? c : null;
      }, '守夜人的卡没落库');
      if (!dropped.every((x) => x.effect === 'beat' && (x.any || []).length)) fail('守夜人卡该走 beat 效果并带正文检核：' + JSON.stringify(dropped.map((x) => x.id)));
      reviewed = (reviewed || '') + ' · 守夜人 ' + rows.length + ' 条 · 掉卡 ' + dropped.length + ' 张';
      dropBtn.click();
      const again = await wait4(async () => {
        const t = [...document.querySelectorAll('.pk-debt-acts .hint')].map((e) => e.textContent || '').join(' ');
        return /没有可掉的新卡/.test(t) ? t : null;
      }, '再点掉卡没有幂等回执', 6000);
      if ((await read4()).cards.custom.filter((x) => (x.id || '').startsWith('wd-')).length !== dropped.length) fail('重复点堆了重复卡');
      reviewed += ' · 再点幂等';
    });

    return {
      ok: true,
      summary: `记忆闭环通过（快照${lazy}·取名 ${nameMade}·${wired}${layout ? " · " + layout : ""}${reviewed ? " · " + reviewed : ""}）：人物卡 ${verified.disk} 张；林越状态已更新(履历 ${verified.linLog} 条)；雾隐师新建档(履历 ${verified.yunLog} 条，关系 ${verified.rel})；幻觉角色已清洗；采纳欠账提示「${debt}」已核`,
      trace,
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), trace, page: snapshot() };
  }
})()
