/**
 * 真实模拟（playthrough）—— 检查「可达性」
 * ===============================================================
 * 和 `headless-check.mjs` 的分工，说清楚：
 *
 *   headless-check  = **平衡检验**。它用 `suggestNext`（完美前瞻的理性模型）跳步推进，
 *                     只回答「数值对不对」。它**不能**回答「玩家能不能走到」。
 *   playthrough     = **可达性检验**。它按游戏真实的 1 秒 tick 推进，用一个
 *                     **没有前瞻能力的贪心玩家**做决策，从空档一直玩到结局。
 *
 * 为什么必须分开：`headless-check.mjs` 里那张「结局判定表」是**手工构造状态**
 * 再调 `evaluateRetirement()` 的 —— 那只能证明**判定函数对给定状态正确**，
 * 不能证明那个状态**玩得出来**（例如「第 8 幕市值达标时玩家真能排到世界第 1」只有真跑才知道）。
 *
 * ⚠️ 2026-09-26 第三批（结局收敛）：结局只剩「登顶」一个，判据是退休那一刻 `s.worldRank === 1`。
 *    没登顶点退休**不是失败**：游戏不结束，玩家可以接着经营（`ended === 'not-top'`）。
 *    传承（LP / 商店 / 转生）与心结、回忆图鉴整块删除，本文件的玩法分组也已随之收敛。
 *
 * 三条忠实性要求（缺一条就不是真模拟）：
 *   1. **dt = 1 秒**，与 `engine.TICK_MS` 一致，不做时间跳跃（跳步会漏掉定时器溢出、
 *      离线结算、事件窗口等一切与「时间如何流逝」有关的 bug）。
 *   2. **玩家不做前瞻**。决策只用界面上看得见的量（价格、产出、能否买得起），
 *      绝不调用 `suggestNext` —— 那是「顾问」，是检验用的上帝视角。
 *   3. **定期走一遍存档读写**。存不下来的状态 = 现实里重开就丢。
 *
 * 用法：
 *   node tools/playthrough.mjs                  # 跑默认玩法分组
 *   node tools/playthrough.mjs --style=greedy --route=tech --verbose
 *   node tools/playthrough.mjs --all             # 全部玩法分组（较慢，几分钟）
 */

import { createState, serialize, deserialize } from '../src/core/state.js';
import {
  rates, costOf, canAfford, purchase, unlocked, suggestNext, applySuggestion,
} from '../src/core/economy.js';
import { ACTS, BUILDINGS, STAFF, STAFF_PARAMS, SEC_PER_YEAR } from '../src/core/content.js';
import { tick as engineTick, advanceAct, canAdvance, isFinalAct, applyChoice } from '../src/core/engine.js';
import { acceptOffer, declineOffer, offersWithOdds, hasFreeSlot, suggestContract } from '../src/core/contracts.js';
import {
  trainStaff, raiseStaff, shareStaff, promoteStaff, headcount, actionsFor,
} from '../src/core/staff.js';
import { pendingEvent, resolveEvent } from '../src/core/events.js';
import { useSkill, SKILL_IDS } from '../src/core/skills.js';
import { evaluateRetirement, endingName } from '../src/core/endings.js';

// ─────────────────────────── 参数 ───────────────────────────
const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.split('=')[1] : d;
};
const flag = k => process.argv.includes(`--${k}`);

const DT = 1;                 // ⚠️ 真实 tick，别改
const THINK = Number(arg('think', 10));   // 玩家每 10 游戏秒做一次决定（人不逐帧操作）
const SAVE_EVERY = 300;       // 每 5 游戏分钟走一遍存档读写
const HOUR_CAP = Number(arg('cap', 400)); // 单局模拟上限（游戏小时），防跑飞

// ─────────────────────────── 玩家策略（无前瞻）───────────────────────────

/**
 * 贪心：在买得起的建筑里挑「单位资金产出最高」的。首次购买给予偏好
 * （真实玩家会先把每条链买出第一座，因为那解锁新东西）。
 */
