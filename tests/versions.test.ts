// 快照侧车存储的纯函数回归：自动保存只发正文，快照单独发，所以「剥/收/指纹」三步必须自洽。
// 背景：实测 500 章的书里历史快照占保存 payload 的 93%，整包反复重写既撞请求体上限也拖慢每一拍。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Project, ProjectVersion } from '../src/types';
import { chapterKey, flattenVersions, mergeVersionsInto, pickVersionWrites, signatureOf, stripVersions, unionVersions, versionSignatures } from '../src/versions';

// 份数上限在客户端与服务端各写一份（server.js 不能 import TS 源码），
// 两边漂了不会有报错，只会表现为「界面显示 20 份、落盘被截成更少」这类查半天的怪事。
test('MAX_VERSIONS：客户端与服务端必须同值（防两处常量悄悄漂移）', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pick = (file: string) => {
    const src = readFileSync(path.join(root, file), 'utf-8');
    const m = src.match(/MAX_VERSIONS\s*=\s*(\d+)/);
    assert.ok(m, `${file} 里找不到 MAX_VERSIONS`);
    return Number(m[1]);
  };
  assert.equal(pick('src/versions.ts'), pick('server-lib/schema.js'), '快照份数上限两处不一致');
  assert.equal(pick('src/App.tsx'), pick('server-lib/schema.js'), '快照份数上限三处不一致');
});

const snap = (at: string, words: number): ProjectVersion => ({ at, words, text: '旧稿' + at });

function mkProject(patch: Partial<Project> & { id: string }): Project {
  return {
    title: '书',
    type: '小说',
    status: '写作中',
    deadline: '',
    notes: '',
    draft: '',
    linkedIdeaIds: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...patch,
  };
}

const withVersions = mkProject({
  id: 'p1',
  draft: '单文档正文',
  versions: [snap('2026-09-01 10:00', 12), snap('2026-09-02 10:00', 34)],
  mode: 'chapters',
  chapters: [
    { id: 'c1', title: '第一章', content: '甲', versions: [snap('2026-09-03 09:00', 5)], createdAt: '', updatedAt: '' },
    { id: 'c2', title: '第二章', content: '乙', createdAt: '', updatedAt: '' },
  ],
});

const plain = mkProject({ id: 'p2', title: '无快照的书', draft: '只有正文' });

test('stripVersions：快照被剥掉，正文与其它字段原样保留', () => {
  const bare = stripVersions([withVersions, plain])[0];
  assert.equal(bare.versions, undefined);
  assert.equal(bare.chapters?.[0].versions, undefined);
  assert.equal(bare.chapters?.[0].content, '甲');
  assert.equal(bare.chapters?.[1].content, '乙');
  assert.equal(bare.title, '书');
  assert.equal(bare.draft, '单文档正文');
});

test('stripVersions：没有快照的项目/章节保持原对象引用（不必无谓复制整本书）', () => {
  const [p2] = stripVersions([plain]);
  assert.equal(p2, plain);
  const chapters = withVersions.chapters!;
  const stripped = stripVersions([withVersions])[0];
  assert.equal(stripped.chapters?.[1], chapters[1], '无快照的第 2 章应保持同一引用');
  assert.notEqual(stripped.chapters?.[0], chapters[0], '有快照的第 1 章需要新对象');
});

test('flattenVersions：按 key 摊平，只收真有的快照', () => {
  const flat = flattenVersions([withVersions, plain]);
  assert.deepEqual(Object.keys(flat).sort(), ['p1', 'p1::c1']);
  assert.equal(flat['p1'].length, 2);
  assert.equal(flat[chapterKey('p1', 'c1')][0].text, '旧稿2026-09-03 09:00');
  assert.equal(flat['p2'], undefined, '全无快照的作品不进表');
  assert.equal(Object.keys(flattenVersions([withVersions], new Set(['p2']))).length, 0, 'only 之外的作品一条都不发');
});

