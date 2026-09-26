/**
 * 引擎（GDD §1.5 / §1.6 / §1.7）
 * ===============================================================
 * 一个 tick 只做六件事，顺序不能换：
 *   ① 生产（净收入入账）→ ② 自动购买（买「等级最低」那条线）→ ③ 重算
 *   → ④ 进度钟（日历 = 阶段内市值进度）→ ⑤ 融资 → ⑥ 世界榜 / 推幕 / 年度报告
 *
 * ⚠️ 年度决策**并在这里**（GDD §3.2 明确：不新建文件）。它是全作唯一的抉择层：
 *   在线不弹窗，主界面只显示待决角标；积压上限 `PENDING_CAP` 条，第 4 条起按默认选项自动结算。
 *
 * ⚠️ 全作**零 `Math.random()`** —— 事件按序轮转抽取，所以同一份存档永远走到同一个未来，
 *   无头工具才可能断言。
 */

import {
  ACTS, LINES, PENDING_CAP, IPO_LINE,
  eventsFor, eventById, companyName,
} from './content.js';
import { rates, derived, purchase, lowestLine, costFor, lineLevel } from './economy.js';
import { financeTick } from './finance.js';
import { worldTick } from './world.js';
import { calMonthOf, gameYear, gameMonths } from './format.js';

/** 日志保留条数（存档里只留最后 40 条，见 state.serialize） */
export const LOG_MAX = 60;
/** 一次 tick 内自动购买的次数上限 —— 防「一次大额到账」时把循环卡住 */
const AUTO_BUY_MAX = 16;

// ─────────────────────────── 效果 ───────────────────────────
/**
 * 把一次决策/融资的效果落到五个变量上 —— **这是唯一的落点**（GDD §1.5）。
 * `cash` 的单位是**年营收**（自动随公司成长缩放）；`prod/share/team` 是乘数；`pe` 是加减。
 * 现金下不封负：决策不许把公司变成负资产（本作没有破产）。
 */
export function applyEffect(s, eff, R) {
  if (!eff) return;
  if (eff.cash) s.money = Math.max(0, s.money + R.revenue * eff.cash);
  if (eff.prod) s.mod.prod *= eff.prod;
  if (eff.share) s.mod.share *= eff.share;
  if (eff.team) s.mod.team *= eff.team;
  if (eff.pe) s.mod.pe += eff.pe;
}

// ─────────────────────────── 自动购买（§1.6）───────────────────────────
/**
 * 每 tick 买「当前等级最低」的那条线 —— 这是游戏**真正的引擎**，玩家不在它也一直转。
 * 三条线共用 `cost(n)` ⇒ 等级最低 = 最便宜 ⇒ 均衡自动维持，不用玩家自己算。
 */
function autoBuy(s) {
  let n = 0;
  let id = lowestLine(s);
  while (n < AUTO_BUY_MAX && s.money >= costFor(s, id)) {
    purchase(s, id);
    id = lowestLine(s);
    n += 1;
  }
  if (n > 0) logPurchases(s);
}

/**
 * 流水里的购买行按**时间窗合并**（30 真实秒，随最后一次购买顺延）：
 * 窗口内只就地改写同一行，行数不涨。累积状态挂在模块级 WeakMap，**不进存档**
 * （存了就会变成「关掉页面再打开，突然冒出一行旧账」）。
 */
const BURST_WINDOW = 30;
const bursts = new WeakMap();
function logPurchases(s) {
  const now = s.elapsed || 0;
  let b = bursts.get(s);
  if (!b || now - b.at >= BURST_WINDOW) { b = { at: now, idx: -1, line: '' }; bursts.set(s, b); }
  b.at = now;
  const text = `🔨 ${LINES.map(l => `${l.name} Lv${lineLevel(s, l.id)}`).join(' · ')}`;
  if (b.idx < 0) b.idx = s.log.length;
  else if (s.log[b.idx] !== b.line) {
    const i = s.log.lastIndexOf(b.line);
    b.idx = i >= 0 ? i : s.log.length;
  }
  s.log[b.idx] = text;
  b.line = text;
}

