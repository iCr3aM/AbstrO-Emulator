#!/usr/bin/env node
/**
 * 点击链路回放（`npm run click`，GDD §5.3）
 * ===============================================================
 * 为什么非有它不可：check / robust / probe 全都**直接调 core 函数**，所以永远不会发现
 * 「界面上没有这个按钮」「点了没反应」「弹窗活不过一帧」这类 bug。
 * 只有「把 `render()` 吐出来的 HTML 解析成按钮 → 构造事件 → 走 `bind.js` 的委托
 * → 落到 `dispatch`」这一整条路，才能覆盖 UI 的死活。
 *
 * ⚠️ `dispatch` 在这里是**抄的一份**（main.js 没有导出它）。抄件与主件一旦走偏，
 *    探针就会报红灯（`probes.mjs` 有一条接线一致性探针比对两份 `if (d.x !== undefined)`）。
 *    这就是 GDD §5.3 那句「新的接线必须同步抄进 click-sim / probes」的执行方式。
 * ⚠️ 主事件是 `pointerdown`（不是 `click`）—— 本文件按 `bind.js` 的 `PRIMARY_EVENT` 派发，
 *    所以「有人把 bind.js 改回 click」这件事会在跑分的**同时**被抓住。
 * ⚠️ 恒 exit 0；结论读末尾 `BRIEF`。
 */

import { installDom, makeNode, buttonsIn, findBtn } from './dom-stub.mjs';
import { createState } from '../src/core/state.js';
import { rates, lowestLine, costFor, lineLevel, peOf, canAffordManual } from '../src/core/economy.js';
import { tick, pendingEvent, resolvePending, manualBuy } from '../src/core/engine.js';
import { deliverOrder } from '../src/core/orders.js';
import { CURVE_RATIO, MANUAL_GAIN, MANUAL_PAY, RESERVE_FRAC, LINES } from '../src/core/content.js';
import { evaluateRetirement } from '../src/core/endings.js';
import {
  render, renderEnding, renderNotTop, renderOffline, renderSettings, closeModal, setTab,
  armDeleteSave, deleteSaveArmed, disarmDeleteSave, setRankSel,
} from '../src/ui/render.js';
import { bindActions, ACTION_KEYS, PRIMARY_EVENT } from '../src/ui/bind.js';

installDom();

/**
 * 每条投资线住在第几个页签（与 `render.js` 的 `PAGE_LINES = [['r','m','h'], ['c','d']]` 对齐）。
 * 回放里「找按钮」必须先切到正确的页 —— 否则会以为按钮不存在。
 * ⚠️ 页签序 = **创始人(0) / 公司(1) / 订单(2) / 市值榜(3)**；2026-09-27 调换过前两个。
 */
const PAGE_OF = { r: 0, m: 0, h: 0, c: 1, d: 1 };

const app = makeNode('div');
const overlay = makeNode('div');

/** 容器：把事件处理器记下来，好让我们手工派发 */
function recorder() {
  const n = makeNode('div');
  n.handlers = [];
  n.addEventListener = (type, fn, capture) => { n.handlers.push({ type, fn, capture }); };
  n.removeEventListener = () => {};
  n.fire = (type, ev) => {
    for (const h of n.handlers) if (h.type === type) h.fn(ev);
  };
  return n;
}
const appBox = recorder();
const overlayBox = recorder();

/**
 * 从一段 HTML 里挑一个按钮，做成「可派发的事件目标」。
 * `closest` 是 `bind.js` 唯一的取值口径（`findActionEl` = `target.closest(ACTION_SELECTOR)`），
 * 所以这里只需让它**认自己**；`.modal` 那一支留给 `closeModal`。
 */
function clickable(btn, modal = null) {
  const el = {
    dataset: { ...btn.data },
    disabled: !!btn.disabled,
    closest(sel) {
      if (sel === '.modal') return modal;
      return Object.keys(el.dataset).length ? el : null;
    },
  };
  return el;
}
const ev = extra => ({ target: null, cancelable: true, detail: 1, stopPropagation() {}, preventDefault() {}, ...extra });

