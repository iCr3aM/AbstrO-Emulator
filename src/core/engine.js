/**
 * 引擎（GDD §1.5 / §1.6 / §1.7）
 * ===============================================================
 * 一个 tick 只做七件事，顺序不能换：
 *   ① 生产（净收入入账）→ ② 自动购买（买「等级最低」那条线）→ ③ 重算
 *   → ④ 进度钟（日历 = 阶段内市值进度）→ ⑤ 融资 → ⑥ 订单 → ⑦ 世界榜 / 推幕 / 年度报告
 *
 * ⚠️ 年度决策**并在这里**（GDD §3.2 明确：不新建文件）。它是全作唯一的抉择层：
 *   在线不弹窗，主界面只显示待决角标；积压上限 `PENDING_CAP` 条，第 4 条起按默认选项自动结算。
 *
 * ⚠️ 全作**零 `Math.random()`** —— 事件按序轮转抽取，所以同一份存档永远走到同一个未来，
 *   无头工具才可能断言。
 */

import {
  ACTS, PENDING_CAP, autoBuyReserveOf, MANUAL_GAIN, MANUAL_PAY, MILESTONES,
  AUTO_DECIDE_STAGE, SPRINT_STAGE, DIL_MIN, DIL_AT, SAVOR_RATE,
  SAVOR_MONTHS_PER_MIN, SAVOR_END_MONTH, SAVOR_MKT_LINES, SAVOR_US_LINES,
  CYCLE_MONTHS, CYCLE_RISE, CYCLE_CRASH,
  eventsFor, eventById, companyName, RENAME_LINES,
} from './content.js';
import { rates, derived, purchase, lowestLine, costFor, spendableOf } from './economy.js';
import { financeTick } from './finance.js';
import { ordersTick } from './orders.js';
import { worldTick, ranking, cycleNotes } from './world.js';
import { calMonthOf, gameYear, gameMonths, fmt } from './format.js';

/**
 * 日志保留条数（存档里只留最后 40 条，见 `state.serialize`）。
 *
 * ⚠️ 60 → 120（用户 2026-09-27「日志又出现刷屏」）：一局全程约 176 行，
 *    而 8× 倍速下这 176 行只占 **40 分钟真实时间**（一局一共就这么长），
 *    60 条 ≈ 13 分钟的历史 —— 翻两下就到底了，观感就是「一直在刷」。
 *    真正压掉条数的是 `orders.js` 的**窗口归并**（订单占全程 45%，见那里），
 *    这里只是把「能回看多久」翻一倍。
 */
export const LOG_MAX = 120;
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

// ─────────────────────────── 自动购买与手动购买（§1.6）───────────────────────────
/**
 * 每 tick 买一条线 —— 这是游戏**真正的引擎**，玩家不在它也一直转。
 * 买**等级最低的那条**：所有线共用 `cost(n)` ⇒ 均衡时「等级最低 = 最便宜」，
 * 均衡由公式自动维持，玩家不需要算（GDD §1.6）。
 *
 * 门槛是 `K × cost` 而不是 `cost`：自动要留 K−1 份储备才动手，
 * 于是**每个购买周期里约 `(K−1)/K` 的时间钱是够手动买的**。
 * 没有这个储备，钱会在同一个 tick 里被买光，手动按钮永远点不动。
 *
 * ⚠️ `K` 是**两档**的（用户 2026-09-27）：**融资前**用 `AUTO_BUY_RESERVE_EARLY`（= 6），
 *    天使轮到账后回到 `AUTO_BUY_RESERVE`（= 2）。融资前那一段，自动的窗口被压得很小
 *    —— 玩家一动手就把它挤出去，所以**那一段实际上是玩家自己点的**（这正是用户要的
 *    「公司和创始人在做融资之前都只能玩家自己点击」）。注意它**不改变挂机的稳态速率**
 *    （两次购买之间永远隔一个 `cost` 的时间），所以挂机玩家照样能通关（见 content.js）。
 */
