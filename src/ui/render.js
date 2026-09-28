/**
 * 极简 DOM 渲染（主界面四个页签：公司 / 创始人 / 订单 / 市值榜）
 * ===============================================================
 * 只做「把状态画出来」+「把点击转成一次 action」，不含任何游戏规则。
 *
 * ⚠️ 这里是**全量重建**（`root.innerHTML = ...`）—— 所以任何交互态（展开与否、确认与否）
 *    都必须由本模块持有，不能留在 DOM 里。
 * ⚠️ 只有 `data-*` 一种接线方式，且动作键必须落在 `bind.js` 的 `ACTION_KEYS` 里。
 */

import {
  ACTS, LINES, lineName, FOUNDERS, agesAt, PENDING_CAP, SEC_PER_YEAR, companyName, MILESTONES,
  IPO_LINE, SAVOR_RATE,
} from '../core/content.js';
import { rates, derived, manualCostOf, canAffordManual, sharePctOf } from '../core/economy.js';
import { ORDER_SLOTS, liveOf, liveCount, hasHot, isHot, monthsLeftOf, valueOf, describeOrder, doneCount } from '../core/orders.js';
import { ranking, toUSD_T, SECTOR_LABEL, hotSector, WORLD_START_YEAR } from '../core/world.js';
import { isListed, isValued, ROUNDS, yearNow } from '../core/finance.js';
import { gameDate, gameYear } from '../core/format.js';
import { pendingEvent, stageGoalMet, LOG_MAX, dilate, isSprint } from '../core/engine.js';
import { ENDING_TEXT } from '../core/endings.js';

/** 阶段配色：只改一个 CSS 变量，整页基调随之推移（八章各一色） */
const ACCENT = [null, '#6ad1c0', '#7bc47f', '#c9b458', '#d98c5f',
                '#c96a8a', '#8f8fd9', '#6fa8dc', '#e0e0e0'];

/** 倍速档位（页头那三个按钮；`s.speed` 等于哪一档，哪个就点亮） */
const SPEEDS = [1, 4, 8];

// ─────────────────────────── 分页（交互态）───────────────────────────
/**
 * 四个页签：**创始人 / 公司 / 订单 / 市值榜**（用户 2026-09-27：创始人第一位、公司第二位）。
 */
const TABS = ['创始人', '公司', '订单', '市值榜'];
/** 页签下标 —— 别在正文里裸写数字 */
const TAB_FOUNDER = 0;
const TAB_COMPANY = 1;
const TAB_ORDER = 2;
/** 市值榜 —— 登顶后**唯一**可点的页（第九批 §6） */
const TAB_RANK = 3;

/**
 * 五条线怎么分页：创始人页三条（研发 / 营销 / 招聘 —— 各由一位创始人把着），
 * 公司页两条**资产**（算力 / 渠道）。
 * 分页只是显示 —— 五条线共用一个 `cost(n)` 与一个 `g`，数学上完全等价。
 */
const PAGE_LINES = [['r', 'm', 'h'], ['c', 'd']];

/**
 * 当前页。⚠️ `render()` 是**全量重建**，所以这个态必须住在模块里，
 * 不能留在 DOM 的 class 上（重建一次就没了）。
 * 不进存档：它是一次交互，不是游戏状态 —— 与 `deleteArmed` 同规矩。
 */
let tab = 0;
export function setTab(i) {
  const n = Number(i);
  if (Number.isInteger(n) && n >= 0 && n < TABS.length) tab = n;
}

const esc = v => String(v).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function fmt(n, d = 2) {
  if (!Number.isFinite(n)) return '∞';
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(d) + '万亿';
  if (a >= 1e8) return (n / 1e8).toFixed(d) + '亿';
  if (a >= 1e4) return (n / 1e4).toFixed(d) + '万';
  return a >= 100 ? n.toFixed(0) : n.toFixed(d);
}

/** 万亿美元口径（世界榜唯一单位）—— **恒两位小数**：「三位数就取整」会让榜首悄悄少一位精度 */
const tUsd = v => v.toFixed(2);

/** 市值榜只显示前 20 名；名次超出 100 只报「>100」（榜单之外的名次没有意义） */
const RANK_SHOW = 20;
const RANK_MAX = 100;
/**
 * 从第几章起，HUD 的世界格开始报**上市前的名次**（用户 2026-09-28：「如果融资后……可以显示」）。
 * 实测（`best` 路径）：第 2–6 章整整 300 个月卡在 114~148 名，写出来只是一个不动的数字；
 * 第 7 章（月 340）开始往上冲，月 351 首次进前 100 ⇒ 第 7 章才有信息量。
 */
const RANK_EST_STAGE = 7;

/**
 * 净收入的显示 —— **单位与量级两件事一起管**（用户 2026-09-27：读数要能看到单位）。
 *
 * 单位：「每秒」在早期是 `¥12.34/秒` 这种能看懂的数是好的，但到后期就是
 * 「每秒 ¥3.70万亿」这种念不出来的东西；而上万之后换成「每年」（与市值 / 年营收
 * 同一个口径、同一个 `¥…/年` 写法）正好落在可读区间。
 * ⚠️ 币种写出来（`¥` = 人民币）：市值榜那一格是**美元**口径，两边不能只靠位置区分。
 */
function rateOf(v) {
  const sign = v >= 0 ? '+' : '−';
  const a = Math.abs(v);
  return a < 1e4
    ? `${sign}¥${fmt(a)}/秒`
    : `${sign}¥${fmt(a * SEC_PER_YEAR)}/年`;
}

/**
 * **近 N 游戏秒真实入账回推的年化**（用户 2026-09-28：「现金 加xxxx/年 的数字也要跟着跳动……
 * 回味期你可以合理将数字显示正常上升下降而不是硬切」）。
 *
 * 为什么不能直接用 `R.netPerSec`：它只是**五条线等级的函数**（`economy.rates`），两次购买
 * 之间是一个**常数** ⇒ 表现是「几秒不动、然后跳一格」。这正是用户说的「硬切」。
 *
 * 这里量的是**最近 `RATE_WIN` 游戏秒里现金真的变了多少**，再换算成「元/游戏秒」——
 * 与 `netPerSec` 同一个单位，所以 `rateOf` 一个字都不用改。
 *   · 「游戏秒」= 真实秒 × 本帧的时间倍率（`engine.tick` 里那个 `dt` 的口径）——
 *     不除这个倍率的话，8× 档读出来是 1× 档的 8 倍：同一家公司在页头换个档位就换一个
 *     「年营收」，那是撒谎。
 *   · 它是**测量**不是**逼近**：滑窗里真的发生了什么就报什么（购买把它拉下去、产能爬上来
 *     又把它推回去）。不做「向目标值指数逼近」那种永远落后真值的假平滑。
 *   · 首帧 / 读档第一帧没有历史 ⇒ 回落到 `R.netPerSec`（唯一诚实的兜底），
 *     所以无头工具里「渲染一次就断言」的那类探针读到的仍是老值。
 *
 * ⚠️ 这是**渲染模块自己的内存态**，与 `tab` / `rankSel` 同规矩：不进存档、不进 core。
 */
