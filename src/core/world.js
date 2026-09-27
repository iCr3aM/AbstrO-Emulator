/**
 * 世界市值模拟：100 家真实公司从 2026-09 起步，按月演化到 2066。
 *
 * 设计原则：
 * 1. **完全确定性** —— 随机取自 (month, company, salt) 的哈希，**无状态**。
 *    玩家的操作随机数不会被消耗，所以同一份存档的世界永远一致，无头探针可断言。
 * 2. **不撒谎** —— 基线是真拍的公司名/市值/国家；未来的入场公司若属预测，
 *    在 IPO_POOL 里逐条写了事实依据。
 * 3. **硬约束** —— 长期市值增速不许跑赢名义 GDP 太多（模型 B 的上限），
 *    三套模型里 C 违反这条（留着只作对照）。
 */

import { TOP100, IPO_POOL, DARK_HORSES, ALPHA, SECTOR_LABEL } from './world-data.js';
import { gameMonths } from './format.js';
import { derived } from './economy.js';
import { DIL_AT } from './content.js';

/** 世界起点：2026 年 9 月（= 游戏开局） */
export const WORLD_START_YEAR = 2026;
export const WORLD_START_MONTH = 8;

const WORLD_SEED = 20260924;

/**
 * 三套增长假设（年化）。
 *   A 保守：符合「巨头几乎停涨」的推测（除太空/AI 新贵）
 *   B 中性：推荐 —— 遵守 GDP 天花板，AI 与太空仍是最大赢家
 *     第 480 月（2066-08）榜首 ≈ **$26.04T**（实跑 `createWorld('B') + advanceWorld`；
 *     2026-09-27 加了三层周期后从 $23.63T 抬上来，`npm run tune` 复核为幂等）。
 *     这是「玩家终局市值」的上限锚点：
 *     `ACTS[8].mcap` 由 `npm run tune` 钉在「第 480 月榜首」上，榜首一旦虚高，
 *     终局线就跟着虚高，最后一章会在日历打满之前收尾（旧值 0.08 会给出 $245T，明显失真）。
 *   C 激进：全行业高增速，仅作对照（会导致巴菲特指标爆表，不推荐）
 */
export const MODELS = {
  A: { ai: 0.020, cloud: 0.020, space: 0.080, consumer: 0.015, health: 0.020, finance: 0.015, energy: 0.010, industry: 0.012 },
  B: { ai: 0.022, cloud: 0.018, space: 0.030, consumer: 0.014, health: 0.018, finance: 0.012, energy: 0.010, industry: 0.013 },
  C: { ai: 0.120, cloud: 0.110, space: 0.130, consumer: 0.090, health: 0.090, finance: 0.080, energy: 0.060, industry: 0.070 },
};

const NOISE_SIGMA = 0.14;                              // 年化波动
const MONTH_SIGMA = NOISE_SIGMA / Math.sqrt(12);

/**
 * 周期层（2026-09-27）—— 让榜单「有呼吸」，不再是 100 条平滑向上的曲线。
 * 三样东西都写在 `(月份, 公司, salt)` 上，**无状态**，所以同存档永远一致（探针可断言）。
 *
 *  1. **行业轮动** `SECTOR_PHASE` + `ROTATE_*`：每个行业一条 8 年正弦，相位错开，
 *     接入**年化增速**（±2.4%）。于是「今年 AI 涨、明年能源涨」，名次会真的换位置。
 *  2. **泡沫周期** `bubbleAt`：全市场一条 12 年正弦，直接乘在**市值水平**上（±12%）。
 *     它不改变世界内部的相对名次（人人同乘），但**玩家的市值不在这个乘数里**
 *     ⇒ 泡沫起来时玩家名次被压低、破裂时被抬高，这是玩家能感到的「大盘」。
 *  3. **黑天鹅**（见 `eventFactor`）：个股每月 0.5% 概率 ±15~35%，比财报跳变大一个量级。
 */
const ROTATE_AMP = 0.024;
const ROTATE_MONTHS = 96;
const SECTOR_PHASE = { ai: 0, cloud: 0.7, space: 1.4, consumer: 2.1, health: 2.8, finance: 3.5, energy: 4.2, industry: 4.9 };

