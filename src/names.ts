// 取名面板的数据层：确定性拼装 + 本书避重。不调模型、不联网，「换一批」只是换个种子。
//
// 为什么自己做而不丢给 AI：作者要的是翻牌的手感——三秒一批、顺眼就钉住，而不是等一次
// 网络往返。词库拼出来的名字足够挑，而且同种子永远同一批，能写断言，也不会半夜抽风给出
// 一个「李铁柱·瓦伦斯」。
import type { Project, WorldItem } from './types';

export type NameStyle = '玄幻' | '古言' | '都市' | '西幻';
export type NameCategory = '人物男' | '人物女' | '别号' | '势力' | '功法' | '地名' | '器物';

export const NAME_STYLES: NameStyle[] = ['玄幻', '古言', '都市', '西幻'];
export const NAME_CATEGORIES: NameCategory[] = ['人物男', '人物女', '别号', '势力', '功法', '地名', '器物'];

export interface NamePick {
  name: string;
  note: string; // 为什么这么拼，让作者有的可挑
  category: NameCategory;
  kind: 'char' | 'world';
  worldKind?: WorldItem['kind'];
}

export interface GenerateOptions {
  category: NameCategory;
  style?: NameStyle;
  seed?: number;
  count?: number;
  banned?: string[]; // 本书已有名、已钉住的名：生成时绕开
  twoChar?: boolean; // 人物名：双名 / 单名
}

// ---------- 词库 ----------
// [词, 释义]；释义只用来拼「注」，缺省就退回字面本身
type W = [string, string?];

const SURNAME_OLD: W[] = [['林'], ['沈'], ['顾'], ['裴'], ['谢'], ['萧'], ['陆'], ['江'], ['温'], ['晏'], ['霍'], ['容'], ['秦'], ['燕'], ['楚'], ['岳'], ['商'], ['闻'], ['澹台'], ['上官'], ['皇甫'], ['令狐']];
const SURNAME_MODERN: W[] = [['周'], ['陈'], ['李'], ['王'], ['张'], ['刘'], ['杨'], ['黄'], ['赵'], ['吴'], ['孙'], ['郑'], ['冯'], ['蒋'], ['韩'], ['曹'], ['邓'], ['许'], ['傅'], ['曾']];
const WEST_CLAN: W[] = [['瓦伦'], ['奥斯特'], ['梅里'], ['晨星'], ['艾森'], ['洛林'], ['卡文'], ['塞拉'], ['德里克'], ['凡斯'], ['戈登'], ['米尔顿'], ['兰开']];
const WEST_ONSET: W[] = [['奥'], ['里'], ['塞'], ['德'], ['卡'], ['索'], ['艾'], ['凡'], ['戈'], ['洛'], ['米'], ['雷'], ['尤'], ['西']];
const WEST_CODA: W[] = [['安'], ['奥'], ['恩'], ['斯'], ['特'], ['尔'], ['蒙'], ['丹'], ['诺'], ['兰'], ['德里'], ['德']];

const GIVEN_M: W[] = [['照', '点亮'], ['承', '承接'], ['砚', '砚台'], ['昭', '显著'], ['慕', '思慕'], ['执', '持守'], ['观', '看'], ['临', '到'], ['渡', '渡过'], ['归', '回'], ['拾', '捡起'], ['沉', '沉潜'], ['怀', '心中'], ['慎', '谨慎'], ['远', '远处'], ['青', '青翠'], ['无', '无'], ['亦', '也'], ['与', '和'], ['长', '长久']];
const GIVEN_F: W[] = [['璃', '琉璃'], ['挽', '挽留'], ['听', '听'], ['栖', '栖止'], ['疏', '疏朗'], ['映', '映照'], ['眠', '安睡'], ['晚', '晚'], ['芷', '白芷'], ['蘅', '杜蘅'], ['微', '细微'], ['念', '念'], ['知', '知'], ['素', '素白'], ['照', '点亮'], ['雪', '雪']];
const GIVEN_TAIL: W[] = [['川', '河流'], ['山', '山'], ['澜', '大波'], ['夜', '夜'], ['明', '明亮'], ['舟', '船'], ['岸', '岸'], ['声', '声音'], ['寒', '寒'], ['尘', '尘'], ['光', '光'], ['衡', '平衡'], ['野', '原野'], ['泉', '泉'], ['柏', '柏树'], ['年', '年岁'], ['迟', '晚'], ['行', '走'], ['灯', '灯'], ['桥', '桥'], ['渊', '深潭'], ['岳', '高山'], ['棠', '海棠'], ['鹤', '鹤']];
const GIVEN_MODERN: W[] = [['志', '志气'], ['家', '家'], ['立', '立'], ['思', '思'], ['嘉', '善'], ['宁', '安宁'], ['航', '航行'], ['睿', '明智'], ['安', '安'], ['然', '然'], ['宸', '帝王居所'], ['霖', '久雨'], ['瑶', '美玉'], ['萱', '萱草'], ['桐', '梧桐'], ['越', '越过'], ['野', '原野'], ['沫', '泡沫']];

