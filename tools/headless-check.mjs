#!/usr/bin/env node
/**
 * 节奏量尺（GDD §5.3）
 * ===============================================================
 * 它跑的是**线上真正会用的 src/core 代码**，所以「这里通过 = 线上实现的节奏与目标一致」。
 * 以后改 content.js 的任何数字，跑一次就知道有没有把节奏改坏。
 *
 * 两条**闸门**路径（判据全部来自 tools/curve-targets.mjs，唯一真相源）：
 *   node tools/headless-check.mjs          # A 主动：每年选「对数市值增量最大」的那个选项
 *   node tools/headless-check.mjs --idle   # D 挂机：待决一律按默认（保守项）结算
 *
 * A 路径判「节奏五项」：七幕全部到达、幕弧长都是有限值、严格递增、合计 ∈ CURVE_BAND、
 * 每幕落在 CURVE_MID ± CURVE_TOL 内。
 * D 路径只判四项：能通关 + 递增 + 合计 ∈ IDLE_BAND + 幕弧长可测。
 * 它的逐幕偏差**照打**，但标成「参考」不计入 `bad` —— CURVE_MID 是**主动**路径的曲线，
 * 而挂机走的是「一律选保守项」，要求两条路径落在同一区间等于要求「不做决策不会变慢」。
 *
 * 另有一条与节奏无关、但标定器必须拿到的事实：**登顶在物理上够不够得着**。
 * 判据是「玩家终局市值 ≥ 同一游戏月的榜首」—— 世界榜按**玩家的进度钟**推进，
 * 所以只能拿**玩家收尾那一月**的榜首来比，不能拿第 420 月的（慢玩家会赢在日历打满之前，
 * 用它去比会误报「够不着」）。
 * 反过来也守一下上限：玩家不该是同月榜首的 1.25 倍以上 —— 那说明终局线虚高，
 * 最后一幕会在日历打满之前就收尾（节奏会掉出 `CURVE_MID`）。
 *
 * 同时把**第 420 月榜首**也报出去：第 7 幕的门槛锚点 `ACTS[7].mcap` 就是照这个数钉的，
 * `npm run tune` 要用它守住那条锚点。
 *
 * ⚠️ 本文件末尾**没有** process.exit ⇒ `npm run check` 恒退出 0。
 *    结论只读末尾那一行 `BRIEF {...}`；robust / tune 都靠它取数。
 * ⚠️ 改 content.js 任何数字 ⇒ 必须重跑 `tune` + `check` + `robust`。
 */

import {
  ACTS, LINE_IDS, CURVE_RATIO, PENDING_CAP,
} from '../src/core/content.js';
import { createState } from '../src/core/state.js';
import { rates, derived, costFor, lowestLine, peOf } from '../src/core/economy.js';
import { tick, pendingEvent, resolvePending, manualBuy } from '../src/core/engine.js';
import { createWorld, advanceWorld, ranking, toUSD_T } from '../src/core/world.js';
import { MONTHS_TOTAL, gameMonths } from '../src/core/format.js';
import { CURVE_BAND, IDLE_BAND, CURVE_MID, CURVE_TOL } from './curve-targets.mjs';

// ─────────────────────────── 决策策略 ───────────────────────────
/**
 * 一个选项在**对数市值**上的增量 —— `best` / `worst` 的排序依据。
 *
 * 为什么用对数：市值是乘积形式（`INCOME_SCALE·SEC_PER_YEAR·gen·pe·F·r^(ΣL/3)`），
 * 只有取对数之后各选项才可加、才跨幕可比。三项一阶效应：
 *   · `cash` c（单位 = 年营收）⇒ 能多买 `c·revenue / cost` 次 ⇒ `Δln = 次数 × ln r / 3`
 *     （每次购买把 `ΣL` 抬 1 ⇒ 市值 ×`r^(1/3)`）
 *   · `prod/share/team` 是乘数 ⇒ `Δln = ln(乘数)`
 *   · `pe` 是加法 ⇒ `Δln = ln((pe+Δ)/pe)`
 */
