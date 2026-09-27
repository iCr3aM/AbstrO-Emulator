/**
 * 经济模型（GDD §5.1）
 * ===============================================================
 * ```
 * 算力   comp = g^Lc        渠道  chan = g^Ld
 * 产品力 prod = g^Lr        份额指数 share = g^Lm        团队效率 team = g^Lh
 * 每秒收入 income = INCOME_SCALE · prod · share · team · comp · chan
 * 年营收  revenue = income · SEC_PER_YEAR
 * 成本    cost(n, 月) = LINE_COST0 · r^n · winterAt(月)     // r = 1.13，五条线共用
 * 支出    upkeep = revenue · (salaryFrac + scaleFrac)
 * 市值    marketCapBase = revenue · PE(stage, decisions)          // 公司的真实进度
 *         marketCap     = marketCapBase · valAt(月)                // 市场当时肯给的价格
 * ```
 * **只有一个乘积，没有加法桶、没有隐藏乘数层、没有绝对额固定支出。**
 *
 * ### 两条恒等式（改动任何数值前先读这两条）
 * ```
 * ① 年营收 / cost(n) = INCOME_SCALE · SEC_PER_YEAR / LINE_COST0 = 720 × 500 / 8777 = 41.02
 * ② 现金 / 年营收 ∈ [ K/(1−rf) − 1 , K/(1−rf) ] / 41.02      K = autoBuyReserveOf(s)
 * ```
 * ① 与等级、章次无关（2026-09-27 起成本带上 `winterAt(月)` 周期，所以它逐月有 ±30% 起伏，
 *    但周期在整局上正好是 4 个整周期、**均值 1** ⇒「全程合计」的比值仍是 41.02）。
 *    （`LINE_COST0` 由 `tune` 标定；第四批改造前是 `9665` ⇒ 分母 `37.25`。）
 * ⇒「一笔融资值多少次购买」「一单值多少营收」的**量级**全程恒定。改 `LINE_COST0` 会破坏它。
 *
 * ### ⚠️ 储备金**不是**节流阀（2026-09-27 审计纠正）
 * 一个购买周期 = 「可动用现金从下沿涨到上沿」：
 * ```
 * 要补的量 = (1 − rf)·cost          补充速率 = (1 − rf)·净收入
 * ⇒ 周期长度 = cost / 净收入        ← (1 − rf) 在分子分母上相消
 * ```
 * ⇒ **购买速率、全程耗时与 `RESERVE_FRAC` 无关**。它只是账上的一个静态偏移
 * （改变的是「现金 / 年营收」这个比值），唯一代价是开局把锯齿填满的一次性时延。
 * 旧注释写的「储备是一条平滑的节流阀」在「年营收 × 25%」的旧口径下才对 —— 那是硬墙。
 *
 * 为什么「没有绝对额支出」是硬约束：旧版 `net = gross·k − 固定额`，gross 一旦偏小
 * ⇒ 净收入恒负 ⇒ 永远回不来（旧版「不可恢复死锁」的全部来源）。
 * 本版支出全是收入的比例 ⇒ 收入归零时支出也归零 ⇒ **不存在死锁**。
 *
 * ⚠️ 2026-09-26 删掉了旧版的 `GENERATION = 1.5^(stage−1)` 隐藏乘数。它有两个害处：
 *   ① 让「年营收 / 单次成本」逐章缩小 1.5 倍 ⇒ 事件里的现金效果必须逐章缩小，是纯粹的复杂度；
 *   ② 让每章的 ln 台阶被 `ln(gen·pe)` 这一项吃掉一部分 ⇒ 章弧长无法与市值阶梯一一对应。
 *   删掉之后 `年营收 / cost(n) = INCOME_SCALE·SEC_PER_YEAR / LINE_COST0` —— **一个常数**，
 *   于是「一次购买耗时」在章内恒定、「一笔融资值多少次购买」全程恒定，标定只剩两个旋钮。
 */

import {
  ACTS, LINES, LINE_IDS, LINE_GROWTH, CURVE_RATIO, LINE_COST0,
  INCOME_SCALE, SEC_PER_YEAR, RESERVE_FRAC, MANUAL_PAY,
  PE_MIN, PE_MAX, salaryFrac, scaleFrac, winterAt, valAt,
} from './content.js';
import { gameYear, gameMonths } from './format.js';

/** 第 id 条线的等级（只增不减） */
export const lineLevel = (s, id) => Math.max(0, Math.floor((s.lines && s.lines[id]) || 0));

