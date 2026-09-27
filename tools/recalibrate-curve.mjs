#!/usr/bin/env node
/**
 * 曲线标定器（`npm run tune`，GDD §5.3 / §5.4 第 3 步）
 * ===============================================================
 * 它不自己算模型 —— 它**把 `tools/headless-check.mjs` 当黑盒量尺**，反解两个旋钮：
 *
 *   旋钮 1 · `LINE_COST0`（content.js）—— **时间旋钮**。
 *            每次购买耗时 `= LINE_COST0 / (INCOME_SCALE·F·margin)`，
 *            而「一章要买几次」由市值阶梯决定、与它无关 ⇒ 它**等比缩放整局时长**。
 *   旋钮 2 · `ACTS[].mcap` 的形状 —— **分配旋钮**。
 *            章内购买次数 `= 3/ln r × [ln(mcap_a/mcap_{a-1}) − ln(pe_a/pe_{a-1})]`，
 *            所以「改哪一章的 ln 台阶」就是「改哪一章占多久」。
 *            两端的锚点钉死：起点 `START_MCAP` 是公式派生量；
 *            终点 `ACTS[8].mcap` = **第 480 月的世界榜首**（登上它 = 登顶 = 结局）。
 *
 * 反解方式：**阻尼不动点迭代**（不推导闭式 —— 闭式要假设 `F` 与购买时序无关，
 * 而 `best` 策略下 `F` 会累积，假设不成立）。每轮：
 *   `LINE_COST0 ← LINE_COST0 × (几何平均 f)^0.7`，`s_a ← s_a × f_a^0.7` 后按总数归一，
 * 其中 `f_a = CURVE_MID[a] / 实测章弧长`。跑到 `headless-check` 的 `bad` 归零，
 * 或到轮次上限（保留最好的一轮，绝不把更差的写回去）。
 *
 * ⚠️ **幂等**：起点即达标 ⇒ 一次 `check` 都不写盘（GDD §5.3 的判据）。
 * ⚠️ 恒 exit 0；结论读末尾 `BRIEF`。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RMB_PER_T_USD } from '../src/core/world.js';
import { START_MCAP } from '../src/core/content.js';
import { CURVE_BAND, IDLE_BAND, CURVE_MID, CURVE_TOL } from './curve-targets.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = join(ROOT, 'src', 'core', 'content.js');
const CHECK = join(ROOT, 'tools', 'headless-check.mjs');

/** 轮次上限（每轮 = 一次 A + 一次 D，约 1 秒） */
const MAX_ROUNDS = 6;
/** 阻尼指数：1.0 = 每轮全额修正（会来回振荡），0.7 = 收敛且不激进 */
const DAMP = 0.7;
/** 单章 ln 台阶的下限 —— 低于它等于「这一章不用买」 */
const MIN_STEP = 0.15;