function pickBuildingGreedy(s) {
  let best = null, bestScore = 0;
  for (const b of BUILDINGS) {
    if (b.kind === 'landmark') continue;
    if (!unlocked(s, b.id)) continue;
    if (!canAfford(s, b.id)) continue;
    const c = costOf(b.id, s.buildings[b.id] || 0);
    if (!(c.amount > 0)) continue;
    // mul 类没有直接产出：用「它乘的那些东西当前值多少」粗估，真实玩家也是这么感受的
    // ⚠️ 2026-09-26 第四批：只剩资金一条产出链，所以三种 target 的估值都归到 moneyRate。
    let gain = b.rate || 0;
    if (b.kind === 'mul') {
      gain = rates(s).moneyRate * (b.m - 1) * 0.25;
    }
    const first = (s.buildings[b.id] || 0) === 0 ? 2.5 : 1;   // 首次购买偏好
    const score = (gain / c.amount) * first;
    if (score > bestScore) { bestScore = score; best = b.id; }
  }
  return best;
}

/** 保守玩家：只买最便宜的那座（完全不看产出） */
function pickBuildingCheap(s) {
  let best = null, bestCost = Infinity;
  for (const b of BUILDINGS) {
    if (b.kind === 'landmark') continue;
    if (!unlocked(s, b.id)) continue;
    if (!canAfford(s, b.id)) continue;
    const c = costOf(b.id, s.buildings[b.id] || 0);
    if (c.amount < bestCost) { bestCost = c.amount; best = b.id; }
  }
  return best;
}

const PICKERS = { greedy: pickBuildingGreedy, cheap: pickBuildingCheap };

/**
 * 会留储备的玩家 —— **这才是正常人的买法**。
 *
 * 背景：把可购买乘数改成加法桶之后，经济对投入是线性的，
 * 于是「有钱就花」不再是最优解 —— 它会**永远攒不出地标**（实测 276 小时）。
 * 正常玩家看一眼进度条就知道要留钱：「还差 800 万，我这 300 万先别花」。
 * 所以中间水平应该用这条策略代表：**留够一个地标的钱，剩下的才拿去买设施。**
 */
function pickBuildingSaver(s, R) {
  const lmCost = costOf(ACTS[s.act].landmark, 0).amount;
  const reserve = lmCost;                       // 手里始终留一个地标的身家
  if (s.resources.money - reserve <= 0) return null;
  let best = null, bestScore = 0;
  for (const b of BUILDINGS) {
    if (b.kind === 'landmark') continue;
    if (!unlocked(s, b.id)) continue;
    const c = costOf(b.id, s.buildings[b.id] || 0);
    if (s.resources.money - c.amount < reserve) continue;
    let gain = b.rate || 0;
    if (b.kind === 'mul') {
      gain = rates(s).moneyRate * (b.m - 1) * 0.25;
    }
    const first = (s.buildings[b.id] || 0) === 0 ? 2.5 : 1;
    const score = (gain / c.amount) * first;
    if (score > bestScore) { bestScore = score; best = b.id; }
  }
  return best;
}
PICKERS.saver = pickBuildingSaver;

/**
 * 「多久回本」型玩家 —— 现实中正常人真正会用的判据，而且**不需要任何前瞻**。
 *
 * 规则只有一条：**只买回本时间 ≤ PAYBACK 秒的那一项**，否则就攒钱冲地标。
 * 为什么需要它：把可购买乘数改成加法桶后，「有钱就花」（greedy）会永远攒不出地标（实测 276h），
 * 「留一个地标身家」（saver）又太保守（实测 >200h 超时）。两者都不是正常人。
 * 而「这笔钱多久能赚回来」是每个闲置游戏玩家都会本能估算的东西 ——
 * 它自动给出一个**宽的平原**：设施越买越稀释，回本时间自然变长，到点就自己停手去攒地标。
 */
