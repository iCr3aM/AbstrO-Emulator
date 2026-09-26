/**
 * 极简 DOM 渲染（GDD §5.3 第 1 问：主界面就是世界市值榜）
 * ===============================================================
 * 只做「把状态画出来」+「把点击转成一次 action」，不含任何游戏规则。
 *
 * ⚠️ 这里是**全量重建**（`root.innerHTML = ...`）—— 所以任何交互态（展开与否、确认与否）
 *    都必须由本模块持有，不能留在 DOM 里。
 * ⚠️ 只有 `data-*` 一种接线方式，且动作键必须落在 `bind.js` 的 `ACTION_KEYS` 里。
 */

import { ACTS, LINES, FOUNDERS, agesAt, marginOf, PENDING_CAP } from '../core/content.js';
import { rates, derived, costFor, canAfford, lineLevel, sharePctOf } from '../core/economy.js';
import { ranking, toUSD_T } from '../core/world.js';
import { isListed } from '../core/finance.js';
import { gameDate } from '../core/format.js';
import { pendingEvent, stageGoalMet } from '../core/engine.js';
import { ENDING_TEXT } from '../core/endings.js';

/** 阶段配色：只改一个 CSS 变量，整页基调随之推移 */
const ACCENT = [null, '#6ad1c0', '#7bc47f', '#c9b458', '#d98c5f', '#c96a8a', '#8f8fd9', '#e0e0e0'];

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

/** 名次变化（`rankDelta` 正数 = 上升；`null` = 本月新入场） */
function deltaOf(c) {
  if (c.isNew) return '<em class="new">新</em>';
  const d = c.rankDelta || 0;
  if (d > 0) return `<em class="up">↑${d}</em>`;
  if (d < 0) return `<em class="down">↓${-d}</em>`;
  return '<em class="flat">─</em>';
}

// ─────────────────────────── 常驻 HUD ───────────────────────────
function hud(s, R, D) {
  const sign = v => (v >= 0 ? '+' : '−');
  /**
   * ⚠️ **上市前不进榜**（GDD §1.4）：名次只在 IPO 之后显示。
   * `s.worldRank` 本身一直在算（结局判据要用），但「显示」是另一条规则。
   */
  const listed = isListed(s);
  const rank = listed && s.worldRank ? `#${s.worldRank}` : '—';
  return `
  <div class="hud">
    <span class="cell"><i>现金</i><b>¥${fmt(s.money)}</b><u>每秒 ${sign(R.netPerSec)}${fmt(Math.abs(R.netPerSec))}</u></span>
    <span class="cell"><i>市值</i><b>¥${fmt(D.marketCap)}</b><u>年营收 ¥${fmt(D.revenue)}</u></span>
    <span class="cell"><i>净利率</i><b>${(R.margin * 100).toFixed(0)}%</b><u>PE ${D.pe.toFixed(0)}</u></span>
    <span class="cell"><i>世界</i><b>${rank}</b><u>${listed ? '已上市' : '未上市'}</u></span>
  </div>`;
}

// ─────────────────────────── 三条投资线 ───────────────────────────
function lines(s, R) {
  const rows = LINES.map(l => {
    const lv = lineLevel(s, l.id);
    const cost = costFor(s, l.id);
    const ok = canAfford(s, l.id);
    const value = l.id === 'm' ? `${(sharePctOf(R.share)).toFixed(1)}%` : `×${(l.id === 'r' ? R.prod : R.team).toFixed(2)}`;
    return `
    <div class="line">
      <button class="btn${ok ? '' : ' dim'}" data-buy="${l.id}">${l.name}<em>${l.who}</em></button>
      <span class="lv">Lv ${lv}</span>
      <span class="val">${l.label} ${value}</span>
      <span class="cost">¥${fmt(cost)}</span>
    </div>`;
  }).join('');
  return `<div class="lines">${rows}</div>`;
}

