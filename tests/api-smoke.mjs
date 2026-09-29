// API 冒烟测试：把真实的 server.js 起在隔离数据目录 + 空闲端口上，用 HTTP 打核心接口。
// 目的：每次改 server.js / 数据格式后，自动确认「本地数据 API 全链路」没被改坏。
// 用法：npm run test:api（无需先 build；静态页断言在 dist 存在时自动附加）
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverJs = path.join(root, 'server.js');
const distIndex = path.join(root, 'dist', 'index.html');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

let failures = 0;
const steps = [];
function step(name, fn) {
  steps.push({ name, fn });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg} —— 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}

step('GET /api/data 返回默认结构与隔离 dataDir', async (base) => {
  const r = await fetch(base + '/api/data');
  assertEq(r.status, 200, '状态码');
  const j = await r.json();
  for (const k of ['ideas', 'projects', 'stats', 'ai', 'obsidian']) {
    assert(j[k] !== undefined, `字段 ${k} 缺失`);
  }
  assert(Array.isArray(j.ideas), 'ideas 应为数组');
  assert(Array.isArray(j.projects), 'projects 应为数组');
  assertEq(j.ideas.length, 0, '隔离目录初始 ideas 应为空');
  assert(Array.isArray(j.ai.rules), 'ai.rules 应为数组');
  assert(j.dataDir.startsWith(tmpdir()), `dataDir 应指向隔离临时目录，实际 ${j.dataDir}`);
});

step('PUT /api/data 写入 projects/ideas/stats 后回读一致', async (base) => {
  const project = {
    id: 'p1',
    title: '冒烟测试书',
    chapters: [
      { id: 'c1', title: '第一章', content: '测试内容' },
      { id: 'c2', title: '第二章', content: '' },
    ],
    updatedAt: '2026-09-09T00:00:00.000Z',
  };
  const idea = { id: 'i1', title: '一个灵感' };
  const stats = { daily: { '2026-09-09': { p1: 4 } }, reflection: 'ok' };
  const w = await fetch(base + '/api/data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projects: [project], ideas: [idea], stats }),
  });
  assertEq(w.status, 200, '写入状态码');
  const j = await (await fetch(base + '/api/data')).json();
  assertEq(j.projects.length, 1, 'projects 数量');
  assertEq(j.projects[0].chapters[1].content, '', '空内容保留');
  assertEq(j.projects[0].updatedAt, project.updatedAt, '字段往返无损');
  assertEq(j.ideas[0].title, '一个灵感', 'ideas 往返');
  assertEq(j.stats.daily['2026-09-09'].p1, 4, 'stats 往返');
});

step('PUT /api/data 类型非法时拒绝（400）', async (base) => {
  for (const bad of [
    { projects: 'not-array' },
    { ideas: 42 },
    { stats: [] },
  ]) {
    const r = await fetch(base + '/api/data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bad),
    });
    assertEq(r.status, 400, `应 400：${JSON.stringify(bad)}`);
  }
});

step('PUT /api/ai-config 规整并回读（rules 裁剪/过滤/布尔化）', async (base) => {
  const w = await fetch(base + '/api/ai-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3:8b',
      protocol: 'ollama',
      apiKey: '',
      gateDraft: false,
      judgeOnly: true,
      rules: [
        { name: '短', content: '第一条', on: true },
        { name: 'x'.repeat(40), content: 'c'.repeat(2100), on: false },
        { content: '缺 name 的规则', on: true },
        { content: 123 }, // 非字符串内容应被过滤
        '纯字符串应被过滤',
      ],
    }),
  });
  assertEq(w.status, 200, '状态码');
  const j = await w.json();
  assertEq(j.ai.provider, 'ollama', 'provider 生效');
  assertEq(j.ai.protocol, 'ollama', 'protocol 生效');
  assertEq(j.ai.ready, true, 'baseUrl+model 齐全应 ready');
  assertEq(j.ai.rules.length, 3, '4 条有效规则中 1 条因 content 非字符串被过滤');
  assertEq(j.ai.rules[1].name.length, 30, 'name 应截断到 30');
  assertEq(j.ai.rules[1].content.length, 2000, 'content 应截断到 2000');
  assertEq(j.ai.rules[2].name, '未命名规则', '缺 name 补默认');
  assertEq(j.ai.gateDraft, false, '批量门禁开关应能关掉');
  assertEq(j.ai.judgeOnly, true, '「AI 只判不写」开关应能打开');
  const again = await fetch(base + '/api/ai-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:8b' }),
  });
  const aj = await again.json();
  assertEq(aj.ai.gateDraft, false, '后续保存不带这个字段时，关掉的门禁不该被打开');
  assertEq(aj.ai.judgeOnly, true, '同上：只判不写不该被下一次保存悄悄关掉');
  assertEq(aj.ai.rules.length, 3, '保存其它字段不该清掉规则');
  const j2 = await (await fetch(base + '/api/data')).json();
  assertEq(j2.ai.provider, 'ollama', 'ai.json 落盘回读一致');
});

step('PUT/GET /api/chat 会话往返', async (base) => {
  const sessions = [{ id: 's1', title: '冒烟会话', messages: [{ role: 'user', content: 'hi' }] }];
  const w = await fetch(base + '/api/chat', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessions }),
  });
  assertEq(w.status, 200, '写入状态码');
  const bad = await fetch(base + '/api/chat', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessions: 'x' }),
  });
  assertEq(bad.status, 400, '非数组 sessions 应 400');
  const j = await (await fetch(base + '/api/chat')).json();
  assertEq(j.sessions.length, 1, '会话数量');
  assertEq(j.sessions[0].messages[0].content, 'hi', '会话往返无损');
});

step('Obsidian：空配置 400 / 不存在目录 400 / 状态未配置', async (base) => {
  const r1 = await fetch(base + '/api/obsidian/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vaultPath: '' }),
  });
  assertEq(r1.status, 400, '空 vaultPath 应 400');
  const r2 = await fetch(base + '/api/obsidian/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vaultPath: 'Z:/不存在的目录_冒烟' }),
  });
  assertEq(r2.status, 400, '不存在目录应 400');
  const s = await (await fetch(base + '/api/obsidian/status')).json();
  assertEq(s.configured, false, '初始未配置');
});