// ─────────────────────────── 年度决策（§1.5）───────────────────────────
/**
 * 抽一条事件：**按序轮转**（`uidSeq + decisions` 取模），不随机。
 * 池子里的都抽过一遍后重置 `seen`，允许再来一轮。
 */
function drawEvent(s) {
  const pool = eventsFor(s.stage);
  if (!pool.length) return null;
  let fresh = pool.filter(e => !s.seen.includes(e.id));
  if (!fresh.length) {
    for (const e of pool) {
      const i = s.seen.indexOf(e.id);
      if (i >= 0) s.seen.splice(i, 1);
    }
    fresh = pool;
  }
  const pick = fresh[(s.uidSeq + s.decisions) % fresh.length];
  s.seen.push(pick.id);
  return pick;
}

/** 待决队列里的第一条（界面只显示角标 + 逐条处理） */
export function pendingEvent(s) {
  const p = s.pending && s.pending[0];
  return p ? eventById(p.id) : null;
}

/**
 * 结算一条待决事件。
 * @returns {boolean} 是否结算成功（uid 对不上说明界面拿的是过期节点）
 */
export function resolvePending(s, uid, optIndex, R = rates(s)) {
  const i = (s.pending || []).findIndex(p => p.uid === uid);
  if (i < 0) return false;
  const ev = eventById(s.pending[i].id);
  s.pending.splice(i, 1);
  if (ev) {
    const opt = ev.options[optIndex] || ev.options[ev.default] || ev.options[0];
    applyEffect(s, opt.eff, R);
    s.decisions += 1;
    s.log.push(`【决策】${ev.title} → ${opt.text}`);
  }
  return true;
}

/** 用默认选项结算前 n 条（积压超限时调用） */
function resolveByDefault(s, n, R) {
  let done = 0;
  while (done < n && s.pending.length) {
    const p = s.pending.shift();
    const ev = eventById(p.id);
    if (ev) {
      applyEffect(s, ev.options[ev.default].eff, R);
      done += 1;
    }
  }
  s.overflowed += done;
  return done;
}

/** 年度报告：每年 1 条待决事件 + 一行年度摘要 */
function annualReport(s, R, D) {
  const y = gameYear(s);
  if (y <= s.lastYear) return;
  s.lastYear = y;

  const ev = drawEvent(s);
  let spilled = 0;
  if (ev) {
    s.pending.push({ uid: ++s.uidSeq, id: ev.id });
    // 积压上限：第 4 条起按默认选项自动结算（在线、离线同一条规则）
    if (s.pending.length > PENDING_CAP) spilled = resolveByDefault(s, s.pending.length - PENDING_CAP, R);
  }
  s.log.push(`【第 ${y} 年】${s.pending.length ? `待决 ${s.pending.length} 条` : '无待决'}`
    + (spilled ? ` · 另有 ${spilled} 条已按默认处理` : ''));
}

// ─────────────────────────── 推幕与目标 ───────────────────────────
/** 阶段目标是否达成（**只用于年度报告里打勾**，不额外加闸） */
export function stageGoalMet(s, R, D) {
  switch (s.stage) {
    case 1: return R.prod >= 3.0;
    case 2: return R.net > 0;
    case 3: return D.sharePct >= 15;
    case 4: return (s.finance.rounds || []).includes('a');
    case 5: return D.marketCap >= IPO_LINE;
    case 6: return (s.worldRank ?? 999) <= 10;
    case 7: return s.worldRank === 1;
    default: return false;
  }
}

/** 唯一的机械闸门：`市值 ≥ 本阶段 mcap` ⇒ 自动进入下一阶段（不弹窗、不给偏置） */
function advanceStage(s, D) {
  const last = ACTS.length - 1;
  if (s.stage >= last) return false;
  if (!(D.marketCap >= ACTS[s.stage].mcap)) return false;
  s.stage += 1;
  const a = ACTS[s.stage];
  s.log.push(`【${a.place}】${a.years} 起 · 目标：${a.goal}`);
  return true;
}