test('mergeVersionsInto：读回来能挂回原位，且不就地改写原对象', () => {
  const flat = flattenVersions([withVersions]);
  const bare = stripVersions([withVersions])[0];
  assert.equal(bare.chapters?.[0].versions, undefined);
  const back = mergeVersionsInto([bare, plain], flat)[0];
  assert.equal(back.versions?.length, 2);
  assert.equal(back.chapters?.[0].versions?.length, 1);
  assert.equal(back.chapters?.[1].versions, undefined, '没快照的章不凭空长出快照');
  assert.equal(plain.chapters, undefined, '另一本书保持不动');
  assert.equal(withVersions.chapters?.[0].versions?.length, 1, '原对象不被就地改写');
});

test('unionVersions：按时间去重、升序、裁到上限', () => {
  const a = [snap('2026-09-03 09:00', 5)];
  const b = [snap('2026-09-01 10:00', 12), snap('2026-09-03 09:00', 5), snap('2026-09-04 08:00', 7)];
  const merged = unionVersions(a, b);
  assert.deepEqual(merged.map((v) => v.at), ['2026-09-01 10:00', '2026-09-03 09:00', '2026-09-04 08:00']);
  assert.equal(unionVersions(Array(25).fill(0).map((_, i) => snap('2026-09-0' + (1 + (i % 8)) + ' 10:0' + i, i)), []).length, 20, '上限 20 份');
  assert.deepEqual(unionVersions(), [], '两边都没有也不炸');
});

test('signatureOf：同一份快照稳定，回滚追加能察觉', () => {
  const base = signatureOf(withVersions.versions!);
  assert.equal(signatureOf(structuredClone(withVersions.versions!)), base);
  assert.notEqual(signatureOf([...withVersions.versions!, snap('2026-09-05 07:00', 99)]), base, '追加一条要变');
  const rolled = [withVersions.versions![1], snap('2026-09-05 07:00', 99)];
  assert.notEqual(signatureOf(rolled), base, '被上限截断后份数不变，时间/字数要兜住');
});

test('pickVersionWrites：只发变了的 key，没读过的绝不发', () => {
  const flat = flattenVersions([withVersions]);
  const sigs = versionSignatures(flat);
  const loaded = new Set(['p1']);
  const sentEmpty = new Map<string, string>();
  let r = pickVersionWrites(flat, sentEmpty, {}, loaded);
  assert.deepEqual(Object.keys(r.changed).sort(), ['p1', 'p1::c1'], '第一次两条都要发');
  assert.deepEqual(r.need, []);
  r = pickVersionWrites(flat, sigs, {}, loaded);
  assert.deepEqual(r.changed, {}, '全部发过且没变，就一条都不发');

  const appended = structuredClone(withVersions);
  appended.chapters![1].versions = [snap('2026-09-04 08:00', 7)];
  const later = flattenVersions([appended]);
  r = pickVersionWrites(later, sigs, {}, loaded);
  assert.deepEqual(Object.keys(r.changed), ['p1::c2'], '只有新增的那条要发');

  // 关键护栏：没读过的作品即便内存里有快照，也不能顶掉磁盘上那 20 份
  const other = structuredClone(withVersions);
  other.id = 'p9';
  delete other.versions;
  other.chapters = [{ id: 'c9', title: '章', content: '甲', versions: [snap('2026-09-04 08:00', 7)], createdAt: '', updatedAt: '' }];
  const ofOther = flattenVersions([other]);
  r = pickVersionWrites(ofOther, new Map(), { 'p9::c9': 20 }, new Set());
  assert.deepEqual(r.changed, {}, '服务端已有 20 份而我们没读过 → 一条都不发');
  assert.deepEqual(r.need, ['p9'], '但要去把 p9 读回来，下一拍自愈');
  r = pickVersionWrites(ofOther, new Map(), {}, new Set());
  assert.deepEqual(Object.keys(r.changed), ['p9::c9'], '服务端本来就是空的 key 允许直接写');
});