const PAYBACK = Number(arg('payback', 900));   // 15 分钟回本
function pickBuildingPayback(s, R) {
  const base = R.moneyRate;
  let best = null, bestPay = Infinity;
  for (const b of BUILDINGS) {
    if (b.kind === 'landmark' || !unlocked(s, b.id) || !canAfford(s, b.id)) continue;
    const c = costOf(b.id, s.buildings[b.id] || 0);
    const n0 = s.buildings[b.id] || 0;
    s.buildings[b.id] = n0 + 1;
    const after = rates(s).moneyRate;
    s.buildings[b.id] = n0;
    const d = after - base;
    if (d <= 0) continue;
    const pay = c.amount / d;
    if (pay < bestPay) { bestPay = pay; best = b.id; }
  }
  return bestPay <= PAYBACK ? best : null;      // 不划算就攒钱冲地标
}
PICKERS.payback = pickBuildingPayback;

/**
 * 顾问策略：直接用 `suggestNext`（刻意攒钱冲地标的保守模型）。
 * 这里**故意**允许调用它 —— 目的是做「同一份代码、同一个 tick 粒度，只有策略不同」的对照实验，
 * 单独隔离「策略」这一个变量。默认的贪心策略仍然禁止使用它。
 */
function thinkAdvisor(s, R) {
  const ev = pendingEvent(s);
  if (ev) {
    const annual = Math.max(0, R.moneyRate) * SEC_PER_YEAR;
    const ok = ev.options.map((o, i) => i).filter(i => {
      const o = ev.options[i];
      return !o.eff || !o.eff.money || o.eff.money >= 0 || s.resources.money + annual * o.eff.money >= 0;
    });
    if (!ok.length) return;
    let bi = ok[0], bw = -1;
    ok.forEach(i => { const w = ev.options[i].w ?? 1; if (w > bw) { bw = w; bi = i; } });
    resolveEvent(s, bi, R);
    return;
  }
  const sug = suggestNext(s, R);
  if (sug && sug.id) applySuggestion(s, sug, R);
}

