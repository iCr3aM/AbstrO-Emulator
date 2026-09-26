#!/usr/bin/env node
/**
 * Abstract Studio 创业模拟器 · 平衡仿真 v6（现实性约束版）
 * ===============================================================
 * v6 相对 v5 的核心改动：**给经济加上「现实性约束」**
 *
 *   v5 的问题：第八幕地标造价 1,360 京（1.36e19 元）——比市值还大 1 亿倍。
 *   真实世界数据（2026 Top10 市值公司）：现金储备 ≈ 市值的 1–3.5%（中位 2.5%）。
 *   所以：市值 30 万亿的公司，现金只有约 7,500 亿。
 *
 * v6 做法：
 *   1. 市值不再是「叙事标签」，而是**由经济推导**：市值 = 年营收 × P/S(幕)
 *      （P/S 参考真实区间：初创 3× → AI 龙头 26×）
 *   2. 地标造价不再由标定器随意决定，而是**锚定在真实比例上**：
 *      地标造价 ≈ 市值的 2%–20%（资本开支量级），由 P/S 与营收反推
 *   3. 幕门槛与地标造价都改读 src/core/content.js 的市值门槛（ACTS[].mcap），
 *      镜像自己不再持有「一幕多长」的旋钮（曲线层 Task 5 起与线上同源）
 *   4. 保留 v5 已被验证的两条硬指标：合计落在 CURVE_BAND、每幕单调递增
 *
 * 目标时长与带宽改读 tools/curve-targets.mjs（唯一真相源）。
 * 用法：node tools/balance-sim.mjs [--choice=tech|biz|org]
 *
 * ⚠️⚠️ 已知失效：**自曲线层起，本镜像不再作为引擎标定的交叉检验**（R38）。
 *   实测：第 1 幕约 0.6h 之后就**再也到不了任何一幕**（`durs` 从第 2 幕起全是 null）。
 *   这不是「±40% 内的差异」，是仪器报废 —— 别把它当成一条通过的验证。
 *   根因：本镜像是一个**简化模型**，缺员工 / 幕乘数 / 合同 / 规模维护成本这几层，
 *   于是它的每幕增长率只有 ~10×，而新标定的 `ACTS[].mcap` 要求每幕 15–37×。
 *   旧版之所以「对得上 52h」，靠的是 `LMSCALE` 这个**自标定旋钮**（曲线层已删除）；
 *   换句话说，旧版对上的是它自己拧出来的数，本来就不是独立验证。
 *   处置：**保留**它与线上同源的判据（读 `curve-targets` / `LANDMARK_K` / `MCAP(a)`），
 *   将来把这些层补上时仪器立刻可用；**禁止**为了让镜像「看起来对上」去改 `B` 表 /
 *   `MIRROR_SCALE` 或自造一套门槛 —— 那会让交叉检验退回成自证（R4 / R34 同源）。
 *   另：`mono` 已按「不可测即 ❌」修（C2）—— 任一幕未到达时不再谎报「单调递增 ✅」。
 */

import { ACTS, BUILDINGS, LANDMARK_K } from '../src/core/content.js';
import { CURVE_MID, CURVE_BAND, CURVE_TOL, TARGET_SEC_PER_YEAR } from './curve-targets.mjs';

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const CHOICE = (process.argv.find(a => a.startsWith('--choice=')) || '--choice=tech').split('=')[1];

const P = {
  SAL_BASE: 0.26, SAL_STEP: 0.015,
  SEC_PER_YEAR: arg('spy', TARGET_SEC_PER_YEAR),   // 与线上同源（= 目标总秒数 / 35 年）
  FOUNDER: { money: 1, code: 3, renmai: 3 },
  MAX_TIME: 400 * 3600, MAX_STEPS: 150000,
};

// 市值 = 年营收 × P/S。P/S 参考真实数据：早期初创 3×、成长期 6–14×、AI 龙头 22–26×
const PS = [0, 3, 6, 10, 14, 18, 22, 26, 20];

// 目标时长与带宽改读 tools/curve-targets.mjs（唯一真相源）——
// 镜像不该有自己的节奏目标，否则它「独立验证」的是它自己的假设。
// （`const TARGET = CURVE_MID` 曾在此，只有已删的 scoreOf 用它 —— 一并删掉，免得留一个孤立别名）
const RANGE  = CURVE_MID.map((m, a) => (a === 0 ? null : [m * (1 - CURVE_TOL), m * (1 + CURVE_TOL)]));
const NAME   = [null, '出租屋', '车库', '中关村', '出海', '算力帝国/IPO', '万亿时代', '超越英伟达', '交接与退休'];
const LM     = [null, 'garage', 'floor', 'tower', 'hq', 'chipline', 'gw', 'orbit', 'perp'];