// ─────────────────────────── dispatch（main.js 的抄件）───────────────────────────
let s = createState();
const realWipe = () => { store.delete('abstract-studio.save.v1'); };
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

let deletes = 0;
const handlers = {
  buy(id) { if (manualBuy(s, id)) draw(); },
  opt(arg) {
    const [uid, i] = String(arg).split(':');
    if (resolvePending(s, Number(uid), Number(i), rates(s))) draw();
  },
  close() { draw(); },
  /** 退休：登顶 ⇒ 结局弹窗；未登顶 ⇒ 「还差一点」（与 main.js 同源，判定只此一处） */
  retire() {
    const r = evaluateRetirement(s);
    if (r.ending) renderEnding(overlay, s);
    else renderNotTop(overlay, r.rank);
  },
  order(uid) { if (deliverOrder(s, Number(uid), rates(s))) draw(); },
  settings() { renderSettings(overlay, s); },
  speed(v) { s.speed = Number(v) || 1; draw(); },
  tab(i) { setTab(i); draw(); },
  /** 世界榜的一行：展开 / 收起公司详情（主件里会顺手响一声，这里只切状态） */
  rank(k) { setRankSel(k); draw(); },
  /** 音效开关：主件里会顺手放一声「叮」，这里只切状态（无头环境没有 AudioContext） */
  audio() { s.sfx = s.sfx === false; renderSettings(overlay, s); },
  delete() {
    // 两步确认：与 main.js 同源 —— 用 render.js 的武装态，而不是本地另立一份
    if (!deleteSaveArmed()) { armDeleteSave(); renderSettings(overlay, s); return; }
    disarmDeleteSave();
    deletes += 1;
    realWipe();
  },
};

function dispatch(el) {
  const d = el.dataset;
  if (d.buy !== undefined) return handlers.buy(d.buy);
  if (d.order !== undefined) return handlers.order(d.order);
  if (d.opt !== undefined) return handlers.opt(d.opt);
  if (d.speed !== undefined) return handlers.speed(d.speed);
  if (d.tab !== undefined) return handlers.tab(d.tab);
  if (d.rank !== undefined) return handlers.rank(d.rank);
  if (d.settings !== undefined) return handlers.settings();
  if (d.retire !== undefined) return handlers.retire();
  if (d.audio !== undefined) return handlers.audio();
  if (d.delete !== undefined) return handlers.delete();
  // 关闭与 main.js 同源：调 render.js 的 closeModal（它负责**把 overlay 清空**）
  if (d.close !== undefined) { closeModal(overlay); return handlers.close(); }
}

bindActions({ app: appBox, overlay: overlayBox }, dispatch);

/** 主界面 + 弹窗都重画一遍 */
function draw() { render(app, s); }
draw();

// ─────────────────────────── 断言 ───────────────────────────
const rows = [];
const check = (name, ok, note = '') => { rows.push({ name, ok: !!ok, note }); return !!ok; };

/** 一个选项在对数市值上的增量（与 headless-check 同一口径，用来挑「最优选项」） */
function logCapDelta(eff, R) {
  if (!eff) return 0;
  let d = 0;
  // 一笔现金能买几级 × 每级的对数市值增量（ln g = ln r / 线数）
  if (eff.cash) d += ((eff.cash * R.revenue) / costFor(s, 'r')) * Math.log(CURVE_RATIO) / LINES.length;
  for (const k of ['prod', 'share', 'team']) if (eff[k]) d += Math.log(eff[k]);
  if (eff.pe) d += Math.log(Math.max(1e-9, (peOf(s) + eff.pe) / peOf(s)));
  return d;
}

/**
 * 派发一次「点击」：从 HTML 找按钮 → 造元素 → 走容器上的 `PRIMARY_EVENT`。
 * 返回是否真的派发成功了（找不到按钮 = false，调用方据此判缺陷）。
 */
function clickFirst(html, box, key, modal = null) {
  const btn = findBtn(buttonsIn(html), key);
  if (!btn) return null;
  const el = clickable(btn, modal);
  box.fire(PRIMARY_EVENT, ev({ target: el }));
  return btn;
}

