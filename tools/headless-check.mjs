#!/usr/bin/env node
/**
 * 架构自检（唯一的节奏量尺）
 * ===============================================================
 * 它跑的是**线上真正会用的 src/core 代码**，所以：
 *   - 自检通过 = 线上实现的节奏与目标一致
 *   - 以后改 content.js 的任何数字，跑一次就知道有没有把节奏改坏
 *
 * 判定标准（目标全部来自 tools/curve-targets.mjs，唯一真相源）：
 *   主动玩法合计 3–6 h（CURVE_BAND）｜ 纯挂机合计 3–18 h（IDLE_BAND）
 *   主动路径：每幕落在 CURVE_MID ± CURVE_TOL 内 ｜ 两条闸门路径：每幕时长单调递增
 *   无死条目 ｜ 现实性：地标造价 / 年营收 ≤ LANDMARK_K（派生不等式的上界，不是恒等式）
 *   登顶可达：第 420 月榜首 ≤ 玩家终局的 80%
 *   合同收入占总收入 ≤ 30%（合同是「主动大单」，不是第二条主线）
 *
 * ⚠️ 路径分「闸门」与「诊断」，口径不同（R28 / R31）：
 *   闸门  node tools/headless-check.mjs                            # A 主动：接单 + 跟随顾问（**全量**判据）
 *   闸门  node tools/headless-check.mjs --no-contract              # D 纯挂机：不接单（只判**节奏四项**）
 *   诊断  node tools/headless-check.mjs --no-staff                 # 顾问不建议员工养成（strawman）
 *   诊断  node tools/headless-check.mjs --no-contract --no-staff   # 双重 strawman
 *   诊断  node tools/headless-check.mjs --choice=mixed             # 三路线轮流走（诊断用，不再对应隐藏结局）
 *
 *   · A 主动是**唯一全量闸门**：`bad` 统计本文件所有断言的失败。
 *   · D 纯挂机只判**节奏四项**（R28）：`durs` 有 null/非有限、时长并非单调递增、
 *     合计 ∉ IDLE_BAND、登顶不可达。它的逐幕实测与对 CURVE_MID 的偏差**照打**，
 *     但标成「参考」而不是 ❌ —— CURVE_MID 是主动路径的节奏曲线，而 `IDLE_BAND` 自己
 *     就写着「挂机只守能通关 + 单调递增 + 上限不荒谬，不是节奏指标」。
 *     其余「正确性类」断言（现实性 / 结局表 / 压力 / 渲染 / 启动）在 D 上
 *     仍照打 ❌，但不计入 D 的 `bad` —— 它们与「挂机这条路径的表现」无关，且 A 这条
 *     全量闸门已经守着，在 D 上重复计一次只会让同一件事报两次红灯。
 *   · 诊断路径的 ✅/❌ 一律照打（信息不能丢），但**都不计入 `bad`**。
 *     两条 strawman 会跑到中途就 `break` —— 这是**既有**行为（顾问不建议员工养成
 *     ⇒ 收入上不去），不在本计划修；写在这里，是因为「都跑一遍才算验证完整」不能是空话。
 *     ⚠️ 它们死在第几幕、累计交付多少单**故意不写死**：这些数随每次重标定而变，写死必然过期
 *        （本注释里曾抄着 `[0.25, null×7]` / `done=1139` / `rep=3337`，一次重标定就全错）。
 *        要看实测请直接跑一次该路径。
 *
 * ⚠️ 重新标定请用 `npm run tune`（tools/recalibrate-curve.mjs）。
 *    本文件里的 `--tune` / LMSCALE 机制已在曲线层 Task 1 删除：地标造价不再是旋钮，
 *    它派生自 ACTS[].mcap（8 个造价旋钮会与市值门槛互相打架，第 8 幕因此出现过
 *    「造价下调反而更慢」的混沌）。
 * ⚠️ 本文件末尾**没有** process.exit ⇒ `npm run check` 恒退出 0。
 *    验收必须读末尾的 `BRIEF {...}`：`bad` / `mono` / `total` / `cap` 才是判据。
 */

import { ACTS, BUILDINGS, SEC_PER_YEAR, salaryFrac, LANDMARK_K } from '../src/core/content.js';
import { createState } from '../src/core/state.js';
import {
  rates, derived, canAfford, purchase, suggestNext, setMinGain, applySuggestion, setStaffAdvisor, MIN_GAIN,
} from '../src/core/economy.js';
import { tick as engineTick, canAdvance } from '../src/core/engine.js';
import { contractShare, slotsUsed, suggestContract, availableTiers } from '../src/core/contracts.js';
import { staffSummary, staffTotal, successors, expandShock } from '../src/core/staff.js';
import { eventStats } from '../src/core/events.js';
import { ROUNDS, RETAIN_AFTER_ALL } from '../src/core/finance.js';
import { SKILL_IDS, skillState } from '../src/core/skills.js';
import { themeOf } from '../src/core/art.js';
import { SFX_NAMES } from '../src/ui/audio.js';
import { ACT_AGE } from '../src/core/content.js';
import { evaluateRetirement, endingName } from '../src/core/endings.js';
import { PRESSURE } from '../src/core/content.js';
import { CHOICE as CHOICE_EVENTS } from '../src/core/event-data.js';
import { STAFF_PARAMS } from '../src/core/content.js';
import { render, renderChoice, renderEvent, TABS } from '../src/ui/render.js';
import { createWorld, advanceWorld, ranking, toUSD_T } from '../src/core/world.js';
import { MONTHS_TOTAL } from '../src/core/format.js';
import { CURVE_BAND, IDLE_BAND, CURVE_MID, CURVE_TOL } from './curve-targets.mjs';