const RATE_WIN = 3;                     // 游戏秒
let rateTrace = [];                     // [{ gs, money }] —— gs = 累计游戏秒
let rateGs = 0;                         // 累计游戏秒
let rateAt = 0;                         // 上一次采样的真实秒

/** 本帧的时间倍率 —— 必须与 `engine.tick` 的 `dt` 逐字一致（回味期忽略倍速与减速） */
const stepRate = s => (s.ending ? SAVOR_RATE : (s.speed || 1) * dilate(s));

function liveNet(s, netPerSec) {
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  if (rateAt > 0 && now > rateAt) rateGs += (now - rateAt) * stepRate(s);
  rateAt = now;
  rateTrace.push({ gs: rateGs, money: s.money || 0 });
  while (rateTrace.length > 1 && rateGs - rateTrace[0].gs > RATE_WIN) rateTrace.shift();
  const oldest = rateTrace[0];
  const dGs = rateGs - oldest.gs;
  if (!(dGs > 0.25)) return netPerSec;                  // 窗口还没攒够（含「渲染一次就断言」的探针）
  const v = ((s.money || 0) - oldest.money) / dGs;
  return Number.isFinite(v) ? v : netPerSec;
}

/** 名次变化（`rankDelta` 正数 = 上升；`null` = 本月新入场） */
function deltaOf(c) {
  if (c.isNew) return '<em class="new">新</em>';
  const d = c.rankDelta || 0;
  if (d > 0) return `<em class="up">↑${d}</em>`;
  if (d < 0) return `<em class="down">↓${-d}</em>`;
  return '';                              // 持平不画符号：一屏幕的「─」是纯噪声
}

/**
 * 名次文本：**100 名开外一律显示 `>100`**（137 还是 152 对玩家没有信息量）。
 * 玩家自己的行在 100 名开外时**连升降也不显示** —— 那个区间里名次每天都在漂，
 * `↑3 / ↓5` 只是噪声，反而让人以为有事发生。
 */
const rankText = r => (r <= RANK_MAX ? String(r) : `>${RANK_MAX}`);

/**
 * 环比百分比：`+3.4%` / `−1.2%`（用 U+2212 的 `−`，与 `rateOf` 同一个减号，不与 ASCII `-` 混用）。
 * 恒一位小数：环比本来就只到「涨了几个百分点」的精度，两位是假精确。
 */
const pctText = v => `${v >= 0 ? '+' : '−'}${(Math.abs(v) * 100).toFixed(1)}%`;

/** 带红绿的环比（`.up` / `.down` 与榜单升降、HUD 副行共用同一套着色） */
const dirEm = v => `<em class="${v >= 0 ? 'up' : 'down'}">${pctText(v)}</em>`;

/**
 * 玩家市值的**环比**（对上一个世界月）—— 与市值榜里玩家行用的是**同一个数**：
 * 两边都拿「当帧市值 ÷ 上月末快照」。各算一遍迟早会不一致，所以收成一个函数。
 * @returns 没有基准（新档第一帧 / 旧档缺字段）时为 `null`
 */
const capMomOf = (s, D) => (s.worldPrevCap > 0 ? toUSD_T(D.marketCap) / s.worldPrevCap - 1 : null);

// ─────────────────────────── 常驻 HUD ───────────────────────────
/**
 * 四格 2×2：**现金总额** / 市值 / 净利率＋世界排名（同框，左净利率右排名）/ 本阶段目标。
 *
 * 「现金」与「现金储备」是**同一格的两行**（用户 2026-09-27）—— 账上那笔钱只有一部分能动：
 * 储备金 = `现金 × RESERVE_FRAC`（`economy.spendableOf`）。口径取**甲**：
 * **大字放现金总额**（对上 GDD §1.2 的「现金及等价物」，与「年营收 3.31 万亿」同量级可对照），
 * 副行**分两行**写「可动用 ¥X」/「储备 ¥Y」—— 因为 `rf = 0.80` 时储备是可动用的 4 倍，
 * 旧版「大字放可动用」会让副行数字反超大字，读起来别扭。
 * ⚠️ 副行原来是**一行**「可动用 ¥X ｜ 储备 ¥Y」（用户 2026-09-27 反馈：现金格会随文字跳动
 *    格子高度）—— 两个金额位数一变（`¥432万` → `¥2500.00万亿`），这一行就在 1 行 / 2 行
 *    之间来回折，同一 grid 行被撑高，整块 HUD 跟着跳。拆成两个 `<u>` 后**恒 4 行**。
 *    其余三格 2026-09-27 也补满了第 4 行（见下），当时四格**都是 4 行**；
 *    `style.css` 里 `.hud .cell` 仍按 4 行预算锁死高度，四格同高。
 *    （2026-09-28 净利率格删掉了一行 ⇒ 它是 3 行；锁的是**格子**高度，不是行数。）
 * 三位创始人的年龄挂在目标格的副行（他们不进任何公式，只是叙事）。
 *
 * **2026-09-27 补第三行**（用户：「市值那一个框现在不是三行吗？可是只显示了两行」）：
 * 现金格本来就占满 4 行，其余两格各空一行 ⇒ 现在逐格补上，四格**格子**同高（`.hud .cell` 锁 90px）：
 *   · 市值格   → `相比上月 ±x.x%`（与市值榜里玩家行同一个数，见 `capMomOf`）
 *   · 世界格   → 未上市写「距下一轮融资 N年」（只剩 IPO 时写 `距上市 ×N`）；上市写名次环比（见下）
 * ⚠️ **净利率格那行的 `净利 ¥X` 已删**（用户 2026-09-28：「可以删除净利率格末行的显示」）：
 *    它与现金格标题行右端的 `+¥8862.22亿/年`（`rateOf(R.netPerSec)`）是**同一个数**
 *    （`net = netPerSec × SEC_PER_YEAR`），只差小数位 —— 一屏说两遍。删掉后那半格是 3 行、
 *    右半格（世界）仍是 4 行：格子高度本来就锁死，半格少一行不会让 HUD 跳动。
 *
 * 目标达成的表现是**目标文字转绿 + 标题行右端写「完成」**，**不打钩**（用户 2026-09-27）：
 * 打钩只是给词尾缀了一个符号，转绿则把「这一条已经跨过」摊在整个词上 —— 一眼就能扫到。
 * ⚠️ 原来是**绿框**（`border` + `padding` = 横向多占 14px），会把「完成 Pre-IPO 轮」这类
 *    长目标挤成两行、格子高度又跳（用户 2026-09-27 二次修订：**去掉框，只留颜色**）。
 * 未达成时**什么都不加**（「颜色变没变」本身就是达成与否的信号）。
 */
