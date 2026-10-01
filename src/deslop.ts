// AI 味自检：确定性句式/词表扫描，零依赖、零 token、不联网。
// 规则类别参考 oh-story-claudecode（MIT）的 story-deslop 禁用词表，条目为本项目自行整理，
// 判据全部可在回归测试里直接断言（与 health.ts 同一套取向：宁少勿滥）。
//
// 两处刻意的取舍：
// 1) 引号内的命中一律不报——「不是A，而是B」这类句式出现在对白里是正常中文，
//    提示层针对的是叙述腔，误伤对白比漏报更烦人。
// 2) 只报原文区间，不改写。改不改、怎么改由作者决定（与「辅助不替代」一致）。

export interface DeslopRule {
  key: string;
  label: string;
  level: 2 | 3 | 4 | 5; // 毒级：5 = 一养成就会反复出现，最该先清
  fix: string;
  re: RegExp;
}

export const DESLOP_RULES: DeslopRule[] = [
  {
    key: 'not-but',
    label: '不是A，而是B',
    level: 5,
    fix: '直接写 B，或换个不绕的说法；这种句子是在替读者下结论。',
    re: /不[是像][^，。！？；\n]{1,18}[，,](?:而)?是/g,
  },
  {
    key: 'dai-zhe',
    label: '「，带着…」万能状语',
    level: 4,
    fix: '删掉状语留主句，或把情绪换成一个具体动作。',
    re: /[，,]带着[^。！？；\n]{1,18}/g,
  },
  {
    key: 'flat-voice',
    label: '「声音不大却…」无情绪声线',
    level: 4,
    fix: '直接写台词内容、音色的具体特征，或说话时的动作。',
    re: /(?:声音不大|声音平(?:直|淡)|语气(?:毫|并)无|毫无(?:波澜|起伏)|不起丝毫波澜|平静无波|听不出(?:任何)?(?:情绪|波动))/g,
  },
  {
    key: 'shadow',
    label: '「一丝…划过/掠过」',
    level: 3,
    fix: '写具体的表情或身体反应，别用抽象的量词。',
    re: /(?:一丝|一抹|一缕|些许)[^。！？\n]{0,10}?(?:划过|掠过|浮上|染上|爬上|闪过)/g,
  },
  {
    key: 'as-if',
    label: '「仿佛…一般」书面腔',
    level: 3,
    fix: '改成直陈，或换一个属于这个人物视角的具体意象。',
    re: /(?:仿佛|犹如|宛若|好似)[^。！？\n]{0,22}?(?:一般|一样|似的|那般)/g,
  },
  {
    key: 'tell-knows',
    label: '「他知道…」直白告知',
    level: 3,
    fix: '用行为、感官或取舍把这份认知演出来。',
    re: /(?:他|她|它)(?:也|都|心里|心里明白)?知道[^。！？\n]{0,16}/g,
  },
  {
    key: 'summary',
    label: '段首总结式评论',
    level: 3,
    fix: '删掉评论句，让画面自己收尾；作者别站出来讲话。',
    re: /(?:^|\n)(?:总之|毫无疑问|不得不说|值得一提的是|可想而知|很显然)/g,
  },
  {
    key: 'em-dash',
    label: '破折号成对插入语',
    level: 2,
    fix: '拆成两句，或干脆删掉插入语。',
    re: /——[^。！？\n]{2,20}——/g,
  },
  {
    key: 'le-xia',
    label: '「…了一下」尾巴密集',
    level: 2,
    fix: '多数可删掉「了一下」，或换成单个动词。',
    re: /(?:笑|点|顿|停|默|愣|皱|抿|抬|侧|叹|晃|颤)了一下/g,
  },
  {
    key: 'triple',
    label: '三连以上排比并列',
    level: 2,
    fix: '留最狠的那一个；并列越多越像模板。',
    re: /[^。！？\n；]{3,20}；[^。！？\n；]{3,20}；[^。！？\n；]{3,20}；/g,
  },
];