function autoBuy(s) {
  let n = 0;
  let id = lowestLine(s);
  const K = autoBuyReserveOf(s);
  /**
   * ⚠️ 门槛是「**可动用现金**（现金 × (1 − 储备比例)）≥ `K × cost`」，
   *    而不是现金本身 —— 储备金是账上不能动的那笔钱（见 `content.RESERVE_FRAC`）。
   */
  while (n < AUTO_BUY_MAX && spendableOf(s) >= K * costFor(s, id)) {
    purchase(s, id, 1);
    id = lowestLine(s);
    n += 1;
  }
}

/**
 * 手动购买 —— **唯一入口**（按钮与无头工具都走这里）。
 * 与 `autoBuy` 共用同一个 `purchase()`，差别只有两点：**由玩家指定哪条线**、
 * **一次 `MANUAL_GAIN` 级**。这就是「自动是打折版、手动是满配」。
 * @returns {boolean} 是否买成
 */
export function manualBuy(s, id) {
  return purchase(s, id, MANUAL_GAIN, MANUAL_PAY);
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
    /**
     * ⚠️ 只写「选了什么」，**不写事件标题**（2026-09-27）。
     *    原来是 `【决策】<标题> → <选项>`，最长一条实测 60 单位 ≈ 420px —— 手机日志栏
     *    只有 366px，注定折行。而标题是**提问**、选项是**答案**，日志记的是答案；
     *    提问当时就在「公司」页的待决卡片上（`render.pendingCard`），再抄一遍是冗余。
     */
    s.log.push(`【决策】${opt.text}`);
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
  /**
   * 日志里的年份写**日历的 20xx 年**（用户 2026-09-27），不写「第 N 年」——
   * `gameYear` 是 1 起的叙事年序（第 1 年 = 2026），所以实际年份是 `2026 + y − 1`。
   * 它是「本年报发布时」的日历年份，与顶部的 HUD 日期同源（都是市值进度钟的派生量）。
   */
  const tag = `【${2026 + y - 1} 年】`;

  /**
   * ⚠️ 年份行**不再写「待决 N 条」/「无待决」**（用户 2026-09-28：「可以删除日志《【2026 年】
   *    待决 1 条》的显示」）。那半句与「公司」页那张待决卡片（`render.pendingCard`）
   *    说的是同一件事，而卡片是**当下**、永远比日志新；写在日志里只是把同一屏的同一件事说两遍。
   *    下面两条分支因此只在**界面看不见**的时候才落一行（见各自的注释）。
   */
  const ev = drawEvent(s);
  if (!ev) return;

  /**
   * 第 `AUTO_DECIDE_STAGE` 幕起**不再交给玩家**（GDD §1.5「前期玩家操作、后期自动化」）：
   * 那时公司已经大到三个人管不过来，年度事件由团队按**保守项**自行处理，不进待决队列。
   * 玩家剩下的动作只有点投资线（§1.6）。
   */
  if (s.stage >= AUTO_DECIDE_STAGE) {
    const opt = ev.options[ev.default];
    applyEffect(s, opt.eff, R);
    s.autoDecided += 1;
    // 同上：只留「答案」。`【20xx 年】` 这个标签本身已经说明「这一年做了一次决策」。
    s.log.push(`${tag}${opt.text}`);
    return;
  }

  s.pending.push({ uid: ++s.uidSeq, id: ev.id });
  // 积压上限：第 4 条起按默认选项自动结算（在线、离线同一条规则）
  const spilled = s.pending.length > PENDING_CAP ? resolveByDefault(s, s.pending.length - PENDING_CAP, R) : 0;
  /**
   * ⚠️ **只在积压溢出时落一行**：`另有 N 条已按默认处理` 是**界面看不见**的事实
   *    （被跳过的那些决策，卡片上只剩结果），不说就是静默改数。没溢出就一行都不写 ——
   *    这一年的待决情况卡片上有，日志里再说一遍是冗余（本次修订的起因）。
   */
  if (spilled) s.log.push(`${tag}另有 ${spilled} 条已按默认处理`);
}

