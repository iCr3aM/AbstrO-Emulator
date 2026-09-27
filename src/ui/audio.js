/**
 * 音效（Web Audio 合成，零资源文件）
 * ===============================================================
 * 为什么是**合成**而不是 mp3/ogg：本作是「一个 HTML + 一个 JS + 一个 CSS」就要能跑起来的
 * 零依赖项目，多一个音频文件就多一份要上传、要缓存、要在 SFTP 上保持目录结构的东西。
 * 而这里要的音效全是几十毫秒的「叮 / 咚 / 三音上行」，振荡器 + 增益包络就够了。
 *
 * ───────────────────────────────────────────────────────────────
 * 三条纪律
 * ───────────────────────────────────────────────────────────────
 * ① **不许抛错**。浏览器策略、无 `AudioContext` 的老环境、被用户静音 —— 任何一种情况下
 *    它都只是「没声音」，绝不能把主循环带崩（`main.js` 的 `fatal()` 一旦触发就是一屏红字）。
 *    所以全程 `try/catch`，并且**只在第一次真的要用时才建 `AudioContext`**
 *    （有些浏览器在页面加载时就建会留下来一条警告）。
 * ② **音效不是信息**。它不报任何游戏状态，只是动作的回执 —— 关掉它不会少看一个数，
 *    所以开关默认开、放在 ⚙ 里，且**不进任何判据**（无头工具里 `AudioContext` 不存在，
 *    `play()` 直接返回）。
 * ③ **同一音效限流**。8× 倍速下一分钟可以点几十下，逐下发声会糊成一片噪音 ——
 *    同一 `name` 在 `MIN_GAP` 毫秒内只响一次。
 */

/** 同一音效的最小间隔（毫秒）—— 8× 倍速下手速再快也不会糊成一片 */
const MIN_GAP = 45;

/** 浏览器是否给面子 —— 第一个真音效才建上下文，建不出来就永远静音 */
let ctx = null;
let ctxTried = false;

function ac() {
  if (ctxTried) return ctx;
  ctxTried = true;
  try {
    const C = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (C) ctx = new C();
  } catch { ctx = null; }
  return ctx;
}

/**
 * 一个音：`f` 起始频率、`t` 延迟秒、`d` 持续秒、`type` 波形、`gain` 峰值、
 * `slide` 结束频率是起始的几倍（>1 上扬、<1 下坠）。
 */
function tone(c, { f, t = 0, d = 0.08, type = 'triangle', gain = 0.05, slide = 0 }) {
  const t0 = c.currentTime + t;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, f * slide), t0 + d);
  // 8ms 淡入（避免爆音）+ 指数淡出 —— 听感上就是一声干净的「叮」
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
  o.connect(g);
  g.connect(c.destination);
  o.start(t0);
  o.stop(t0 + d + 0.03);
}

/**
 * 音色表。五条与游戏动作一一对应，**没有一条会连响到吵**：
 *   buy   买下一级 —— 短促上扬的「叮」，最常响，所以最轻最短
 *   order 交付订单 —— 两音上行（钱进来了）
 *   opt   年度决策 —— 一个低一点的单音（比买线「重」一档）
 *   stage 推进新章 —— 三音上行
 *   top   登顶   —— 四音上行 + 拖长，全作只响一次
 *   ui    开关 / 切页 / 切倍速 —— 极轻的一声
 */
const RECIPES = {
  buy: c => tone(c, { f: 520, d: 0.06, type: 'square', gain: 0.028, slide: 1.7 }),
  order: c => { tone(c, { f: 660, d: 0.09 }); tone(c, { f: 990, t: 0.07, d: 0.12 }); },
  opt: c => tone(c, { f: 392, d: 0.12, type: 'sine', gain: 0.05 }),
  stage: c => [523.25, 659.25, 783.99].forEach((f, i) => tone(c, { f, t: i * 0.08, d: 0.2, gain: 0.04 })),
  top: c => [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(c, { f, t: i * 0.15, d: 0.45, gain: 0.05 })),
  ui: c => tone(c, { f: 320, d: 0.045, type: 'sine', gain: 0.025, slide: 1.8 }),
};

const lastAt = new Map();

/**
 * 放一个音效。
 * @param {string} name  `buy / order / opt / stage / top / ui` 之一
 * @param {boolean} on   用户的音效开关（`s.sfx`）—— 关掉了就整段跳过，连 `AudioContext` 都不建
 */
export function play(name, on = true) {
  if (!on) return;
  const fn = RECIPES[name];
  if (!fn) return;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (now - (lastAt.get(name) || -1e9) < MIN_GAP) return;
  lastAt.set(name, now);
  try {
    const c = ac();
    if (!c) return;
    /**
     * 自动播放策略：首次一定是从玩家点击（`bind.js` 的 `pointerdown`）里进来的，`resume()` 会成功。
     * `resume()` 是异步的，**所以不能等它** —— 它没转起来之前 `currentTime` 是冻结的，
     * 此刻排进去的振荡器会等到恢复后照常发声。推幕 / 登顶这类由主循环触发的声音可能没有手势
     * 可用，那就静默无声，同样不报错。
     */
    if (c.state === 'suspended') c.resume().catch(() => {});
    fn(c);
  } catch { /* 音效永远不许把主循环带崩 */ }
}