// ─────────────────────────── tick ───────────────────────────
/**
 * @param {object} s   状态
 * @param {number} dtReal 本步的**真实**秒（倍速在内部放大；`s.elapsed` 只记真实秒）
 */
export function tick(s, dtReal = 0.1) {
  const dt = dtReal * (s.speed || 1);

  // ① 生产
  let R = rates(s);
  s.money += R.netPerSec * dt;
  s.elapsed += dtReal;

  // ② 自动购买（默认开启、无开关）
  autoBuy(s);

  // ③ 重算
  R = rates(s);
  const D = derived(s, R);

  // ④ 进度钟：日历 = 阶段起点 + 阶段内市值进度 × 5 年（玩得快，时间就走得快）
  s.calMonth = calMonthOf(s, D);

  // ⑤ 融资（按日历年到点；IPO 看市值）
  financeTick(s, R, D);

  // ⑥ 世界榜（与日历同一真相源）→ 推幕 → 年度报告
  worldTick(s, R);
  advanceStage(s, D);
  annualReport(s, R, D);

  // 登顶 = 唯一结局的判据（`worldRank` 由 world.js 维护，这里不另算一遍）
  if (!s.ending && s.worldRank === 1) {
    s.ending = 'top';
    s.log.push(`【登顶】${companyName(s.stage)} 成了世界第一。上面没有人了。`);
  }

  if (s.log.length > LOG_MAX) s.log.splice(0, s.log.length - LOG_MAX);
  return { R, D };
}

// ─────────────────────────── 主循环 ───────────────────────────
/**
 * @param {object} s
 * @param {() => void} [onTick]
 * @param {() => void} [onRender]
 * @returns {{ start: () => void, stop: () => void }}
 */
export function createLoop(s, onTick, onRender) {
  const STEP = 0.1;      // 逻辑步长（秒）
  const MAXDT = 1.0;     // 单帧最多补 1 秒 —— 后台标签页回来不许一次结算半天
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let running = false;
  let last = 0;
  let acc = 0;
  let raf = 0;

  const frame = ms => {
    if (!running) return;
    const dt = Math.min(MAXDT, Math.max(0, (ms - last) / 1000));
    last = ms;
    acc += dt;
    let guard = 0;
    while (acc >= STEP && guard++ < 60) { tick(s, STEP); acc -= STEP; }
    if (onTick) onTick();
    if (onRender) onRender();
    raf = requestAnimationFrame(frame);
  };

  return {
    start() {
      if (running) return;
      running = true;
      last = now();
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}

/**
 * 离线结算用的**纯自动模拟**（GDD §1.7）：自动购买 + 所有年度决策取默认选项。
 * 不逐帧重放 —— 按 1 秒步长跑一遍等效游戏时间。
 *
 * ⚠️ 它**不改** `s.elapsed` 与 `s.speed`：前者由 `save.applyOffline` 按真实离线秒记，
 *    后者是玩家的设置。两个字段都在这里暂存后还原。
 */
export function offlineRun(s, seconds) {
  const from = { stage: s.stage, months: gameMonths(s), money: s.money, overflowed: s.overflowed };
  const keepSpeed = s.speed;
  const keepElapsed = s.elapsed;
  s.speed = 1;
  let left = Math.max(0, seconds);
  let guard = 0;
  while (left > 0 && guard++ < 40000) {
    const step = Math.min(1, left);
    tick(s, step);
    left -= step;
  }
  s.speed = keepSpeed;
  s.elapsed = keepElapsed;
  return {
    stageFrom: from.stage,
    stageTo: s.stage,
    monthsFrom: from.months,
    monthsTo: gameMonths(s),
    cashGained: s.money - from.money,
    overflowed: s.overflowed - from.overflowed,
    pending: s.pending.length,
    rank: s.worldRank,
    revenue: rates(s).revenue,
  };
}
