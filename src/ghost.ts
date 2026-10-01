// 幽灵字续写：从模型输出里挑出「可直接采纳的下一句」。
// 纯函数零依赖，交互逻辑在 CodeEditor（Tab 采纳）。

export const GHOST_SYSTEM = '你是续写引擎：只输出光标后的下一句正文，30 字以内，不解释，不重复已有文字。';

/**
 * 取第一句（遇 。！？… 或换行截断，句号保留）、≤30 字、剥掉开头 markdown 残留（# / * / 空白）。
 * 结果为空，或开头（≤10 字）原样重复了传入尾巴（tail）的结尾（模型在复读而不是续写），返回 ''。
 */
export function pickGhost(raw: string, tail = ''): string {
  if (!raw) return '';
  const s = raw.replace(/^[\s#*。！？…，、；：""''（）()【】\[\]—~\-]+/, '');
  if (!s) return '';
  const m = /[。！？…\n]/.exec(s);
  let sentence = m ? (m[0] === '\n' ? s.slice(0, m.index) : s.slice(0, m.index + 1)) : s;
  if (sentence.length > 30) sentence = sentence.slice(0, 30);
  sentence = sentence.replace(/\s+$/, '');
  if (!sentence) return '';
  // 复读检测：raw 开头与尾巴结尾重合（≥4 字就算），插进正文就是重复
  if (tail) {
    const t = tail.replace(/\s+$/, '');
    for (let k = Math.min(10, sentence.length); k >= 4; k--) {
      if (t.endsWith(sentence.slice(0, k))) return '';
    }
  }
  return sentence;
}
