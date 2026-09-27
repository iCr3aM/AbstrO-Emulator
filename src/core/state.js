/**
 * 游戏状态 + 存档序列化（GDD §3.2）
 * ===============================================================
 * 原则：**只存「原始事实」，不存「派生值」**。
 *   存：现金、五条线的等级、已做的决策、世界表、在手订单
 *   不存：产品力 / 份额 / 团队效率 / 年营收 / 市值 / 名次 —— 每次由 `economy.rates()` 重算
 * 所以永远不会有「存档里的加成和资源对不上」这类 bug。
 */

import { ACTS, OPENING, LINES } from './content.js';

/**
 * ⚠️ 版本号 20 → 21：新增**订单**子系统（用户 2026-09-27）。旧档没有 `orders.next`，
 * 直接合出一份「从第 0 月起补生成订单」的档会一次涌出十几条 —— 与 19 → 20
 * （七幕改八章）同一先例：`migrate()` 返回 null ⇒ 给一份新状态，不做半吊子的字段搬运。
 */
export const SAVE_VERSION = 21;
export const SAVE_KEY = 'abstract-studio.save.v1';

export function createState() {
  return {
    version: SAVE_VERSION,
    createdAt: Date.now(),
    savedAt: Date.now(),

    /** 本局累计真实秒（倍速**不**放大；只服务离线结算与日志锚定） */
    elapsed: 0,
    /** 最后一次 tick 注入的真实时间戳（毫秒）—— 离线结算的唯一真相源 */
    lastSeen: Date.now(),
    /**
     * 进度钟缓存（由 `engine.tick` 每帧写、由 `format.gameMonths` 读）。
     * **正篇不入存档** —— 它完全由市值派生，读档后第一帧就会重算（见 `save.applyOffline`）。
     * ⚠️ **回味期（登顶后）例外，必须存**：那时它由**真实秒**推进（1 真实分钟 = 1 游戏年），
     *    从市值**算不回来** —— 不存的话读档后它从 0 重来，`worldTick` 会把世界重建回 2026 年。
     *    剥离只发生在非结局档，见 `serialize`。
     */
    calMonth: 0,
    /**
     * 登顶那一刻的游戏月（`u` 的唯一依据，见 `content.SAVOR_RAMP_MONTHS`）。
     * 默认 0：旧档合并后拿到 0，而 `ending` 为 null 的旧档根本不走回味分支 ⇒ 0 从不被读。
     */
    topMonth: 0,

    stage: 1,
    money: 0,
    /** 五条线的等级（只增不减） */
    lines: Object.fromEntries(LINES.map(l => [l.id, 0])),
    /**
     * 决策带来的修正。三类变量与 PE 各一个累加器 ——
     * 这是年度决策**唯一**的落点（GDD §1.5：每个选项只能影响 cash / prod / share / team / pe）。
     */
    mod: { prod: 1, share: 1, team: 1, pe: 0 },

    /** 上一次发过年报的游戏年（1..35），防重复触发 */
    lastYear: 0,
    /** 待决事件 `[{ uid, id }]`，积压上限 `PENDING_CAP` */
    pending: [],
    uidSeq: 0,
    /** 积压超限被按默认选项结算的条数（年度报告里报一行） */
    overflowed: 0,
    /**
     * 第 `AUTO_DECIDE_STAGE` 幕起因「后期自动化」直接按默认选项结算的年数（§1.5）。
     * 它与 `decisions + pending + overflowed` 相加**必须等于已过的年数** —— 这条恒等式
     * 是「每年恰好一条待决」的机器判据（见 `tools/probes.mjs`）。
     */
    autoDecided: 0,
    /** 已经抽到过的事件 id，尽量不重复 */
    seen: [],
    decisions: 0,

    log: [OPENING],

    // ── 世界市值榜（惰性初始化：第一次 tick 才建 100 家的表）──
    world: null,
    /** 世界种子：`world.js` 用它决定「抽到哪几家黑马」（字段名与 `world.js` 的读取一致） */
    rngSeed: 20260924,
    worldCap: null,
    worldPrevCap: null,
    worldRank: null,
    /** 上月末的玩家名次（与 `worldPrevCap` 同一次快照）—— HUD 世界格的名次环比用它 */
    worldRankPrev: null,
    worldBest: 999,
    worldMilestones: [],
    /** 已经记过的**叙事里程碑下标**（`content.MILESTONES` 的顺序号）—— 只记日志，不加效果 */
    mcapMilestones: [],

    // ── 融资（`finance.rounds` 已完成的轮次 id）──
    finance: { rounds: [] },

    /**
     * 订单（`orders.js`）：`next` = 下一条要生成的序号（第 n 条在第 `n × 6` 个月出现），
     * `live` = 在手 `[{ uid, tier, born }]`，上限 `ORDER_SLOTS` 条，`done` = 累计交付数。
     * 只存这几个原始事实，「还有几个月到期 / 值多少钱」都是派生量。
     * ⚠️ `done` 是 2026-09-27 补的纯计数（界面右上角「已完成 N 单」）——`migrate` 的
     *    `{ ...fresh.orders, ...(data.orders || {}) }` 已经会让旧档拿到 0，**不必升版本**。
     */
    orders: { next: 0, live: [], done: 0 },

    // ── 设置 ──
    speed: 1,
    /**
     * 音效开关（`src/ui/audio.js`）。默认开 —— 音效只是动作的回执、不是信息，
     * 关掉不会少看一个数，所以在 ⚙ 里留一个开关就够。
     * ⚠️ 它是**顶层字段**，`deserialize` 的 `{ ...fresh, ...data }` 会让旧档自动拿到 `true`。
     */
    sfx: true,

    /** 结局：`'top'` = 唯一结局「登顶」，否则 null（游戏继续） */
    ending: null,
  };
}

