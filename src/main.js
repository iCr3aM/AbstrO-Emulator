/**
 * 入口：把「状态 / 引擎 / 存档 / 渲染」接起来
 * ===============================================================
 * 职责边界很清楚：
 *   core/*  还不知道有 UI 这回事
 *   ui/*    只负责画和把点击转成 action
 *   main.js 是唯一把两边连起来的地方
 */

import { createState } from './core/state.js';
import { save, load, applyOffline, wipe, disableSave } from './core/save.js';
import { createLoop, tick, resolvePending } from './core/engine.js';
import { rates, purchase } from './core/economy.js';
import { evaluateRetirement } from './core/endings.js';
import {
  render, renderOffline, renderSettings, renderEnding, renderNotTop,
  armDeleteSave, deleteSaveArmed, disarmDeleteSave,
} from './ui/render.js';
import { bindActions } from './ui/bind.js';

const root = document.getElementById('app');
const overlay = document.getElementById('overlay') || root;
let s = load() || createState();

/**
 * 启动兜底：**启动链上任何一步抛错都不许是一片黑**。
 *
 * 为什么非有不可（用户报过两次黑屏）：本文件是模块入口，顶层任一句抛错 ⇒ 模块未完成
 * ⇒ `#app` 一个字都没有；而 `#app` 为空时，唯一的自救入口（⚙ → 删除全部数据）**也在 `#app` 里**
 * —— 玩家于是卡在「一片纯黑、无法点击、无法自清」的死局里。
 * 所以这里把异常原样摊在屏幕上，并给一个不依赖主循环的清档按钮。
 */
let fatalShown = false;
function fatal(where, err) {
  if (fatalShown) return;                 // 每帧重绘会反复抛，只摊一次
  fatalShown = true;
  try {
    const msg = (err && (err.stack || err.message)) || String(err);
    root.textContent = '';
    const head = document.createElement('div');
    head.className = 'head';
    head.textContent = `启动失败（${where}）`;
    const pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;word-break:break-all;color:#e06c75;font-size:12px';
    pre.textContent = msg;
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = '清除本地存档并重开（会丢掉当前进度）';
    // 直接绑 onclick，不走 `data-*` 委托 —— 崩溃可能发生在 bindActions 之前
    btn.onclick = () => { disableSave(); wipe(); location.reload(); };
    root.append(head, pre, btn);
  } catch { /* 兜底里再抛就真的没办法了 */ }
}

/**
 * 离线结算（GDD §1.7）。资源入账必须早于首次 draw。
 * 时钟在这一层（应用边界）取，再**显式注入**给 core —— core 不许自己读 `Date.now()`，
 * 否则「离线 24 小时」这类断言在无头工具里无法复现。
 */
let offlineNotice = null;
try {
  const off = applyOffline(s, Date.now());
  if (off.capped > 60 && off.report) offlineNotice = off;
} catch (err) {
  fatal('离线结算', err);
}

// 第一帧之前先跑一次 dt = 0 的 tick：建世界表、写进度钟、发第 1 年的年报。
try { tick(s, 0); } catch (err) { fatal('初始化', err); }

const handlers = {
  /** 手动点击 = 立即买下你点的那一条（与自动购买同一个函数，只影响顺序） */
  buy(id) { if (purchase(s, id)) draw(); },

  /** 结算一条待决事件 */
  opt(arg) {
    const [uid, i] = String(arg).split(':');
    if (resolvePending(s, Number(uid), Number(i), rates(s))) { save(s); draw(); }
  },

  close() { draw(); },
  settings() { renderSettings(overlay, s); },
  speed(v) { s.speed = Number(v) || 1; draw(); },

  /** 退休：登顶 ⇒ 唯一结局；未登顶 ⇒ 只提示，游戏继续 */
  retire() {
    const r = evaluateRetirement(s);
    save(s);
    if (r.ending) renderEnding(overlay, s);
    else renderNotTop(overlay, r.rank);
  },

  /**
   * 删除存档（两步确认）。存档只有一个 localStorage key，删掉就是全没了。
   * 第二次点击才真正执行；6 秒不点自动复位。
   */
  delete() {
    if (!deleteSaveArmed()) {
      armDeleteSave();
      renderSettings(overlay, s);           // 确认文案必须立即显示
      clearTimeout(deleteReset);
      deleteReset = setTimeout(() => { disarmDeleteSave(); renderSettings(overlay, s); }, 6000);
      return;
    }
    clearTimeout(deleteReset);
    disarmDeleteSave();
    doDeleteSave();
  },
};

let deleteReset = 0;
let endingShown = false;

function draw() {
  render(root, s);
  if (s.ending === 'top' && !endingShown) {
    endingShown = true;
    save(s);
    renderEnding(overlay, s);
  }
}

/**
 * 点击入口。接线逻辑在 `src/ui/bind.js`（**用 `pointerdown` 而不是 `click`**：
 * 本页每 150ms 重建一次 DOM，`click` 要求 mousedown/mouseup 落在同一节点上，
 * 否则会派发到最近公共祖先 ⇒ 点击被静默丢弃）。
 *
 * ⚠️ 弹窗的关闭**只由 `data-close` 决定**，不做「派发前无条件摘掉节点」——
 *    否则设置里的两步确认（「再点一次…」）永远看不见。
 */
function dispatch(el) {
  const d = el.dataset;
  if (d.buy !== undefined) return handlers.buy(d.buy);
  if (d.opt !== undefined) return handlers.opt(d.opt);
  if (d.speed !== undefined) return handlers.speed(d.speed);
  if (d.settings !== undefined) return handlers.settings();
  if (d.retire !== undefined) return handlers.retire();
  if (d.delete !== undefined) return handlers.delete();
  if (d.close !== undefined) { closeModal(el); return handlers.close(); }
}

/** 点掉弹窗里的「关闭」后，把那个弹窗整块移除 */
function closeModal(el) {
  const box = el.closest ? el.closest('.modal') : null;
  if (box && box.parentNode) box.parentNode.removeChild(box);
}

bindActions({ app: root, overlay }, dispatch);

// 渲染节流：150ms（约 7fps）—— 文字游戏不需要 60fps，手机上也不会发热
let lastDrawAt = 0;
const loop = createLoop(s, () => {}, () => {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (now - lastDrawAt < 150) return;
  lastDrawAt = now;
  try {
    draw();
  } catch (err) {
    fatal('渲染', err);
    loop.stop();
  }
});

// 存盘闸门在 save.js 里统一兜住三条写盘路径，这里不判
const autoSaveTimer = setInterval(() => save(s), 10000);
window.addEventListener('beforeunload', () => save(s));

/**
 * 真正执行删档。**顺序是关键**：先关闸门，再 wipe()。
 * `location.reload()` 会触发 `beforeunload`，若那时还能存盘，
 * 刚删掉的档会在重载前一瞬间被原样写回来（而玩家以为删成功了）。
 */
function doDeleteSave() {
  disableSave();
  try { loop.stop(); } catch { /* 停不掉也照样删 */ }
  clearInterval(autoSaveTimer);
  wipe();
  if (typeof location !== 'undefined' && typeof location.reload === 'function') location.reload();
}

// 离线报告在 overlay 就绪后呈现
if (offlineNotice) renderOffline(overlay, offlineNotice);

draw();
loop.start();
save(s);   // 开局立刻落一次盘：否则 10 秒内关掉浏览器就是白玩