/**
 * 第 n 次购买的成本（五条线共用；n 从 0 起）。
 * `month` 是游戏月数 —— 成本随**宏观周期**起伏（寒冬最贵 +30%，见 `content.COST_CYCLE_*`）。
 * **默认 0 = 平常**：探针与工具里那些「只想知道基准价」的调用点因此不用改。
 */
export const costOf = (n, month = 0) => LINE_COST0 * CURVE_RATIO ** n * winterAt(month);

/** 现在买下第 id 条线要花多少（按**当前游戏月**取周期价） */
export const costFor = (s, id) => costOf(lineLevel(s, id), gameMonths(s));

/**
 * 现金储备（元）= 现金 × `RESERVE_FRAC`。**账上留存的、不能动的那笔钱**。
 *
 * ⚠️ 基数从「年营收」改成「现金」（用户 2026-09-27）：旧版 `年营收 × 0.25` 等于一道
 *    `≈10 份成本`（`年营收 / cost = 41.02 × 0.25`）的硬墙 —— 现金没填满这条线之前一分钱都动不了，
 *    表现就是「现金明明在涨、按钮全是灰的」。改成现金基数之后**永远有 (1−rf) 能动**，
 *    而且「现金少了储备自然跟着少」变成数学恒等式（见 `content.RESERVE_FRAC`）。
 */
export const reserveOf = money => Math.max(0, money) * RESERVE_FRAC;

/** 可动用现金（元）= 现金 − 储备金 = 现金 × (1 − 储备比例)。购买只能用这一部分。 */
export const spendableOf = s => Math.max(0, s.money) - reserveOf(s.money);

/**
 * 买得起吗（**绕开储备金之后**还买得起）。
 * ⚠️ 必须带相对容差：`(cost + 储备) − 储备` 在浮点里会丢几个 ulp，边界上会算出
 *    `可动用 = cost − 8.7e-11 < cost` —— 界面把按钮点亮了，点下去却 `false`。
 *    `canAfford`（按钮亮度）与 `purchase`（真扣款）用**同一条闸门**，两者才不会打架。
 */
const afford = (avail, cost) => avail >= cost * (1 - 1e-9);
export const canAfford = (s, id) => afford(spendableOf(s), costFor(s, id));

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
  // 公司页那两条「资产」线（算力 / 渠道）—— 没有对应的年度决策变量，直接吃等级
  const comp = factor.c;
  const chan = factor.d;
  /** 按线 id 取效果（界面用：`×N` 那个数） */
  const effect = { c: comp, d: chan, r: prod, m: share, h: team };

  const income = INCOME_SCALE * prod * share * team * comp * chan;   // 元/秒
  const revenue = income * SEC_PER_YEAR;                             // 元/年
  const frac = salaryFrac(s.stage) + scaleFrac(s.stage);
  const upkeep = revenue * frac;                                     // 元/年
  return {
    levels, prod, share, team, comp, chan, effect, frac,
    income, revenue, upkeep,
    net: revenue - upkeep,                                    // 元/年
    netPerSec: income * (1 - frac),                           // 元/秒
    margin: 1 - frac,
  };
}

/** 市盈率 = 章节基准 + 决策累加，夹取到 [8, 60]（不变式 ④） */
export const peOf = s => {
  const base = (ACTS[s.stage] || ACTS[1]).pe + ((s.mod && s.mod.pe) || 0);
  return Math.max(PE_MIN, Math.min(PE_MAX, base));
};

/**
 * 行业总盘子（元/年）——「你所在的那个市场一年有多大」。
 * 以 2026 年的 **50 亿元/年**为底，按 **1.165/年** 复利（比现实里成熟的 IT 行业快，
 * 因为这里面装着 AI / 算力 / 云 / 太空几条同时在膨胀的线）。
 *
 * ⚠️ 旧版的 `份额 = 100·年营收/(年营收 + 本幕门槛/PE)` 有个致命后果：**开局就有 40%**
 *    （开局年营收 5928 元、分母 8750 元）—— 用户 2026-09-26 明确报了这个数。
 *    份额的分母必须是**外生的行业盘子**，不能是本幕门槛（那是玩家自己的目标）。
 *
 * 三个刻度的取法（都由「头尾必须像真的」反推）：
 *   · `TAM0 = 5e9` ⇒ 开局份额 `100×36万/(50亿+36万) ≈ 0.007%` —— 就是「还没有份额」；
 *   · `TAM_GROWTH = 1.165` ⇒ 2066 年盘子 `5e9×1.165^40 ≈ 2.27e12`，那时玩家年营收 3.4e12
 *     ⇒ 份额 `3.4/(2.27+3.4) ≈ 60%` ——用户 2026-09-27 要的「结局在 50% 左右」。
 *   · **口径是「赛道份额」**（自家细分赛道：AI / 算力 / 云），不是「全行业市场份额」——
 *     现实里世界第一的 IT 公司只占全行业 10–25%（NVIDIA 在 AI 加速卡里能到 90%，
 *     那正是细分赛道口径）。所以 UI 展示名一律写「赛道份额」。
 *   1.30 会让终局份额只剩 5%（盘子涨得比玩家快），所以压到 1.165。
 */