function hud(s, R, D) {
  const a = ACTS[s.stage] || ACTS[1];
  const ages = agesAt(s.stage);
  const who = FOUNDERS.map(f => `${f.name} ${ages[f.id]}`).join(' · ');
  const goal = stageGoalMet(s, R, D);
  const listed = isListed(s);
  const r = s.worldRank;
  /**
   * 名次文本 —— **三种口径**（2026-09-28 重排，用户诉求 #3 / #7）：
   *
   *   · 已上市（现状）：`#42` ／ `>100`。进了榜但排在 100 名开外只报 `>100` ——
   *     具体是 137 还是 152 对玩家没有信息量。
   *   · **未上市但已进第 7 章**：100 名开外写 **`预估 >100`**（用户原话口径）——
   *     榜上根本没有他这一行，那个名次只能**推算**出来，所以加「预估」两个字。
   *     名次真的进了前 100（实测月 351 起）就照实写 `#97`：那时它已经能被直接看到，
   *     **而且写不下** —— 半格只有 73px，`预估 #97 ↑3` 会横向溢出（`npm run shots` 会红）。
   *   · 第 2–6 章：`—`（实测那 300 个月一直卡在 114~148 名，写出来只是个不动的数字）。
   */
  const inList = !!(r && r <= RANK_MAX);
  const ranked = listed ? (inList ? `#${r}` : `>${RANK_MAX}`)
    : s.stage >= RANK_EST_STAGE ? (inList ? `#${r}` : `预估 >${RANK_MAX}`)
    : '—';
  /**
   * 名次升降 —— **贴在名次右边**（用户 2026-09-28：「名次上升下降放在 排名右边」）。
   * 原来是世界格的**最后一行**（`名次 ↑3`），现在与名次同一行、同一字号，读起来是一个整体。
   * ⚠️ 只在 `r ≤ 100` 时给 —— 与榜单里玩家行同一条规矩：100 名开外那个区间每天在漂，
   *    `↑3 / ↓5` 只是噪声，反而让人以为有事发生。
   */
  const dRank = listed && s.worldRankPrev != null && inList ? s.worldRankPrev - r : 0;   // 正数 = 前进
  const worldDelta = dRank > 0 ? ` <em class="up">↑${dRank}</em>`
    : dRank < 0 ? ` <em class="down">↓${-dRank}</em>` : '';
  const mom = capMomOf(s, D);
  /**
   * **估值解锁**（用户 2026-09-28：「市值、PE 一开始可以不显示（创业初期显示为 `-`），
   * 并且可以在天使轮之后才开始显示」）。
   *
   * 天使轮到账之前，公司只有三张折叠桌 —— 那时写 `市值 预估 ¥432万` / `PE 12 倍` 是纯噪声。
   * 判据是 `finance.isValued`（与下面世界格那行「距天使轮 xx%」**同一个真相源**，
   * 所以「进度条走到 100%」与「市值出现」落在同一天）。
   *
   * 隐藏期**留骨架**（用户三选一里选的那档）：
   *   · 市值格：标签退回 `市值`（**不写「预估」** —— 那时连预估都没有）、大字 `—`、
   *     「相比上月」也写 `—`；但 **「年营收」照常显示**（营收是事实，不是估值）；
   *   · 净利率格的 PE 行写 `PE —`；`净利率` 大字照常（`margin` 与估值无关）。
   * ⚠️ 破折号用 `—` 而不是 `-`：与「相比上月 `—`」「世界 `—`」同一口径 ——
   *    一屏里只有一个「没有值」的写法。
   * ⚠️ 格子**行数不变**（上行 4 行 / 下行 3 行）⇒ `.hud` 的 `grid-template-rows: 90px 74px` 不用动。
   */
  const valued = isValued(s);
  const capLabel = valued && !listed ? '<em>预估</em>' : '';   // 隐藏期不写「预估」
  const capText = valued ? `¥${fmt(D.marketCap)}` : '—';
  const peText = valued ? `PE ${D.pe.toFixed(0)} 倍` : 'PE —';
  /**
   * 世界格的**第三行** —— 原来写「未上市 / 已上市」，2026-09-28 起换成
   * **「距下一轮融资的时间进度」**（用户诉求 #8：「距 xx 天使轮 b轮等 改为百分比 xx%」）。
   *
   * 口径取**时间进度** = `(今年 − 上一轮年份) / (本轮年份 − 上一轮年份)`：
   * 融资轮本来就是按**年份**触发的（`finance.ROUNDS[].year`），所以时间进度是唯一
   * 会自然走到 100% 的口径（按市值算永远差一点，因为推进到下一轮还要看门槛）。
   * 天使轮的「上一轮年份」用公司成立那年（`WORLD_START_YEAR` = 2026）。
   *
   * ⚠️ **只剩 `ipo` 那一轮时回到「距上市 ×N」** —— IPO 是**市值门槛**（`D.marketCap ≥ IPO_LINE`），
   *    与年份无关，写成「距 IPO xx%」是假的。这是唯一一处「跨阶段」的正确口径。
   * ⚠️ 轮次名里的空格要**去掉**（`Pre-A 轮` → `Pre-A轮`，`Pre-IPO` 本来就是连写）：
   *    这一行实测最宽的是 `距Pre-IPO 100%`（≈81px），而世界半格改成 54% 后有 82px。
   * ⚠️ `距上市 ×N` **只保留整数**：一位小数会写出 `×41.7万`，会溢出。
   *
   * ⚠️ **上市之后这一行留空**（用户 2026-09-28 裁决）：原来那行「已上市」与页头的
   *    公司名（那时会写成 `Abstract Inc`；现在按章查表，第 7 章起叫 `Abstra`）是同一件事说两遍。
   */
  let worldSub = '';
  if (!listed) {
    const i = ROUNDS.findIndex(x => !s.finance.rounds.includes(x.id));
    const nr = ROUNDS[i];
    if (nr && nr.id !== 'ipo') {
      const fromY = i > 0 ? ROUNDS[i - 1].year : WORLD_START_YEAR;
      const span = Math.max(1, nr.year - fromY);
      const pct = Math.round(Math.max(0, Math.min(1, (yearNow(s) - fromY) / span)) * 100);
      worldSub = `距${nr.name.replace(/\s+/g, '')} ${pct}%`;
    } else {
      worldSub = `距上市 ×${fmt(IPO_LINE / D.marketCap, 0)}`;
    }
  }
  return `
  <div class="hud">
    <span class="cell"><i>现金<em>${rateOf(liveNet(s, R.netPerSec))}</em></i><b>¥${fmt(s.money)}</b><u>可动用 ¥${fmt(D.spendable)}</u><u>储备 ¥${fmt(D.reserve)}</u></span>
    <span class="cell"><i>市值${capLabel}</i><b>${capText}</b><u>年营收 ¥${fmt(D.revenue)}</u><u>相比上月 ${valued && mom != null ? dirEm(mom) : '—'}</u></span>
    <span class="cell"><span class="half"><i>净利率</i><b>${(R.margin * 100).toFixed(0)}%</b><u>${peText}</u></span><span class="half"><i>世界</i><b class="${rankClass(r)}">${ranked}${worldDelta}</b><u>${worldSub}</u></span></span>
    <span class="cell goal"><i>本阶段目标${goal ? '<em class="ok">完成</em>' : ''}</i><b${goal ? ' class="done"' : ''}>${esc(a.goal)}</b><u>${esc(who)}</u></span>
  </div>`;
}