/** 每 THINK 秒调用一次：做**一件**最该做的事（模拟玩家的注意力） */
function think(s, R, P) {
  const pick = PICKERS[P.style] || PICKERS.advisor || pickBuildingGreedy;

  // ① 决策事件弹窗（真人必须先点掉才能继续）
  const ev = pendingEvent(s);
  if (ev) {
    /**
     * ⚠️ 只能挑**付得起**的选项。界面上付不起的按钮是 disabled 的。
     *    如果这里挑了一个买不起的，`resolveEvent` 会返回 false、弹窗永远挂着，
     *    而 `eventTick` 见到 pending 就提前返回 —— 整局只剩最开始那几个事件。
     *    （这个 bug 让 200 小时里只发生了 4 个事件、卡在第一幕，排查了很久。）
     */
    const annual = Math.max(0, R.moneyRate) * SEC_PER_YEAR;   // 与 events.js 的 affordable 同一算法
    const canPay = o => !o.eff || !o.eff.money || o.eff.money >= 0
      || s.resources.money + annual * o.eff.money >= 0;
    const avail = ev.options.map((o, i) => i).filter(i => canPay(ev.options[i]));
    if (!avail.length) { P.stuckOnEvent = ev.id; return; }   // 全部付不起：真卡住，记下来
    let bi = avail[0];
    for (const i of avail) if (i === P.eventChoice(s, ev)) { bi = i; break; }
    resolveEvent(s, bi, R);
    return;
  }

  // ② 退休：到了第八幕、且（建成了地标 或 是「急性子」玩法）→ 关灯看结局
  //    「急性子」玩家：到了第八幕不建永续组织中枢，直接关灯。
  //    这不是 bug，是一种真实存在的玩法 —— 也正好用来验证「未登顶不结束游戏」这条新出口。
  const finalLm = ACTS[8].landmark;
  const readyToRetire = (s.buildings[finalLm] || 0) >= 1 || P.retireEarly;
  if (isFinalAct(s) && readyToRetire && P.decided) {
    P.done = 'retire';                     // 退休判定在 playOnce 尾部用 evaluateRetirement 做
    return;
  }

  /**
   * ③ 幕次推进 + **立即做该幕的三选一抉择**。
   *
   * 真实流程是 `advanceAct()` 之后弹 `renderChoice()`，玩家必须选一条路才能继续
   * （GDD C4：8 次抉择 = 本作两大底层系统之一）。
   * ⚠️ 早先漏掉了这一步，导致 `s.choices` 一直是空的、结局权重只由事件累加 ——
   *    而那会把「一起退休」永远排除掉（它要求三项权重极差 ≤ 3）。
   */
  if (canAdvance(s)) {
    advanceAct(s);
    applyChoice(s, P.route);
    return;
  }

  // ④ 地标买得起就买（**只能买一座** —— 地标是门槛不是产能，重复买纯属浪费）
  //    「急性子」只跳过第八幕那个中枢，1–7 幕的地标照买（否则根本走不到第八幕）
  const lmId = ACTS[s.act].landmark;
  const skipThisLm = P.retireEarly && s.act === 8;
  if (!skipThisLm && (s.buildings[lmId] || 0) === 0 && canAfford(s, lmId)) { purchase(s, lmId, 1); return; }

  // ⑤ 合同（用界面上真实存在的「顾问建议」，不是上帝视角）
  if (P.contracts) {
    const sug = suggestContract(s);
    if (sug) { acceptOffer(s, sug.offerId, sug.quote, R); return; }
    // 报价占着位置又没价值就放弃，避免槽位被垃圾单堵死
    for (const o of s.contracts.offers) {
      if (!hasFreeSlot(s, o.form)) continue;
      const odds = offersWithOdds(s).find(x => x.o.id === o.id);
      if (odds && odds.odds.high < 0.6 && o.ttl < 200) declineOffer(s, o.id);
    }
  }

  // ⑥ 员工：忠诚告急先补，再培训，再晋升。
  //    ⚠️ 加薪额度（salaryAddCap）是全局的 —— 按 STAFF 固定顺序遍历时先到的组把它吃光
  //    （实测 ops/hw/sci 忠诚卡 14 而 dev 顶满）。改成**忠诚最低的组优先**：
  //    现实里的老板也会先安抚最不满的那批人（2026-09-24，302 场景诊断引入）。
  if (P.staff) {
    const ordered = [...STAFF].sort((a, b) => s.staff[a.id].loyalty - s.staff[b.id].loyalty);
    for (const g of ordered) {
      if (headcount(s, g.id) <= 0) continue;
      const st = s.staff[g.id];
      if (st.loyalty < 75 && s.staff.salaryAdd < STAFF_PARAMS.salaryAddCap && actionsFor(s, g.id, R).raise) {
        if (raiseStaff(s, g.id, R)) return;
      }
      if (st.promoted && !st.immune && actionsFor(s, g.id, R).share) {
        if (shareStaff(s, g.id)) return;
      }
      if (actionsFor(s, g.id, R).promote) { if (promoteStaff(s, g.id, R)) return; }
      // 培训：留一点余钱，别把地标的钱花光（真实玩家会犹豫）
      if (st.level < STAFF_PARAMS.levelMax && actionsFor(s, g.id, R).train) {
        const lmCost = costOf(lmId, 0).amount;
        if (s.resources.money > lmCost * 0.35 && trainStaff(s, g.id, R)) return;
      }
    }
  }

  // ⑦ 技能（烧创始人健康的主动操作）
  if (P.skills && s.act >= 2) {
    for (const id of SKILL_IDS) { if (useSkill(s, id)) return; }
  }

  // ⑧ 后 IPO 资本操作已删除（2026-09-24 做减法：回购/分红没有实际决策价值）
  // ⚠️ 第三批：原先这里的「⑧.5 staff40」「⑧.6 front」两个场景旋钮随心结 / 分支结局一起删 ——
  //    它们改的是「玩家在意什么」以凑某一结局的前置（小朱心结要 ≥40 人、tech_ideal 要研究院），
  //    而这两类前置的载体（心结、分支结局）已不存在。

  // ⑨ 买建筑 / 员工养成
  //    `advisor` 代表**「照着界面上那条顾问建议玩」的玩家** —— 那是游戏主动展示给玩家的功能，
  //    所以是完全正当的一种玩法，也是设计上的预期体验。它走完整套流程（推进幕次/事件/合同），
  //    只在「买什么」这一步改用建议值。
  if (P.style === 'advisor') {
    const sug = suggestNext(s, R);
    if (sug && sug.id) applySuggestion(s, sug, R);
    return;
  }
  const b = pick(s, R);
  if (b) purchase(s, b, 1);
}