const EPI_A: W[] = [['听', '听'], ['照', '照亮'], ['挽', '拉'], ['临', '到'], ['踏', '踩'], ['问', '问'], ['守', '守'], ['不', '不'], ['无', '无'], ['半', '一半'], ['独', '独'], ['一', '一'], ['长', '长久'], ['笑', '笑']];
const EPI_B: W[] = [['雪', '雪'], ['雨', '雨'], ['夜', '夜'], ['江', '江'], ['关', '关隘'], ['灯', '灯'], ['剑', '剑'], ['舟', '船'], ['云', '云'], ['山', '山'], ['风', '风'], ['月', '月'], ['潮', '潮'], ['杯', '酒杯']];
const EPI_TAIL: Record<NameStyle, W[]> = {
  玄幻: [['客'], ['道人'], ['散人'], ['真君'], ['尊者'], ['居士'], ['主人']],
  古言: [['翁'], ['先生'], ['公子'], ['娘子'], ['判官'], ['三郎'], ['主人'], ['姐']],
  都市: [['先生'], ['总监'], ['老板'], ['医生'], ['律师'], ['队长'], ['哥'], ['姐']],
  西幻: [['骑士'], ['法师'], ['领主'], ['执政官'], ['先知'], ['匠师'], ['游侠']],
};

const FOR_A: W[] = [['玄', '玄'], ['青', '青'], ['九', '九'], ['天', '天'], ['无', '无'], ['长', '长'], ['落', '落'], ['幽', '幽'], ['明', '明'], ['星', '星'], ['云', '云'], ['沧', '沧海'], ['寒', '寒'], ['赤', '红']];
const FOR_B: W[] = [['龙'], ['虎'], ['剑'], ['刀'], ['日'], ['月'], ['音'], ['影'], ['花'], ['叶'], ['山'], ['海'], ['雷'], ['泉'], ['沙'], ['血'], ['灯'], ['雀'], ['麟'], ['网'], ['讯'], ['桥']];
const FOR_TAIL: Record<NameStyle, W[]> = {
  玄幻: [['宗'], ['门'], ['派'], ['教'], ['殿'], ['谷'], ['盟'], ['圣地'], ['天朝']],
  古言: [['府'], ['门'], ['家'], ['号'], ['阁'], ['楼'], ['社'], ['堂'], ['商会']],
  都市: [['集团'], ['科技'], ['事务所'], ['实验室'], ['会所'], ['公会'], ['研究院'], ['律所']],
  西幻: [['王朝'], ['议会'], ['骑士团'], ['教廷'], ['家族'], ['学院'], ['佣兵团'], ['密会']],
};

const GONG_A: W[] = [['燃', '烧'], ['照', '照亮'], ['拾', '捡'], ['挽', '拉'], ['听', '听'], ['踏', '踩'], ['吞', '吞'], ['锁', '锁'], ['御', '驾御'], ['凝', '凝聚'], ['引', '引'], ['断', '断'], ['裂', '裂'], ['洗', '洗'], ['卧', '卧'], ['惊', '惊'], ['点', '点'], ['化', '化'], ['守', '守']];
const GONG_B: W[] = [['海', '海'], ['星', '星'], ['霜', '霜'], ['雷', '雷'], ['火', '火'], ['月', '月'], ['云', '云'], ['渊', '深潭'], ['灯', '灯'], ['剑', '剑'], ['影', '影'], ['魂', '魂魄'], ['骨', '骨'], ['潮', '潮'], ['夜', '夜'], ['风', '风'], ['涛', '波涛'], ['阳', '日']];
const GONG_TAIL: Record<NameStyle, W[]> = {
  玄幻: [['诀'], ['经'], ['功'], ['典'], ['篇'], ['图']],
  古言: [['诀'], ['谱'], ['功'], ['法'], ['心法'], ['秘要']],
  都市: [['训练法'], ['体系'], ['手册'], ['呼吸法'], ['教程'], ['心法']],
  西幻: [['秘术'], ['法典'], ['祷文'], ['战技'], ['课纲'], ['传承']],
};

