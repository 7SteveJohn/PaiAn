// 内置卡池：抽出来的是「下一步写什么」，不是数值。
// 卡面里的 {char} {place} {item} {hook} {num} 是槽位，打出时从**当前这本书**的人物卡/设定卡/未回收伏笔里取
// （见 gacha.ts 的 resolveCard），所以同一张卡用在不同的书上，落出来的任务并不一样。
// 稀有度只表示作用半径：N 一句、R 一个冲突、SR 一种破格手法、SSR 一个跨卷局面。
import type { GachaCard } from './gacha';

export const RATES = { N: 0.6, R: 0.28, SR: 0.1, SSR: 0.02 };
export const PITY = 30; // 30 抽内必出一张 SSR
export const WORDS_PER_PULL = 1000; // 净产出 1000 字 = 1 抽；删改会回扣，刷不出来
export const INK_PER_DUP = 2; // 重复卡转「墨」
export const CHANGE_COST = 12; // 定向换一张卡（含 SSR）的墨价：救济通道，不是商店
export const HAND_LIMIT = 3; // 同时在手最多三张，避免变成囤积游戏

// 卡牌注入的规则（SR 卡「打出即追加一条」）按来源限量：
// 写多了会把每一次 AI 调用都撑爆，而且读者看不出是哪本书留下的。
export const CARD_RULE_PREFIX = '卡牌·';
export const CARD_RULE_LIMIT = 6;

export const SERIES = ['小事', '岔路', '破格', '大局', '练笔'];