/**
 * 世界格那个名次的**分色档位**（用户 2026-09-27：「可以把世界的框的排名，不同排名有不同颜色」）。
 *
 * 先澄清一件事：名次**本来就显示**在世界格里（那个 `<b>#42</b>`），
 * 但它一直没有 `color` —— `.hud .cell b` 只定了字号，所以 `#1` 和 `#100` 是同一个白。
 * 这一档是**正在新增的信息**，不是把已有的东西再说一遍。
 *
 * ⚠️ **只换色相，一个字都不能加**：那半格实测可用宽度只有 **73px**（`.hud .cell` 177px × 48%），
 *    `#100` 已经是 30px，再加「第一」「前三」这类字立刻横向溢出（`npm run shots` 会红）。
 * ⚠️ 色相全部复用现有变量（`--gold` / `--accent` / `--ok` / `--fg` / `--mut`），**不新增调色板** ——
 *    与日志着色同一条原则：只换色相、饱和度都收着，别让 HUD 变成圣诞树（LESS IS MORE）。
 * ⚠️ 开局未上市 / 名次在 100 开外时 `r` 为假值，一并走 `rk-out`（压暗）。
 */
function rankClass(r) {
  if (!r || r > RANK_MAX) return 'rk-out';     // >100 / 未上市 —— 压暗
  if (r === 1) return 'rk-1';                  // 世界第一
  if (r <= 3) return 'rk-3';                   // 前三
  if (r <= 10) return 'rk-10';                 // 前十
  return 'rk-100';                             // 已入榜
}

// ─────────────────────────── 五条投资线 ───────────────────────────
/**
 * 一行一条线：按钮（谁负责）+ 累计效果 + 下一次的成本。
 * **不显示等级** —— 五条线共用同一条成本曲线，等级只是一个运营视角的内部计数，
 * 对玩家没有决策价值（真正要看的是「效果」和「多少钱」）。
 *
 * @param {string[]} ids 本页要画哪几条（公司页 `c/d`、创始人页 `r/m/h`）
 */
function lines(s, R, dis, ids) {
  const rows = ids.map(id => {
    const l = LINES.find(x => x.id === id);
    const cost = manualCostOf(s, id);
    const ok = canAffordManual(s, id);
    // 「份额」显示的是百分比（它是派生量，不是乘数）；其余显示累计乘数
    const value = id === 'm'
      ? `${sharePctOf(R.revenue, gameYear(s)).toFixed(1)}%`
      : `×${R.effect[id].toFixed(2)}`;
    return `
    <div class="line">
      <button class="btn${ok ? '' : ' dim'}" data-buy="${l.id}"${dis}>${esc(lineName(l, s.stage))}<em>${esc(l.who)}</em></button>
      <span class="val">${esc(l.label)} ${value}</span>
      <span class="cost">¥${fmt(cost)}</span>
    </div>`;
  }).join('');
  return `<div class="lines">${rows}</div>`;
}

// ─────────────────────────── 订单页 ───────────────────────────
/**
 * 在手订单（≤ `ORDER_SLOTS` 条）：报酬 = **当前年营收 × 等级系数 × 客户系数 × 形态系数**，
 * 所以数字是活的。大单（等级 ≥ 第 4 档）整行加亮，页签同时 `.hot` ——「有一条大的在等」
 * 是唯一需要玩家现在就动手的信号。
 *
 * **一条单占两行**（用户 2026-09-27「字太长可以改为两行」）：
 *   第一行 = 甲方真名 + 报酬（钱是决策依据，跟名字放一起好比较）；
 *   第二行 = **形态** + 交付内容 + 剩余月数 + 交付按钮。
 * 拆行的原因很实在：`上海汽车集团股份有限公司 · 集团数据中台迁移 · 剩余 11 个月`
 * 这一串在手机上必然折行，而**折在哪一行由字数决定**，于是每条单的版式都不一样。
 * 固定成两行之后，甲方永远对齐在第一行、按钮永远对齐在第二行右端。
 * 行与行之间加分割线（`.order + .order`），因为现在每条单有 2 行，光靠留白分不开。
 *
 * ⚠️ **标签只有两个**（用户 2026-09-27 裁决）：甲方公司名 + **形态**。
 *    等级（6 档）与客户类别（4 类）只进数值、不进文案 —— 玩家从甲方名字的量级读数就够了。
 *
 * 右上是**累计已交付的订单数**（`orders.done`）—— 它给的是「这家公司一直在干活」的
 * 手感，不是任何机械效果（订单只给现金，GDD §1.2）。
 */
