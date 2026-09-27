/**
 * 事件接线（唯一的点击入口）
 * ===============================================================
 * 这个文件存在的唯一理由：**让「点击到底用哪个事件」这件事可以被测试**。
 * 原来它内联在 `main.js` 里，而 `tools/probes.mjs` 只能自己**抄一份** dispatch 逻辑，
 * 于是「接线错了」这类 bug 永远测不到 —— 探针测得再全也是测了个副本。
 *
 * ───────────────────────────────────────────────────────────────
 * ⚠️ 为什么**不能**用 `click` 事件（这是本项目最贵的一个 bug）
 * ───────────────────────────────────────────────────────────────
 * MDN 对 `click` 的定义是：
 *   「若在一个元素上按下、而在另一个元素上松开，事件会派发到**同时包含两者的
 *     最具体祖先元素**上。」（most specific ancestor = 最近公共祖先）
 *
 * 而 `render()` 每 150ms 就用 `root.innerHTML = ...` **把整个 DOM 重建一遍**。
 * 桌面端一次鼠标按压要 100–300ms，于是极常见的情况是：
 *
 *   mousedown 落在「按钮 A」→ 中途 DOM 被重建 → mouseup 落在「新按钮 B」
 *   → `click` 派发到共同祖先（`.row` 或 `#app`），**不是按钮**
 *   → `ev.target.closest(ACTION_SELECTOR)` 返回 null → **这一下点击被静默丢弃**
 *
 * 这就是「桌面端点着点着就不灵」的根因。**换 `click` 为 `pointerdown` 才是解法**：
 * `pointerdown` 在**按下那一刻**就派发到命中测试的那个元素上，
 * 它不关心你什么时候松手、松在哪里，所以重建 DOM 影响不到它。
 *
 * 曾经的写法是「把 `click` 监听挂到容器上做委托」—— 那**并没有**解决问题：
 * 委托只改变了**监听的节点**，没有改变 `ev.target` 会因为松手位置而**上浮到祖先**这件事。
 * （`main.js` 里那段注释当时写的理由是错的，已随本文件改正。）
 *
 * ───────────────────────────────────────────────────────────────
 * 键盘怎么办
 * ───────────────────────────────────────────────────────────────
 * `pointerdown` 只覆盖指针设备。按钮获得焦点后按 Enter/Space 触发的是 `click`，
 * 且这种「非指针来源」的 click 有一个可靠特征：**`detail === 0`**
 * （鼠标/触摸触发的 click，detail ≥ 1）。所以保留一条 `click` 兜底，
 * 但**只处理 `detail === 0` 的**，避免同一次鼠标点击被处理两遍。
 */

/**
 * 所有「动作键」——渲染出的 `data-*` 必须落在这里面，否则点了没反应。
 *
 * ⚠️ 重制版（v4）的动作面收敛到十条：点一条投资线、**交付一条订单**、结算一条待决、
 *    关弹窗、**退休**、音效开关、设置、删档、调倍速、切页签。旧版的 `choice / act / bid / skill /
 *    intro / fold / focus` 对应的系统（三选一、合同、技能、开幕剧情、折叠块、自动购买方向）
 *    已全部删除。
 *    `retire` 一度被删（2026-09-27 上午），同日又装回来了 —— 但它**不住页头**，
 *    而是 HUD 上面一条通栏横条（`.retire`），页头因此仍然只有一行。
 */
export const ACTION_KEYS = [
  'buy', 'order', 'opt', 'close', 'retire', 'audio', 'settings', 'delete', 'speed', 'tab',
];

/**
 * 命中判定用的选择器。由 `ACTION_KEYS` 生成，保证两边不会走偏。
 * ⚠️ `main.js` 的 `dispatch` 与 `tools/probes.mjs` 的 `HANDLED` 都必须与它一致，
 *    有一条**结构探针**会校验这件事。
 */
export const ACTION_SELECTOR = ACTION_KEYS.map(k => `[data-${k}]`).join(',');

