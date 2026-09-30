import type { GachaState, UserCards } from './gacha';
import type { Constraint } from './constraints';

// 两张在手卡并成的本章任务：只活在这一章，达成给一次奖励抽
export interface ComboTask {
  name: string;
  task: string;
  constraints: Constraint[];
  yielded: string[];
  from: [string, string];
  createdAt: string;
  litAt?: string;
}

export type IdeaKind = '灵感' | '素材' | '摘抄' | '选题';
export interface Idea {
  id: string;
  content: string;
  kind: IdeaKind;
  tags: string[];
  pinned: boolean;
  createdAt: string;
  deletedAt?: string; // 软删除时间；不存在或为空表示未删除
  src?: string; // 从 Obsidian 导入时记下的库内相对路径：用来认出「这篇已经导过几条」
}

export type ProjectStatus = '构思' | '大纲' | '写作中' | '已完成' | '已发布';

// 历史版本快照：at 为本地时间 "YYYY-MM-DD HH:mm"
export interface ProjectVersion {
  at: string;
  words: number;
  text: string;
}

// 正文锚点标记：只存在于工作台内，导出/同步自动剥离
export type MarkType = '伏笔' | '彩蛋' | '人物' | '场景' | '碎片';

export interface TextMark {
  id: string;
  type: MarkType;
  start: number;
  end: number;
  text: string;
  note?: string;
  status?: '埋下' | '回收'; // 伏笔用
  expected?: string; // 预期回收章节
  orphaned?: boolean; // 原文已变，找不到锚点
  chapterId?: string; // 章节模式：锚点所属章节
  createdAt: string;
}

// 断点记忆：光标位置 + 所在章节
export interface Breakpoint {
  cursor: number;
  chapterId?: string;
  at: string;
}

// 章节：长篇模式下项目的基本写作单元
export interface Chapter {
  id: string;
  title: string;
  content: string;
  summary?: string; // 剧情梗概（AI 上下文/前情提要用）
  timeLabel?: string; // 故事内时间标签，如「入历327年九月」
  volume?: string; // 所属卷名，如「第一卷 废土列车」；留空归入「未分卷」
  beats?: string; // 本章剧情要点（结构化大纲）
  cast?: string; // 出场人物，顿号分隔
  places?: string; // 出场地点
  hooks?: string; // 本章要埋/要推进的伏笔
  pending?: string; // AI 生成的草稿，待审核采纳（不进正文）
  discuss?: ChatMessage[]; // 本章剧情探讨对话（写前敲定剧情用）
  freezeAt?: number;
  versions?: ProjectVersion[];
  createdAt: string;
  updatedAt: string;
}

// 人物卡：情绪履历 + 关系 + 战力（绑定章节防升级线崩坏）
export interface Character {
  id: string;
  name: string;
  state: string; // 当前心理状态
  log: { at: string; text: string }[];
  relations: { with: string; note: string }[];
  power?: string; // 当前境界 / 战力等级，如「筑基后期」
  powerLog?: { chapterId?: string; text: string }[]; // 战力变更记录：在第几章发生了什么变化
  bio?: string; // 人生经历：跨章汇总的「他经历了什么」（可 AI 提炼，也可手改）
}

// 世界观词条（卡片化实体：势力/功法/力量体系可被大纲与上下文引用）
export interface WorldItem {
  id: string;
  name: string;
  kind: '地点' | '道具' | '设定' | '势力' | '功法' | '力量体系';
  content: string;
  parent?: string; // 地点用：上级地点名（如「码头」的上级是「雾港」）；留空即顶层
}

// 剧情分支沙盘
export interface StoryBranch {
  id: string;
  title: string;
  tag: '备选' | '废弃' | '待扩写';
  text: string;
  updatedAt: string;
}

