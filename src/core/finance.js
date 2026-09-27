/**
 * 融资（GDD §3.2：保留轮次定义与 `rounds` 标记，**去掉股权稀释**）
 * ===============================================================
 * 设计原则：融资**不新增子系统** —— 它只是 7 个按时间自动触发的里程碑，
 * 效果只有两个：`cash`（到账金额）与 `pe`（市场给的估值倍数）。
 *
 * ⚠️ 金额一律用「相当于多少年营收」，所以自动随公司成长缩放。
 * ⚠️ IPO 没有领投方（公开发行不是某一家投的），界面须能处理 `investor` 为空。
 */

import { IPO_LINE, companyName } from './content.js';
import { fmtShort, gameMonths } from './format.js';

/**
 * `year` = 到账的**日历年**（要求 `gameMonths` 的进度钟，与顶部日期同一真相源）。
 * 与八章的对应（v6 · 用户 2026-09-27：40 年到 2066）：
 *   天使轮 ch2(2030–2034) ｜ Pre-A ch2(2030–2034) ｜ A + B ch4(2039–2044)
 *   ｜ C ch5(2044–2049) ｜ Pre-IPO ch6(2049–2054) ｜ IPO ch7（看市值，不看年份）
 * 所以第 4 章「资本局」的目标「完成 A 轮」在幕内约 40% 处达成，
 * 第 6 章「完成 Pre-IPO 轮」在幕内约 40% 处达成 —— 两条都是**幕内**达成的。
 * ⚠️ 七轮的年份必须落在**各自那一章的 years 区间**里：`ipo` 不看年份、只看市值
 *    （`IPO_LINE` 必须落在第 7 章内），否则会出现「先上市、后到账」的时序错乱。
 *    `tools/probes.mjs` 有对应的断言。
 *
 * ⚠️ `years` = 到账金额相当于**多少年营收**（字段名保留 `years`，别再改）。
 *    它是**叙事与节奏的双重旋钮**：`Δln(市值) = c · (年营收/cost) · ln(r)/k`，
 *    而 `年营收/cost = INCOME_SCALE·SEC_PER_YEAR / LINE_COST0` 是**常数**
 *    （旧版的 `GENERATION` 隐藏乘数删掉之后才成立）⇒ 系数 `c` 全程不必逐章缩放。
 *
 * ### 取值（用户 2026-09-27「融资的钱太少了」）
 * 换算关系（`ρ` = 年营收 / 一次购买成本 = `INCOME_SCALE·SEC_PER_YEAR / LINE_COST0` ≈ 37.3，
 * 再乘上决策乘数，实测终局 38.2）：**1 年营收 ≈ 37 次购买**，一局全程 656 次购买。
 * 旧版后四轮是递减的（0.05 / 0.06 / 0.06 / 0.07 / 0.08 / 0.09 / 0.10，Σ = 0.51 年），
 * 一局七轮总共只到账 **19.5 次购买当量 = 全程的 3.0%** —— 用户读出来就是
 * 「我都是独角兽了，融资怎么还这点钱」，判断是对的。
 *
 * 现在按**方案 A**抬后期：Σ = 3.04 年 ⇒ **120.5 次购买当量 = 全程的 18.4%**
 * （实测 A 档 best 一局逐轮落点 14.4 / 8.9 / 8.0 / 8.2 / 10.7 / 21.0 / 49.3 次），
 * 融资从「边角料」变成第二条外部现金流。
 * 天使 / Pre-A **刻意不动**：那两轮落在「自动购买门槛还是 6 份」的第 2 章，
 * 一动就会把玩家自己点的那段窗口买光（见 `content.AUTO_BUY_RESERVE_EARLY`）。
 *
 * ⚠️ **用户要的「Pre-IPO 百亿美元 / IPO 千亿美元」在数学上够不着**，原因写在这里，
 *    免得下次又当成 bug 改回去：一局的**总购买次数被终局市值钉死为 656 次**
 *    （世界榜首由 `npm run tune` 锚定），而「1 年营收 ≈ 37 次购买」是常数。
 *    Pre-IPO 时点年营收 83 亿 ⇒ ¥720 亿（$100 亿）= **8.7 倍年营收 ≈ 330 次**
 *    （全程的一半）；IPO 时点年营收 387 亿 ⇒ ¥7200 亿（$1000 亿）= **18.6 倍 ≈ 700 次
 *    —— 比一局的总购买次数还多**，光这一轮就把整局买完了。
 *    所以只能取「同量级、但不吃掉全局」的这一档。
 *    顺带一提：按**估值**口径我们本来就在那个量级（Pre-IPO 时点估值 ≈ $328 亿、
 *    IPO 敲钟时 ≈ $2500 亿），那正是用户拿来对标 SpaceX 的那张表。
 *
 * 实测绝对金额（当前阶梯，A 档 best 一局）：
 *    天使 68.05 万 → Pre-A 162.33 万 → A 3492.22 万 → B 9490.19 万
 *    → C 2.28 亿 → Pre-IPO 45.68 亿 → IPO 464.86 亿。
 *    改这里 ⇒ 必须重跑 `npm run tune` → `npm run check` → `npm run robust`。
 */
export const ROUNDS = [
  { id: 'angel',  name: '天使轮',   year: 2031, years: 0.35, pe: 0, investor: '真格基金' },
  { id: 'preA',   name: 'Pre-A 轮', year: 2033, years: 0.24, pe: 0, investor: '创新工场' },
  { id: 'a',      name: 'A 轮',     year: 2041, years: 0.20, pe: 1, investor: '红杉中国' },
  { id: 'b',      name: 'B 轮',     year: 2043, years: 0.22, pe: 1, investor: '高瓴创投' },
  { id: 'c',      name: 'C 轮',     year: 2045, years: 0.28, pe: 1, investor: '软银愿景基金' },
  { id: 'preIpo', name: 'Pre-IPO',  year: 2051, years: 0.55, pe: 2, investor: '淡马锡' },
  { id: 'ipo',    name: 'IPO',      year: null, years: 1.20, pe: 3, investor: null },
];

/** 已上市的判据：`rounds` 里有 ipo（世界榜据此决定要不要把玩家排进去） */
export const isListed = s => !!(s.finance && s.finance.rounds.includes('ipo'));

/** 当前日历年（进度钟的派生量）—— HUD 的「距下一轮 N 年」也用它，别在别处再算一遍 */
export const yearNow = s => 2026 + Math.floor(gameMonths(s) / 12);

/** 每 tick 调用：到点就自动触发尚未完成的融资轮 */
export function financeTick(s, R, D) {
  if (!s.finance) s.finance = { rounds: [] };
  if (!Array.isArray(s.finance.rounds)) s.finance.rounds = [];
  const y = yearNow(s);
  for (const r of ROUNDS) {
    if (s.finance.rounds.includes(r.id)) continue;
    const ready = r.id === 'ipo' ? D.marketCap >= IPO_LINE : y >= r.year;
    if (!ready) continue;

    s.finance.rounds.push(r.id);
    const got = R.revenue * r.years;
    s.money += got;
    if (r.pe) s.mod.pe += r.pe;
    s.log.push(`【${r.name}】到账 ¥${fmtShort(got)}（${r.investor || '公开发行'}）`);
    if (r.id === 'ipo') {
      s.log.push(`【改名】${companyName(false)} 从今天起叫 ${companyName(true)} —— 招股书第一页，印的是出租屋那张桌子。`);
    }
  }
}