// 默认值直接读 economy.js 的 MIN_GAIN（唯一真相源，不再在工具里写第二份常量）
const GAIN = Number((process.argv.find(a => a.startsWith('--gain=')) || `--gain=${MIN_GAIN}`).split('=')[1]);
setMinGain(GAIN);
setStaffAdvisor(!process.argv.includes('--no-staff'));

const ROUTE = (process.argv.find(a => a.startsWith('--choice=')) || '--choice=tech').split('=')[1];

/** 每幕结束时的员工快照（等级/忠诚） —— 用来定位「是哪一幕把经济拖慢的」 */
const snapshotStaff = s => staffSummary(s)
  .filter(r => r.headcount > 0)
  .map(r => `${r.id} L${r.level} Y${r.loyalty.toFixed(0)} ×${r.mul.toFixed(2)}`)
  .join(' ｜ ');
const NO_CONTRACT = process.argv.includes('--no-contract');
/**
 * 两条路径的节奏带都读 tools/curve-targets.mjs（唯一真相源），这里不写任何小时数。
 *
 * 为什么纯挂机的上限（`IDLE_BAND`，18h）比主动（`CURVE_BAND`，6h）宽 3 倍：
 * 这条路径回答的是「完全不碰合同系统，还能不能通关」，用来证明「合同不是第二条主线」。
 * 它**不是**节奏指标 —— 一个刻意无视 3 个内容系统里 2 个的玩家必然更慢，
 * 要求两条路线的绝对小时数落在同一区间是自相矛盾的（那等于说「不接合同不会变慢」）。
 * 所以挂机只守「能通关 + 单调递增 + 上限不荒谬」。
 */
const BAND = NO_CONTRACT ? IDLE_BAND : CURVE_BAND;
/**
 * `bad` 的**口径**（R28 / R31）—— `bad` 是「**本条路径**该负责的失败数」，不是「全仓库失败数」：
 *   · `IS_GATE`      —— 只有 A（默认）与 D（`--no-contract`）两条**闸门**路径计 `bad`；
 *                       诊断路径（`--no-staff` / `--choice=*`）的 ❌ 照打，但一律不计。
 *   · `COUNT_STRUCT` —— 「正确性类」断言（现实性 / 结局表 / 转生 / 失败与压力 / 渲染 / 启动）
 *                       只在 A 上计：它们与「挂机这条路径的表现」无关，而 A 这条全量闸门
 *                       已经守着，在 D 上重复计一次只是让同一件事报两次红灯。
 *   · 节奏四项（R28）—— 两条闸门路径都计。
 */
const IS_GATE = !process.argv.includes('--no-staff') && !process.argv.some(a => a.startsWith('--choice='));
const COUNT_RHYTHM = IS_GATE;
const COUNT_STRUCT = IS_GATE && !NO_CONTRACT;
/**
 * 节奏判据全部读 tools/curve-targets.mjs —— 那是**唯一真相源**。
 * 这里不再留任何手写小时数：手写一份「验收用的目标」，标定器追另一份「标定用的目标」，
 * 两者一定会分叉（旧版本就是一边 40–60h、一边 50h 地各说各话）。
 */
const MID = CURVE_MID;
// 每幕允许的目标偏差：CURVE_MID[a] ± CURVE_TOL（与标定器的收敛判据同一个容差）
const TARGETS = CURVE_MID.map((m, a) => (a === 0 ? null : [m * (1 - CURVE_TOL), m * (1 + CURVE_TOL)]));

const MAX_TIME = 600 * 3600;
const MAX_STEPS = 150000;
const STEP_CAP = 1800;