export interface DeslopHit {
  start: number;
  end: number;
  key: string;
  label: string;
  level: number;
  fix: string;
  text: string;
}

export interface DeslopGroup {
  key: string;
  label: string;
  level: number;
  fix: string;
  count: number;
  samples: string[]; // 命中的原句片段（最多 3 段，供界面直接列出来）
}

export interface DeslopReport {
  chars: number;
  hits: DeslopHit[];
  per1k: number; // 每千字命中数（跨章可比的口径）
  groups: DeslopGroup[]; // 按「毒级×次数」降序，最该先改的排前面
}

const byKey = new Map(DESLOP_RULES.map((r) => [r.key, r]));

// 引号（「」／“”／‘’）覆盖的区间：约束求值与 AI 味判定都用它把对白排除在外
export function quoteRanges(text: string): [number, number][] {
  const pairs: [string, string][] = [
    ['「', '」'],
    ['『', '』'],
    ['“', '”'],
    ['‘', '’'],
  ];
  const out: [number, number][] = [];
  for (const [open, close] of pairs) {
    let from = text.indexOf(open);
    while (from >= 0) {
      const to = text.indexOf(close, from + open.length);
      if (to < 0 || to - from > 600) break; // 未闭合或跨度过长：视为引文/坏数据，不做屏蔽
      out.push([from, to + close.length]);
      from = text.indexOf(open, to + close.length);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

export function inQuote(ranges: [number, number][], start: number, end: number): boolean {
  const mid = (start + end) >> 1;
  for (const [a, b] of ranges) {
    if (mid >= a && mid <= b) return true;
    if (a > mid) break;
  }
  return false;
}

// 单次全量扫描。长书按章调用，不一次喂整本书。
export function scanDeslop(text: string): DeslopHit[] {
  if (!text) return [];
  const quotes = quoteRanges(text);
  const hits: DeslopHit[] = [];
  for (const rule of DESLOP_RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      if (!m[0]) {
        rule.re.lastIndex++; // 防空转（理论上不会发生，兜住）
        continue;
      }
      // 段首类规则的匹配可能带上前导换行，装饰区间收窄到关键词本身
      let start = m.index;
      let end = m.index + m[0].length;
      if (text[start] === '\n') start += 1;
      if (inQuote(quotes, start, end)) continue;
      hits.push({ start, end, key: rule.key, label: rule.label, level: rule.level, fix: rule.fix, text: text.slice(start, end) });
      if (rule.re.lastIndex === m.index) rule.re.lastIndex = end;
    }
  }
  hits.sort((a, b) => a.start - b.start || b.level - a.level);
  // 同一段文字可能被多条规则命中，只留毒级最高的那条，避免界面重复刷屏
  const kept: DeslopHit[] = [];
  for (const h of hits) {
    const last = kept[kept.length - 1];
    if (last && h.start < last.end) {
      if (h.level > last.level) kept[kept.length - 1] = h;
      continue;
    }
    kept.push(h);
  }
  return kept;
}

export function summarizeDeslop(text: string): DeslopReport {
  const hits = scanDeslop(text);
  const chars = text.length;
  const agg = new Map<string, DeslopGroup>();
  for (const h of hits) {
    let g = agg.get(h.key);
    if (!g) {
      const rule = byKey.get(h.key)!;
      g = { key: h.key, label: rule.label, level: rule.level, fix: rule.fix, count: 0, samples: [] };
      agg.set(h.key, g);
    }
    g.count++;
    if (g.samples.length < 3 && !g.samples.includes(h.text)) g.samples.push(h.text);
  }
  return {
    chars,
    hits,
    per1k: chars > 0 ? Math.round((hits.length / (chars / 1000)) * 10) / 10 : 0,
    groups: [...agg.values()].sort((a, b) => b.level - a.level || b.count - a.count),
  };
}
