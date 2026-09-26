/**
 * 极简 DOM stub + 按钮解析（click-sim 与 probes 共用）
 * ===============================================================
 * 为什么需要它：本项目的另外两个工具（headless-check / playthrough）**全都直接调 core 函数**，
 * 所以永远不会发现「界面上没有这个按钮」「弹窗活不过一帧」这类 bug。
 * 只有「从渲染出来的 HTML 里解析出按钮、再走事件委托那条路径」才能覆盖 UI 的死活。
 *
 * 这里刻意保持极小：不实现选择器引擎，只做两件事 ——
 *   ① 让 `render()` 能往一个假节点上写 innerHTML、能 appendChild 弹窗；
 *   ② 把 HTML 字符串里的 `<button data-*>` 解析成「玩家能点到的按钮」。
 */

export function makeNode(tag = 'div') {
  const n = {
    tagName: tag, className: '', innerHTML: '', textContent: '',
    dataset: {}, disabled: false, children: [], parentNode: null,
    style: { setProperty() {} },
    appendChild(c) { c.parentNode = n; n.children.push(c); return c; },
    removeChild(c) { n.children = n.children.filter(x => x !== c); c.parentNode = null; return c; },
    remove() { if (n.parentNode) n.parentNode.removeChild(n); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener() {},
    closest() { return null; },
  };
  return n;
}

/** 装上全局 document / performance，好让 src 里的 UI 代码能在 Node 里跑 */
export function installDom() {
  if (globalThis.document) return;
  globalThis.document = {
    createElement: makeNode,
    getElementById: () => null,
    addEventListener() {},
    body: makeNode('body'),
  };
  if (!globalThis.performance) globalThis.performance = { now: () => Date.now() };
}

/**
 * 把渲染出来的 HTML 里所有可点按钮解析出来（含 disabled 状态）。
 * ⚠️ `disabled` 必须用「属性边界」精确匹配，否则 `data-x="not-disabled"` 之类会误判。
 */
export function buttonsIn(html) {
  const out = [];
  const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const label = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const data = {};
    // 带值：data-foo="bar"
    const dre = /data-([a-z0-9]+)="([^"]*)"/g;
    let d;
    while ((d = dre.exec(attrs))) data[d[1]] = d[2];
    // 无值（HTML 布尔属性写法）：data-foo
    // ⚠️ 必须支持 —— 源码里 `data-close`（结局的「关灯」）与 `data-intro`（开幕的「开工」）
    //    都是无值写法，只认带值会**静默漏掉整条流程**（探针就报「界面上找不到按钮」）。
    const bareRe = /(?:^|\s)data-([a-z0-9]+)(?=[\s>]|$)/g;
    let b2;
    while ((b2 = bareRe.exec(attrs))) if (!(b2[1] in data)) data[b2[1]] = '1';
    const bare = attrs.replace(/data-[a-z0-9]+(="[^"]*")?/g, '');
    const disabled = /(^|\s)disabled(\s|$)/.test(bare);
    out.push({ data, label, disabled });
  }
  return out;
}

/** 找第一个「带某个 data 键且未 disabled」的按钮 */
export const findBtn = (btns, key) => btns.find(b => b.data[key] !== undefined && !b.disabled) || null;

/**
 * 按 `data-act` 的**值**找按钮。
 * ⚠️ 不能用「有没有 data-act」找 —— 页头还有 speed1 / speed4 / toggleMute，
 *    按存在性找会先命中它们（踩过：导致「进入第 2 幕」永远点不到）。
 */
export const findAct = (btns, action) =>
  btns.find(b => b.data.act === action && !b.disabled) || null;
