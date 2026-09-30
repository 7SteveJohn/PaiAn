// AI 提示词层：动作清单、每个动作拼出的消息、以及「本次到底送了哪段文本」的范围计算。
// 放在组件外面有两个理由：这些是纯字符串拼装，可以直接写断言；也避免写作页越长越没人敢动。
import type { AIPublic, Chapter, Project } from './types';
import { buildAiContext, rulesSuffix } from './util';
import type { ChatMessage } from './api';

export type AiAction = 'continue' | 'polish' | 'expand' | 'para' | 'draft' | 'title' | 'blurb' | 'outline' | 'assoc' | 'sensory' | 'pov' | 'tension' | 'voice' | 'gdialog' | 'gquest' | 'ggdd';

export const AI_ACTIONS: { key: AiAction; label: string; needSelection: boolean; hint: string; game?: boolean }[] = [
  { key: 'continue', label: '续写', needSelection: false, hint: '从本章结尾接着往下写' },
  { key: 'polish', label: '润色所选', needSelection: true, hint: '润色选中的文字' },
  { key: 'expand', label: '扩写所选', needSelection: true, hint: '把选中的文字写得更充实' },
  { key: 'para', label: '写一段', needSelection: false, hint: '按目标字数续写一个独立段落，采纳走插入文末' },
  { key: 'title', label: '起标题', needSelection: false, hint: '根据正文拟 5 个备选标题' },
  { key: 'blurb', label: '简介', needSelection: false, hint: '按书名与梗概生成一版书籍简介，抽卡模式出 3 版不同风格' },
  { key: 'outline', label: '生成大纲', needSelection: false, hint: '根据标题与备注列创作大纲' },
  { key: 'assoc', label: '联想词云', needSelection: true, hint: '为选中文字联想氛围/意象/感官词，只出词不成文' },
  { key: 'sensory', label: '感官检视', needSelection: true, hint: '指出选段缺少哪些感官维度与补充方向' },
  { key: 'pov', label: '视角校验', needSelection: true, hint: '检查选段是否有视角越界' },
  { key: 'tension', label: '张力分析', needSelection: true, hint: '检查对话是否缺少潜台词' },
  { key: 'voice', label: '风格采样', needSelection: true, hint: '采样选中对话的句式与口头禅，给出风格约束' },
  { key: 'gdialog', label: '对话树', needSelection: false, game: true, hint: '把本章正文改写成剧情游戏对话树（场景/台词/选项跳转）' },
  { key: 'gquest', label: '任务脚本', needSelection: false, game: true, hint: '把本章情节拆成游戏任务事件脚本（目标/NPC/奖励/分支）' },
  { key: 'ggdd', label: '改编策划', needSelection: false, game: true, hint: '输出本章节游戏化改编策划案（关卡形态/玩法循环/系统建议）' },
];

// 「AI 只判不写」：只有这三类动作会产出可以直接粘进稿子的正文，开关开着时它们改成给判断。
// 分析类（感官 / 视角 / 张力 / 风格 / 联想）与改编类（对话树 / 任务脚本 / 策划案）本来就不写小说正文，不受影响。
export const JUDGED_ACTIONS: AiAction[] = ['continue', 'polish', 'expand'];
export const isJudged = (action: AiAction, judgeOnly?: boolean) => !!judgeOnly && JUDGED_ACTIONS.includes(action);

const JUDGE_TAIL =
  '\n\n【只判不写】这次不要产出成品正文：不要写出可以直接粘进稿子的段落或句子。' +
  '给判断、依据、可选方向与各自的代价；需要指位置时引一句现有原文当坐标就够了。写正文这件事只属于作者。';

// ---------- 提示词开放：四个入口的 system 身份句可被 data/prompts/<key>.md 覆盖 ----------
export type PromptKey = 'advisor' | 'advisor-judge' | 'draft' | 'chat';
export type PromptOverrides = Partial<Record<PromptKey, string>>;

// fallback 与内置拼装逐字一致；{workName}/{type}/{title} 占位符由调用方按当前作品回填
export const PROMPT_DEFS: { key: PromptKey; label: string; fallback: string }[] = [
  {
    key: 'advisor',
    label: '写作顾问身份',
    fallback:
      '你是一位专业的中文写作顾问，正在辅助创作者打磨{workName}。遵守「辅助而不替代」：给出分析、方向与素材，不要替作者写成品段落（除非明确要求续写/润色/扩写/简介）。下面是这部作品的相关资料，供你理解上下文。',
  },
  {
    key: 'advisor-judge',
    label: '写作顾问·判稿',
    fallback: '你是一位专业的中文写作顾问，正在帮创作者判断{workName}接下来该往哪儿走。尊重作者原有的语气与取向，只给判断与方向，不要代写。',
  },
  {
    key: 'draft',
    label: '生成草稿',
    fallback:
      '你是一位专业的中文写作助手，正在为长篇{type}《{title}》撰写章节正文初稿。文风自然、真诚，不堆砌辞藻。只输出正文本身，不要解释，不要输出章节标题，不要复述资料。',
  },
  { key: 'chat', label: 'AI 对话', fallback: '你是一位经验丰富的中文写作伙伴，与创作者自由讨论选题、结构、素材与写作技巧。回答实用、具体、不空谈，语气自然，适当用 Markdown 分点。' },
];