step('Obsidian：配置真实目录后可写读回', async (base, dataDir) => {
  const w = await fetch(base + '/api/obsidian/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vaultPath: dataDir, folder: '冒烟库/子目录' }),
  });
  assertEq(w.status, 200, '状态码');
  const j = await w.json();
  assertEq(j.obsidian.folder, '冒烟库/子目录', 'folder 透传');
  const s = await (await fetch(base + '/api/obsidian/status')).json();
  assertEq(s.configured, true, '配置后应为 true');
});

step('未知 API 返回 404 JSON 且不崩', async (base) => {
  for (const [method, url] of [['POST', '/api/nope'], ['GET', '/api/also-nope'], ['DELETE', '/api/data']]) {
    const r = await fetch(base + url, { method });
    assertEq(r.status, 404, `${method} ${url} 应 404`);
    const ct = r.headers.get('content-type') || '';
    assert(ct.includes('application/json'), `${url} 应为 JSON 响应`);
  }
});

step('静态首页（dist 存在时）返回可挂载的 HTML', async (base) => {
  if (!existsSync(distIndex)) {
    console.log('      （未构建 dist，跳过静态页断言——先执行 npm run build）');
    return;
  }
  const r = await fetch(base + '/');
  assertEq(r.status, 200, '首页状态码');
  const html = await r.text();
  assert(html.includes('<div id="root"'), '首页应包含 #root 挂载点');
});

// ---------- 历史快照侧车存储 ----------

step('快照分流：正文进 projects.json、快照进 versions.json，首屏只回份数', async (base, dataDir) => {
  const versions = [
    { at: '2026-09-01 10:00', words: 4, text: '第一稿开头' },
    { at: '2026-09-02 10:00', words: 9, text: '第二稿开头' },
  ];
  const project = {
    id: 'pv1',
    title: '快照分流书',
    draft: '当前正文',
    notes: '',
    linkedIdeaIds: [],
    mode: 'chapters',
    versions,
    chapters: [
      { id: 'pc1', title: '第一章', content: '章正文', versions: [{ at: '2026-09-03 08:00', words: 3, text: '章旧稿' }] },
      { id: 'pc2', title: '第二章', content: '第二章正文' },
    ],
    updatedAt: '2026-09-09T00:00:00.000Z',
  };
  const w = await fetch(base + '/api/data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projects: [project] }),
  });
  assertEq(w.status, 200, '写入状态码');
  const projectsFile = readFileSync(path.join(dataDir, 'projects.json'), 'utf-8');
  assert(!projectsFile.includes('"versions"'), 'projects.json 里不该再有快照（否则自动保存仍在重写它）');
  assert(projectsFile.includes('章正文'), '正文仍要落在 projects.json');
  const sidecar = JSON.parse(readFileSync(path.join(dataDir, 'versions.json'), 'utf-8'));
  assertEq(sidecar.pv1.project.length, 2, '作品级快照落侧车');
  assertEq(sidecar.pv1.chapters.pc1.length, 1, '章级快照落侧车');
  assertEq(sidecar.pv1.chapters.pc2, undefined, '无快照的章不占位');
  const j = await (await fetch(base + '/api/data')).json();
  assertEq(j.projects[0].versions, undefined, '首屏不并回快照：几十 MB 的书不该每次开机都搬一遍');
  assertEq(j.projects[0].chapters[0].versions, undefined, '章级快照同样不进首屏');
  assertEq(j.projects[0].chapters[1].content, '第二章正文', '正文无损');
  assertEq(j.projects[0].draft, '当前正文', 'draft 无损');
  assertEq(j.versionCounts.pv1, 2, '首屏给份数表，客户端才知道哪条 key 有东西');
  assertEq(j.versionCounts['pv1::pc1'], 1, '章级 key 用 pid::cid');
  assertEq(j.versionCounts['pv1::pc2'], undefined, '没快照的章不占份数');
  const lazy = await (await fetch(base + '/api/versions?project=pv1')).json();
  assertEq(lazy.versions['pv1::pc1'][0].text, '章旧稿', '按作品懒读能拿到全文');
  assertEq(lazy.versions.pv1.length, 2, '作品级快照也在同一次返回里');
  const none = await (await fetch(base + '/api/versions?project=不存在的书')).json();
  assertEq(Object.keys(none.versions).length, 0, '别人的作品一条都不该被带出来');
});

step('PUT /api/versions：按 key 增量合并 + 非法清洗 + 空数组删除', async (base, dataDir) => {
  const many = Array.from({ length: 25 }, (_, i) => ({ at: `2026-09-${String((i % 28) + 1).padStart(2, '0')} 10:00`, words: i, text: '稿' + i }));
  const before = JSON.parse(readFileSync(path.join(dataDir, 'versions.json'), 'utf-8'));
  assert(before.pv1?.project?.length === 2, '前置：上一步写进去的两份作品级快照');
  const w = await fetch(base + '/api/versions', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      versions: {
        pv1: many, // 覆盖这一条 key
        'pv1::pc9': [{ at: '2026-09-05 09:00', words: 1, text: '有效' }, { at: '2026-09-05 09:10', words: 2, text: 123 }, '纯字符串', { noAt: true }],
        'pv1::pc1': [], // 空数组＝删掉这条
        坏形状: '不是数组',
      },
    }),
  });
  assertEq(w.status, 200, '状态码');
  const store = JSON.parse(readFileSync(path.join(dataDir, 'versions.json'), 'utf-8'));
  assertEq(store.pv1.project.length, 20, '快照份数按上限 20 截断，保留最新的');
  assertEq(store.pv1.project[19].text, '稿24', '截断保留尾部（最新）');
  assertEq(store.pv1.chapters.pc9.length, 1, '缺 text/at 的条目被清洗');
  assertEq(store.pv1.chapters.pc1, undefined, '空数组把这条 key 删掉');
  assertEq(store.坏形状, undefined, '形状不对的 key 被丢掉，且不能让服务崩');
  const after = await (await fetch(base + '/api/data')).json();
  assertEq(after.versionCounts.pv1, 20, '份数表跟着增量更新');
  assertEq(after.versionCounts['pv1::pc9'], 1, '新 key 出现在份数表里');
  assertEq(after.versionCounts['pv1::pc1'], undefined, '删掉的 key 从份数表消失');
  // merge 是本步的重点：只发 pv1 相关，另一本书（下面这步造的）不该被牵连
  await fetch(base + '/api/versions', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ versions: { other1: [{ at: '2026-09-06 10:00', words: 3, text: '另一本书的快照' }] } }),
  });
  const merged = JSON.parse(readFileSync(path.join(dataDir, 'versions.json'), 'utf-8'));
  assertEq(merged.other1.project.length, 1, 'merge 写入新作品');
  assertEq(merged.pv1.project.length, 20, '没发过的其它 key 一律不动（整表覆盖才是这次要防的事）');
});

