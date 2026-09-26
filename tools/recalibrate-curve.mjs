#!/usr/bin/env node
/**
 * 曲线标定器（曲线层 Task 3）：从「目标时长向量」反推 content.js 的数值
 * ===============================================================
 * 它按固定顺序改三样东西，**顺序不能换**：
 *   ① SEC_PER_YEAR —— 时间旋钮（= 目标总秒数 / 35 个游戏年）
 *   ② ACTS[].mcap  —— 形状旋钮（8 个门槛 ↔ 8 个目标时长）
 *   ③ λ            —— 量纲旋钮（整体货币改版，让「登顶」物理上够得着）
 *
 * ① 必须在 ② 之前：市值 = 年营收 × ps = 每秒收入 × SEC_PER_YEAR × ps，
 * 换个 SEC_PER_YEAR 就给所有市值换了把尺子，先钉住它，② 追的才是同一个东西。
 * ③ 必须在 ② 之后：λ 是「同一场演出换一套货币」（cost / rate / mcap 同乘 λ），
 * 理论上幕长不变 —— 但**绝对常量**（融资额 / PRESSURE 阈值 / 事件绝对额）不跟着缩放，
 * 实测会偏离，所以它不该参与 ② 的收敛过程，只在最后补一次并**实测复核 + 必要时续标**。
 *
 * 为什么用「跑真实现 + 坐标下降」而不是解公式：幕长是**复利 + 购买决策 + tier 解锁时序**
 * 的涌现结果，没有闭式解；而且 `mcap → 幕长` 是**分段**映射（单幕能在 0.22 ↔ 3.87 小时
 * 之间跳，见 R25），阻尼固定点迭代在这种映射上本来就不收敛 —— 旧写法跑满 45 轮，
 * 最大步长恒在 0.14–0.28，从未接近过它自己的收敛阈值。坐标下降不要求映射连续，
 * 只比较「候选的 score 是否严格变小」，天然适合分段函数。
 * headless-check 跑的就是 src/core 本身（架构铁律：验证工具与线上同源），
 * 一局 4.5h 的步数远少于旧的 50h 局，一次实测只要 0.1 秒左右 —— 直接迭代最准。
 *
 * ⚠️ **每个候选跑两条闸门路径**（R29）：A 主动（默认）与 D 纯挂机（`--no-contract`）。
 * 只跑 A 会漏掉 D 的 `mono` —— 实测 A 全绿时 D 仍有三处倒置，而「挂机也要单调递增」
 * 是**真**的节奏要求，不是 A 的影子。所以 score 是双路径元组，收敛时两条路径一起看。
 *
 * 用法：
 *   npm run tune                   # 标定并回写 src/core/content.js
 *   npm run tune -- --dry          # 只测一轮 + 报账，**不写任何文件**
 *   npm run tune -- --iters=20     # 轮次上限（默认 40；通常先撞上 --budget）
 *   npm run tune -- --budget=1500  # runCheck 累计调用上限（默认 1500 **对** ≈ 3000 次跑）
 *
 * ⚠️ 它会重写 src/core/content.js。跑完必须 `npm run check` + `npm run probe` 复核。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { SEC_PER_YEAR as SPY_NOW } from '../src/core/content.js';
import { MONTHS_TOTAL } from '../src/core/format.js';
import { createWorld, advanceWorld, ranking, RMB_PER_T_USD } from '../src/core/world.js';
import { TARGET_TOTAL_H, CURVE_MID, CURVE_TOL, CURVE_BAND, IDLE_BAND, TARGET_SEC_PER_YEAR } from './curve-targets.mjs';

const FILE = 'src/core/content.js';
const argOf = (k, d) => {
  const a = process.argv.find(x => x.startsWith(`--${k}=`));
  return a ? Number(a.split('=')[1]) : d;
};
const DRY = process.argv.includes('--dry');
const ITERS = argOf('iters', 40);      // 轮次上限
const BUDGET = argOf('budget', 1500);  // runCheck 累计调用上限（**按候选计**，一个候选 = 两条路径）
const STEP0 = argOf('step', 0.6);      // 坐标下降的初始步长（R25 原定 0.25，见下面 STEP_LADDER 的说明）
const STEP_MIN = 0.01;                 // 步长下限：再小就只是分段映射的噪声
/**
 * 起点步长的候选表，**从大到小**依次试，第一个达标的就停（R25 的步长细则是 0.25，
 * 这里是对它的**实测修正**，理由见 R28）：
 *   `mcap → 幕长` 是断崖式映射（单幕能在 0.22 ↔ 3.87 h 之间跳），于是「步长太小」会卡死：
 *   要修好第 1↔2 幕的倒置，得把 ratio[2] 抬到 act2 > act1，而中间那个「还差一点」的点
 *   因为 inv 没变、maxDev 反而更差，会被「平手不接 / 只接严格更优」的规则拒掉 ——
 *   小步长永远走不到。0.6 能一步跨过去；0.25 只作为兜底（有些地形反而只有小步走得动）。
 */