function logCapDelta(s, eff, R) {
  if (!eff) return 0;
  let d = 0;
  if (eff.cash) {
    const times = (eff.cash * R.revenue) / costFor(s, LINE_IDS[0]);
    d += (times * Math.log(CURVE_RATIO)) / 3;
  }
  for (const k of ['prod', 'share', 'team']) if (eff[k]) d += Math.log(eff[k]);
  if (eff.pe) {
    const pe = peOf(s);
    d += Math.log(Math.max(1e-9, (pe + eff.pe) / pe));
  }
  return d;
}

/**
 * 五种「玩家性格」+ 一种「什么都不做」。返回选项下标；`null` = 不处理待决。
 * 全部**零随机**（引擎本身也零随机，事件按序轮转），所以同一策略永远得到同一条曲线。
 */
export const STRATEGIES = {
  /** 保守：每年都选「保住现金」那一项（= 事件的 default 项） */
  conserve: () => 0,
  /** 激进：每年都选「花钱换乘数」那一项 */
  invest: () => 1,
  /** 交替：奇数年保守、偶数年投入 */
  mixed: (ev, s, i) => i % 2,
  /** 最优：每年选对数市值增量更大的那一项 */
  best: (ev, s) => {
    const R = rates(s);
    const a = logCapDelta(s, ev.options[0].eff, R);
    const b = logCapDelta(s, ev.options[1] && ev.options[1].eff, R);
    return a >= b ? 0 : 1;
  },
  /** 最差：每年都选对数市值增量更小的那一项（消极玩法的下界） */
  worst: (ev, s) => {
    const R = rates(s);
    const a = logCapDelta(s, ev.options[0].eff, R);
    const b = logCapDelta(s, ev.options[1] && ev.options[1].eff, R);
    return a <= b ? 0 : 1;
  },
  /** 挂机：一条待决都不碰 —— 交给引擎的积压上限按默认选项结算（§1.5） */
  default: null,
};

// ─────────────────────────── 跑一局 ───────────────────────────
/**
 * 跑一局到结局（或超时）。
 *
 * @param {object} opts
 *   `strategy`    `STRATEGIES` 的键
 *   `step`        逻辑步长（真实秒）。取 1s：线上主循环是 0.1s，但最短购买间隔 ≈ 20s
 *                 （`LINE_COST0 / (INCOME_SCALE·gen·F·margin)` 的全程最小值），
 *                 1s 的量化误差对 1.7 万秒的一局是 0.006% —— 换来 10× 的执行速度。
 *   `maxHours`    超时上限（真实小时）
 *   `manualClick` 抢点的节律（秒）；`0` = 不点。走的是线上那条手动路径
 *                 （`engine.manualBuy`：一次 `MANUAL_GAIN` 级），用来量「手动到底快多少」。
 *                 ⚠️ 它**不是**「多点几下就更快」：门槛是钱不是手，1 秒一次与 20 秒一次实测只差 5%。
 */
export function run({ strategy = 'best', step = 1, maxHours = 40, manualClick = 0 } = {}) {
  const decide = STRATEGIES[strategy] ?? null;
  const s = createState();
  const durs = [];
  let cur = s.stage;
  let stageStart = 0;
  let t = 0;
  let decisions = 0;
  let clicks = 0;
  let steps = 0;
  const maxSteps = Math.ceil((maxHours * 3600) / step);

  while (!s.ending && steps < maxSteps) {
    steps += 1;
    tick(s, step);
    t += step;

    // 手动点击：与自动购买同一个 `purchase`，差别只有「玩家指定哪条」+ 一次 MANUAL_GAIN 级
    if (manualClick > 0 && steps % manualClick === 0) {
      const id = lowestLine(s);
      if (s.money >= costFor(s, id)) { manualBuy(s, id); clicks += 1; }
    }

    if (decide) {
      const ev = pendingEvent(s);
      if (ev) {
        const k = decide(ev, s, decisions++);
        if (k != null) resolvePending(s, s.pending[0].uid, k, rates(s));
      }
    }

    if (s.stage !== cur) {
      durs.push((t - stageStart) / 3600);
      stageStart = t;
      cur = s.stage;
    }
  }
  // 结局发生在最后一幕内部 ⇒ 循环退出时那一幕还没有收尾（只在它收尾才 push）
  if (durs.length < cur) durs.push((t - stageStart) / 3600);

  const total = durs.reduce((a, x) => a + x, 0);
  const complete = durs.length === ACTS.length - 1 && durs.every(Number.isFinite);
  let mono = complete;
  for (let a = 1; a < durs.length && mono; a++) if (!(durs[a] > durs[a - 1])) mono = false;

  return {
    s, durs, total, complete, mono,
    ending: s.ending,
    decisions, steps, clicks, seconds: t,
    cap: derived(s).marketCap,
    overflowed: s.overflowed || 0,
    pendingLeft: s.pending.length,
    levels: { ...s.lines },
  };
}