// ─────────────────────────── 推幕与目标 ───────────────────────────
/**
 * 阶段目标是否达成（**只用于 HUD 高亮那格**，不额外加闸）。
 * 八条与 `ACTS[].goal` 的文案一一对应，阈值全部实测反推 ⇒ **每条都在本幕之内被跨过**
 * （推演与理由见 `content.js` 的 `ACTS` 注释）。
 *
 * 八章里三类判据各司其职：
 *   · 产品/团队/营收（第 1/2/3 章）—— 用 `rates()` 的派生量，读者一眼能懂；
 *   · 市值刻度（第 5 章）—— 直接用 `D.marketCap ≥ 4e10`（约 400 亿元 ≈ $56 亿）；
 *   · 融资轮（第 4/6/7 章）—— 看 `finance.rounds`，与 `finance.js` 的年份表同源；
 *   · 第 8 章「登顶」—— 看 `s.worldRank`，与唯一结局共用同一个判据。
 *
 * ⚠️ 第 2/3/5 章的阈值必须同时满足「**高于本章入场值**」和「**低于本章末值**」——
 *    八章的市值阶梯一变（`npm run tune` 会重排），这三个数就要跟着复核。
 *    阈值一律取**幕中实测值**（见 `tools/.tmp-bal.mjs` 的量法），落点约在本章 50% 处。
 *    ⚠️ 五条线制下 `g = r^(1/5) = 1.0247`（旧三条线制是 `r^(1/3) = 1.0416`），
 *    同一个效果数字对应的等级**高了一截** —— 三线制下的老阈值（team ≥ 2.5、cap ≥ 2e11）
 *    在新阶梯上**整章都够不着**，必须按幕中实测重设。
 */
export function stageGoalMet(s, R, D) {
  const rounds = (s.finance && s.finance.rounds) || [];
  switch (s.stage) {
    case 1: return R.prod >= 1.13;              // 做出原型：产品力第一次被买起来（幕中 1.138）
    case 2: return R.team >= 1.60;              // PMF：团队效率把交付扛住（幕中 1.615）
    case 3: return R.revenue >= 3e7;            // 千万级大订单：年营收站上 3000 万（幕中 3.04e7）
    case 4: return rounds.includes('a');        // 完成 A 轮融资
    case 5: return D.marketCap >= 4e10;         // 估值破四百亿元（幕中 4.38e10）
    case 6: return rounds.includes('preIpo');   // 完成 Pre-IPO 轮
    case 7: return rounds.includes('ipo');      // IPO 敲钟
    case 8: return s.worldRank === 1;           // 登顶世界第一
    default: return false;
  }
}

/**
 * 叙事里程碑（`content.MILESTONES`）：跨过阈值的那一刻**只记一条日志**，不加机械效果。
 * 去重靠 `s.mcapMilestones`（存的是下标，不是浮点阈值 —— 存浮点迟早会因为精度对不上）。
 */
function logMilestones(s, D) {
  if (!s.mcapMilestones) s.mcapMilestones = [];
  for (let i = 0; i < MILESTONES.length; i++) {
    if (D.marketCap >= MILESTONES[i].v && !s.mcapMilestones.includes(i)) {
      s.mcapMilestones.push(i);
      s.log.push(MILESTONES[i].text);
    }
  }
}

