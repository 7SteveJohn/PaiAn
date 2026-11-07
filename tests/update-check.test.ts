// 检查更新判据层的回归钉：新版本判定宁漏勿误——tag 读不懂一律不动。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewerVersion, parseTag } from '../server-lib/update-check.js';

test('isNewerVersion：常规比较、v 前缀、段数不齐补 0', () => {
  assert.equal(isNewerVersion('1.0.2', 'v1.0.3'), true);
  assert.equal(isNewerVersion('1.0.2', '1.0.2'), false, '相等不算新');
  assert.equal(isNewerVersion('1.0.3', '1.0.2'), false, '更旧不算新');
  assert.equal(isNewerVersion('1.0', '1.0.1'), true, '短版本补 0 后比较');
  assert.equal(isNewerVersion('1.0.2', 'v2'), true, '跳大版本');
  assert.equal(isNewerVersion('1.0.9', '1.0.10'), true, '数字比不是字典序');
  assert.equal(isNewerVersion('0.9', '1.0'), true);
});

test('isNewerVersion：读不懂的 tag 一律 false（宁漏勿误）', () => {
  assert.equal(isNewerVersion('1.0.2', 'beta'), false);
  assert.equal(isNewerVersion('1.0.2', 'v1.1.0-rc.1'), false, '预发布段不比，不误报');
  assert.equal(isNewerVersion('1.0.2', ''), false);
  assert.equal(isNewerVersion('', '1.0.3'), false, '当前版本读不到也不报');
  assert.deepEqual(parseTag(' v1.2.3 '), [1, 2, 3], '首尾空白与 v 前缀都剥掉');
});