// 成本增长率明显提高（v5 的 1.19–1.25 会让经济跨越 14 个数量级；现实只需要 8–9 个）
const B = [
  // ── 资金链（= 合同收入）：产出比 1 → 3e5 ──
  { id:'biz1',  n:'商务助理',       a:1, c:{money:60},      r:1.35, prod:['money',1] },
  { id:'sales', n:'销售团队',       a:2, c:{money:900},     r:1.33, prod:['money',7] },
  { id:'biz2',  n:'商务拓展部',     a:3, c:{money:1.5e4},   r:1.32, prod:['money',60] },
  { id:'biz3',  n:'全球渠道部',     a:4, c:{money:4e5},     r:1.31, prod:['money',500] },
  { id:'biz4',  n:'生态合作部',     a:5, c:{money:1.2e7},   r:1.30, prod:['money',4000] },
  { id:'biz5',  n:'标准委员会',     a:6, c:{money:5e8},     r:1.29, prod:['money',35000] },
  { id:'biz6',  n:'文明级业务部',   a:7, c:{money:3e10},    r:1.28, prod:['money',300000] },
  // ── 代码链：产出比 1 → 1000 ──
  { id:'xuedi', n:'兼职学弟',       a:1, c:{code:50},       r:1.37, prod:['code',1] },
  { id:'prog',  n:'全职程序员',     a:1, c:{code:800},      r:1.35, prod:['code',5] },
  { id:'team',  n:'研发小组',       a:2, c:{code:2e4},      r:1.33, prod:['code',30] },
  { id:'algo',  n:'算法团队',       a:3, c:{code:5e5},      r:1.31, prod:['code',180] },
  { id:'front', n:'前沿研究院',     a:5, c:{code:2e8},      r:1.29, prod:['code',1000] },
  // ── 人脉链：产出比 1 → 600 ──
  { id:'rel1',  n:'商务助理·关系',  a:1, c:{renmai:60},     r:1.37, prod:['renmai',1] },
  { id:'rel2',  n:'渠道经理',       a:3, c:{renmai:5e3},    r:1.33, prod:['renmai',25] },
  { id:'rel3',  n:'全球关系部',     a:5, c:{renmai:3e6},    r:1.31, prod:['renmai',600] },
  // ── 设施（乘数）──
  { id:'srv1',  n:'二手服务器',     a:2, c:{money:8e4},     r:1.33, mul:['money',1.05] },
  { id:'lab',   n:'研发实验室',     a:2, c:{money:3e5},     r:1.33, mul:['code',1.08] },
  { id:'rack',  n:'机柜',           a:3, c:{money:2e6},     r:1.32, mul:['money',1.08] },
  { id:'idc0',  n:'小型机房',       a:3, c:{money:8e6},     r:1.32, mul:['money',1.12] },
  { id:'idc1',  n:'IDC 托管',       a:4, c:{money:4e7},     r:1.31, mul:['money',1.18] },
  { id:'inst',  n:'研究院',         a:4, c:{money:1.5e8},   r:1.30, mul:['money',1.28] },
  { id:'cool',  n:'液冷智算中心',   a:5, c:{money:6e8},     r:1.30, mul:['eff',1.15] },
  { id:'dc',    n:'自建数据中心',   a:5, c:{money:2e9},     r:1.29, mul:['money',1.40] },
  { id:'fab',   n:'晶圆厂',         a:6, c:{money:1e10},    r:1.28, mul:['money',1.60] },
  { id:'photon',n:'光子/量子实验室',a:6, c:{money:3e10},    r:1.28, mul:['money',1.90] },
  { id:'sat',   n:'卫星通信星座',   a:7, c:{money:5e10},    r:1.28, mul:['eff',1.25] },
  { id:'ring',  n:'洲际算力环网',   a:7, c:{money:1e11},    r:1.27, mul:['money',2.20] },
  // ── 地标（造价 = 本幕门槛 / ps × LANDMARK_K，由 lmCostOf 派生）──
  //      B 表里的 c.money 只是历史副本，priceOf 对 lm 项一律取 lmCostOf(a)，此处数值不再生效
  { id:'garage',  n:'车库办公室',        a:1, c:{money:3.6e5},   r:1, lm:true },
  { id:'floor',   n:'写字楼半层',        a:2, c:{money:2.0e6},   r:1, lm:true },
  { id:'tower',   n:'独立办公楼',        a:3, c:{money:1.5e7},   r:1, lm:true },
  { id:'hq',      n:'全球总部',          a:4, c:{money:1.0e9},   r:1, lm:true },
  { id:'chipline',n:'自研芯片量产线',    a:5, c:{money:7.5e9},   r:1, lm:true },
  { id:'gw',      n:'千兆瓦级集群',      a:6, c:{money:7.5e11},  r:1, lm:true },
  { id:'orbit',   n:'海底/轨道数据中心', a:7, c:{money:1.5e13},  r:1, lm:true },
  { id:'perp',    n:'永续组织中枢',      a:8, c:{money:7.5e13},  r:1, lm:true },
];