export const TAM0 = 5e9;
export const TAM_GROWTH = 1.165;
export const tamOf = year => TAM0 * TAM_GROWTH ** Math.max(0, (year | 0) - 2026);

/**
 * 「显示份额」= 100 · 年营收 / (年营收 + 行业盘子)。
 * @param {number} revenue 年营收（元）
 * @param {number} year    游戏内当前**日历年**（进度钟的派生量）
 * 分子分母都在长，而年营收长得更快（每章 ×10 量级 vs 盘子 ×1.3/年）⇒ 全程单调上升。
 */
export const sharePctOf = (revenue, year) => {
  const tam = tamOf(year);
  return 100 * revenue / (revenue + tam);
};

/**
 * 派生展示值（**不入存档**）。
 *
 * ### 为什么「市值」被拆成两个字段（用户 2026-09-27）
 * 估值周期的存在意味着市值**会跌**，而日历是「市值 → 月」的对数插值
 * （`format.calMonthOf`）—— 市值一跌日期就倒退，`tools/probes.mjs` 有硬断言守着。
 * 所以把两个含义分开：
 *
 * | 量 | 含义 | 谁用它 |
 * |---|---|---|
 * | `marketCapBase` = `年营收 × PE` | 公司的**真实进度** | **只给日历**（`calMonthOf` 内部优先取它） |
 * | `marketCap` = `base × valAt(月)` | 市场**当时肯给的价格** | HUD、世界榜、推幕闸门、里程碑、IPO 线 |
 *
 * `marketCapBase` **单调不减**：等级只增、`mod.pe` 只增（事件里没有 pe）⇒ 日历永不倒退。
 * 两个字段都是纯派生量（与 `s.calMonth` 同规矩不进存档）⇒ **不升 `SAVE_VERSION`**：
 * 读档后重算得到同一个值。
 *
 * 语义上也站得住：**日历记的是「公司走到哪一步」，市值记的是「市场当时给多少钱」**——
 * 估值与经营脱钩，正是现实里会发生的事。
 */
export function derived(s, R = rates(s)) {
  const pe = peOf(s);
  const reserve = reserveOf(s.money);
  const base = R.revenue * pe;
  return {
    ...R, pe, marketCapBase: base, marketCap: base * valAt(gameMonths(s)),
    sharePct: sharePctOf(R.revenue, gameYear(s)),
    reserve, spendable: spendableOf(s),
  };
}

/**
 * 手动点击一次要花多少钱（元）= 一级的原价 × `MANUAL_PAY`。
 * 它是**按钮上印的那个数**，也是按钮亮不亮的判据 —— 手动与自动不是同一个价。
 */
export const manualCostOf = (s, id) => costFor(s, id) * MANUAL_PAY;

/** 手动那一条闸门：与 `manualBuy` 真扣款同源（按钮亮度不许自己写比较） */
export const canAffordManual = (s, id) => afford(spendableOf(s), manualCostOf(s, id));

/**
 * 买一条线。**手动点击与自动购买走的是同一个函数**（GDD §1.6）——
 * 差别只有 `gain`（自动 1 级、手动 `MANUAL_GAIN` 级）与 `payScale`
 * （自动 1 级原价、手动 `MANUAL_PAY` 级原价）。
 * ⚠️ 钱的闸门是「**可动用现金**」（现金 − 储备金），不是现金本身（用户 2026-09-26）。
 * @param {number} [gain=1] 这一次买几级
 * @param {number} [payScale=1] 按几级的原价付钱
 * @returns {boolean} 是否买成
 */
export function purchase(s, id, gain = 1, payScale = 1) {
  const c = costFor(s, id) * payScale;
  if (!afford(spendableOf(s), c)) return false;
  s.money -= c;
  s.lines[id] = lineLevel(s, id) + gain;
  return true;
}

/**
 * 选一条「当前等级最低」的线 —— 自动购买的决策规则（GDD §1.6）。
 * 五条线共用 `cost(n)` ⇒ 等级最低的那条就是最便宜的那条，均衡会自动维持。
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