function orderBlock(s, R, dis) {
  const live = liveOf(s);
  const rows = live.map(o => {
    const { client, work, form } = describeOrder(o);
    return `
    <div class="order${isHot(o) ? ' hot' : ''}">
      <div class="o-nm">
        <span class="onm">${esc(client)}</span>
        <span class="oamt">¥${fmt(valueOf(R, o))}</span>
      </div>
      <div class="o-act">
        <span class="owk">${esc(form.name)} · ${esc(work)} · 剩余 ${monthsLeftOf(s, o)} 个月</span>
        <button class="btn" data-order="${o.uid}"${dis}>交付</button>
      </div>
    </div>`;
  }).join('');
  return `
  <div class="orders">
    <div class="o-head"><span>在手订单 <b>${live.length}</b> / ${ORDER_SLOTS} 条</span><span>已完成 <b>${doneCount(s)}</b> 单</span></div>
    ${live.length ? rows : '<div class="o-empty">暂时没有在手的单子。</div>'}
  </div>`;
}

// ─────────────────────────── 世界市值榜（§1.4）───────────────────────────
/**
 * 展开详情的那一行 —— key = 玩家行写 `'me'`，其余写公司名（见 `rankBlock` 的 `row`）。
 * ⚠️ 与 `tab` / `deleteArmed` 同规矩：`render()` 是全量重建，这个态**必须住在模块里**，
 *    留在 DOM 的 class 上活不过一帧。
 * 不进存档：它是一次查看动作，不是游戏状态。
 */
let rankSel = null;
/** 点同一行 = 收起（第二次点同一个 key 就把选中清掉） */
export function setRankSel(k) { rankSel = rankSel === k ? null : k; }

/**
 * 环比列（用户 2026-09-27：「对比上个月涨了 xx%、跌了 xx%，就像排行榜上升、下降那样」）。
 * 三种情况**留空**，因为写出来是噪声而不是信息：
 *   ① 本月新入场 —— 它的 `prev` 是**上市估值**，根本没有「上个月」可比（`ranking` 已标 `isNew`）；
 *   ② 涨跌小到只会写成 `+0.0%`；
 *   ③ 玩家第一帧 / 旧档 —— 没有上月末快照。
 */
function momTextOf(c) {
  if (c.isNew || !(Math.abs(c.mom) >= 0.0005)) return '';
  return dirEm(c.mom);
}

/**
 * 展开的详情一行（用户 2026-09-27：「世界榜公司详情 / 行业可见」）。
 * 只说榜上看不出来的事：**行业**、**国家**、**哪一年入场**（`born` 只有 IPO 池与黑马才有，
 * 100 家老公司开局就在榜上，不写）。环比与名次变化**不重复** —— 它们已经在行里了。
 * ⚠️ 玩家行的行业是 `ranking` 为了排序临时塞的 `'space'`，不是事实 ⇒ 那一行不报行业。
 */
function detailOf(c) {
  const bits = c.me ? ['中国', '你的公司'] : [`行业 ${SECTOR_LABEL[c.s] || c.s}`, c.co];
  if (c.born != null) bits.push(`${WORLD_START_YEAR + Math.floor((c.born - 1) / 12)} 年入场`);
  return `<div class="rdet">${bits.map(esc).join(' · ')}</div>`;
}

/**
 * 前 20 名 + （上市且掉在 20 名开外时）把玩家钉在列表底部单独一行。
 * 玩家那一行显示的是**公司名**（不是「我们」）并整行加亮 —— 榜单是给玩家看自己爬到哪儿的。
 *
 * 每行是**一个按钮**（`data-rank`）：点开在行下方展开 `detailOf` 那一行。
 * 整行做靶子而不是只让公司名可点 —— 手机上 34px 宽的名次列也是能按到的。
 * 卡片头上那行「当前最热」与周期播报同源（`hotSector`）—— 榜上写的和播报说的必须是同一件事。
 * ⚠️ 原先是「当前最热：X · 点一行看详情」，**「点一行看详情」半句已删**（用户 2026-09-27，
 *    LESS IS MORE）：操作提示是「可以没有的说明」，而「最热」是信息，只能留一个。
 */
function rankBlock(s, D) {
  if (!s.world) return '<div class="rank"><div class="rank-head"><span>世界市值榜</span><span>单位：万亿美元</span></div></div>';
  const listed = isListed(s);
  const cap = listed ? toUSD_T(D.marketCap) : null;
  /**
   * **月内进度** —— 榜单里每一家的 `cur` 与名次都按它插值（用户 2026-09-28
   * 「回味期的数字变换不够丝滑，隔月就硬切了……其他公司市值也可以同样处理」）。
   * ⚠️ **环比列不插值**（`ranking` 里已写明理由）：它是整月的事实，插值会得到「月初 0%」。
   *
   * `s.world.month` 恒 = `floor(s.calMonth)`（`worldTick` 里就是这样推的）⇒ 这个差天然落在
   * `[0, 1)`，跨月那一帧趋近 1、下一帧回到 0，曲线**连续**。
   * 玩家自己的市值（`D.marketCap`）本来就逐帧连续（回味期锚在插值后的榜首上，见 `worldTopAt`）
   * ⇒ 两边同一节奏，不会再出现「自己的数字在滑、别人的数字在跳」。
   *
   * ⚠️ **只在回味期插值**（`s.ending`）。正常段（含冲刺段）取 1 = 月末口径，与
   *    `worldTick` 写下的 `s.worldRank` 逐位一致 —— 那两处**同屏**（HUD 的 `#9 ↑3` 与
   *    榜单自己那一列），任何相位差都会变成「两个地方报不同名次」。
   *    正常段之所以不需要插值：玩家自己的市值也踩在月度网格上（`valAt(gameMonths)`），
   *    整榜一起按月跳；只有回味期玩家市值改锚到连续曲线上，才必须让别家也连续。
   */
  const frac = s.ending
    ? Math.max(0, Math.min(1, (s.calMonth || 0) - (s.world.month || 0)))
    : 1;
  const { top, all } = ranking(s.world, cap, RANK_SHOW, s.worldPrevCap ?? null, frac);
  const me = all.find(c => c.me);
  const mine = companyName(s.stage);   // 公司名按**章**查表（`content.NAME_TIERS`，五段阶梯）
  const row = c => {
    const key = c.me ? 'me' : c.n;
    const showDelta = !(c.me && c.rank > RANK_MAX);
    return `
    <button class="row${c.me ? ' me' : ''}" data-rank="${esc(key)}">
      <span class="no">${rankText(c.rank)}</span>
      <span class="nm">${esc(c.me ? mine : c.n)}</span>
      <span class="dlt">${showDelta ? deltaOf(c) : ''}</span>
      <span class="mom">${momTextOf(c)}</span>
      <span class="cap">${tUsd(c.cur)}</span>
    </button>${rankSel === key ? detailOf(c) : ''}`;
  };
  const rows = top.map(row).join('');
  // 名次 > 20 时钉在列表底部单独一行（上市后才会出现）；100 名开外只报「>100」
  const pin = me && me.rank > RANK_SHOW ? `<div class="sep">⋯</div>${row(me)}` : '';
  return `
  <div class="rank">
    <div class="rank-head">
      <span>世界市值榜<em>当前最热：${esc(SECTOR_LABEL[hotSector(s.world.month)] || '—')}</em></span>
      <span>单位：万亿美元</span>
    </div>
    ${rows}${pin}
  </div>`;
}

