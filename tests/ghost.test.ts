// 幽灵字续写的挑句逻辑：截句、截断、剥残留、复读拒绝。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GHOST_SYSTEM, pickGhost } from '../src/ghost';

test('GHOST_SYSTEM 说清只出下一句与字数上限', () => {
  assert.ok(GHOST_SYSTEM.includes('下一句'), GHOST_SYSTEM);
  assert.ok(GHOST_SYSTEM.includes('30 字'), GHOST_SYSTEM);
});

test('截句：遇到句号收句，句号保留，后面的不要', () => {
  assert.equal(pickGhost('他推门进来。屋里的灯还亮着。'), '他推门进来。');
});

test('截句：换行也截断，换行符本身不进句子', () => {
  assert.equal(pickGhost('他抬起头\n第二行'), '他抬起头');
});

test('超过 30 字截到 30 字', () => {
  const long = '一二三四五六七八九十'.repeat(3) + '。多余的';
  const g = pickGhost(long);
  assert.equal(g.length, 30);
  assert.ok(!g.includes('多余的'));
});

test('空串与剥掉 markdown 残留后为空的都返回空', () => {
  assert.equal(pickGhost(''), '');
  assert.equal(pickGhost('###'), '');
  assert.equal(pickGhost('  \n '), '');
});

test('剥掉开头的 # 与 * 残留再取句', () => {
  assert.equal(pickGhost('## 他推门进来。'), '他推门进来。');
  assert.equal(pickGhost('* 雾更浓了。'), '雾更浓了。');
});

test('开头重复传入尾巴的结尾：拒绝（模型在复读而不是续写）', () => {
  const tail = '夜色沉下来，他推门进来，屋里一片漆黑，';
  assert.equal(pickGhost('屋里一片漆黑，他伸手去摸开关。', tail), '');
  assert.equal(pickGhost('他推门进来，说今天不回去了。', '夜色沉下来，他推门进来，'), '');
});

test('正常续写不被误杀', () => {
  const tail = '夜色沉下来，他推门进来，';
  assert.equal(pickGhost('屋里比外头还冷。', tail), '屋里比外头还冷。');
});

test('pickGhost：开头是标点时先剥掉（模型先吐了句号的情形）', () => {
  assert.equal(pickGhost('。接下来他往码头走。'), '接下来他往码头走。');
  assert.equal(pickGhost('，、""开局一句台词。'), '开局一句台词。');
});

test('pickGhost：整段全是标点返回空串', () => {
  assert.equal(pickGhost('。。。！！！'), '');
});

test('pickGhost：开头是标点时先剥掉（模型先吐了句号的情形）', () => {
  assert.equal(pickGhost('。接下来他往码头走。'), '接下来他往码头走。');
  assert.equal(pickGhost('，、""开局一句台词。'), '开局一句台词。');
});

test('pickGhost：整段全是标点返回空串', () => {
  assert.equal(pickGhost('。。。！！！'), '');
});