/** 唯一的机械闸门：`市值 ≥ 本阶段 mcap` ⇒ 自动进入下一阶段（不弹窗、不给偏置） */
function advanceStage(s, D) {
  const last = ACTS.length - 1;
  if (s.stage >= last) return false;
  if (!(D.marketCap >= ACTS[s.stage].mcap)) return false;
  s.stage += 1;
  const a = ACTS[s.stage];
  /**
   * 推幕那一行 = **年份 + 地名 + 一句专属开场**，例：`2030年【车库】借来的车库，租金按天算。`
   *
   * 2026-09-27 之前八幕共用一个模板 `【place】years 起 · 目标：goal`，
   * 八句除了地名完全一样（用户：「八章开场白同模板可丰富」）。现在文案在 `ACTS[].open`，
   * 这里只负责拼装；`goal` 不再进流水（HUD 的「本阶段目标」格已经在显示它）。
   *
   * ⚠️ 年份取 `years` 的**前四位**（`'2030–2034'` → `2030`）—— 段落表里只有起点年份有意义，
   *    终点年份就是下一幕的起点，写出来只是把同一件事说两遍。
   * ⚠️ `【place】` 不出现在行首（前面多了 `2030年`），所以 `render.js` 的 `logClass()` 必须
   *    先摘掉这个年份前缀再认标签，否则推幕行会掉回兜底色（`.li.act` 丢色）。
   */
  s.log.push(`${a.years.slice(0, 4)}年【${a.place}】${a.open}`);
  /**
   * **更名**（用户 2026-09-28：「更名要有日志叙事」）—— 名字按**章**查表
   * （`content.NAME_TIERS`，五段阶梯 2+2+2+1+1），所以改名点天然就是**换幕**：
   * 相邻两章同名（1↔2、3↔4、5↔6）时一个字都不推，一局恰好四次
   * （第 3 / 5 / 7 / 8 章各一次）。
   * ⚠️ 紧跟在推幕行之后：那一行说「到了哪一幕」，这一行说「公司现在叫什么」——
   *    两句挨着读才连得上。
   * ⚠️ 文案来自 `RENAME_LINES`，**只写新名字**（旧版两个名字都写，2026-09-27 因超宽被收短过）。
   */
  const next = companyName(s.stage);
  if (next !== companyName(s.stage - 1)) s.log.push(RENAME_LINES[next]);
  return true;
}

// ─────────────────────────── 决胜段减速 ───────────────────────────
/**
 * 决胜段减速因子 —— 乘在 `s.speed` **之外**（见 `content.DIL_MIN` 的整段推演）。
 * `worldBest` 越小越慢：`DIL_AT` 名开外 = 1（不减速），第 1 名 = `DIL_MIN`（最慢）。
 *
 * ⚠️ 键取**名次**而不是「与榜首的差距」：差距每月都在变（世界榜有月度噪声），
 *    速度会跟着抖；名次是**单调只减不增**的量，玩家体感是「越往上越沉」。
 * ⚠️ 它是纯函数、不写状态 ⇒ 存档/读档/无头工具三处结果一致。
 * @returns {number} ∈ [DIL_MIN, 1]
 */
export function dilate(s) {
  const b = s.worldBest ?? Infinity;
  const w = Math.max(0, Math.min(1, (DIL_AT + 1 - b) / DIL_AT));   // 10 名 → 0.1；1 名 → 1
  return 1 - (1 - DIL_MIN) * w;
}

// ─────────────────────────── 冲刺段（锁操作）───────────────────────────
/**
 * 是否已进入**冲刺段**（用户 2026-09-28：「登顶前无法操作，但是能选择加速」）。
 *
 * 判据是**章节**（`SPRINT_STAGE = 8`），不是 `dilate < 1`、也不是 `s.ending`：
 *   · `dilate < 1` 从第 5 名（实测月 431）就开始，那时玩家还在第 8 章里点投资线；
 *   · `s.ending` 是**登顶之后**（回味期），那时早就不许操作了。
 *
 * ⚠️ 它只被两个消费者用：`main.js` 的 handler（决定**玩家的动作**要不要执行）
 *    与 `render.js`（把正文钉在市值榜上、提示文案）。`tick` **不看它** ——
 *    锁的是玩家的手，不是模拟本身（无头工具照旧跑满）。纯函数、不写状态。
 */
export const isSprint = s => (s.stage || 1) >= SPRINT_STAGE;

// ─────────────────────────── 回味期的月度市场快讯 ───────────────────────────
/**
 * 每跨一个游戏月落**一条**市场快讯（第九批 §5）—— 这是回味期日志栏里唯一的内容。
 *
 * 四类**按优先级**：①②（黑天鹅 / 大盘·特殊）直接复用 `world.js` 的池子 ——
 * `cycleNotes(m − 1, m, w)` 恰好给出「第 m 月」那一条，命中就用它；没命中就从
 * ③④（大盘·常规 / 我们）里按月轮转。于是 240 个月的回味期**月月有文案**，
 * 而且不会出现「同一个月两条」。
 *
 * ⚠️ 只在 `engine.tick` 的回味分支调用：`worldTick` 那边已经关掉了 `cycleNotes`
 *    （见那里的注释），两边不会打架。
 */