/** 覆盖文本优先（trim 后非空才算数），否则用内置默认 */
export function promptOf(key: PromptKey, overrides?: PromptOverrides): string {
  return overrides?.[key]?.trim() || PROMPT_DEFS.find((d) => d.key === key)!.fallback;
}

/** 把覆盖文本里保留的占位符回填成当前作品的值（没登记的占位符原样保留） */
function fillVars(t: string, vars: Record<string, string>): string {
  return t.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

export const GAME_DIALOG_SPEC =
  `你是一名游戏剧情编剧，正在把一部中文小说改编成剧情向游戏的对话树。\n` +
  `只输出可直接使用的对话树文本，遵循这套约定：\n` +
  `· 场景用「〔场景：名称〕」另起一行标记，场景内依次写可演出内容；\n` +
  `· 旁白/动作提示写作 [旁白]；角色台词写 角色名：台词；\n` +
  `· 对话出现抉择点时写 ＞选项A｜选项B，并在其后用 → 目标场景标注跳转，不写死具体台词；\n` +
  `· 保留原有人物语气与情节信息，删去纯文学性描写，只留可演出内容；\n` +
  `· 不要解释你的改编过程，直接输出文本。`;

export const GAME_QUEST_SPEC =
  `你是一名游戏任务策划，正在把小说情节拆成可直接照做的任务事件脚本。\n` +
  `只输出脚本文本，按下面小节组织：\n` +
  `【任务名】\n【触发条件】（时间/地点/与谁对话后）\n【任务目标】分步骤编号列出\n【关键NPC与台词】（每条对话附触发时机）\n【可选分支】（玩家不同选择导致的不同走向）\n【失败条件】（如果有）\n【奖励建议】（贴合剧情的道具或剧情解锁）\n` +
  `不要解释，不要写攻略式废话，直接输出脚本。`;

export const GAME_DESIGN_SPEC =
  `你是一名游戏制作人兼叙事策划。基于作品资料与下方正文，输出一份「本章节游戏化改编策划案」，要点明确、可执行：\n` +
  `· 本章适合改编成的关卡/场景形态（探索/潜行/对白驱动/追逐战等，贴合剧情给出理由）\n` +
  `· 核心玩法循环如何嵌入叙事——不能只是对话播放器\n` +
  `· 本章冲突/悬念可转成哪些游戏机制（选择后果、资源管理、情报收集、限时决策等）\n` +
  `· 落地需要的系统与 UI 建议\n` +
  `条理清晰，直接输出策划要点，不要泛泛而谈。`;

export function buildMessages(
  action: AiAction,
  project: Project,
  selection: string,
  rules: AIPublic['rules'],
  chapter: Chapter | null,
  judgeOnly = false,
  overrides?: PromptOverrides,
  echo?: string,
  wordTarget = 300,
): ChatMessage[] {
  const judged = isJudged(action, judgeOnly);
  const context = buildAiContext(project, chapter?.id);
  const workName = `${project.type}《${project.title}》`;
  const echoBlock = echo && echo.trim() ? echo : '';
  // 缓存友好：规则整段与章无关，放在身份句之后、语境块之前；每章变化的章名留在末尾
  const base = fillVars(promptOf('advisor', overrides), { workName }) + rulesSuffix(rules) + (judged ? JUDGE_TAIL : '') + context + echoBlock + (chapter ? `\n\n【当前章节】${chapter.title}` : '');
  const draftTail = (project.mode === 'chapters' && chapter ? chapter.content : project.draft).slice(-1500);
  let user: string;
  switch (action) {
    case 'continue':
      if (judged)
        return [
          { role: 'system', content: fillVars(promptOf('advisor-judge', overrides), { workName }) + rulesSuffix(rules) + JUDGE_TAIL + context + echoBlock },
          { role: 'user', content: `下面是${chapter ? `「${chapter.title}」` : '本文'}的结尾。请判断接下来该往哪儿走：给 3 种走向（每种一句话），各说清它会引出什么后果、跟已写的人物动机合不合拍，最后指出你更建议哪一种、为什么。\n\n"""${draftTail || '（正文还是空的：那就判断一下这个该立在什么之上）'}"""` },
        ];
      return [
        { role: 'system', content: `你是一位专业的中文写作助手，正在协助创作者完成${workName}。文风自然、真诚，不堆砌辞藻，尊重作者原有的语气与风格。只输出正文内容本身，不要解释，紧接已有情节写，不要复述资料。` + rulesSuffix(rules) + context + echoBlock },
        { role: 'user', content: `请为${chapter ? `「${chapter.title}」` : '本文'}续写约 300 字。以下是正文结尾部分，请自然地接着写，不要重复已有内容：\n\n"""${draftTail || '（正文还是空的，请根据作品资料写一个开头）'}"""` },
      ];
    case 'para':
      // 可控生成：作者指定字数的独立段落——明确下达的生成命令，不受「只判不写」转换
      user = `接着下面的正文，续写一个独立的叙事段落，目标 ${wordTarget} 字左右（上下浮动一成都行）。只输出这一段正文，不要标题、不要引号、不要解释：\n\n"""${draftTail || '（正文还是空的，请根据作品资料直接写一段开场）'}"""`;
      break;
    case 'draft':
      // 本章草稿走 buildDraftMessages（WritingView 直调），这里只是类型收口，不会执行
      user = "";
      break;
    case 'polish':
      user = judged
        ? `下面这段想润色。请只当镜子，不当笔：逐条指出哪一句有什么问题（啰嗦、含混、假大空、节奏塌、动作没主语），每条给「往哪儿改」的方向与一句依据，不要替我重写整句，也不要给成稿。\n\n"""${selection}"""`
        : `请润色以下文字，保持原意与语气，让表达更准确、流畅，直接输出润色后的文字：\n\n"""${selection}"""`;
      break;
    case 'expand':
      user = judged
        ? `下面这段你觉得单薄。请只判断它薄在哪儿：给 3 个可补的方向（感官、动作、信息差、环境代价…），每个说清补进去能承担什么功能、会不会改动情节，并指出哪一个最不改剧情就能加厚。不要写出成品段落。\n\n"""${selection}"""`
        : `请把以下文字扩写得更充实（补充细节、感官与例证，长度约为原文两倍），保持语气一致，直接输出扩写后的文字：\n\n"""${selection}"""`;
      break;
    case 'title':
      user = `根据以下正文内容，为这篇${project.type}拟 5 个备选标题，每行一个：\n\n"""${(project.mode === 'chapters' && chapter ? chapter.content : project.draft).slice(0, 1500) || project.title}"""`;
      break;
    case 'outline':
      user = `请为${project.type}《${project.title}》列出后续章节级大纲：分点、每点一行，包含章节名与要点提示。${project.notes ? `\n作者备注：${project.notes}` : ''}`;
      break;
    case 'assoc':
      user = `围绕以下文字，联想并输出可用于拓展的氛围词、意象词、感官词（视觉/听觉/嗅觉/触觉各若干），每行一组、只出词语，不要写成句子，不要解释：\n\n"""${selection}"""`;
      break;
    case 'sensory':
      user = `分析以下叙事选段缺少哪些感官维度（视觉/听觉/嗅觉/触觉/体感），逐项指出并只给「补充方向」建议，不要替我写成句：\n\n"""${selection}"""`;
      break;
    case 'pov':
      user = `假设以下选段为限知视角叙事，逐句检查是否存在视角越界（描写了视角人物不可能知道的其他角色内心），列出可疑处与理由，不要改写原文：\n\n"""${selection}"""`;
      break;
    case 'tension':
      user = `分析以下对话的张力：指出哪些句子过于直白、缺少潜台词或言不由衷，给出「往哪里留白」的方向建议，不要替我写台词：\n\n"""${selection}"""`;
      break;
    case 'voice':
      user = `采样以下对话的语言风格：总结这个角色的口头禅、句式习惯、语气特征，输出一份「风格约束清单」供我后续自己写台词时对照，不要生成新台词：\n\n"""${selection}"""`;
      break;
    case 'blurb':
      // 简介是文案不是正文：不受「只判不写」转换，也不吃选区；资料走 system 的语境块，备注在 user 里点名
      return [
        { role: 'system', content: `你是一位专业的中文写作助手，正在协助创作者完成${workName}。文风自然、真诚，不堆砌辞藻，尊重作者原有的语气与风格。只输出正文内容本身，不要解释，紧接已有情节写，不要复述资料。` + rulesSuffix(rules) + context + echoBlock },
        { role: 'user', content: `为${workName}写一段书籍简介，120 字以内：钩子先行，点出核心冲突或反差，结尾留期待。不要分点，不要剧透结局。作者备注与作品资料见下。\n\n"""${project.notes || '（作者没留备注，按作品资料发挥）'}"""` },
      ];
    case 'gdialog':
      return [
        { role: 'system', content: GAME_DIALOG_SPEC + rulesSuffix(rules) + context },
        { role: 'user', content: `请把以下章节正文改编成剧情对话树。\n\n"""${(chapter?.content || project.draft || '').slice(0, 3000) || '（正文为空，请基于作品资料生成一段可演示的对话树）'}"""` },
      ];
    case 'gquest':
      return [
        { role: 'system', content: GAME_QUEST_SPEC + rulesSuffix(rules) + context },
        { role: 'user', content: `请根据以下章节正文拆出任务事件脚本。\n\n"""${(chapter?.content || project.draft || '').slice(0, 3000) || '（正文为空，请基于作品资料先规划本章可承载的任务骨架）'}"""` },
      ];
    case 'ggdd':
      return [
        { role: 'system', content: GAME_DESIGN_SPEC + rulesSuffix(rules) + context },
        { role: 'user', content: `请为「${chapter?.title ?? '本文'}」输出游戏化改编策划案。本章正文如下：\n\n"""${(chapter?.content || project.draft || '').slice(0, 2500) || '（正文为空，请基于作品资料先给出本章的叙事目标与可玩点建议）'}"""` },
      ];
  }
  return [
    { role: 'system', content: base },
    { role: 'user', content: user },
  ];
}

// 章节草稿（单章与批量共用这一份拼法）：原先在 OutlinePanel 里抄了两遍，改一处漏一处。
// 块序按易变度排：身份句与规则恒在前，罕变的设定/世界观/战力线/伏笔随后，
// 按本章 cast 重排的【人物】和每章都变的前情压到最后——命中段因此能一直盖到【人物】之前。
export function buildDraftMessages(project: Project, chapter: Chapter, words: number, rules: AIPublic['rules'], overrides?: PromptOverrides): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        fillVars(promptOf('draft', overrides), { type: project.type, title: project.title }) +
        rulesSuffix(rules) +
        buildAiContext(project, chapter.id) +
        `\n\n【本次任务】撰写「${chapter.title}」一章。`,
    },
    {
      role: 'user',
      content: `请撰写本章正文，约 ${words} 字。以正文直接开始；剧情落在本章要点之内，并照顾到列出的未回收伏笔（可推进其中一两条，不要全部强行回收）。`,
    },
  ];
}

