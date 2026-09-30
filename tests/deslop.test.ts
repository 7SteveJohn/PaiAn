// AI 味扫描的回归锚点：既要命中模板句式，更要保证不把正常中文和白带进去。
// 规则表来自 oh-story-claudecode（MIT）的句式类别，这里是本项目自写的判据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DESLOP_RULES, scanDeslop, summarizeDeslop } from '../src/deslop';

const keys = (text: string) => new Set(scanDeslop(text).map((h) => h.key));

test('命中：不是A，而是B / 不是A，是B（省略「而」也算）', () => {
  assert.ok(keys('他不是冷漠，而是绝望。').has('not-but'));
  assert.ok(keys('这不是运气，是筹码。').has('not-but'));
});

test('不误伤：转折「但是」与并列陈述不算命中', () => {
  assert.ok(!keys('他想走，但是没有门。').has('not-but'));
  assert.ok(!keys('门开着，灯也亮着。').has('not-but'));
});

test('命中：万能状语 / 无情绪声线 / 量词影子 / 仿佛…一般', () => {
  const k = keys('她笑了一下，带着一丝不易察觉的嘲讽。他声音不大，却带着不容置疑的力量。仿佛能穿透夜色一般。一丝犹豫掠过心头。');
  for (const key of ['dai-zhe', 'flat-voice', 'shadow', 'as-if']) assert.ok(k.has(key), `应命中 ${key}，实际 ${[...k].join(',')}`);
});

test('命中：段首总结、破折号插入语、三连排比、告知式心理', () => {
  assert.ok(keys('\n总之，这一夜谁都没有睡。').has('summary'));
  assert.ok(keys('他留下一句话——那是他唯一的请求——然后转身。').has('em-dash'));
  assert.ok(keys('铁路在左；废墟在右；风声在头顶；谁都没有说话。').has('triple'));
  assert.ok(keys('他知道这一切都来不及了。').has('tell-knows'));
});

test('引号内的对白不报（正常口语不该被当 AI 味）', () => {
  const quoted = keys('她抬起头：「他不是冷漠，而是绝望。」');
  assert.ok(!quoted.has('not-but'), `对白里的句式不该报，实际命中 ${[...quoted].join(',')}`);
  // 同一句放在叙述里就要报
  assert.ok(keys('她抬起头，他不是冷漠，而是绝望。').has('not-but'));
});

test('同一处文字被多条规则命中时，只保留毒级最高的一条', () => {
  const hits = scanDeslop('夜里很静，一丝不安划过他的心头。');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].key, 'shadow');
});

test('正常叙述不误报', () => {
  const clean = '火车进港时天还没亮。她把信塞回袖子里，数着站台上的灯。第三个人回头看了一眼，又转回去。';
  assert.deepEqual(scanDeslop(clean), []);
});

test('空文本与短文本不炸，规则表自身完整', () => {
  assert.deepEqual(scanDeslop(''), []);
  assert.deepEqual(scanDeslop('不'), []);
  for (const r of DESLOP_RULES) {
    assert.ok(r.re.global, `${r.key} 缺少 g 标志`);
    assert.ok(r.label && r.fix && r.level >= 2 && r.level <= 5, `${r.key} 元信息不全`);
  }
});

test('summarizeDeslop：每千字口径与排序（毒级×次数在前）', () => {
  const text = '他不是犹豫，而是害怕。她笑了一下，带着一丝勉强。' + '车厢很闷，窗上的雾凝成一线，往下淌。'.repeat(20);
  const r = summarizeDeslop(text);
  assert.equal(r.chars, text.length);
  assert.equal(r.hits.length, 3);
  assert.equal(r.groups[0].level, 5, '最毒的一条排在最前');
  assert.equal(r.groups[0].key, 'not-but');
  assert.ok(r.per1k > 0 && r.per1k < 100, `每千字密度应在合理区间，实际 ${r.per1k}`);
  assert.ok(r.groups[0].samples.length >= 1 && r.groups[0].samples[0].includes('不是'), '要带原句片段供界面列出');
});

test('性能：百万字级整本按章扫描有上限（不得在长书上失控）', () => {
  const tail = '他不是不怕，是没有时间怕。';
  const chapter = ('雾从海面上漫过来，漫过缆桩、漫过湿透的缆绳。'.repeat(120).slice(0, 2500 - tail.length) + tail);
  const book = Array.from({ length: 400 }, (_, i) => chapter.replace('漫过来', `漫过来${i}`)).join('\n\n');
  assert.ok(book.length > 900000, `样本应接近百万字，实际 ${book.length}`);
  assert.equal(chapter.length, 2500, '每章固定 2500 字，贴近真实网文单章');
  const t0 = performance.now();
  let hits = 0;
  for (const ch of book.split('\n\n')) hits += scanDeslop(ch).length;
  const ms = performance.now() - t0;
  assert.ok(hits >= 400, `每章都应命中一次「不是…而是」，实际 ${hits}`);
  assert.ok(ms < 200, `400 章整本扫描应在毫秒级，实测 ${ms.toFixed(0)}ms`);
  console.log(`      （400 章 × 2500 字整本扫描 ${ms.toFixed(0)}ms，命中 ${hits} 处）`);
});