let sawOpt = 0;
let sawBuy = 0;
let sawSpeed = 0;
let sawHot = 0;
const seenKeys = new Set();

// ── ① 主界面按钮审计：渲染出来的每个 data-* 动作键都必须在 ACTION_KEYS 里 ──
{
  const btns = buttonsIn(app.innerHTML);
  const stray = [];
  for (const b of btns) {
    for (const k of Object.keys(b.data)) {
      seenKeys.add(k);
      if (!ACTION_KEYS.includes(k)) stray.push(`data-${k}`);
    }
  }
  check('主界面渲染出的动作键全部落在 ACTION_KEYS 内', stray.length === 0, stray.join('、'));
  check('开局停在「创始人」页：三条经营线按钮（data-buy）', btns.filter(b => b.data.buy !== undefined).length === 3,
    `实际 ${btns.filter(b => b.data.buy !== undefined).length} 个`);
  check('主界面存在倍速按钮（data-speed）', btns.some(b => b.data.speed !== undefined));
  // 「退休」横条**只在登顶之后出现**（用户 2026-09-27 明确两次）。开局这一帧就得守住 ——
  // 否则它会悄悄变回一颗常驻按钮（那正是被否决过两次的做法）。
  check('开局（未登顶）没有「退休」按钮 —— 它只在登顶后出现',
    !app.innerHTML.includes('data-retire'));
}

// ── ①b 页签：切页真的换内容，而且这个态住在模块里（全量重建不会丢）──
{
  /** 从当前渲染结果里点指定页签 —— `clickFirst` 按「有没有这个键」找，页签必须按值找 */
  const clickTab = i => {
    const btn = buttonsIn(app.innerHTML).find(b => b.data.tab === String(i));
    if (!btn) return false;
    appBox.fire(PRIMARY_EVENT, ev({ target: clickable(btn) }));
    return true;
  };
  check('主界面给了四个页签（创始人 / 公司 / 订单 / 市值榜）',
    buttonsIn(app.innerHTML).filter(b => b.data.tab !== undefined).length === 4);
  check('开局停在「创始人」页：有投资线、没有榜单',
    buttonsIn(app.innerHTML).some(b => b.data.buy !== undefined) && !app.innerHTML.includes('世界市值榜'));

  check('点「市值榜」切得动', clickTab(3));
  check('切到「市值榜」：榜单出现、投资线让位',
    app.innerHTML.includes('世界市值榜') && !buttonsIn(app.innerHTML).some(b => b.data.buy !== undefined));
  check('未上市时榜单里没有玩家行（未上市不进榜）', !app.innerHTML.includes('class="row me"'));

  draw();   // 整页重建一次 —— 页签状态若留在 DOM 上，这一下就会弹回「创始人」
  check('页签状态住在模块里：重建一帧后仍停在「市值榜」', app.innerHTML.includes('世界市值榜'));

  check('切回「公司」页挂出两条资产线',
    clickTab(1) && buttonsIn(app.innerHTML).filter(b => b.data.buy !== undefined).length === 2);
}

// ── ①c 订单页：交付按钮真的能点（data-order → deliverOrder）──
{
  tick(s, 0);                                   // 建世界表 / 写进度钟 / 发第 0 月那条订单
  check('「订单」页切得动',
    buttonsIn(app.innerHTML).some(b => b.data.tab === '2') && (setTab(2), draw(), true));
  const live = s.orders.live.length;
  check('开局就有在手订单（排期第 0 月来一条）', live >= 1, `在手 ${live} 条`);
  const moneyBefore = s.money;
  const delivered = clickFirst(app.innerHTML, appBox, 'order');
  check('点交付按钮真的拿到了订单钱（准时 ×1.0，且出队）',
    !!delivered && s.money > moneyBefore && s.orders.live.length === live - 1,
    `${live} → ${s.orders.live.length} 条 ｜ +${(s.money - moneyBefore).toFixed(0)}`);
  setTab(0);
  draw();
}