/** 主事件：按下即触发。**不要改成 `click`** —— 理由见文件头。 */
export const PRIMARY_EVENT = 'pointerdown';

/** 键盘兜底事件：只处理 `detail === 0`（非指针来源）的那些 */
export const KEYBOARD_EVENT = 'click';

/** 从事件目标往上找「可点的动作元素」 */
export function findActionEl(target) {
  return target && target.closest ? target.closest(ACTION_SELECTOR) : null;
}

/** 环境是否支持 Pointer Events（现代浏览器自 2019 起全部支持） */
export const HAS_POINTER_EVENTS = typeof window !== 'undefined'
  && typeof window.PointerEvent === 'function';

/**
 * 把动作接线挂到容器上。
 *
 * ## ⚠️ 这里必须是**唯一**的派发路径
 * `pointerdown` 之后浏览器**还会**派发一次 `click`（`preventDefault()` 不保证抑制它，
 * 规范层面也不该依赖）。所以如果页面元素上还挂着 `onclick`，一次点击就会**跑两遍**
 * ——表现是「买一份变成买两份」。
 *
 * 早期的写法里 `render.js` 确实给每个按钮都绑了 `onclick`，靠 `click` 委托的
 * `stopPropagation` 拦掉；换成 `pointerdown` 之后那一层拦截就失效了（它拦的是另一个事件）。
 * 因此现在**把 `render.js` 里的元素级 `onclick` 全部删掉**，只留这一条路径。
 *
 * @param {object} roots   { app, overlay } —— **两个都要挂**：弹窗在 overlay 里，主界面在 app 里
 * @param {(el)=>void} onAction  真正执行动作的回调（`main.js` 的 dispatch）
 * @param {object} [opts]  `{ pointerEvents }` 仅供测试指定环境能力
 * @returns {{ off: () => void }}  供测试拆卸用
 */
export function bindActions(roots, onAction, opts = {}) {
  const pointerOk = opts.pointerEvents !== undefined ? !!opts.pointerEvents : HAS_POINTER_EVENTS;
  const containers = [roots.app, roots.overlay].filter(
    c => c && typeof c.addEventListener === 'function',
  );

  const handle = ev => {
    const el = findActionEl(ev.target);
    if (!el || el.disabled) return;
    ev.stopPropagation();
    if (ev.cancelable !== false && ev.preventDefault) ev.preventDefault();
    onAction(el);
  };

  /**
   * `click` 通道只服务两种来源：
   *   ① 键盘激活 —— 特征是 `detail === 0`（鼠标/触摸触发的 click，detail ≥ 1）；
   *   ② **不支持 Pointer Events 的环境** —— 那就只能靠 click，此时全部接收。
   * 少了 ②，老环境会变成「完全点不动」；少了 ①，鼠标点击会被处理两遍。
   */
  const handleClick = ev => {
    if (pointerOk && ev.detail !== 0) {
      /**
       * 指针来源的 click：这一下在 pointerdown 里**已经**处理过，这里只补一件事 ——
       * 命中了动作元素就掐掉浏览器对它的**原生激活行为**。
       * `<summary>` 的展开/收起正是靠 click 的原生激活做的：不 preventDefault，
       * 同一次触摸会先按我们的状态展开、再被原生行为翻回相反值（表现是「闪一下」）。
       */
      const el = findActionEl(ev.target);
      if (el && ev.cancelable !== false && ev.preventDefault) ev.preventDefault();
      return;
    }
    handle(ev);
  };

  for (const c of containers) {
    c.addEventListener(PRIMARY_EVENT, handle, true);
    c.addEventListener(KEYBOARD_EVENT, handleClick, true);
  }

  return {
    off() {
      for (const c of containers) {
        if (typeof c.removeEventListener !== 'function') continue;
        c.removeEventListener(PRIMARY_EVENT, handle, true);
        c.removeEventListener(KEYBOARD_EVENT, handleClick, true);
      }
    },
  };
}