/** 序列化：去掉运行时派生字段，裁日志 */
export function serialize(s) {
  /**
   * 不存：`calMonth`（进度钟缓存，**回味期例外**，见下）、`orderWin`（订单日志的归并窗口）、
   * `savorCap`（回味期市值的派生缓存，读档后第一帧由 `worldTick` 重算 ——
   * **包括封顶之后**，那一条路由 `engine.tick` 的封顶出口补算，否则它会永远是 0）。
   *
   * ⚠️ `calMonth` 只在 `s.ending`（回味期）时留：
   *    正篇里它完全由市值派生（`save.applyOffline` 读档时重算得到），存了反而多一处可能撒谎的字段；
   *    回味期里它由**真实秒**推进、**算不回来**，不存 ⇒ 读档后日历从 0 重来、
   *    世界被 `worldTick` 重建回 2026 年（名次与榜单全废）。
   */
  const { calMonth, orderWin, savorCap, ...save } = s;
  return JSON.stringify({
    ...save,
    ...(s.ending ? { calMonth } : {}),
    savedAt: Date.now(),
    log: s.log.slice(-40),
  });
}

/** 反序列化 + 版本迁移 */
export function deserialize(raw) {
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  if (data.version < SAVE_VERSION) data = migrate(data);
  if (!data) return null;

  const fresh = createState();
  const merged = { ...fresh, ...data };
  // 嵌套对象逐层合并，避免旧档缺字段时拿到 undefined
  merged.lines = { ...fresh.lines, ...(data.lines || {}) };
  merged.mod = { ...fresh.mod, ...(data.mod || {}) };
  merged.finance = { ...fresh.finance, ...(data.finance || {}), rounds: (data.finance && data.finance.rounds) || [] };
  merged.orders = { ...fresh.orders, ...(data.orders || {}) };
  merged.orders.live = (data.orders && data.orders.live) || [];
  merged.pending = (data.pending || []).filter(p => p && p.id);
  merged.seen = data.seen || [];
  merged.worldMilestones = data.worldMilestones || [];
  merged.mcapMilestones = data.mcapMilestones || [];
  merged.log = Array.isArray(data.log) && data.log.length ? data.log : fresh.log;
  // 五条线等级只增不减 —— 夹到合法区间，防手改存档
  for (const l of LINES) merged.lines[l.id] = Math.max(0, Math.floor(merged.lines[l.id] || 0));
  merged.stage = Math.max(1, Math.min(ACTS.length - 1, merged.stage | 0));
  merged.version = SAVE_VERSION;
  return merged;
}

/**
 * 迁移：v4 是重制，旧档**不可迁移** —— 直接给一份新状态。
 * 这里刻意不写 v18 及以前的字段搬运表：那批字段的含义（建筑座数、员工、合同、持股）
 * 在新版里已经没有对应物，搬过来只会造出一份自相矛盾的存档。
 */
function migrate(data) {
  return data.version < SAVE_VERSION ? null : data;
}