const PLACE_A: W[] = [['落', '落'], ['青', '青'], ['白', '白'], ['长', '长'], ['老', '老'], ['孤', '孤'], ['寒', '寒'], ['云', '云'], ['星', '星'], ['断', '断'], ['隐', '隐'], ['鸣', '响'], ['卧', '卧'], ['铜', '铜'], ['芦', '芦苇'], ['桃', '桃树'], ['苦', '苦'], ['碧', '碧']];
const PLACE_B: W[] = [['沙'], ['雁'], ['龙'], ['鹿'], ['门'], ['江'], ['梅'], ['柳'], ['风'], ['雷'], ['石'], ['桥'], ['塔'], ['洲'], ['浦'], ['角'], ['井'], ['林']];
const PLACE_TAIL: Record<NameStyle, W[]> = {
  玄幻: [['城'], ['关'], ['泽'], ['渊'], ['岭'], ['墟'], ['洞天'], ['秘境']],
  古言: [['城'], ['关'], ['渡'], ['津'], ['驿'], ['亭'], ['府'], ['州'], ['塞']],
  都市: [['路'], ['街'], ['里'], ['苑'], ['大道'], ['广场'], ['码头'], ['站']],
  西幻: [['堡'], ['港'], ['森林'], ['山脉'], ['领'], ['城邦'], ['修道院']],
};

const RELIC_A: W[] = [['照', '照亮'], ['无', '无'], ['青', '青'], ['玄', '玄'], ['冷', '冷'], ['素', '素'], ['落', '落'], ['拾', '捡'], ['长', '长久'], ['半', '半'], ['九', '九'], ['不', '不'], ['残', '残缺'], ['古', '古']];
const RELIC_B: W[] = [['尘', '尘'], ['渊', '深潭'], ['夜', '夜'], ['星', '星'], ['月', '月'], ['海', '海'], ['雪', '雪'], ['霜', '霜'], ['魂', '魂魄'], ['命', '命'], ['音', '音'], ['更', '更漏'], ['天', '天'], ['灯', '灯']];
const RELIC_TAIL: Record<NameStyle, W[]> = {
  玄幻: [['剑'], ['印'], ['镜'], ['灯'], ['舟'], ['幡'], ['钟'], ['符'], ['珠']],
  古言: [['扇'], ['砚'], ['簪'], ['佩'], ['匣'], ['镜'], ['灯'], ['刀'], ['卷']],
  都市: [['录音笔'], ['打火机'], ['工牌'], ['钥匙'], ['手表'], ['档案袋'], ['徽章']],
  西幻: [['剑'], ['权杖'], ['圣杯'], ['护符'], ['罗盘'], ['王冠'], ['锁子甲']],
};

const WORLD_KIND_OF: Record<NameCategory, WorldItem['kind'] | undefined> = {
  人物男: undefined,
  人物女: undefined,
  别号: '设定',
  势力: '势力',
  功法: '功法',
  地名: '地点',
  器物: '道具',
};

// ---------- 随机源 ----------
// mulberry32：同种子同结果，测试能断言，「换一批」只是换一个种子
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rnd = () => number;
const take = <T>(r: Rnd, list: T[]): T => list[Math.min(list.length - 1, Math.floor(r() * list.length))];
const word = (w: W) => w[0];
const mean = (w: W) => (w[1] ? `（${w[1]}）` : '');

// ---------- 各类拼装 ----------
function person(r: Rnd, style: NameStyle, male: boolean, twoChar: boolean): NamePick {
  const category: NameCategory = male ? '人物男' : '人物女';
  if (style === '西幻') {
    const given = word(take(r, WEST_ONSET)) + word(take(r, WEST_CODA));
    const clan = word(take(r, WEST_CLAN));
    return { name: `${given}·${clan}`, note: `音译拼合：名「${given}」+ 氏族「${clan}」`, category, kind: 'char' };
  }
  const sur = take(r, style === '都市' ? SURNAME_MODERN : SURNAME_OLD);
  const a = take(r, style === '都市' ? GIVEN_MODERN : male ? GIVEN_M : GIVEN_F);
  if (!twoChar) return { name: word(sur) + word(a), note: `${word(sur)}姓，单名「${word(a)}」${mean(a)}`, category, kind: 'char' };
  if (style === '都市') {
    const b = take(r, GIVEN_MODERN);
    return { name: word(sur) + word(a) + word(b), note: `${word(sur)}姓，「${word(a)}」${mean(a)}「${word(b)}」${mean(b)}`, category, kind: 'char' };
  }
  const b = take(r, GIVEN_TAIL);
  return { name: word(sur) + word(a) + word(b), note: `${word(sur)}姓，「${word(a)}」${mean(a)} + 「${word(b)}」${mean(b)}`, category, kind: 'char' };
}

