/**
 * 世界模拟对照工具（离线跑，不接游戏）
 *   node tools/world-sim.mjs           三套模型 × 关键年份的 Top10
 *   node tools/world-sim.mjs --model=B 只看一套
 *   node tools/world-sim.mjs --year=2056 --top=15
 *
 * 用途：数值/叙事拍板前，先看这三套假设到底会长出什么榜。
 */

import { createWorld, advanceWorld, ranking, worldDate } from '../src/core/world.js';

const arg = (k, d) => {
  const m = process.argv.slice(2).find(a => a.startsWith(`--${k}=`));
  return m ? m.split('=')[1] : d;
};

const MODELS = arg('model', '').split(',').filter(Boolean);
const YEARS = arg('year', '').split(',').filter(Boolean).map(Number);
const TOP = Number(arg('top', 10));
const models = MODELS.length ? MODELS : ['A', 'B', 'C'];
const checkYears = YEARS.length ? YEARS : [2031, 2036, 2041, 2046, 2051, 2056, 2061];

const pad = (s, n) => String(s).padEnd(n, ' ');
const padL = (s, n) => String(s).padStart(n, ' ');

for (const model of models) {
  console.log(`\n══════════ 模型 ${model} ══════════`);
  for (const year of checkYears) {
    const w = createWorld(model);
    const targetMonth = (year - 2026) * 12 - 8;      // 从 2026-09 起算
    if (targetMonth <= 0) { console.log(`  ${year}（未到）`); continue; }
    advanceWorld(w, targetMonth);
    const [cy, cm] = worldDate(w);
    const { top } = ranking(w, null, TOP);
    const totalTop = top.reduce((a, c) => a + c.cur, 0);
    console.log(`\n  ── ${cy} 年 ${cm} 月 ── Top${TOP} 合计 ${totalTop.toFixed(1)}T USD`);
    top.forEach(c => {
      console.log(`   ${padL(c.rank, 2)}. ${pad(c.n, 12)} ${padL(c.cur.toFixed(2), 7)}T  ${c.co}`);
    });
  }
}

// ── 确定性自检：同一起点走同样月数，两次结果必须完全一致（无头验证的前提）──
{
  const a = createWorld('B'); advanceWorld(a, 360);
  const b = createWorld('B'); advanceWorld(b, 360);
  const same = a.companies.every((c, i) => c.cur === b.companies[i].cur);
  console.log(`\n确定性自检（两次独立推进 360 月）：${same ? '✅ 完全一致' : '❌ 结果漂移！'}`);
  if (!same) process.exitCode = 1;
}

// ── 对照：玩家现值在世界里的位置 ──
const PLC = arg('player', '').split(',').filter(Boolean).map(Number);
console.log(`\n══════════ 玩家现值对照 ══════════`);
console.log('（玩家数值来自 headless-check 的 mcap 列，单位万亿 RMB → USD ÷ 7.2）');

/**
 * 玩家真实市值（`node tools/headless-check.mjs` 的市值列，万亿 RMB）对照幕末年份：
 *   幕5 2041–2046 → 0.9146 ｜ 幕6 2046–2051 → 37.50 ｜ 幕7 2051–2056 → 2869.23 ｜ 幕8 2056–2061 → 5560.84
 * ⚠️ 每次重标定后这两个数字会变，请重新跑 headless-check 取最新值再填回来。
 *   （2026-09-25 阶段 0/1 重标定：删点击期 + 合同可行域后，幕 7/8 的市值比旧值高一个量级。）
 */
const defaultPlayer = [[2046, 0.9146], [2051, 37.50], [2056, 2869.23], [2061, 5560.84]];
const playerList = PLC.length
  ? defaultPlayer.map(([y], i) => [y, PLC[i]])
  : defaultPlayer;

for (const model of models) {
  console.log(`\n  ── 模型 ${model} ──`);
  let w = createWorld(model);
  let curYear = 2026;
  for (const [year, rmb] of playerList) {
    advanceWorld(w, (year - curYear) * 12);
    curYear = year;
    const usd = rmb / 7.2;
    const { all } = ranking(w, usd, 1e9);
    const me = all.find(c => c.me);
    const no1 = all[0];
    console.log(`   ${year}：玩家 ${padL(rmb, 6)} 万亿RMB = ${padL(usd.toFixed(1), 6)}T USD`
      + ` → 第 ${padL(me.rank, 2)} 名 ／ 榜首 ${pad(no1.n, 8)} ${padL(no1.cur.toFixed(1), 6)}T`
      + ` ／ ×${(usd / no1.cur).toFixed(2)}`);
  }
}