step('整包写入按最新清单剪掉孤儿快照；/api/export 才带快照全文', async (base, dataDir) => {
  const before = JSON.parse(readFileSync(path.join(dataDir, 'versions.json'), 'utf-8'));
  assert(before.pv1?.chapters?.pc9, '前置：上一步留下的 pc9 快照');
  assert(before.other1?.project?.length === 1, '前置：另一条 key 的快照');
  // 只留 pc2：pc9/pc9 这些不存在的章，快照该跟着走。
  // other1 也要在作品清单里出现——它只是没有章节，不该被当成删掉的书
  const slim = {
    id: 'pv1',
    title: '快照分流书',
    draft: '当前正文',
    notes: '',
    linkedIdeaIds: [],
    mode: 'chapters',
    chapters: [{ id: 'pc2', title: '第二章', content: '第二章正文' }],
    updatedAt: '2026-09-10T00:00:00.000Z',
  };
  const other = { id: 'other1', title: '别本书', draft: '', notes: '', linkedIdeaIds: [], chapters: [], updatedAt: '2026-09-10T00:00:00.000Z' };
  const w = await fetch(base + '/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projects: [slim, other] }) });
  assertEq(w.status, 200, '整包写入状态码');
  const after = JSON.parse(readFileSync(path.join(dataDir, 'versions.json'), 'utf-8'));
  assertEq(after.pv1.chapters?.pc9, undefined, '删掉的章不该继续背着快照');
  assertEq(after.pv1.project.length, 20, '作品级快照与还在的章不受牵连');
  assertEq(after.other1.project.length, 1, '还在的书一颗快照都不掉');
  assert(!readFileSync(path.join(dataDir, 'projects.json'), 'utf-8').includes('"versions"'), '剪枝过程不该把快照写回 projects.json');
  // 书被删掉，快照也该跟着走
  const w2 = await fetch(base + '/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projects: [slim] }) });
  assertEq(w2.status, 200, '第二次整包写入');
  const after2 = JSON.parse(readFileSync(path.join(dataDir, 'versions.json'), 'utf-8'));
  assertEq(after2.other1, undefined, '删掉的书不留孤儿快照');
  assertEq(after2.pv1.project.length, 20, '留下的书照旧');

  const res = await fetch(base + '/api/export');
  assertEq(res.status, 200, '导出状态码');
  assert(/attachment/.test(res.headers.get('content-disposition') || ''), '导出要带下载文件名（备份由服务端拼装）');
  const dump = await res.json();
  assertEq(dump.projects[0].versions.length, 20, '导出里必须有快照全文：客户端内存已经不带着了');
  assertEq(dump.ideas.constructor.name, 'Array', '灵感照常导出');
  assert(dump.exportedAt, '导出时间戳');
});

step('并发整包保存：结果仍是合法 JSON 且不留临时文件', async (base, dataDir) => {
  const pad = '并'.repeat(60000); // ~180KB/次，6 次足以让写入重叠
  const sends = Array.from({ length: 6 }, (_, i) => ({
    id: 'conc',
    title: '并发' + i,
    draft: pad + i,
    notes: '',
    linkedIdeaIds: [],
    updatedAt: '2026-09-09T00:00:00.000Z',
  }));
  const rs = await Promise.all(
    sends.map((p) => fetch(base + '/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projects: [p] }) })),
  );
  for (const r of rs) assertEq(r.status, 200, '并发写入都应成功');
  const j = await (await fetch(base + '/api/data')).json();
  assertEq(j.projects.length, 1, '最后写入胜出，不该出现半包');
  assert(/^并发[0-5]$/.test(j.projects[0].title), `落库内容应是某一次完整写入，实际 ${j.projects[0].title}`);
  const leftovers = readdirSync(dataDir).filter((f) => f.endsWith('.tmp'));
  assertEq(leftovers.length, 0, '不该留下 .tmp 残留：' + leftovers.join(','));
});

step('请求体超上限回 413 且带可读原因（不再是断连）', async (base) => {
  // 本套用例把上限压到 2MB（WB_MAX_BODY_MB），避免为了测上限真传 100MB
  const body = JSON.stringify({ projects: [{ id: 'big', title: '超大书', draft: '字'.repeat(900000), notes: '', linkedIdeaIds: [] }] });
  assert(Buffer.byteLength(body) > 2 * 1024 * 1024, '构造的请求体应超过 2MB 上限');
  const r = await fetch(base + '/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
  assertEq(r.status, 413, '超限应 413');
  const j = await r.json();
  assert(typeof j.error === 'string' && j.error.includes('MB'), `应给出具体积上限的原因，实际：${JSON.stringify(j)}`);
  // 被拒的这次写入不能污染已有数据
  const after = await (await fetch(base + '/api/data')).json();
  assertEq(after.projects.find((p) => p.id === 'conc')?.title.startsWith('并发'), true, '超限请求不应改动已落库数据');
});

step('整包写入比磁盘已有内容更旧时回 stale 标记（多标签页覆盖的识别）', async (base) => {
  const put = async (at) => {
    const r = await fetch(base + '/api/data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projects: [{ id: 'stale1', title: '覆盖测试', draft: '正文', updatedAt: at }] }),
    });
    return r.json();
  };
  assertEq((await put('2026-09-22T10:00:00.000Z')).stale, undefined, '首次写入不该报 stale');
  assertEq((await put('2026-09-22T12:00:00.000Z')).stale, undefined, '比已有内容更新的写入不该报 stale');
  assertEq((await put('2026-09-22T11:00:00.000Z')).stale, true, '更旧的整包写入要标记出来');
  assertEq((await put('2026-09-22T13:00:00.000Z')).stale, undefined, '标记过一次后，账要跟到最新一次写入');
});

step('数据文件损坏：保留 .corrupt 原件、以空数据继续并上报 warnings', async (base, dataDir) => {
  writeFileSync(path.join(dataDir, 'ideas.json'), '{"这不是": 数组，而且是半截的');
  const r = await fetch(base + '/api/data');
  assertEq(r.status, 200, '单个文件坏了不能让接口整体失败');
  const j = await r.json();
  assert(Array.isArray(j.ideas) && j.ideas.length === 0, '损坏文件按空数据处理');
  assert(Array.isArray(j.warnings) && j.warnings.length > 0, '必须通过 warnings 让界面知道');
  assert(j.warnings.some((w) => w.includes('ideas.json')), `warnings 要点名是哪个文件，实际：${j.warnings.join('|')}`);
  await fetch(base + '/api/data'); // 再读两次：另存只做一次，不能每次都刷一份副本
  await fetch(base + '/api/data');
  const kept = readdirSync(dataDir).filter((f) => /^ideas\.json\.corrupt-/.test(f));
  assertEq(kept.length, 1, '应只把原件另存一份留待人工找回');
  assertEq(readFileSync(path.join(dataDir, kept[0]), 'utf-8').startsWith('{"这不是"'), true, '另存的原件内容保持损坏原样');
});

step('卡池账本与自建卡：往返一致，非法值被清洗', async (base, dataDir) => {
  const w = await fetch(base + '/api/data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      gacha: { pulls: 12, sincePity: 3, ink: 7, usedWords: 12000, hand: ['n01', 'n02'], owned: { n01: 2 }, applied: { n01: '2026-09-22T00:00:00.000Z' }, lit: {} },
      cards: {
        version: 1,
        custom: [
          { id: 'u1', series: '自建', rarity: 'SR', name: '我的手法卡', effect: 'beat', payload: '写一件只有读者知道的事' },
          {
            id: 'u4',
            rarity: 'N',
            name: '短句行军',
            effect: 'constraint',
            payload: '把句子拆短，对白写够',
            constraints: [
              { kind: 'maxSentence', chars: 14 },
              { kind: 'dialogueShare', min: 20 },
              { kind: 'pronounOpen', max: 0 },
              { kind: 'deslopMax', key: 'em-dash', count: 0 },
              { kind: '胡说八道', chars: 9 },
              { kind: 'maxSentence', chars: 0 },
              { kind: 'any', words: [] },
              '不是对象',
            ],
          },
          { id: 'u2', rarity: '传说', name: '非法稀有度', effect: 'beat', payload: 'x' },
          { id: '', rarity: 'N', name: '缺 id', effect: 'beat', payload: 'x' },
          { id: 'u3', rarity: 'N', name: 'x'.repeat(60), effect: '不存在', payload: 'x' },
        ],
        off: ['n01', 123, 'x'.repeat(80)],
      },
    }),
  });
  assertEq(w.status, 200, '写入状态码');
  const j = await (await fetch(base + '/api/data')).json();
  assertEq(j.gacha.pulls, 12, '抽数往返');
  assertEq(j.gacha.ink, 7, '墨往返');
  assertEq(j.gacha.usedWords, 12000, '字数账往返');
  assertEq(JSON.stringify(j.gacha.hand), JSON.stringify(['n01', 'n02']), '手牌往返');
  assertEq(j.gacha.owned.n01, 2, '收藏计数往返');
  assertEq(j.cards.custom.length, 2, '非法自建卡（稀有度不在白名单 / 缺 id / 效果非法）全部被丢');
  assertEq(j.cards.custom[0].id, 'u1', '合法的那张留下');
  const cond = j.cards.custom.find((c) => c.id === 'u4');
  assertEq(
    JSON.stringify(cond.constraints),
    JSON.stringify([
      { kind: 'maxSentence', chars: 14 },
      { kind: 'dialogueShare', min: 20 },
      { kind: 'pronounOpen', max: 0 },
      { kind: 'deslopMax', key: 'em-dash', count: 0 },
    ]),
    '约束条件必须原样落盘——掉了 constraints，重启后这张练笔卡变成零条件卡，打出去直接白点亮'
  );
  assertEq(j.cards.off[0], 'n01', 'off 保留合法项');
  assertEq(j.cards.off.length, 2, '非字符串被丢、超长项被截而不被丢');
  const dirty = await fetch(base + '/api/data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gacha: { pulls: -5, ink: '很多', sincePity: null, hand: 'n01', owned: [1, 2] } }),
  });
  assertEq(dirty.status, 200, '脏数据不报错，只被规整');
  const j2 = await (await fetch(base + '/api/data')).json();
  assertEq(JSON.stringify(j2.gacha), JSON.stringify({ pulls: 0, sincePity: 0, ink: 0, usedWords: 0, hand: [], bonusPulls: 0, owned: {}, applied: {}, lit: {} }), '负数/字符串/null 一律归零或丢弃');
  assert(existsSync(path.join(dataDir, 'gacha.json')), 'gacha.json 独立落盘');
  assert(existsSync(path.join(dataDir, 'cards.json')), 'cards.json 独立落盘');
});

