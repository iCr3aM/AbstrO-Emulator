/**
 * 真实点击模拟（click simulation）
 * ===============================================================
 * 它回答的问题和另外两个工具都不同：
 *
 *   headless-check  → 数值/平衡对不对
 *   playthrough     → 玩家能不能走到某个结局
 *   click-sim       → **界面上出现的按钮，点了到底有没有用**
 *
 * 为什么必须有它：2026-09-23 发现游戏在真实浏览器里**根本点不动** ——
 * 主循环每帧 `root.innerHTML = ...` 把 DOM 整个重建（60fps），
 * 而 `click` 事件要求 mousedown 与 mouseup 落在同一个节点上，桌面端于是永远点不中。
 * 同时所有弹窗都挂在 `#app` 里，**活不过一帧** → 路线抉择选不了、事件弹窗点不掉 → 无法通关。
 * 这类 bug **只能**靠「从渲染结果里解析按钮、再走真实点击路径」来暴露：
 * 前面两个工具都是直接调 core 函数，永远看不见 UI 的死活。
 *
 * 忠实性要求：
 *   1. 每一步都**重新渲染**，按钮只能从**渲染出来的 HTML 里**找（不直接调 core）。
 *   2. 走的是**事件委托**那条路径（从 dataset 解析意图再调 handler）。
 *      ⚠️ 这份 dispatch 是**手抄** `main.js` 的副本（浏览器的接线已抽到 `src/ui/bind.js`），
 *         不是同一段代码 —— 于是**漏抄新接线不会报错，只会静默失效**。
 *         每次 main.js 新增一条触发路径，都必须同步抄到这里（本轮就是漏抄了「幕自动推进 → 弹抉择」）。
 *   3. 断言里包含**结构约束**：弹窗必须不在 `#app` 里（否则会被下一帧擦掉）。
 */

import { createState } from '../src/core/state.js';
import { rates, derived, costOf, canAfford, purchase, unlocked } from '../src/core/economy.js';
import { ACTS, BUILDINGS, STAFF } from '../src/core/content.js';
import { tick } from '../src/core/engine.js';
import { render, renderChoice, renderEvent } from '../src/ui/render.js';
import { pendingEvent, resolveEvent, autoEventChoice } from '../src/core/events.js';
import { applyChoice } from '../src/core/engine.js';
import { evaluateRetirement, endingName } from '../src/core/endings.js';
import { headcount } from '../src/core/staff.js';
import { acceptOffer, suggestContract } from '../src/core/contracts.js';
import { useSkill, SKILL_IDS } from '../src/core/skills.js';

// ─────────────────────────── 极简 DOM ───────────────────────────
function makeNode(tag = 'div') {
  const n = {
    tagName: tag, className: '', innerHTML: '', textContent: '',
    dataset: {}, disabled: false, children: [], parentNode: null, style: { setProperty() {} },
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
globalThis.document = {
  createElement: makeNode,
  getElementById: () => null,
  addEventListener() {},
  body: makeNode('body'),
};
globalThis.performance = globalThis.performance || { now: () => Date.now() };

/** 把渲染出来的 HTML 里所有「可点按钮」解析出来（含 disabled 状态） */
function buttonsIn(html) {
  const out = [];
  const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const label = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const data = {};
    const dre = /data-([a-z0-9]+)="([^"]*)"/g;
    let d;
    while ((d = dre.exec(attrs))) data[d[1]] = d[2];
    // disabled 是裸属性，用「属性边界」精确匹配，避免命中 "not-disabled" 之类
    const disabled = /(^|\s)disabled(\s|$)/.test(attrs.replace(/data-[a-z0-9]+="[^"]*"/g, ''));
    out.push({ data, label, disabled });
  }
  return out;
}

/** 找第一个匹配 data 键（且未 disabled）的按钮 */
const findBtn = (btns, key) => btns.find(b => b.data[key] !== undefined && !b.disabled) || null;

// ─────────────────────────── 断言 ───────────────────────────
let pass = 0; const fails = [];
const check = (name, ok, extra = '') => { if (ok) pass++; else fails.push(`${name}${extra ? ' —— ' + extra : ''}`); };

// ─────────────────────────── 模拟一局（全部靠「点」）───────────────────────────
console.log('');
console.log('  ╔══════════════════════════════════════════════════════════════════════════╗');
console.log('  ║  真实点击模拟：从渲染结果里找按钮 → 走事件委托 → 断言每一步真的生效      ║');
console.log('  ╚══════════════════════════════════════════════════════════════════════════╝');
console.log('');