// ─────────────────────────── 待决事件（§1.5）───────────────────────────
/**
 * 选项上的**效果数字**：文案讲的是故事，数字讲的是代价 —— 缺了后者，玩家是在盲选。
 * `cash` 的单位是**年营收**（见 content.js），所以写成百分比而不是绝对值。
 */
function effText(eff) {
  const NAME = { prod: '产品力', share: '份额', team: '团队效率', pe: '市盈率' };
  return Object.entries(eff).map(([k, v]) => {
    if (k === 'cash') return `现金 ${v > 0 ? '+' : '−'}${(Math.abs(v) * 100).toFixed(1)}% 年营收`;
    // 市盈率的单位是「倍」（与 HUD 里 `PE 12 倍` 同一个写法）—— 只写数字会被读成百分比
    if (k === 'pe') return `${NAME[k]} ${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} 倍`;
    return `${NAME[k]} ×${v.toFixed(3)}`;
  }).join(' · ');
}

/**
 * **在线不弹窗** —— 待决事件就长在主界面里：角标是数量，正文是第一条，
 * 选项直接点。积压上限 `PENDING_CAP` 条，超出部分由引擎按默认选项结算。
 */
function pendingBlock(s, dis) {
  if (!s.pending.length) return '';
  const ev = pendingEvent(s);
  if (!ev) return '';
  const uid = s.pending[0].uid;
  const opts = ev.options.map((o, i) =>
    `<button class="opt" data-opt="${uid}:${i}"${dis}>${esc(o.text)}<em class="eff">${esc(effText(o.eff))}</em></button>`).join('');
  return `
  <div class="pending">
    <div class="p-head">待决 <b>${s.pending.length}</b> / ${PENDING_CAP} 条</div>
    <div class="p-title">${esc(ev.title)}</div>
    <div class="p-body">${esc(ev.body)}</div>
    <div class="p-opts">${opts}</div>
  </div>`;
}

// ─────────────────────────── 日志着色 ───────────────────────────
/**
 * 日志条目的**分类着色**（用户 2026-09-27：不同条目用不同颜色，方便区分）。
 *
 * 分类只认行首那个 `【标签】` —— 那是各模块写日志时唯一稳定的结构
 * （`finance` 写融资轮名、`engine` 写阶段地名与年份、`orders` 写「订单」…）。
 * 标签表由**数据源本身**拼出来（`ROUNDS` / `MILESTONES` / `ACTS`），所以以后
 * 改轮次名、加里程碑，颜色自己就跟上了，不用在这里再抄一份。
 */
const LOG_TAGS = new Map([
  ...ACTS.filter(Boolean).map(a => [a.place, 'act']),                        // 推幕：2030年【车库】借来的车库…
  ...ROUNDS.map(r => [r.name, 'fin']),                                       // 融资：【A 轮】到账…
  ...MILESTONES.map(m => [m.text.slice(1, m.text.indexOf('】')), 'mile']),   // 叙事里程碑
  ['改名', 'fin'],
  ['订单', 'ord'],
  ['决策', 'dec'],
  ['登顶', 'top'],
  // 决胜段减速的**回执**（`world.worldTick` 在 `worldBest` 首次 ≤ `DIL_AT` 时写一条）——
  // 与「登顶」同色：两条都标志终局那一段。
  ['决胜', 'top'],
  // 市值榜的三层周期（`world.cycleNotes` 写出来的）—— 与「世界第 N」那条青色的名次播报分开：
  // 名次是**结果**，这几条是**原因**（大盘起落 / 行业轮动 / 黑天鹅）。
  ['大盘', 'cyc'],
  ['轮动', 'cyc'],
  ['黑天鹅', 'cyc'],
]);

/** 年度报告写的是**日历 20xx 年**（`engine.annualReport`），单独一档压暗 */
const YEAR_TAG = /^【20\d\d 年】/;
/** 名次播报的 N 是变量，正则匹配 */
const WORLD_TAG = /^【世界第 \d+】/;

/** 给一行日志挑颜色；认不出来的（含 `（回忆）…` 这类无前缀的文案）走兜底色 */
function logClass(t) {
  if (YEAR_TAG.test(t)) return ' yr';
  if (WORLD_TAG.test(t)) return ' world';
  /**
   * ⚠️ 推幕行 2026-09-27 起带**年份前缀**（`2030年【车库】…`，用户拍板「可加年份」），
   *    标签不再一定在行首 —— 先把 `20xx年` 摘掉再认，否则 `.li.act` 那一档会静默丢色。
   *    （`YEAR_TAG` 是另一回事：年度报告写的是 `【2042 年】`，括号在里面。）
   */
  const body = t.replace(/^\d{4}\s*年/, '');
  const i = body.indexOf('】');
  const tag = body.startsWith('【') && i > 1 ? body.slice(1, i) : '';
  return LOG_TAGS.has(tag) ? ` ${LOG_TAGS.get(tag)}` : '';
}

// ─────────────────────────── 主渲染 ───────────────────────────
/**
 * 登顶之后**只剩回看**（用户 2026-09-28）：时间**慢放**到近乎停住（`content.SAVOR_RATE`，
 * 现实 2 秒 = 游戏 1 秒），HUD 上的数字还在跳，直到玩家自己点「退休」——
 * 买卖与倍速因此全部 `disabled` / 撤掉（`bind.js` 的派发会跳过 disabled 元素）。
 * 「设置」不禁：它是删档的唯一入口。
 * ⚠️ 「退休」按钮已删（用户 2026-09-27），取而代之的是 HUD 上面那条通栏横条（见下），
 *    它是**结局弹窗唯一的手动入口** —— 登顶那一刻不再自动糊一张弹窗上去，那会打断回味。
 */
