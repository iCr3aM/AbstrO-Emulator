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
  IPO_LINE,
} from '../core/content.js';
import { rates, derived, manualCostOf, canAffordManual, sharePctOf } from '../core/economy.js';
import { ORDER_SLOTS, liveOf, liveCount, hasHot, isHot, monthsLeftOf, valueOf, describeOrder, doneCount } from '../core/orders.js';
import { ranking, toUSD_T, SECTOR_LABEL, hotSector, WORLD_START_YEAR } from '../core/world.js';
import { isListed, ROUNDS, yearNow } from '../core/finance.js';
import { gameDate, gameYear } from '../core/format.js';
import { pendingEvent, stageGoalMet, LOG_MAX } from '../core/engine.js';
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
 *    其余三格 2026-09-27 也补满了第 4 行（见下），现在四格**都是 4 行**，
 *    `style.css` 里 `.hud .cell` 按 4 行预算锁死高度，四格同高。
 * 三位创始人的年龄挂在目标格的副行（他们不进任何公式，只是叙事）。
 *
 * **2026-09-27 补第三行**（用户：「市值那一个框现在不是三行吗？可是只显示了两行」）：
 * 现金格本来就占满 4 行，其余三格各空一行 ⇒ 现在逐格补上，四格全部 4 行、正好填满 72px：
 *   · 市值格   → `环比 ±x.x%`（与市值榜里玩家行同一个数，见 `capMomOf`）
 *   · 净利率格 → `净利 ¥X`（`R.net` = 年营收 − 年支出，口径与上面的 `年营收` 对得上）
 *   · 世界格   → 未上市写「距下一轮融资 N年」（只剩 IPO 时写 `距上市 ×N`）；上市写名次环比（见下）
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
  /**
   * ⚠️ **上市前不进榜**（GDD §1.4）：名次只在 IPO 之后显示。
   * `s.worldRank` 本身一直在算（结局判据要用），但「显示」是另一条规则。
   * 进了榜但排在 100 名开外 ⇒ 只报 `>100` —— 具体是 137 还是 152 对玩家没有信息量。
   */
  const listed = isListed(s);
  const r = s.worldRank;
  const ranked = listed ? (r && r <= RANK_MAX ? `#${r}` : `>${RANK_MAX}`) : '—';
  const mom = capMomOf(s, D);
  /**
   * 世界格的第四行 —— **没上市做「下一轮融资倒计时」，上市了说「名次比上个月动了几名」**。
   *
   * 未上市这一段（用户 2026-09-27 二次裁决）：原来写 `距上市 ×7954`（差多少倍市值），
   * 数字虽准，但开局是「×7954」这种八千倍的数，读起来只有「还早得很」，没有目标感。
   * 改成**下一轮融资的倒计时**：`距天使轮 5年` / `距Pre-A轮 6年` … `距C轮 3年`。
   * ⚠️ **只剩 `ipo` 那一轮时回到「距上市 ×N」** —— IPO 是**市值门槛**（`D.marketCap ≥ IPO_LINE`），
   *    与年份无关，写成「距 IPO N 年」是假的。这也是唯一一处「跨阶段」的正确口径。
   * ⚠️ 轮次名里的空格要**去掉**（`Pre-A 轮` → `Pre-A轮`）：半格实测可用宽度仅 73px，
   *    带空格时 `Pre-A 轮 6年` 是 75px、`距 Pre-IPO 7年` 是 76px，都会横向溢出（`npm run shots`）。
   *    去空格后 `距Pre-IPO 7年` / `距Pre-A轮 6年` 都恰好 73px。
   *
   * ⚠️ 名次在 100 名开外时**这一行留空**（用户 2026-09-27 拍板），与榜单里玩家行同一条规矩：
   *    那个区间每天在漂，↑3 / ↓5 只是噪声，反而让人以为有事发生。（格子高度是锁死的，留空不会跳。）
   * ⚠️ `距上市 ×N` **只保留整数**：一位小数会写出 `×41.7万`（77px），同样溢出。
   */
  let worldSub = '';
  if (!listed) {
    const nr = ROUNDS.find(x => !s.finance.rounds.includes(x.id));
    worldSub = nr && nr.id !== 'ipo'
      ? `距${nr.name.replace(/\s+/g, '')} ${Math.max(0, nr.year - yearNow(s))}年`
      : `距上市 ×${fmt(IPO_LINE / D.marketCap, 0)}`;
  } else if (s.worldRankPrev != null && r && r <= RANK_MAX) {
    const d = s.worldRankPrev - r;                     // 正数 = 排名前进（与榜单 `rankDelta` 同向）
    worldSub = d > 0 ? `名次 <em class="up">↑${d}</em>`
      : d < 0 ? `名次 <em class="down">↓${-d}</em>`
      : '名次持平';
  }
  return `
  <div class="hud">
    <span class="cell"><i>现金<em>${rateOf(R.netPerSec)}</em></i><b>¥${fmt(s.money)}</b><u>可动用 ¥${fmt(D.spendable)}</u><u>储备 ¥${fmt(D.reserve)}</u></span>
    <span class="cell"><i>市值</i><b>¥${fmt(D.marketCap)}</b><u>年营收 ¥${fmt(D.revenue)}</u><u>环比 ${mom == null ? '—' : dirEm(mom)}</u></span>
    <span class="cell"><span class="half"><i>净利率</i><b>${(R.margin * 100).toFixed(0)}%</b><u>PE ${D.pe.toFixed(0)} 倍</u><u>净利 ¥${fmt(R.net, 0)}</u></span><span class="half"><i>世界</i><b>${ranked}</b><u>${listed ? '已上市' : '未上市'}</u><u>${worldSub}</u></span></span>
    <span class="cell"><i>本阶段目标${goal ? '<em class="ok">完成</em>' : ''}</i><b${goal ? ' class="done"' : ''}>${esc(a.goal)}</b><u>${esc(who)}</u></span>
  </div>`;
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
    <div class="o-head"><span>在手订单 <b>${live.length}</b> / ${ORDER_SLOTS} 条</span><span>已完成 <b>${doneCount(s)}</b> 项</span></div>
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
  const { top, all } = ranking(s.world, cap, RANK_SHOW, s.worldPrevCap ?? null);
  const me = all.find(c => c.me);
  const mine = companyName(listed);
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
  ...ACTS.filter(Boolean).map(a => [a.place, 'act']),                        // 推幕：【车库】2030–2034 起…
  ...ROUNDS.map(r => [r.name, 'fin']),                                       // 融资：【A 轮】到账…
  ...MILESTONES.map(m => [m.text.slice(1, m.text.indexOf('】')), 'mile']),   // 叙事里程碑
  ['改名', 'fin'],
  ['订单', 'ord'],
  ['决策', 'dec'],
  ['登顶', 'top'],
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
  const i = t.indexOf('】');
  const tag = t.startsWith('【') && i > 1 ? t.slice(1, i) : '';
  return LOG_TAGS.has(tag) ? ` ${LOG_TAGS.get(tag)}` : '';
}