function run() {
  const s = createState();
  // 默认：模型一个「会主动接单」的理性玩家；--no-contract 则模型纯挂机玩家。
  // 两条路线的合计带宽都来自 tools/curve-targets.mjs（A 主动 CURVE_BAND / D 纯挂机 IDLE_BAND）：
  // 这里不写死小时数 —— 写死就变成第二份「验收目标」，必然与标定器各说各话（旧版就是一边 40–60h、
  // 一边 50h）。「合同不是第二条主线」的真正保证是 D 路径能通关且合计落在 IDLE_BAND 内。
  s.autoContract = !process.argv.includes('--no-contract');
  s.autoStaff = !process.argv.includes('--no-staff');
  s.autoEvents = !process.argv.includes('--no-events');
  s.autoSkills = !process.argv.includes('--no-skills');

  const stats = {};
  const actStart = { 1: 0 };
  let steps = 0;

  while (s.elapsed < MAX_TIME && steps < MAX_STEPS) {
    steps++;
    const R = rates(s);
    const lmId = ACTS[s.act].landmark;

    // 与线上完全同源：达成本幕市值门槛即结束本幕（第一批 §5 的 canAdvance）
    if (s.act < 8 && canAdvance(s, R)) {
      stats[s.act] = { dur: s.elapsed - actStart[s.act], R, cnt: { ...s.buildings }, net: R.netMoney, rev: R.moneyRate * SEC_PER_YEAR, staff: snapshotStaff(s) };
      advance(s);
      continue;
    }
    // 第 8 幕是终章，`canAdvance` 对 act ≥ 8 恒为 false（引擎不允许推进到第 9 幕），
    // 所以这里直接比较同一个门槛表达式 —— 判据仍与线上同源（derived().marketCap），只是不经 canAdvance。
    if (s.act === 8 && derived(s, R).marketCap >= ACTS[8].mcap) {
      stats[8] = { dur: s.elapsed - actStart[8], R, cnt: { ...s.buildings }, net: R.netMoney, rev: R.moneyRate * SEC_PER_YEAR, staff: snapshotStaff(s) };
      // 真玩家在市值得分达标之后不会立刻退休 —— 他会先看一眼回忆、再点关灯。
      // 这里补跑一小段时间，让第八幕自己的里程碑/碎片有机会触发（否则 m16 永远测不到）。
      tickN(s, 3600);
      break;
    }
    if (canAfford(s, lmId)) { purchase(s, lmId); continue; }

    const sug = suggestNext(s, R);
    if (sug.id) {
      tickN(s, Math.min(Math.max(sug.waitSeconds, 0.05), STEP_CAP));
      // 与线上同源：顾问建议同时包含「买建筑」与「员工培训/加薪」
      applySuggestion(s, sug, rates(s));
      continue;
    }
    if (!Number.isFinite(sug.waitSeconds)) break;
    tickN(s, Math.min(Math.max(sug.waitSeconds, 1), STEP_CAP));
  }

  const durs = [1, 2, 3, 4, 5, 6, 7, 8].map(a => stats[a] ? stats[a].dur / 3600 : null);
  const total = durs.reduce((a, x) => a + (x || 0), 0);
  return { s, stats, steps, durs, total };

  function advance(st) {
    st.act += 1;
    st.flow *= ACTS[st.act].flow;
    // --choice=mixed：三条路线轮流走（⚠️ 第四批起三选一无任何数值加成，只累加叙事权重）
    const route = ROUTE === 'mixed' ? ['tech', 'biz', 'org'][(st.act - 1) % 3] : ROUTE;
    st.weights[route === 'tech' ? 'tech' : route === 'biz' ? 'biz' : 'bond'] += 1;
    st.choices.push({ act: st.act, route });
    expandShock(st);                  // 与 engine.advanceAct 同源
    actStart[st.act] = st.elapsed;
  }
  function tickN(st, dt) {
    // 直接跑线上 tick：产出 + 合同交付推进是同一份时序（架构铁律 3）
    engineTick(st, dt);
  }
}

// ─────────────────────────── 主流程 ───────────────────────────
const t0 = Date.now();
const res = run();