export function render(root, s) {
  const R = rates(s);
  const D = derived(s, R);
  const a = ACTS[s.stage] || ACTS[1];
  /**
   * **操作锁** = 回味期 ∪ 冲刺段（用户 2026-09-28：「登顶前无法操作，但是能选择加速」）。
   *
   * 冲刺段从**第 8 章**起（`isSprint`）：那一章没有年度决策（`AUTO_DECIDE_STAGE = 7`），
   * 玩家剩下的「点投资线 / 点订单」本来就由自动购买与自动交付包办（`check --idle` 零决策
   * 照样通关）⇒ 锁的不是玩法，而是「必须自己去点 tab 才看得到市值榜」这层摩擦。
   * `main.js` 的 handler 有同一把锁（渲染层只是把按钮画灰，真正拦下动作的是那边）。
   */
  const dis = (s.ending || isSprint(s)) ? ' disabled' : '';
  /** 只有回味期才需要禁用的东西（页头工具区）—— 冲刺段还要留着加速 */
  const endDis = s.ending ? ' disabled' : '';
  /**
   * 决胜段（`worldBest ≤ DIL_AT`）**倍速按钮整组撤掉**（用户 2026-09-27：「减速带的时候，
   * 倍速的按钮要消失」）。减速因子乘在 `s.speed` **之外**（见 `content.DIL_MIN`）⇒ 此刻能拿到的
   * 只有 `7.2× … 4×`，而按钮上写着 `1× / 4× / 8×` —— 留着它就是在**撒谎**（点 8× 得到 4×）。
   * 撤掉，就是「关不掉」这件事的可见形态；`.log` 里那条 `【决胜】时间放慢。` 是它的回执。
   * ⚠️ 用**撤掉**而不是 `disabled`：`disabled` 还占着位置、还暗示「等一等就能点」，
   *    而这是**终局规则** —— 到登顶为止都不会回来（登顶后 `worldBest = 1`，同样撤掉，正好一串到底）。
   *
   * ⚠️ **冲刺段例外**（用户 2026-09-28：「最后的登顶有点太慢了……我感觉也可以改为类似回味期一样，
   *    登顶前无法操作，但是能选择加速」）：第 8 章里操作已经锁了（`dis`），玩家的唯一动作就是
   *    「看着自己往上爬」——此时把加速拿掉，等于在最想加速的地方把加速收走（第八批 §3 的
   *    「按钮在撒谎」只适用于**操作还开着**的时候）。
   *    做法是**把原本那三个按钮还给他**，不加新控件、不加新状态：此刻能拿到的确实是
   *    `8 × dilate`（≈4×~7.2×），而按钮只是「再快一点」的意思 —— 玩家自己也清楚
   *    终局会慢下来。**登顶之后（回味期）维持撤掉**：那时 `SAVOR_RATE` 完全无视 `s.speed`，
   *    留着按钮才是真撒谎。
   */
  const slowed = dilate(s) < 1;
  /** 页头倍速按钮要不要出现：回味期撤掉；冲刺段（含减速带）保留 */
  const showSpeeds = !s.ending && (isSprint(s) || !slowed);

  /**
   * **登顶之后 / 冲刺段只剩市值榜**（第九批 §6 + 用户 2026-09-28）：其余三个页签 `disabled`
   * （`bind.js` 的派发会跳过 `disabled` 元素），而且**正文一律改画市值榜** ——
   * 否则玩家那一刻若正停在「公司」页，页签已经点不动了，却还看着那一页的残影。
   * 买卖 / 待决此时本来就已经 `disabled`，于是页面上可点的只剩「市值榜」与加速 / 退休。
   */
  const page = (s.ending || isSprint(s)) ? TAB_RANK : tab;

  if (root.style && root.style.setProperty) {
    const acc = ACCENT[s.stage] || ACCENT[1];
    root.style.setProperty('--accent', acc);
    // 选中态的**淡底**（`.on` / `.hot`）：八位十六进制 = 主色 + 18% 透明度。
    // 派生的原因见 style.css 顶部 —— 一处声明，倍速 / 页签共用，不必各写一份 rgba。
    root.style.setProperty('--accent-soft', `${acc}2e`);
  }

  /**
   * ⚠️ **滚动的秘密**：本函数是全量重建（`root.innerHTML = …`），`.log` 的 DOM 节点
   *    每 150ms 被销毁重建一次 ⇒ 浏览器把 `scrollTop` 归零 ⇒ 表现就是「日志栏滚不动」。
   *    修法只有一条：重建**前**记下旧节点的 `scrollTop`，重建**后**写回新节点。
   *    （渲染条数同时从 12 提到 `LOG_MAX`：132px 只装 6 行，只画 12 行的话
   *      「能滚」这件事本身就没有意义。）
   */
  const prevLog = root.querySelector ? root.querySelector('.log') : null;
  const keepTop = prevLog ? prevLog.scrollTop : 0;

  const log = s.log.slice(-LOG_MAX).reverse()
    .map(t => `<div class="li${logClass(t)}">${esc(t)}</div>`).join('');

  /**
   * 页签角标 `.hot`（与倍速的 `.on` 同一套视觉，不切页也看得见）：
   *   · **订单页** —— 手上有大单，数字是在手条数；
   *   · **公司页** —— 有待决事件（用户 2026-09-27）。待决卡片就长在公司页里，
   *     玩家没切过去时，页签上这一下是唯一的提醒信号，所以数字也是待决条数。
   */
  const tabs = TABS.map((t, i) => {
    const hot = ((i === TAB_ORDER && hasHot(s)) || (i === TAB_COMPANY && s.pending.length > 0)) ? ' hot' : '';
    const n = i === TAB_ORDER ? liveCount(s) : i === TAB_COMPANY ? s.pending.length : 0;
    // 登顶后 / 冲刺段其余三个页签一律 disabled（`page` 已经锁定在市值榜，见上）
    const off = (s.ending || isSprint(s)) && i !== TAB_RANK ? ' disabled' : '';
    return `<button class="tab${i === page ? ' on' : ''}${hot}" data-tab="${i}"${off}>${esc(t)}${n ? ` ${n}` : ''}</button>`;
  }).join('');

  /** 待决卡片长在「公司」页（用户 2026-09-27 修正：不挪去创始人页，改用页签角标提醒） */
  const body = page === TAB_COMPANY ? `${lines(s, R, dis, PAGE_LINES[TAB_COMPANY])}${pendingBlock(s, dis)}`
    : page === TAB_FOUNDER ? lines(s, R, dis, PAGE_LINES[TAB_FOUNDER])
    : page === TAB_ORDER ? orderBlock(s, R, dis)
    : rankBlock(s, D);

  /**
   * 页头 = **一行**（用户 2026-09-27）：左边是公司名 + 副行（日期 · 章节地标），右边只留工具区。
   * 两处让位：① 日期从公司名**右侧**挪到**下方**；② 「退休」按钮从页头**挪走**。
   * 左边只剩公司名，工具区就永远放得下，`.head` 得以 `flex-wrap: nowrap`。
   *
   * ⚠️ 「退休」按钮**只在登顶之后出现**（用户 2026-09-27 明确两次）：它是旧版那条
   *    「已登顶 · 时间冻结」横条的**替身** —— 同一个位置（HUD 正上方）、同一个条件（`s.ending`），
   *    只是把静态提示换成了可点的按钮（点开重看结局）。**不是常驻按钮。**
   */
  root.innerHTML = `
  <header class="head">
    <div class="brand">
      <b>${esc(companyName(s.stage))}</b>
      <span>${gameDate(s)} · ${esc(a.place)}</span>
    </div>
    <div class="tools">
      ${showSpeeds ? SPEEDS.map(v => `<button class="ic${s.speed === v ? ' on' : ''}" data-speed="${v}"${endDis}>${v}×</button>`).join('') : ''}
      <button class="ic" data-settings="1">⚙</button>
    </div>
  </header>
  ${s.ending ? '<button class="retire" data-retire="1">退休</button>' : ''}
  ${hud(s, R, D)}
  <div class="tabs">${tabs}</div>
  ${body}
  <div class="log">${log}</div>`;

  if (keepTop > 0) {
    const el = root.querySelector ? root.querySelector('.log') : null;
    if (el) el.scrollTop = keepTop;
  }
  return { R, D };
}

