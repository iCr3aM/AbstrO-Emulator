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
 * 与阶段目标的对应：**第 4 阶段（海外分部）是融资幕** —— A / B / C / Pre-IPO 四轮
 * 全部落在 2042–2045，幕末市值一到就敲钟 ⇒ 上市发生在第 4 幕幕末（2046）。
 * 所以第 4 幕的目标「拿到 A 轮」会在幕内 ~20% 处打勾。
 * ⚠️ 四轮年份必须都落在 `ACTS[4].years`（2041–2046）之内：`ipo` 不看年份、只看市值
 *    （`IPO_LINE = ACTS[4].mcap`），若 B/C/Pre-IPO 排在 2046 之后，就会出现
 *    「先上市、后到账」的时序错乱。
 * `ipo` 不看年份，看市值 —— 达到 `IPO_LINE` 即上市（GDD §2 第 5 阶段）。
 *
 * ⚠️ `years` = 到账金额相当于**多少年营收**。它是**节奏旋钮**，不是叙事自由度：
 *    一笔 `c` 倍年营收的现金 = `c · INCOME_SCALE · gen · SEC_PER_YEAR / LINE_COST0` 次购买。
 *    旧标定用的 0.30–1.00 倍（合计 4.3 倍年营收 ⇒ 约 220 次购买、占全程 45%）
 *    会把「天使轮所在的第 2 幕」「A 轮所在的第 4 幕」直接腰斩，七幕时长不再单调。
 *    现在压到 5%–10%，合计约 24 次购买（全程 ~5%）—— 叙事上仍是「一大笔钱」，
 *    数值上不再改写幕长。改这里 ⇒ 必须重跑 `npm run tune`。
 */
export const ROUNDS = [
  { id: 'angel',  name: '天使轮',   year: 2032, years: 0.05, pe: 0, investor: '真格基金' },
  { id: 'preA',   name: 'Pre-A 轮', year: 2035, years: 0.06, pe: 0, investor: '创新工场' },
  { id: 'a',      name: 'A 轮',     year: 2042, years: 0.06, pe: 1, investor: '红杉中国' },
  { id: 'b',      name: 'B 轮',     year: 2043, years: 0.07, pe: 1, investor: '高瓴创投' },
  { id: 'c',      name: 'C 轮',     year: 2044, years: 0.08, pe: 1, investor: '软银愿景基金' },
  { id: 'preIpo', name: 'Pre-IPO',  year: 2045, years: 0.09, pe: 2, investor: '淡马锡' },
  { id: 'ipo',    name: 'IPO',      year: null, years: 0.10, pe: 3, investor: null },
];

/** 已上市的判据：`rounds` 里有 ipo（世界榜据此决定要不要把玩家排进去） */
export const isListed = s => !!(s.finance && s.finance.rounds.includes('ipo'));

/** 当前日历年（进度钟的派生量） */
const yearNow = s => 2026 + Math.floor(gameMonths(s) / 12);

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
    s.log.push(`【${r.name}】到账 ${fmtShort(got)}（${r.investor || '公开发行'}）`);
    if (r.id === 'ipo') {
      s.log.push(`【改名】${companyName(false)} 从今天起叫 ${companyName(true)} —— 招股书第一页，印的是出租屋那张桌子。`);
    }
  }
}
