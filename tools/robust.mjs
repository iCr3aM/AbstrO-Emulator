#!/usr/bin/env node
/**
 * 鲁棒性矩阵（`npm run robust`，GDD §5.3 / §4 裁决 4）
 * ===============================================================
 * 节奏量尺（headless-check）只回答「按最优策略玩，4.8 小时到得了吗」。
 * 本文件回答的是另一件事：**换个性格玩，还通得了关吗、快慢差多少。**
 *
 * 三块：
 *   A 档（主动）  5 种决策策略：conserve / invest / mixed / best / worst
 *                 —— 全通，且**极差 ≤ 2.0×**（§1.1：「2× 差异来自决策质量」）
 *   D 档（消极）  2 种：default（一条待决都不碰）/ worst（每年都选最差项）
 *                 —— 零点击、全通，且**极差 ≤ 3.0×**
 *   手动         default 挂机 vs default + 跟着节律手点 —— 两条判据：
 *                 · **手动必须有分量**：挂机 / 全手动 ≥ 1.8×（§1.6「自动是打折版、手动是满配」）
 *                 · **手速不是变量**：每 1 秒点一次 vs 每 20 秒点一次 ≤ 1.10×
 *                   （瓶颈永远是钱不是手；少了这一条，手动就退化成点击劳动）
 *
 * ⚠️ A 档的 `invest` 刻意**允许**单调性微破：三线乘数会复利，把远景幕压短。
 *    GDD §5.3 对 robust 档位只要求「全通 + ≤ 2.0×」，单调性由 `npm run check` 负责。
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
/** 手动加速的下限（§1.6：自动是打折版、手动是满配 —— 手动必须真的有分量） */
export const MANUAL_MIN = 1.8;
/** 手速的上限（§1.6：瓶颈是钱不是手 —— 点得再快也不许更快） */
export const CADENCE_MAX = 1.10;

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
console.log(`  策略        合计       单调   最大偏差   bad   终局      带宽 [${CURVE_BAND[0]}, ${CURVE_BAND[1]}]h`);
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
  console.log(`  ${st.padEnd(11)} ${(r.total.toFixed(2) + 'h').padStart(8)}  ${(r.mono ? '✅' : '❌').padStart(4)}  `
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
console.log(`  策略        合计       单调   bad   终局      带宽 [${IDLE_BAND[0]}, ${IDLE_BAND[1]}]h`);
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
  if (!r.mono) bad.push(`D/${st} 幕弧长非严格递增`);
  console.log(`  ${st.padEnd(11)} ${(r.total.toFixed(2) + 'h').padStart(8)}  ${(r.mono ? '✅' : '❌').padStart(4)}  `
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
const cadenceRatio = idleSlow.total / idleFast.total;
const cadenceOk = cadenceRatio <= CADENCE_MAX;
if (!cadenceOk) bad.push(`手速变成了变量：每 20s ／ 每 1s = ${cadenceRatio.toFixed(3)}× > ${CADENCE_MAX}×`);
console.log(`  一、有没有分量：挂机 ${idlePlain.total.toFixed(2)}h ／ 跟着节律手点 ${idleFast.total.toFixed(2)}h`
  + ` → ${manualRatio.toFixed(2)}× → ${manualOk ? `✅ ≥ ${MANUAL_MIN}×` : `❌ < ${MANUAL_MIN}×`}`);
console.log(`  二、手速是不是变量：每 1s 点 ${idleFast.total.toFixed(2)}h ／ 每 20s 点 ${idleSlow.total.toFixed(2)}h`
  + ` → ${cadenceRatio.toFixed(3)}× → ${cadenceOk ? `✅ ≤ ${CADENCE_MAX}×` : `❌ > ${CADENCE_MAX}×`}`
  + `（实点 ${idleFast.clicks} / ${idleSlow.clicks} 次）`);

// ─────────────── 汇总 ───────────────
console.log('');
console.log('  ' + '─'.repeat(76));
console.log(`  四项判据：A 极差 ${aRange.toFixed(2)}×（≤${A_RANGE_MAX}）｜ D 极差 ${dRange.toFixed(2)}×（≤${D_RANGE_MAX}）`
  + `｜ 手动分量 ${manualRatio.toFixed(2)}×（≥${MANUAL_MIN}）｜ 手速 ${cadenceRatio.toFixed(3)}×（≤${CADENCE_MAX}）`);
console.log(`  问题数 bad = ${bad.length}`);
for (const b of bad) console.log(`  ❌ ${b}`);
if (!bad.length) console.log('  ✅ 全部通过');
console.log('');

console.log('BRIEF ' + JSON.stringify({
  bad: bad.length,
  aRange: +aRange.toFixed(3),
  dRange: +dRange.toFixed(3),
  manualRatio: +manualRatio.toFixed(3),
  cadenceRatio: +cadenceRatio.toFixed(3),
  allEnding: rows.every(r => r.ending === 'top'),
  results: rows.map(r => ({ band: r.band, strategy: r.strategy, total: r.total, mono: r.mono, bad: r.bad, ending: r.ending })),
}));
