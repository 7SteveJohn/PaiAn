// 导入素材的预处理：把「一坨来源文本」变成干净正文，以及来源路径那笔账。
// 放在组件外面是因为这几条都必须能断言——尤其是批注区那个标记串，它跟 server-lib/obsidian.js
// 里的必须一字不差，两边不一致就会哪天悄悄把批注当正文导进来（tests/obsidian-import.test.ts 钉着这条）。
//
// 落点判据、书名推断、要点拼接不在这里，它们在 import-plan.ts（那是「导到哪里去」的事）。

/** 我方同步文件里批注区的分隔标记（与 server-lib/obsidian.js 的 NOTES_MARK 同值） */
export const NOTES_MARK = '<!-- wb-notes -->';

/** 预览截断长度：一篇几十章的镜像文件不该整个塞进 <pre> */
export const PREVIEW_CAP = 12000;

/**
 * 导入前整理正文：剥掉 YAML 属性区（Obsidian 生态的通行做法），
 * 再剥掉我方维护的批注区——那是「他在库里写的旁注」，不是素材正文。
 */
export function prepareForImport(text: string): { content: string; droppedFrontmatter: boolean; droppedNotes: boolean } {
  // Obsidian 在 Windows 上按 CRLF 存盘：换行统一成 LF 再进库，
  // 否则 \r 会一路跟着 JSON 存进卡片，之后到处是看不见的差异
  let body = String(text ?? '').replace(/\r\n/g, '\n');
  let droppedFrontmatter = false;
  let droppedNotes = false;
  const fm = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/.exec(body);
  if (fm) {
    body = body.slice(fm[0].length);
    droppedFrontmatter = true;
  }
  const at = body.indexOf(NOTES_MARK);
  if (at >= 0) {
    body = body.slice(0, at);
    droppedNotes = true;
  }
  return { content: body.replace(/\s+$/, '').replace(/^\s+/, ''), droppedFrontmatter, droppedNotes };
}

/** 预览用的截断：明确告诉他截了，导入的是全文 */
export function previewOf(content: string, cap = PREVIEW_CAP): { text: string; truncated: boolean } {
  return content.length <= cap ? { text: content, truncated: false } : { text: content.slice(0, cap), truncated: true };
}

/** 每个来源标识已经导入过几条（用来提醒「这篇导过了」，而不是让人凭记忆数） */
export function importedCounts(ideas: { src?: string }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of ideas) {
    if (!i.src) continue;
    m.set(i.src, (m.get(i.src) ?? 0) + 1);
  }
  return m;
}

/** 实体名取文件名去 .md；库里常见「2026-01-01 随手记」这种名字，截一下就行，不猜内容 */
export function entityNameOf(path: string): string {
  const base = String(path ?? '').split(/[\\/]/).pop() ?? '';
  const name = base.replace(/\.(md|markdown|txt|text|docx|html?)$/i, '').replace(/^\d{4}-\d{2}-\d{2}\s+/, '').trim();
  return name || '未命名';
}