// ─────────────────────────── 单局 ───────────────────────────

function playOnce(opts) {
  const s = createState();
  s.rngSeed = opts.seed;

  const P = {
    style: opts.style, contracts: !opts.noContract, staff: !opts.noStaff,
    skills: !opts.noSkills, funding: !opts.noFunding,
    route: opts.route || 'tech',
    retireEarly: !!opts.retireEarly,
    decided: false, done: null,
    /**
     * 抉择事件的选项。**这是玩家风格的真正分水岭**：
     *   `maxW`   —— 永远挑作者标记的最优项，权重会一路偏科（影响 `dominantRoute` 驱动的时代偏向与客户门槛）。
     *   `balance`—— 每次都挑「选完之后三项权重最均衡」的那项，代表想走中道路线的玩家。
     * ⚠️ 第三批：权重**不再决定结局**（结局只剩「登顶」），这里保留只是因为它仍是一种真实的玩法风格。
     */
    eventChoice: (st, e) => {
      if (opts.balance) {
        let bi = 0, bestSpread = Infinity;
        e.options.forEach((o, i) => {
          const w = k => st.weights[k] + ((o.eff && o.eff.weight && o.eff.weight.key === k) ? o.eff.weight.d : 0);
          const v = [w('tech'), w('biz'), w('bond')];
          const spread = Math.max(...v) - Math.min(...v);
          // 平手时偏好分高的优先（玩家不是机器人）
          if (spread < bestSpread) { bestSpread = spread; bi = i; }
        });
        return bi;
      }
      let bi = 0, bw = -1;
      e.options.forEach((o, i) => {
        const w = typeof o.w === 'number' ? o.w : 1;
        if (w > bw) { bw = w; bi = i; }
      });
      return bi;
    },
  };

  let seconds = 0;
  let saveAcc = 0;
  const saveErrors = [];
  let actionCount = 0;
  // 逐幕计时：只有真跑一遍才知道玩家实际在第几幕花了多久
  const actLog = [];
  let lastAct = s.act;
  let actStart = 0;

  const cap = HOUR_CAP * 3600;
  while (seconds < cap) {
    const R = rates(s);
    engineTick(s, DT);
    seconds += DT;
    if (s.act !== lastAct) {
      const RR = rates(s);
      actLog.push({
        act: lastAct, dur: seconds - actStart,
        // 乘数分解：用来定位「是哪一层在指数爆炸」
        // ⚠️ 第四批：只剩资金一条产出链，techFactor / relFactor 已删除。
        net: RR.netMoney, moneyMul: RR.moneyMul, effMul: RR.effMul,
        staff: RR.staff,
        bld: Object.values(s.buildings).reduce((a, b) => a + b, 0),
        // 声誉：用来标定「不是钱能买」的幕次门槛
        // ⚠️ 第三批：信任 / 默契随关系机制整块删除，这一栏只剩声誉。
        rep: s.resources.rep || 0,
      });
      actStart = seconds; lastAct = s.act;
    }

    // 存档往返：存不下来的状态，现实里重开就丢
    saveAcc += DT;
    if (saveAcc >= SAVE_EVERY) {
      saveAcc = 0;
      try {
        const back = deserialize(serialize(s));
        if (back.resources.money !== s.resources.money) saveErrors.push('money 往返不一致');
        if (back.act !== s.act) saveErrors.push('act 往返不一致');
        s.savedAt = back.savedAt;
      } catch (e) { saveErrors.push(`存档抛异常：${e.message}`); }
    }

    // 玩家操作（每 THINK 秒一次）
    if (seconds % THINK === 0) {
      think(s, R, P);
      actionCount++;
      if (P.done === 'retire') break;
      if (P.done) break;
      // 第一幕结束后开始「决策」
      if (s.act >= 2) P.decided = true;
    }
  }

  // 走结局判定（真跑到的状态）
  // ⚠️ 第三批：判据源是 `s.worldRank`（world.js 每 tick 维护）—— `evaluateRetirement` 返回
  //    `{ ending: 'top'|null, rank }`。`ending === null` 表示**未登顶**：不是失败，游戏不结束。
  const lmId = ACTS[8].landmark;
  const builtPerp = (s.buildings[lmId] || 0) >= 1;
  const result = P.done === 'retire' ? evaluateRetirement(s) : null;
  // 「未登顶就关灯」是一种**预期内**的出口（急性子玩法），给它一个独立的状态名，
  // 好让汇总能把「没走到的局」与「走到了但没登顶的局」分开，不会混成一个 ❌。
  const ended = P.done === 'retire'
    ? (result.ending || 'not-top')
    : (P.done || (builtPerp ? 'perp-built-but-not-retired' : 'timeout'));

  actLog.push({ act: lastAct, dur: seconds - actStart, net: rates(s).netMoney, bld: Object.values(s.buildings).reduce((a, b) => a + b, 0) });

  return {
    s, P, seconds, result, saveErrors, actionCount, builtPerp, actLog, ended,
  };
}