// ---------- 牵线工作流（关系图）----------
// 节点几乎都只是「已有实体的影子」：章、人物卡、设定卡、伏笔标记。图里只存引用与坐标，
// 不复制内容——改人物卡不必同步图，删了实体也不会留下说谎的节点。
export type GNodeKind = 'chapter' | 'char' | 'world' | 'hook' | 'note';
export type GLinkKind = 'next' | 'cast' | 'kin' | 'hook' | 'free';

export interface GNode {
  id: string;
  kind: GNodeKind;
  ref?: string; // 指向 chapters/characters/worldItems/marks 的 id；note 没有
  x?: number;
  y?: number;
  note?: string; // kind=note 时的正文；也可给引用节点写一句旁批
}

export interface GLink {
  id: string;
  from: string;
  to: string;
  kind: GLinkKind; // next 推动 / cast 出场 / kin 关系 / hook 伏笔 / free 手牵
  label?: string;
}

export interface StoryGraph {
  version: 1;
  nodes: GNode[];
  links: GLink[];
}

export interface Project {
  id: string;
  title: string;
  type: string;
  status: ProjectStatus;
  deadline: string; // 空字符串表示未设置
  target?: number; // 字数目标，0/未设置表示不启用
  notes: string;
  draft: string;
  linkedIdeaIds: string[];
  createdAt: string;
  updatedAt: string;
  versions?: ProjectVersion[];
  deletedAt?: string;
  marks?: TextMark[];
  characters?: Character[];
  worldItems?: WorldItem[];
  branches?: StoryBranch[];
  freezeAt?: number; // 冻结修改（单文档模式）：此位置之前的正文锁定
  breakpoint?: Breakpoint;
  game?: { forbidden: string[] }; // 禁用词练笔
  /** 牵线工作流（关系图）：节点尽量引用已有实体，线是作者手牵的因果。
   *  坐标可缺省——缺了就在「整理布局」时按确定性网格补上。 */
  graph?: StoryGraph;
  combo?: ComboTask; // 在手两卡并成的组合任务（只活在这一章）
  mode?: 'single' | 'chapters'; // 章节模式（长篇）；缺省为单文档
  chapters?: Chapter[];
  // 全书至今梗概：长篇写到几十章后，远古章节靠它进上下文，避免「只记得最近 30 章」
  rollingSummary?: { upTo: number; text: string; at?: string };
}

// AI 对话
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: string;
}

export interface StatsData {
  daily: Record<string, number>;
  reflection: string;
  dailyGoal?: number; // 每日目标字数，0/未设置表示不启用
}

// 写作规则：启用后注入所有 AI 调用的系统提示
export interface AIRule {
  name: string;
  content: string;
  on: boolean;
}

export interface AIPublic {
  provider: string;
  baseUrl: string;
  model: string;
  protocol?: 'openai' | 'anthropic' | 'ollama'; // 请求协议，默认 openai
  hasKey: boolean;
  keyMask?: string; // 已存 Key 的打码形态（sk-ab12••••9cd0），空 = 未存
  ready: boolean; // baseUrl 与 model 均已配置（本地模型无需 Key 即可 ready）
  rules?: AIRule[];
  memoryExtract?: boolean; // 采纳 AI 正文后自动抽取「出场记忆」写回人物/设定卡（默认开）
  gateDraft?: boolean; // 批量生成草稿前查细纲与未采纳草稿（默认开）
    judgeOnly?: boolean; // 只判不写：续写/润色/扩写改成给判断，批量出稿禁用（默认关）
}

export interface AppData {
  ideas: Idea[];
  projects: Project[];
  stats: StatsData;
  gacha: GachaState; // 抽卡账本：抽数/墨/已收/已点亮
  cards: UserCards; // 用户自建卡与关掉的内置卡
}

export interface ObsidianConfig {
  vaultPath: string;
  folder: string;
  /** ⑤ 自动同步：写作页停下 AUTO_SYNC_MS 自己推一次。默认关——后台写盘不是谁都想要 */
  autoSync?: boolean;
}