function epithet(r: Rnd, style: NameStyle): NamePick {
  const a = take(r, EPI_A);
  const b = take(r, EPI_B);
  const tail = take(r, EPI_TAIL[style]);
  return { name: `${word(a)}${word(b)}${word(tail)}`, note: `取「${word(a)}」「${word(b)}」意象，人称「${word(tail)}」`, category: '别号', kind: 'world', worldKind: '设定' };
}

function force(r: Rnd, style: NameStyle): NamePick {
  const a = take(r, FOR_A);
  const b = take(r, FOR_B);
  const tail = take(r, FOR_TAIL[style]);
  return { name: `${word(a)}${word(b)}${word(tail)}`, note: `「${word(a)}」「${word(b)}」二字立号，以「${word(tail)}」为制`, category: '势力', kind: 'world', worldKind: '势力' };
}

function technique(r: Rnd, style: NameStyle): NamePick {
  const a = take(r, GONG_A);
  const b = take(r, GONG_B);
  const tail = take(r, GONG_TAIL[style]);
  return { name: `${word(a)}${word(b)}${word(tail)}`, note: `取「${word(a)}」「${word(b)}」两义，${a[1] ?? '行功'}路数归「${word(tail)}」`, category: '功法', kind: 'world', worldKind: '功法' };
}

function place(r: Rnd, style: NameStyle): NamePick {
  const a = take(r, PLACE_A);
  const tail = take(r, PLACE_TAIL[style]);
  const mid = r() < 0.55 ? take(r, PLACE_B) : undefined;
  const name = word(a) + (mid ? word(mid) : '') + word(tail);
  return { name, note: `「${word(a)}」${a[1] ?? ''}${mid ? word(mid) : ''}之${word(tail)}，可作${style}舞台`, category: '地名', kind: 'world', worldKind: '地点' };
}

function relic(r: Rnd, style: NameStyle): NamePick {
  const a = take(r, RELIC_A);
  const b = take(r, RELIC_B);
  const tail = take(r, RELIC_TAIL[style]);
  return { name: `${word(a)}${word(b)}${word(tail)}`, note: `「${word(a)}」「${word(b)}」之${word(tail)}，来历可以留白`, category: '器物', kind: 'world', worldKind: '道具' };
}

function one(r: Rnd, category: NameCategory, style: NameStyle, twoChar: boolean): NamePick {
  switch (category) {
    case '人物男':
      return person(r, style, true, twoChar);
    case '人物女':
      return person(r, style, false, twoChar);
    case '别号':
      return epithet(r, style);
    case '势力':
      return force(r, style);
    case '功法':
      return technique(r, style);
    case '地名':
      return place(r, style);
    case '器物':
      return relic(r, style);
  }
}

/** 出一批名字：同 seed 同结果；banned 里的名字一定不出现 */
export function generateNames(opts: GenerateOptions): NamePick[] {
  const style = opts.style && NAME_STYLES.includes(opts.style) ? opts.style : '玄幻';
  const category = opts.category && NAME_CATEGORIES.includes(opts.category) ? opts.category : '人物男';
  const count = Math.max(1, Math.min(30, Math.floor(opts.count ?? 8)));
  const banned = new Set((opts.banned ?? []).map((s) => (s ?? '').trim()).filter(Boolean));
  const r = rng(opts.seed ?? 1);
  const out: NamePick[] = [];
  const seen = new Set<string>();
  // 撞车就重拼：词库容量足够，几十次内一定出得来；真出不来就少给几个，不硬凑重复
  for (let tries = 0; out.length < count && tries < count * 40; tries++) {
    const p = one(r, category, style, opts.twoChar !== false);
    if (banned.has(p.name) || seen.has(p.name)) continue;
    seen.add(p.name);
    out.push(p);
  }
  return out;
}

/** 一本书里已经用掉的名字：人物卡 + 设定卡 + 章节出场名单，生成时全部绕开 */
export function usedNames(project: Project): string[] {
  const out = new Set<string>();
  for (const c of project.characters ?? []) if (c.name?.trim()) out.add(c.name.trim());
  for (const w of project.worldItems ?? []) if (w.name?.trim()) out.add(w.name.trim());
  for (const ch of project.chapters ?? []) {
    for (const seg of (ch.cast ?? '').split(/[、,，;；\s]+/)) if (seg.trim()) out.add(seg.trim());
  }
  return [...out];
}

/** 建卡要用的分类：人物走人物卡（返回 undefined），其余按 worldKind 落到设定卡 */
export function pickToWorldKind(p: NamePick): WorldItem['kind'] | undefined {
  if (p.kind === 'char') return undefined;
  return p.worldKind ?? WORLD_KIND_OF[p.category] ?? '设定';
}