step('牵线图随作品整包往返：坐标与线不丢，脏图也不该让服务崩', async (base, dataDir) => {
  const graph = {
    version: 1,
    nodes: [
      { id: 'chapter:c1', kind: 'chapter', ref: 'c1', x: 40, y: 40 },
      { id: 'chapter:c2', kind: 'chapter', ref: 'c2', x: 248, y: 40 },
      { id: 'char:k1', kind: 'char', ref: 'k1', x: 248, y: 160 },
      { id: 'note:n1', kind: 'note', note: '支线：老灯塔', x: 12, y: 300 },
    ],
    links: [
      { id: 'next|chapter:c1->chapter:c2', from: 'chapter:c1', to: 'chapter:c2', kind: 'next' },
      { id: 'cast|chapter:c2->char:k1', from: 'chapter:c2', to: 'char:k1', kind: 'cast' },
    ],
  };
  const projWith = {
    id: 'pg1',
    title: '牵线往返书',
    draft: '',
    notes: '',
    linkedIdeaIds: [],
    mode: 'chapters',
    chapters: [{ id: 'c1', title: '第一章', content: '甲' }, { id: 'c2', title: '第二章', content: '乙' }],
    characters: [{ id: 'k1', name: '林越', state: '', log: [], relations: [] }],
    graph,
    updatedAt: '2026-09-11T00:00:00.000Z',
  };
  const w = await fetch(base + '/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projects: [projWith] }) });
  assertEq(w.status, 200, '写入状态码');
  const back = (await (await fetch(base + '/api/data')).json()).projects[0].graph;
  assertEq(JSON.stringify(back), JSON.stringify(graph), '图要原样回来（节点、线、坐标一个都不丢）');
  assertEq(back.nodes[3].note, '支线：老灯塔', '便签正文不丢');
  // 脏图：服务端只存形状，规整在客户端做——重点是别 500、别把别的字段带走
  const dirty = { ...projWith, graph: { version: 1, nodes: '不是数组', links: [{ from: 1 }] }, updatedAt: '2026-09-12T00:00:00.000Z' };
  const w2 = await fetch(base + '/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projects: [dirty] }) });
  assertEq(w2.status, 200, '脏图写入不该报错');
  const j2 = await (await fetch(base + '/api/data')).json();
  assertEq(j2.projects[0].chapters.length, 2, '脏图不能连累正文字段');
  assertEq(JSON.stringify(j2.projects[0].graph), JSON.stringify({ version: 1, nodes: '不是数组', links: [{ from: 1 }] }), '原样存原样回，界面读到时再自己整');
});

step('同源闸：跨源写/伪 Host/畸形路径全部挡掉，正常同源的照常能写', async (base) => {
  // 绑 127.0.0.1 只挡住局域网，挡不住浏览器：任何网页都能对本机发「简单请求」。
  // 这几条钉的是实测过的洞——修完之后谁再把它改回去，这里就红。
  const before = await (await fetch(base + '/api/data')).json();
  const n0 = before.projects.length;

  const evil = await fetch(base + '/api/data', {
    method: 'PUT',
    // 浏览器的「简单请求」形状：不带预检的 content-type + 外站 Origin
    headers: { 'Content-Type': 'text/plain', Origin: 'http://evil.example' },
    body: JSON.stringify({ projects: [{ id: 'xss', title: '外部网页写进来的书', mode: 'chapters', chapters: [] }] }),
  });
  assert(evil.status === 403 || evil.status === 415, `跨源简单请求应被拒，实际 ${evil.status}`);
  await evil.text();
  const after = await (await fetch(base + '/api/data')).json();
  assertEq(after.projects.length, n0, '被拒的写不能留下任何东西');

  // 最坏的一条链：跨站先把 baseUrl 改掉，下次正常调用就把 Key 送到别人服务器上
  const cfg0 = (await (await fetch(base + '/api/data')).json()).ai.baseUrl;
  const pivot = await fetch(base + '/api/ai-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain', Origin: 'http://evil.example' },
    body: JSON.stringify({ baseUrl: 'http://attacker.example/v1' }),
  });
  assert(pivot.status === 403 || pivot.status === 415, `改配置的跨站请求应被拒，实际 ${pivot.status}`);
  await pivot.text();
  const cfg1 = (await (await fetch(base + '/api/data')).json()).ai.baseUrl;
  assertEq(cfg1, cfg0, '被拒的请求不许把 baseUrl 换成别人的地址——那是 Key 外泄的通道');

  const nullOrigin = await fetch(base + '/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'null' },
    body: '{}',
  });
  assertEq(nullOrigin.status, 403, `Origin: null（file:// 形状）不该放行，实际 ${nullOrigin.status}`);
  await nullOrigin.text();

  // Host 伪造 = DNS rebinding 的形状，浏览器不会带 Origin 到同源，只能靠 Host 认
  const spoof = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: new URL(base).port, path: '/api/data', method: 'GET', headers: { host: 'evil.example' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end();
  });
  assertEq(spoof, 403, 'Host 不是本机就该 403');

  const bad = await fetch(base + '/%zz');
  assertEq(bad.status, 400, `畸形百分号编码应回 400，实际 ${bad.status}`);
  await bad.text();
  const alive = await fetch(base + '/api/data');
  assertEq(alive.status, 200, '挨了一个畸形请求之后服务必须还活着');

  // 正例：同源（渲染进程就是这个名字）带 body 要能正常写
  const ok = await fetch(base + '/api/data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ projects: before.projects, ideas: [{ id: 'i-gate', content: '闸门正例', createdAt: '', updatedAt: '' }] }),
  });
  assertEq(ok.status, 200, `同源写入不该被闸门误伤，实际 ${await ok.text()}`);
  const ideas = (await (await fetch(base + '/api/data')).json()).ideas;
  assertEq(ideas.length, 1, '正例要真的落库');

  // 不带请求体的 POST（渲染进程有这类调用）不能被 content-type 规则误伤：
  // 打一个不存在的路由，闸门若错判会回 403/415，正常则是 404
  const noBody = await fetch(base + '/api/nope-no-body', { method: 'POST' });
  assertEq(noBody.status, 404, `无请求体的 POST 被闸门误伤：${noBody.status}`);
  await noBody.text();
});

