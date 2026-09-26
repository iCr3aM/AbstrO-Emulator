/**
 * 数值格式化（GDD 17.4）
 * 本作峰值约 82 万亿 = 8.2e13，远低于 Number 安全整数上限 9e15，
 * 因此不需要 BigNumber —— 这一条已在 GDD 里显式确认。
 */

// 时间轴换算：一游戏年 = `SEC_PER_YEAR` 个游戏秒（GDD 16/2.4 的时间轴基准）。
// 这里**不写死数值**：`SEC_PER_YEAR` 是标定量（一局 3–6h / 35 年，目标见 `tools/curve-targets.mjs`），
// 写死的话每次重新标定它都会在旁边留一句假话。
// ⚠️ 2026-09-26 第二批 §2.6：日历改由**幕次 + 幕内市值进度**派生（进度钟），
//    幕的年份区间（`ACTS[].years`）重新成为日历的真相源 ⇒ 本文件重新 import `ACTS`。
//    `SEC_PER_YEAR` 不再参与日历推导（它降级为「一局多长」的标定参考，见 content.js），
//    所以这里也不再 import 它。
import { ACTS, START_MCAP } from './content.js';

const UNITS = [
  { v: 1e12, s: '万亿' },
  { v: 1e8, s: '亿' },
  { v: 1e4, s: '万' },
];

/** 中文单位显示：1,320 → "1,320"；1320万 → "1,320.00万" */
export function fmt(n, digits = 2) {
  if (!Number.isFinite(n)) return '∞';
  const neg = n < 0;
  const a = Math.abs(n);
  for (const { v, s } of UNITS) {
    if (a >= v) {
      const x = a / v;
      return (neg ? '-' : '') + x.toFixed(x >= 100 ? 0 : digits) + s;
    }
  }
  return (neg ? '-' : '') + a.toFixed(a >= 100 ? 0 : digits);
}

/** 速率显示：+1.20万/秒 */

/**
 * 紧凑格式（日志/合同/事件用）：1.32万 → "1.32万亿"；无千分位、小数固定 2 位。
 * 2026-09-24 工程债清理：此前 finance/contracts/events 各有一份逐字符相同的实现 ——
 * 三处已统一 import 本函数。与上面 `fmt` 的差异：固定 2 位小数、无 ≥100 收整分支。
 */