// ─────────────────────────── 量尺 ───────────────────────────
function measure(...flags) {
  const out = execFileSync(process.execPath, [CHECK, ...flags, '--quiet'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const line = out.split('\n').find(l => l.startsWith('BRIEF '));
  if (!line) throw new Error(`headless-check 没有打印 BRIEF 行（flags: ${flags.join(' ')}）`);
  return JSON.parse(line.slice(6));
}
const measureA = () => measure();
const measureD = () => measure('--idle');

// ─────────────────────────── 读写 content.js ───────────────────────────
/**
 * 写回时的数字风格：与 content.js 原有的写法一致（大数用 `1.07e5` 而非 `107000`），
 * 但**只有 3 位有效数字** —— 门槛只用来比较大小，写 6 位有效数字是假精度，
 * 还会把 ACTS 表挤得对不齐。`LINE_COST0` 走普通数字（它是个金额，不是量级）。
 */
const num = v => {
  if (v >= 1e5) {
    const [m, e] = v.toExponential(2).split('e');
    return `${m}e${Number(e)}`;
  }
  return String(Number(v.toPrecision(4)));
};

const LINE_RE = /export const LINE_COST0 = [\d.eE+-]+;/;
const MCAP_RE = /mcap: [\d.eE+-]+/g;

function parse(text) {
  const l = LINE_RE.exec(text);
  const mcaps = [...text.matchAll(MCAP_RE)].map(m => Number(m[0].slice(6)));
  if (!l) throw new Error('content.js 里找不到 `export const LINE_COST0 = …`');
  if (mcaps.length !== 8) throw new Error(`content.js 里 mcap 锚点应有 8 个，实际 ${mcaps.length} 个 —— 不写盘`);
  return { lineCost0: Number(l[0].split('=')[1].trim().replace(';', '')), mcaps };
}

/** 以**原始文本**为底重建，保证反复写不会累积漂移 */
function render(base, { lineCost0, mcaps }) {
  let i = 0;
  return base
    .replace(LINE_RE, `export const LINE_COST0 = ${num(lineCost0)};`)
    .replace(MCAP_RE, () => `mcap: ${num(mcaps[i++])}`);
}

const ORIGINAL = readFileSync(CONTENT, 'utf8');

// ─────────────────────────── 修正一步 ───────────────────────────
/**
 * 反解下一组旋钮。`a` = A 路径的实测简报（`durs` 是八章的真实小时数）。
 * 几何平均那一步负责「整局快慢」，形状那一步负责「各章比例」，两者近似正交：
 * 形状归一化保留了 Σ ln 台阶（= 总购买次数），所以它不动总时长。
 */
function step(cur, durs, mcapEnd) {
  const f = [null];
  for (let a = 1; a <= 8; a++) {
    const h = durs[a - 1];
    f[a] = h && Number.isFinite(h) && h > 0 ? CURVE_MID[a] / h : 1;
  }
  const gm = Math.exp(CURVE_MID.slice(1).reduce((s, _, i) => s + Math.log(f[i + 1]), 0) / 8);
  const lineCost0 = cur.lineCost0 * gm ** DAMP;

  // 台阶：`s_1` = START_MCAP → mcap[1]，`s_a` = mcap[a-1] → mcap[a]
  const steps = [];
  for (let a = 1; a <= 8; a++) {
    const lo = a === 1 ? cur.startMcap : cur.mcaps[a - 2];
    steps.push(Math.max(MIN_STEP, Math.log(cur.mcaps[a - 1] / lo) * f[a] ** DAMP));
  }
  // 归一：Σ 台阶必须等于 ln(末端 / 起点) —— 两端锚点都不许动
  const span = Math.log(mcapEnd / cur.startMcap);
  const k = span / steps.reduce((x, y) => x + y, 0);
  const mcaps = [];
  let cap = cur.startMcap;
  for (let a = 1; a <= 8; a++) {
    cap = a === 8 ? mcapEnd : cap * Math.exp(steps[a - 1] * k);
    mcaps.push(cap);
  }
  return { lineCost0, mcaps, startMcap: cur.startMcap };
}

// ─────────────────────────── 主流程 ───────────────────────────
const t0 = Date.now();
const top1USD = measure('--quiet').top1USD;
/** 第 8 章门槛 = 第 480 月榜首（换算成元）—— 「日历打满 2066」与「登顶」是同一刻 */
const mcapEnd = top1USD * RMB_PER_T_USD;

let cur = { ...parse(ORIGINAL), startMcap: START_MCAP };

console.log('');
console.log('  🎚  曲线标定器（量尺 = tools/headless-check.mjs，旋钮 = LINE_COST0 + ACTS[].mcap 形状）');
console.log('  ─'.repeat(36));
console.log(`  起点：LINE_COST0 = ${cur.lineCost0} ｜ 第 8 章门槛 = ${mcapEnd.toExponential(3)} 元（第 480 月榜首 ${top1USD}T USD）`);
console.log('');
console.log('  轮   LINE_COST0   A 合计    D 合计    A 最大偏差   bad');
console.log('  ' + '─'.repeat(60));

const history = [];
let best = null;
let wrote = false;

for (let round = 0; round <= MAX_ROUNDS; round++) {
  const a = measureA();
  const d = measureD();
  const bad = a.bad + d.bad;
  history.push({ round, lineCost0: cur.lineCost0, totalA: a.total, totalD: d.total, maxDev: a.maxDev, bad });
  console.log(`  ${String(round).padStart(2)}  ${String(+cur.lineCost0.toFixed(1)).padStart(11)}`
    + `  ${(a.total.toFixed(2) + 'h').padStart(8)}  ${(d.total.toFixed(2) + 'h').padStart(8)}`
    + `  ${((a.maxDev == null ? '—' : (a.maxDev * 100).toFixed(0) + '%')).padStart(10)}  ${String(bad).padStart(4)}`
    + (bad === 0 ? '  ✅' : ''));

  if (!best || bad < best.bad) best = { ...cur, mcaps: [...cur.mcaps], bad, a, d };
  if (bad === 0 || round === MAX_ROUNDS) break;

  cur = step(cur, a.durs, mcapEnd);
  writeFileSync(CONTENT, render(ORIGINAL, cur));
  wrote = true;
}

// 收敛不了就把「最好的一轮」写回去（绝不留下更差的一份）
const finalBad = history[history.length - 1].bad;
if (wrote && best.bad < finalBad) {
  writeFileSync(CONTENT, render(ORIGINAL, best));
  console.log(`  ↩︎ 末轮比历史最好一轮更差，已回滚到第 ${history.find(h => h.bad === best.bad).round} 轮（bad ${best.bad}）`);
}

const delivered = best.bad === 0;
console.log('  ' + '─'.repeat(60));
console.log(`  ${delivered ? '✅ 达标（bad 0）' : `❌ 未收敛（最好 bad ${best.bad}）`}`
  + ` ｜ 轮次 ${history.length} ｜ 写盘 ${wrote ? '是' : '否'} ｜ ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (!wrote) console.log('  ✅ 幂等：起点即达标，一个字节都没有改（GDD §5.3 的判据）');
console.log(`  A 合计 ${best.a.total}h ∈ [${CURVE_BAND[0]}, ${CURVE_BAND[1]}]`
  + ` ｜ D 合计 ${best.d.total}h ∈ [${IDLE_BAND[0]}, ${IDLE_BAND[1]}]`
  + ` ｜ 容差 ±${(CURVE_TOL * 100).toFixed(0)}%`);
console.log('');

console.log('BRIEF ' + JSON.stringify({
  wrote,
  rounds: history.length,
  bad: best.bad,
  lineCost0: +best.lineCost0.toFixed(2),
  mcapEnd: +best.mcaps[7].toExponential(4),
  top1USD: +top1USD.toFixed(2),
  totalA: best.a.total,
  totalD: best.d.total,
  maxDevA: best.a.maxDev,
  history: history.map(h => ({ round: h.round, bad: h.bad, totalA: h.totalA, totalD: h.totalD })),
}));