// 抉择：资金乘数偏保守（避免把跨度推大）
// ⭐ 全局量纲缩放：把经济整体放大 MSCALE 倍，使第 7 幕市值命中「30 万亿（≈NVIDIA 峰值）」
// 系统对量纲是尺度不变的（成比例缩放不改变任何时长），所以这一步只影响数字的「观感」
const MSCALE = arg('mscale', 22);
for (const b of B) {
  if (b.c.money) b.c.money *= MSCALE;
  if (b.prod && b.prod[0] === 'money') b.prod[1] *= MSCALE;
}
P.FOUNDER.money *= MSCALE;

const ACTM = [0, 1.15, 1.20, 1.25, 1.30, 1.35, 1.40, 1.45, 1.15];
const ROUTE = { tech: { code: 1.6 }, biz: { renmai: 1.6 }, org: { sal: 0.90 } };

const MIL = [[25,2],[50,3],[100,5],[200,7]];   // ×210（完整四档，让里程碑真正被激活）
const mil = n => { let m = 1; for (const [k,v] of MIL) if (n >= k) m *= v; return m; };

const RSHIFT = [0,0,0,0,0,0,0,0,0];   // 成本增长率偏移（本轮固定为 0）
/**
 * 量纲对齐因子 —— 镜像自己的 `B` 表是 content.js 数字的**副本**（历史上整体乘过 MSCALE）。
 * 与其"记住历史倍数"，不如在运行期量一遍比值：两边任何一边改数，这个因子自动跟上。
 * 为什么必须对齐：门槛（ACTS[].mcap）与地标造价都是**绝对 RMB**，
 * 镜像的量纲若不与线上同一把尺子，「市值达标」在两边就不是同一件事。
 */
const MIRROR_SCALE = B.find(b => b.id === 'biz1').prod[1] / BUILDINGS.find(b => b.id === 'biz1').rate;

/** 幕门槛：与线上同源（曲线层 ⑤）。这就是镜像里「一幕多长」唯一的旋钮。 */
const MCAP = a => ACTS[a].mcap * MIRROR_SCALE;
/** 地标造价：派生量（曲线层 ① ②），与门槛同源 ⇒ 镜像里也不再是独立旋钮。 */
const lmCostOf = a => (MCAP(a) / ACTS[a].ps) * LANDMARK_K;

const rOf = b => b.r + (RSHIFT[b.a] || 0);
const fresh = () => ({
  t:0, act:1, res:{money:0, code:0, renmai:0},
  cnt: Object.fromEntries(B.map(b => [b.id, 0])),
  cumRev:0, bonus:{money:1, code:1, renmai:1, eff:1, sal:1}, buys:0, log:[],
});
const priceOf = (b, cnt) => {
  const o = {}, n = cnt[b.id] | 0;
  for (const [k, v] of Object.entries(b.c)) o[k] = v * Math.pow(Math.max(1.001, rOf(b)), n);
  // 地标：造价是派生量（= 本幕门槛 / ps × LANDMARK_K），不再乘自己的旋钮
  if (b.lm) o.money = lmCostOf(b.a);
  return o;
};