// 计算"本次实际送进 AI 的文本范围"，让结果区能展示给用户看——避免"接在哪儿"完全黑箱
export function buildRunContext(
  action: AiAction,
  doc: string,
  sel: { start: number; end: number },
  chapterTitle?: string,
): AiContext {
  const fullLen = doc.length;
  if (action === 'continue') {
    return {
      kind: 'tail',
      chapterTitle,
      snippet: doc.slice(-1500),
      range: fullLen > 0 ? [Math.max(0, fullLen - 1500), fullLen] : null,
      fullLen,
    };
  }
  if (action === 'title') {
    return {
      kind: 'head',
      chapterTitle,
      snippet: doc.slice(0, 1500),
      range: fullLen > 0 ? [0, Math.min(1500, fullLen)] : null,
      fullLen,
    };
  }
  if (action === 'outline') {
    // 大纲 prompt 不带正文片段，标记为 none（UI 不展开语境卡）
    return { kind: 'none', chapterTitle, snippet: '', range: null, fullLen };
  }
  if (action === 'gdialog' || action === 'gquest' || action === 'ggdd') {
    // 游戏改编类取整章正文（截前 3000 字作素材）
    const len = Math.min(3000, fullLen);
    return {
      kind: 'chapter',
      chapterTitle,
      snippet: doc.slice(0, 3000),
      range: fullLen > 0 ? [0, len] : null,
      fullLen,
    };
  }
  // 其他动作（polish/expand/assoc/sensory/pov/tension/voice）都基于选区
  const hasSel = sel.end > sel.start;
  return {
    kind: 'selection',
    chapterTitle,
    snippet: hasSel ? doc.slice(sel.start, sel.end) : '',
    range: hasSel ? [sel.start, sel.end] : null,
    fullLen,
  };
}

// 结果区头部的"语境卡"：让用户看清本次 AI 拿到的是哪段文本，避免接哪儿都不知道

export interface AiContext {
  // 'tail'=正文末尾 / 'head'=正文开头 / 'selection'=选区 / 'chapter'=整章正文（游戏改编类）/ 'none'=本次未带正文
  kind: 'tail' | 'head' | 'selection' | 'chapter' | 'none';
  // 显示用的章节标题（single 模式时为 null）
  chapterTitle?: string;
  // 实际送进 user prompt 的文本片段
  snippet: string;
  // snippet 在全文里的字符范围 [from, to)（to = exclusive）；无范围时为 null
  range: [number, number] | null;
  // 全文长度（用于换算占比）
  fullLen: number;
}
