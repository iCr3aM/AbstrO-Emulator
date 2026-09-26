/**
 * 经济模型（GDD §5.1）
 * ===============================================================
 * ```
 * 产品力 prod = g^Lr        份额指数 share = g^Lm        团队效率 team = g^Lh
 * 每秒收入 income = INCOME_SCALE · prod · share · team · GENERATION
 * 年营收  revenue = income · SEC_PER_YEAR
 * 成本    cost(n) = LINE_COST0 · r^n            // r = 1.13，三条线共用
 * 支出    upkeep = revenue · (salaryFrac + scaleFrac)
 * 市值    marketCap = revenue · PE(stage, decisions)
 * ```
 * **只有一个乘积，没有加法桶、没有隐藏乘数层、没有绝对额固定支出。**
 *
 * 为什么「没有绝对额支出」是硬约束：旧版 `net = gross·k − 固定额`，gross 一旦偏小
 * ⇒ 净收入恒负 ⇒ 永远回不来（旧版「不可恢复死锁」的全部来源）。
 * 本版支出全是收入的比例 ⇒ 收入归零时支出也归零 ⇒ **不存在死锁**。
 */

import {
  ACTS, LINES, LINE_IDS, LINE_GROWTH, CURVE_RATIO, LINE_COST0,
  INCOME_SCALE, GENERATION, SEC_PER_YEAR,
  PE_BASE, PE_MIN, PE_MAX, salaryFrac, scaleFrac,
} from './content.js';

/** 第 id 条线的等级（只增不减） */
export const lineLevel = (s, id) => Math.max(0, Math.floor((s.lines && s.lines[id]) || 0));

/** 第 n 次购买的成本（三条线共用；n 从 0 起） */
export const costOf = n => LINE_COST0 * CURVE_RATIO ** n;

/** 现在买下第 id 条线要花多少 */
export const costFor = (s, id) => costOf(lineLevel(s, id));

/** 买得起吗 */
export const canAfford = (s, id) => s.money >= costFor(s, id);

/** 产品代际：每阶段 ×1.5，共 6 次 ⇒ 全程 ×11.4 */
export const generationOf = stage => GENERATION ** (Math.max(1, stage) - 1);

/**
 * 当前速率。**纯函数**：同样的状态永远得到同样的结果，可被无头探针直接断言。
 */
export function rates(s) {
  const levels = {};
  const factor = {};
  for (const l of LINES) {
    levels[l.id] = lineLevel(s, l.id);
    factor[l.id] = LINE_GROWTH ** levels[l.id];
  }
  const m = s.mod || {};
  const prod = factor.r * (m.prod ?? 1);
  const share = factor.m * (m.share ?? 1);
  const team = factor.h * (m.team ?? 1);
  const gen = generationOf(s.stage);

  const income = INCOME_SCALE * prod * share * team * gen;     // 元/秒
  const revenue = income * SEC_PER_YEAR;                      // 元/年
  const frac = salaryFrac(s.stage) + scaleFrac(s.stage);
  const upkeep = revenue * frac;                              // 元/年
  return {
    levels, prod, share, team, gen, frac,
    income, revenue, upkeep,
    net: revenue - upkeep,                                    // 元/年
    netPerSec: income * (1 - frac),                           // 元/秒
    margin: 1 - frac,
  };
}

/** 市盈率 = 阶段基准 + 决策累加，夹取到 [8, 60]（不变式 ④） */
export const peOf = s => {
  const base = (ACTS[s.stage] || ACTS[1]).pe + ((s.mod && s.mod.pe) || 0);
  return Math.max(PE_MIN, Math.min(PE_MAX, base));
};

/** 「显示份额」：把无界的 `share` 映射到 0–100%，供界面与阶段 3 的目标显示 */
export const sharePctOf = share => 100 * (1 - 1 / Math.max(1, share));

/**
 * 派生展示值（**不入存档**）。
 * `marketCap` 同时是推幕闸门、日期进度钟与世界榜的三重输入 —— 只有一个真相源。
 */
export function derived(s, R = rates(s)) {
  const pe = peOf(s);
  return { ...R, pe, marketCap: R.revenue * pe, sharePct: sharePctOf(R.share) };
}

/**
 * 买一条线。**手动点击与自动购买走的是同一个函数**（GDD §1.6）——
 * 手动点击只是把购买顺序微调得更好一点，加速上限 ≲1.15×。
 * @returns {boolean} 是否买成
 */
export function purchase(s, id) {
  const c = costFor(s, id);
  if (!(s.money >= c)) return false;
  s.money -= c;
  s.lines[id] = lineLevel(s, id) + 1;
  return true;
}

/**
 * 选一条「当前等级最低」的线 —— 自动购买的决策规则（GDD §1.6）。
 * 三条线共用 `cost(n)` ⇒ 等级最低的那条就是最便宜的那条，均衡会自动维持。
 */
export function lowestLine(s) {
  let best = LINE_IDS[0];
  let bestLv = Infinity;
  for (const id of LINE_IDS) {
    const lv = lineLevel(s, id);
    if (lv < bestLv) { bestLv = lv; best = id; }
  }
  return best;
}