step('Obsidian 双向同步：推成文件树、库里改动拉回来、两边都改算冲突并能判定、Obsidian 换写法与自加属性不吃掉', async (base, dataDir) => {
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
  const put = (p, body) => fetch(base + p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const vault = path.join(dataDir, 'vault');
  mkdirSync(vault, { recursive: true });
  const cfg = await put('/api/obsidian/config', { vaultPath: vault, folder: '工作台' });
  assert(cfg.obsidian?.vaultPath, '库配置没保存下来');

  const mk = (over) => ({
    id: 'ob1',
    type: '玄幻',
    title: '雾港',
    status: '写作中',
    deadline: '',
    notes: '雾城',
    draft: '',
    linkedIdeaIds: [],
    mode: 'chapters',
    chapters: [
      { id: 'c1', title: '到港', content: '林越在码头等船。', volume: '第一卷', createdAt: '', updatedAt: '' },
      { id: 'c2', title: '黑车', content: '', volume: '第一卷', createdAt: '', updatedAt: '' },
    ],
    characters: [{ id: 'k1', name: '林越', state: '握着半枚铜印', log: [], relations: [] }],
    worldItems: [{ id: 'w1', name: '北窗', kind: '地点', content: '永远不开的窗' }],
    createdAt: '',
    updatedAt: '',
    ...over,
  });
  await put('/api/data', { projects: [mk()] });

  const idx = path.join(vault, '工作台', '雾港', 'index.md');
  const chap1 = path.join(vault, '工作台', '雾港', '章节', '第1章 到港.md');
  const charFile = path.join(vault, '工作台', '雾港', '人物', '林越.md');
  const worldFile = path.join(vault, '工作台', '雾港', '设定', '北窗.md');
  const foreign = path.join(vault, '工作台', '别人的笔记.md');
  mkdirSync(path.dirname(foreign), { recursive: true });
  writeFileSync(foreign, '随手写的，不属于本工具\n', 'utf-8');

  const r1 = await post('/api/obsidian/sync', { projectId: 'ob1' });
  assert(r1.root === '雾港', `root 该是书名目录，实际 ${r1.root}`);
  assert(r1.pushed.length >= 5, `首次该把索引 + 两章 + 人物 + 设定都写出去：${JSON.stringify(r1.pushed)}`);
  for (const f of [idx, chap1, charFile, worldFile]) assert(existsSync(f), `库里缺文件：${f}`);
  const t1 = readFileSync(chap1, 'utf-8');
  assert(t1.includes('[[人物/林越]]'), `正文人物没写成双链：${t1.slice(0, 200)}`);
  assert(readFileSync(idx, 'utf-8').includes('[[第1章 到港]]'), '索引页没链到章节');

  const r2 = await post('/api/obsidian/sync', { projectId: 'ob1' });
  assert(r2.pushed.length === 0 && r2.pulled.length === 0 && r2.conflicts.length === 0, `第二趟无事发生才对：${JSON.stringify({ p: r2.pushed, q: r2.pulled, c: r2.conflicts.length })}`);
  // 空转那一趟不许重写祖先状态表（自动同步开着时每 12 秒就来一回）
  const stPath = path.join(dataDir, 'obsidian-sync.json');
  const m0 = statSync(stPath).mtimeMs;
  await new Promise((r) => setTimeout(r, 1100));
  await post('/api/obsidian/sync', { projectId: 'ob1' });
  assertEq(statSync(stPath).mtimeMs, m0, '什么都没挪，却把状态表重写了');

  // 在库里改（模拟 Obsidian 里编辑）→ 该被拉回来，且我方不重复覆盖
  // 注意：渲染后人名已经是 [[人物/林越]]，替换要挑没被链住的那段
  writeFileSync(chap1, t1.replace('在码头等船。', '在码头等船，船没有来。'), 'utf-8');
  const r3 = await post('/api/obsidian/sync', { projectId: 'ob1' });
  assert(r3.pulled.length === 1 && r3.pulled[0].endsWith('第1章 到港.md'), `库里的改动该被拉回来：${JSON.stringify(r3.pulled)}`);
  assert(r3.pushed.length === 0, `拉回来的那趟不该又推回去：${JSON.stringify(r3.pushed)}`);
  assert(r3.nextProject?.chapters?.[0]?.content?.includes('船没有来'), `回读补丁没带上新正文：${JSON.stringify(r3.nextProject?.chapters?.[0]?.content)}`);
  // 界面拿到 nextProject 后走自己的保存路径，这里模拟同样的动作
  await put('/api/data', { projects: [r3.nextProject] });

  // 两边都改 → 冲突：既不许自动推，也不许自动拉
  writeFileSync(charFile, readFileSync(charFile, 'utf-8').replace('当前状态：握着半枚铜印', '当前状态：库里改的'), 'utf-8');
  await put('/api/data', { projects: [mk({ characters: [{ id: 'k1', name: '林越', state: '工作台改的', log: [], relations: [] }] })] });
  const r4 = await post('/api/obsidian/sync', { projectId: 'ob1' });
  const rel = '雾港/人物/林越.md';
  assert(r4.conflicts.some((c) => c.rel === rel), `两边都改了必须报冲突：${JSON.stringify({ c: r4.conflicts.map((x) => x.rel), p: r4.pushed })}`);
  assert(!r4.pushed.includes(rel) && !r4.pulled.includes(rel), '冲突项不许被自动偏向任何一边');
  assert(readFileSync(charFile, 'utf-8').includes('库里改的'), '冲突未判定前不许动库里的文件');

  const r5 = await post('/api/obsidian/sync', { projectId: 'ob1', resolve: { [rel]: 'app' } });
  assert(r5.pushed.includes(rel), `判定「用工作台这版」后该推出去：${JSON.stringify({ p: r5.pushed, c: r5.conflicts.map((x) => x.rel) })}`);
  assert(readFileSync(charFile, 'utf-8').includes('工作台改的'), '判定后文件内容没更新');
  const r6 = await post('/api/obsidian/sync', { projectId: 'ob1' });
  assert(r6.conflicts.length === 0 && r6.pushed.length === 0 && r6.pulled.length === 0, `判定之后该归于平静：${JSON.stringify(r6.pushed.concat(r6.pulled, r6.conflicts))}`);

  // Obsidian 自己怎么写回去：属性去引号、tags 换块式列表、键序打乱，外加他自己的属性。
  // 这叫「写法变了、内容没变」——既不该惊动同步，更不该在下次推的时候把他的属性抹掉。
  const rewriteObsidian = (text) => {
    const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!m) return text;
    const groups = [];
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (kv && kv[2].trim().startsWith('[')) {
        groups.push([kv[1] + ':', ...JSON.parse(kv[2].trim()).map((i) => '  - ' + i)]);
      } else if (kv) {
        groups.push([kv[1] + ': ' + kv[2].trim().replace(/^"(.*)"$/, '$1')]);
      } else if (groups.length && /^\s+-\s/.test(line)) {
        groups[groups.length - 1].push(line);
      } else {
        groups.push([line]);
      }
    }
    groups.reverse();
    return '---\n' + groups.flat().join('\n') + '\n---' + text.slice(m[0].length);
  };
  writeFileSync(chap1, rewriteObsidian(readFileSync(chap1, 'utf-8')).replace(/^---\n/, '---\naliases:\n  - 老码头\n'), 'utf-8');
  const r8 = await post('/api/obsidian/sync', { projectId: 'ob1' });
  assert(r8.pushed.length === 0 && r8.pulled.length === 0 && r8.conflicts.length === 0, 'Obsidian 只是换了写法＋加了别名，不该有任何动作：' + JSON.stringify({ p: r8.pushed, q: r8.pulled, c: r8.conflicts.length }));
  assert(readFileSync(chap1, 'utf-8').includes('- 老码头'), '同步过程中把库里的别名弄丢了');

  // 我方改正文 → 该推；推完他的别名必须还在
  const p8 = mk({});
  p8.chapters[0].content = '林越蹲在第七根缆桩边，改写后的正文，船还是没来。';
  await put('/api/data', { projects: [p8] });
  const r9 = await post('/api/obsidian/sync', { projectId: 'ob1' });
  assert(r9.pushed.some((x) => x.endsWith('第1章 到港.md')), '改了正文该推出去：' + JSON.stringify(r9.pushed));
  const pushed9 = readFileSync(chap1, 'utf-8');
  assert(pushed9.includes('改写后的正文'), '推的内容没落进文件');
  assert(pushed9.includes('- 老码头'), 'push 把他在库里加的 aliases 抹掉了：' + pushed9.slice(0, 200));
  const r10 = await post('/api/obsidian/sync', { projectId: 'ob1' });
  assert(r10.pulled.length === 0 && r10.conflicts.length === 0, '别名不该被反复判成改动：' + JSON.stringify({ q: r10.pulled, c: r10.conflicts.length }));
  writeFileSync(chap1, rewriteObsidian(readFileSync(chap1, 'utf-8')), 'utf-8');
  const r11 = await post('/api/obsidian/sync', { projectId: 'ob1' });
  assert(r11.pushed.length === 0 && r11.pulled.length === 0 && r11.conflicts.length === 0, '再被 Obsidian 存一次还是不该有动作：' + JSON.stringify({ p: r11.pushed, q: r11.pulled, c: r11.conflicts.length }));

  // 别人写的笔记一个字节都不许碰
  assert(existsSync(foreign) && readFileSync(foreign, 'utf-8').includes('不属于本工具'), '误改了库里的他人笔记');

  // 删掉一章 → 只回收我方文件
  await put('/api/data', { projects: [mk({ chapters: [mk().chapters[0]] })] });
  const r7 = await post('/api/obsidian/sync', { projectId: 'ob1' });
  assert(r7.pruned.includes('雾港/章节/第2章 黑车.md'), `该回收被删章节的文件：${JSON.stringify(r7.pruned)}`);
  assert(!existsSync(path.join(vault, '工作台', '雾港', '章节', '第2章 黑车.md')), '回收没真的删掉文件');
  assert(existsSync(foreign), '回收时不许碰别人的笔记');

  const st = await fetch(base + '/api/obsidian/status').then((r) => r.json());
  assert(st.books?.some((b) => b.root === '雾港' && b.files > 0), `状态接口该报出同步记录：${JSON.stringify(st.books)}`);
  assert(st.noteCount === undefined, 'status 不该再扫整库：noteCount 没人读，却要为它 stat + 开几百个文件');
});

