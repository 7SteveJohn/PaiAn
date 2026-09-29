// 卡池 UI 驱动脚本：在 Electron 渲染进程里真点一遍抽卡、打出与合成，返回 {ok, summary}。
// 由 tests/ui-gacha-smoke.mjs 注入；失败时把现场信息带在 error/trace 里，方便定位。
// 覆盖：动效层与账本、溢出提示、卡牌效果真的落到落库数据、约束达成率与自动点亮、
// 两卡合成的组合任务与达成后的奖励抽。
// 预置手牌顺序固定为 n01（零条件·要点）→ n02（词表条件）→ x01（句长节奏条件），
// 随机抽到的那张因为进不了满手（3 张）也不会干扰下面的步骤。
(async () => {
  // sleep/trace/fail/step/btns/has/click/read(hunt 等等待类) 都在 ui-drive-helpers.js，
  // 由冒烟脚本拼在本文件前面；waitFor 是旧名的兼容桥——参数序换成 hunt 的，实现只有一份。
  const waitFor = (fn, cap = 9000, label = '条件') => hunt(fn, label, cap);
  const chips = () => [...document.querySelectorAll('.hand-strip .hs-card')];
  const ongoing = () => [...document.querySelectorAll('.hs-ongoing')];
  const names = (list) => list.map((e) => (e.querySelector('b')?.innerText || '').trim());
  const em = (e) => (e.querySelector('em')?.innerText || '').trim();
  const out = {};
  try {
    await step('进入卡池页，钱包与图鉴就位', async () => {
      await click('卡池');
      if (!document.querySelector('.gacha-wallet')) fail('卡池钱包没渲染，页面：' + snapshot());
      const w = (document.querySelector('.gacha-wallet').innerText || '').replace(/\s+/g, ' ');
      if (!/可抽\s*25/.test(w)) fail('预置 25000 净产字应给 25 抽，实际：' + w.slice(0, 90));
      if (!/在手 3 \/ 3/.test(w)) fail('预置三张手牌应显示在手 3/3，实际：' + w.slice(0, 120));
      out.wallet = w.slice(0, 120);
      out.codexGroups = document.querySelectorAll('.gacha-series').length;
    });

    await step('手牌已满时抽一张：不占手牌名额并说明退回图鉴', async () => {
      const owned0 = await api().then((x) => Object.keys(x.gacha.owned));
      await click('抽一张', 150);
      if (!document.querySelector('.gacha-stage')) fail('抽卡后动效层没出现');
      out.flippedAtOnce = document.querySelectorAll('.gacha-card.flipped').length;
      await sleep(1000);
      out.flippedLater = document.querySelectorAll('.gacha-card.flipped').length;
      if (out.flippedLater < 1) fail('卡始终没翻开：' + out.flippedAtOnce + '→' + out.flippedLater);
      out.rarity = (document.querySelector('.gc-front .gc-rarity')?.innerText || '').trim();
      document.querySelector('.gacha-stage').click();
      await sleep(700);
      const flash = (document.querySelector('.gacha-flash')?.innerText || '').replace(/\s+/g, ' ');
      const owned1 = await api().then((x) => Object.keys(x.gacha.owned));
      // 抽到手牌里已有的那三张时不会重复占位，也就不存在「多出一张」，话术必须跟着变
      const pulled = owned1.find((k) => !owned0.includes(k)) ?? '';
      out.pulledDup = pulled === 'n01' || pulled === 'n02' || pulled === 'x01';
      if (out.pulledDup) {
        if (/手牌已满/.test(flash)) fail('抽到手牌里已有的卡，不该说「手牌已满」：' + flash.slice(0, 80));
      } else if (!/手牌已满/.test(flash)) {
        fail('手牌满时应说明多出的卡退回图鉴，实际：' + flash.slice(0, 80));
      }
      const w = (document.querySelector('.gacha-wallet').innerText || '').replace(/\s+/g, ' ');
      if (!/累计抽取\s*1/.test(w)) fail('抽数没进账：' + w.slice(0, 140));
      // 保底计数要跟着这次抽到的稀有度走：抽中 SSR 归零，其余 +1（写死数字会让测试随概率抖）
      const pity = (w.match(/保底进度\s*(\d+)\s*\/\s*30/) || [])[1];
      const expectPity = out.rarity === 'SSR' ? '0' : '1';
      if (pity !== expectPity) fail('保底计数应为 ' + expectPity + '/30（这次抽到 ' + out.rarity + '），实际 ' + pity + '/30：' + w.slice(0, 140));
    });

    await step('去写作页，三张手牌在顶栏', async () => {
      await click('去写作页用卡', 2600);
      out.hand = names(chips());
      if (chips().length !== 3) fail('应有 3 张在手，实际 ' + JSON.stringify(out.hand) + '；页面：' + snapshot());
    });

    await step('合成最左两卡：立成本章任务并显示达成率', async () => {
      await click('合成两卡', 900);
      const c = document.querySelector('.hs-combo');
      if (!c) fail('合成后没挂出组合任务；手牌条：' + names(chips()).join(' | '));
      out.comboName = (c.querySelector('b')?.innerText || '').trim();
      out.comboProgress = em(c);
      if (!/多出来的第三人/.test(out.comboName) || !/一件带不走的东西/.test(out.comboName)) fail('组合名应带上两张卡名：' + out.comboName);
      if (out.comboProgress !== '0/1') fail('一张无条件 + 一张要词表，并完应是 0/1，实际 ' + out.comboProgress);
      const j = await api();
      if (j.gacha.bonusPulls) fail('合成那一刻不该先发奖励：' + JSON.stringify(j.gacha.bonusPulls));
    });

    await step('把组合条件写到位 → 白送一次抽并落库', async () => {
      const cm = document.querySelector('.cm-content');
      if (!cm) fail('没找到编辑器');
      cm.focus();
      if (!document.execCommand('insertText', false, '他把信留在了站台上，没有带走。')) fail('insertText 未生效');
      const j = await waitFor(async () => {
        const x = await api();
        return x.gacha.bonusPulls > 0 ? x : null;
      }, 9000, '组合达成并发放奖励抽');
      out.bonusAfterCombo = j.gacha.bonusPulls;
      const combo = j.projects[0].combo;
      if (!combo || !combo.litAt) fail('组合任务的 litAt 没落到项目里：' + JSON.stringify(combo || null));
      await sleep(900);
      const c = document.querySelector('.hs-combo');
      out.comboStateAfter = c ? (c.querySelector('.hs-text')?.innerText || '').trim() : '（任务条已收起）';
    });

    await step('打出零条件卡：要点追加、落地即点亮', async () => {
      const before = await api();
      const beforeBeats = (before.projects[0].chapters.find((c) => c.id === 'gc1').beats || '').trim();
      chips()[0].querySelector('.hs-play').click();
      await sleep(400);
      out.receiptN01 = (document.querySelector('.hs-msg')?.innerText || '').slice(0, 60);
      const after = await waitFor(async () => {
        const x = await api();
        const b = x.projects[0].chapters.find((c) => c.id === 'gc1').beats || '';
        return b !== beforeBeats ? x : null;
      }, 9000, '要点追加已落库');
      const c1 = after.projects[0].chapters.find((c) => c.id === 'gc1');
      out.beats = c1.beats;
      if (!c1.beats.includes('原有要点')) fail('原有要点被覆盖丢了：' + c1.beats);
      if (!c1.beats.includes('林越')) fail('卡面槽位应从书里取人物名：' + c1.beats);
      if (!after.gacha.lit.n01) fail('零条件卡应落地即点亮，lit=' + JSON.stringify(after.gacha.lit));
    });

    await step('词表卡：正文已写到位时打出去直接点亮', async () => {
      chips()[0].querySelector('.hs-play').click();
      const j = await waitFor(async () => {
        const x = await api();
        return x.gacha.lit.n02 ? x : null;
      }, 9000, 'n02 点亮');
      out.litAfterN02 = Object.keys(j.gacha.lit).sort();
      if (ongoing().some((e) => (e.querySelector('b')?.innerText || '').includes('一件带不走的东西'))) fail('已点亮的卡还挂在手牌条上');
    });

    await step('节奏约束：不达标持续提醒，可以放弃', async () => {
      chips()[0].querySelector('.hs-play').click();
      await sleep(900);
      const ch = ongoing().find((e) => (e.querySelector('b')?.innerText || '').includes('短句行军'));
      if (!ch) fail('打完 x01 后没挂出进行中提示；当前：' + names(ongoing()).join(' | '));
      out.rhythmProgress = em(ch);
      out.rhythmTitle = (ch.getAttribute('title') || '').slice(0, 60);
      if (out.rhythmProgress !== '0/1') fail('预置正文含 20+ 字长句，短句行军应 0/1，实际 ' + out.rhythmProgress);
      ch.querySelector('.icon-btn').click();
      const j = await waitFor(async () => {
        const x = await api();
        return !x.gacha.applied.x01 ? x : null;
      }, 9000, '放弃后 x01 从 applied 消失');
      if (ongoing().some((e) => (e.querySelector('b')?.innerText || '').includes('短句行军'))) fail('放弃后提示条还在');
      out.applied = Object.keys(j.gacha.applied).sort();
    });

    await step('回到卡池拆一本对标书', async () => {
      const sample = [
        '第一章 夜航',
        '「你上错了船。」她说。',
        '他退到栈桥口，看见雾里有三盏灯。',
        '「下去。」她把手收回去。',
        '',
        '第二章 舱单',
        '「这一趟没人回来过。」验货的人说。',
        '他把舱单折成两截，只留下一行。',
        '「烧掉。」她说。',
        '',
        '第三章 铁锈',
        '「你认得这道纹。」她盯着他的手。',
        '他承认自己认得，但不承认在哪见过。',
        '船在身后响了一声，像有人在里面翻身。',
        '',
        '第四章 天亮前',
        '「现在跳还来得及。」她说。',
        '他把最后一盏灯吹灭，水面立刻把光吞干净了。',
        '「来不及了。」他说。',
      ].join('\n');
      await click('卡池', 700);
      const area = document.querySelector('.bench-form textarea');
      const titleInput = document.querySelector('.bench-form input');
      if (!area || !titleInput) fail('卡池页没找到拆文对标的输入区');
      const setVal = (el, v) => {
        Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setVal(titleInput, '夜航对标');
      setVal(area, sample);
      await sleep(200);
      await click('拆开看', 900);
      const rows = [...document.querySelectorAll('.bench-row')];
      if (!rows.some((r) => (r.innerText || '').includes('夜航对标'))) fail('对标书没进列表：' + rows.map((r) => r.innerText.replace(/\s+/g, ' ')).join(' | '));
      out.benchRow = (rows[0].innerText || '').replace(/\s+/g, ' ').slice(0, 90);
      const before = await api();
      const cmp = document.querySelector('.bench-cmp');
      if (!cmp) fail('拆完没出节奏对照表（可能两边章数不够）');
      out.gapRows = [...cmp.querySelectorAll('.bc-row')].map((r) => (r.innerText || '').replace(/\s+/g, ' ').slice(0, 46));
      out.worthRows = [...cmp.querySelectorAll('.bc-row.worth')].length;
      const btn = has('掉成卡')[0];
      if (!btn) fail('有差距但没给出「掉成卡」按钮；对照：' + out.gapRows.join(' / '));
      btn.click();
      await sleep(1600);
      const after = await api();
      out.customCards = after.cards.custom.map((c) => c.name);
      if (!after.cards.custom.length) fail('掉卡没落库到 cards.json');
      if (before.cards.custom.length !== 0) fail('起点不该已有自建卡，实际 ' + before.cards.custom.length);
      await sleep(700);
      out.codexAfter = document.querySelectorAll('.gacha-series').length;
      out.poolRowsAfter = document.querySelectorAll('.pool-row').length;
    });

    await step('笔触漂移：跟自己比也掉卡，卡面是「找回」不是「学它」', async () => {
      const panel = document.querySelector('.self-drift');
      if (!panel) fail('卡池页没有「笔触漂移」面板：' + snapshot());
      const hint = (panel.querySelector('.hint')?.innerText || '').replace(/\s+/g, ' ');
      out.driftHint = hint.slice(0, 60);
      if (!/同一本书的前 3 章/.test(hint)) fail('只有一本书时基准该取本书前段，实际：' + hint);
      const worth = [...panel.querySelectorAll('.bc-row.worth')];
      out.driftWorth = worth.map((r) => (r.innerText || '').replace(/\s+/g, ' ').slice(0, 34));
      if (worth.length < 2) fail('预置前段对白密/末段长句，至少该报出 2 项漂移，实际 ' + worth.length + '：' + out.driftWorth.join(' | '));
      const before = await api();
      if (before.cards.custom.some((c) => (c.name || '').startsWith('找回：'))) fail('起点不该已经有「找回」卡');
      const btn = [...panel.querySelectorAll('button')].find((b) => (b.innerText || '').includes('找回'));
      if (!btn) fail('漂移够大却没给掉卡按钮：' + out.driftWorth.join(' | '));
      btn.click();
      // 回执要等 React 提交，读 DOM 得轮询；落库走 800ms 防抖，同样轮询而不是赌 sleep
      const msg = await waitFor(() => {
        const t = (document.querySelector('.bench-msg')?.innerText || '').replace(/\s+/g, ' ');
        return /找回：/.test(t) ? t : null;
      }, 5000, '「找回」掉卡回执');
      const after = await waitFor(async () => {
        const x = await api();
        return x.cards.custom.some((c) => (c.name || '').startsWith('找回：')) ? x : null;
      }, 9000, '「找回」卡落库');
      out.selfMsg = msg.slice(0, 80);
      const back = after.cards.custom.filter((c) => (c.name || '').startsWith('找回：'));
      if (!back.length) fail('点了却没落库到 cards.json');
      if (back.some((c) => (c.payload || '').includes('《'))) fail('self 卡面不该出现书名号：' + JSON.stringify(back.map((c) => c.payload)));
      if (!back.every((c) => (c.constraints || []).length)) fail('找回卡必须能判达成');
      if (!after.cards.custom.some((c) => (c.name || '').startsWith('学它：'))) fail('拆文对标的「学它」卡被吃掉了');
      btn.click();
      await sleep(500);
      const again = await api();
      if (again.cards.custom.length !== after.cards.custom.length) fail('重复点不该堆重复卡：' + after.cards.custom.length + '→' + again.cards.custom.length);
      out.selfCards = back.map((c) => c.name);
    });

    await step('批量生成前置门禁：缺细纲的章被拦下，补了要点就重算', async () => {
      await click('去写作页', 2600);
      const seg = [...document.querySelectorAll('.mode-seg button')].find((b) => (b.innerText || '').trim() === '大纲');
      if (!seg) fail('没找到「大纲」模式切换；页面：' + snapshot());
      seg.click();
      await sleep(700);
      if (!document.querySelector('.ol-list .ol-card')) fail('大纲卡没渲染：' + snapshot());
      out.thinMarked = document.querySelectorAll('textarea.ol-thin').length;
      if (out.thinMarked !== 2) fail('预置应有 2 章待写且细纲过短被标出，实际 ' + out.thinMarked);
      document.querySelector('.batch-check input').click();
      await sleep(300);
      const run = has('批量生成草稿')[0];
      if (!run) fail('没找到批量生成按钮');
      if (run.disabled) fail('已选章且 AI 默认 ready，批量按钮不该禁用');
      const panel = () => document.querySelector('.gate-panel');
      const read = () => (panel()?.querySelector('.gate-text')?.innerText || '').replace(/\s+/g, ' ');
      const label = () => [...panel().querySelectorAll('button')].map((b) => (b.innerText || '').replace(/\s+/g, ' ').trim());
      const pick = (t) => [...panel().querySelectorAll('button')].find((b) => (b.innerText || '').includes(t));
      run.click();
      await sleep(400);
      if (!panel()) fail('点了批量却没弹出门禁面板：' + snapshot());
      out.gateText = read();
      if (!/2 章没有剧情要点（第2章、第7章/.test(out.gateText)) fail('面板该数出两章缺细纲的：' + out.gateText);
      if (!/正文里有 1 处境界前后不一/.test(out.gateText)) fail('门禁该把守夜人的境界矛盾一并报出来：' + out.gateText);
      const lore = [...(panel()?.querySelectorAll('.gate-lore li') || [])].map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim());
      out.loreRows = lore;
      if (lore.length !== 1 || !/林越：第1章「金丹」→ 第5章「筑基中期」/.test(lore[0])) fail('境界矛盾要单列成行并带章号：' + JSON.stringify(lore));
      if (!/提示词里已经注入/.test(panel().innerText)) fail('面板该说明 AI 拿到的是哪条依据：' + (panel().innerText || '').replace(/\s+/g, ' ').slice(0, 160));
      const onlyBtn = pick('只生成有细纲的');
      if (!onlyBtn || !/1 章/.test(onlyBtn.innerText)) fail('应有「只生成有细纲的 1 章」，实际：' + label().join(' | '));
      const jump = pick('先补第2章要点');
      if (!jump) fail('缺细纲时该给「先补第2章要点」，实际：' + label().join(' | '));
      const box = document.getElementById('ol-beats-gc2');
      if (!box) fail('门禁指到的章没有对应要点输入框');
      jump.click();
      await sleep(200);
      box.focus();
      if (!document.execCommand('insertText', false, '他把手伸进怀里，摸到那张不该在的舱单')) fail('insertText 没进要点输入框');
      await sleep(500);
      run.click();
      await sleep(400);
      if (!panel()) fail('第七章仍缺细纲，不该直接放行');
      out.gateAfter = read();
      if (!/1 章没有剧情要点（第7章/.test(out.gateAfter)) fail('补完第二章后面板该只报第七章：' + out.gateAfter);
      pick('先不生成').click();
      await sleep(300);
      if (panel()) fail('选了「先不生成」后面板还在');
      if (document.getElementById('ol-beats-gc2').classList.contains('ol-thin')) fail('补过要点的章不该还挂着虚线');
      if (!document.getElementById('ol-beats-gc7').classList.contains('ol-thin')) fail('没补的第七章该一直标着虚线');
    });

    await step('守夜人入口：还在吃内置境界表就劝建词条，点一下真建出力量体系卡并立刻改用它', async () => {
      const seg = (t) => [...document.querySelectorAll('.mode-seg button')].find((b) => (b.innerText || '').trim() === t);
      seg('写作').click();
      await sleep(600);
      seg('复盘').click();
      const card = () => document.querySelector('.pitch.wd');
      await waitFor(async () => card(), 12000, '复盘栏里没有守夜人那一屏');
      if (!/内置/.test(card().innerText || '')) fail('这本书没写力量体系词条，面板该如实说用的是内置表：' + (card().innerText || '').replace(/\s+/g, ' ').slice(0, 120));
      const btn = () => [...card().querySelectorAll('button')].find((b) => (b.innerText || '').includes('补一张力量体系卡'));
      if (!btn()) fail('缺入口：内置表判不了自创体系，该给一键建卡的按钮');
      btn().click();
      const worlds = await waitFor(async () => {
        const j = await api();
        const w = (j.projects[0].worldItems || []).filter((x) => x.kind === '力量体系');
        return w.length ? w : null;
      }, 9000, '力量体系卡没落库');
      out.ladder = worlds[0].content.slice(0, 14);
      if (worlds.length !== 1) fail('点一次只该建一张，实际 ' + worlds.length + ' 张');
      if (!worlds[0].content.includes('→')) fail('脚手架要给出可照抄的序列写法：' + worlds[0].content.slice(0, 60));
      await sleep(500);
      if (!/词条/.test(card().innerText || '')) fail('建完卡面板该立刻改用作者的词条线：' + (card().innerText || '').replace(/\s+/g, ' ').slice(0, 120));
      if (btn()) fail('已经有词条了还劝建卡，就是 nag');
    });

    return {
      ok: true,
      summary:
        `动效(${out.flippedAtOnce}→${out.flippedLater} 翻开, ${out.rarity})→${out.pulledDup ? '抽到手牌已有卡·不重复占位✓' : '溢出提示✓'}→手牌3→合成 0/1→` +
        `写到位白送一抽(bonusPulls=${out.bonusAfterCombo}, litAt✓, 条上「${out.comboStateAfter}」)→` +
        `零条件卡要点追加+即点亮→词表卡已达标直接点亮(${out.litAfterN02.join('/')})→节奏卡 ${out.rhythmProgress} 可放弃→` +
        `拆文对标：${out.benchRow}｜差距 ${out.gapRows.length} 项(${out.worthRows} 项值得学)→掉卡 ${out.customCards.length} 张=${out.customCards.join('/')}→卡池 ${out.poolRowsAfter} 张→` +
        `笔触漂移：${out.driftHint}｜偏了 ${out.driftWorth.length} 项=${out.selfCards.join('/')}→` +
        `守夜人入口：建词条卡「${out.ladder}…」→ ` +
        `批量门禁：2 章缺细纲被拦（补要点后只剩 ${out.gateAfter.match(/\d+ 章/)?.[0] ?? '?'}）+ 境界矛盾 ${out.loreRows.length} 行「${out.loreRows[0] ?? ''}」，补前「${out.gateText}」`,
      data: out,
      trace,
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), trace, page: snapshot(), data: out };
  }
})()