function savorNews(s, fromMonth, toMonth) {
  const mTo = Math.floor(toMonth);
  for (let m = Math.floor(fromMonth) + 1; m <= mTo; m++) {
    const special = cycleNotes(m - 1, m, s.world);
    const line = special.length ? special[0] : savorRegular(m, s);
    if (line) s.log.push(line);
  }
}

/**
 * ③④ 按月轮转 —— 每月恰好占一类，相邻月不重类。
 * ⚠️ `%3` → `%2`：第 ⑤ 类「对手」已删（用户 2026-09-28），双类轮转。
 */
function savorRegular(m, s) {
  const cls = ((m % 2) + 2) % 2;
  return cls === 0 ? marketLine(m) : usLine(m, s);
}

/**
 * ③ 大盘·常规：按**当月水位与斜率**说 —— 六个档与 `cycleAt` 的锯齿四段严格对齐
 * （缓涨 u<57 / 见顶 u=57 / 崩盘 58~59 / 缓跌 60~116 / 低谷 u=117 / 回暖 118~119）。
 */
function marketLine(m) {
  const pool = SAVOR_MKT_LINES[marketPhase(m)];
  return pool[m % pool.length];
}

/**
 * ④ 我们：说自己的市值与「比第二名高多少」。
 * 涨 / 跌看**上一个月**的环比（`s.worldPrevCap` 由 `worldTick` 在跨月那一刻快照）。
 */
function usLine(m, s) {
  const cur = s.worldCap || 0;
  const prev = s.worldPrevCap != null ? s.worldPrevCap : cur;
  const rival = ranking(s.world, cur, 2, prev).all.find(c => !c.me);
  if (!rival) return null;
  const mom = prev > 0 ? (cur / prev - 1) : 0;
  const p = Math.abs(Math.round(mom * 100));
  if (marketPhase(m) === 'crash') return SAVOR_US_LINES.crash(fmt(s.savorCap || 0), p);
  /**
   * ⚠️ 跌幅**不足 0.5%** 时 `p` 会取整成 0，「本月跌 0%」是自相矛盾的一句 ——
   *    用户 2026-09-28 正是因为「对手经常本月涨 0%」把对手那一类整个删掉了。
   *    玩家这一类保留，但这种情况改成一句**不报数字**的话（长度也短，不会顶破 46 单位）。
   */
  if (mom < 0) {
    return p > 0
      ? SAVOR_US_LINES.down(fmt(s.savorCap || 0), p)
      : `【我们】市值 ${fmt(s.savorCap || 0)}，本月几乎持平。`;
  }
  const higher = rival.cur > 0 ? Math.round((cur / rival.cur - 1) * 100) : 0;
  return SAVOR_US_LINES.up(fmt(s.savorCap || 0), higher);
}

/** 当月处在 `cycleAt` 锯齿的哪一段 —— ③ 与 ④ 共用同一套判据 */
function marketPhase(m) {
  const u = ((m % CYCLE_MONTHS) + CYCLE_MONTHS) % CYCLE_MONTHS;
  if (u === CYCLE_RISE) return 'top';
  if (u < CYCLE_RISE) return 'rise';
  if (u < CYCLE_RISE + CYCLE_CRASH) return 'crash';
  if (u === CYCLE_MONTHS - CYCLE_CRASH) return 'trough';
  if (u < CYCLE_MONTHS - CYCLE_CRASH) return 'dip';
  return 'rebound';
}

