/**
 * 游戏状态 + 存档序列化（GDD §3.2）
 * ===============================================================
 * 原则：**只存「原始事实」，不存「派生值」**。
 *   存：现金、三条线的等级、已做的决策、世界表
 *   不存：产品力 / 份额 / 团队效率 / 年营收 / 市值 / 名次 —— 每次由 `economy.rates()` 重算
 * 所以永远不会有「存档里的加成和资源对不上」这类 bug。
 */

import { ACTS, OPENING, LINES } from './content.js';

/**
 * ⚠️ 版本号从 18 直接跳到 19：v4 是**重制**，字段含义全变了
 * （`buildings` 座数 → `lines` 等级、`resources.money` → `money`、多了 `mod`）。
 * 旧档无法迁移，`migrate()` 直接给一份新状态 —— 不做半吊子的字段搬运。
 */
export const SAVE_VERSION = 19;
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
     * 进度钟缓存：`阶段起点 + 阶段内市值进度 × 5 年`（由 `engine.tick` 每帧写、由 `format.gameMonths` 读）。
     * **不入存档** —— 它完全由市值派生，读档后第一帧就会重算（见 `save.applyOffline`）。
     */
    calMonth: 0,

    stage: 1,
    money: 0,
    /** 三条线的等级（只增不减） */
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
    /** 已经抽到过的事件 id，尽量不重复 */
    seen: [],
    decisions: 0,

    log: [OPENING],

    // ── 世界市值榜（惰性初始化：第一次 tick 才建 100 家的表）──
    world: null,
    worldSeed: 20260924,
    worldCap: null,
    worldPrevCap: null,
    worldRank: null,
    worldBest: 999,
    worldMilestones: [],

    // ── 融资（`finance.rounds` 已完成的轮次 id）──
    finance: { rounds: [] },

    // ── 设置 ──
    speed: 1,

    /** 结局：`'top'` = 唯一结局「登顶」，否则 null（游戏继续） */
    ending: null,
  };
}

/** 序列化：去掉运行时派生字段，裁日志 */
export function serialize(s) {
  const { calMonth, ...save } = s;
  return JSON.stringify({ ...save, savedAt: Date.now(), log: s.log.slice(-40) });
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
  merged.pending = (data.pending || []).filter(p => p && p.id);
  merged.seen = data.seen || [];
  merged.worldMilestones = data.worldMilestones || [];
  merged.log = Array.isArray(data.log) && data.log.length ? data.log : fresh.log;
  // 三条线等级只增不减 —— 夹到合法区间，防手改存档
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