/** 第 `month` 个世界月（0 起）的榜首市值（T USD） */
export function top1At(month) {
  const w = createWorld('B');
  advanceWorld(w, month);
  return ranking(w, null, 1).top[0].cur;
}

/** 第 420 月（2061-09）的榜首（T USD）—— 第 7 幕门槛锚点的参照，标定器也要这个数 */
export function top1AtEnd() {
  return top1At(MONTHS_TOTAL);
}

// ─────────────────────────── CLI ───────────────────────────
const args = process.argv.slice(2);
const IDLE = args.includes('--idle');
const QUIET = args.includes('--quiet');
const STRAT = (args.find(a => a.startsWith('--strategy=')) || '').split('=')[1];
/** `--click` = 每 1 秒抢点；`--click=20` = 每 20 秒抢点（robust 用它守「手速不是变量」） */
const CLICK_ARG = args.find(a => a === '--click' || a.startsWith('--click='));
const CLICK = CLICK_ARG ? Number(CLICK_ARG.split('=')[1] || 1) : 0;

const strategy = STRAT || (IDLE ? 'default' : 'best');
const band = IDLE ? IDLE_BAND : CURVE_BAND;
/**
 * 「严格」= 逐幕也要落进 `CURVE_MID ± CURVE_TOL`。只有 A 主动路径严格 ——
 * 理由见文件头（挂机必然更慢，`CURVE_MID` 不是它的曲线）。
 */
const strict = !IDLE;

const t0 = Date.now();
const res = run({ strategy, manualClick: CLICK });
const months = gameMonths(res.s);
const top1USD = top1AtEnd();      // 第 420 月（锚点参照）
const top1Now = top1At(months);   // 玩家收尾那一月（可达性判据）
const playerUSD = toUSD_T(res.cap);