// ─────────────────────────── 弹窗 ───────────────────────────
/**
 * 关掉弹窗层 —— **唯一的关闭实现**（`main.js`、`click-sim`、`probes` 都调它）。
 *
 * ⚠️ **必须把 overlay 清空，不能只摘掉 `.modal`。**
 *    下面四个 `renderXxx` 写进去的模板首尾各有一组换行 + 缩进，那是**文本节点**；
 *    只摘 `.modal` 会在 overlay 里留下一个空白文本节点，而 `#overlay:empty`
 *    走的是 **Selectors Level 3** 语义 —— 浏览器**都不忽略**空白节点（MDN 明确写过），
 *    所以遮罩层不会消失。后果是两级：
 *      ① 屏幕上留一层 `rgba(0,0,0,.6)` 的黑幕；
 *      ② 它还是 `position:fixed; inset:0; z-index:10`，**把整页的点击都吃掉** ——
 *         表现就是「关掉弹窗后倍速 / 退休按钮点了没反应」。
 */
export function closeModal(overlay) {
  if (overlay) overlay.innerHTML = '';
}

/** 离线回来**只有一份报告**（§1.7） */
export function renderOffline(overlay, off) {
  const rep = off.report;
  const row = (k, v) => `<div class="kv"><i>${k}</i><b>${v}</b></div>`;
  const html = `
  <div class="modal">
    <div class="m-head">离开的这段时间</div>
    <div class="m-body">
      ${row('离线时长', `${(off.capped / 3600).toFixed(1)} 小时${off.cappedOut ? '（已按 8 小时上限）' : ''}`)}
      ${row('等效游戏时间', `${(off.equiv / 60).toFixed(1)} 分钟`)}
      ${rep ? row('推进', `${rep.stageFrom} → ${rep.stageTo} 阶段 · 现金 ¥${fmt(rep.cashGained)}`) : ''}
      ${rep && rep.overflowed ? row('按默认处理', `${rep.overflowed} 条`) : ''}
      ${rep ? row('待决', `${rep.pending} 条`) : ''}
    </div>
    <div class="m-opts"><button class="opt" data-close="1">知道了</button></div>
  </div>`;
  overlay.innerHTML = html;
}

/**
 * 设置（音效开关 + 两步删档）。
 * `data-audio` 走与其它按钮**同一条** `data-*` 委托（`ACTION_KEYS` 里有 `audio`），
 * 所以它在 `probes` 的「渲染出的动作键全部落在 ACTION_KEYS 内」里也被审到。
 * ⚠️ 音效开关**关掉弹窗**是错的（用户 2026-09-26：点完要看得到结果），所以这里只重画弹窗。
 */
export function renderSettings(overlay, s) {
  const armed = deleteSaveArmed();
  const on = s.sfx !== false;
  overlay.innerHTML = `
  <div class="modal">
    <div class="m-head">设置</div>
    <div class="m-opts">
      <button class="opt" data-audio="1">音效：${on ? '开' : '关'}</button>
      <button class="opt danger" data-delete="1">${armed ? '再点一次，全部数据将被删除' : '删除全部数据'}</button>
      <button class="opt" data-close="1">关闭</button>
    </div>
  </div>`;
  return armed;
}

/** 唯一结局：登顶 */
export function renderEnding(overlay, s) {
  const t = ENDING_TEXT.top;
  overlay.innerHTML = `
  <div class="modal">
    <div class="m-head">${esc(t.title)}</div>
    <div class="m-body">
      <p class="line-quote">${esc(t.line)}</p>
      <p>${esc(t.body).replace(/\n/g, '<br>')}</p>
      <p class="mut">${esc(t.epilogue)}</p>
    </div>
    <div class="m-opts"><button class="opt" data-close="1">关灯</button></div>
  </div>`;
}

/**
 * 点了「退休」但还没登顶：**只提示，不结束游戏**。
 * ⚠️ 这里**没有**「名次」以外的信息 —— 它只是一句「第一行还不是你们的」，
 *    真正的进度在 HUD 与市值榜里，弹窗不重复。
 */
export function renderNotTop(overlay, rank) {
  overlay.innerHTML = `
  <div class="modal">
    <div class="m-head">还差一点</div>
    <div class="m-body"><p>现在是世界第 <b>${rank ?? '—'}</b> 名。第一行还不是你们的。</p></div>
    <div class="m-opts"><button class="opt" data-close="1">继续经营</button></div>
  </div>`;
}

// ─────────────────────────── 删档两步确认 ───────────────────────────
/**
 * 删档是**不可恢复**的（只有一个 localStorage key），所以必须两步。
 * 武装态住在模块级（不进存档）：它是一次交互，不是游戏状态。
 */
let deleteArmed = false;
export function armDeleteSave() { deleteArmed = true; }
export function disarmDeleteSave() { deleteArmed = false; }
export const deleteSaveArmed = () => deleteArmed;
