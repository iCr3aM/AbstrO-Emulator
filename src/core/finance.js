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
 * 与阶段目标的对应：A 轮落在第 4 阶段（「融资：为上市准备」）。
 * `ipo` 不看年份，看市值 —— 达到 `IPO_LINE` 即上市（GDD §2 第 5 阶段）。
 */
export const ROUNDS = [
  { id: 'angel',  name: '天使轮',   year: 2032, years: 0.30, pe: 0, investor: '真格基金' },
  { id: 'preA',   name: 'Pre-A 轮', year: 2035, years: 0.40, pe: 0, investor: '创新工场' },
  { id: 'a',      name: 'A 轮',     year: 2042, years: 0.50, pe: 1, investor: '红杉中国' },
  { id: 'b',      name: 'B 轮',     year: 2044, years: 0.60, pe: 1, investor: '高瓴创投' },
  { id: 'c',      name: 'C 轮',     year: 2048, years: 0.70, pe: 1, investor: '软银愿景基金' },
  { id: 'preIpo', name: 'Pre-IPO',  year: 2050, years: 0.80, pe: 2, investor: '淡马锡' },
  { id: 'ipo',    name: 'IPO',      year: null, years: 1.00, pe: 3, investor: null },
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
      s.log.push(`【改名】${companyName(4)} 从今天起叫 ${companyName(5)} —— 招股书第一页，印的是出租屋那张桌子。`);
    }
  }
}