// ── ①d 市值榜：每行都是按钮，点一下展开公司详情（行业 / 国家），同值再点收起 ──
{
  setTab(3);
  draw();
  const rows = buttonsIn(app.innerHTML).filter(b => b.data.rank !== undefined);
  check('市值榜每一行都是可点的按钮（data-rank）', rows.length >= 20, `实际 ${rows.length} 行`);
  check('榜头写着「当前最热」的行业（与周期播报同源）', app.innerHTML.includes('当前最热：'));
  const first = rows[0];
  appBox.fire(PRIMARY_EVENT, ev({ target: clickable(first) }));
  check('点一行：行下方展开详情（行业 / 国家）',
    app.innerHTML.includes('class="rdet"') && app.innerHTML.includes('行业 '),
    `点的是「${first.label}」`);
  const again = buttonsIn(app.innerHTML).find(b => b.data.rank === first.data.rank);
  appBox.fire(PRIMARY_EVENT, ev({ target: clickable(again) }));
  check('同值再点：详情收起（收起态也住在模块里）', !app.innerHTML.includes('class="rdet"'));
  setTab(0);
  draw();
}

// ── ② 倍速按钮：真实接线走一遍 ──
{
  const before = s.speed;
  // 三个倍速键（1× / 4× / 8×）都点一遍 —— 只点第一个（1×）等于没验
  const boxes = buttonsIn(app.innerHTML).filter(b => b.data.speed !== undefined);
  check('主界面给了 1× / 4× / 8× 三个倍速按钮', boxes.length === 3, `实际 ${boxes.length} 个`);
  for (const b of boxes) {
    appBox.fire(PRIMARY_EVENT, ev({ target: clickable(b) }));
    sawSpeed += 1;
  }
  check('依次点过全部倍速按钮后 s.speed 落在最后一个（8×）',
    sawSpeed >= 3 && s.speed === Number(boxes[boxes.length - 1].data.speed), `${before} → ${s.speed}`);
  s.speed = 1;
}

// ── ③ 手动点击买一条线（走 dispatch → handlers.buy → manualBuy）──
{
  /**
   * 现金与「可动用现金」的关系：可动用 = 现金 × (1 − 储备比例)（储备基数已改成**现金**）。
   * 手动一次付 `MANUAL_PAY` 份原价的钱（≈1.57）⇒ 现金必须给到 `MANUAL_PAY / (1 − rf)`
   * 以上；rf=0.80 下 4 份现金只能动 0.8 份（按钮会是灰的），这里改成 1.2 倍余量。
   */
  const money0 = costFor(s, 'r') * MANUAL_PAY / (1 - RESERVE_FRAC) * 1.2;
  s.money = money0;
  const lvBefore = lineLevel(s, 'r');
  const payBefore = costFor(s, 'r') * MANUAL_PAY;
  // r（投研发）在「创始人」页 —— 五条线分两页之后，必须切到对应页才找得到那个按钮
  setTab(0);
  draw();
  const btn = buttonsIn(app.innerHTML).find(b => b.data.buy === 'r' && !b.disabled);
  let hit = null;
  if (btn) { appBox.fire(PRIMARY_EVENT, ev({ target: clickable(btn) })); hit = btn; }
  check(`点击投资线按钮真的买下了（等级 +${MANUAL_GAIN}）`,
    !!hit && lineLevel(s, 'r') === lvBefore + MANUAL_GAIN, `${lvBefore} → ${lineLevel(s, 'r')}`);
  // ⚠️ 用相对容差：扣款口径与 costFor × MANUAL_PAY 在 IEEE754 下可能差 1 ulp
  check(`手动按 ${MANUAL_PAY.toFixed(2)} 份原价扣款（买 2 级不付 2 级的钱）`,
    !!hit && Math.abs(s.money - (money0 - payBefore)) <= payBefore * 1e-9,
    `预期 ${money0 - payBefore}，实得 ${s.money}`);
  if (hit) sawBuy += 1;
  setTab(0);
  draw();
}