const BUBBLE_AMP = 0.12;
const BUBBLE_MONTHS = 144;
/** 第 m 月末的估值水位乘数（`m = 0` 时恰好为 1，开局不偏） */
const bubbleAt = m => 1 + BUBBLE_AMP * Math.sin((m / BUBBLE_MONTHS) * Math.PI * 2);

/** 32 位整数哈希 —— 确定性随机的地基（`orders.js` 也拿它算交付单的甲方） */
export function hash32(a, b, c) {
  let h = Math.imul(a | 0, 2654435761) ^ Math.imul(b | 0, 2246822519) ^ Math.imul(c | 0, 3266489917);
  h ^= h >>> 15; h = Math.imul(h, 2246822507);
  h ^= h >>> 13; h = Math.imul(h, 3266489913);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 近似标准正态（三次均匀和）；clamp 到 ±3 防极端值 */
function gauss(month, i, salt) {
  let s = 0;
  for (let k = 0; k < 3; k++) s += hash32(month, i * 7 + k, WORLD_SEED + salt * 131 + k) / 4294967296;
  const g = (s - 1.5) * 1.15;
  return Math.max(-3, Math.min(3, g));
}

/**
 * 月度事件乘数：
 *  - 财报跳变：每月 3% 概率，±4~8%
 *  - AI 周期回撤：约每 7 年（84 月）一次 −25%，随后 18 个月修复
 *  - **黑天鹅**（2026-09-27）：每月 0.5% 概率，±15~35%。单次就吃掉/送来几年的涨幅，
 *    让「谁在前面」这件事带上真的意外性 —— 也是榜单上唯一会一夜之间改名的机制。
 */
function eventFactor(month, i) {
  let f = 1;
  const r = hash32(month, i, WORLD_SEED + 777) / 4294967296;
  if (r < 0.03) {
    const mag = 0.04 + (hash32(month, i, WORLD_SEED + 778) / 4294967296) * 0.04;
    f *= r < 0.015 ? 1 + mag : 1 - mag;
  }
  const q = hash32(month, i, WORLD_SEED + 779) / 4294967296;
  if (q < 0.005) {
    const mag = 0.15 + (hash32(month, i, WORLD_SEED + 780) / 4294967296) * 0.20;
    f *= q < 0.0025 ? 1 + mag : 1 - mag;
  }
  const period = Math.floor(month / 84);
  const hit = period * 84 + (i % 18);
  if (month === hit) f *= 0.75;
  else if (month > hit && month <= hit + 18) f *= 1.016;
  return f;
}

/** 行业轮动：该行业当下的年化增速修正量（±`ROTATE_AMP`，相位按行业错开） */
function sectorRotation(month, sector) {
  return Math.sin((month / ROTATE_MONTHS) * Math.PI * 2 + (SECTOR_PHASE[sector] || 0)) * ROTATE_AMP;
}

/**
 * 当下**最热**的行业（= 8 条正弦里此刻最高的那个）。
 *
 * 现在只有**一处**读者：市值榜卡片头上那行「当前最热：X」（`render.rankBlock`）。
 * ⚠️ 原来还有第二个读者 —— `cycleNotes` 每 80 月那一条 `【轮动】…` 播报。那条已删
 *    （用户 2026-09-28：「日志《【轮动】》展示删除」）：榜头与日志在**同一屏**同时可见，
 *    说的是同一个 `hotSector`，属于同一件事说两遍。删日志而不是删榜头，是因为榜头是**常驻**的、
 *    日志只是每 80 月闪一次 —— 信息一个没少。
 * ⚠️ 与 `sectorRotation` 共用 `ROTATE_MONTHS` 与相位表：界面上的「最热」与世界内部真正
 *    在加的那点增速，是同一件事（这一层**没有**被删，行业轮动照旧在推动名次变化）。
 */
export function hotSector(month) {
  let best = null;
  for (const k of Object.keys(SECTOR_PHASE)) {
    const v = Math.sin((month / ROTATE_MONTHS) * Math.PI * 2 + SECTOR_PHASE[k]);
    if (!best || v > best.v) best = { k, v };
  }
  return best.k;
}

/**
 * 新建世界（可序列化，直接存进存档）。
 * @param seed 每局的随机源（游戏内传 s.rngSeed）—— 只用于决定**抽到哪几家黑马**，
 *             所有后续走势仍由 (月份, 公司, salt) 的哈希驱动，两者互不干扰。
 */
export function createWorld(model = 'B', seed = WORLD_SEED) {
  const horses = DARK_HORSES
    .filter((_, i) => hash32(seed, i, 99991) / 4294967296 < 0.33)   // 期望抽中 ~8 家（池子 24 条）
    .map(h => ({ ...h }));
  return {
    model,
    seed,
    month: 0,
    companies: TOP100.map(c => ({ n: c.n, t: c.t, s: c.s, co: c.co, cur: c.c, prev: c.c })),
    ipo: [...IPO_POOL.map(i => ({ ...i })), ...horses],
  };
}

/** 推进 n 个月（默认 1 个月） */
export function advanceWorld(w, months = 1) {
  const mu = MODELS[w.model] || MODELS.B;
  for (let m = 0; m < months; m++) {
    w.month += 1;
    // 入场：到了年份就加进来
    const yearNow = Math.floor((w.month - 1) / 12);
    for (const p of w.ipo) {
      if (!p.done && WORLD_START_YEAR + yearNow >= p.y) {
        p.done = true;
        // `born` = 入场月。它的 `prev` 是**上市估值**，不存在「上个月的名次」——
        // 排行榜据此标「新」，而不是编造一个 ↑N（见 ranking 的 isNew）。
        w.companies.push({ n: p.n, t: p.t, s: p.s, co: p.co, cur: p.c, prev: p.c, born: w.month });
      }
    }
    for (let i = 0; i < w.companies.length; i++) {
      const c = w.companies[i];
      const growth = (mu[c.s] || 0.03) + (ALPHA[c.t] || 0) + sectorRotation(w.month, c.s);
      const noise = gauss(w.month, i, 1) * MONTH_SIGMA;
      c.prev = c.cur;
      // 泡沫乘的是**水位**，所以这一步用的是「本月末 / 上月末」两点的比值（等价于把正弦直接乘在市值上）
      const bub = bubbleAt(w.month) / bubbleAt(w.month - 1);
      c.cur = Math.max(1e-4, c.cur * (1 + growth / 12 + noise) * eventFactor(w.month, i) * bub);
    }
  }
  return w;
}

/** 当前世界日期：[年, 月(1-12)] */
export function worldDate(w) {
  const total = WORLD_START_MONTH + w.month;
  return [WORLD_START_YEAR + Math.floor(total / 12), (total % 12) + 1];
}

/**
 * 排行榜（含玩家）。
 *
 * 两列派生数据，都是**无状态**算出来的（同一份存档永远一致，可被无头探针断言）：
 *   · `mom`       环比上月涨跌幅 = `cur / prev - 1`（各家的 `prev` 就是它上月末的市值）
 *   · `rankDelta` 名次变化 = `rankPrev - rank`，**正数 = 上升**。
 *     上月名次不需要额外存档：把同一张表**按 `prev` 再排一次**就是上个月的榜单。
 *     ⚠️ 是**全榜**（100 家 + 后来的 IPO）重排，不是只在前 10 名里重排 ——
 *        所以「从第 15 名杀进第 8 名」会如实显示 `↑7`。
 *   · `isNew`     本月刚入场的公司（IPO 池 / 黑马）。它的 `prev` 是**上市估值**，
 *        不存在「上个月的名次」，所以 `rankDelta = null`，UI 显示「新」。
 *        ⚠️ 它还**不参与上月末榜的重排** —— 上个月它根本不在榜上；
 *           若算进去，它下面所有公司的上月名次都会被人为 +1，凭空多出 ↑1 的假变化。
 *        ⚠️ 只认「入场月 == 当前月」。离线一次跳多个月时，中途入场的公司已存在若干月，
 *           此时按真实 `prev`（上一次推进后的月末值）算名次变化才是对的。
 * @param {object} w             世界
 * @param {number} playerCap     玩家市值（**万亿 USD**；外部负责把 RMB 换来）
 * @param {number} n             返回前 n 名
 * @param {number} playerCapPrev 玩家上月末市值（同上单位）。缺省 = 不显示玩家的环比/名次变化
 */
export function ranking(w, playerCap = null, n = 10, playerCapPrev = null) {
  const isNew = c => c.born != null && c.born === w.month;
  const list = w.companies.map(c => ({
    ...c,
    mom: c.prev > 0 ? c.cur / c.prev - 1 : 0,
    isNew: isNew(c),
  }));
  if (playerCap != null && playerCap > 0) {
    const prev = playerCapPrev != null && playerCapPrev > 0 ? playerCapPrev : playerCap;
    list.push({
      n: '我们', t: 'YOU', s: 'space', co: '中国',
      cur: playerCap, prev, mom: prev > 0 ? playerCap / prev - 1 : 0, me: true,
    });
  }
  list.sort((a, b) => b.cur - a.cur);
  list.forEach((c, i) => { c.rank = i + 1; });

  // 上月末榜单 = 按 `prev` 重排（`byPrev` 只是引用重排，名次写回同一批对象）。
  // 新入场的公司被排除在外 —— 上个月它不在榜上（见上面 isNew 的第 2 条注释）。
  const byPrev = list.filter(c => !c.isNew).sort((a, b) => b.prev - a.prev);
  byPrev.forEach((c, i) => { c.rankPrev = i + 1; });

  // 本月名次**含**新入场公司，所以它们会把它下面的公司挤低一名 —— 那是真实发生的事，
  // 如实显示为 ↓1，不修正。
  // ⚠️ 新入场公司必须显式给 `rankDelta = null`：它们不参与上月末榜，不写就是 `undefined`，
  //    而 `undefined > 0` / `undefined < 0` 都是 false ⇒ UI 会误显示成「─ 持平」（本 bug 的原始形态）。
  for (const c of list) c.rankDelta = c.isNew ? null : c.rankPrev - c.rank;

  return { top: list.slice(0, n), all: list };
}

/* ─────────────────── 游戏内驱动 ─────────────────── */

/**
 * 汇率：1 万亿 USD = 7.2e12 元。
 * 提到导出常量是因为它现在有**两个**使用者：这里是 RMB → T USD（给 UI 与榜单），
 * 标定器（tools/recalibrate-curve.mjs）要反过来把「榜首多少 T USD」换算成 RMB 下限
 * （判断玩家的终局市值够不够得着第 1 名）。两处写两个 7.2e12 迟早会不一致。
 */
export const RMB_PER_T_USD = 7.2e12;
/** 玩家市值（RMB）→ 万亿 USD（世界榜用美元口径） */
export const toUSD_T = rmb => rmb / RMB_PER_T_USD;

/**
 * 三层周期 → 日志（用户 2026-09-27：「市值榜的周期要有日志或者事件显示」）
 * ===============================================================
 * 周期原本是**看不见的**：榜单名次在动，但玩家不知道那是行业轮动、是大盘水位、
 * 还是某家公司自己出了事。这里把机制写成人话，让「名次变了」有可归因的原因。
 *
 * ⚠️ **行业轮动那一类已删**（用户 2026-09-28）—— 榜头「当前最热：X」就是同一个 `hotSector`，
 *    常驻可见，日志里每 80 月再说一遍是同一屏的冗余。剩下两类（大盘 / 黑天鹅）没有别的地方说。
 *
 * 为什么放在 core 而不是 render：它们是**世界的事实**，与玩家无关；而且必须**幂等** ——
 * 同一段 `(from, to]` 不管跑几次都得出一模一样的几行。所以它只读 `(月份, 序号)` 上的
 * 哈希与正弦，不带任何内部状态（与 `world.js` 的确定性铁律一致）。
 *
 * ⚠️ **只许在 `worldTick` 的「向前推进」分支调用**。回拉分支是「重建 + 推进到 target」，
 *    在那里播报等于把整局的周期事件重播一遍。
 *
 * @param {number} from 推进前的月号（不含）
 * @param {number} to   推进后的月号（含）
 * @param {object} w    世界（已推进到 `to`）
 * @returns {string[]}  该区间内发生的播报，按时间顺序
 */

/**
 * 周期播报**文案池**（2026-09-27 第二轮，用户：「描述太重复了……一局最多重复两次或者一次」）
 * ===============================================================
 * 改前实测（一局 27 条播报）的撞句率：
 *   AI 回撤 5 条全同 ｜ 泡沫见顶 4 条全同 ｜ 泡沫见底 3 条全同 ｜ 轮动 5 条全同 ｜
 *   黑天鹅 10 条只有 2 种句式（涨 / 跌各 1 句，各撞 6 次 / 4 次）。
 * 改后：每一类都按「**本局这是第几条**」轮取模板，池子大小 ≥ 一局的条数 ⇒ **每句最多出现一次**。
 * ⚠️ 是**轮取**（`k % pool.length`）不是**抽**：抽是做不到不重复的 ——
 *    黑天鹅 10 条从 8 个模板里随机挑，光重复对就有 ~5 对。
 * ⚠️ 「第几条」全部**算得出来**，没有一处新增状态（黑天鹅那段有详细说明）：
 *    不写存档、读档不重播、探针连调两次必然一致。
 */

/**
 * ⚠️ **每一条播报（含标签）必须 ≤ 46 单位**（半角 1 / 全角 2）—— 与推幕行同一条硬约束。
 *    手机日志栏可用宽 **366px**，单位→像素实测约 7（`npm run shots` 量到最宽的一条 308px）
 *    ⇒ 46 单位留足了一档余量。`probes` 守字符预算、`shots` 用真 Chromium 量像素 —— 两边都判红。
 *    2026-09-27 收短：原来这几条 60–78 单位（最长那条实测要 586px），在手机上全是两行。
 *    代价是形容词没了（「十年一遇」「懒得多写一行」这类），换来的是**一行读完**。
 */

/** 泡沫见顶：一局 4 条（第 36 / 180 / 324 / 468 月） */
const BUBBLE_TOP_LINES = [
  '估值水位见顶，泡沫开始消退。',
  '估值水位见顶，卖方集体改口。',
  '估值水位见顶，最贵的先被卖掉。',
  '估值水位见顶，钱挪向现金流。',
];

/** 泡沫见底：一局 3 条（第 108 / 252 / 396 月） */
const BUBBLE_BOTTOM_LINES = [
  '估值水位见底，钱又涌向科技股。',
  '估值水位见底，两家大基金扫货。',
  '估值水位见底，被砍最狠的先动。',
];

/** AI 回撤：一局 5 条（第 84 / 168 / 252 / 336 / 420 月） */
const AI_PULLBACK_LINES = [
  'AI 回撤，从巨头逐月扫过整条赛道。',
  'AI 回撤，这轮轮到给模型打工的。',
  'AI 回撤，市场开始追问钱花哪了。',
  'AI 回撤，算力交付被摆上台面。',
  'AI 回撤，先从估值最高的开始。',
];

/**
 * 黑天鹅：**涨 / 跌各 12 条** —— 现实里能在一夜之间撼动一家巨头的原因，按方向列。
 * 一局实测 10 条（涨 6 / 跌 4，0.5% × 前 5 名 × 480 月），池子 12 条 ⇒ 每句最多出现一次，
 * 且**任何**涨跌配比都够用（最坏 12 涨 0 跌也正好一人一条）。
 * ⚠️ 每条 ≤ 8 个全角字（16 单位）：行首那一截（`【黑天鹅】英伟达一夜暴涨23%：`）已经占掉 27 单位，
 *    46 单位的总预算只给归因留下 8 个字。2026-09-27 收短前是整句叙事（20+ 字），必折行。
 * 写的是「归因」，不是事实 —— 所以句子都留着传闻口吻（一份做空报告 / 传闻 / 被翻出）。
 */
const SWAN_UP_LINES = [
  '军方订单曝光。',
  '关键专利获批。',
  '三家投行齐上调。',
  '空头被轧空回补。',
  '传闻要吞掉对手。',
  '新品预约量翻倍。',
  '成了新标准主笔。',
  '被列入产业扶持。',
  '纳入核心指数。',
  '产线公告被误读。',
  '拿到独家供应链。',
  '演示数字上热搜。',
];
const SWAN_DOWN_LINES = [
  '一份做空报告。',
  '监管盯上主业。',
  '大客户转给对手。',
  '交付延后两季度。',
  '输了专利官司。',
  '审计所拒签年报。',
  '创始人旧账被翻。',
  '债券降到垃圾级。',
  '核心团队出走。',
  '机房起火停六周。',
  '旗舰产品被下架。',
  '反垄断立案调查。',
];

export function cycleNotes(from, to, w) {
  const out = [];
  if (!w || !(to > from)) return out;
  /**
   * 黑天鹅只报**开局就在最上面的那五家**（`companies` 前 5 条 = `TOP100` 按市值降序的前 5：
   * 英伟达 / 苹果 / 谷歌 / 微软 / 亚马逊）。小公司的暴雷是噪声，巨头的暴雷才叫新闻。
   * ⚠️ 为什么不用「当下的前 5 名」（旧实现：每帧重算 `top`）：那个集合**随时间漂**，而
   *    「这是本局第几条黑天鹅」必须按**同一套规则**数出来 —— 两个时刻的集合不同，数出来的
   *    序号就会漂，同一句会被用到两次（实测：一局里「业内都在传，它最大的客户把订单转给了
   *    别人」出现了 2 次）。固定在开局五家之后，序号只是 `(月份)` 的纯函数 ⇒ **每句最多一次**。
   */
  const swanIds = [0, 1, 2, 3, 4];
  /** 黑天鹅判据：每月 0.5% 概率，其中前一半是涨 —— 与 `eventFactor` 同一组 salt */
  const qSwan = (m, i) => hash32(m, i, WORLD_SEED + 779) / 4294967296;

  /**
   * ⚠️ **黑天鹅的「本局第几条」是数出来的，不是存出来的。**
   * 为什么不用哈希挑模板：10 条从 8 个模板里随机挑，重复对期望 ~5 对，做不到「不重复」。
   * 为什么不用 `s.noteSeq` 计数器：那个字段不进存档 ⇒ 读档后从 0 重来，**已经报过的句子会再报一遍**。
   * 做法：从第 1 月数到 `from`，逐月复用下面的判据（只看开局五家、命中即 break），
   * 最多 480 × 5 次哈希 —— 而且只在世界**真的推进了一个月**时跑（函数开头就 return 了空区间），
   * 一帧的量级都算不上。换来的是零状态：读档、回拉、探针连调，结果全都一样。
   */
  let nUp = 0, nDown = 0;
  for (let m = 1; m <= from; m++) {
    for (const i of swanIds) {
      const q = qSwan(m, i);
      if (q >= 0.005) continue;
      if (q < 0.0025) nUp++; else nDown++;
      break;
    }
  }

  for (let m = from + 1; m <= to; m++) {
    // ① 泡沫周期（12 年一条正弦，乘在**水位**上）：第 36 月见顶、第 108 月见底，此后每 12 年一轮
    if (m % BUBBLE_MONTHS === BUBBLE_MONTHS / 4) {
      out.push('【大盘】' + BUBBLE_TOP_LINES[((m - BUBBLE_MONTHS / 4) / BUBBLE_MONTHS) % BUBBLE_TOP_LINES.length]);
    } else if (m % BUBBLE_MONTHS === (BUBBLE_MONTHS * 3) / 4) {
      out.push('【大盘】' + BUBBLE_BOTTOM_LINES[((m - (BUBBLE_MONTHS * 3) / 4) / BUBBLE_MONTHS) % BUBBLE_BOTTOM_LINES.length]);
    }

    // ② 行业轮动**不播报**（用户 2026-09-28 删掉了那条 `【轮动】…`）：榜头「当前最热：X」
    //    是常驻的同一个 `hotSector`，同一屏说两遍。行业轮动本身照旧在推名次（`sectorRotation`）。

    // ③ AI 回撤：与 `eventFactor` 同一周期（每 7 年一轮，从巨头起逐月扫过整条赛道）
    if (m % 84 === 0) {
      out.push('【大盘】' + AI_PULLBACK_LINES[(m / 84 - 1) % AI_PULLBACK_LINES.length]);
    }

    // ④ 黑天鹅（`eventFactor` 里那 0.5%）：每月最多一条，且只报开局那五家里的那一家
    for (const i of swanIds) {
      const q = qSwan(m, i);
      if (q >= 0.005) continue;
      const mag = 0.15 + (hash32(m, i, WORLD_SEED + 780) / 4294967296) * 0.20;
      const up = q < 0.0025;
      const pool = up ? SWAN_UP_LINES : SWAN_DOWN_LINES;
      out.push(`【黑天鹅】${w.companies[i].n}一夜${up ? '暴涨' : '重挫'}${Math.round(mag * 100)}%`
        + `：${pool[(up ? nUp++ : nDown++) % pool.length]}`);
      break;                                  // 每月最多一条
    }
  }
  return out;
}

/**
 * 跨越名次时的叙事日志。只跨这几个门槛才记一条 ——
 * 每月可能因为股价噪声反复换位，全写会刷屏；这几个门槛一生只有一次。
 *
 * 2026-09-27（用户「让玩家有慢慢超越的感觉」）：从「我们排第几」改成**点名** ——
 * 每一条都说出**越过了谁**。这正是「超越」这件事的节拍器，而原来的文案里没有人名。
 * 越过的就是此刻紧贴我们下面那一家（`rank + 1`）—— 上月末它还压在我们头上。
 * ⚠️ 名字必须截到 **8 单位**以内（`shortName`）：`【世界第 10】` 这个前缀已占 13 单位，
 *    再顶一个长公司名，整行就过 46 单位的死线（手机日志栏 366px，见 `cycleNotes` 上方说明）。
 *
 * ⚠️ **第 1 名那一档已删**（用户 2026-09-28：「删除一个」）—— 它原来写 `上面没有人了。`，
 *    是整张表里**唯一不点名**的一条（其余四条都写「越过了 XXX」），因为登顶时确实没有人可点。
 *    而登顶那一刻 `engine.tick` 还会紧跟着推一条 `【登顶】<公司名> 成了世界第一。` ——
 *    两条在同一个 tick 落下，说的是同一件事。留下的那条是 `【登顶】`：它有专属配色（`.li.top`）、
 *    与结局同源、且句子里带着**公司名**（玩家改了名就跟着改）。
 *    ⇒ 删掉这一档之后，登顶只剩一条日志，也就是最有分量的那一条。
 */
const RANK_NARRATION = {
  10: who => `越过了 ${who}。第一次进前十。`,
  5:  who => `越过了 ${who}。老钟截了图发群里。`,
  3:  who => `越过了 ${who}。有人在问这是谁。`,
  2:  who => `越过了 ${who}。只差最后一个名字。`,
};

/** 点名用的短名：**最多 8 单位**（4 个全角字 / 8 个半角字符）—— 名字多长都不撑破那一行 */
function shortName(n) {
  let out = '', w = 0;
  for (const c of n) {
    const u = c.charCodeAt(0) > 0xff ? 2 : 1;
    if (w + u > 8) break;
    out += c; w += u;
  }
  return out;
}

/**
 * 每帧调用：把世界推进到当前游戏月份，并结算「我们排第几」。
 * 惰性初始化 —— 旧存档第一次进来才建世界，之后随存档走。
 */
export function worldTick(s, R = null) {
  if (!s.world) s.world = createWorld('B', s.rngSeed || WORLD_SEED);
  /**
   * 世界推进到「游戏内已经过去的月数」——与顶部日期**同一个真相源**（format.js 的 gameMonths）。
   *
   * ⚠️ 这里**没有 +1**：世界起点 2026-09 比游戏起点 2026-08 晚一个月这件事，
   *    已经由 `worldDate` 的 `WORLD_START_MONTH = 8` 表达（world.month 0 → 2026-09），
   *    再加 1 就会把世界整体推到 2026-10。
   *
   * ⚠️ 2026-09-26 第二批 §2.6（进度钟）：`gameMonths` 现在是**幕次 + 幕内市值进度**的派生量
   *    ⇒ 世界榜由**玩家进度**驱动：玩家推进快，世界就走得快；卡在某一幕时**世界与玩家一起冻结**
   *    （这正是用户要的「玩得慢，时间就走得慢」）。旧「真实时间线性映射」口径已被取代。
   *    8 幕跨度合计仍是 480 月，打满还是 2066 ⇒ 终局标定（第 40 年榜首 vs 玩家终值）不变。
   */
  const target = gameMonths(s);
  /**
   * 玩家「上月末市值 / 上月末名次」快照 —— 只在跨月那一刻取一次。
   * `s.worldCap` / `s.worldRank` 在本帧被覆盖之前，存的是**上一个世界月**的值
   * （两者都只在本函数末尾落库，而世界月只在这里推进）⇒ 它们就是环比的基准。
   * （离线一次跳多个月时，基准会跨越那几个月 —— 这是能拿到的唯一真相。）
   * ⚠️ 快照必须在分支之前：向前推进与旧档回拉都会发生「时间往前走」这件事，
   *    放在任一支里，另一支就会让基准悄悄停在上上个月。
   * ⚠️ **必须带上 `target !== s.world.month`**：本函数每帧都被调（`engine.tick`），
   *    而 `target` 是 `gameMonths(s)`（整数月）—— 一个月里它会连着几百帧都不变。
   *    少这个判断，第二帧就把「本月末」当成「上月末」写进基准 ⇒ 环比恒为 0。
   */
  if (s.worldCap != null && target !== s.world.month) {
    s.worldPrevCap = s.worldCap;
    s.worldRankPrev = s.worldRank ?? null;
  }
  if (target > s.world.month) {
    const from = s.world.month;
    advanceWorld(s.world, target - from);
    /**
     * 周期播报**只在这一支**（向前推进）。上面那个回拉分支是「重建 + 推进到 target」，
     * 在那里播报会把整局的周期事件重播一遍。
     */
    for (const line of cycleNotes(from, target, s.world)) s.log.push(line);
  } else if (target < s.world.month) {
    /**
     * **旧档回拉**（2026-09-25）。
     * 日历改口径之前，世界是按「幕内插值、幕末封顶」的旧口径推进的 —— 这个口径下世界可能与玩家
     * 真实进度**脱节并跑到前面**（挂机时被操作甩开的正是它）。按新口径（幕次 + 市值进度），
     * 世界的目标月份只由 `gameMonths(s)`（即 `s.calMonth`）给出，跑在前面的旧世界必须被拉回来。
     * 若只是 `if (target > month)`，那份跑在前面的旧世界会一直卡住不跟随，玩家被永久甩开（正是用户截图那个 bug）。
     *
     * 做法：**重建**而不是回滚 —— 世界是 `(model, seed, month)` 的纯函数
     * （`advanceWorld` 只依赖 `w.month` 与序号，随机来自哈希，无内部累积状态），
     * 所以「重建 + 推进到 target」与「一份新档自然走到 target」逐家一致，不是近似。
     */
    s.world = createWorld(s.world.model || 'B', s.world.seed ?? (s.rngSeed || WORLD_SEED));
    advanceWorld(s.world, target);
  }

  const cap = toUSD_T((R ? derived(s, R) : derived(s)).marketCap);
  const { all } = ranking(s.world, cap, 1e9, s.worldPrevCap ?? null);
  const me = all.find(c => c.me);
  const rank = me.rank;
  const prevBest = s.worldBest || 999;

  if (rank < prevBest) {
    s.worldBest = rank;
    s.worldMilestones = s.worldMilestones || [];
    if (RANK_NARRATION[rank] && !s.worldMilestones.includes(rank)) {
      s.worldMilestones.push(rank);
      const passed = all.find(c => c.rank === rank + 1);
      s.log.push(`【世界第 ${rank}】${RANK_NARRATION[rank](passed ? shortName(passed.n) : '前面那家')}`);
    }
    /**
     * **决胜回执**（用户 2026-09-27：「可以在减速开始时给一条日志回执」）——
     * `dilate()` 的减速权重 `w` 正是在 `worldBest` 首次 ≤ `DIL_AT` 时脱离 0，
     * 所以「减速开始」的字面位置就是这里。
     * ⚠️ **只报一次**：`worldBest` 只减不增 ⇒「上一次还没进、这一次进了」这个条件
     *    一生只成立一次，不需要新增去重字段。
     * ⚠️ 它与名次播报（`【世界第 5】`，正因为 `DIL_AT = 5`）会落在同一个月。两条说的不是一件事
     *    （「越过了谁」vs「接下来会变慢」），日志栏 132px 放得下相邻两条。
     */
    if (prevBest > DIL_AT && rank <= DIL_AT) s.log.push('【决胜】时间放慢。');
  }
  /**
   * 名次落库（2026-09-26 精简）：每 150ms 重绘一次，若在渲染层现算 `ranking`
   * 就等于每帧多做一次 100 家公司的排序 —— 而 `worldTick` 每秒已经算过一遍了。
   * 所以在这里把名次直接落到 `s` 上，渲染层只读不算。
   * （原来还落了 `worldRankDelta` / `worldRankNew` / `worldTopCur` 三个数，
   *   世界榜顶部改为整榜渲染后**无人再读**，已删。）
   */
  s.worldRank = rank;
  s.worldCap = cap;
  return { rank, cap };
}

export { SECTOR_LABEL };