const STEP_LADDER = [...new Set([STEP0, 0.25])];
const LAMBDA_ROUNDS = argOf('lambda-rounds', 3);  // ③ λ「放大 → 复核 → 续标」的最大轮数

/** 从 content.js 文本里按出现顺序读出 8 个 mcap（它们是 ACTS 里唯一的 mcap） */
const readMcaps = () => [...readFileSync(FILE, 'utf8').matchAll(/mcap: ([0-9.eE+-]+)/g)].map(m => Number(m[1]));

/** runCheck 累计调用数（**按候选计**：一个候选 = 两条路径 = 两次进程）—— 与「步长」并列的预算闸 */
let checks = 0;

/** 跑**一条**路径，取它的 BRIEF 行 */
const runOne = flag => {
  const out = execSync(`node tools/headless-check.mjs ${flag}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const line = out.split('\n').find(l => l.startsWith('BRIEF '));
  if (!line) throw new Error('headless-check 没有打印 BRIEF 行');
  return JSON.parse(line.slice(6));
};

/**
 * 跑线上实现，**两条闸门路径各一次**（R29）：A 主动（默认）与 D 纯挂机（`--no-contract`）。
 * 单次实测只要 ~0.1 s（步数 622）⇒ 一个候选两次进程完全负担得起。
 * 为什么必须跑 D：只跑 A 会漏掉 D 的 `mono` —— 实测 A 全绿时 D 仍有三处倒置，
 * 而「挂机也要单调递增」是**真**的节奏要求，不是 A 的影子。
 */
const runCheck = () => { checks++; return { a: runOne(''), d: runOne('--no-contract') }; };

/**
 * 唯一的写点。参数分两类，都是「要写进去的最终值」，不做增量：
 *   · `mcaps` + `{ spy, lambda }` —— 从 content.js 现有内容出发，替换 mcap / SEC_PER_YEAR / 货币量纲；
 *   · `{ raw }` —— 整份文件快照回滚（λ 回滚用），给字节就原样写回，不做任何解析。
 * 回滚也走这里，是为了「唯一的写点」这条纪律 —— 全仓库只有这一个函数会写 content.js。
 */
const writeFile = (mcaps, { spy = null, lambda = 1, raw = null } = {}) => {
  if (raw != null) { writeFileSync(FILE, raw); return; }
  if (mcaps.length !== 8) throw new Error(`mcap 数量应为 8，实为 ${mcaps.length}`);
  let hit = 0;
  const out = readFileSync(FILE, 'utf8').split('\n').map(l => {
    let line = l;
    // ACTS 的每一行同时带 act / seconds / mcap —— 一次改完，避免两次正则各自漏行
    const am = line.match(/act: (\d+),.*mcap: /);
    if (am) {
      const a = Number(am[1]);
      if (!(a >= 1 && a <= 8)) throw new Error(`ACTS 里出现异常幕次 ${a}`);
      line = line.replace(/mcap: [0-9.eE+-]+/, `mcap: ${mcaps[a - 1].toExponential(3)}`);
      // seconds 已从「标定产物」降级为「目标镜像」：它只回答「这一幕打算多长」，
      // 真实时长由 mcap 决定（见 Task 4 的说明）。finance.js 的融资时点与
      // format.js 的幕内进度都读它，所以它必须存在且必须等于目标。
      line = line.replace(/seconds: [0-9]+,/, `seconds: ${Math.round(CURVE_MID[a] * 3600)},`);
      hit++;
    }
    if (spy != null && /export const SEC_PER_YEAR = /.test(line)) {
      line = line.replace(/export const SEC_PER_YEAR = [0-9.eE+-]+;/, `export const SEC_PER_YEAR = ${spy};`);
    }
    if (lambda !== 1) {
      // money 量纲：建筑 cost.money（地标在 Task 1 之后是派生表达式，**不会**被这里匹配到，
      // 它跟着 mcap 自动缩放 —— 这正是 Task 1 想要的效果）
      const cm = line.match(/cost: \{ money: ([0-9.eE+-]+) \}/);
      if (cm) line = line.replace(cm[0], `cost: { money: ${(Number(cm[1]) * lambda).toExponential(3)} }`);
      if (/kind: 'money'/.test(line)) {
        const rm = line.match(/rate: ([0-9.eE+-]+)/);
        if (rm) line = line.replace(rm[0], `rate: ${(Number(rm[1]) * lambda).toExponential(3)}`);
      }
      // ⚠️ 第四批：只剩资金一条资源，FOUNDER_BASE 不再有 code / renmai 两栏。
      const fm = line.match(/FOUNDER_BASE = \{ money: ([0-9.eE+-]+) \};/);
      if (fm) line = line.replace(fm[0], `FOUNDER_BASE = { money: ${(Number(fm[1]) * lambda).toExponential(3)} };`);
    }
    return line;
  });
  if (hit !== 8) throw new Error(`只改到 ${hit} 幕的 mcap（应为 8）—— content.js 的 ACTS 结构变了？`);
  writeFileSync(FILE, out.join('\n'));
};

/**
 * λ：让「登顶」这条**绝对**下限成立。
 * 榜首（第 420 月，T USD）换算成 RMB 后，玩家终局市值必须够得着它的 1/0.8
 * （与 headless-check 的世界榜标定同一个判据：留 20% 余量给最后几幕反超）。
 * 只放大不缩小 —— λ < 1 说明已经够得着，不动它（少改一次数就少一次风险）。
 */
const needLambda = capRMB => {
  const w = createWorld('B');
  advanceWorld(w, MONTHS_TOTAL);
  const top1USD_T = ranking(w, null, 1).top[0].cur;
  const floorRMB = (top1USD_T / 0.8) * RMB_PER_T_USD;
  return { top1USD_T, floorRMB, lambda: Math.max(1, floorRMB / capRMB) };
};

/**
 * 登顶的**绝对**下限（与 λ 同源，取一次即可）：floorRMB 只依赖世界榜、不依赖当前 cap。
 * score 的 `violations` 要判「终局市值够不够得着榜首」，就得在搜索**之前**拿到这条线，
 * 不能等到最后算 λ 时才知道 —— 否则搜索会收敛到一个登顶不可达的点上。
 */
const FLOOR_RMB = needLambda(1).floorRMB;

/**
 * 双路径格式化（R29）：一行里同时给出 A 主动与 D 纯挂机的合计与 8 幕时长，
 * 免得报账时两条路径分开看、漏掉其中一条的倒置。
 */
const fmt = pr => `A ${pr.a.total.toFixed(2)}h [${pr.a.durs.map(d => (d == null ? '—' : d.toFixed(2))).join('/')}] ／ D ${pr.d.total.toFixed(2)}h [${pr.d.durs.map(d => (d == null ? '—' : d.toFixed(2))).join('/')}]`;
/** maxDev 可能是 `+∞`（某一幕时长不可测），直接 toFixed 会炸 */
const fmtDev = d => (d === Infinity ? '∞' : d.toFixed(3));

// ─────────────────────────── 主流程 ───────────────────────────
console.log(`目标：合计 ${TARGET_TOTAL_H}h（带宽见 curve-targets）｜ SEC_PER_YEAR ${SPY_NOW} → ${TARGET_SEC_PER_YEAR}`);

const mcaps = readMcaps();

if (DRY) {
  const pr = runCheck();
  const { top1USD_T, floorRMB, lambda } = needLambda(pr.a.cap);
  console.log(`  实测：${fmt(pr)}`);
  console.log(`  榜首（第 420 月）${top1USD_T.toFixed(1)}T USD ⇒ 终局须 ≥ ${floorRMB.toExponential(3)} 元，当前 ${pr.a.cap.toExponential(3)} ⇒ 本轮会写入 λ = ${lambda.toFixed(3)}`);
  console.log('  --dry：未写任何文件');
  process.exit(0);
}

// ① 时间旋钮：先钉住「一年有多长」
writeFile(mcaps, { spy: TARGET_SEC_PER_YEAR });

// ② 形状旋钮：mcap 坐标下降到「交付判据」
/**
 * 控制量是**相邻门槛的比值** `ratio[a] = mcap[a] / mcap[a-1]`（曲线层 Task 4 R21），
 * 第 1 幕是唯一例外 —— 起始市值为 0，没有前一档 ⇒ `mcap[1] = ratio[1]`（绝对锚，
 * 它同时是整局的时间尺度）。由 ratio 累乘即得 mcaps，所以搜索空间本身就是 ratio。
 *
 * 按绝对值各自调 mcap[a] 有**负耦合**：抬高 mcap[a] 会让第 a 幕变长，玩家进第 a+1 幕时
 * 收入更高，于是后续各幕反而变短 —— 8 个旋钮互相拉扯，整局只能振荡。
 * 比值才是真正的控制量：`canAdvance` 每步都查，进第 a 幕那一刻市值 ≈ mcap[a-1]
 * （过冲最多一步），要跨到 mcap[a] 所需的正是**比值**。改一个比值只改「这一幕多长」。
 */
const mcapsOf = ratio => {
  const out = [];
  let acc = 1;                                   // 从 1 累乘 ⇒ mcap[1] 即 ratio[1]（绝对锚）
  for (let a = 1; a <= 8; a++) { acc *= ratio[a]; out.push(acc); }
  return out;
};
/** 反向读法：从盘上的 8 个 mcap 还原出搜索空间里的 ratio */
const ratiosOf = m => {
  const r = [null, m[0]];
  for (let a = 2; a <= 8; a++) r.push(m[a - 1] / m[a - 2]);
  return r;
};

/**
 * score：**双路径字典序，小者优**（R29）
 *   ① violations —— 结构性违规数（越小越先修）：
 *        `#null(A) + #null(D)`（时长不可测）
 *      + `total(A) ∉ CURVE_BAND`
 *      + `total(D) ∉ IDLE_BAND`
 *      + `cap(A) < FLOOR_RMB`（登顶不可达 —— 与 λ / 世界榜同一条绝对下限）
 *   ② invA       —— A 路径的倒置对数 `#{ a>1 : d[a] != null && d[a-1] != null && d[a] <= d[a-1] }`
 *   ③ invD       —— D 路径的同一件事（**D 的 `mono` 是独立要求**，不能靠 A 带过）
 *   ④ maxDevA    —— `max_a |d_A[a] / CURVE_MID[a] − 1|`，`d_A[a] == null` 记 `+∞`
 *   ⑤ totalGapA  —— `|total(A) − TARGET_TOTAL_H|`
 * 为什么 violations 排第一：`null` / 登顶不可达 / 合计出带，是「连门都没进」的失败，
 * 比「进了门但节奏歪一点」严重，必须先清零再谈其余。
 * 为什么 invD 排第三：它是本轮唯一还没过的验收项（A 早已单调、D 有三处倒置），
 * 排在 maxDevA 之前，避免搜索在 A 的容差内停住而放着 D 的倒置不管。
 * `d[a] == null` 记 `+∞` 的道理与 R18 同源：**测不出来就是最差**，不能被别的幕的好成绩掩盖。
 */
const invOf = durs => {
  let n = 0;
  for (let a = 2; a <= 8; a++) if (durs[a - 1] != null && durs[a - 2] != null && durs[a - 1] <= durs[a - 2]) n++;
  return n;
};
const maxDevOf = durs => {
  let m = 0;
  for (let a = 1; a <= 8; a++) {
    const v = durs[a - 1];
    if (v == null || !Number.isFinite(v)) return Infinity;   // 测不出来就是最差，直接短路
    const dev = Math.abs(v / CURVE_MID[a] - 1);
    if (dev > m) m = dev;
  }
  return m;
};
const nullsOf = durs => durs.filter(d => d == null || !Number.isFinite(d)).length;
const inBand = (v, band) => v >= band[0] && v <= band[1];

const scoreOf = pr => ({
  violations: nullsOf(pr.a.durs) + nullsOf(pr.d.durs)
    + (inBand(pr.a.total, CURVE_BAND) ? 0 : 1)
    + (inBand(pr.d.total, IDLE_BAND) ? 0 : 1)
    + (pr.a.cap >= FLOOR_RMB ? 0 : 1),
  invA: invOf(pr.a.durs),
  invD: invOf(pr.d.durs),
  maxDevA: maxDevOf(pr.a.durs),
  totalGapA: Math.abs(pr.a.total - TARGET_TOTAL_H),
});

/** 严格更优才算更优 —— **平手不接**（R25），否则会在两个等价点之间无限打转 */
const better = (x, y) =>
  x.violations !== y.violations ? x.violations < y.violations
    : x.invA !== y.invA ? x.invA < y.invA
      : x.invD !== y.invD ? x.invD < y.invD
        : x.maxDevA !== y.maxDevA ? x.maxDevA < y.maxDevA
          : x.totalGapA < y.totalGapA - 1e-9;

/**
 * 交付判据（R29 第 1 条）——**它才是「可以停手」的定义**，不是什么内部精度阈值。
 * 四项同时成立：结构性违规清零、A 单调、**D 也单调**、A 的逐幕偏差在容差内。
 * 注意这里**没有**要求 `totalGapA` 更小：合计只要落在各自带宽里就行，那是判据（violations
 * 里的两项），不是要压到零的误差 —— 去追一个与交付无关的精度只会永远不收工。
 */
const delivered = sco =>
  sco.violations === 0 && sco.invA === 0 && sco.invD === 0 && sco.maxDevA <= CURVE_TOL;

/**
 * 评估一个候选。⚠️ 候选**必须先落到 content.js** 才可能被 headless-check 读到
 * （它是静态 `import`，没有「传入一组数」的入口）—— 所以写入分两类，别把它们混为一谈：
 *   ① 候选写入（本函数）—— 只发生在「正在评估这一个候选」的瞬间，可能比 best 差；
 *   ② best 写入 —— 每一维的两个方向试完、每一轮结束、以及返回前，盘上一律落定为 best。
 * 于是：**任何可观察的静止态都是 best**，更差的候选绝不会残留（R25 第 3 条）。
 */
const evalRatios = ratio => { writeFile(mcapsOf(ratio), {}); return runCheck(); };

/**
 * 坐标下降（R25 / R29）：外层轮次，每轮对 a = 1..8 依次试 `ratio[a] × (1 ± step)`
 * （两方向都试，以**本维开始时的 best** 为基准），只接受让 score 严格变小的那个；
 * 整轮零接受 ⇒ `step /= 2`。`step < STEP_MIN` 或 runCheck 预算用尽即停。
 * 每个候选都跑**两条路径**（`evalRatios` → `runCheck`），所以接受 / 交付判据看的是双路径元组。
 */
const converge = (step0 = STEP0, startPair = null) => {
  let bestRatios = ratiosOf(readMcaps());        // 起点 = 当前 content.js 的 ratio（R25）
  let best = startPair || runCheck();
  let bestScore = scoreOf(best);
  console.log(`  起点：${fmt(best)} ｜ violations=${bestScore.violations} invA=${bestScore.invA} invD=${bestScore.invD} maxDevA=${fmtDev(bestScore.maxDevA)}`);
  /**
   * ⚠️ 起点已达标就**立刻收工**。少了这一句，已达标的盘会被「再压一点 totalGap」的贪心带着
   * 走下坡：实测第二次跑 tune 时它把第 8 幕从 1.28 h 压到 1.15 h（合计 5.30 → 5.16），
   * 幕长判据仍达标、但终局市值从 2.57e15 掉到 1.85e15，**跌破榜首下限 ⇒ 登顶不再可达**。
   * 「达标就不动」既保住了登顶余量，也让 tune 幂等（跑第二遍不再改盘）。
   * 判据是**双路径**的交付口径（R29）：起点必须 A、D 都单调且 A 在容差内，否则继续搜。
   */
  if (delivered(bestScore)) { console.log('  起点已达标 ⇒ 不再搜（tune 幂等）'); return best; }
  let step = step0;
  for (let it = 1; it <= ITERS; it++) {
    if (step < STEP_MIN) { console.log(`  步长 ${step.toFixed(4)} < ${STEP_MIN} ⇒ 停（搜到头了）`); break; }
    if (checks >= BUDGET) { console.log(`  runCheck 预算用尽（${checks}/${BUDGET} 次）⇒ 停`); break; }
    let accepted = 0;
    for (let a = 1; a <= 8; a++) {
      const base = bestRatios.slice();
      let pick = null;
      for (const dir of [1, -1]) {
        if (checks >= BUDGET) break;
        const cand = base.slice();
        cand[a] = base[a] * (1 + dir * step);
        if (!(cand[a] > 0) || !Number.isFinite(cand[a])) continue;
        const pr = evalRatios(cand);
        const sco = scoreOf(pr);
        if (delivered(sco)) {
          // 命中交付判据 ⇒ 立即停。盘上此刻正是这个候选（evalRatios 刚写过）。
          console.log(`  轮 ${it} a=${a} dir=${dir > 0 ? '+' : '−'} ⇒ ✅ 命中交付判据：${fmt(pr)}`);
          return pr;
        }
        if (better(sco, pick ? pick.sco : bestScore)) pick = { ratios: cand, brief: pr, sco };
      }
      if (pick) { bestRatios = pick.ratios; best = pick.brief; bestScore = pick.sco; accepted++; }
      writeFile(mcapsOf(bestRatios));   // 这一维试完了：盘上落定为 best（可能是被接受的新值）
    }
    console.log(`  轮 ${String(it).padStart(2)} step=${step.toFixed(3)} viol=${bestScore.violations} invA=${bestScore.invA} invD=${bestScore.invD} maxDevA=${fmtDev(bestScore.maxDevA)} totalA=${best.a.total.toFixed(2)} totalD=${best.d.total.toFixed(2)}${accepted ? '' : '（零接受）'}`);
    if (accepted === 0) step /= 2;
  }
  writeFile(mcapsOf(bestRatios));   // 返回前盘上落定为 best
  return best;
};
// 按 STEP_LADDER 从大到小试起点步长，第一个达标的步长就停
let brief = converge();
for (let i = 1; i < STEP_LADDER.length && !delivered(scoreOf(brief)); i++) {
  if (checks >= BUDGET) { console.log('  runCheck 预算用尽 ⇒ 不再换步长'); break; }
  console.log(`  步长 ${STEP_LADDER[i - 1]} 未达标 ⇒ 换步长 ${STEP_LADDER[i]} 从当前 best 续搜：`);
  brief = converge(STEP_LADDER[i], brief);
}

// ③ 量纲旋钮：λ（货币改版）—— 与 ② 同一套「只写更优」纪律
/**
 * λ 是**唯一会无条件写盘**的步骤（① 的 SEC_PER_YEAR 在稳态下不写、② 只在更优时写），
 * 而它又**不是**严格的时长不变换（见下），所以必须加两道闸 —— 否则反复跑 tune 会把 ②
 * 辛苦标定的达标状态一次次冲掉（实测：第二次跑就从 4.66/inv0 退化成 5.30/inv2）：
 *   闸一「有界循环」：λ ≤ 1.0001 就立刻收工（cap 已够得着榜首，不需要再放大）—— 幂等；
 *   闸二「快照回滚」：λ 之后若既没命中交付判据、续标也救不回比原状态更好的点，
 *                     就把整份文件按快照回滚，绝不把更差的状态留在盘上。
 */
let lambda = 1;
let top1USD_T = null, floorRMB = null;
let bestBrief = brief;
for (let k = 1; k <= LAMBDA_ROUNDS; k++) {
  const need = needLambda(bestBrief.a.cap);
  top1USD_T = need.top1USD_T; floorRMB = need.floorRMB; lambda = need.lambda;
  console.log(`  榜首（第 420 月）${top1USD_T.toFixed(1)}T USD ⇒ 终局须 ≥ ${floorRMB.toExponential(3)} 元 ／ 当前 ${bestBrief.a.cap.toExponential(3)} ⇒ λ = ${lambda.toFixed(3)}`);
  if (lambda <= 1.0001) { console.log('  cap 已够得着榜首（λ ≤ 1.0001）⇒ 不再放大，收工（tune 幂等）'); break; }
  const snapshot = readFileSync(FILE, 'utf8');        // 实测达标状态：回滚用
  writeFile(readMcaps().map(x => x * lambda), { lambda });
  console.log('  λ 把 cost / rate / mcap 同乘一个尺度（货币改版）⇒ 理论上幕长不变，**两条路径**各复核一次：');
  const after = runCheck();
  const sc = scoreOf(after);
  console.log(`  复核：${fmt(after)} ｜ violations=${sc.violations} invA=${sc.invA} invD=${sc.invD} maxDevA=${fmtDev(sc.maxDevA)}`);
  /**
   * ⚠️ λ **不是**严格的时长不变换：finance.js 的融资额、PRESSURE 阈值、事件绝对额等
   * **绝对常量**没有跟着缩放（R25）。所以复核一次是必须的：一旦不再满足交付判据，就用
   * **剩下的预算**再跑一段坐标下降把它救回来（盘上此刻是 best，converge 从它续跑）。
   */
  if (delivered(sc)) { bestBrief = after; continue; }
  console.log('  ⚠️ λ 之后幕长变了、不再满足交付判据 ⇒ 用剩余预算续标：');
  const rescued = converge(STEP0, after);
  const rsc = scoreOf(rescued);
  if (delivered(rsc) || better(rsc, scoreOf(bestBrief))) { bestBrief = rescued; continue; }
  console.log('  ❌ 续标也救不回比 λ 之前更好的点 ⇒ 回滚快照（绝不写更差）');
  writeFile(null, { raw: snapshot });
  lambda = 1;
  break;
}
brief = bestBrief;

// ④ 报账（标定是否真的达标，由这里和 `npm run check` + `... --no-contract` 一起说）
const finalSco = scoreOf(brief);
/** 逐幕偏差只对 A 报 —— CURVE_MID 是**主动路径**的节奏曲线，D 不用它当判据（R28） */
const devOff = (durs) => durs.map((d, i) => (d == null ? `第${i + 1}幕 缺失` : Math.abs(d / CURVE_MID[i + 1] - 1) > CURVE_TOL ? `第${i + 1}幕 目标 ${CURVE_MID[i + 1]}h 实测 ${d.toFixed(2)}h` : null)).filter(Boolean);
const offA = devOff(brief.a.durs);
console.log(offA.length ? `  ⚠️ A 路径仍有 ${offA.length} 幕超出 ±${(CURVE_TOL * 100).toFixed(0)}%：${offA.join('；')}` : `  ✅ A 路径 8 幕全部落在 ±${(CURVE_TOL * 100).toFixed(0)}% 内`);
console.log(`  交付判据（双路径）：A 合计 ∈ [${CURVE_BAND[0]}, ${CURVE_BAND[1]}]、D 合计 ∈ [${IDLE_BAND[0]}, ${IDLE_BAND[1]}]、两条路径都单调递增、A 的 maxDev ≤ ${CURVE_TOL} ⇒ violations ${finalSco.violations}｜invA ${finalSco.invA}｜invD ${finalSco.invD}｜maxDevA ${fmtDev(finalSco.maxDevA)} ⇒ ${delivered(finalSco) ? '✅ 达标' : '❌ 未达标'}`);
console.log(`  本轮 runCheck 调用 ${checks} 次（预算 ${BUDGET}，每次含 A + D 两条路径）`);
console.log('BRIEF ' + JSON.stringify({
  totalA: +brief.a.total.toFixed(2), totalD: +brief.d.total.toFixed(2),
  dursA: brief.a.durs, dursD: brief.d.durs,
  monoA: brief.a.mono, monoD: brief.d.mono,
  cap: brief.a.cap, top1USD: +top1USD_T.toFixed(2), lambda: +lambda.toFixed(4),
  violations: finalSco.violations, invA: finalSco.invA, invD: finalSco.invD,
  maxDevA: finalSco.maxDevA === Infinity ? 'Infinity' : +finalSco.maxDevA.toFixed(4),
  delivered: delivered(finalSco),
}));