// ── ④ 设置弹窗 + 两步删档 ──
{
  clickFirst(app.innerHTML, appBox, 'settings');
  check('点 ⚙ 弹出设置弹窗（data-delete / data-close 都在）',
    overlay.innerHTML.includes('data-delete') && overlay.innerHTML.includes('data-close'));

  const modal = makeNode('div');
  modal.className = 'modal';
  overlay.appendChild(modal);
  clickFirst(overlay.innerHTML, overlayBox, 'delete', modal);
  check('第一次点「删除全部数据」只进入确认态，不执行删除',
    deletes === 0 && overlay.innerHTML.includes('再点一次'), `deletes=${deletes}`);
  clickFirst(overlay.innerHTML, overlayBox, 'delete', modal);
  check('第二次点击才真正执行删档', deletes === 1, `deletes=${deletes} | 存档键 ${[...store.keys()].length}`);
  check('删档确认是两步（不是一个按钮点一次）', deletes === 1);

  // 关闭：只有带 data-close 的按钮才关得掉
  renderSettings(overlay, s);
  clickFirst(overlay.innerHTML, overlayBox, 'close');
  check('点 data-close 后 overlay 真正清空（#overlay:empty 成立 ⇒ 遮罩不留残影）',
    overlay.innerHTML === '', `innerHTML=${JSON.stringify(overlay.innerHTML.slice(0, 24))}`);

  // 遮罩若残留就吃掉全页点击 —— 用户报的「关掉设置后倍速失效」正是这一条
  const eight = buttonsIn(app.innerHTML).find(b => b.data.speed === '8');
  appBox.fire(PRIMARY_EVENT, ev({ target: clickable(eight) }));
  check('关掉弹窗后主界面按钮仍然点得到（点 8× ⇒ s.speed = 8）', s.speed === 8, `speed=${s.speed}`);
  s.speed = 1;                                   // 复位：后面那一局按 1× 跑
}

// ── ⑤ 跑到结局：每一帧都从渲染出的 HTML 里找按钮来点 ──
const T0 = Date.now();
let steps = 0;
let renders = 0;
const STEP = 1;           // 逻辑步长（秒）
const MAX_STEPS = 40000;  // 40 000 秒 = 11 小时，远超一局
let lastRenderAt = -1e9;

while (!s.ending && steps < MAX_STEPS) {
  steps += 1;
  tick(s, STEP);

  const evPending = pendingEvent(s);
  // 只在「有待决」或「距上次重画超过 600 秒」时重画 —— render 是整页重建 + 105 家排序，
  // 每帧都画会把回放拖到分钟级，而我们要验的是「按钮能不能被找到」，不是渲染性能。
  const due = evPending || steps - lastRenderAt >= 600;
  if (!due) continue;
  lastRenderAt = steps;
  renders += 1;
  // ⚠️ 先定位该画哪一页：待决卡片只长在「公司」页（页签下标 1）；投资线分两页，
  //    `lowestLine` 可能落在「创始人」页。以前只有一条页签链、整页只有一份内容，
  //    所以这里不需要切页；现在不切就等于找不到按钮。
  setTab(evPending ? 1 : (PAGE_OF[lowestLine(s)] || 0));
  draw();

  if (evPending) {
    // 有待决 ⇒ 「公司」页签必须亮 `.hot`（玩家没切过去时，这是唯一的提醒信号）
    if (/<button class="tab[^"]* hot" data-tab="1">/.test(app.innerHTML)) sawHot += 1;
    const btns = buttonsIn(app.innerHTML);
    for (const b of btns) for (const k of Object.keys(b.data)) seenKeys.add(k);
    const opts = btns.filter(b => b.data.opt !== undefined);
    check(`待决「${evPending.title}」在主界面上给出了两个可点的选项`, opts.length === 2, `实际 ${opts.length} 个`);
    const R = rates(s);
    const a = logCapDelta(evPending.options[0].eff, R);
    const b = logCapDelta(evPending.options[1].eff, R);
    const want = a >= b ? 0 : 1;
    const el = clickable(opts[want]);
    appBox.fire(PRIMARY_EVENT, ev({ target: el }));
    sawOpt += 1;
    if (s.pending.some(p => p.uid === Number(opts[want].data.opt.split(':')[0]))) {
      check('点击选项后那条待决仍未结算', false, 'uid 未出队');
      break;
    }
  } else {
    // 手动点击 = 从界面里找「等级最低」那条线的按钮（与自动购买同一个解）
    const want = lowestLine(s);
    const btn = buttonsIn(app.innerHTML).find(b => b.data.buy === want && !b.disabled);
    // 门槛是「可动用现金（现金 × (1 − 储备比例)）≥ cost × MANUAL_PAY」——
    // 与 autoBuy / manualBuy 同一条闸门。
    // ⚠️ 用 `canAffordManual`（与按钮亮度同源），不要自己写 `>=`：边界上浮点会差几个 ulp，
    //    自写比较会比按钮更严 —— 那就模拟成了「按钮亮着却不点」，量尺就不是线上那套了。
    if (btn && canAffordManual(s, want)) {
      appBox.fire(PRIMARY_EVENT, ev({ target: clickable(btn) }));
      sawBuy += 1;
    }
  }
}
draw();