const root = makeNode('div');
const overlay = makeNode('div');

// 与 main.js 的 dispatch 同构（手抄副本）：解析 dataset → 调 handler。
// ⚠️ 「同构」不是「同一段代码」—— 新增触发路径必须同步抄过来，漏抄不会报错、只会静默失效
//    （本轮实测：漏了「幕自动推进 → 弹抉择」，`s.choices` 一直是 0）。
function click(b) {
  const d = b.data;
  if (d.tab !== undefined) return;
  if (d.buy !== undefined) { purchase(s, d.buy, Number(d.k || 1)); return; }
  if (d.act === 'retire') { retiring = true; return; }
  if (d.act === 'toggleMute') { s.muted = !s.muted; return; }
  if (d.choice !== undefined) { applyChoice(s, d.choice); choiceModal = false; return; }
  if (d.opt !== undefined) { resolveEvent(s, Number(d.opt), rates(s)); return; }
  if (d.bid !== undefined) { const [id, q] = d.bid.split(':'); acceptOffer(s, id, q, rates(s)); return; }
  /**
   * 三人技能（GDD 4.5）。`main.js` 的接线是 `if (d.skill !== undefined) return handlers.skill(...)`。
   *
   * ⚠️ 这条曾经**漏抄**（本文件顶部那条警告说的就是这个病）：
   * 2026-09-26 代码 / 人脉两条链并入资金后，`skillFactors().money`（1.44 → 增益期 ~13）
   * 成了资金产出**唯一**的乘数级增长源，于是「没点技能」从「少赚一点」变成**致命**——
   * 同一个模拟从 5.7 h 通关退化成第 7 幕卡死 400 h（净利率被 salaryFrac + scaleFrac
   * 吃到 ≈ 0，压力机制反复卖设施又买回来，市值再也涨不动）。
   * 漏抄不会报错，只会静默失效，所以这里补上，并在末尾加一条断言守着它。
   */
  if (d.skill !== undefined) { if (useSkill(s, d.skill)) skillPresses++; return; }
}

const s = createState();
s.rngSeed = 20260809;
let choiceModal = false, retiring = false, retired = false, ending = null;
let skillPresses = 0;               // 技能行按钮真的被点到过几次（末尾断言用）
let lmSeen = false;                 // 地标按钮断言只报一次，避免刷屏
/** 上一帧看到的幕次 —— 与 main.js 的 draw() 同名游标，用途见下方循环里的 hook */
let lastAct = s.act;

/** 渲染一次，返回「玩家能看到的按钮」 */
function look(tab) {
  render(root, s, tab, { setTab() {}, buy() {}, choice() {}, retire() {}, bid() {}, drop() {}, capital() {}, skill() {}, toggleMute() {} });
  return buttonsIn(root.innerHTML);
}

const T0 = process.hrtime.bigint();
let seconds = 0;
const LIMIT = 400 * 3600;
let think = 0;