// ─────────────────────────── tick ───────────────────────────
/**
 * @param {object} s   状态
 * @param {number} dtReal 本步的**真实**秒（倍速在内部放大；`s.elapsed` 只记真实秒）
 * @param {boolean} live 这一步是不是**真实会话**（`createLoop` 才有资格传 true）
 *
 * ### 登顶之后：慢放，还是定格？（用户 2026-09-28）
 * 登顶不再立刻定格 —— 时间是慢放到近乎停住，但 HUD 上那几个数字一直跳，直到玩家自己点「退休」。
 * 但**只有真实会话**有资格这样跑。另外两个调用方必须继续定格：
 *   · `offlineRun`（离线结算）—— 不然读档回来会发现数字被离线推进过；
 *   · 无头工具（`check` / `probe` / `tune`）—— 它们没有「玩家点退休」这个终止条件，会一直跑到超时。
 * 所以判定条件是 `s.ending && !live`，而 `live` **只有 `createLoop` 会传**（它只被 `main.js` 用）。
 * ⚠️ 用参数而不是新增 `s.mode` 字段：状态字段会被存档，而「是不是真实会话」是**这一次运行**的
 *    性质，不是这一局的性质 —— 存下来只会在读档后留一个撒谎的标记。
 */
export function tick(s, dtReal = 0.1, live = false) {
  /**
   * 定格（GDD §1.7）：时间冻结，生产 / 购买 / 日历 / 融资 / 世界榜全部暂停，玩家只剩回看。
   * 放在最前面 —— 只有这一个出口才可能把「暂停」漏掉半件事。
   */
  if (s.ending && !live) return { R: rates(s), D: derived(s) };

  /**
   * 回味期跑到头：日历封顶 `SAVOR_END_MONTH`（2086-08）后**彻底静止**。
   *
   * 起点是登顶那月的 480，回味期 12 游戏月 / 真实分钟 ⇒ 最多再看 20 真实分钟就停。
   * 此后日期、经营、世界榜一起定住 —— 这就是「挂机一整个月会怎么样」的答案：
   * **什么也不会发生**（后台标签页的 rAF 本就不跑；即便一直盯着，20 分钟后也到这个出口）。
   *
   * ⚠️ **但 `savorCap` 必须在这里补算一次**：它是**派生缓存、不入存档**（见 `state.serialize`），
   *    而下面两个出口都不再调 `worldTick`（它是唯一的写入点）⇒ 封顶后的存档读回来时它恒为 0，
   *    `derived()` 于是退回**未锚定的** `marketCapBase × valAt`（实测 118 T → 259 T）**且永不自愈**
   *    —— 每一帧都在第一行就返回，再也不会有人写它。所以：还是 0 就把世界这一趟补上
   *    （此时它什么也不推进，只写这一个数），之后每帧都只是读。
   */
  if (s.ending && s.calMonth >= SAVOR_END_MONTH) {
    if (!(s.savorCap > 0)) worldTick(s, rates(s));
    return { R: rates(s), D: derived(s) };
  }

  /**
   * 真实秒 → 游戏秒：
   *   · 回味期（登顶后的真实会话）：`SAVOR_RATE` —— **忽略 `s.speed` 与 `dilate`**，
   *     否则玩家登顶时停在 8× 的话，回味期会变成 4×，与「特别慢」正相反；
   *   · 正常段：倍速 × **决胜段减速**（`dilate` 乘在 `s.speed` 之外 ⇒ 玩家关不掉）。
   * `s.elapsed` 仍只记真实秒（缩放的是游戏进程，不是这局玩了多久）。
   */
  const dt = s.ending
    ? dtReal * SAVOR_RATE
    : dtReal * (s.speed || 1) * dilate(s);

  // ① 生产
  let R = rates(s);
  s.money += R.netPerSec * dt;
  s.elapsed += dtReal;

  // ② 自动购买（默认开启、无开关）
  autoBuy(s);

  // ③ 重算
  R = rates(s);
  const D = derived(s, R);

  /**
   * ── 回味期（第九批 · 登顶后）──
   * 日历改由**真实秒**驱动：1 真实分钟 = `SAVOR_MONTHS_PER_MIN` 游戏月（= 1 游戏年），
   * 封顶 `SAVOR_END_MONTH`（2086-08）。
   * ⛔ **不再走 `calMonthOf`**：它是「市值进度钟」（市值 → 月），而回味期的市值锚在世界榜上、
   *    又由真实时间推进 —— 继续用它，日历会随真实时间**指数级**飙（实测挂 3 小时 +75 个月）。
   */
  if (s.ending) {
    const from = s.calMonth;
    s.calMonth = Math.min(SAVOR_END_MONTH, s.calMonth + (dtReal * SAVOR_MONTHS_PER_MIN) / 60);

    /**
     * 经营**照旧跑**（生产已在上面的 ①、自动购买在 ②；融资与订单在这里）——
     * 「像正常公司一样发展，只是玩家不能再操作」（用户 2026-09-28）。
     * 唯一要做的是**静音非市场日志**：年度报告（`【20xx 年】` 与年度决策）、订单文案、
     * 名次播报与决胜回执在回味期都是与市值榜无关的噪声，日志栏只留市场快讯。
     * 手法：临时把 `s.log.push` 换成丢弃版 —— 只在这一次调用里生效，退出前原样还回去。
     *
     * ⚠️ **叙事里程碑不在静音之列**（2026-09-28 拓展）：它读 `D.marketCap`，而回味期的市值锚
     *    是 `worldTick` 刚写下的 `s.savorCap` ⇒ 必须排在 `worldTick` **之后**、且在静音之外。
     *    排在静音里等于把新补的九条（30~110 万亿）全吞掉；排在 `worldTick` 之前则要等下一帧。
     */
    const keepPush = s.log.push;
    s.log.push = () => s.log.length;                 // 静音：下面四个都照跑，只是一个字不落
    financeTick(s, R, D);
    ordersTick(s, R);
    worldTick(s, R);
    annualReport(s, R, D);
    s.log.push = keepPush;

    logMilestones(s, D);                             // 会让出静音，见上
    savorNews(s, from, s.calMonth);                  // 每月一条，四类按优先级

    if (s.log.length > LOG_MAX) s.log.splice(0, s.log.length - LOG_MAX);
    return { R, D };
  }

  // ④ 进度钟：日历 = 市值在对数轴上的位置（玩得快，时间就走得快）
  //    ⚠️ `calMonthOf` 内部取的是 `D.marketCapBase`（**不含估值周期**）——
  //    估值会让市值跌，而日期永远不许倒退（用户 2026-09-27 的宏观周期，见 economy.derived）
  s.calMonth = calMonthOf(s, D);

  // ⑤ 融资（按日历年到点；IPO 看市值）
  financeTick(s, R, D);

  // ⑥ 订单（按日历月生成；到期未点则自动交付 ×0.9）—— 只给现金，不动收入公式
  ordersTick(s, R);

  // ⑦ 世界榜（与日历同一真相源）→ 推幕 → 里程碑 → 年度报告
  worldTick(s, R);
  advanceStage(s, D);
  logMilestones(s, D);
  annualReport(s, R, D);

  // 登顶 = 唯一结局的判据（`worldRank` 由 world.js 维护，这里不另算一遍）
  if (!s.ending && s.worldRank === 1) {
    s.ending = 'top';
    /**
     * 记下**登顶那一刻的游戏月** —— 回味期 `gap` 的爬坡起点（`u` 的唯一依据）。
     * 登顶时 `calMonth` 恰好是 480（`calMonthOf` 在末档打满），而日历随后由真实秒推进。
     */
    s.topMonth = gameMonths(s);
    // ⚠️ 不再接「上面没有人了。」—— 同一局的名次播报（`【世界第 1】`）已经说了这一句，
    //    两条紧挨着出现是同一件事说两遍（用户 2026-09-27「事件描述避免重复」）。
    /**
     * ⚠️ 公司名按**章**取（`companyName(s.stage)`，2026-09-28）—— 登顶必在第 8 章，
     *    所以这里写的恒定是 `AbstrO`。**上一步 `advanceStage`（更名）必须排在这一步之前**：
     *    同一次 tick 里若先判登顶再推幕，这一行会写出上一章的名字。顺序不能调。
     */
    s.log.push(`【登顶】${companyName(s.stage)} 成了世界第一。`);
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
    // ⚠️ 第三个参数 `live = true`：**只有这里**在跑真实会话 —— 登顶之后要慢放（`SAVOR_RATE`）
    //    而不是定格。`offlineRun` 与无头工具都直接调 `tick`（默认 false），照旧定格。
    while (acc >= STEP && guard++ < 60) { tick(s, STEP, true); acc -= STEP; }
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