function rates(st) {
  const g = { money:P.FOUNDER.money, code:P.FOUNDER.code, renmai:P.FOUNDER.renmai };
  const add = { money:0, code:0, renmai:0, eff:0 };
  let gross = 0;
  for (const b of B) {
    const n = st.cnt[b.id]; if (!n) continue;
    const m = mil(n);
    if (b.prod) { const out = b.prod[1] * n * m; g[b.prod[0]] += out; if (b.prod[0] === 'money') gross += out; }
    if (b.mult) add[b.mult[0]] += (b.mult[1] - 1) * n;
  }
  const mM = (1 + add.money) * st.bonus.money, eM = (1 + add.eff) * st.bonus.eff;
  const codeRate = g.code * (1 + add.code) * st.bonus.code * eM;
  const renmaiRate = g.renmai * st.bonus.renmai * eM;
  const techF = 1 + Math.log10(1 + codeRate) / 8;
  const relF  = 1 + Math.log10(1 + renmaiRate) / 8;
  const moneyRate = g.money * mM * eM * techF * relF;
  const salFrac = (P.SAL_BASE + P.SAL_STEP * (st.act - 1)) * st.bonus.sal;
  const upkeep = gross * mM * eM * techF * relF * salFrac;
  return { moneyRate, codeRate, renmaiRate, upkeep, netMoney: moneyRate - upkeep, salFrac, techF, relF };
}
const tta = (st, b, R) => {
  const c = priceOf(b, st.cnt); let t = 0;
  for (const [k, need] of Object.entries(c)) {
    const have = st.res[k] || 0; if (have >= need) continue;
    const rate = k === 'money' ? R.netMoney : k === 'code' ? R.codeRate : R.renmaiRate;
    if (rate <= 0) return Infinity;
    t = Math.max(t, (need - have) / rate);
  }
  return t;
};
const afford = (st, b) => Object.entries(priceOf(b, st.cnt)).every(([k, v]) => (st.res[k] || 0) >= v);
const advance = (st, dt, R) => {
  st.res.money += R.netMoney * dt; st.res.code += R.codeRate * dt; st.res.renmai += R.renmaiRate * dt;
  st.cumRev += Math.max(0, R.moneyRate) * dt; st.t += dt;
};
const buy = (st, b) => { for (const [k, v] of Object.entries(priceOf(b, st.cnt))) st.res[k] -= v; st.cnt[b.id]++; st.buys++; };

function simulate(st, verbose = false) {
  const start = {1:0}, stats = {};
  let steps = 0;
  while (st.t < P.MAX_TIME && steps < P.MAX_STEPS) {
    steps++;
    const R = rates(st);
    const lm = B.find(b => b.id === LM[st.act]);
    const mcapNow = R.moneyRate * P.SEC_PER_YEAR * PS[st.act];

    if (st.act < 8 && mcapNow >= MCAP(st.act)) {
      stats[st.act] = { dur: st.t - start[st.act], R, cnt: {...st.cnt} };
      st.act++; start[st.act] = st.t;
      st.bonus.money *= ACTM[st.act];
      const rb = ROUTE[CHOICE] || {};
      for (const k of ['code','renmai','sal']) if (rb[k]) st.bonus[k] *= rb[k];
      if (verbose) st.log.push(`第 ${st.act} 幕 ${NAME[st.act]} ｜ 累计 ${fmtH(st.t)} ｜ 上一幕 ${fmtH(stats[st.act-1].dur)}`);
      continue;
    }
    if (st.act === 8 && mcapNow >= MCAP(8)) { stats[8] = { dur: st.t - start[8], R, cnt: {...st.cnt} }; break; }

    // ⚠️ 地标是**一次性、最多 1 座**的买入（content.js）：造价不随座数增长，
    //    若无 `cnt === 0` 守卫，下面的 afford 分支会把它反复买回去（每次照价扣款），
    //    把现金永久压在 lmCost 之下 —— 推幕判据改成市值后，重购不再被「买完即推幕」阻断。
    if (st.cnt[lm.id] === 0 && afford(st, lm)) { buy(st, lm); continue; }

    // 理性玩家：以「让本幕达标来得更早」为唯一准则（锚点 = 派生地标造价，与门槛同源）
    const lmCost = lmCostOf(st.act);
    const tLMbase = R.netMoney > 0 ? Math.max(0, (lmCost - st.res.money) / R.netMoney) : Infinity;

    let best = null, bestScore = Infinity, bestTt = 0;
    for (const b of B) {
      if (b.a > st.act) continue;
      const tt = tta(st, b, R); if (!isFinite(tt)) continue;
      const cost = priceOf(b, st.cnt);
      const moneyAfter = st.res.money - (cost.money || 0) + R.netMoney * tt;
      if (moneyAfter < 0) continue;
      const old = st.cnt[b.id]; st.cnt[b.id] = old + 1;
      const netAfter = rates(st).netMoney;
      st.cnt[b.id] = old;
      const tLMafter = netAfter > 0 ? tt + Math.max(0, (lmCost - moneyAfter) / netAfter) : Infinity;
      if (st.cnt[b.id] === 0 || tLMafter < Math.max(tLMbase, 1) * 0.999) {
        if (tLMafter < bestScore) { bestScore = tLMafter; best = b; bestTt = tt; }
      }
    }
    if (best) {
      if (bestTt > 0) advance(st, Math.min(bestTt, 1800), R);
      if (afford(st, best)) buy(st, best);
      continue;
    }
    if (!isFinite(tLMbase)) { st.log.push(`⚠️退出@第${st.act}幕 t=${fmtH(st.t)} 净资金/秒=${fmtN(R.netMoney)}`); break; }
    advance(st, Math.min(Math.max(tLMbase, 1), 1800), R);
  }
  if (st.t >= P.MAX_TIME && steps < P.MAX_STEPS) st.log.push(`⚠️超时@第${st.act}幕 t=${fmtH(st.t)} 净资金/秒=${fmtN(rates(st).netMoney)}`);
  const total = Object.values(stats).reduce((a, s) => a + s.dur, 0) / 3600;
  return { stats, steps, total };
}