const fmtN = n => {
  if (!Number.isFinite(n)) return '∞';
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + '万亿';
  if (a >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (a >= 1e4) return (n / 1e4).toFixed(2) + '万';
  return a.toFixed(0);
};
const fmtH = h => (h == null || !Number.isFinite(h) ? '—' : h.toFixed(2) + 'h');

const dev = a => (res.durs[a - 1] / CURVE_MID[a] - 1);
const maxDev = res.complete
  ? Math.max(...ACTS.slice(1).map((_, i) => Math.abs(dev(i + 1))))
  : NaN;

const problems = [];
if (!res.complete) problems.push(`有幕未到达（拿到 ${res.durs.length}/${ACTS.length - 1} 幕）或弧长不可测`);
if (!res.mono) problems.push('幕弧长并非严格递增');
if (!(res.total >= band[0] && res.total <= band[1])) problems.push(`合计 ${res.total.toFixed(2)}h 出带 [${band[0]}, ${band[1]}]`);
if (res.ending !== 'top') problems.push(`未走到唯一结局「登顶」（ending = ${res.ending ?? 'null'}）`);
if (strict && res.complete) {
  for (let a = 1; a <= 7; a++) {
    if (Math.abs(dev(a)) > CURVE_TOL) problems.push(`第 ${a} 幕偏差 ${(dev(a) * 100).toFixed(0)}% 超 ±${(CURVE_TOL * 100).toFixed(0)}%`);
  }
}
const capRatio = playerUSD / top1Now;
const reachable = playerUSD >= top1Now;
if (!reachable) problems.push(`登顶物理不可达（终局 ${playerUSD.toFixed(1)}T < 第 ${months} 月榜首 ${top1Now.toFixed(1)}T）`);
else if (capRatio > 1.25) problems.push(`终局线虚高（终局是同月榜首的 ${capRatio.toFixed(2)}×，最后一幕会提前收尾）`);

const out = [];
out.push('═'.repeat(88));
out.push(`  节奏量尺 · ${IDLE ? 'D 挂机' : 'A 主动'}路径 ｜ 策略 ${strategy}`
  + `${CLICK ? ` + 手动每 ${CLICK}s 抢点（实点 ${res.clicks} 次）` : ''}`
  + ` ｜ ${(Date.now() - t0) / 1000}s ｜ 逻辑步数 ${res.steps}`);
out.push('═'.repeat(88));
out.push('');
out.push('  幕  地点            实测       目标         偏差      判定');
out.push('  ' + '─'.repeat(82));
for (let a = 1; a <= 7; a++) {
  const h = res.durs[a - 1];
  const mid = CURVE_MID[a];
  const d = dev(a);
  let v;
  if (h == null || !Number.isFinite(h)) v = '❌未到达';
  else if (Math.abs(d) <= CURVE_TOL) v = '✅';
  else if (strict) v = `❌偏离 ${(d * 100).toFixed(0)}%`;
  else v = `参考·${d < 0 ? '偏快' : '偏慢'} ${(d * 100).toFixed(0)}%`;
  out.push(`  ${a}  ${ACTS[a].place.padEnd(13)} ${fmtH(h).padStart(8)}  ${(mid + 'h').padStart(8)}  `
    + `${(Number.isFinite(d) ? ((d >= 0 ? '+' : '') + (d * 100).toFixed(0) + '%') : '—').padStart(8)}  ${v}`);
}
out.push('  ' + '─'.repeat(82));
out.push(`  合计 ${res.total.toFixed(2)}h ／ 目标 ${CURVE_MID.slice(1).reduce((a, b) => a + b, 0).toFixed(2)}h`
  + ` ／ 带宽 [${band[0]}, ${band[1]}]h → ${res.total >= band[0] && res.total <= band[1] ? '✅ 达标' : '❌ 出带'}`);
out.push(`  单调递增 → ${res.complete ? (res.mono ? '✅' : '❌') : '❌不可测'}`
  + ` ｜ 最大逐幕偏差 ${Number.isFinite(maxDev) ? (maxDev * 100).toFixed(0) + '%' : '—'}`
  + `（容差 ±${(CURVE_TOL * 100).toFixed(0)}%）`);
out.push(`  决策 ${res.decisions} 次 ｜ 积压超限按默认结算 ${res.overflowed} 条 ｜ 余留待决 ${res.pendingLeft}/${PENDING_CAP}`);
out.push(`  终局：${res.ending === 'top' ? '登顶 ✅' : '未登顶 ❌'} ｜ 市值 ${fmtN(res.cap)} 元 = ${playerUSD.toFixed(1)}T USD`);
out.push(`  第 420 月榜首 ${top1USD.toFixed(1)}T USD ／ 玩家终局 ${playerUSD.toFixed(1)}T USD（第 ${months} 月，同月榜首 ${top1Now.toFixed(1)}T）`
  + ` ／ 终局线 ${capRatio.toFixed(3)}× → ${capRatio >= 1 && capRatio <= 1.25 ? '✅ 登顶可达且不虚高' : '❌ 见下'}`);
out.push('');
out.push(`  问题数 bad = ${problems.length}`);
for (const p of problems) out.push(`  ❌ ${p}`);
if (!problems.length) out.push('  ✅ 全部通过');
out.push('');

if (!QUIET) console.log(out.join('\n'));

console.log('BRIEF ' + JSON.stringify({
  route: IDLE ? 'idle' : 'active',
  strategy,
  click: CLICK,
  clicks: res.clicks,
  bad: problems.length,
  mono: res.complete && res.mono,
  total: +res.total.toFixed(2),
  durs: res.durs.map(d => (Number.isFinite(d) ? +d.toFixed(3) : null)),
  maxDev: Number.isFinite(maxDev) ? +maxDev.toFixed(3) : null,
  ending: res.ending,
  cap: +res.cap.toExponential(4),
  top1USD: +top1USD.toFixed(2),
  top1Now: +top1Now.toFixed(2),
  months,
  capRatio: +capRatio.toFixed(3),
  reachable,
  decisions: res.decisions,
  steps: res.steps,
}));