const fmtN = n => {
  if (!Number.isFinite(n)) return '∞';
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + '万亿';
  if (a >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (a >= 1e4) return (n / 1e4).toFixed(2) + '万';
  return a.toFixed(0);
};
const fmtH = s => (s < 3600 ? (s / 60).toFixed(1) + '分' : (s / 3600).toFixed(2) + 'h');
const statsOf = (r, a) => r.stats[a];

const out = [];
out.push('═'.repeat(92));
out.push(`  架构自检 · src/core 线上实现 ｜ 路线=${ROUTE} ｜ 耗时 ${((Date.now() - t0) / 1000).toFixed(2)}s ｜ 步数 ${res.steps}`);
out.push('═'.repeat(92));
out.push('');
out.push('  幕  地点            地标                  造价        实测      目标       判定');
out.push('  ' + '─'.repeat(86));
let prev = 0, mono = true, bad = 0, monoUnmeasurable = false;
for (let a = 1; a <= 8; a++) {
  const st = res.stats[a], b = BUILDINGS.find(x => x.id === ACTS[a].landmark);
  if (!st) {
    out.push(`  ${a}  ${ACTS[a].place.padEnd(14)} ${b.name.padEnd(18)} （未到达）`);
    if (COUNT_RHYTHM) bad++;
    /**
     * ⚠️ 必须同时置位「单调不可测」（W3，2026-09-25 最终修复波）。
     *
     * 为什么：`if (h < prev)` 只在**到达**的幕上执行 —— 8 幕全部「未到达」时它一次都不跑，
     * `mono` 于是保持初始的 `true`，这一项会打印「单调递增 ✅」而实际什么都没测。
     * 这与 F5/F7 是同一个假绿 genre：没有测量依据就不许报绿。置位是**幂等**的，
     * 与 `:264` 的 NaN 判定并列，两条路径谁先命中都算不可测。
     */
    monoUnmeasurable = true;
    continue;
  }
  const h = st.dur / 3600, [lo, hi] = TARGETS[a];
  /**
   * ⚠️ 必须先显式挡掉「非有限」的幕时长（F5，2026-09-25 修复轮 3）。
   *
   * 为什么必须显式挡：`h` 为 NaN 时下面三条比较（`< lo*0.75` / `> hi*1.33` / `< lo || > hi`）
   * **全部为 false**，于是它会一路落进 `'✅'`，`bad++` 也不触发 —— 命令报绿，其实什么都没验。
   * 这与 F1「click-sim 漏抄接线、静默失效」是同一 genre 的假绿闸门：测不出来就是失败，不能当通过。
   *
   * 病因已随曲线层 Task 1 消失：本幕判据换成与线上同源的 `canAdvance` / 市值门槛之后，
   * 尺子不会再因为「地标迟迟买不下来」而算不出时长。
   * 这道闸仍须保留 —— 它挡的是「`stats[a]` 存在、但时长算出来非有限」这一种情况，
   * 而上面三条比较对 NaN 全部为 false，漏过就是静默假绿：防御的价值与病因是否已修无关。
   */
  let v;
  if (!Number.isFinite(h)) { v = '❌时长不可测'; monoUnmeasurable = true; }
  else if (h >= lo && h <= hi) v = '✅';
  else if (NO_CONTRACT) v = `参考·${h < lo ? '偏快' : '偏慢'}`;   // R28：D 不判 ❌，只作参考（实测与偏差照打）
  else v = h < lo * 0.75 ? '❌太快' : h > hi * 1.33 ? '❌太慢' : '⚠️偏离';
  if (h < prev) { mono = false; v = '❌非递增'; }
  if (v.startsWith('❌') && COUNT_RHYTHM) bad++;
  prev = h;
  // 目标带由 CURVE_MID × (1 ± CURVE_TOL) 现算（唯一真相源），是个浮点数 ⇒ 显示时定到两位
  out.push(`  ${a}  ${ACTS[a].place.padEnd(14)} ${b.name.padEnd(18)} ${fmtN(b.cost.money).padStart(11)}  ${fmtH(st.dur).padStart(8)}  ${(lo.toFixed(2) + '–' + hi.toFixed(2) + 'h').padStart(9)}  ${v}`);
}
out.push('  ' + '─'.repeat(86));
/**
 * ⚠️ 「单调递增」也必须先显式挡掉不可测（F7，2026-09-25 修复轮 5，与上一块的 F5 同一改法）。
 *
 * 为什么：`if (h < prev)` 在 `h` 为 NaN 时**恒为 false** ⇒ `mono` 保持初始的 `true`
 * ⇒ 这一项打印 `✅`。而 NaN 与任何数比较都是 false，「没测到」于是被伪装成「测到了且通过」——
 * 与幕级判定是同一个假绿 genre。所以只要有任何一幕时长不可测（`monoUnmeasurable`，由 F5 那道闸置位），
 * 这一项就显式判 `❌不可测`，并用**与幕级完全相同**的那套表达计入失败总数（`❌` 前缀 + `bad++`），
 * 不新造口径。
 *
 * ⚠️ `bad++` 放在打印**之后**：这一行里的「问题幕数」只统计幕级问题，非幕级问题一律在打印后计入
 * `bad` —— 与后面各块（世界榜 / 合同 / 结局 / 失败与压力）的既有写法一致。
 */
const monoVerdict = monoUnmeasurable ? '❌不可测' : (mono ? '✅' : '❌');
const inBand = res.total >= BAND[0] && res.total <= BAND[1];
out.push(`  合计 ${res.total.toFixed(1)} h（${NO_CONTRACT ? '纯挂机' : '主动玩法'}目标 ${BAND[0]}–${BAND[1]} h）→ ${inBand ? '✅ 达标' : '❌ 不达标'}   单调递增 → ${monoVerdict}   问题幕数 ${bad}`);
if (COUNT_RHYTHM && monoVerdict.startsWith('❌')) bad++;
// R28：合计出带是**节奏四项**之一，此前只打印 ❌、从不计入 bad —— 现在补上（两条闸门路径都算）
if (COUNT_RHYTHM && !inBand) bad++;
/**
 * R31：诊断路径与 D 的 ❌ 照打，但口径不同，必须在旁边说清「以下 ❌ 算不算」，
 * 否则读者会以为 `bad` 就是屏幕上能数出来的 ❌ 个数。
 */
if (!IS_GATE) out.push('  （本路径为**诊断路径**：以下 ❌ 照打，但一律**不计入 `bad`**）');
else if (NO_CONTRACT) out.push('  （纯挂机只判**节奏四项**（R28）：以下「正确性类」❌ 照打但**不计入 `bad`** —— 它们由主动路径这条全量闸门负责）');
if (!NO_CONTRACT) {
  out.push('  （挂机路径请另跑 --no-contract；两条路线的节奏带不同，理由见本文件顶部注释）');
} else {
  out.push('  （这是「不接单」的被动路径；用 --no-contract 复现。硬指标对比请跑主动模式）');
}
out.push('');
out.push('  ⭐ 现实性检验');
out.push(`  幕  年营收            市值          P/S   现金/市值   地标/年营收（应 ≤ LANDMARK_K = ${LANDMARK_K}）`);
out.push('  ' + '─'.repeat(86));
for (let a = 1; a <= 8; a++) {
  const st = res.stats[a]; if (!st) continue;
  const b = BUILDINGS.find(x => x.id === ACTS[a].landmark);
  const ps = ACTS[a].ps;
  const mcap = st.rev * ps;
  const cr = b.cost.money / st.rev;
  /**
   * 判据变更（2026-09-25 曲线层）：原来查的是「造价 / 年营收 ∈ [0.15, 6] 的现实性带」，
   * 那是**标定量**；现在造价是派生量（造价 = `ACTS[a].mcap / ps × LANDMARK_K`），
   * 所以这里查的是一条**不等式**：`造价 / 年营收 ≤ LANDMARK_K`。
   * 为什么是 ≤ 而不是 =：表里取的是**幕末**年营收 `st.rev`，而幕末必然已达标
   * （`市值 ≥ mcap` ⇒ `st.rev ≥ mcap / ps`）⇒ 比值 = `K × (mcap/ps) / st.rev ≤ K`，
   * 之后越走越低。恒等式只对「造价 = `mcap/ps × K`」这一半成立 —— 把它写成 = 就是假话。
   * 上界一旦破了，说明造价被人手改过 —— 那正是这条断言要拦的事。
   */
  const ok = cr > 0 && cr <= LANDMARK_K + 1e-6;
  out.push(`  ${a}  ${fmtN(st.rev).padStart(12)}   ${fmtN(mcap).padStart(12)}   ${String(ps).padStart(2)}×  ${((b.cost.money / mcap) * 100).toFixed(2).padStart(8)}%   ${cr.toFixed(2).padStart(9)}×  ${ok ? '✅' : '❌'}`);
  if (!ok && COUNT_STRUCT) bad++;
}
out.push('');
out.push('  幕  资金/秒        工资占比');
out.push('  ' + '─'.repeat(46));
for (let a = 1; a <= 8; a++) {
  const st = res.stats[a]; if (!st) continue;
  const R = st.R;
  out.push(`  ${a}  ${fmtN(R.moneyRate).padStart(11)} ${(R.salaryPct * 100).toFixed(1).padStart(8)}%`);
}
out.push('');
const statActs = Object.keys(res.stats).map(Number);
const lastAct = Math.max(...statActs);
/**
 * 零样本报绿（最终审查 Minor）：`Math.max()` 对空集返回 `-Infinity` ⇒ `never = []`
 * ⇒ 打印「✅ 所有已解锁建筑都被购买过」，实际什么都没测（与 F5/F7 同一个 genre）。
 * 不可测即 ❌：连一幕都没跑完时这一项没有测量依据，不许报绿。
 */
if (!Number.isFinite(lastAct) || statActs.length === 0) {
  out.push('  ❌ 从未购买：本局没有跑完任何一幕，无法判断（不可测）');
  if (COUNT_STRUCT) bad++;
} else {
  const never = BUILDINGS.filter(b => b.act <= lastAct && !res.s.buildings[b.id]);
  out.push(never.length ? '  ⚠️ 从未购买：' + never.map(b => b.name).join('、') : '  ✅ 所有已解锁建筑都被购买过');
}
out.push('');

// ── 合同与客户（GDD 第 9 章）──
const C = res.s.contracts;
const share = contractShare(res.s) * 100;
{
  const ok = share <= 30;
  out.push('  ⭐ 合同与客户');
  out.push(`  累计交付 ${C.done} 单 ｜ 竞标失败 ${C.bidLost} 次 ｜ 当前进行中 ${C.active.length}（槽位 ${slotsUsed(res.s)}）`);
  out.push(`  合同累计收入 ${fmtN(C.earned)} ｜ 同期产出收入 ${fmtN(C.viaProduction)}`);
  out.push(`  合同收入占总收入 ${share.toFixed(1)}%  → ${ok ? '✅ ≤30%（合同是主动大单，不是第二条主线）' : '❌ >30% 合同过强，需下调 payEq 或槽位'}`);
  // ⚠️ 门槛第四份拷贝曾是硬编码的表（2026-09-24 修复）—— 现在统一读 availableTiers，
  //    任何一次门槛调整都会同时反映到这里，不会再出现「工具说已解锁、游戏里没有」这种情况。
  out.push(`  最终声誉 ${(res.s.resources.rep || 0).toFixed(0)} ｜ 已解锁等级 ${availableTiers(res.s).map(t => `${t.name}（${t.label}）`).join(' / ')}`);
  const reps = Object.entries(C.clientRep).map(([k, v]) => `${k} ${v.toFixed(0)}`);
  out.push(`  客户关系 ${reps.length ? reps.join(' ｜ ') : '（无）'}`);
  const longs = Object.entries(C.clientDone).filter(([, v]) => v >= 3).map(([k, v]) => `${k}×${v}`);
  out.push(`  长期客户 ${longs.length ? longs.join(' ｜ ') : '（无）'}`);
  // 顾问建议是否可用（证明 suggestContract 与线上同源）
  const sc = suggestContract(res.s, rates(res.s));
  out.push(`  顾问建议（末状态）: ${sc ? `接 ${sc.offerId} @ ${sc.quote}` : '暂无值得接的报价'}`);
  out.push('');
}
// ── 员工（GDD 第 8 章）──
{
  const rows = staffSummary(res.s);
  const active = rows.filter(r => r.headcount > 0);
  const anyStaff = active.length > 0;
  out.push('  ⭐ 员工');
  if (!anyStaff) {
    out.push('  （无）');
  } else {
    out.push('  组            人数    等级   忠诚   产出 ×   管理层');
    out.push('  ' + '─'.repeat(74));
    for (const r of rows) {
      if (r.headcount <= 0) {
        out.push(`  ${r.name.padEnd(12)} ${String(r.headcount).padStart(5)}   （尚未建立）`);
        continue;
      }
      out.push(`  ${r.name.padEnd(12)} ${String(r.headcount).padStart(5)}  ${String(r.level).padStart(3)}/${STAFF_PARAMS.levelMax}  ${r.loyalty.toFixed(0).padStart(4)}  ${r.mul.toFixed(2).padStart(6)}   ${r.promoted ? '✅ ' + r.role : '—'}`);
    }
    out.push(`  工资系数加成 +${((res.s.staff.salaryAdd || 0) * 100).toFixed(1)}%（加薪的永久代价）`);
    const suc = successors(res.s);
    out.push(`  接班人资格（忠诚 ≥ ${STAFF_PARAMS.successorLoyalty}）：${suc.length ? '✅ ' + suc.map(g => g.name).join('、') : '❌ 无人符合 —— 会落到「未能退休」'}`);
    const bad2 = active.filter(r => r.loyalty < 30);
    if (bad2.length) out.push(`  ⚠️ 人心涣散：${bad2.map(r => r.name).join('、')}`);
  }
  out.push('');
}

// ── 事件（GDD 第 11 章）──
{
  const st2 = eventStats(res.s, rates(res.s));
  const E = res.s.events;
  out.push('  ⭐ 事件');
  out.push(`  已发生 ${E.count} 次 ｜ 日常 ${E.byType.daily} ｜ 抉择 ${E.byType.choice} ｜ 里程碑 ${E.byType.milestone}`);
  for (const [type, v] of Object.entries(st2)) {
    const label = { daily: '日常', choice: '抉择', milestone: '里程碑' }[type];
    out.push(`  ${label}：条目 ${v.total} ｜ 当前可用 ${v.usable} ｜ 已触发 ${v.fired}`);
  }
  const seen = E.seen.length;
  const totalEvents = Object.values(st2).reduce((a, v) => a + v.total, 0);
  out.push(`  内容覆盖率 ${((seen / totalEvents) * 100).toFixed(0)}%（${seen}/${totalEvents} 条至少出现过一次）`);
  const neverFired = Object.entries(st2)
    .flatMap(([type, v]) => v.neverFired || [])
    .filter(Boolean);
  if (neverFired.length) out.push(`  ⚠️ 从未触发：${neverFired.join('、')}`);
  out.push('');
}

// ── 开局底料（原点击期，2026-09-25 折进 FOUNDER_BASE）──
{
  out.push('  ⭐ 开局底料（原「点击期」已整块删除，速率折进 FOUNDER_BASE）');
  const c = createState();
  let pass = 0, fail = 0;
  const ck = (name, cond) => { if (cond) pass++; else { fail++; out.push(`  ❌ ${name}`); } };

  const R0 = rates(c);
  // 原来的点击期是「没点就没产出」的闸门；折进底料后必须**开局即有产出**，
  // 否则不会点鼠标的玩家（挂机 / 无头）会永远卡在 0 上。
  // ⚠️ 2026-09-26 第四批：代码 / 人脉两条链并入资金，这里只断言资金底料。
  ck('开局资金产出为正（不再是 0）', R0.moneyRate > 0);
  ck('rates() 不再暴露点击字段', !('clickEff' in R0) && !('focusMul' in R0) && !('focus' in R0));
  ck('开局状态里不再有 clicks / autoClick 字段', c.clicks === undefined && c.autoClick === undefined);
  // 纯挂机（零操作）也必须能走出第一幕 —— 见下方八幕表
  const noClick = createState();
  noClick.autoContract = true; noClick.autoStaff = true; noClick.autoEvents = true;
  noClick.autoBuy = true;
  ck('纯挂机（零操作）仍然可以开局', rates(noClick).moneyRate > 0);

  out.push(`  ${pass} 项断言通过${fail ? `，${fail} 项失败` : ''}`);
  out.push('  基线：底料是**常驻**被动产出；第一幕之后建筑产出高 3–6 个数量级，可忽略');
  out.push('');
  // 与其它「正确性类」断言同口径：只在 A（全量闸门）上计入 `bad`（R28 / R31）
  if (COUNT_STRUCT) bad += fail;
}

// ── 美术与音效（GDD 18.7）──
// ⚠️ 第三批：回忆图鉴（`fragments.js` 54 条）整块删除，这里只剩色调与音效两项。
{
  out.push('  ⭐ 美术与音效（GDD 18.7）');
  out.push(`  当前幕色调「${themeOf(res.s.act).name}」（${themeOf(res.s.act).note}）`);
  out.push(`  音效：合成音效 ${Object.keys(SFX_NAMES).length} 种，开关已持久化（本局 muted = ${res.s.muted}）`);
  out.push('');
}

// ── 三人技能与年龄（GDD 4.3 / 4.5）──
// ⚠️ 第三批：健康 / 心气 / 健康上限 / 「稳定之手」随机制一起删，这里只留年龄与技能就绪状态。
{
  out.push('  ⭐ 三人技能与年龄');
  out.push(`  年龄（钟/严/朱）：${ACT_AGE[res.s.act].zhong}/${ACT_AGE[res.s.act].yan}/${ACT_AGE[res.s.act].zhu} 岁`);
  for (const id of SKILL_IDS) {
    const k = skillState(res.s, id);
    // 小朱的被动「稳定之手」已删（N2 ②）⇒ 被动名可能为空，这里不能无条件读 k.passive.name
    out.push(`  ${k.who}　被动「${(k.passive || {}).name || '—'}」　主动「${k.active.name}」${k.cd > 0 ? '（冷却中）' : '（就绪）'}`);
  }
  out.push('');
}

// ── 融资（GDD 第 13 章）──
{
  const F = res.s.finance || { rounds: [] };
  out.push('  ⭐ 融资');
  out.push(`  已完成 ${F.rounds.length}/7 轮：${F.rounds.map(id => (ROUNDS.find(r => r.id === id) || {}).name).join(' → ') || '（无）'}`);
  out.push(`  创始人持股 ${(res.s.equity * 100).toFixed(1)}%（无技能时应为 ${(RETAIN_AFTER_ALL * 100).toFixed(1)}%；小严的被动会再减 20% 稀释）→ ${res.s.equity < 0.3 ? '⚠️ 已触发「打工人」阈值' : '✅ 高于 30% 阈值'}`);
  out.push('');
}

// ── 结局（GDD 第 16 章）──
// ⚠️ 第三批：结局收敛为**唯一一个** —— 公司市值登顶世界第一。
//    判据源是 `s.worldRank`（`world.js` 每 tick 维护，与世界榜同一真相源），**不另算一遍名次**。
{
  const r = evaluateRetirement(res.s);
  out.push('  ⭐ 结局');
  out.push(`  s.worldRank = ${res.s.worldRank ?? 'null'}（世界榜是惰性初始化的：首 tick 之前为空）`);
  out.push(`  退休判定 → ${r.ending ? `「${endingName(r.ending)}」（${r.ending}）` : '未登顶 —— **不结束游戏**，可继续经营'}`);
  out.push(`  员工总数 ${staffTotal(res.s)} 人 ｜ 创始人持股 ${(res.s.equity * 100).toFixed(1)}%`);
  // ⚠️ 权重**不再参与结局分流**（第三批摘掉的唯一一处），但它仍驱动 eraBias 与客户门槛 needBiz，
  //    所以这里只当一条诊断信息打印，不再是任何结局的判据。
  const w2 = res.s.weights;
  const spread = Math.max(w2.tech, w2.biz, w2.bond) - Math.min(w2.tech, w2.biz, w2.bond);
  out.push(`  权重 技术 ${w2.tech} ｜ 商业 ${w2.biz} ｜ 情义 ${w2.bond} ｜ 极差 ${spread}（--choice=mixed 可复现）`);
  out.push('');
}

// ── 世界榜标定（2026-09-25）：「登顶」不只是一个判定函数，得先物理上够得着 ──
/**
 * 这条断言守的是 Tasks 1/5 修掉的那个坑：
 * 世界榜原来**不封顶**，玩家挂机久了世界会走到 2121 年（榜首被 95 年复利推到百万亿），
 * 于是「第 8 幕排世界第 1」在物理上不可能 —— 判定函数再对也没用。
 * 判据：第 35 年（第 420 月）榜首 ≤ 玩家终局市值的 80%，留 20% 余量给最后几幕反超。
 */
// 标定器（tools/recalibrate-curve.mjs）靠这两个数判断「登顶够不够得着」——
// 它们是**实测值**，不是推算值：cap 是玩家跑完整局时的真实市值，top1USD 是世界模型走到
// 第 420 月时的真实榜首。让标定器去 import world.js 自己算会得到第二个真相源。
let LAST_CAP_RMB = 0;
let TOP1_USD = 0;
{
  LAST_CAP_RMB = res.stats[8] ? res.stats[8].rev * ACTS[8].ps : 0;
  const playerCapUSD_T = toUSD_T(LAST_CAP_RMB);
  const w = createWorld('B');                       // 与 worldTick 惰性初始化用的同一条模型
  advanceWorld(w, MONTHS_TOTAL);                    // 世界推进到游戏终点（2061-09）
  const topAt35y = ranking(w, null, 1).top[0].cur;
  TOP1_USD = topAt35y;
  const ceiling = 0.8 * playerCapUSD_T;
  const okWorld = topAt35y <= ceiling;
  out.push('  ⭐ 世界榜标定（登顶是否物理可达）');
  out.push(`  第 35 年榜首 ${topAt35y.toFixed(1)}T USD ／ 玩家终局 ${playerCapUSD_T.toFixed(1)}T USD ／ 上限（80%）${ceiling.toFixed(1)}T → ${okWorld ? '✅ 登顶可达' : '❌ 榜首太高，登顶不可能'}`);
  if (!okWorld && COUNT_RHYTHM) bad++;   // 登顶可达属「节奏四项」（R28）
  out.push('');
}

// ── 结局判定：唯一结局「登顶」二态断言 ─────────────────────────────
// ⚠️ 第三批（2026-09-26）：8 结局分流 + 散伙 / 破产失败结局已删，判据收敛为一条 ——
//    「退休那一刻 `s.worldRank === 1` ⇒ 登顶；否则 `ending = null` 且**不结束游戏**」。
{
  const cases = [
    ['第 1 名 ⇒ 登顶', (() => { const s = createState(); s.worldRank = 1; return s; })(), 'top'],
    ['第 2 名 ⇒ 不结束', (() => { const s = createState(); s.worldRank = 2; return s; })(), null],
    ['第 10 名 ⇒ 不结束', (() => { const s = createState(); s.worldRank = 10; return s; })(), null],
    ['名次未知（首 tick 前）⇒ 不结束', (() => { const s = createState(); s.worldRank = null; return s; })(), null],
  ];

  out.push('  ⭐ 结局判定表（唯一结局「登顶」）');
  let badEnding = 0;
  for (const [label, st, want] of cases) {
    const r = evaluateRetirement(st);
    const ok = r.ending === want;
    if (!ok) badEnding++;
    out.push(`  ${ok ? '✅' : '❌'} ${label} → 实际 ${r.ending ? `「${endingName(r.ending)}」（${r.ending}）` : '无结局（游戏继续）'}`);
  }
  if (badEnding && COUNT_STRUCT) bad++;

  // 压力状态（2026-09-25 第一批 §6）：破产判定已删除 —— 净收入为负只减速，不结束游戏。
  // ⚠️ 第三批起这是**唯一**的「危机」形态（散伙判定与 `gameOver` 已整块删除）。
  const sPress = createState();
  sPress.resources.money = 0;
  // ⚠️ 必须有**产出型建筑**，否则 gross = 0 → upkeep = 0 → 净收入永远为正，压力测不出来
  sPress.buildings.biz1 = 5;
  sPress.staff.salaryAdd = 5;                     // 工资系数远超 100% → 净收入为负
  for (let i = 0; i < 40 && !sPress.pressure; i++) engineTick(sPress, 5);
  const okPressure = !!sPress.pressure;
  // `gameOver` 字段本身保留（旧档兼容点），但**不再有任何代码置位** —— 必须恒为假
  const okNoGameOver = !sPress.gameOver && !res.s.gameOver;

  out.push('');
  out.push('  ⭐ 减速压力（第一批 §6，第三批起是唯一的危机形态）');
  out.push(`  ${okPressure ? '✅' : '❌'} 压力：净收入为负持续 ${PRESSURE.enterSec} 秒 → 进入减速压力（资金见底也不结束游戏）`);
  out.push(`  ${okNoGameOver ? '✅' : '❌'} 全流程没有任何失败状态（压力局 gameOver = ${sPress.gameOver || 'null'} ｜ 本局 gameOver = ${res.s.gameOver || 'null'}）`);
  if ((!okPressure || !okNoGameOver) && COUNT_STRUCT) bad++;
  out.push('');
}

out.push('  幕  员工（等级/忠诚/产出系数）—— 定位是哪一幕把经济拖慢的');
out.push('  ' + '─'.repeat(86));
for (let a = 1; a <= 8; a++) {
  const st = statsOf(res, a); if (!st || !st.staff) continue;
  out.push(`  ${a}  ${st.staff}`);
}
out.push('');
out.push('  ▶ 地标造价（派生量，改 ACTS[].mcap 会自动跟着改，不要手写）');
for (let a = 1; a <= 8; a++) {
  const b = BUILDINGS.find(x => x.id === ACTS[a].landmark);
  out.push(`     ${b.id.padEnd(10)} 第${a}幕  ${b.name.padEnd(18)} = ${b.cost.money.toExponential(4)}   // ${fmtN(b.cost.money)} = mcap/ps × ${LANDMARK_K}`);
}
// ── 渲染烟测：5 个标签页 + 抉择弹窗都必须能画出 HTML 而不抛异常 ──
out.push('  ⭐ 渲染烟测');
try {
  const node = () => ({
    innerHTML: '', dataset: {},
    querySelectorAll: () => [], appendChild() {}, remove() {},
  });
  globalThis.document = { createElement: node };
  const root = node();
  const handlers = {
    setTab() {}, buy() {}, choice() {}, advance() {}, retire() {},
    bid() {}, drop() {}, staff() {}, click() {}, clickUp() {}, toggleMute() {},
  };
  let bytes = 0;
  for (let t = 0; t < TABS.length; t++) {
    render(root, res.s, t, handlers);
    if (!root.innerHTML || root.innerHTML.length < 40) throw new Error(`标签页 ${TABS[t]} 渲染为空`);
    bytes += root.innerHTML.length;
  }
  renderChoice(root, 4, () => {});
  // 事件弹窗烟测：拿一条真实的抉择事件渲染
  renderEvent(root, CHOICE_EVENTS[0], () => {}, () => true);
  bytes += root.innerHTML.length;
  out.push(`  ✅ ${TABS.length} 个标签页 + 抉择弹窗 + 事件弹窗全部渲染成功（合计 ${bytes} 字节 HTML）`);
} catch (e) {
  out.push(`  ❌ 渲染失败：${e.message}`);
  if (COUNT_STRUCT) bad++;
}
out.push('');

// ── 启动烟测：真正 import main.js，验证入口/存档/循环这条链不抛异常 ──
out.push('  ⭐ 启动烟测（真跑 src/main.js）');
try {
  const node = () => {
    const el = {
      innerHTML: '', className: '', dataset: {},
      children: [],
      querySelectorAll: () => [], querySelector: () => node(),
      appendChild(c) { el.children.push(c); }, remove() {},
      onclick: null,
    };
    return el;
  };
  const store = new Map();
  let raf = 0;
  globalThis.document = {
    createElement: node,
    getElementById: () => node(),
  };
  globalThis.window = { addEventListener() {} };
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  globalThis.requestAnimationFrame = cb => { if (raf++ < 4) cb(Date.now()); return raf; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};

  await import('../src/main.js');
  out.push(`  ✅ main.js 启动成功：存档读写 → 离线结算 → 渲染 → 主循环调度，全部无异常（跑过 ${raf} 帧）`);
  out.push(`  ✅ 存档已写入 localStorage（${[...store.keys()].length} 个键）`);
} catch (e) {
  out.push(`  ❌ 启动失败：${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
  if (COUNT_STRUCT) bad++;
}
out.push('');

console.log(out.join('\n'));

console.log('BRIEF ' + JSON.stringify({
  // ⚠️ `mono` 报的是**判定结果**，不是原始布尔：时长不可测时它必须是 false（F7）——
  //    否则机器可读的那一行仍在声称「单调递增成立」，假绿只是从屏幕挪进了 JSON。
  //    字段名保持不变（曲线计划的标定器靠 `route/total/mono/bad/durs` 取数）。
  route: ROUTE, total: +res.total.toFixed(2), mono: monoVerdict === '✅', bad,
  cap: +LAST_CAP_RMB.toExponential(4),        // 玩家终局市值（RMB）—— 标定器用它算 λ
  top1USD: +TOP1_USD.toFixed(2),              // 第 420 月榜首（T USD）—— 登顶的绝对下限
  durs: res.durs.map(d => d === null ? null : +d.toFixed(2)),
  contracts: {
    done: C.done, bidLost: C.bidLost,
    share: +share.toFixed(1), earned: C.earned, rep: +(res.s.resources.rep || 0).toFixed(0),
    ok: share <= 30,
  },
  staff: {
    salaryAdd: +(res.s.staff.salaryAdd || 0).toFixed(3),
    successor: successors(res.s).length > 0,
    groups: staffSummary(res.s).filter(r => r.headcount > 0)
      .map(r => `${r.id}:L${r.level}/Y${r.loyalty.toFixed(0)}${r.promoted ? '/P' : ''}`),
  },
}));