export function fmtShort(n) {
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + '万亿';
  if (a >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (a >= 1e4) return (n / 1e4).toFixed(2) + '万';
  return n.toFixed(0);
}

/** 整数+千分位：12,847 */

/** 时长：秒 → "45.0分" / "1.09h" */

/**
 * 游戏内日期 —— **进度钟**（第二批 §2.6，2026-09-26）。
 *
 * ⚠️ 四个版本的口径都写在这里，免得后人再踩一遍：
 *    ① 最初：只推进「年」，月与日钉死在 8 月 9 日 —— 一个游戏年 1.62 小时，
 *      玩家前一个半小时看到的日期一个字都不变（用户报的「日期不推进」）。
 *    ② 第二版：按 `s.elapsed` 线性推进，但 `s.elapsed` 被倍速放大、又被幕封顶 ——
 *      挂机 7.6 小时 ⇒ 第 1/8 幕「出租屋」的日期走到 2031 年，世界榜跟着复利掉 5 年。
 *    ③ 第三版（2026-09-25 第一批 §2）：幕内插值整块删除，日历改为 `s.elapsed`（真实秒）的线性映射。
 *      修好了②，但把日历与世界榜彻底挂到**墙钟**上 ⇒ 挂机时世界照常复利，
 *      「挂机 = 被甩开」；而冲刺时日历也不会走快（用户报的「玩家挂机很慢」）。
 *    ④ 第四版（本版 · 进度钟）：日历 = **幕次 + 幕内市值进度**。
 *      `p = clamp(市值 / 本幕门槛, 0, 1)`，月数在本幕的 `ACTS[].years` 区间里插值。
 *      ⇒ 玩得快，时间就走得快；玩得慢，时间就走得慢；卡在某一幕时**世界与你一起冻结**。
 *      ⇒ 第 8 幕打满（`p = 1`）**恰好**是 2061 年 8 月 = 结局 ——「玩到最后时间刚刚好是结局」。
 *
 * `s.elapsed` **仍然存在、仍然累加真实秒**（离线结算 / 融资到点 / 日志锚定靠它），
 * 但它不再驱动日历与世界榜；日历的缓存字段是 `s.calMonth`（`engine.tick` 每帧写入）。
 *
 *    ⑤ 第五版（v4 重制 · 本版）：字段名对齐 `s.stage`（v4 的幕次字段叫 `stage`，不叫 `act`），
 *      并把「幕内插值」换成**全局锚点插值** —— 因为前者在幕边界会**倒退**：
 *      跨幕那一瞬市值 ≈ `mcap[j-1]`，而 `p = 市值 / mcap[j]` 立刻掉到 `1/比值`（本版阶梯上 1/5 ~ 1/1200）
 *      ⇒ 每跨一幕日历往回跳两三年。改成「对数市值轴上的全局分段线性」后：
 *      锚点 `(START_MCAP → 0 月)`、`(ACTS[j].mcap → 60j 月)`，市值单调 ⇒ 月份单调，绝不倒退。
 *      玩法语义**不变**：玩得快时间走得快；卡在某一幕时，时间与世界一起冻结。
 */
const START_UTC = Date.UTC(2026, 7, 9);              // 2026-08-09
const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;
export const TOTAL_YEARS = 35;                        // GDD 2.4：2026–2061（engine tick 的跨年日志分隔也用）
export const MONTHS_TOTAL = TOTAL_YEARS * 12;         // 420

/**
 * 每一幕的**月区间** `[起, 止]`（相对 2026-08 的月数），解析自 `ACTS[].years`。
 * 八幕首尾相接，末值 = `MONTHS_TOTAL`（420 = 2061-08）—— 所以「幕次 → 月」只有这一份数据。
 * 索引与 `ACTS` 对齐（第 0 位是 null）。
 */
export const ACT_MONTHS = ACTS.map(a => {
  if (!a) return null;
  const m = /(\d{4})\s*[–—-]\s*(\d{4})/.exec(a.years || '');
  return m ? [(Number(m[1]) - 2026) * 12, (Number(m[2]) - 2026) * 12] : [0, 0];
});

/**
 * 进度钟锚点：`[市值, 月数]`。第 0 个是「开局市值 → 0 月」，第 j 个是 `(mcap[j] → 60j 月)`。
 * 门槛阶梯由标定器保证**严格递增**（见 content.js 顶部说明），所以这条链天然单调。
 */
const CLOCK = [[START_MCAP, 0], ...ACTS.slice(1).map((a, i) => [a.mcap, (i + 1) * 60])];

/**
 * 当前市值对应的**日历月数** —— 对数市值轴上的分段线性插值（单调 ⇒ 日期只前进不后退）。
 * @param s 只用 `s.calMonth` 的容器身份（本函数的输出**要写回** `s.calMonth`，见 `engine.tick`）
 * @param D `derived(s)` 的结果（只要 `marketCap`）—— 由调用方算，避免 format → economy 的环。
 */
export function calMonthOf(s, D) {
  const cap = Math.max(CLOCK[0][0], (D && D.marketCap) || 0);
  const x = Math.log(cap);
  for (let i = 1; i < CLOCK.length; i++) {
    const [c0, m0] = CLOCK[i - 1];
    const [c1, m1] = CLOCK[i];
    if (cap > c1 && i < CLOCK.length - 1) continue;
    const span = Math.log(c1) - Math.log(c0);
    const p = span > 0 ? Math.max(0, Math.min(1, (x - Math.log(c0)) / span)) : 1;
    return m0 + p * (m1 - m0);
  }
  return MONTHS_TOTAL;
}

/**
 * 游戏内已经过去多少个月（0 起，封顶 420）。
 * @param s 存档状态。只读 `s.calMonth` 一个**派生**字段（由 `engine.tick` 每帧写入）。
 *          没写过时按 0 处理 —— 新档第一帧渲染出来就是 2026 年 8 月，与起点一致。
 */
export function gameMonths(s) {
  return Math.max(0, Math.min(MONTHS_TOTAL, Math.floor(s.calMonth || 0)));
}

export function gameDate(s) {
  const years = gameMonths(s) / 12;                  // ← 由月数反推年，唯一真相源
  const d = new Date(START_UTC + years * MS_PER_YEAR);
  // 只显示到月（2026-09-24 用户）：「日」的精度是假的 —— 真实秒 → 日期是线性映射，
  // 「12 月 3 日」会让人以为那天真的发生了什么；月粒度才符合放置游戏的时间感。
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月`;
}

/**
 * 当前处在第几个游戏年（**1..35**）—— 探针会用到。
 * ⚠️ 夹取上限是 `TOTAL_YEARS - 1` 再加 1：month 420（第 35 年末）是第 **35** 年，不是第 36 年。
 *    原实现写成 `Math.min(TOTAL_YEARS, ...) + 1`，在终点会返回 36 —— 只是以前从没走到那一格。
 */
export const gameYear = s =>
  Math.min(TOTAL_YEARS - 1, Math.floor(gameMonths(s) / 12)) + 1;