export const BASE_CARDS: GachaCard[] = [
  // ---------------- N · 小事：一句就能落地 ----------------
  { id: 'n01', series: '小事', rarity: 'N', name: '多出来的第三人', effect: 'beat', payload: '让 {char} 在本章多说一句与情节无关的话，这句话要到第 {num} 章才起作用。' },
  { id: 'n02', series: '小事', rarity: 'N', name: '一件带不走的东西', effect: 'beat', payload: '给 {char} 一件必须留在 {place} 的东西，只写他放下它的动作，不写心情。', any: ['放下', '留在', '留下'] },
  { id: 'n03', series: '小事', rarity: 'N', name: '只写身体', effect: 'constraint', payload: '本章叙述不许出现心理动词，全部换成身体反应。', absent: ['他想', '他觉得', '他明白', '他记得', '他知道', '她知道'] },
  { id: 'n04', series: '小事', rarity: 'N', name: '把话说一半', effect: 'beat', payload: '{char} 本章至少打断自己两次，用破折号或直接住口，不解释为什么。', any: ['——'] },
  { id: 'n05', series: '小事', rarity: 'N', name: '错开的信息', effect: 'hook', payload: '埋一条只有读者看得见的信息：{item}。书中谁都不知道它真正的用处。' },
  { id: 'n06', series: '小事', rarity: 'N', name: '不许有长句', effect: 'constraint', payload: '本章叙述句一律压到 20 字以内，宁可断句也别用逗号拖长。', constraints: [{ kind: 'maxSentence', chars: 20 }] },
  { id: 'n07', series: '小事', rarity: 'N', name: '给对手一件善事', effect: 'beat', payload: '让本章对手在做完对自己有利的事之后，顺手做一件毫无好处的小事，不写动机。' },
  { id: 'n08', series: '小事', rarity: 'N', name: '环境的账', effect: 'beat', payload: '在 {place} 加一处与情节无关、但明显有人住过的痕迹。' },
  { id: 'n09', series: '小事', rarity: 'N', name: '数字要确凿', effect: 'constraint', payload: '本章不许出现「很多／一些／几天／几个」，一律换成确数：几里、几文钱、第几根缆桩。', absent: ['很多', '一些', '几天', '几个', '许多'] },
  { id: 'n10', series: '小事', rarity: 'N', name: '把结尾删掉', effect: 'beat', payload: '本章砍掉最后 1—3 句总结性的话，停在一个动作上。' },
  { id: 'n11', series: '小事', rarity: 'N', name: '借一双眼睛', effect: 'cast', payload: '把本章某一段的视角临时交给 {char}：他只看见局部，看不见关键。' },
  { id: 'n12', series: '小事', rarity: 'N', name: '同一句说两次', effect: 'beat', payload: '挑本章最短的一句台词，在结尾原样再说一次，语境要变味。' },

  // ---------------- R · 岔路：两个既有元素被迫相撞 ----------------
  { id: 'r01', series: '岔路', rarity: 'R', name: '旧物 × 新人', effect: 'task', payload: '把「{item}」和「{char}」写进同一场戏：他第一次见它就认得，却说不出为什么。只给动作与对白，不给解释。' },
  { id: 'r02', series: '岔路', rarity: 'R', name: '伏笔提前爆一半', effect: 'beat', payload: '把「{hook}」在本章戳破一半：让人物自己说出一半，另一半永远不说。' },
  { id: 'r03', series: '岔路', rarity: 'R', name: '地点错位', effect: 'beat', payload: '把本章最关键的交锋挪到 {place} 发生，而这个地点的人完全不懂他们在争什么。' },
  { id: 'r04', series: '岔路', rarity: 'R', name: '好人说有用的谎', effect: 'task', payload: '为 {char} 写一个谎：他明知会被拆穿仍然要说，因为不说会伤到更多人。三百字内见分晓。' },
  { id: 'r05', series: '岔路', rarity: 'R', name: '双线同一时刻', effect: 'beat', payload: '本章分两半写同一时刻的两地：一半在 {place}，一半在别处，中间只留一个空行。', absent: ['与此同时', '另一边', '同一时间'] },
  { id: 'r06', series: '岔路', rarity: 'R', name: '代价前置', effect: 'hook', payload: '本章开头就交代动用「{item}」要付的代价，让读者先替人物心疼，再让他用。' },
  { id: 'r07', series: '岔路', rarity: 'R', name: '盟友不可信', effect: 'beat', payload: '让本章帮 {char} 的人做一件他自己看不出问题、读者一眼看出问题的事。' },
  { id: 'r08', series: '岔路', rarity: 'R', name: '答案给得太早', effect: 'task', payload: '在本章前八百字就交出本章悬念的答案，之后只写人物如何应付这个答案。给我三种入口。' },
  { id: 'r09', series: '岔路', rarity: 'R', name: '无对白冲突', effect: 'constraint', payload: '本章写一场冲突，全程不许有对话，只用动作、物件与环境推进。', absent: ['说道', '问道', '：「', '："'] },
  { id: 'r10', series: '岔路', rarity: 'R', name: '配角抢半章', effect: 'cast', payload: '把本章后半让给一个只出场过一次的人，由他决定这一章停在哪里。' },

  // ---------------- SR · 破格：一次叙事手法 ----------------
  { id: 's01', series: '破格', rarity: 'SR', name: '第二人称逼问', effect: 'rule', payload: '本章通篇用第二人称「你」；「你」是本章里做了最坏选择的那个人，全章不点破。' },
  { id: 's02', series: '破格', rarity: 'SR', name: '死者不知情', effect: 'rule', payload: '本章叙述者已经死了，但叙事语气完全不承认，照常办事、照常计划明天。' },
  { id: 's03', series: '破格', rarity: 'SR', name: '倒着走的一章', effect: 'beat', payload: '本章从结尾往回写：先给结果，再一层层撤掉原因，最后一段是最早发生的事。' },
  { id: 's04', series: '破格', rarity: 'SR', name: '双声道反驳', effect: 'task', payload: '上一章由 {char} 讲的话，这一章让另一个知情者当面逐段拆穿；两个声道不许同时说话。给三种拆法。' },
  { id: 's05', series: '破格', rarity: 'SR', name: '文档体插入', effect: 'beat', payload: '本章中段插入一份非叙述文本（验尸记录／理赔单／港务日志／一张清单），正文不解释它。', any: ['记录', '清单', '日志', '单'] },
  { id: 's06', series: '破格', rarity: 'SR', name: '尺度跳切', effect: 'beat', payload: '把本章最长的一段时间压成一段，最短的一瞬摊开成八百字，比例故意失衡。' },
  { id: 's07', series: '破格', rarity: 'SR', name: '只写余波', effect: 'task', payload: '正面写一场大事之后的两小时，绝不回头交代那场大事，只从损坏的东西反推发生了什么。给三个开头。' },
  { id: 's08', series: '破格', rarity: 'SR', name: '首尾同句异义', effect: 'hook', payload: '记下本章第一句；全书最后一次复现时要变成一句托词，语义由 {item} 承担。' },
  { id: 's09', series: '破格', rarity: 'SR', name: '叙述者偷懒', effect: 'rule', payload: '本章叙述者承认自己在讲，并拒绝描述某一段，理由含糊且带着个人偏好。' },
  { id: 's10', series: '破格', rarity: 'SR', name: '三处破绽', effect: 'beat', payload: '让本章叙述者的说法留下三处与现场不符的破绽：{item}、时间、脚印。读者数得出来，人物数不出来。' },


  // ---------------- 练笔 · 条件本身就是奖品（达成率驱动，写完自动点亮） ----------------
  { id: 'x01', series: '练笔', rarity: 'N', name: '短句行军', effect: 'constraint', payload: '本章所有叙述句压到 18 字以内，长信息拆成两三句，别拿逗号拖着。', constraints: [{ kind: 'maxSentence', chars: 18 }] },
  { id: 'x02', series: '练笔', rarity: 'N', name: '别拿「他」开头', effect: 'constraint', payload: '本章最多一段以「他/她」起头，其余段落换成物件、动作、声音或地点开头。', constraints: [{ kind: 'pronounOpen', max: 1 }] },
  { id: 'x03', series: '练笔', rarity: 'R', name: '一场纯对白', effect: 'constraint', payload: '本章写成一场戏：只有说话和极少的动作提示，别替读者解释谁是什么心情。', constraints: [{ kind: 'dialogueShare', min: 55 }] },
  { id: 'x04', series: '练笔', rarity: 'R', name: '静音章', effect: 'constraint', payload: '本章一句话都不许说出口：全部信息走动作、物件和环境，对话压到 8% 以下。', constraints: [{ kind: 'dialogueShare', max: 8 }] },
  { id: 'x05', series: '练笔', rarity: 'SR', name: '一句顶三句', effect: 'constraint', payload: '本章禁用「不是A，而是B」这个翻身句式，一次都不许出现；顺带把句子拆短。', constraints: [{ kind: 'deslopMax', key: 'not-but', count: 0 }, { kind: 'maxSentence', chars: 24 }] },
  { id: 'x06', series: '练笔', rarity: 'N', name: '不解释情绪', effect: 'constraint', payload: '不许写他知道/她明白/一丝…划过这类告知句，情绪全部换成身体反应与动作。', absent: ['他知道', '她明白', '一丝'], constraints: [{ kind: 'deslopMax', key: 'shadow', count: 0 }] },
  { id: 'x07', series: '练笔', rarity: 'SR', name: '让排比闭嘴', effect: 'constraint', payload: '本章最多一组三连并列；想排比就只留最狠的那一句。', constraints: [{ kind: 'deslopMax', key: 'triple', count: 0 }] },
  { id: 'x08', series: '练笔', rarity: 'R', name: '长短交错', effect: 'constraint', payload: '叙述句压在 22 字内，同时让对白占到 15% 以上——节奏靠交错，不靠平均。', constraints: [{ kind: 'maxSentence', chars: 22 }, { kind: 'dialogueShare', min: 15 }] },

  // ---------------- SSR · 大局：跨卷局面（自动铺到后续五章） ----------------
  { id: 'v01', series: '大局', rarity: 'SSR', name: '他要保的人不在船上', effect: 'outline', payload: '① 他终于动手护人，却发现对象早不在局中；② 为撑住这个谎必须做一件真坏事；③ {char} 开始疑他；④ 证据出现在 {place}；⑤ 他选择让疑他的人看见真相的一半。' },
  { id: 'v02', series: '大局', rarity: 'SSR', name: '敌人为他挡了一刀', effect: 'outline', payload: '① 对手替他挡下不该挡的东西；② 这份人情必须还，还不起；③ {item} 成了筹码；④ 盟友因这笔交换崩掉；⑤ 他与对手第一次说人话。' },
  { id: 'v03', series: '大局', rarity: 'SSR', name: '胜利是假的', effect: 'outline', payload: '① 本章让他赢，赢得太顺；② 战果开始逼他撒谎维持；③ {char} 是唯一看出破绽的人；④ 破绽在 {place} 公开；⑤ 选输回来，还是继续假赢。' },
  { id: 'v04', series: '大局', rarity: 'SSR', name: '把金手指写成债', effect: 'outline', payload: '① 一次寻常用法；② 代价第一次显形；③ 他学会回避代价；④ 回避的代价更大；⑤ 「{hook}」在这一章回收，正是这笔账。' },
  { id: 'v05', series: '大局', rarity: 'SSR', name: '读者知道，主角不知道', effect: 'outline', payload: '① 先把答案交给读者；② 主角每一步都走错且每步都合理；③ 唯一接近真相的是 {char}，他说不出口；④ 主角走到真相门口，本章停在门口；⑤ 门后是 {place}。' },
  { id: 'v06', series: '大局', rarity: 'SSR', name: '让主线停一章', effect: 'outline', payload: '① 照原线推进；② 埋一个可回收的道具；③ 整章离开主线，只写一个配角的一天或一件东西的旅行，但必须留下一条后续要用的信息；④ 回到原线，代价显形；⑤ {char} 第一次主动选择。' },
];
