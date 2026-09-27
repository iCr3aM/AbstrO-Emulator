/**
 * 存档 + 离线结算（GDD §1.7 / §3.2）
 */

import { SAVE_KEY, serialize, deserialize, createState } from './state.js';
import { OFFLINE_CAP_SEC, OFFLINE_MODIFIER } from './content.js';
import { offlineRun } from './engine.js';
import { derived } from './economy.js';
import { calMonthOf } from './format.js';

export { OFFLINE_CAP_SEC, OFFLINE_MODIFIER };

/**
 * ══════════════ 存盘闸门（删除存档用）══════════════
 *
 * 删档有一个反直觉的坑：**删完必须让所有写盘路径都停下来**。
 * 本作有三条会写盘的路径 —— 每 10 秒的自动存盘、关页时的 `beforeunload`、
 * 以及各种 handler 里的手动 `save(s)`。
 * 而 `location.reload()` 恰好会触发 `beforeunload` —— 如果那时还能存盘，
 * **刚删掉的档会在重载前一瞬被原样写回来**，玩家看到的是「点了删除，刷新一下档又回来了」。
 *
 * 所以闸门放在 `save()` 里面（而不是放在 main.js 的调用处）：
 * 只要闸门关着，**任何**调用点都写不进去，不可能漏掉一条。
 */
let saveDisabled = false;

/** 关掉存盘（删档前调用）。返回后不会再有任何路径能写入存档。 */
export function disableSave() { saveDisabled = true; }

/** 打开存盘（仅测试用：探针验完要恢复，否则会污染同一个进程里的后续用例） */
export function enableSave() { saveDisabled = false; }

export function save(s) {
  if (saveDisabled) return false;
  try {
    localStorage.setItem(SAVE_KEY, serialize(s));
    return true;
  } catch { return false; }
}

export function load() {
  try { return deserialize(localStorage.getItem(SAVE_KEY)); } catch { return null; }
}

/** 删档。全清 —— 本作只有一个 localStorage key，当前周目就在这一个对象里。 */
export function wipe() {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
}

/**
 * 离线结算（GDD §1.7）
 * ===============================================================
 * 离线的**等效游戏时间 = 真实离线秒 × 0.15** ⇒ 封顶 8h 只拿到 1.2h = 全程 5.2h 的 23%。
 * 用等效时间跑一次**纯自动模拟**（自动购买 + 所有年度决策取默认选项），不逐帧重放。
 * 世界与年份跟着这次模拟后的市值一起走 —— 与在线**共用同一套进度钟**，不存在第二套时间。
 *
 * ⚠️ `nowMs` 是**参数**（默认值只为兼容 UI 的裸调用）：core 不许自己读 `Date.now()`，
 *    否则「离线 24 小时」这条断言在无头工具里没法复现。
 *
 * @returns {{ seconds, capped, cappedOut, equiv, report }}
 */
export function applyOffline(s, nowMs = Date.now()) {
  const seconds = Math.max(0, (nowMs - (s.savedAt || nowMs)) / 1000);
  const capped = Math.min(seconds, OFFLINE_CAP_SEC);
  const equiv = capped * OFFLINE_MODIFIER;

  /**
   * 进度钟：`s.calMonth` 是**派生**缓存（不入存档），读档后还没被任何 tick 写过。
   * 这里先刷一次 —— 否则刚进页面时日历与世界榜会短暂地按「第 0 月」渲染，
   * 下一帧才跳回真实进度。
   */
  s.calMonth = calMonthOf(s, derived(s));

  const report = equiv > 0 ? offlineRun(s, equiv) : null;
  s.elapsed += capped;
  s.savedAt = nowMs;
  s.lastSeen = nowMs;
  return { seconds, capped, cappedOut: seconds > OFFLINE_CAP_SEC, equiv, report };
}

export { createState };