step('彻底删除一本书：状态表条目自动清掉，库内镜像只在他点头后才回收，别人的笔记一个字节不动', async (base, dataDir) => {
  const vault = path.join(dataDir, 'vault');
  const bookDir = path.join(vault, '工作台', '雾港');
  const foreign = path.join(vault, '工作台', '别人的笔记.md');
  const foreignText = readFileSync(foreign, 'utf-8');
  const st0 = await (await fetch(base + '/api/obsidian/status')).json();
  assert(st0.books?.some((b) => b.root === '雾港'), '前置：雾港还在状态表里');

  // 软删（进回收站）：那本书还能恢复，状态表条目必须留着
  const soft = (await (await fetch(base + '/api/data')).json()).projects[0];
  await fetch(base + '/api/data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projects: [{ ...soft, deletedAt: '2026-09-24T00:00:00.000Z' }] }),
  });
  const st1 = await (await fetch(base + '/api/obsidian/status')).json();
  assert(st1.books?.some((b) => b.root === '雾港'), '软删的书还能恢复，状态表条目不该被清');

  // 彻底删除（整包里没有它了）：状态表条目自动清掉，但库里的文件一个都不许动
  await fetch(base + '/api/data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projects: [] }),
  });
  const st2 = await (await fetch(base + '/api/obsidian/status')).json();
  assert(!st2.books?.some((b) => b.root === '雾港'), `彻底删除后状态表不该再列它：${JSON.stringify(st2.books)}`);
  const syncFile = JSON.parse(readFileSync(path.join(dataDir, 'obsidian-sync.json'), 'utf-8'));
  assert(!('雾港' in syncFile), '状态表文件里的条目没被清掉');
  assert(existsSync(bookDir), '删状态条目绝不能顺手删库——库内文件必须原样留着等用户决定');

  // 用户点头之后才回收：POST /api/obsidian/purge-book
  const gone = await fetch(base + '/api/obsidian/purge-book', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: '雾港' }),
  });
  assertEq(gone.status, 200, '回收状态码');
  assert((await gone.json()).removed > 0, '该真的删掉一些文件');
  assert(!existsSync(bookDir), '点头之后库里的书目录该整个消失');
  assert(existsSync(path.dirname(bookDir)), '库的子文件夹根（工作台）要留着');
  assert(readFileSync(foreign, 'utf-8') === foreignText, '同名目录之外的笔记一个字节没动');

  // 幂等：再回收一次不报错也不再删东西；带路径分隔符的 root 是越界企图，必须挡掉
  const again = await fetch(base + '/api/obsidian/purge-book', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root: '雾港' }) });
  assertEq((await again.json()).removed, 0, '再回收一次不该报错也不该再删东西');
  const evil = await fetch(base + '/api/obsidian/purge-book', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root: '../escape' }) });
  assertEq(evil.status, 400, '带路径分隔符的 root 必须被挡掉');
});

