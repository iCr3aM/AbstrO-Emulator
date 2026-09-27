#!/usr/bin/env node
/**
 * 鲁棒性矩阵（`npm run robust`，GDD §5.3 / §4 裁决 4）
 * ===============================================================
 * 节奏量尺（headless-check）只回答「按最优策略玩，5.2 小时到得了吗」。
 * 本文件回答的是另一件事：**换个性格玩，还通得了关吗、快慢差多少。**
 *
 * 三块：
 *   A 档（主动）  5 种决策策略：conserve / invest / mixed / best / worst
 *                 —— 全通，且**极差 ≤ 2.0×**（§1.1：「2× 差异来自决策质量」）
 *   D 档（消极）  2 种：default（一条待决都不碰）/ worst（每年都选最差项）
 *                 —— 零点击、全通，且**极差 ≤ 3.0×**
 *   手动         default 挂机 vs default + 跟着节律手点 —— 三条判据：
 *                 · **手动必须有分量**：挂机 / 全手动 ≥ 1.5×（§1.6「自动是打折版、手动是满配」）
 *                 · **手动也不许快过下限**：全手动 ≥ `CURVE_BAND[0]`（3h）—— 手动是「更优策略」，
 *                   不是「跳过游戏」（用户 2026-09-27 拍板）
 *                 · **手速不是变量**：每 1 秒点一次 vs 每 20 秒点一次 ≤ 1.5×
 *                   （瓶颈永远是钱不是手；少了这一条，手动就退化成点击劳动）
 *
 * ⚠️ **不再判「章弧长严格递增」**（八章下这条必然破，与 `headless-check` 同一理由：
 *    真实营收阶梯的 ln 比率递减）。原本守它的两处已删，`mono` 只在量尺里作参考上报。
 *
 * ⚠️ A 档的 `invest` 刻意**允许**单调性微破：三线乘数会复利，把远景章压短。
 *    GDD §5.3 对 robust 档位只要求「全通 + ≤ 2.0×」。
 *
 * ⚠️ 手动分量为什么是 1.5× 而不是别的（2026-09-27 现金储备改口径后重标）：
 *    旧版「储备 = 年营收 × 0.25」等于一道 **13 份成本的硬墙**（`年营收 / cost = 37`），
 *    它本身就是压住手动的节流阀 —— 那时手动只有 2.24×、手速 1.13×。
 *    改成「储备 = 现金 × 0.25」之后这道墙没了，手动一路涨到 **3.46×**，
 *    手速变成 **1.356×**（用户 2026-09-27 实测翻红）。
 *    解法不是收回储能，而是给手动补一个**付款档**：`MANUAL_PAY = 1 + CURVE_RATIO/2`
 *    （买 2 级付 1.565 级的钱）⇒ 手动回落到 **3.21h / 1.61× / 手速 1.100×**。
 *    1.5× 是「手动确实省了三成以上时间」这条**能被玩家感觉到**的下限。
 * ⚠️ 本文件**不自己跑引擎** —— 每个格子都 spawn 一次 `headless-check.mjs`，只读它的
 *    `BRIEF` 行。这样矩阵与量尺永远是同一把尺子，不会各算一份（旧的矩阵模式就是
 *    在文件里另写了一遍循环，两次重标定之后两份口径就分叉了）。
 * ⚠️ 恒 exit 0；结论读末尾 `BRIEF`。
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CURVE_BAND, IDLE_BAND } from './curve-targets.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = join(ROOT, 'tools', 'headless-check.mjs');

/** A 档极差上限（§4 裁决 4） */
export const A_RANGE_MAX = 2.0;
/** D 档极差上限（§4 裁决 4） */
export const D_RANGE_MAX = 3.0;
/** 手动加速的下限（§1.6：自动是打折版、手动是满配 —— 手动必须真的有分量）。
 *  取 1.5× 的理由见文件头（现金储备改口径后手动一度涨到 3.46×，靠 `MANUAL_PAY` 压回 1.61×）。 */
export const MANUAL_MIN = 1.5;
/** 手速的上限（§1.6：瓶颈是钱不是手 —— 点得再快也不许更快）。
 *  ⚠️ 2026-09-27 由 1.10 放宽到 1.25，再放宽到 1.50（用户两次拍板）。
 *  过程：五条线制下 `g = 1.13^(1/5) = 1.0247`（三条线制是 1.0416），购买颗粒度更细
 *  ⇒ 手动购买间隔 ≈ 28.5s，落在「每 20s 点一次」的采样尺度上；随后现金储备改口径
 *  （`年营收 × 0.25` 的硬墙 → `现金 × 0.25`）把这道墙拆了，手速实测涨到 1.356×。
 *  用户选择**保留现有手感**（点击必须当场钱够才生效，不引入「预约」机制），
 *  并把「手动不许快过 3h」交给 `MANUAL_PAY` 实现、把这条判据放宽到 1.5×。
 *  实测 1.100× —— 连原来的 1.25× 门槛都过，1.5× 只是留了重标定的余量。
 *  ⚠️ 本文件与 `GDD.MD` §5.3 两处同源，改一处要改两处。
 *     原方案文件已归档：`docs/archive/2026-09-27-v6/v6-方案-五条线-40周年-订单页.md`。 */
