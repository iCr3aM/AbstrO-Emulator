/**
 * 目标时长向量 —— 唯一真相源（spec §0 决策 ④：一局 3–6 小时）
 * ===============================================================
 * 为什么单独一个文件：标定器（recalibrate-curve.mjs）与量尺（headless-check.mjs）
 * 必须读**同一份**「目标」。各写一份就会出现「标定到 4.5h、验收按 40–60h」这种漂移，
 * 而本计划存在的全部意义，就是把「一幕多长」收敛到一个地方。
 *
 * 单位一律是**真实小时**：它不随 SEC_PER_YEAR 变，是标定器去追的东西。
 */

/** 目标合计时长（小时）：spec §0 决策 ④ 区间 3–6h 的中段偏上。 */
export const TARGET_TOTAL_H = 4.5;

/** 主动玩法（跑满合同 + 员工）的验收带宽（小时）—— headless-check 用它判 ❌/✅。 */
export const CURVE_BAND = [3, 6];

/**
 * 纯挂机玩法（不接任何合同）的验收带宽（小时）。
 * 上限放宽到目标的 4 倍：合同系统若真的只是「一次性现金流」（spec §3.2），
 * 无视它的玩家必然更慢 —— 要求两条路径落在同一区间等于要求「不接单不会变慢」，
 * 自相矛盾。这里守的是「挂机也一定能通关，且不会慢到荒谬」。
 */
export const IDLE_BAND = [3, 18];

/**
 * 每幕目标时长（小时；第 0 项占位）。**严格递增**，合计 = TARGET_TOTAL_H。
 * 形状的理由：前 7 幕各解锁一条新 tier（0.3 → 0.7，逐幕加长，玩家需要更多次购买才能跨过下一档），
 * 第 8 幕是终章（1.0），给足时间让玩家看见「超越英伟达」和结算页。
 */
export const CURVE_MID = [null, 0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 1.0];

/** 单幕验收容差：|实测 / 目标 − 1| ≤ CURVE_TOL 视为达标（标定器也用它判收敛）。 */
export const CURVE_TOL = 0.4;

/** 8 幕叙事跨度（游戏年，2026–2061）—— `SEC_PER_YEAR` 从它派生。 */
export const NARRATIVE_YEARS = 35;

/** 时间旋钮的目标值：一局 = TARGET_TOTAL_H 小时 = 35 个游戏年 ⇒ 1 游戏年多少真实秒。 */
export const TARGET_SEC_PER_YEAR = Math.round(TARGET_TOTAL_H * 3600 / NARRATIVE_YEARS);

// ── 自洽守卫：合计必须等于 TARGET_TOTAL_H，严格递增，否则这张表自己就是错的 ──
const sum = CURVE_MID.slice(1).reduce((a, b) => a + b, 0);
if (Math.abs(sum - TARGET_TOTAL_H) > 1e-9) {
  throw new Error(`CURVE_MID 合计 ${sum}h ≠ TARGET_TOTAL_H ${TARGET_TOTAL_H}h —— 两者必须同步修改`);
}
for (let a = 2; a <= 8; a++) {
  if (!(CURVE_MID[a] > CURVE_MID[a - 1])) {
    throw new Error(`CURVE_MID 必须严格递增：第 ${a} 幕 ${CURVE_MID[a]}h ≤ 第 ${a - 1} 幕 ${CURVE_MID[a - 1]}h`);
  }
}