check('从渲染出的 HTML 里真的点到过待决选项（不是空转）', sawOpt >= 20, `${sawOpt} 次`);
check('有待决时「公司」页签亮 .hot（不切过去也看得见）', sawHot >= 20, `${sawHot}/${sawOpt} 次`);
check('从渲染出的 HTML 里真的点到过投资线按钮（不是空转）', sawBuy >= 1, `${sawBuy} 次`);
check('一路点到唯一结局「登顶」', s.ending === 'top', `ending=${s.ending ?? 'null'}`);

// ── ⑤b 登顶后：界面只剩回看；无头工具（= 非实时会话）走 tick 时仍旧定格 ──
//   ⚠️ 真实会话（`createLoop` 传 `live = true`）登顶后是**慢放** `SAVOR_RATE`，不是定格
//      —— 那一条由 `probes.mjs` 的登顶探针钉住；这里只负责界面与「非实时会话定格」。
{
  const money = s.money;
  const elapsed = s.elapsed;
  const stage = s.stage;
  const lv = lineLevel(s, 'r');
  setTab(1);                                     // 登顶后要看的「投资线按钮」在「公司」页（两条资产线）
  draw();
  const btns = buttonsIn(app.innerHTML);
  const buys = btns.filter(b => b.data.buy !== undefined);
  const speeds = btns.filter(b => b.data.speed !== undefined);
  check('登顶后：旧版「已登顶 · 时间冻结」提示已经让位给「退休」横条',
    !app.innerHTML.includes('已登顶 · 时间冻结') && btns.some(b => b.data.retire !== undefined));
  check('登顶后：投资线按钮全部 disabled，且倍速按钮**已经整组撤掉**（只剩回看 ＋ ⚙）',
    buys.length === 2 && speeds.length === 0 && buys.every(b => b.disabled),
    `投资线 ${buys.filter(b => b.disabled).length}/2、倍速 ${speeds.length} 个（应为 0）`);
  // 真派发一次 pointerdown：disabled 的元素必须被 bind.js 直接跳过
  if (buys[0]) appBox.fire(PRIMARY_EVENT, ev({ target: clickable(buys[0]) }));
  tick(s, 600);                                  // 非实时会话：10 分钟的等效时间，不许发生任何事
  check('登顶后（非实时会话）：点击 + 600 秒 tick 后现金/时间/等级/阶段一个都没动',
    s.money === money && s.elapsed === elapsed && s.stage === stage && lineLevel(s, 'r') === lv);
}

// ── ⑥ 结局弹窗 + 关灯 ──
{
  renderEnding(overlay, s);
  check('结局弹窗渲染出来了（含 data-close「关灯」）', overlay.innerHTML.includes('data-close'));
  clickFirst(overlay.innerHTML, overlayBox, 'close');
  check('点「关灯」后 overlay 真正清空（结局弹窗不留残影）',
    overlay.innerHTML === '', `innerHTML=${JSON.stringify(overlay.innerHTML.slice(0, 24))}`);
}