// ─────────────────────────── 报告 ───────────────────────────

const fmtH = sec => (sec / 3600).toFixed(1) + 'h';

function run(label, opts) {
  const t0 = Date.now();
  const r = playOnce(opts);
  const ms = Date.now() - t0;
  const end = r.result ? (r.result.ending || 'not-top') : r.ended;
  const name = r.result ? (r.result.ending ? endingName(r.result.ending) : '未登顶') : r.ended;
  return {
    label, opts, ...r, end, name, ms,
    hours: r.seconds / 3600,
    events: r.s.events.count,
    contracts: r.s.contracts.done,
  };
}

function printRun(r, verbose) {
  // ✅ 登顶 ｜ 🟡 走到关灯但未登顶（合法出口，游戏继续）｜ ❌ 没走到关灯
  const mark = r.result ? (r.result.ending ? '✅' : '🟡') : '❌';
  const bits = [
    `${mark} ${r.label.padEnd(30)}`,
    `结局=「${r.name}」`.padEnd(22),
    `${fmtH(r.seconds)}`.padStart(7),
    `事件 ${String(r.events).padStart(4)} ｜ 合同 ${String(r.contracts).padStart(4)} ｜ 世界排名 ${r.s.worldRank ?? 'null'}`,
    `｜ 操作 ${r.actionCount}`,
    `｜ ${(r.ms / 1000).toFixed(1)}s`,
  ];
  console.log('  ' + bits.join(' '));
  if (r.saveErrors.length) console.log('      ⚠️ 存档问题：' + [...new Set(r.saveErrors)].join('、'));
  if (verbose) {
    console.log('      逐幕：' + r.actLog.map(a => `${a.act}幕 ${fmtH(a.dur)}`).join(' ｜ '));
    // 声誉曲线 → 定位「哪一幕的声誉门槛在拖后腿」
    // ⚠️ 第三批：信任 / 默契随关系机制整块删除，这一块只剩声誉。
    if (r.actLog.some(a => a.rep !== undefined)) {
      console.log('      ── 声誉（幕末，用于标定幕次门槛）──');
      for (const a of r.actLog) {
        if (a.rep === undefined) continue;
        console.log(`      ${a.act}幕末：声誉 ${Math.round(a.rep)}`);
      }
    }
    // 乘数分解 → 定位「哪一层在指数爆炸」
    if (r.actLog.some(a => a.moneyMul !== undefined)) {
      console.log('      ── 乘数分解（幕末）──');
      console.log('      幕   资金/秒        建筑   moneyMul  effMul   dev  sales  ops   hw   sci');
      for (const a of r.actLog) {
        if (a.moneyMul === undefined) continue;
        const st = a.staff || {};
        console.log(`      ${a.act}  ${a.net.toExponential(2).padStart(10)}  ${String(a.bld).padStart(5)}`
          + `  ${a.moneyMul.toFixed(1).padStart(8)}  ${a.effMul.toFixed(1).padStart(6)}`
          + `  ${(st.dev || 1).toFixed(2)}  ${(st.sales || 1).toFixed(2)}  ${(st.ops || 1).toFixed(2)}`
          + `  ${(st.hw || 1).toFixed(2)}  ${(st.sci || 1).toFixed(2)}`);
      }
    }
  }
  if (verbose && r.result) {
    const s = r.s;
    console.log(`      最终：持股 ${(s.equity * 100).toFixed(1)}% ｜ 世界排名 ${s.worldRank ?? 'null'} ｜ 市值折算 ${r.result.rank === 1 ? '第 1 名' : '未登顶'}`);
    console.log(`      员工总数 ${STAFF.reduce((a, g) => a + headcount(s, g.id), 0)} ｜ 等级 ${STAFF.map(g => g.id + ':' + s.staff[g.id].level).join(' ')}`);
    console.log(`      权重 ${JSON.stringify(s.weights)} ｜ 极差 ${Math.max(s.weights.tech, s.weights.biz, s.weights.bond) - Math.min(s.weights.tech, s.weights.biz, s.weights.bond)}（第三批起不再决定结局）`);
  }
}