// ─────────────────────────── 主渲染 ───────────────────────────
/**
 * 登顶之后**定格**：时间冻结、一切计算暂停（`engine.tick` 会直接返回），
 * 界面只剩回看 —— 所以买卖与倍速按钮全部 `disabled`（`bind.js` 的派发会跳过 disabled 元素）。
 * 「设置」不禁：它是删档的唯一入口。
 * ⚠️ 「退休」按钮已删（用户 2026-09-27）：结局是**自动**触发的（`main.js` 的 `draw()`
 *    在 `s.ending === 'top'` 时弹结局），那个按钮只是同一件事的第二个入口 ——
 *    它占着页头一行，却什么也不多做。删掉之后页头收成一行，空出来的位置留给
 *    「已登顶 · 时间冻结」这条提示（原先它是一整块独立的横条）。
 */
export function render(root, s) {
  const R = rates(s);
  const D = derived(s, R);
  const a = ACTS[s.stage] || ACTS[1];
  const dis = s.ending ? ' disabled' : '';

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
    return `<button class="tab${i === tab ? ' on' : ''}${hot}" data-tab="${i}">${esc(t)}${n ? ` ${n}` : ''}</button>`;
  }).join('');

  /** 待决卡片长在「公司」页（用户 2026-09-27 修正：不挪去创始人页，改用页签角标提醒） */
  const body = tab === TAB_COMPANY ? `${lines(s, R, dis, PAGE_LINES[TAB_COMPANY])}${pendingBlock(s, dis)}`
    : tab === TAB_FOUNDER ? lines(s, R, dis, PAGE_LINES[TAB_FOUNDER])
    : tab === TAB_ORDER ? orderBlock(s, R, dis)
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
      <b>${esc(companyName(isListed(s)))}</b>
      <span>${gameDate(s)} · ${esc(a.place)}</span>
    </div>
    <div class="tools">
      ${SPEEDS.map(v => `<button class="ic${s.speed === v ? ' on' : ''}" data-speed="${v}"${dis}>${v}×</button>`).join('')}
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
