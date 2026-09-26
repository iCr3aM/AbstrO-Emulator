/**
 * 极简 DOM 渲染（主界面两个页签：公司页管投入 · 市值榜页就是排名）
 * ===============================================================
 * 只做「把状态画出来」+「把点击转成一次 action」，不含任何游戏规则。
 *
 * ⚠️ 这里是**全量重建**（`root.innerHTML = ...`）—— 所以任何交互态（展开与否、确认与否）
 *    都必须由本模块持有，不能留在 DOM 里。
 * ⚠️ 只有 `data-*` 一种接线方式，且动作键必须落在 `bind.js` 的 `ACTION_KEYS` 里。
 */

import {
  ACTS, LINES, FOUNDERS, agesAt, PENDING_CAP, SEC_PER_YEAR, companyName, FOCUS,
} from '../core/content.js';
import { rates, derived, costFor, canAfford, sharePctOf } from '../core/economy.js';
import { ranking, toUSD_T } from '../core/world.js';
import { isListed } from '../core/finance.js';
import { gameDate } from '../core/format.js';
import { pendingEvent, stageGoalMet } from '../core/engine.js';
import { ENDING_TEXT } from '../core/endings.js';

/** 阶段配色：只改一个 CSS 变量，整页基调随之推移 */
const ACCENT = [null, '#6ad1c0', '#7bc47f', '#c9b458', '#d98c5f', '#c96a8a', '#8f8fd9', '#e0e0e0'];

/** 倍速档位（页头那三个按钮；`s.speed` 等于哪一档，哪个就点亮） */
const SPEEDS = [1, 4, 8];

// ─────────────────────────── 分页（交互态）───────────────────────────
/** 两个页签：公司（投资线 + 待决）/ 市值榜 */
const TABS = ['公司', '市值榜'];

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

/** 万亿美元口径（世界榜唯一单位） */
const tUsd = v => v.toFixed(v >= 100 ? 0 : 2);

/** 市值榜只显示前 20 名；名次超出 100 只报「>100」（榜单之外的名次没有意义） */
const RANK_SHOW = 20;
const RANK_MAX = 100;

/**
 * 净收入的显示单位 —— **按量级换挡**。
 * 「每秒」在早期是 12 元这种能看懂的数是好的，但到后期就是「每秒 3.70万亿」这种念不出来的东西；
 * 而上万之后换成「每年」（与市值/年营收同一个口径）正好落在可读区间。
 */
function rateOf(v) {
  const sign = v >= 0 ? '+' : '−';
  const a = Math.abs(v);
  return a < 1e4
    ? `每秒 ${sign}${fmt(a)}`
    : `每年 ${sign}${fmt(a * SEC_PER_YEAR)}`;
}

/** 名次变化（`rankDelta` 正数 = 上升；`null` = 本月新入场） */
function deltaOf(c) {
  if (c.isNew) return '<em class="new">新</em>';
  const d = c.rankDelta || 0;
  if (d > 0) return `<em class="up">↑${d}</em>`;
  if (d < 0) return `<em class="down">↓${-d}</em>`;
  return '';                              // 持平不画符号：一屏幕的「─」是纯噪声
}

// ─────────────────────────── 常驻 HUD ───────────────────────────
/**
 * 四格：现金 / 市值 / **净利率＋世界排名（同框，左净利率右排名）** / 本阶段目标。
 * 目标从原来的独立一行收进 HUD —— 那一行里还重复了一次净利率，去掉后没有第二处净利率。
 * 三位创始人的年龄挂在目标格的副行（他们不进任何公式，只是叙事）。
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
  const rank = listed ? (r && r <= RANK_MAX ? `#${r}` : `>${RANK_MAX}`) : '—';
  return `
  <div class="hud">
    <span class="cell"><i>现金</i><b>¥${fmt(s.money)}</b><u>${rateOf(R.netPerSec)}</u></span>
    <span class="cell"><i>市值</i><b>¥${fmt(D.marketCap)}</b><u>年营收 ¥${fmt(D.revenue)}</u></span>
    <span class="cell"><span class="half"><i>净利率</i><b>${(R.margin * 100).toFixed(0)}%</b><u>PE ${D.pe.toFixed(0)}</u></span><span class="half"><i>世界</i><b>${rank}</b><u>${listed ? '已上市' : '未上市'}</u></span></span>
    <span class="cell"><i>本阶段目标</i><b>${esc(a.goal)} <em class="${goal ? 'ok' : ''}">${goal ? '✓' : '·'}</em></b><u>${esc(who)}</u></span>
  </div>`;
}

// ─────────────────────────── 三条投资线 ───────────────────────────
/**
 * 一行一条线：按钮（谁负责）+ 累计效果 + 下一次的成本。
 * **不显示等级** —— 三条线共用同一条成本曲线，等级只是一个运营视角的内部计数，
 * 对玩家没有决策价值（真正要看的是「效果」和「多少钱」）。
 */
function lines(s, R, dis) {
  const rows = LINES.map(l => {
    const cost = costFor(s, l.id);
    const ok = canAfford(s, l.id);
    const value = l.id === 'm' ? `${sharePctOf(R.revenue, s.stage).toFixed(1)}%` : `×${(l.id === 'r' ? R.prod : R.team).toFixed(2)}`;
    return `
    <div class="line">
      <button class="btn${ok ? '' : ' dim'}" data-buy="${l.id}"${dis}>${l.name}<em>${l.who}</em></button>
      <span class="val">${l.label} ${value}</span>
      <span class="cost">¥${fmt(cost)}</span>
    </div>`;
  }).join('');
  return `<div class="lines">${rows}</div>`;
}