// ─────────────────────────── 世界市值榜（§1.4）───────────────────────────
function rankBlock(s, D) {
  if (!s.world) return '<div class="rank"><div class="rank-head"><span>世界市值榜</span><span>单位：万亿美元</span></div></div>';
  const listed = isListed(s);
  const cap = listed ? toUSD_T(D.marketCap) : null;
  const { top, all } = ranking(s.world, cap, 10, s.worldPrevCap ?? null);
  const me = all.find(c => c.me);
  const row = c => `
    <div class="row${c.me ? ' me' : ''}">
      <span class="no">${c.rank}</span>
      <span class="nm">${esc(c.n)}</span>
      <span class="dlt">${deltaOf(c)}</span>
      <span class="cap">${tUsd(c.cur)}</span>
    </div>`;
  const rows = top.map(row).join('');
  // 名次 > 10 时钉在列表底部单独一行（上市后才会出现）
  const pin = me && me.rank > 10
    ? `<div class="sep">⋯</div>${row({ ...me, rank: '—' })}`
    : '';
  return `
  <div class="rank">
    <div class="rank-head"><span>世界市值榜</span><span>单位：万亿美元</span></div>
    ${rows}${pin}
  </div>`;
}

// ─────────────────────────── 待决事件（§1.5）───────────────────────────
/**
 * **在线不弹窗** —— 待决事件就长在主界面里：角标是数量，正文是第一条，
 * 选项直接点。积压上限 `PENDING_CAP` 条，超出部分由引擎按默认选项结算。
 */
function pendingBlock(s) {
  if (!s.pending.length) return '';
  const ev = pendingEvent(s);
  if (!ev) return '';
  const uid = s.pending[0].uid;
  const opts = ev.options.map((o, i) =>
    `<button class="opt" data-opt="${uid}:${i}">${esc(o.text)}</button>`).join('');
  return `
  <div class="pending">
    <div class="p-head">待决 <b>${s.pending.length}</b> / ${PENDING_CAP} 条</div>
    <div class="p-title">${esc(ev.title)}</div>
    <div class="p-body">${esc(ev.body)}</div>
    <div class="p-opts">${opts}</div>
  </div>`;
}

// ─────────────────────────── 主渲染 ───────────────────────────
export function render(root, s, handlers = {}) {
  const R = rates(s);
  const D = derived(s, R);
  const a = ACTS[s.stage] || ACTS[1];
  const ages = agesAt(s.stage);
  const goal = stageGoalMet(s, R, D);
  const who = FOUNDERS.map(f => `${f.name} ${ages[f.id]}`).join(' · ');

  if (root.style && root.style.setProperty) root.style.setProperty('--accent', ACCENT[s.stage] || ACCENT[1]);

  const log = s.log.slice(-12).reverse()
    .map(t => `<div class="li">${esc(t)}</div>`).join('');

  root.innerHTML = `
  <header class="head">
    <div class="brand">${esc(s.stage >= 5 ? 'Abstract Inc' : 'Abstract Studio')}</div>
    <div class="date">${gameDate(s)} · ${esc(a.place)}</div>
    <div class="tools"><button class="ic" data-settings="1">⚙</button></div>
  </header>
  ${hud(s, R, D)}
  <div class="goal">本阶段目标 ${esc(a.goal)} <b class="${goal ? 'ok' : ''}">${goal ? '✓' : '·'}</b>
    <span class="mut">净利率 ${(marginOf(s.stage) * 100).toFixed(0)}% · ${esc(who)}</span></div>
  ${lines(s, R)}
  ${pendingBlock(s)}
  ${rankBlock(s, D)}
  <div class="log">${log}</div>
  <div class="foot">
    <button class="ic" data-speed="1">1×</button>
    <button class="ic" data-speed="4">4×</button>
    <button class="ic" data-speed="8">8×</button>
    <span class="grow"></span>
    <button class="ic" data-retire="1">退休</button>
  </div>`;
  return { R, D };
}

// ─────────────────────────── 弹窗 ───────────────────────────
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
