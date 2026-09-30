// 卡池抽卡的 UI 冒烟：起真实 Electron（隐藏窗口 + 隔离数据目录），注入 tests/ui-gacha-drive.js，
// 让它真点一遍「进卡池 → 抽一张（动效层翻开）→ 收下 → 去写作页 → 打出手牌 → 等自动保存 → 回读校验」，
// 断言卡牌效果真的改到了落库数据。npm test 只测纯函数与存储，界面接缝靠这条兜住。
// 用法：npm run build && npm run test:ui:gacha
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleDrive } from './ui-drive-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const drivePath = path.join(root, 'tests', 'ui-gacha-drive.js');

if (!existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('缺少 dist/index.html，请先执行 npm run build');
  process.exit(1);
}

const electronDir = path.join(root, 'node_modules', 'electron');
const binName = readFileSync(path.join(electronDir, 'path.txt'), 'utf-8').trim();
const electronBin = path.join(electronDir, 'dist', binName);
const dataDir = mkdtempSync(path.join(tmpdir(), 'wb-gacha-ui-'));
const driveScript = bundleDrive(dataDir, drivePath); // 公共助手 + 驱动，拼好写进隔离目录

// 预置：一部两章的书（一章已写一章未写）、足够抽 25 次的净产字数、手里三张已知卡
// 固定手牌是为了让断言可判定——随机抽到的卡面没法预知，打出的效果与达成率却必须能核对：
// 顺序固定：n01（零条件·写要点）→ n02（词表条件）→ x01（句长节奏条件），
// 这样「合成最左两卡」得到的组合只带 n02 那一条词表条件，打字即可达成，断言才稳
const body = '雾港的雾一年里有三百天不肯散。林越沿着码头第七根缆桩往东走，靴底踩着湿木板。';
// 笔触漂移要「前段」和「最近」两种明显不同的写法才测得出方向：
// 前段几章对白密、句子短；末尾几章几乎全是长句叙述。两边都过 150 字的可用章门槛。
const talkBody = ['「卸货。」她把手背到身后。', '「几时走？」他问。', '「天亮前，走了就不回头。」', '她把舱单折成四折，塞进他上衣口袋。', '「别弄丢。」', '「我丢了半条命。」他说。', '「你先上船。」她补充。'].join('\n').repeat(2);
const narrBody =
  '船舱里的灯油味压住了外头的咸腥，他靠着货堆坐下来，听着头顶木板缝隙里漏下来的水声一下一下敲在空桶上，那声音起初还慢，后来竟和某种他熟悉的节奏对上了，于是他在黑暗里想起很久以前那条没有航标的航线，想起那时也这样，所有人都说雾会散，可没有一个人肯说清什么时候散。' +
  '雾从板缝里一点一点挤进来，把灯芯的火苗压成一小团青蓝色，照着舱单上那行他念了三遍也没念对的名字，他一直念到舵楼那边传来脚步声才停下。';
const project = {
  id: 'pg1',
  title: '卡池冒烟书',
  type: '小说',
  status: '写作中',
  deadline: '',
  notes: '既有备注',
  draft: '',
  linkedIdeaIds: [],
  mode: 'chapters',
  chapters: [
    { id: 'gc1', title: '第一章 到港', content: '林越一步踏入金丹，全场无人说话。' + body.repeat(4), beats: '原有要点：认出铁锈纹', createdAt: '', updatedAt: '' },
    { id: 'gc2', title: '第二章 卸货', content: '', createdAt: '', updatedAt: '' },
    // 拆文对标要「两边各 ≥3 章」才比得出名堂，所以多备几章有正文的
    { id: 'gc3', title: '第三章 清点', content: body.repeat(2), createdAt: '', updatedAt: '' },
    { id: 'gc4', title: '第四章 封口', content: body.repeat(2), createdAt: '', updatedAt: '' },
    { id: 'gc5', title: '第五章 天亮', content: '林越的气息退回筑基中期。' + body.repeat(2), createdAt: '', updatedAt: '' },
    // 门禁要看的是「选中的待写章里有没有细纲」，所以再备两章空白待写：
    // gc6 有要点（可放行），gc7 没有（该被拦）
    { id: 'gc6', title: '第六章 复航', content: '', beats: '船长逼他把名单交出来，他反过来问了第一个问题', createdAt: '', updatedAt: '' },
    { id: 'gc7', title: '第七章 起雾', content: '', createdAt: '', updatedAt: '' },
    // 笔触漂移用：前三章是「对白密、句子短」的旧笔触，最后三章换成「长句叙述」，
    // 这样「最近几章 vs 惯常」才真的偏，掉出「找回」卡
    { id: 'gc8', title: '第八章 交舱单', content: talkBody, createdAt: '', updatedAt: '' },
    { id: 'gc9', title: '第九章 清点', content: talkBody, createdAt: '', updatedAt: '' },
    { id: 'gc10', title: '第十章 开船', content: talkBody, createdAt: '', updatedAt: '' },
    { id: 'gc11', title: '第十一章 舱底', content: narrBody, createdAt: '', updatedAt: '' },
    { id: 'gc12', title: '第十二章 航标', content: narrBody, createdAt: '', updatedAt: '' },
    { id: 'gc13', title: '第十三章 散雾', content: narrBody, createdAt: '', updatedAt: '' },
  ],
  characters: [{ id: 'k1', name: '林越', state: '怀疑走私线', log: [], relations: [] }],
  worldItems: [{ id: 'w1', name: '夜航船', kind: '地点', content: '每晚十点进港' }],
  marks: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project], null, 2), 'utf-8');
writeFileSync(path.join(dataDir, 'stats.json'), JSON.stringify({ daily: { '2026-09-20': 25000 }, reflection: '', dailyGoal: 0 }, null, 2), 'utf-8');
writeFileSync(path.join(dataDir, 'gacha.json'), JSON.stringify({ pulls: 0, sincePity: 0, ink: 0, usedWords: 0, hand: ['n01', 'n02', 'x01'], owned: {}, applied: {}, lit: {} }, null, 2), 'utf-8');

const child = spawn(electronBin, [root, '--smoke-test', '--no-sandbox'], {
  cwd: root,
  env: { ...process.env, WB_DATA_DIR: dataDir, WB_SMOKE_SCRIPT: driveScript },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));

const finish = (code, msg) => {
  clearTimeout(timer);
  rmSync(dataDir, { recursive: true, force: true });
  console.log(msg);
  process.exit(code);
};
const timer = setTimeout(() => {
  child.kill();
  finish(1, '✗ 卡池 UI 冒烟超时（120s）\n--- 输出摘录 ---\n' + out.slice(-2500));
}, 120000);

child.on('exit', () => {
  const line = out.split('\n').find((l) => l.includes('[smoke] OK')) || '';
  if (!line) return finish(1, '✗ 卡池 UI 冒烟失败\n--- 输出摘录 ---\n' + out.slice(-2500));
  finish(0, '✓ 卡池抽卡 UI 冒烟通过\n  ' + (line.split('UI 主路径：')[1] || line).trim());
});