function realismOf(stats) {
  const out = [];
  for (let a = 1; a <= 8; a++) {
    const s = stats[a]; if (!s) { out.push(null); continue; }
    const annualRev = s.R.moneyRate * P.SEC_PER_YEAR;
    const mcap = annualRev * PS[a];
    out.push({ act: a, annualRev, mcap, ps: PS[a], lmCost: lmCostOf(a) });
  }
  return out;
}

const fmtN = n => {
  if (!isFinite(n)) return '∞'; const a = Math.abs(n);
  if (a >= 1e12) return (n/1e12).toFixed(2)+'万亿';
  if (a >= 1e8) return (n/1e8).toFixed(2)+'亿';
  if (a >= 1e4) return (n/1e4).toFixed(2)+'万';
  return a >= 1 ? n.toFixed(0) : n.toFixed(2);
};
const fmtH = s => s < 3600 ? (s/60).toFixed(1)+'分' : (s/3600).toFixed(2)+'h';

const t0 = Date.now();
const st = fresh();
const { stats, steps, total } = simulate(st, true);
const real = realismOf(stats);

const out = [];
out.push('═'.repeat(96));
out.push(`  Abstract Studio · 平衡仿真 v6（现实性约束版） ｜ 抉择=${CHOICE} ｜ 耗时 ${((Date.now()-t0)/1000).toFixed(1)}s`);
out.push('═'.repeat(96));
out.push(`  1 游戏年 = ${P.SEC_PER_YEAR} 秒（≈ ${(P.SEC_PER_YEAR/3600).toFixed(2)} 小时） ｜ 购买 ${st.buys} 次 ｜ 步数 ${steps}`);
out.push('');
out.push('  幕  名称              地标                    造价        时长      目标       判定');
out.push('  ' + '─'.repeat(90));
let mono = true, monoUnmeasurable = false, prev = 0, bad = 0;
for (let a = 1; a <= 8; a++) {
  const s = stats[a], b = B.find(x => x.id === LM[a]);
  // 未到达 = 这一维没测到 ⇒ 单调性不可测（C2：不能因为「没跑到」就谎报 ✅）
  if (!s) { out.push(`  ${a}  ${NAME[a].padEnd(16)} ${b.n.padEnd(20)} （未到达）`); monoUnmeasurable = true; bad++; continue; }
  const h = s.dur/3600, [lo,hi] = RANGE[a];
  let v = h < lo*0.75 ? '❌太快' : h > hi*1.33 ? '❌太慢' : (h<lo||h>hi) ? '⚠️偏离' : '✅';
  if (h < prev) { mono = false; v = '❌非递增'; }
  if (v.startsWith('❌')) bad++;
  prev = h;
  out.push(`  ${a}  ${NAME[a].padEnd(16)} ${b.n.padEnd(20)} ${fmtN(lmCostOf(a)).padStart(12)}  ${fmtH(s.dur).padStart(8)}  ${(lo+'–'+hi+'h').padStart(9)}  ${v}`);
}
out.push('  ' + '─'.repeat(90));
/**
 * `mono` 的假绿修复（C2 / 最终审查）：初值 `true`、只在**到达**的幕上才可能被置 false ⇒
 * 8 幕全部未到达时它一次都不跑，这一项会打印「单调递增 ✅」而实际什么都没测。
 * 不可测即 ❌：任一幕未到达就判不成立（与 headless-check 的 `monoUnmeasurable` 同一口径）。
 */
