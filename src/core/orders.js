/**
 * 订单（GDD §1.2 / §3.6 · 用户 2026-09-27）
 * ===============================================================
 * 每 9 个游戏月来一条「交付单」，在手最多 3 条。它是**现金的第二个来源**，
 * 不进收入公式、不给任何长期乘数 ⇒ 不改经济模型，标定只需把它的现金量算进去。
 *
 * 三条硬约束：
 *   ① **零 `Math.random()`** —— 等级按序号轮转（`ORDER_TIERS` 六档），
 *      客户类别与形态由 `uid` 的 `hash32` 现算，
 *      所以同一份存档永远跑出同一串订单，无头工具才可能断言。
 *   ② **报酬 = 当前年营收 × (payEq/500) × 客户系数 × 形态系数** ——
 *      `年营收 / cost` 是常数（见 economy.js 顶部），所以一单的价值全程恒定：
 *      平均一单 ≈ **年营收的 10.6%** ≈ 4 次购买（旧值 0.047 档 ≈ 1.7 次）。
 *      有分量，但不接管主循环（收益永远比不上「多买一级」的复利）。
 *   ③ **交付只有两个价** —— 玩家点「交付」⇒ ×1.0；到期未点 ⇒ 自动交付 ×0.9。
 *      「总是点」比「从不点」多拿 `1/0.9 − 1 ≈ 11%` 的订单现金，而订单现金只是购买现金的
 *      一部分 ⇒ 手速上界由 `npm run robust` 的「手速 ≤ 1.5×」守着（实测 `1.077×`）。
 *      ⚠️ `×0.9` 只活在**算钱**里，**不写进日志**（用户 2026-09-27）——
 *      准时与超时两种交付在流水里合并成同一行，看不出折扣。
 */

import { fmtShort, gameMonths } from './format.js';
import { ORDER_TIERS, ORDER_KINDS, ORDER_FORMS, ORDER_CLIENTS, ORDER_WORKS, SEC_PER_YEAR } from './content.js';
import { hash32 } from './world.js';

/** 每多少个游戏月来一条（9 ⇒ 一局 54 单，「少而大」，一年一单多一点） */
export const ORDER_EVERY_MONTHS = 9;
/** 一条单在手上能放多少个月（到期未点 ⇒ 自动交付） */
export const ORDER_LIFE_MONTHS = 12;
/** 在手槽位上限 */
export const ORDER_SLOTS = 3;
/** 到期自动交付的折扣（玩家点 = ×1.0）—— **只算钱，不进日志** */
export const AUTO_DELIVER = 0.9;
/**
 * 大单门槛：等级 **≥ 第 4 档**（即 `payEq ≥ 45` 秒）才算「有一条大的在等」。
 * 旧值是「档位 ≥ 0.04」—— 六档之下那个写法会让第 3 档以上全部命中，`.hot` 角标常年亮着，
 * 就等于没有信号。改成按下标取，与档位表一一对齐。
 */
export const HOT_TIER = ORDER_TIERS[3].tier;
/**
 * 订单日志的**归并窗口**（真实秒，随最后一次交付顺延）。
 *
 * 为什么要归并：一局全程 176 行日志里**订单占 79 行（45%）** —— 它是刷屏的唯一大头。
 * 窗口是**真实秒**而不是游戏月，所以倍速一开（8× 时一条单只隔 ~30 真实秒）
 * 归并自然变密、1× 时几乎不触发 —— 「快的时候合并、慢的时候逐条」不用额外规则。
 * 归并只改**日志**，不改任何钱的算术。
 */
const LOG_WINDOW = 20;

/**
 * 记一条订单流水。
 * 窗口内就地**改写同一行**（`s.log` 的末行还是自己写的那一行时才改写，
 * 所以别的模块插进来一条日志就会自然断开归并）。
 * `s.orderWin` 是**运行时**字段 —— 与 `calMonth` 同规矩，不入存档。
 */
function logOrder(s, desc, got) {
  const w = s.orderWin;
  const joining = w && (s.elapsed - w.at) < LOG_WINDOW && s.log[s.log.length - 1] === w.text;
  if (!joining) {
    const text = `【订单 · ${desc.form.name}】${desc.client} · +¥${fmtShort(got)}`;
    s.log.push(text);
    s.orderWin = { name: desc.client, form: desc.form.name, n: 1, sum: got, at: s.elapsed, text };
    return;
  }
  w.n += 1;
  w.sum += got;
  w.at = s.elapsed;
  w.text = `【订单 · ${w.form}】${w.name} 等 ${w.n} 单 · +¥${fmtShort(w.sum)}`;
  s.log[s.log.length - 1] = w.text;
}