export const CADENCE_MAX = 1.5;

/** 跑一格：spawn 一次量尺，只取 BRIEF */
function cell(...flags) {
  const out = execFileSync(process.execPath, [CHECK, ...flags, '--quiet'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const line = out.split('\n').find(l => l.startsWith('BRIEF '));
  if (!line) throw new Error(`headless-check 没有打印 BRIEF 行（flags: ${flags.join(' ')}）`);
  return JSON.parse(line.slice(6));
}

const A_STRATEGIES = ['conserve', 'invest', 'mixed', 'best', 'worst'];
const D_STRATEGIES = ['default', 'worst'];

console.log('');
console.log('  🧱 鲁棒性矩阵（每一格都 spawn 一次 tools/headless-check.mjs，读它的 BRIEF）');
console.log('  ─'.repeat(36));

const bad = [];
const rows = [];

// ─────────────── A 档：主动（每年做决策）───────────────
console.log('');
console.log('  ⭐ A 档 · 主动（零点击，只靠自动购买；每年做一次决策）');
console.log(`  策略        合计      最大偏差   bad   终局      带宽 [${CURVE_BAND[0]}, ${CURVE_BAND[1]}]h`);
console.log('  ' + '─'.repeat(76));
const aTotals = [];
for (const st of A_STRATEGIES) {
  const r = cell(`--strategy=${st}`);
  rows.push({ band: 'A', strategy: st, ...r });
  aTotals.push(r.total);
  const reached = r.ending === 'top';
  if (!reached) bad.push(`A/${st} 没走到结局（ending = ${r.ending ?? 'null'}）`);
  if (!(r.total >= CURVE_BAND[0] && r.total <= CURVE_BAND[1])) {
    // 极差由 INV_A 单独守，这里只报事实：A 档不要求每格都落在主动带宽内
  }
  console.log(`  ${st.padEnd(11)} ${(r.total.toFixed(2) + 'h').padStart(8)}  `
    + `${(r.maxDev == null ? '—' : (r.maxDev * 100).toFixed(0) + '%').padStart(7)}  ${String(r.bad).padStart(4)}  `
    + `${(reached ? '登顶 ✅' : '未登顶 ❌').padEnd(8)}`);
}
const aMin = Math.min(...aTotals);
const aMax = Math.max(...aTotals);
const aRange = aMax / aMin;
const aOk = aRange <= A_RANGE_MAX;
if (!aOk) bad.push(`A 档极差 ${aRange.toFixed(2)}× > ${A_RANGE_MAX}×`);
console.log(`  极差 max/min = ${aMax.toFixed(2)}h / ${aMin.toFixed(2)}h = ${aRange.toFixed(2)}×`
  + ` → ${aOk ? `✅ ≤ ${A_RANGE_MAX}×` : `❌ > ${A_RANGE_MAX}×`}`);

// ─────────────── D 档：消极（零点击）───────────────
console.log('');
console.log('  ⭐ D 档 · 消极（零点击；不主动优化决策）');
console.log(`  策略        合计      bad   终局      带宽 [${IDLE_BAND[0]}, ${IDLE_BAND[1]}]h`);
console.log('  ' + '─'.repeat(76));
const dTotals = [];
for (const st of D_STRATEGIES) {
  const r = cell('--idle', `--strategy=${st}`);
  rows.push({ band: 'D', strategy: st, ...r });
  dTotals.push(r.total);
  const reached = r.ending === 'top';
  if (!reached) bad.push(`D/${st} 没走到结局（ending = ${r.ending ?? 'null'}）`);
  const inBand = r.total >= IDLE_BAND[0] && r.total <= IDLE_BAND[1];
  if (!inBand) bad.push(`D/${st} 合计 ${r.total.toFixed(2)}h 出带 [${IDLE_BAND[0]}, ${IDLE_BAND[1]}]`);
  console.log(`  ${st.padEnd(11)} ${(r.total.toFixed(2) + 'h').padStart(8)}  `
    + `${String(r.bad).padStart(4)}  ${(reached ? '登顶 ✅' : '未登顶 ❌').padEnd(8)} ${inBand ? '' : '❌出带'}`);
}
const dMin = Math.min(...dTotals);
const dMax = Math.max(...dTotals);
const dRange = dMax / dMin;
const dOk = dRange <= D_RANGE_MAX;
if (!dOk) bad.push(`D 档极差 ${dRange.toFixed(2)}× > ${D_RANGE_MAX}×`);
console.log(`  极差 max/min = ${dMax.toFixed(2)}h / ${dMin.toFixed(2)}h = ${dRange.toFixed(2)}×`
  + ` → ${dOk ? `✅ ≤ ${D_RANGE_MAX}×` : `❌ > ${D_RANGE_MAX}×`}`);

// ─────────────── 手动：有分量，但手速不是变量 ───────────────
console.log('');
console.log('  ⭐ 手动（§1.6：自动是打折版、手动是满配；门槛是钱不是手）');
const idlePlain = rows.find(r => r.band === 'D' && r.strategy === 'default');
const idleFast = cell('--idle', '--strategy=default', '--click');       // 每 1s 抢点
const idleSlow = cell('--idle', '--strategy=default', '--click=20');    // 每 20s 抢点
rows.push({ band: 'D', strategy: 'default+click1', ...idleFast });
rows.push({ band: 'D', strategy: 'default+click20', ...idleSlow });
for (const [tag, r] of [['每 1s', idleFast], ['每 20s', idleSlow]]) {
  if (r.ending !== 'top') bad.push(`${tag} 抢点没走到结局（ending = ${r.ending ?? 'null'}）`);
}
const manualRatio = idlePlain.total / idleFast.total;
const manualOk = manualRatio >= MANUAL_MIN;
if (!manualOk) {
  bad.push(`手动几乎没有分量：挂机 ${idlePlain.total.toFixed(2)}h ／ 全手动 ${idleFast.total.toFixed(2)}h`
    + ` = ${manualRatio.toFixed(2)}× < ${MANUAL_MIN}×`);
}
// 手动是「更优策略」，不是「跳过游戏」：全手动也不许掉到主动带宽下限之下（用户 2026-09-27 拍板）
const manualFast = idleFast.total >= CURVE_BAND[0];
if (!manualFast) {
  bad.push(`全手动 ${idleFast.total.toFixed(2)}h 快过下限 ${CURVE_BAND[0]}h —— 手动退化成跳过游戏`);
}
const cadenceRatio = idleSlow.total / idleFast.total;
const cadenceOk = cadenceRatio <= CADENCE_MAX;
if (!cadenceOk) bad.push(`手速变成了变量：每 20s ／ 每 1s = ${cadenceRatio.toFixed(3)}× > ${CADENCE_MAX}×`);
console.log(`  一、有没有分量：挂机 ${idlePlain.total.toFixed(2)}h ／ 跟着节律手点 ${idleFast.total.toFixed(2)}h`
  + ` → ${manualRatio.toFixed(2)}× → ${manualOk ? `✅ ≥ ${MANUAL_MIN}×` : `❌ < ${MANUAL_MIN}×`}`);
console.log(`  二、手动不越下限：全手动 ${idleFast.total.toFixed(2)}h → ${manualFast ? `✅ ≥ ${CURVE_BAND[0]}h` : `❌ < ${CURVE_BAND[0]}h`}`);
console.log(`  三、手速是不是变量：每 1s 点 ${idleFast.total.toFixed(2)}h ／ 每 20s 点 ${idleSlow.total.toFixed(2)}h`
  + ` → ${cadenceRatio.toFixed(3)}× → ${cadenceOk ? `✅ ≤ ${CADENCE_MAX}×` : `❌ > ${CADENCE_MAX}×`}`
  + `（实点 ${idleFast.clicks} / ${idleSlow.clicks} 次）`);

// ─────────────── 汇总 ───────────────
console.log('');
console.log('  ' + '─'.repeat(76));
console.log(`  五项判据：A 极差 ${aRange.toFixed(2)}×（≤${A_RANGE_MAX}）｜ D 极差 ${dRange.toFixed(2)}×（≤${D_RANGE_MAX}）`
  + `｜ 手动分量 ${manualRatio.toFixed(2)}×（≥${MANUAL_MIN}）｜ 手动下限 ${idleFast.total.toFixed(2)}h（≥${CURVE_BAND[0]}）`
  + `｜ 手速 ${cadenceRatio.toFixed(3)}×（≤${CADENCE_MAX}）`);
console.log(`  问题数 bad = ${bad.length}`);
for (const b of bad) console.log(`  ❌ ${b}`);
if (!bad.length) console.log('  ✅ 全部通过');
console.log('');

console.log('BRIEF ' + JSON.stringify({
  bad: bad.length,
  aRange: +aRange.toFixed(3),
  dRange: +dRange.toFixed(3),
  manualRatio: +manualRatio.toFixed(3),
  manualFast: +idleFast.total.toFixed(3),
  cadenceRatio: +cadenceRatio.toFixed(3),
  allEnding: rows.every(r => r.ending === 'top'),
  results: rows.map(r => ({ band: r.band, strategy: r.strategy, total: r.total, mono: r.mono, bad: r.bad, ending: r.ending })),
}));