while (seconds < LIMIT && !retired) {
  const R = rates(s);
  tick(s, 1);
  seconds += 1;

  // 与 main.js 的 draw() 同构：幕由 `tick` 自动推进（玩家不点任何按钮），
  // 所以这里必须自己发现「进了新幕」并把路线抉择弹出来 —— 少了这一步，
  // `s.choices` 永远是空的（实测：0 次），「选路」这条玩家必经的接线就等于没被覆盖。
  if (s.act !== lastAct) { lastAct = s.act; choiceModal = true; }

  // ── 弹窗优先级：抉择事件 → 路线抉择（都和浏览器里一样，必须先点掉）
  const ev = pendingEvent(s);
  if (ev) {
    // 弹窗必须渲染在 overlay（stub 的 appendChild 会记进 children，用它断言结构）
    while (overlay.children.length) overlay.removeChild(overlay.children[0]);
    renderEvent(overlay, ev, () => {}, () => true);
    check('事件弹窗渲染到了 #overlay（不在 #app，否则活不过一帧）', overlay.children.length === 1);
    check('弹窗里的按钮在界面上真实存在', buttonsIn(overlay.children[0].innerHTML).some(x => x.data.opt !== undefined));
    const btns = buttonsIn(overlay.children[0].innerHTML).filter(x => x.data.opt !== undefined);
    const b = btns.find(x => !x.disabled) || btns[0];
    if (b) click(b);
    continue;
  }
  if (choiceModal) {
    while (overlay.children.length) overlay.removeChild(overlay.children[0]);
    renderChoice(overlay, s.act, () => {});
    const b = findBtn(buttonsIn(overlay.children[0].innerHTML), 'choice');
    if (b) click(b);
    continue;
  }
  /**
   * 点了退休（`main.js` 的 `retire() { finishRetirement(); }`）。
   * 第三批（2026-09-26）结局收敛为唯一一个：判据是退休那一刻 `s.worldRank === 1`。
   * 走到第 8 幕 ⇒ 市值已越过终章门槛（远超世界榜首）⇒ 名次必为 1 ⇒ 判「登顶」。
   */
  if (retiring) {
    const res = evaluateRetirement(s);
    ending = res.ending;
    retired = true;
    break;
  }

  // ── 正常操作：每 10 秒看一眼界面、点一次 ──
  think += 1;
  if (think % 10) continue;

  const btns = look(0);                       // 主界面（技能行与地标的购买按钮都在这里）
  // 三人技能「就绪就放」：线上唯一的入口是 HUD 技能行的按钮（`render.js` 的 data-skill），
  // 后台没有自动释放（`engine.autoSkillTick` 只在自检里打开）——玩家不点就是没点，必须模拟出来。
  const skBtn = btns.find(b => b.data.skill !== undefined && !b.disabled);
  if (skBtn) click(skBtn);
  if (card1(btns)) continue;
  const blds = look(1);                       // 建设页

  // 该买地标了吗 —— 按钮必须**在界面上真的存在**（这就是本次报的那个 bug）
  const lmId = ACTS[s.act].landmark;
  if ((s.buildings[lmId] || 0) === 0 && canAfford(s, lmId)) {
    const lmBtn = btns.find(b => b.data.buy === lmId && b.data.k === '1');
    if (!lmSeen) { lmSeen = true; check(`地标「${lmId}」买得起时，界面上有购买按钮`, !!lmBtn); }
    if (lmBtn) click(lmBtn);
    continue;
  }
  // 顺手点掉顾问建议
  const sug = suggestContract(s, R);
  if (sug) {
    const biz = look(2);
    const bidBtn = biz.find(b => b.data.bid && b.data.bid.startsWith(sug.offerId + ':'));
    if (bidBtn) { click(bidBtn); continue; }
  }
  // ⚠️ 这里**删掉**了原先「找 `data-staff` 按钮 → 点它来培训」的一段：
  //    4 页 UI 里根本没有员工页（`render.js` 全库 0 处 `data-staff`），那段永不命中 ——
  //    既不是有效断言，也不是死代码保护，只是一句假装存在的接线。
  //    培训现在唯一的入口是后台自动化（`engine.autoStaffTick`，跑在 `tick` 里、无需按钮），
  //    所以对它的看守改成**循环结束后的断言**（见下方「员工培训由后台自动化执行」）。
  // 买最便宜的建筑（模拟「有钱就花」）
  let best = null, bc = Infinity;
  for (const bb of BUILDINGS) {
    if (bb.kind === 'landmark' || !unlocked(s, bb.id) || !canAfford(s, bb.id)) continue;
    const c = costOf(bb.id, s.buildings[bb.id] || 0);
    if (c.amount < bc) { bc = c.amount; best = bb.id; }
  }
  if (best) {
    const bb = blds.find(x => x.data.buy === best && x.data.k === '1');
    if (bb) click(bb);
  }
}

/**
 * 主界面上的大按钮：第 8 幕的「关灯 · 退休」。
 * ⚠️ 必须按 `data-act` 的**值**找，不能用「有没有 data-act」找 ——
 *    页头还有 speed1 / speed4 / speed8 / toggleMute 四个同样带 data-act 的按钮，
 *    按存在性找会先命中它们，导致按钮永远点不到（这里踩过）。
 * ⚠️ 「进入下一幕」按钮本批已删（幕改由市值门槛在 `tick` 里自动推进），
 *    所以这里只剩退休 —— 它仍要能点，否则模拟永远走不到结局。
 */
function card1(btns) {
  const adv = btns.find(b => b.data.act === 'retire' && !b.disabled);
  if (adv) { click(adv); return true; }
  return false;
}

