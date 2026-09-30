// 出场记忆闭环冒烟：预置「章节模式 + 待采纳草稿」项目到隔离数据目录，起假上游返回固定的
// 记忆抽取 JSON（含一个故意造出的幻觉角色），注入 tests/ui-memory-drive.js 真实点击
// 「采纳为正文」，端到端验证：抽取 → 校验合并 → 人物卡写回落盘。
// 用法：npm run build && node tests/ui-memory-smoke.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { bundleDrive } from './ui-drive-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const drivePath = path.join(root, 'tests', 'ui-memory-drive.js');

if (!existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('缺少 dist/index.html，请先执行 npm run build');
  process.exit(1);
}

// ---------- 假上游：/chat/completions（openai 协议）。非流式返回固定记忆 JSON ----------
const MEMORY_JSON = JSON.stringify({
  memories: [
    {
      name: '林越',
      isNew: false,
      state: '在雾港码头认出夜航船的铁锈纹路，坐实了走私线',
      changeNote: '本章在雾港码头认船，坐实走私线',
      relations: [],
    },
    {
      name: '雾隐师',
      isNew: true,
      state: '迷雾中现身，自称受雇于下游买家',
      changeNote: '初登场：雾中拦下林越，警告他别再查这条线',
      relations: [{ with: '林越', note: '警告他别再查这条线' }],
    },
    // 故意注入的噪声：正文里没有「幽灵船长」，若 sanitize 的出场校验失效，它会混进卡册
    { name: '幽灵船长', isNew: true, state: '幽灵船上的船长', changeNote: '幽灵船初登场', relations: [] },
  ],
}, null, 0);

// 正文必须 ≥200 字（采纳后触发抽取的门槛）且包含：林越 / 雾隐师 / 阿禾（阿禾出场但记忆里不提 → 验证不误动）
const PENDING_TEXT =
  '雾港的雾一年里有三百天不肯散。林越沿着码头第七根缆桩往东走，靴底踩着湿漉漉的木板，发出闷响。夜里到港的那艘船没有名字，船头漆着铁锈色的纹路——和他在北岸仓库见到的印记一模一样。他蹲下来，指腹压过那道纹，凉意顺着指尖往上爬。\n\n' +
  '「别再往前了。」雾里有人说话，声音像隔着一层水。林越抬头，只见一道瘦长的影子立在栈桥尽头，看不清脸，雾却在那人周身绕开半步，仿佛不敢近身。那人自称雾隐师，说他受雇于下游的买家，专程来劝退所有还在查这条线的人。\n\n' +
  '林越没动：「劝退，还是灭口？」\n\n' +
  '雾隐师沉默了一会儿，说：「你运气好，今晚我不想沾血。」话落，雾合拢，人影消失。只有船头那枚铁锈纹还在雾里隐隐发亮。远处阿禾提着灯跑来，脸色发白：「我听说这船今晚要卸货，货在……」她没说完，因为雾里忽然传来一声钟响——那是整座雾港从没听过的声音。';

function startMock() {
  const seen = { requests: 0, lastStream: null };
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        seen.requests++;
        if (body.stream) {
          seen.lastStream = body.stream;
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: MEMORY_JSON } }] }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: MEMORY_JSON } }] }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, seen }));
  });
}

// ---------- 预置隔离数据目录 ----------
const dataDir = mkdtempSync(path.join(tmpdir(), 'wb-mem-'));
const driveScript = bundleDrive(dataDir, drivePath); // 公共助手 + 驱动，拼好写进隔离目录
const sample = (() => {
  try {
    const arr = JSON.parse(readFileSync(path.join(root, 'data', 'projects.json'), 'utf-8'));
    return arr[0];
  } catch {
    return null;
  }
})();