// ─────────────────────────── 世界市值榜（§1.4）───────────────────────────
/**
 * 前 20 名 + （上市且掉在 20 名开外时）把玩家钉在列表底部单独一行。
 * 玩家那一行显示的是**公司名**（不是「我们」）并整行加亮 —— 榜单是给玩家看自己爬到哪儿的。
 */
function rankBlock(s, D) {
  if (!s.world) return '<div class="rank"><div class="rank-head"><span>世界市值榜</span><span>单位：万亿美元</span></div></div>';
  const listed = isListed(s);
  const cap = listed ? toUSD_T(D.marketCap) : null;
  const { top, all } = ranking(s.world, cap, RANK_SHOW, s.worldPrevCap ?? null);
  const me = all.find(c => c.me);
  const mine = companyName(listed);
  const row = c => `
    <div class="row${c.me ? ' me' : ''}">
      <span class="no">${c.rank}</span>
      <span class="nm">${esc(c.me ? mine : c.n)}</span>
      <span class="dlt">${deltaOf(c)}</span>
      <span class="cap">${tUsd(c.cur)}</span>
    </div>`;
  const rows = top.map(row).join('');
  // 名次 > 20 时钉在列表底部单独一行（上市后才会出现）；100 名开外只报「>100」
  const pin = me && me.rank > RANK_SHOW
    ? `<div class="sep">⋯</div>${row({ ...me, rank: me.rank <= RANK_MAX ? me.rank : `>${RANK_MAX}` })}`
    : '';
  return `
  <div class="rank">
    <div class="rank-head"><span>世界市值榜</span><span>单位：万亿美元</span></div>
    ${rows}${pin}
  </div>`;
}

// ─────────────────────────── 待决事件（§1.5）───────────────────────────
/**
 * 选项上的**效果数字**：文案讲的是故事，数字讲的是代价 —— 缺了后者，玩家是在盲选。
 * `cash` 的单位是**年营收**（见 content.js），所以写成百分比而不是绝对值。
 */
function effText(eff) {
  const NAME = { prod: '产品力', share: '份额', team: '团队效率', pe: 'PE' };
  return Object.entries(eff).map(([k, v]) => {
    if (k === 'cash') return `现金 ${v > 0 ? '+' : '−'}${(Math.abs(v) * 100).toFixed(1)}% 年营收`;
    if (k === 'pe') return `${NAME[k]} ${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;
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

/**
 * 自动购买的**方向**（§1.6）：玩家不必再盯着三条线轮着点，只需要在这里定一个大方向。
 * 一条线最多领先最低线 `FOCUS_LAG` 级 —— 到线自动回补（见 `engine.nextLine`），
 * 所以「偏科」只能是偏好，不可能是翻车。
 */
function focusBlock(s, dis) {
  const cur = s.focus || 'even';
  const btns = FOCUS.map(f =>
    `<button class="ic${cur === f.id ? ' on' : ''}" data-focus="${f.id}"${dis}>${esc(f.name)}</button>`).join('');
  return `<div class="focus"><span class="fk">自动方向</span>${btns}</div>`;
}

// ─────────────────────────── 主渲染 ───────────────────────────
/**
 * 登顶之后**定格**：时间冻结、一切计算暂停（`engine.tick` 会直接返回），
 * 界面只剩回看 —— 所以买卖与倍速按钮全部 `disabled`（`bind.js` 的派发会跳过 disabled 元素）。
 * 「退休」与「设置」不禁：前者是结局弹窗的另一个入口，后者是删档的唯一入口。
 */
export function render(root, s, handlers = {}) {
  const R = rates(s);
  const D = derived(s, R);
  const a = ACTS[s.stage] || ACTS[1];
  const dis = s.ending ? ' disabled' : '';

  if (root.style && root.style.setProperty) root.style.setProperty('--accent', ACCENT[s.stage] || ACCENT[1]);

  const log = s.log.slice(-12).reverse()
    .map(t => `<div class="li">${esc(t)}</div>`).join('');

  root.innerHTML = `
  <header class="head">
    <div class="brand">${esc(companyName(isListed(s)))}</div>
    <div class="date">${gameDate(s)} · ${esc(a.place)}</div>
    <div class="tools">
      ${SPEEDS.map(v => `<button class="ic${s.speed === v ? ' on' : ''}" data-speed="${v}"${dis}>${v}×</button>`).join('')}
      <button class="ic" data-retire="1">退休</button>
      <button class="ic" data-settings="1">⚙</button>
    </div>
  </header>
  ${s.ending ? '<div class="frozen">已登顶 · 时间冻结</div>' : ''}
  ${hud(s, R, D)}
  <div class="tabs">
    ${TABS.map((t, i) => `<button class="tab${i === tab ? ' on' : ''}" data-tab="${i}">${esc(t)}</button>`).join('')}
  </div>
  ${tab === 0 ? `${focusBlock(s, dis)}${lines(s, R, dis)}${pendingBlock(s, dis)}` : rankBlock(s, D)}
  <div class="log">${log}</div>`;
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

/** 设置（只有一件事：两步删档）—— ⚠️ 音效模块已删（GDD §3.3），所以这里没有音效开关 */
export function renderSettings(overlay, s) {
  const armed = deleteSaveArmed();
  overlay.innerHTML = `
  <div class="modal">
    <div class="m-head">设置</div>
    <div class="m-opts">
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

/** 未登顶：只提示，不结束游戏 */
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