/**
 * 员工培训的接线断言（2026-09-25 Task 4 修复轮）。
 *
 * ⚠️ 这里曾经是「找 `data-staff` 按钮 → 点它」的一段**操作**，但 4 页 UI 里没有员工页
 *    （`render.js` 全库 0 处 `data-staff`），那段永不命中：既不是有效断言，也不是死代码保护。
 *    培训现在唯一的入口是后台自动化 `engine.autoStaffTick`（跑在 `tick` 里、不需要任何按钮），
 *    所以改成**断言**：跑到最后确实有员工被练上了级。少了它，「培训是否真的在自动发生」
 *    就又成了一条无人看守的静默路径 —— 与 F1 那条「漏抄触发路径」是同一类病。
 */
check('员工培训由后台自动化执行（无需任何按钮）',
  STAFF.some(g => s.staff[g.id].level > 1 && headcount(s, g.id) > 0),
  `终局等级 ${STAFF.map(g => `${g.id}:L${s.staff[g.id].level}`).join(' ')}`);

/**
 * ⚠️ 整局健康的三个**承重**断言（2026-09-25 最终修复波 W1）。
 *
 * 为什么必须有牙：下面「关键节点」那三行原本只是 `console.log`，从不进 `check()`，
 * 而退出码只看 `fails.length` —— 于是「卡在第 2 幕 + 0 次抉择 + 无结局 + 超时」这种
 * **整局退化**仍然退出码 0、报 0 失败（Task 4 的 F1 正是这样溜过审查的）。
 * click-sim 是仓库里唯一一条端到端闸门（`probe` 结构上补不上「真渲染 → 找按钮 → 断言生效」
 * 这个洞），所以它必须能失败：测不出通关就不能退出码 0。
 */
check('走到第 8 幕（幕由市值门槛自动推进，无需玩家操作）', s.act === 8, `实为第 ${s.act} 幕`);
check('至少发生一次路线抉择（「进新幕弹抉择」的接线生效）', s.choices.length >= 1, `实为 ${s.choices.length} 次`);
check('走到结局', !!ending, '模拟结束时没有结局');
/**
 * 技能行这条接线的牙：漏抄 `data-skill` 会让整局在第 7 幕卡死 400 h（见 `click()` 里的警告），
 * 而它**不会**让任何别的断言失败 —— 只会让时长悄悄变成 70 倍。所以这里必须硬判。
 */
check('三人技能由 HUD 技能行的按钮释放（main.js 的 data-skill 接线）',
  skillPresses >= SKILL_IDS.length,
  `实为 ${skillPresses} 次，${SKILL_IDS.length} 个技能各至少该放一次`);

const ms = Number(process.hrtime.bigint() - T0) / 1e6;

// ─────────────────────────── 报告 ───────────────────────────
console.log('  ── 关键节点 ──');
console.log(`  车库是否买成：${(s.buildings.garage || 0) >= 1 ? '✅' : '❌'} ｜ 当前第 ${s.act}/8 幕 ｜ 模拟 ${(seconds / 3600).toFixed(1)} 游戏小时`);
console.log(`  路线抉择是否生效：${s.choices.length ? '✅ ' + s.choices.length + ' 次' : '❌ 一次都没选'} ｜ 已发生事件 ${s.events.count} 次`);
console.log(`  是否走到结局：${ending ? '✅ 「' + endingName(ending) + '」' : '❌ 没走到'}`);
console.log('');

console.log('  ── 结构约束（这次 bug 的根因就在这里）──');
check('render() 产出的 HTML 里没有弹窗（弹窗只能挂在 overlay）', !root.innerHTML.includes('class="modal"'));
console.log(`  ${root.innerHTML.includes('class="modal"') ? '❌' : '✅'} 弹窗一律挂在 #app 之外（#overlay）—— 否则会被下一帧 innerHTML 重建擦掉`);
console.log('');

console.log('  ── 断言 ──');
for (const f of fails) console.log('  ❌ ' + f);
console.log(`  ${pass} 项通过${fails.length ? `，${fails.length} 项失败` : ''} ｜ 耗时 ${(ms / 1000).toFixed(1)}s`);
console.log('');
console.log('BRIEF ' + JSON.stringify({
  act: s.act, garage: s.buildings.garage || 0, choices: s.choices.length,
  events: s.events.count, ending, hours: +(seconds / 3600).toFixed(1), skills: skillPresses, pass, fail: fails.length,
}));
console.log('');
process.exit(fails.length ? 1 : 0);