// ─────────────────────────── 主流程 ───────────────────────────
/**
 * 主流程包在 CLI 守卫里：`run` / `printRun` 可以被别的工具 import 复用，
 * 直接执行本文件时才跑玩法分组。
 */
import { pathToFileURL } from 'node:url';
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

export { run, printRun };

if (isMain) {

console.log('');
console.log('  ╔══════════════════════════════════════════════════════════════════════════════╗');
console.log('  ║  真实模拟（playthrough）：dt=1s ｜ 玩家不做前瞻 ｜ 每 5 分钟走一遍存档往返  ║');
console.log('  ╚══════════════════════════════════════════════════════════════════════════════╝');
console.log('');

const results = [];
const push = (label, o) => { const r = run(label, o); results.push(r); printRun(r, flag('verbose')); return r; };

if (flag('all')) {
  console.log('  ── 玩法 1：三条路线 × 两种抉择风格（同一份代码，只有「怎么选」不同）──');
  // 偏科玩家：永远挑作者标记的最优项 → 权重一路偏科（时代偏向与客户门槛会跟着变）
  for (const route of ['tech', 'biz', 'bond']) {
    push(`${route} 偏科/greedy`, { route, style: 'greedy', seed: 20260809 });
  }
  // 平衡玩家：每次都挑「选完权重最均衡」的项
  for (const route of ['tech', 'biz', 'bond']) {
    push(`${route} 平衡/balance`, { route, style: 'greedy', seed: 20260809, balance: true });
  }
  console.log('');
  console.log('  ── 玩法 2：两种买法（同一条路线）──');
  push('平衡玩家/乱买便宜货', { style: 'cheap', seed: 20260809, balance: true });
  console.log('');
  console.log('  ── 玩法 3：刻意放弃某个系统（可达性反证）──');
  push('平衡 + 不接合同', { style: 'greedy', seed: 20260809, noContract: true, balance: true });
  push('平衡 + 不用技能', { style: 'greedy', seed: 20260809, noSkills: true, balance: true });
  console.log('');
  console.log('  ── 玩法 4：「急性子」玩家（第八幕不建中枢，直接关灯）──');
  // ⚠️ 第三批：这一组本意是验证「未登顶」这条出口（关灯那一刻名次 > 1 ⇒ 只弹提示、
  //    **游戏不结束**，`ended === 'not-top'`，而不是被判成失败）。
  //    实测：三个路线在第 8 幕开局时市值都已是世界第一 ⇒ 也判「登顶」。
  //    所以「未登顶」目前只由 `probes` 的构造状态断言覆盖，不靠这一组。
  // ⚠️ 种子是标定值：同种子在不同 route 配置下会走到不同细节，这是正常的 —— route 才是分岔。
  for (const route of ['tech', 'biz', 'bond']) {
    push(`急退/${route}`, { route, style: 'greedy', seed: 20260809, retireEarly: true, balance: true });
  }
  console.log('');
} else {
  // 单跑
  const route = arg('route', 'tech');
  const style = arg('style', 'greedy');
  push(`${route}/${style}`, {
    route, style, seed: Number(arg('seed', 20260809)),
    noContract: flag('no-contract'), noStaff: flag('no-staff'),
    balance: flag('balance'),
    noSkills: flag('no-skills'),
    retireEarly: flag('retire-early'),
  });
}

// ── 汇总：唯一结局「登顶」**真的跑到了**吗 ──
console.log('');
console.log('  ══ 可达性（唯一结局「登顶」）══');
const reached = new Map();
for (const r of results) {
  // 只统计**真结局**：`timeout` / `perp-built-but-not-retired` / `not-top` 这类「没登顶」的状态
  // 不该混进 reached —— 否则分母会变成「4/1」这种鬼数字
  if (!r.result || !r.result.ending || reached.has(r.end)) continue;
  reached.set(r.end, r);
}

const ALL_ENDINGS = ['top'];
let unreachable = 0;
for (const e of ALL_ENDINGS) {
  const r = reached.get(e);
  if (r) {
    console.log(`  ✅ ${('「' + endingName(e) + '」').padEnd(14)} 真实跑到 —— ${r.label}（${fmtH(r.seconds)}）`);
  } else {
    unreachable++;
    console.log(`  ❌ ${('「' + endingName(e) + '」').padEnd(14)} **本次全部玩法都没走到**`);
  }
}
console.log('');

// 「关灯时没登顶」**不是失败**：第三批起游戏不结束，UI 只弹「继续经营」。
// 这一组是这条新出口的实测证据（没有它，`not-top` 就只是文档里的一句话）。
const notTop = results.filter(r => r.ended === 'not-top');
if (notTop.length) {
  console.log('  🟡 关灯但未登顶（合法出口，游戏继续）：');
  for (const r of notTop) console.log(`     ${r.label}（${fmtH(r.seconds)}）｜ 关灯时世界排名 ${r.s.worldRank ?? 'null'}`);
  console.log('');
}

// ── 真实运行才暴露的问题 ──
const stuck = results.filter(r => !r.result);
if (stuck.length) {
  console.log('  ⚠️ 未能走到关灯的玩法（诊断）：');
  for (const r of stuck) {
    const s = r.s;
    console.log(`     ${r.label}：${r.ended}（${fmtH(r.seconds)}）`);
    console.log(`       卡在：第 ${s.act}/8 幕 ｜ 地标=${ACTS[s.act].landmark}（持有 ${s.buildings[ACTS[s.act].landmark] || 0}）｜ canAdvance=${canAdvance(s)}`);
    console.log(`       玩家已进入决策态=${r.P.decided} ｜ P.done=${r.P.done}`);
    console.log(`       资金=${(s.resources.money / 1e4).toFixed(1)}万 ｜ 净收入/秒=${rates(s).netMoney.toExponential(2)}`);
  }
  console.log('');
}
const saveIssues = results.filter(r => r.saveErrors.length);
console.log(`  存档往返：${saveIssues.length ? '❌ ' + saveIssues.length + ' 局有问题' : '✅ 全部一致'}`);
console.log(`  可达性：${reached.size}/${ALL_ENDINGS.length}（唯一结局「登顶」）${unreachable ? ' ❌ 本次没走到' : ' ✅ 真实跑到'}`);
console.log('');
console.log('BRIEF ' + JSON.stringify({
  runs: results.length,
  reached: [...reached.keys()],
  unreachable: ALL_ENDINGS.filter(e => !reached.has(e)),
  notTop: notTop.length,
  ended: results.map(r => `${r.label}=${r.end}(${fmtH(r.seconds)})`),
}));
console.log('');

}