step('Obsidian 导入接口：认出我方导出的镜像、报字节数、超大文件挡在门外', async (base, dataDir) => {
  const put = (p, body) => fetch(base + p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const vault = path.join(dataDir, 'import-vault');
  mkdirSync(path.join(vault, '素材'), { recursive: true });
  // 一篇库里的原创笔记 + 一篇我方导出的镜像（带 wb-id）：镜像要能被认出来，并且沉在后面
  writeFileSync(path.join(vault, '素材', '原创.md'), '---\ntags: [场景]\n---\n\n原创的一句。\n', 'utf-8');
  writeFileSync(path.join(vault, '素材', '镜像.md'), '---\nwb-id: c9\nwb-kind: chapter\n---\n\n镜像正文。\n', 'utf-8');
  const huge = path.join(vault, '素材', '巨型.md');
  writeFileSync(huge, 'x'.repeat(4 * 1024 * 1024 + 64), 'utf-8');

  const cfg = await put('/api/obsidian/config', { vaultPath: vault, folder: '工作台' });
  assert(cfg.obsidian?.vaultPath, '库路径没换过来');
  const list = await (await fetch(base + '/api/obsidian/notes?q=')).json();
  const byName = Object.fromEntries((list.notes || []).map((n) => [n.name, n]));
  assert(byName['原创.md'] && byName['镜像.md'], `列表缺文件：${(list.notes || []).map((n) => n.name).join(',')}`);
  assertEq(byName['原创.md'].wb, false, '别人的笔记被误标成我方导出');
  assertEq(byName['镜像.md'].wb, true, '带 wb-id 的文件没被认出来');
  assert(byName['原创.md'].bytes > 40, `没报字节数：${JSON.stringify(byName['原创.md'])}`);
  const order = (list.notes || []).map((n) => n.name);
  assert(order.indexOf('原创.md') < order.indexOf('镜像.md'), `镜像该沉在原创笔记后面：${order.join(',')}`);

  const one = await (await fetch(base + '/api/obsidian/note?path=' + encodeURIComponent('素材/镜像.md'))).json();
  assertEq(one.wb, true, '读单篇没带身份信息');
  const big = await fetch(base + '/api/obsidian/note?path=' + encodeURIComponent('素材/巨型.md'));
  assertEq(big.status, 413, '超大文件的状态码');
  assert(/MB/.test((await big.json()).error || ''), '错误没说清上限是多少');
  const out = await fetch(base + '/api/obsidian/note?path=' + encodeURIComponent('../escape.md'));
  assertEq(out.status, 403, '越界读取该挡掉');

  // ⑤ 自动同步开关：默认关、只认严格 true，并且要能从 /api/data 带出来给界面
  const on = await put('/api/obsidian/config', { vaultPath: vault, folder: '工作台', autoSync: true });
  assertEq(on.obsidian.autoSync, true, '自动同步开关没存下来');
  const shown = await (await fetch(base + '/api/data')).json();
  assertEq(shown.obsidian.autoSync, true, '/api/data 没带出自动同步开关');
  const junk = await put('/api/obsidian/config', { vaultPath: vault, folder: '工作台', autoSync: 'yes' });
  assertEq(junk.obsidian.autoSync, false, '字符串「yes」不该算开');
  const off = await put('/api/obsidian/config', { vaultPath: vault, folder: '工作台' });
  assertEq(off.obsidian.autoSync, false, '缺字段必须算关——后台写盘不能是默认');
});

step('拆文对标：只回统计，脏值被清洗、超量被截断', async (base, dataDir) => {
  const chapters = Array.from({ length: 5 }, (_, i) => ({
    n: i + 1,
    title: '第' + (i + 1) + '章',
    chars: 1200 + i,
    sentences: 40,
    avgSentence: 18 + i,
    maxSentence: 60,
    dialogueShare: 42,
    pronounOpen: 3,
    paragraphs: 12,
    opener: '对白',
    endsOnTalk: i % 2 === 0,
    deslop: { 'not-but': 1, 'dai-zhe': 0 },
  }));
  const books = [
    { id: 'b1', title: '标杆书', createdAt: '2026-09-22T00:00:00.000Z', chapters },
    { id: 'b2', title: 'x'.repeat(80), createdAt: '', chapters: [{ n: -5, chars: -9, dialogueShare: 300, avgSentence: '很多', endsOnTalk: 'yes', deslop: '不是表' }] },
    { id: '', title: '缺 id 要丢', createdAt: '', chapters: [] },
    '不是对象',
    ...Array.from({ length: 21 }, (_, i) => ({ id: 'bx' + i, title: '第' + i + '本', createdAt: '', chapters: [] })),
  ];
  const w = await fetch(base + '/api/benchmarks', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ books }),
  });
  assertEq(w.status, 200, '写入状态码');
  const j = await (await fetch(base + '/api/benchmarks')).json();
  assert(Array.isArray(j.books), '应返回 books 数组');
  assertEq(j.books.length, 20, '最多留 20 本');
  assert(!j.books.some((b) => b.title === '缺 id 要丢'), '缺 id 的书被丢');
  const b1 = j.books.find((b) => b.id === 'b1');
  assertEq(b1.chapters.length, 5, '章节统计往返');
  assertEq(b1.chapters[1].avgSentence, 19, '句长往返');
  assertEq(b1.chapters[0].endsOnTalk, true, '布尔往返');
  assertEq(b1.chapters[0].deslop['not-but'], 1, 'AI 味计数往返');
  const b2 = j.books.find((b) => b.id === 'b2');
  assertEq(b2.title.length, 40, '书名截到 40 字符');
  assertEq(b2.chapters[0].n, 0, '负数归零');
  assertEq(b2.chapters[0].dialogueShare, 100, '对白占比封顶 100');
  assertEq(b2.chapters[0].avgSentence, 0, '非数字归零');
  assertEq(b2.chapters[0].endsOnTalk, false, '非布尔按 false');
  assertEq(JSON.stringify(b2.chapters[0].deslop), '{}', '非对象的计数表清成空表');
  assert(existsSync(path.join(dataDir, 'benchmarks.json')), 'benchmarks.json 独立落盘');
  const file = readFileSync(path.join(dataDir, 'benchmarks.json'), 'utf-8');
  assert(!file.includes('标杆书正文'), '落盘内容里不该有原文（只存统计）');
  const empty = await fetch(base + '/api/benchmarks', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ books: '不是数组' }) });
  assertEq(empty.status, 200, '脏请求不报错');
  assertEq((await (await fetch(base + '/api/benchmarks')).json()).books.length, 0, '脏请求把表清成空');
});