// ── ⑥b 「退休」横条：住在 HUD 上面（**不在页头**），点了能开结局 ──
{
  setTab(0);
  draw();
  const bar = buttonsIn(app.innerHTML).find(b => b.data.retire !== undefined);
  const head = /<header class="head">[\s\S]*?<\/header>/.exec(app.innerHTML)?.[0] || '';
  check('「退休」是 HUD 上面那条通栏横条，且**不住页头**',
    !!bar && /<button class="retire" data-retire="1">退休<\/button>/.test(app.innerHTML)
    && !/data-retire/.test(head));
  check('旧版「已登顶 · 时间冻结」提示已经没了', !app.innerHTML.includes('已登顶 · 时间冻结'));
  overlay.innerHTML = '';
  if (bar) appBox.fire(PRIMARY_EVENT, ev({ target: clickable(bar) }));
  check('登顶后点「退休」直接弹出结局',
    s.worldRank === 1 && /class="modal"/.test(overlay.innerHTML) && overlay.innerHTML.includes('data-close'));
  clickFirst(overlay.innerHTML, overlayBox, 'close');
  check('关掉结局后 overlay 真正清空', overlay.innerHTML === '');
}

// ── ⑦ 离线报告弹窗 ──
{
  renderOffline(overlay, { capped: 8 * 3600, cappedOut: true, equiv: 4320, report: { stageFrom: 1, stageTo: 2, cashGained: 1.23e6, overflowed: 2, pending: 1 } });
  check('离线报告只给一份（单一弹窗，且有关闭按钮）',
    (overlay.innerHTML.match(/class="modal"/g) || []).length === 1 && overlay.innerHTML.includes('data-close'));
  check('离线报告不再显示名次行（§1.7 精简）', !overlay.innerHTML.includes('名次'));
  clickFirst(overlay.innerHTML, overlayBox, 'close');
  check('离线报告关掉后 overlay 真正清空（不留遮罩）',
    overlay.innerHTML === '', `innerHTML=${JSON.stringify(overlay.innerHTML.slice(0, 24))}`);
}

// ── ⑧ 派发路径审计 ──
{
  check('主事件是 pointerdown（不是 click）', PRIMARY_EVENT === 'pointerdown', PRIMARY_EVENT);
  const missing = ACTION_KEYS.filter(k => !['buy', 'order', 'opt', 'speed', 'tab', 'rank', 'retire', 'settings', 'audio', 'delete', 'close'].includes(k));
  check('dispatch 覆盖了全部 ACTION_KEYS', missing.length === 0, missing.join('、'));
  check(`走完整局一共见到 ${seenKeys.size} 种动作键，没有越界的`, [...seenKeys].every(k => ACTION_KEYS.includes(k)),
    [...seenKeys].filter(k => !ACTION_KEYS.includes(k)).join('、'));
}

// ─────────────────────────── 输出 ───────────────────────────
const pass = rows.filter(r => r.ok).length;
const fails = rows.filter(r => !r.ok);
console.log('');
console.log('  🖱  点击链路回放（HTML → 按钮 → pointerdown → dispatch）');
console.log('  ─'.repeat(34));
console.log(`  逻辑步数 ${steps} ｜ 整页重画 ${renders} 次 ｜ 点击决策 ${sawOpt} 次 ｜ 点击投资线 ${sawBuy} 次`);
console.log(`  终局：${s.ending === 'top' ? '登顶 ✅' : '未登顶 ❌'} ｜ 决策 ${s.decisions} 次 ｜ 耗时 ${((Date.now() - T0) / 1000).toFixed(1)}s`);
console.log('');
for (const r of rows) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.note ? `　（${r.note}）` : ''}`);
console.log('');
console.log(`  ${pass}/${rows.length} 项通过${fails.length ? `，${fails.length} 项失败` : ''}`);
console.log('');

console.log('BRIEF ' + JSON.stringify({
  pass, fail: fails.length, failed: fails.map(f => f.name),
  ending: s.ending, steps, renders, sawOpt, sawBuy,
  decisions: s.decisions, seconds: +(steps).toFixed(0),
  levels: { ...s.lines },
}));