/** 到期月 = 出生月 + 在手时长 */
export const dueMonthOf = o => o.born + ORDER_LIFE_MONTHS;
/** 还有几个月到期 */
export const monthsLeftOf = (s, o) => Math.max(0, dueMonthOf(o) - gameMonths(s));
/** 是不是大单（等级 ≥ 第 4 档） */
export const isHot = o => o.tier >= HOT_TIER;
/** 在手是否有大单 —— 页签据此加 `.hot` */
export const hasHot = s => liveOf(s).some(isHot);
/** 在手条数 —— 页签上的数字 */
export const liveOf = s => (s.orders && s.orders.live) || [];
export const liveCount = s => liveOf(s).length;
/**
 * 累计交付过的订单数（含到期自动交付）—— 界面右上角那枚「已完成 N 项」。
 * 它**没有任何机械效果**（订单只给现金），只是「这家公司一直在干活」的手感。
 */
export const doneCount = s => (s.orders && s.orders.done) || 0;

/** 一条单的甲方与三个标签（全部由 `uid` 哈希现算，**不入存档**） */
export function describeOrder(o) {
  // 等级：`o.tier` 是存档里的数值，回查表得到 `{ name, payEq, tier }`
  const k = Math.max(0, ORDER_TIERS.findIndex(t => t.tier === o.tier));
  const pick = (arr, salt) => arr[hash32(o.uid, salt, 4271) % arr.length];
  return {
    tier: ORDER_TIERS[k],
    kind: pick(ORDER_KINDS, 73),        // 客户类别（系数进数值，不进文案）
    form: pick(ORDER_FORMS, 74),        // 形态（**唯一进日志的标签**）
    client: pick(ORDER_CLIENTS[k], 71), // 甲方真名
    work: pick(ORDER_WORKS[k], 72),     // 交付内容
  };
}

/**
 * 一条单现在值多少钱。
 * = `年营收 × (payEq / SEC_PER_YEAR) × 客户类别系数 × 形态系数`
 * 第一项是**等级**（6 档，按序号轮转），后两项由 `uid` 哈希现算 ⇒ 同一等级的两单金额也不同。
 * 三样都从 `uid` / `tier` 派生 ⇒ **零 `Math.random()`**，同存档永远同结果。
 */
export function valueOf(R, o) {
  const d = describeOrder(o);
  return R.revenue * (d.tier.payEq / SEC_PER_YEAR) * d.kind.pay * d.form.pay;
}

/**
 * 每 tick 调用：① 到月生成 → ② 到期自动交付。
 * ⚠️ 生成时**槽位满了就跳过这一条**（不排队）—— 队列会让长期挂机后一次涌出十几条，
 *    而在手上限的意义正是「三条就是三条」。
 */
export function ordersTick(s, R) {
  if (!s.orders) s.orders = { next: 0, live: [], done: 0 };
  if (!Array.isArray(s.orders.live)) s.orders.live = [];
  if (!Number.isFinite(s.orders.done)) s.orders.done = 0;

  // ① 生成：第 n 条单在第 `n × ORDER_EVERY_MONTHS` 个月出现
  const seq = Math.floor(gameMonths(s) / ORDER_EVERY_MONTHS);
  while (s.orders.next <= seq) {
    const n = s.orders.next;
    if (s.orders.live.length < ORDER_SLOTS) {
      s.orders.live.push({
        uid: ++s.uidSeq,
        tier: ORDER_TIERS[n % ORDER_TIERS.length].tier,
        born: n * ORDER_EVERY_MONTHS,
      });
    }
    s.orders.next = n + 1;
  }

  // ② 到期未点 ⇒ 自动交付 ×0.9（钱打折，日志不打折 —— 与准时共用一行）
  const months = gameMonths(s);
  const kept = [];
  for (const o of s.orders.live) {
    if (months >= dueMonthOf(o)) {
      const got = valueOf(R, o) * AUTO_DELIVER;
      s.money += got;
      s.orders.done += 1;
      logOrder(s, describeOrder(o), got);
    } else kept.push(o);
  }
  s.orders.live = kept;
}

/**
 * 玩家点「交付」—— 准时 ×1.0。
 * @returns {boolean} 是否交付成功（uid 对不上说明界面拿的是过期节点）
 */
export function deliverOrder(s, uid, R) {
  const i = liveOf(s).findIndex(o => o.uid === uid);
  if (i < 0) return false;
  const [o] = s.orders.live.splice(i, 1);
  const got = valueOf(R, o);
  s.money += got;
  if (!Number.isFinite(s.orders.done)) s.orders.done = 0;
  s.orders.done += 1;
  logOrder(s, describeOrder(o), got);
  return true;
}