async function main() {
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), 'wb-smoke-'));
  const child = spawn(process.execPath, [serverJs], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, WB_MAX_BODY_MB: '2' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const base = `http://127.0.0.1:${port}`;

  try {
    // 等服务就绪（最多 15s）
    const t0 = Date.now();
    let ready = false;
    while (Date.now() - t0 < 15000) {
      try {
        const r = await fetch(base + '/api/data');
        if (r.ok) { ready = true; break; }
      } catch { /* 未就绪 */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!ready) throw new Error('server 启动超时\n' + out.slice(-2000));
    if (child.exitCode !== null) throw new Error('server 提前退出\n' + out.slice(-2000));

    console.log('API 冒烟（隔离数据目录，真实 HTTP）：');
    for (const { name, fn } of steps) {
      try {
        // 需要真实 vault 目录的步骤额外传 dataDir
        await fn(base, dataDir);
        console.log('  ✓ ' + name);
      } catch (err) {
        failures += 1;
        console.error('  ✗ ' + name + '\n      ' + (err?.message || err));
      }
    }
  } finally {
    child.kill();
    await new Promise((r) => child.once('exit', r));
    rmSync(dataDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\nAPI 冒烟失败：${failures} 项未通过`);
    process.exit(1);
  }
  console.log('\nAPI 冒烟全部通过。');
}

main().catch((err) => {
  console.error('API 冒烟执行异常:', err?.message || err);
  process.exit(1);
});