const ts = Date.now();
const now = new Date().toISOString();
const chapter = {
  id: 'mc-' + ts,
  title: '第一章 雾锁码头',
  content: '',
  pending: PENDING_TEXT,
  summary: '林越在雾港码头认出夜航船，遭雾隐师警告。',
  timeLabel: '',
  volume: '',
  beats: '雾港码头·认船 → 雾中拦路 → 阿禾报信 → 钟声',
  cast: '林越、雾隐师、阿禾',
  places: '雾港码头',
  hooks: '夜航船的走私线路与雾中钟声',
  createdAt: now,
  updatedAt: now,
};
// 牵线画布要的是「有几章、有伏笔」的常态项目：再备两章正文，图才牵得出东西
const chapter2 = {
  id: 'mc2-' + ts,
  title: '第二章 夜航',
  content: '林越已经是金丹。' + '她把它藏进袖子里，像藏一件与己无关的赃物。'.repeat(9),
  beats: '舱单少一页 → 船家改口',
  cast: '林越、阿禾',
  createdAt: now,
  updatedAt: now,
};
const chapter3 = {
  id: 'mc3-' + ts,
  title: '第三章 钟声',
  content: '林越的气息退回筑基中期。' + '钟声是从船底传来的，不敲在铜上，敲在水线上。'.repeat(9),
  beats: '钟响 → 雾散一角',
  cast: '雾隐师',
  createdAt: now,
  updatedAt: now,
};
const chapter4 = {
  id: 'mc4-' + ts,
  title: '第四章 复航',
  content: ['船长把名单拍在桌上。阿禾说：「少了一页。」', '他把舱单折成两截，只留下一行。'].join('\n').repeat(2),
  beats: '逼他交名单',
  cast: '林越、阿禾',
  createdAt: now,
  updatedAt: now,
};
const chapter5 = {
  id: 'mc5-' + ts,
  title: '第五章 起雾',
  content: ['雾又漫上栈桥。林越说：「开船。」', '阿禾把灯挪近了些。'].join('\n').repeat(2),
  beats: '开船',
  cast: '林越、阿禾',
  createdAt: now,
  updatedAt: now,
};
const project = sample
  ? {
      ...sample,
      title: '记忆冒烟' + ts,
      notes: '（出场记忆闭环自动冒烟用，隔离数据目录内，跑完即删）',
      draft: '',
      chapters: [chapter, chapter2, chapter3, chapter4, chapter5],
      // 用样的样例项目自带别的伏笔标记，这里换成能算账的那条：埋在第一章、埋点章确实在目录里
      marks: [{ id: 'mk-' + ts, type: '伏笔', start: 0, end: 5, text: '铁锈纹的来处', status: '埋下', chapterId: chapter.id, expected: '第二卷中段', createdAt: now }],
      characters: [
        {
          id: 'ch-lin-' + ts,
          name: '林越',
          state: '乘夜船追查走私线索',
          log: [{ at: now, text: '追踪夜航船走私线索' }],
          relations: [{ with: '阿禾', note: '伙伴' }],
        },
        { id: 'ch-he-' + ts, name: '阿禾', state: '跟随林越，负责望风', log: [], relations: [{ with: '林越', note: '伙伴' }] },
      ],
      worldItems: sample.worldItems ?? [],
    }
  : {
      id: 'mp-' + ts,
      title: '记忆冒烟' + ts,
      type: '小说',
      status: '写作中',
      deadline: '',
      target: 0,
      notes: '',
      draft: '',
      linkedIdeaIds: [],
      createdAt: now,
      updatedAt: now,
      mode: 'chapters',
      chapters: [chapter],
      marks: [{ id: 'mk-' + ts, type: '伏笔', start: 0, end: 5, text: '铁锈纹的来处', status: '埋下', chapterId: chapter.id, createdAt: now }],
      characters: [
        {
          id: 'ch-lin-' + ts,
          name: '林越',
          state: '乘夜船追查走私线索',
          log: [{ at: now, text: '追踪夜航船走私线索' }],
          relations: [{ with: '阿禾', note: '伙伴' }],
        },
        { id: 'ch-he-' + ts, name: '阿禾', state: '跟随林越，负责望风', log: [], relations: [{ with: '林越', note: '伙伴' }] },
      ],
      worldItems: [],
      branches: [],
      rollingSummary: undefined,
      breakpoint: undefined,
    };

mkdirSync(dataDir, { recursive: true });
writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project], null, 2), 'utf-8');

// ---------- 起假上游 → 写 ai.json → 拉起 Electron ----------
const { srv, port, seen } = await startMock();
const mockUrl = `http://127.0.0.1:${port}`;
writeFileSync(
  path.join(dataDir, 'ai.json'),
  JSON.stringify({ provider: 'mock', baseUrl: mockUrl, model: 'gpt-mock', protocol: 'openai', apiKey: '', rules: [], memoryExtract: true }, null, 2),
  'utf-8',
);

const electronDir = path.join(root, 'node_modules', 'electron');
const binName = readFileSync(path.join(electronDir, 'path.txt'), 'utf-8').trim();
const electronBin = path.join(electronDir, 'dist', binName);

const child = spawn(electronBin, [root, '--smoke-test', '--no-sandbox'], {
  cwd: root,
  env: { ...process.env, WB_DATA_DIR: dataDir, WB_SMOKE_SCRIPT: driveScript },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));

const timer = setTimeout(() => {
  console.error('✗ 出场记忆冒烟超时（90s）\n--- 输出 ---\n' + out.slice(-2000));
  child.kill();
  srv.close();
  setTimeout(() => process.exit(1), 500);
}, 90000);

function finish(code, message) {
  clearTimeout(timer);
  try { srv.close(); } catch { /* ignore */ }
  rmSync(dataDir, { recursive: true, force: true });
  console.log(message);
  process.exit(code);
}

child.on('exit', (code) => {
  const ok = code === 0 && out.includes('[smoke] OK');
  if (!ok) {
    return finish(1, `✗ 出场记忆冒烟失败（退出码 ${code}）\n--- 输出摘录 ---\n${out.slice(-2500)}`);
  }
  const line = out.split('\n').find((l) => l.includes('[smoke] OK')) || '';
  const up = seen.requests > 0 ? `，假上游收到 ${seen.requests} 次抽取请求` : '（假上游未被调用！）';
  const body = line.includes('记忆闭环通过')
    ? line.split('记忆闭环通过：')[1]?.trim()
    : line.replace('[smoke] OK', '').trim();
  finish(0, `✓ 出场记忆闭环通过${up}\n  ${body || line.trim()}\n  （数据目录 ${dataDir} 已清理，未触碰真实数据）`);
});