const monoOk = mono && !monoUnmeasurable;
out.push(`  合计 ${total.toFixed(1)} h（目标 ${CURVE_BAND[0]}–${CURVE_BAND[1]} h）→ ${total>=CURVE_BAND[0]&&total<=CURVE_BAND[1]?'✅ 达标':'❌ 不达标'}   单调递增 → ${monoOk?'✅':(monoUnmeasurable?'❌不可测':'❌')}   问题幕数 ${bad}`);
out.push('');
out.push('  ⭐ 现实性检验（真实 Top10 公司：现金/市值 1–3.5%，市值/年营收 4–28×）');
out.push('  幕  年营收            市值(P/S推导)      市值/年营收   现金/市值   地标造价/年营收  现实性');
out.push('  ' + '─'.repeat(90));
for (let a = 1; a <= 8; a++) {
  const s = stats[a], r = real[a-1], b = B.find(x => x.id === LM[a]);
  if (!s || !r) continue;
  const cr = r.lmCost / r.annualRev;
  const cashRatio = r.lmCost / r.mcap;
  /**
   * 判据从「恒等式」改成「上界」（R30 / R41，与 headless-check 同源同理由）：
   * 表里取的是**幕末**年营收，而幕末必然已达标（市值 ≥ 本幕 mcap ⇒ 年营收 ≥ mcap/ps）
   * ⇒ 比值 = `LANDMARK_K × (mcap/ps) / 年营收 ≤ LANDMARK_K`，之后越走越低。
   * 恒等式只对「地标造价 = mcap/ps × LANDMARK_K」这条**定义式**成立 —— 写成 = 是假话。
   */
  const ok = cr > 0 && cr <= LANDMARK_K + 1e-6;
  out.push(`  ${a}  ${fmtN(r.annualRev).padStart(12)}   ${fmtN(r.mcap).padStart(14)}   ${(r.ps+'×').padStart(10)}   ${(cashRatio*100).toFixed(2).padStart(8)}%   ${cr.toFixed(2).padStart(14)}×  ${ok?'✅':'⚠️'}`);
}
out.push('');
out.push('  幕  资金/秒        代码/秒      人脉/秒      工资/秒       工资占比');
out.push('  ' + '─'.repeat(82));
for (let a = 1; a <= 8; a++) {
  const s = stats[a]; if (!s) continue; const R = s.R;
  out.push(`  ${a}  ${fmtN(R.moneyRate).padStart(10)} ${fmtN(R.codeRate).padStart(12)} ${fmtN(R.renmaiRate).padStart(11)} ${fmtN(R.upkeep).padStart(12)} ${(R.upkeep/R.moneyRate*100).toFixed(1).padStart(8)}%`);
}
const last = stats[8] || stats[7];
if (last) {
  const never = B.filter(b => b.a <= st.act && last.cnt[b.id] === 0);
  out.push('');
  out.push(never.length ? '  ⚠️ 从未购买：' + never.map(b => b.n).join('、') : '  ✅ 所有已解锁建筑都被购买过');
}
if (process.argv.includes('--counts')) {
  out.push('');
  out.push('  DUMP 各幕末建筑数量：');
  for (let a = 1; a <= 8; a++) {
    const s2 = stats[a]; if (!s2) continue;
    out.push(`  DUMP 幕${a} ` + B.filter(b => s2.cnt[b.id] > 0).map(b => `${b.id}x${s2.cnt[b.id]}`).join(' '));
  }
}
out.push('');
out.push('  ▶ 最终地标造价表（= 本幕门槛 / ps × LANDMARK_K，与门槛同源）');
for (let a = 1; a <= 8; a++) {
  const b = B.find(x => x.id === LM[a]), r = real[a-1];
  out.push(`     第 ${a} 幕  ${b.n.padEnd(20)} = ${fmtN(lmCostOf(a)).padStart(12)}   （${r?'市值 '+fmtN(r.mcap)+' 的 '+(lmCostOf(a)/r.mcap*100).toFixed(2)+'%，年营收的 '+(lmCostOf(a)/r.annualRev).toFixed(2)+'×':'—'}）`);
}
console.log(out.join('\n'));
console.log('BRIEF ' + JSON.stringify({ total:+total.toFixed(2), mono: monoOk, bad, durs:[1,2,3,4,5,6,7,8].map(a=>stats[a]?+(stats[a].dur/3600).toFixed(2):null) }));
