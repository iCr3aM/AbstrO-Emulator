/**
 * 流程探针（flow probes）—— 保证**每个流程都真的可达**
 * ===============================================================
 * 用户要求：「一定要确保每个流程都有探针（保证游戏可达性）以及一定要进行真实模拟，
 *            而不是仅凭代码做模拟」。
 *
 * 所以这个文件里每一条探针都遵守两条规矩：
 *   ① **动作从界面来**：先在真实渲染结果里找到那个按钮（`buttonsIn(root.innerHTML)`），
 *      找不到就判失败 —— 这正是「凑够钱却没有买地标的按钮」那个 bug 的探针形态。
 *   ② **结果看可见状态**：断言状态里真的变了（资源 / 数量 / 幕次 / 日志 / 字符串），
 *      而不是断言「函数返回了 true」。
 *
 * 另外还有一条**结构性探针**：渲染出的 HTML 里出现的每个 `data-*` 动作键，
 * 都必须在 dispatch 表里有对应的处理分支 —— 防止以后加了按钮却忘了接线。
 */

import { readFileSync } from 'node:fs';
import { installDom, makeNode, buttonsIn, findBtn, findAct } from './dom-stub.mjs';
installDom();

import { createState, serialize, deserialize, SAVE_KEY } from '../src/core/state.js';
import {
  CLIENTS, CLIENT_NAMES, TIER_BAND, RIVAL,
} from '../src/core/content.js';
import { rates, derived, costOf, purchase, canAfford, facilityCap } from '../src/core/economy.js';
import { ACTS, BUILDINGS, STAFF, SEC_PER_YEAR, ACT_NARRATION, PRESSURE, LANDMARK_K, CURVE_RATIO, OFFLINE_MODIFIER } from '../src/core/content.js';
import { TARGET_SEC_PER_YEAR, CURVE_MID, NARRATIVE_YEARS } from './curve-targets.mjs';
import { tick, canAdvance, advanceAct, applyChoice, LOG_MAX, autoStaffTick } from '../src/core/engine.js';
import { pendingEvent, resolveEvent, EVENTS, moneyEffectWithinCap } from '../src/core/events.js';
import {
  acceptOffer, suggestContract, offerInterval, makeOffer, hasFreeSlot,
} from '../src/core/contracts.js';
import { loyaltyFactor } from '../src/core/staff.js';
import { useSkill } from '../src/core/skills.js';
import { ROUNDS } from '../src/core/finance.js';
import {
  evaluateRetirement, endingName, ENDING_TEXT,
} from '../src/core/endings.js';
import { ALL_EVENTS, DAILY, CHOICE, MILESTONE } from '../src/core/event-data.js';
import { applyOffline, save, wipe, disableSave, enableSave, OFFLINE_CAP_SEC } from '../src/core/save.js';
import { gameDate, gameYear, gameMonths, calMonthOf, ACT_MONTHS, MONTHS_TOTAL, TOTAL_YEARS } from '../src/core/format.js';
import { createWorld, advanceWorld, ranking, worldDate, worldTick } from '../src/core/world.js';
import { themeOf } from '../src/core/art.js';
import { render, renderChoice, renderEvent, renderIntro, renderNotTop, renderRetirement, renderOffline, TABS, fmt, toggleFold } from '../src/ui/render.js';
import {
  bindActions, findActionEl, PRIMARY_EVENT, KEYBOARD_EVENT, ACTION_KEYS,
} from '../src/ui/bind.js';
import { armDeleteSave, deleteSaveArmed, disarmDeleteSave, renderSettings } from '../src/ui/render.js';

const root = makeNode('div');
const overlay = makeNode('div');

// ─────────────────────────── 与 main.js 同构的 dispatch ───────────────────────────
// 键名与 main.js 的 dispatch 必须一致；下面有一条探针会校验「渲染出的键都有人管」。
const handlers = {
  setTab() {}, buy() {}, choice() {}, advance() {}, retire() {}, bid() {},
  skill() {}, toggleMute() {},
  eventOption() {}, retireClose() {}, closeModal() {}, introStart() {},
};

// `k` 是购买数量（`data-buy="x" data-k="1"`），是**量词不是动作**，跟着 data-buy 一起用
// `fold` 挂在 `<summary>` 上（不是 `<button>`），所以下面的按钮解析扫不到它 —— 由折叠块那条探针单独守
const HANDLED = new Set(['tab', 'buy', 'k', 'choice', 'act', 'bid',
  'skill', 'opt', 'close', 'intro', 'fold']);

/** 走 main.js 里那条 dispatch 路径（不是直接调 core） */
function clickBtn(s, b) {
  const d = b.data;
  if (d.tab !== undefined) return;
  if (d.buy !== undefined) return purchase(s, d.buy, Number(d.k || 1));
  if (d.act === 'advance') { if (canAdvance(s)) advanceAct(s); return; }
  if (d.act === 'retire') return;
  if (d.act === 'toggleMute') { s.muted = !s.muted; return; }
  if (d.act === 'speed1' || d.act === 'speed4' || d.act === 'speed8') {
    s.speed = Number(d.act.slice(5)) || 1; return;
  }
  if (d.choice !== undefined) return applyChoice(s, d.choice);
  if (d.opt !== undefined) return resolveEvent(s, Number(d.opt), rates(s));
  if (d.bid !== undefined) { const [id, q] = d.bid.split(':'); return acceptOffer(s, id, q, rates(s)); }
  if (d.skill !== undefined) return useSkill(s, d.skill);
  if (d.intro !== undefined) { s.introSeen = true; return; }
}

/** 渲染某个标签页，返回玩家能点到的按钮 */
function look(s, tab) {
  render(root, s, tab, handlers);
  return buttonsIn(root.innerHTML);
}

/** 渲染某个标签页，返回原始 HTML（文案探针要检查玩家能看见的文字） */
function htmlOf(s, tab) {
  render(root, s, tab, handlers);
  return root.innerHTML;
}

/** 剥掉标签，只留玩家真正会读到的文字 */
const visible = html => String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// ─────────────────────────── 探针框架 ───────────────────────────
const rows = [];
function probe(name, fn) {
  try {
    const ev = fn();
    rows.push({ ok: true, name, ev: ev || '已生效' });
  } catch (e) {
    rows.push({ ok: false, name, ev: e.message || String(e) });
  }
}
const bad = msg => { throw new Error(msg); };
const need = (cond, msg) => { if (!cond) throw new Error(msg); };
/** 断言「这个按钮在界面上真的存在」——找不到就是可达性失败 */
const needBtn = (btns, key, what) => {
  const b = findBtn(btns, key);
  need(b, `界面上找不到「${what}」的按钮（key=${key}）`);
  return b;
};

/**
 * 造一个**末期**存档，好让所有流程都解锁。
 * ⚠️ 幕次必须是 8：设施、融资轮、后 IPO 资本操作都有 minAct 门槛，
 *    一开始写成第 1 幕，结果「没有已解锁的设施 / 没有融资 / 没有资本按钮」三条探针全假失败。
 */
function lateState() {
  const s = createState();
  s.rngSeed = 20260809;
  s.act = 8;
  for (const b of BUILDINGS) {                   // 直给资源，避免探针等着挂机
    if (b.kind !== 'landmark') s.buildings[b.id] = 3;
  }
  s.resources.rep = 1200;
  // 资金要给足（2026-09-24 营收锚定后量纲：年营收 ~4e12，地标最贵 3e12——
  // 给 1e13 足够任何「买得起」场景，又不会大到让百分比公式失真）
  s.resources.money = 1e13;
  for (const g of STAFF) s.staff[g.id].level = 6;
  return s;
}

// ══════════════════════════ 探针开始 ══════════════════════════

// ── 开幕剧情 / 开局必须点击（GDD 2.1 / 4.6）──
probe('开幕剧情 · 第一屏有「开工」按钮', () => {
  const s = createState();
  while (overlay.children.length) overlay.removeChild(overlay.children[0]);
  renderIntro(overlay, () => {});
  const btns = buttonsIn(overlay.children[0].innerHTML);
  const b = needBtn(btns, 'intro', '开工');
  need(!b.disabled, '「开工」是 disabled');
  clickBtn(s, b);
  need(s.introSeen, '点了「开工」但 introSeen 没置位（下次进游戏还会看到）');
  const text = visible(overlay.children[0].innerHTML);
  return `「${text.slice(0, 30)}…」`;
});

probe('开局 · 点击期已整块删除，底料折进 FOUNDER_BASE', () => {
  /**
   * 2026-09-25 用户拍板 ⑩：`clicks.js` 整块删（折进正常产出）。
   * 三条守门：① 界面上没有点击按钮 ② 开局就有被动产出（不是「不点就没产出」）
   * ③ 技能按钮迁到了主界面。
   */
  const s = createState();
  const btns = look(s, 0);
  need(!btns.some(b => b.data.click !== undefined || b.data.clickup !== undefined),
    '主界面上还有点击区按钮（应已删除）');
  need(s.clicks === undefined && s.autoClick === undefined, 'state 里还有 clicks / autoClick 字段');
  const before = s.resources.money;
  tick(s, 1);                                       // 1 秒被动产出
  need(s.resources.money > before, '开局没有被动资金产出（折进 FOUNDER_BASE 的那条丢了）');
  const skillBtns = btns.filter(b => b.data.skill !== undefined);
  need(skillBtns.length === 3, `主界面应有 3 个技能按钮（实际 ${skillBtns.length}）——「人」页已并入`);
  return `点击区已删；1 秒被动产出资金 +${(s.resources.money - before).toFixed(4)}；技能 3 个在主界面`;
});

// ── 建筑 / 设施 ──
probe('建筑 · 买产出建筑', () => {
  const s = lateState();
  const btns = look(s, 1);
  const list = btns.filter(b => b.data.buy && Number(b.data.k) === 1 && !b.disabled);
  need(list.length, '建设页没有任何可买的按钮');
  const target = BUILDINGS.find(x => x.kind === 'money' && x.act <= s.act);
  const b = btns.find(x => x.data.buy === target.id && x.data.k === '1');
  need(b, `界面上找不到「${target.name}」的购买按钮`);
  const n0 = s.buildings[target.id] || 0;
  const r0 = rates(s).netMoney;
  clickBtn(s, b);
  need((s.buildings[target.id] || 0) === n0 + 1, '数量没增加');
  // 2026-09-24 建造时间机制：购买后进入施工，**落成后才计产出** —— 等 30 秒让工期走完
  for (let i = 0; i < 30; i++) tick(s, 1);
  need(rates(s).netMoney > r0, '买了产出建筑但（落成后）净收入没上升');
  return `${target.name} ${n0} → ${n0 + 1} 座，净收入 ${r0.toExponential(2)} → ${rates(s).netMoney.toExponential(2)}`;
});

probe('设施 · 买入提升乘数', () => {
  const s = lateState();
  const fac = BUILDINGS.find(x => x.kind === 'mul' && x.act <= s.act);
  need(fac, '没有已解锁的设施');
  const btns = look(s, 1);
  const b = btns.find(x => x.data.buy === fac.id && x.data.k === '1');
  need(b, `界面上找不到设施「${fac.name}」的购买按钮`);
  const m0 = rates(s).moneyMul;
  clickBtn(s, b);
  // 建造时间机制：设施有工期，落成后才计入乘数
  for (let i = 0; i < 120; i++) tick(s, 1);
  need(rates(s).moneyMul > m0, '买了设施但（落成后）乘数没上升');
  return `${fac.name}：资金乘数 ${m0.toFixed(2)} → ${rates(s).moneyMul.toFixed(2)}`;
});

// ── 事件金额上限（C14）与惩罚性事件的力度 ──
probe('事件 · 没有一条事件的金额超过 C14 上限', () => {
  const over = [];
  for (const [type, pool] of Object.entries(ALL_EVENTS)) {
    for (const ev of pool) {
      const effs = ev.options ? ev.options.map(o => o.eff) : [ev.eff];
      for (const e of effs) {
        if (!moneyEffectWithinCap(e)) over.push(`${type}/${ev.id}（money=${e && e.money}）`);
      }
    }
  }
  need(!over.length, `越界：${over.slice(0, 6).join('、')}`);
  return `日常 ${ALL_EVENTS.daily.length} + 抉择 ${ALL_EVENTS.choice.length} + 里程碑 ${ALL_EVENTS.milestone.length} 条，金额全部 ≤ ${(EVENTS.moneyCapFrac * 100).toFixed(0)}% 年营收`;
});

probe('数值压力 · 惩罚性事件真的能咬人（≥10% 年营收）', () => {
  /**
   * 这条探针守的是「C14 放宽」这件事**有没有实效**。
   * 上限从 5% 放到 30% 只是允许，还必须真的有事件用到这个额度 ——
   * 否则玩家依然不需要「安全垫」，「有钱就花」依旧没有代价。
   */
  const s = createState();
  s.act = 6;
  s.buildings.biz1 = 60; s.buildings.biz2 = 30; s.buildings.biz3 = 10;
  const annual = Math.max(1, rates(s).moneyRate) * SEC_PER_YEAR;
  const punch = [];
  for (const ev of [...ALL_EVENTS.daily, ...ALL_EVENTS.choice]) {
    const effs = ev.options ? ev.options.map(o => o.eff) : [ev.eff];
    for (const e of effs) if (e && e.money <= -0.10) punch.push({ id: ev.id, frac: e.money, title: ev.title });
  }
  need(punch.length >= 4, `只有 ${punch.length} 条选项达到 10% 年营收，咬不动人`);
  const worst = punch.reduce((a, b) => (b.frac < a.frac ? b : a));
  return `${punch.length} 条选项 ≥10% 年营收；最重一条「${worst.title}」−${(-worst.frac * 100).toFixed(0)}%（约 ${(annual * -worst.frac).toExponential(2)} 资金）`;
});

// ── 数值压力：房租 / 电费（GDD 6.5「资金墙」）──
probe('数值压力 · 房租与电费真的在扣钱，但正常经营不会进入压力', () => {
  const s = createState();
  s.act = 3;
  s.buildings.biz1 = 20; s.buildings.biz2 = 6;
  const R = rates(s);
  need(R.rent > 0, '房租是 0，等于没有固定支出');
  need(R.netMoney > 0, `正常经营下净收入已经是负的（${R.netMoney.toExponential(2)}）`);
  need(R.upkeep > R.rent + R.power, '工资没有被算进 upkeep');
  return `房租 ${R.rent.toExponential(2)}/秒 + 电费 ${R.power.toExponential(2)}/秒（${R.facilityCount} 座设施），净收入仍为正`;
});

probe('数值压力 · 过度堆设施会把净收入压成负数', () => {
  const s = createState();
  s.act = 4;
  s.buildings.biz1 = 60; s.buildings.biz2 = 30; s.buildings.xuedi = 30;
  const before = rates(s).netMoney;
  for (const b of BUILDINGS) if (b.kind === 'mul') s.buildings[b.id] = 120;
  const R2 = rates(s);
  need(R2.netMoney < before, '堆了一堆设施，净收入没有下降（电费没起作用）');
  need(R2.netMoney < 0,
    `堆到 ${R2.facilityCount} 座设施，净收入仍是 +${R2.netMoney.toExponential(2)}/秒 —— `
    + `「有钱就花」没有代价，玩家没有理由克制（电费系数 ${'powerFracPerFacility'} 需要调大）`);
  return `设施 0 → ${R2.facilityCount} 座：净收入 ${before.toExponential(2)} → ${R2.netMoney.toExponential(2)} 每秒（转为亏损）`;
});

// ── 曲线（2026-09-25 曲线层 §4）──
probe('曲线 · 地标造价 = 本幕达标年营收 × LANDMARK_K（不再有独立旋钮）', () => {
  /**
   * 这一条守的是「一幕只有一个时长旋钮」这条设计决定（曲线层 ① ②）。
   * 旧写法里地标造价是 8 个手写常数，与市值门槛**各自**影响幕长 ——
   * 于是出现「第 8 幕把造价下调，挂机反而更慢」的混沌（content.js 旧注释有实测记录）。
   * 钉成派生量之后，想改一幕多长，只能改 ACTS[].mcap 一个数。
   */
  need(LANDMARK_K > 0 && LANDMARK_K < 1, `LANDMARK_K 应落在 (0,1)，实为 ${LANDMARK_K}`);
  for (let a = 1; a <= 8; a++) {
    const b = BUILDINGS.find(x => x.id === ACTS[a].landmark);
    need(b, `第 ${a} 幕的地标 ${ACTS[a].landmark} 不在 BUILDINGS 里`);
    const want = ACTS[a].mcap / ACTS[a].ps * LANDMARK_K;
    need(Math.abs(b.cost.money - want) <= want * 1e-9,
      `第 ${a} 幕「${b.name}」造价 ${b.cost.money.toExponential(4)} 应为 ${want.toExponential(4)}（= mcap/ps × ${LANDMARK_K}）`);
    need(b.r === 1, `地标「${b.name}」的 r 应为 1（只买一座，没有成本曲线），实为 ${b.r}`);
    need(b.kind === 'landmark', `「${b.name}」的 kind 应为 landmark`);
  }
  return `8 座地标造价全部派生自 ACTS[].mcap（LANDMARK_K = ${LANDMARK_K}）`;
});

probe('曲线 · 全建筑（非地标）严格满足 cost(n) = base × 1.13^n', () => {
  /**
   * spec §9.1 断言 #5。三条链、设施，一律同一条曲线 ——
   * 这是「成本按指数增长 × 产出按线性增长」这条通用软上限的前提
   * （Kongregate《The Math of Idle Games》Part I）：
   * 只要有一座建筑的 r 还停在 1.3x，它在同一局里的「逆转等级」就与别座不同，
   * 于是「换一种买法通关时间差 5 倍」的老问题会从那一座重新长出来。
   */
  need(Math.abs(CURVE_RATIO - 1.13) < 1e-9, `CURVE_RATIO 应为 1.13，实为 ${CURVE_RATIO}`);
  const off = BUILDINGS.filter(b => b.kind !== 'landmark' && b.r !== CURVE_RATIO);
  need(!off.length, `仍有 ${off.length} 座建筑没统一 r：${off.map(b => `${b.name}(${b.r})`).join('、')}`);
  // 公式本体也要验一遍（不能只查字段）：costOf 的第 n 座 = base × r^n
  const one = BUILDINGS.find(b => b.kind !== 'landmark');
  const c0 = costOf(one.id, 0).amount;
  for (const n of [1, 5, 13]) {
    const want = c0 * Math.pow(CURVE_RATIO, n);
    const got = costOf(one.id, n).amount;
    need(Math.abs(got - want) <= want * 1e-9, `${one.name} 第 ${n} 座 = ${got}，应为 ${want}（base × 1.13^${n}）`);
  }
  return `${BUILDINGS.filter(b => b.kind !== 'landmark').length} 座建筑统一 r = ${CURVE_RATIO}，costOf 逐座复利核对通过`;
});

probe('曲线 · 第 1–7 幕每幕都解锁至少一个新 tier（第 8 幕是终章，不要求）', () => {
  /**
   * spec §4：「8 幕各对应一个市值量级带；跨幕靠解锁新 tier，而不是把旧建筑造价调爆」。
   * 第 8 幕是「交接与退休」，刻意不再加产能（perp 的 desc 就写着「它不产生任何收入」），
   * 所以只查到第 7 幕 —— 这是设计，不是缺口。
   */
  const miss = [];
  for (let a = 1; a <= 7; a++) {
    if (!BUILDINGS.some(b => b.act === a && b.kind !== 'landmark')) miss.push(a);
  }
  need(!miss.length, `第 ${miss.join('、')} 幕没有任何新建筑 ——「跨幕靠解锁新 tier」落空`);
  return '第 1–7 幕各有新 tier；第 8 幕是交接与退休，不再加产能（设计如此）';
});

probe('曲线 · 时间旋钮与 seconds 镜像都等于目标（一局 4.5h / 35 年）', () => {
  /**
   * 这一条守两件事：
   *   ① SEC_PER_YEAR = 目标秒数 / 35 个游戏年 —— 它是「一局多少真实秒」的旋钮，
   *      改小 ⇒ 一年变短 ⇒ 同样的收入换算成市值更快 ⇒ 幕更短。它必须等于标定目标，
   *      否则「标定到 4.5h」和「线上跑的口径」是两件事。
   *   ② ACTS[].seconds 是**目标镜像**（决定融资时点与幕内进度分母），不是实测值。
   */
  need(SEC_PER_YEAR === TARGET_SEC_PER_YEAR,
    `SEC_PER_YEAR 应为 ${TARGET_SEC_PER_YEAR}（= 目标总秒数 / 35 年），实为 ${SEC_PER_YEAR}`);
  for (let a = 1; a <= 8; a++) {
    const want = Math.round(CURVE_MID[a] * 3600);
    need(ACTS[a].seconds === want, `第 ${a} 幕 seconds 应为目标镜像 ${want}s，实为 ${ACTS[a].seconds}`);
  }
  return `SEC_PER_YEAR = ${SEC_PER_YEAR}｜8 幕 seconds 全部 = 目标秒数（合计 ${TARGET_SEC_PER_YEAR * 35 / 3600}h）`;
});

// ── 地标 / 幕次 / 抉择 ──
probe('地标 · 买得起时有购买按钮（曾整块缺失）', () => {
  const s = createState();
  s.resources.money = costOf('garage', 0).amount * 2;
  const btns = look(s, 0);
  const b = btns.find(x => x.data.buy === 'garage');
  need(b, '地标买得起，但界面上没有购买按钮（游戏无法推进）');
  need(!b.disabled, '按钮存在但是 disabled');
  clickBtn(s, b);
  need((s.buildings.garage || 0) === 1, '点了但地标没建成');
  return `车库办公室建成（${(costOf('garage', 0).amount / 1e4).toFixed(1)} 万）`;
});

probe('地标 · 最多只能建一座（地标 r = 1，多买是纯黑洞）', () => {
  /**
   * 曲线层最终审查 C1：`facilityCap` 曾对地标返回 Infinity ⇒ 量尺（headless-check 的
   * `if (canAfford(s, lmId)) purchase(s, lmId)` 循环）在引擎侧**没有任何座数守卫**。
   * 触发面：无 LP 的闸门路径（`npm run check` / `--no-contract` / `--choice=mixed`）下现金
   * 一直被顾问建议压在造价之下、一次都不触发；但**转生路径 `--lp≥50` 会触发** ——
   * 实测 `--lp=500` 首次触发时现金已达地标造价的 18 倍，旧上限 `Infinity` 会让它连买成批。
   * 即这是在 `--lp` 路径上**真实发生过**的失真。线上那条路径不存在（UI 建成后就没有按钮了），
   * 上限写进引擎（唯一真相源）后，这条探针守它不再被改回去。
   */
  const s = createState();
  s.resources.money = costOf('garage', 0).amount * 1000;
  need(facilityCap('garage') === 1, `地标上限应为 1，实为 ${facilityCap('garage')}`);
  need(purchase(s, 'garage'), '第一座应当买得成');
  need((s.buildings.garage || 0) === 1, `第一座买完座数应为 1，实为 ${s.buildings.garage || 0}`);
  need(!canAfford(s, 'garage'), '钱再多也不该认为第二座买得起');
  need(!purchase(s, 'garage'), '第二座必须买不成');
  need((s.buildings.garage || 0) === 1, `第二座必须没买进，实为 ${s.buildings.garage || 0}`);
  return `facilityCap=${facilityCap('garage')}｜买第二座被拒且座数仍为 1`;
});

probe('幕次 · 市值达标即自动进入下一幕（无需任何操作）', () => {
  /**
   * 第一批 §5：这是「挂机被世界甩开」的**最后一个残余原因** ——
   * 只要推进还挂在玩家手上（原来是「进入下一幕」按钮 + 人情门），挂机就必然落后。
   * 门槛直接读 `ACTS[].mcap`（内容表里本来就有），于是门槛 / 曲线 / 叙事三者在同一张表上。
   *
   * ⚠️ 座数必须**从门槛派生**，不能写死（曲线层 Task 4 R26）：旧夹具硬写 `biz1 = 20`，
   *    而 `biz1` 是线性产出 ⇒ 每次重标定门槛，那个数字都会失效（实测 20 座市值 401929
   *    < 新门槛 452500，样本失效）。写死数字就是写死一个必然过期的夹具。
   *
   * ⚠️ 为什么量**两点**（1 座 + 2 座）而不是 R26 字面的「1 座算单座市值再除」：
   *    市值对座数是**一次函数** `cap(n) = cap1 + (n − 1) × unitGain`，但 `unitCap`（1 座那次）
   *    里混着一块**不随座数走**的常数项（`FOUNDER_BASE.money` 的创始人自产）。
   *    直接 `ceil(mcap / unitCap)` 会**低估**座数：实测它给出 20 座 ⇒ 市值 401929 < 门槛 452500
   *    （正是 R26 记录的那个 401929）—— 夹具会**再一次**失效，那就等于没修。
   *    两点差分把这块常数项消掉（实测 23 座 ⇒ 461778 ≥ 452500），座数是解出来的、不是猜的。
   */
  const s = createState();
  s.buildings.biz1 = 1;                        // 只给 1 座，量出市值
  const cap1 = derived(s, rates(s)).marketCap;
  s.buildings.biz1 = 2;                        // 再加 1 座：差值即「单座边际市值」
  const unitGain = derived(s, rates(s)).marketCap - cap1;
  need(unitGain > 0, `单座边际市值 ${unitGain} 应为正数，否则无法从门槛派生座数`);
  const n = Math.ceil((ACTS[1].mcap - cap1) / unitGain) + 1;   // ⇒ cap(n) ≥ 门槛，恒成立
  s.buildings.biz1 = n;                        // 只给建筑，不给任何点击
  need(derived(s, rates(s)).marketCap >= ACTS[1].mcap,
    `${n} 座商务助理的市值 ${derived(s, rates(s)).marketCap} 还没过第 1 幕门槛 ${ACTS[1].mcap}（样本失效）`);
  need(canAdvance(s), '市值已过门槛，canAdvance 仍为 false');

  tick(s, 1);                                 // 一次 tick 就该自动推幕
  need(s.act === 2, `tick 之后仍是第 ${s.act} 幕（应自动进入第 2 幕）`);
  need(s.log.some(l => l.includes(ACTS[2].place)), '自动推幕没有写幕启叙事日志');
  return `${n} 座（门槛派生）市值 ${derived(s, rates(s)).marketCap.toExponential(2)} ≥ 门槛 ${ACTS[1].mcap.toExponential(2)} → 自动进入第 ${s.act} 幕`;
});

probe('晋升 · 5 个组都必须真的产生效果（不许有空承诺）', () => {
  /**
   * 这条探针的由来：做减法审计时，我一度以为「商务总监的效果没实现」——
   * `content.js` 的 `PROMOTE` 表里写着 `offerSpeed: 0.80`，而我 grep `offerSpeed` 全库无命中。
   * 后来读实际调用点才发现效果**是生效的**，只是写死在 `contracts.js` 的 `offerInterval()` 里。
   * **是我 grep 的方式错了，不是代码错了。**
   *
   * 但这类 bug 是真会发生的：玩家花 0.5 倍年营收买一个「什么都不做」的晋升，
   * UI 文案承诺效果、代码里漏接一条线，两边都不报错。
   * 所以这里对**每一个组**都断言：晋升之后，必须至少有一个可观测的下游值发生变化。
   *
   * 「可观测」故意取一个**宽签名**（三条产出 + 全局效率 + 合同刷新间隔），
   * 而不是逐个组去猜它该影响哪个字段 —— 猜错了探针会假红，那比不写还糟。
   * 以后给某个组加新效果，只要它真的生效，这条签名就会变，探针自动覆盖。
   */
  const s = createState();
  for (const g of STAFF) s.staff[g.id].level = 6;                 // 给个中等规模，别让系数退化
  for (const k of Object.keys(s.buildings)) s.buildings[k] = 10;
  s.resources.rep = 800;                                          // 让合同刷新处在有意义的区间

  const sig = x => {
    const R = rates(x);
    return [R.moneyRate, R.effMul, offerInterval(x)]
      .map(v => (typeof v === 'number' ? v.toFixed(9) : String(v))).join('|');
  };

  const dead = [];
  const lines = [];
  for (const g of STAFF) {
    const before = sig(s);
    s.staff[g.id].promoted = true;
    const after = sig(s);
    if (after === before) dead.push(`${g.id}(${g.name || ''})`);
    else lines.push(g.id);
    s.staff[g.id].promoted = false;                               // 复原，避免互相干扰
  }

  need(dead.length === 0,
    `这些组的晋升没有任何可观测效果（玩家花了 0.5 倍年营收买到空承诺）：${dead.join('、')}`);
  need(lines.length === STAFF.length, `只有 ${lines.length}/${STAFF.length} 组的晋升能观测到变化`);

  return `${lines.join(' / ')} 五组晋升后，产出 / 效率 / 合同刷新至少一项发生变化`;
});

probe('对手 · 必须具名，且名字只用在「正常商业竞争」上', () => {
  /**
   * 原来事件里永远只写「竞对」「对手」「有人」—— 一个从第 2 幕缠斗到第 6 幕的对手，
   * 玩家从头到尾不知道对方是谁。具名之后，挖角/诉讼/竞标才有重量。
   *
   * 这条探针守两件事，第二件**更重要**：
   *   ① 该具名的事件真的用了 RIVAL.name（不是泛称「对手」）
   *   ② ⚠️ **绝不能**把 RIVAL.name 用在「贿赂」「负面报道」这类违法或负面事件上 ——
   *      把这种事指名给一家真实存在的公司，性质就从事竞争描写变成了事实指控。
   *      这类事件里的对手必须保持匿名。
   */
  const name = RIVAL.name;
  const all = [...DAILY, ...CHOICE, ...MILESTONE];
  const txt = e => (e.title || '') + ' ' + (e.text || '');

  // ① 挖角 / 诉讼 / 技术路线取舍：应当具名
  const shouldName = all.filter(e => /挖人|挖角|竞业|端走|少走两年弯路/.test(txt(e)));
  need(shouldName.length >= 3, `应当具名的对手事件只有 ${shouldName.length} 条，数据可能变了`);
  const unnamed = shouldName.filter(e => !txt(e).includes(name));
  if (unnamed.length) {
    need(false, `这些事件里的对手还是泛称：${unnamed.map(e => e.id + '「' + (e.title || '') + '」').join('、')}`);
  }

  // ② 贿赂 / 负面报道：必须**保持匿名**
  const mustStayAnonymous = all.filter(e => /贿赂|信封|负面报道|一半是真的/.test(txt(e)));
  need(mustStayAnonymous.length >= 2, '找不到了那条「贿赂 / 负面报道」事件，数据可能变了');
  const leaked = mustStayAnonymous.filter(e => txt(e).includes(name));
  if (leaked.length) {
    need(false, `「${name}」被写进了违法/负面事件 ${leaked.map(e => e.id).join('、')} —— 必须去掉名字`);
  }

  // ③ 对手要在多个地方出现（只在一处提到名字，玩家仍然记不住它是谁）
  // ⚠️ 2026-09-26 第三批：回忆碎片（`fragments.js`）整块删，计数不再叠加碎片 —— 只数事件。
  const mentions = all.filter(e => txt(e).includes(name)).length;
  need(mentions >= 5, `对手只在 ${mentions} 处出现 —— 反复出现才有分量`);

  return `${name} 出现在 ${mentions} 处（事件）；贿赂与负面报道保持匿名`;
});

// 此处的「转生 · 跨周目字段」探针随传承 / 转生机制一起删（第三批 2026-09-26）：
// 传承与转生已整块删除，跨周目字段清单不再存在。

probe('合同 · 客户必须有名字（等级越高、对方越有名）', () => {
  /**
   * 合同卡片原来只显示「B 级 · 企业 · 订阅」—— 三个类别词，
   * 玩家要交付的对象**没有身份**。作者决定用**真实公司名**。
   *
   * 这条探针守三件事：
   *   ① 生成的报价必须带名字，且**不是**类别名（「企业」「小客户」这种）
   *   ② **接单后名字要一路带过去**（否则进行中的合同还是没身份）
   *   ③ 等级决定量级：D/C 取小、B/A 取中、S/战略 取大 —— 名字不能串档
   * ⚠️ 另外：取名必须走 `rand(s)`（种子随机），不能用 Math.random，否则自检不可复现。
   */
  const categoryNames = new Set(CLIENTS.map(c => c.name));
  const s = createState();
  s.act = 6; s.resources.rep = 900; s.resources.money = 1e12;
  const R = rates(s);

  const made = [];
  for (let i = 0; i < 30; i++) { const o = makeOffer(s, R); if (o) made.push(o); }
  need(made.length > 0, '一个报价都没生成');

  const noName = made.filter(o => !o.name);
  need(noName.length === 0, `${noName.length} 个报价没有客户名`);
  const isCategory = made.filter(o => categoryNames.has(o.name));
  need(isCategory.length === 0,
    `${isCategory.length} 个报价的名字还是类别名（${[...new Set(isCategory.map(o => o.name))].join('、')}）`);

  // 名字必须来自词表（按 类别 × 等级量级）
  const wrong = made.filter(o => {
    const pool = (CLIENT_NAMES[o.client] || {})[TIER_BAND[o.tier] ?? 0] || [];
    return !pool.includes(o.name);
  });
  /*
   * ⚠️ 必须写成 `if (wrong.length) need(false, …)`，不能写
   *    `need(wrong.length === 0, \`…${wrong[0].tier}…\`)` ——
   *    JS 的**实参是先求值的**，所以即便条件成立（wrong 为空），
   *    `${wrong[0].tier}` 也会被求值并直接抛异常。踩过。
   */
  if (wrong.length) {
    need(false, `${wrong.length} 个名字与「等级量级」对不上，例如 ${wrong[0].tier} 级用了「${wrong[0].name}」`);
  }

  // 接单后名字要带到进行中的合同里
  const o = made.find(x => hasFreeSlot(s, x.form)) || made[0];
  const before = s.contracts.active.length;
  let tries = 0;
  while (s.contracts.active.length === before && tries < 40) { acceptOffer(s, o.id, 'std', R); tries++; }
  const act = s.contracts.active[s.contracts.active.length - 1];
  if (act) need(act.name === o.name, `接单后名字丢了：「${o.name}」变成了「${act.name || '(空)'}」`);

  // 可复现：同样的种子，两次生成的名字序列必须一致
  const seq = st => { const out = []; for (let i = 0; i < 6; i++) { const x = makeOffer(st, rates(st)); if (x) out.push(x.name); } return out.join('|'); };
  const a1 = createState(); a1.act = 6; a1.resources.rep = 900; a1.resources.money = 1e12;
  const a2 = createState(); a2.act = 6; a2.resources.rep = 900; a2.resources.money = 1e12;
  need(seq(a1) === seq(a2), '同样的种子两次生成的客户名不一致 —— 说明用了 Math.random');

  return `${made.length} 个报价全部具名（如「${made[0].name}」）；等级与量级匹配；接单后保留；可复现`;
});

// 此处的「心结 · 数据层心愿完整」探针随心结系统一起删（第三批 2026-09-26）：
// 心结的数据与清算弹窗已随之整块删除。

probe('UI · 资源 HUD 必须在所有标签页可见', () => {
  /**
   * 守的是一个很朴素的可用性问题：**要花钱的页面必须看得到钱**。
   * 原来资源面板只长在主界面里，于是「人」页花资金培训/加薪/晋升、「建设」页花资金买建筑，
   * 都看不到自己有多少钱。所有成熟的放置游戏都会把资源条常驻在任意页面。
   */
  const s = createState();
  s.resources.money = 777;                 // 777 走 fmt 会原样显示（≥100 时取整），便于断言
  const bad = [];
  for (let t = 0; t < TABS.length; t++) {
    const html = htmlOf(s, t);
    const txt = visible(html);
    if (!/class="hud"/.test(html)) bad.push(`${TABS[t]}:没有 HUD`);
    else if (!/777/.test(txt)) bad.push(`${TABS[t]}:HUD 里没有资金数字`);
    if (!/净资产/.test(txt)) bad.push(`${TABS[t]}:缺资源项`);
  }
  need(bad.length === 0, `这些页面看不到资源：${bad.join('、')}`);
  return `${TABS.length} 个标签页都能看到 净资产（原来只有主界面有）`;
});

probe('UI · 日志有内存上限（长局不会无限增长）', () => {
  const s = createState();
  for (let i = 0; i < LOG_MAX + 500; i++) s.log.push('填充');
  tick(s, 1);
  need(s.log.length <= LOG_MAX, `日志涨到 ${s.log.length} 行，超过上限 ${LOG_MAX}`);
  need(s.log.length > 0, '裁切不该把日志清空（界面还要显示最后 12 条）');
  return `写入 ${LOG_MAX + 500} 行后，tick 把它裁到 ${s.log.length} 行`;
});

probe('UI · 成本明细不重复渲染', () => {
  /**
   * 原来「工资 / 房租 / 电费」在主界面顶部显示一遍、在「成本与加成明细」折叠里又显示一遍
   * —— 折叠的前提（「其余收进折叠」）是假的，等于白占一屏。
   */
  const s = createState();
  const html = htmlOf(s, 0);
  const dup = ['电费', '房租'].filter(k => (html.match(new RegExp(k, 'g')) || []).length > 1);
  need(dup.length === 0, `这些项被渲染了两遍：${dup.join('、')}（折叠的意义就是只留一处）`);
  return '工资 / 房租 / 电费各只渲染一处';
});

probe('折叠块 · 展开态由 JS 持有并烤进 open 属性，且每个 summary 都挂了 data-fold', () => {
  /**
   * 守的是「折叠块点不动」这个 bug（2026-09-26 用户报：成本与加成明细要点很多下才展开）。
   *
   * 真实成因（2026-09-26 在 Playwright 里逐事件实测）：`<details>` 的原生展开靠浏览器在
   * `click` 里做的激活行为，而 `click` 的目标 = mousedown 与 mouseup 的**最近公共祖先**。
   * `render()` 每 150ms 重建一次正文，按住超过一帧，按下时命中的那个 `summary` 在松手前
   * 就被换掉 ⇒ 已脱离文档 ⇒ **没有公共祖先 ⇒ 浏览器一个 click 都不派发**（实测：按住
   * 150ms 时 pointerdown/mousedown/pointerup/mouseup 四个事件全到，click 一个都没有）。
   * 所以折叠块必须和按钮一样挂 `data-fold`、走 pointerdown 委托，展开态存在 JS 里。
   *
   * ⚠️ 这条探针守的是**结构与 HTML** 这一半（DOM stub 没有事件语义）。别再写一个假 DOM
   *    来「模拟浏览器重建」—— 修复前那条探针就是这么干的（自己造 details 数组、自己让它
   *    变 false），它一路绿着，而玩家的折叠块已经点不动了。
   */
  need(ACTION_KEYS.includes('fold'),
    'ACTION_KEYS 里没有 fold —— [data-fold] 匹配不到，折叠块会完全点不动');

  // ① 结构：每个 <details> 的 summary 都必须挂 data-fold（漏一个 = 那个块点了没反应）
  const keys = [];
  for (const tab of [0, 1, 2]) {
    const html = htmlOf(createState(), tab);
    const dCount = (html.match(/<details\b/g) || []).length;
    const fCount = (html.match(/<summary data-fold="/g) || []).length;
    need(dCount === fCount,
      `标签页 ${tab}：${dCount} 个 <details> 只有 ${fCount} 个挂了 data-fold —— 没挂的那个点了不会有反应`);
    for (const m of html.matchAll(/data-fold="([^"]+)"/g)) keys.push(m[1]);
  }
  // 6 → 5（2026-09-26）：主界面的「创始人」折叠已并入「数值明细」。
  // 5 → 4（同日）：主界面的「记录」折叠已整块删除（A6）。
  need(keys.length === 4, `折叠块数量变了（现在 ${keys.length} 个）—— 本探针按「全部折叠块」写，请复核`);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  need(!dupes.length, `折叠键重复：${dupes.join('、')} —— 两个折叠块会一起开合`);

  // ② 展开态：由 `foldOpen()` 烤进 `open` 属性，所以重绘出来的 DOM 必然与状态一致
  const tagOf = (html, key) => {
    // `\s*`：源码里 summary 常常另起一行（`<details>\n  <summary …>`）
    // `[^>]*`：summary 上允许再挂别的属性（如 `融资进度` 那行为了把「创始人持股」贴右而加了 style）
    const m = html.match(new RegExp(`<details([^>]*)>\\s*<summary data-fold="${key}"[^>]*>`));
    need(m, `折叠块 ${key} 的结构不是「<details…><summary data-fold=…>」`);
    return m[1];
  };
  // ③ 展开态：需要一个「同一标签页里至少两个折叠块」的场景，才能验「开一个不会连开另一个」。
  //    ⚠️ 2026-09-26 主界面删掉「创始人 / 记录」两个折叠后只剩 1 个，所以这里改为
  //    **自动挑第一个含 ≥2 个折叠块的标签页**（现在落在业务页：融资进度 + 客户）。
  const tabWith2 = [0, 1, 2].find(t => (htmlOf(createState(), t).match(/data-fold="/g) || []).length >= 2);
  need(tabWith2 !== undefined, '没有任何标签页含 ≥2 个折叠块 —— 无法验证展开态不串位');
  const tabKeys = [...htmlOf(createState(), tabWith2).matchAll(/data-fold="([^"]+)"/g)].map(m => m[1]);
  const k0 = tabKeys[0], k1 = tabKeys[1];
  need(!/ open/.test(tagOf(htmlOf(createState(), tabWith2), k0)), '折叠块默认应当是合上的');
  toggleFold(k0);
  need(/ open/.test(tagOf(htmlOf(createState(), tabWith2), k0)),
    '切换之后渲染出来的 <details> 没有 open 属性 —— 展开态没烤进 HTML，重绘就会被合上');
  need(!/ open/.test(tagOf(htmlOf(createState(), tabWith2), k1)),
    '另一个折叠块被一起打开了 —— 展开态串位（按位置而不是按键存）');
  toggleFold(k0);
  need(!/ open/.test(tagOf(htmlOf(createState(), tabWith2), k0)), '再切一次应当合上');

  return `${keys.length} 个折叠块都挂了 data-fold（键唯一）；展开态由 JS 持有并烤进 open 属性`;
});

// 此处的「回忆 · 触发进日志且单独高亮 / 结局演出显示回忆计数」探针随回忆碎片机制一起删
// （第三批 2026-09-26）：碎片整块删除，已无代码产出「（回忆）」行，收集数也不在状态里。

probe('删除存档 · 两步确认，且删完不会被写盘路径写回来', () => {
  /**
   * 删档有两个真正的坑，这条探针两条都守：
   *   ① **必须有确认** —— 本作只有一个 localStorage key（当前这一局的全部进度），删掉不可恢复。
   *      所以第一次点只能「预备」，而且**要写明会失去什么**（只写「全部数据」玩家不知道代价）。
   *   ② **删完不能再被写回来** —— `location.reload()` 会触发 `beforeunload`，
   *      若那时还能存盘，档会在重载前一瞬间被原样写回，玩家看到「点了删除、刷新一下档又回来了」。
   */
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
  };

  const s = createState();
  need(save(s) === true, '存盘应当成功');
  need(store.has(SAVE_KEY), '存档应当写进 localStorage');

  // ① 界面上必须真有这个入口（2026-09-24 收进设置弹窗：页头 ⚙ → 弹窗内删档按钮）
  const btns = buttonsIn(htmlOf(s, 0));
  need(findAct(btns, 'settings') !== null, '页头上没有「设置」按钮');
  need(findAct(btns, 'deleteSave') === null, '删档按钮不该留在页头（高危操作应收进设置）');
  while (overlay.children.length) overlay.removeChild(overlay.children[0]);
  renderSettings(overlay, s);
  const setBtns = buttonsIn(overlay.children[0].innerHTML);
  need(findAct(setBtns, 'deleteSave') !== null, '设置弹窗里没有「删除全部数据」按钮');
  need(findAct(setBtns, 'toggleMute') !== null, '设置弹窗里没有音效开关');
  while (overlay.children.length) overlay.removeChild(overlay.children[0]);

  // ② 两步确认（设置弹窗内：未确认 = 「删除全部数据」→ armed = 「再点一次…将被删除」）
  need(!deleteSaveArmed(), '不该默认处于确认态（否则一进来点一下就没了）');
  armDeleteSave();
  need(deleteSaveArmed(), '第一次点击应当进入确认态');
  while (overlay.children.length) overlay.removeChild(overlay.children[0]);
  renderSettings(overlay, s);
  const armed = visible(overlay.children[0].innerHTML);
  need(/再点一次/.test(armed) && /将被删除/.test(armed), '确认态下按钮必须明说「再点一次…将被删除」');
  disarmDeleteSave();
  need(!deleteSaveArmed(), '离开后应当复位，否则 6 秒后回来随手一点就删了');

  // ③ 闸门：删完任何路径都写不回去
  disableSave();
  wipe();
  need(!store.has(SAVE_KEY), 'wipe() 之后存档应当没了');
  const wrote = save(s);              // 模拟 beforeunload / 10 秒自动存盘又调了一次
  need(wrote === false, '删档后 save() 不应再写入（应当被闸门挡住）');
  need(!store.has(SAVE_KEY), '删档后存档被写回来了 —— 玩家会看到「删了又回来」');

  enableSave();                       // 恢复，避免污染同一个进程里的后续用例
  return '按钮在界面上；确认态写明代价；wipe 后 save() 被闸门挡死，档不会被写回';
});

probe('点击接线 · 必须用 pointerdown（click 会被 DOM 重建打断）', () => {
  /**
   * ⚠️ 这条探针守的是**本项目最贵的一个 bug**，别再改回去。
   *
   * `render()` 每 150ms 用 `innerHTML` 全量重建 DOM，而 MDN 对 `click` 的定义是：
   *   「若在一个元素上按下、在另一个元素上松开，事件派发到**同时包含两者的最具体祖先**」
   * 桌面端一次按压要 100–300ms，于是松手时按钮早被换掉了 →
   * `click` 落到祖先上 → `ev.target.closest(ACTION_SELECTOR)` 返回 null → **点击被丢弃**。
   *
   * 下面把这条失效链**逐环节断言出来**，而不只是断言一个常量。
   */
  need(PRIMARY_EVENT === 'pointerdown',
    `主事件是 ${PRIMARY_EVENT} —— 必须是 pointerdown（click 会被 DOM 重建打断）`);

  // ① 按下时：命中按钮 —— 这是 pointerdown 能做到的
  const mk = (data, parentFn) => {
    const el = { dataset: data, disabled: false, closest: null };
    el.closest = sel => (Object.keys(data).some(k => sel.includes(`[data-${k}]`)) ? el : parentFn());
    return el;
  };
  const row = mk({}, () => null);                    // 共同祖先（.row）
  const btn = mk({ skill: 'zhong' }, () => row);     // 按钮（键随便取一个在 ACTION_KEYS 里的）

  need(findActionEl(btn) === btn, '按下时应该命中按钮本身');

  // ② 松手时：click 的目标会上浮到祖先 → 旧写法拿到 null（这就是当年的失效形态）
  need(findActionEl(row) === null,
    '祖先上没有动作键（所以 click 上浮后必然找不到按钮 —— 这就是「桌面端点着点着不灵」的成因）');

  // ③ 真接线：捕获阶段监听 pointerdown，并且按一下**恰好触发一次**
  let saved = null;
  const fakeApp = {
    addEventListener(t, h) { if (t === PRIMARY_EVENT) saved = h; },
    removeEventListener() {},
  };
  let fired = 0;
  bindActions({ app: fakeApp, overlay: null }, () => { fired += 1; });
  need(typeof saved === 'function', `没有在容器上监听 ${PRIMARY_EVENT}`);

  const ev = { target: btn, stopPropagation() {}, preventDefault() {} };
  saved(ev);
  need(fired === 1, `按下按钮应当恰好触发 1 次动作，实际 ${fired} 次`);

  // ④ 禁用的按钮不能触发（否则「已满级」也能点）
  btn.disabled = true;
  saved(ev);
  need(fired === 1, '禁用的按钮不该触发动作');
  btn.disabled = false;

  // ⑤ click 通道要同时满足两件事：有 Pointer Events 时**只服务键盘**，
  //    没有 Pointer Events 的环境**必须全收**（否则完全点不动）
  const clickHarness = pointerEvents => {
    let savedKb = null;
    const fake = {
      addEventListener(t, h) { if (t === KEYBOARD_EVENT) savedKb = h; },
      removeEventListener() {},
    };
    let n = 0;
    bindActions({ app: fake, overlay: null }, () => { n += 1; }, { pointerEvents });
    return {
      fire: detail => savedKb({ target: btn, detail, stopPropagation() {}, preventDefault() {} }),
      count: () => n,
    };
  };

  const hp = clickHarness(true);          // 现代浏览器
  hp.fire(1);
  need(hp.count() === 0, '有 Pointer Events 时，鼠标的 click（detail≥1）又跑了一遍 —— 一次点击会变成两次');
  hp.fire(0);
  need(hp.count() === 1, '键盘激活（detail=0）没生效 —— 键盘用户点不动');

  const hn = clickHarness(false);         // 不支持 Pointer Events 的老环境
  hn.fire(1);
  need(hn.count() === 1, '不支持 Pointer Events 的环境没有用 click 兜底 —— 会完全点不动');

  // ⑥ 结构性：派发路径只能有一条。
  //    `render.js` 里若又出现元素级 onclick，就会和 pointerdown 各跑一次（买一份变两份）。
  //    ⚠️ 必须先剥掉注释再判 —— 文件里有一段注释**讲的就是这件事**，
  //       直接扫源码会命中注释里的示例代码，把自己的说明当成 bug（踩过）。
  const renderSrc = readFileSync(new URL('../src/ui/render.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  need(!/\.onclick\s*=/.test(renderSrc),
    'render.js 里又出现了元素级 onclick —— 它和 pointerdown 会对同一次点击各派发一次，导致买两份');

  return 'pointerdown 捕获阶段接线；按下恰好 1 次；禁用不触发；click 只服务键盘/老环境；派发路径唯一';
});

probe('每幕叙事 · 8 幕齐备，且只走日志（主界面不再常驻）', () => {
  const missing = [];
  for (let a = 1; a <= 8; a++) {
    const n = ACT_NARRATION[a];
    if (!n || !n.open || !n.close) missing.push(`第${a}幕`);
  }
  need(!missing.length, `${missing.join('、')}缺叙事`);

  /**
   * ⚠️ 2026-09-26 第二批 A1：叙事从主界面的常驻 `<div class="nar">` 搬进了流水，
   *    所以旧口径（「主界面必须显示第 4 幕幕启句」）**必须反过来断言** ——
   *    否则这条探针会在改动后继续「通过」一个已经不存在的显示路径。
   * 现在守四件事：
   *   ① 新档第一行日志 = 第 1 幕幕启（第 1 幕不进 `advanceAct`，写在 `createState`）
   *   ② 推幕时新幕幕启进日志（只留句子本身），且**没有**「第 N 幕」前缀
   *   ③ 建成地标时幕落句进日志（A1 后它唯一的出口）
   *   ④ 主界面上不再常驻这两句
   */
  const s = createState();
  const open1 = ACT_NARRATION[1].open;
  need(s.log[0] === open1, `新档日志第一行不是第 1 幕幕启叙事（实为「${s.log[0]}」）`);

  s.act = 3;
  advanceAct(s);                                    // 3 → 4
  const open4 = ACT_NARRATION[4].open;
  // ⚠️ 只能按**前缀**断言：推幕那行末尾还拼了「（规模维护成本升至 X%）」（engine.advanceAct），
  //    用数组 includes 做整行全等会永远不成立（这条探针踩过）。
  need(s.log.some(l => l.startsWith(open4)), `推幕日志里没有第 4 幕幕启叙事（应有「${open4}」）`);
  need(!s.log.some(l => l.includes('第 4 幕')), '推幕日志里还有「第 N 幕」前缀（该表述已废）');

  s.resources.money = costOf(ACTS[4].landmark, 0).amount;
  need(purchase(s, ACTS[4].landmark, 1), '钱刚好够却买不下地标');
  const close4 = ACT_NARRATION[4].close;
  need(s.log.includes(close4), `建成地标后幕落句没有进日志（应有「${close4}」）`);

  /**
   * ④ 主界面上不再**常驻**这两句。判定必须把流水摘出去再查：
   *    叙事现在的正经出口就是 `.log`，连着日志一起查会把「搬进日志」误判成
   *    「还常驻着」（这条探针第一版就是这么错的 —— ② 刚修好 ④ 立刻误报）。
   */
  const page = htmlOf(s, 0);
  const beforeLog = visible(page.split('<div class="log">')[0]);
  need(!beforeLog.includes(ACT_NARRATION[4].open) && !beforeLog.includes(ACT_NARRATION[4].close),
    '主界面上又出现了常驻叙事 —— A1 要求它只出现在日志里');
  // 并且日志里**真的看得见**（防「搬走了但其实没画出来」）
  need(visible(page).includes(ACT_NARRATION[4].open), '日志里也没有第 4 幕幕启句 —— 叙事等于被删丢了');

  return `8 幕齐备；开局「${ACT_NARRATION[1].open}」→ 推幕「${ACT_NARRATION[4].open}」→ 建成地标「${ACT_NARRATION[4].close}」，全部只走日志`;
});

probe('幕次 · 市值没到门槛时绝不推幕（挂机不会自动过关）', () => {
  /**
   * 门槛换成了市值，但「不能白送」这条底线不变 ——
   * 空手挂机必须原地不动，否则 8 幕会在挂机里自己走完，一局游戏就没有内容了。
   */
  const s = createState();                   // 什么建筑都没有 → 市值远低于门槛
  for (let i = 0; i < 600; i++) tick(s, 1);   // 挂机 10 分钟
  need(s.act === 1, `空手挂机 600 秒就进了第 ${s.act} 幕 —— 门槛失效`);
  need(derived(s, rates(s)).marketCap < ACTS[1].mcap, '空手状态下市值竟然过了门槛');
  return `空手挂机 600 秒仍是第 1 幕（门槛 ${ACTS[1].mcap.toExponential(2)}）`;
});

probe('抉择 · 路线抉择弹窗可点且生效', () => {
  const s = createState();
  s.act = 2;
  advanceAct(s);                                 // 从 1 → 2 会走一次抉择流程
  while (overlay.children.length) overlay.removeChild(overlay.children[0]);
  renderChoice(overlay, s.act, () => {});
  const btns = buttonsIn(overlay.children[0].innerHTML);
  const b = needBtn(btns, 'choice', '路线抉择');
  const n0 = s.choices.length;
  clickBtn(s, b);
  need(s.choices.length === n0 + 1, '抉择没有被记录（s.choices 没变）');
  return `已选「${b.label}」，累积抉择 ${s.choices.length} 次`;
});

// ── 失败 / 压力（2026-09-25 第一批 §6：破产已删除）──
probe('压力 · 净收入为负 1 小时后游戏不结束，只减速 + 禁止购买', () => {
  /**
   * 增量游戏的类型定义属性之一是 **the absence of failure states**：
   * 挂机被惩罚成「重开一局」，等于把「离开」的代价设成删档 —— 与放置这个类型本身矛盾。
   * 替代物必须是**可恢复的**，所以这条探针同时守两件事：
   *   ① 不结束（不是失败结局）；② 打折 + 禁购真的生效（压力不是一句空话）。
   */
  const s = createState();
  s.resources.money = 0;
  s.buildings.biz1 = 5;                     // 必须有产出型建筑，否则 gross=0 → 净收入永远为正
  s.staff.salaryAdd = 5;                    // 工资系数远超 100% → 净收入为负

  let entered = 0;
  for (let i = 0; i < 3600 && !s.pressure; i++) { tick(s, 1); entered += 1; }
  need(s.pressure, `${entered} 秒净收入为负仍未进入压力状态`);
  need(entered >= PRESSURE.enterSec, `进入压力太快了（${entered} 秒 < ${PRESSURE.enterSec} 秒）`);
  need(!s.gameOver, `净收入为负竟然结束了游戏（gameOver = ${s.gameOver}）—— 失败状态必须不存在`);

  // ① 产出打折：同一份状态，只有 pressure 不同
  // ⚠️ 必须断言 `moneyRate`（真正入账的产出）而不是 `gross`（成本基数）——
  //    折价曾经误打在 `gross` 上，于是产出没降、成本变便宜，净亏损反而缩小（极性反转）。
  const sOn = createState(); sOn.buildings.biz1 = 5; sOn.staff.salaryAdd = 5; sOn.pressure = true;
  const sOff = createState(); sOff.buildings.biz1 = 5; sOff.staff.salaryAdd = 5; sOff.pressure = false;
  const ROn = rates(sOn), ROff = rates(sOff);
  const ratio = ROn.moneyRate / ROff.moneyRate;
  need(Math.abs(ratio - PRESSURE.discount) < 1e-9, `压力下产出应是 ${PRESSURE.discount}×，实为 ${ratio}`);
  // 极性：压力必须让净收入**更差**。若折价打在成本基数上，这里会变成「净亏损缩小」。
  need(ROn.netMoney < ROff.netMoney,
    `压力下净收入反而变好了（${ROff.netMoney.toExponential(3)} → ${ROn.netMoney.toExponential(3)}）—— 折价打错了地方（成本减免不是减速）`);

  // ② 禁止购买
  s.resources.money = 1e9;
  need(purchase(s, 'biz2', 1) === false, '压力状态下仍然能买东西 —— 「禁止购买」没生效');

  // ③ 可恢复：净收入回正并持续 exitSec 之后解除
  s.staff.salaryAdd = 0;
  for (let i = 0; i < PRESSURE.exitSec + 5; i++) tick(s, 1);
  need(!s.pressure, '净收入回正并持续够了，压力却没解除 —— 玩家会被永久锁死');
  need(s.crises === 1, `危机计数应为 1，实为 ${s.crises}`);
  return `亏损 ${entered} 秒 → 压力（moneyRate ${ROff.moneyRate.toExponential(3)}→${ROn.moneyRate.toExponential(3)}、`
    + `upkeep ${ROff.upkeep.toExponential(3)}→${ROn.upkeep.toExponential(3)}、`
    + `netMoney ${ROff.netMoney.toExponential(3)}→${ROn.netMoney.toExponential(3)}即「更差」；禁购、不结束）`
    + `→ 回正 ${PRESSURE.exitSec} 秒后解除`;
});

probe('压力 · 自动经理会卖掉设施止损', () => {
  /**
   * 「砍掉亏损项」必须真的有人做：压力下玩家自己**买不了**东西（上一条探针），
   * 而净收入为负的一大主因就是设施电费（`power = gross × 座数 × 0.002`）。
   * 设施只给被加法桶稀释的乘数、却按座数收电费 —— 它正是「扩张太快就断粮」的那一项。
   */
  const s = createState();
  s.buildings.biz1 = 5;
  for (const b of BUILDINGS) if (b.kind === 'mul') s.buildings[b.id] = 4;
  s.resources.money = 0;
  s.staff.salaryAdd = 5;
  const before = Object.values(s.buildings).reduce((a, b) => a + b, 0);

  for (let i = 0; i < PRESSURE.enterSec + 60; i++) tick(s, 1);
  const after = Object.values(s.buildings).reduce((a, b) => a + b, 0);
  need(after < before, `自动经理没有卖掉任何设施止血（建筑总数 ${before} → ${after}）`);
  need(/自动经理/.test(s.log.join('\n')), '自动经理卖设施没有写日志 —— 玩家会以为建筑凭空消失');
  return `自动经理卖掉 ${before - after} 座设施止血，并写明了原因`;
});

probe('压力 · 自动经理止损：卖设施后压力态净收入回升、压力最终解除', () => {
  /**
   * 这条钉的是**自动经理这条出口真的管用**（2026-09-25 修复轮 1 提出、修复轮 2 改写）：
   * 折价改到产出侧之后压力下净收入**更差**，而禁购又堵死了玩家自己调结构的路，
   * 于是「玩家能不能出来」靠自动经理按 `SEVER_INTERVAL` 卖设施（压力还有 `maxSec` 兜底）。
   * 断言「压力态净收入回升」而不是「压力由谁解除」—— 因为 `maxSec` 也会在窗口到点时解除，
   * 只有净收入回升才真正证明**止损起了作用**。
   *
   * 构造：只堆设施（电费 = 毛收入 × 座数 × 0.002 是**唯一按座数**收的支出）→ 净收入为负；
   * 卖掉设施就能把它抬回正。座数由循环**动态**找到（不是硬编码阈值），抗系数漂移。
   */
  const s = createState();
  s.act = 1;
  s.buildings.biz1 = 5;
  // ⚠️ 用**非压力**态找座数：进入压力的条件是「非压力态净收入为负」，
  //    若拿压力态去找，会找到「压力下为负、非压力下却为正」的座数 → 永远进不了压力。
  // 步长取 1：把「刚好越过盈亏线」的座数找出来，超建量最小 ⇒ 自动经理只需卖几座就能回正。
  // 若超建太多，`maxSec` 硬上限会先兜底，这条探针就测不到「自动经理自己把压力解除」了。
  let per = 0;
  while (rates(s).netMoney >= 0 && per < 500) {
    per += 1;
    for (const b of BUILDINGS) if (b.kind === 'mul') s.buildings[b.id] = per;
  }
  need(per < 500, '堆满设施也无法把净收入压成负数 —— 这条探针的前提失效了');
  const n0 = Object.values(s.buildings).reduce((a, b) => a + b, 0);

  // 进入压力
  let entered = 0;
  for (let i = 0; i < 600 && !s.pressure; i++) { tick(s, 1); entered += 1; }
  need(s.pressure, `${entered} 秒仍未进入压力`);
  const netAtEntry = rates(s).netMoney;

  // 自动经理出手 → 压力态净收入被抬向 0 → 压力最终解除
  let t = 0, lastNet = netAtEntry;
  for (; t < 200000 && s.pressure; t++) {
    tick(s, 1);
    if (s.pressure) lastNet = rates(s).netMoney;   // 只取「压力态」的净收入，避免与解除后的值混为一谈
  }
  const after = Object.values(s.buildings).reduce((a, b) => a + b, 0);
  need(after < n0, `自动经理没有卖掉任何设施（${n0} → ${after}）`);
  need(/自动经理/.test(s.log.join('\n')), '自动经理卖设施没有写日志');
  need(lastNet > netAtEntry,
    `自动经理卖了 ${n0 - after} 座设施，但压力态净收入没有回升（${netAtEntry.toExponential(3)} → ${lastNet.toExponential(3)}）—— 止损没起作用`);
  need(!s.pressure, `跑了 ${t} 秒后压力仍未解除 —— 压力没有出口`);
  return `堆 ${n0} 座设施进入压力（压力态净收入 ${netAtEntry.toExponential(3)}）→ `
    + `自动经理卖掉 ${n0 - after} 座 → 净收入回升到 ${lastNet.toExponential(3)}、${t} 秒后压力解除`;
});

probe('压力 · 有界：自动经理无手可出时，压力仍会被强制解除（不会永久锁死）', () => {
  /**
   * 为什么单独钉这条：问题不在「压力太重」，而在「压力**没有出口**」。
   * 压力下产出打 75 折，只要正常利润率低于 25%（实测晚期 ≈22%），压力态净收入就必然为负
   * ⇒ `healthyTimer` 永远攒不满 `exitSec`；若此时自动经理也卖光了设施（无可售），
   * 压力就必须靠 `maxSec` 硬上限强制解除 —— 否则它是换了名字的失败状态
   * （玩法被永久锁在 −25% 产出，禁购连地标都买不了 ⇒ 推不了幕 ⇒ 死局）。
   *
   * ⚠️ 这条断言必须有牙：删掉 `PRESSURE.maxSec`（或改成永不出口）时它必须变红。
   */
  const s = createState();
  s.buildings.biz1 = 5;
  s.staff.salaryAdd = 5;   // 巨亏且与设施无关 → 自动经理卖设施也救不回来
  need(rates(s).facilityCount === 0, '这个状态必须没有可售设施，否则自动经理会自己解决，测不出上限'); 

  let entered = 0;
  for (let i = 0; i < PRESSURE.enterSec + 30 && !s.pressure; i++) { tick(s, 1); entered += 1; }
  need(s.pressure, `${entered} 秒仍未进入压力`);
  need(rates(s).netMoney < 0, '压力态净收入必须仍为负，否则会靠 exitSec 正常退出，测不到硬上限');

  let t = 0;
  for (; t < PRESSURE.maxSec + 120 && s.pressure; t++) tick(s, 1);
  need(!s.pressure,
    `持续亏损且自动经理无手可出，驱动 ${t} 秒后 pressure 仍为 true —— `
    + `压力没有出口（maxSec=${PRESSURE.maxSec}），这就是换了名字的失败状态`);
  need(!s.gameOver, `强制缓解期间游戏结束了（gameOver = ${s.gameOver}）—— 压力不该是失败状态`);
  return `无可售设施 + 持续亏损：进入压力后 ${t} 秒被 maxSec=${PRESSURE.maxSec} 强制解除，游戏未结束`;
});

// ── 合同 ──
probe('合同 · 竞标按钮可点', () => {
  const s = lateState();
  s.autoContract = false;      // 自动接单默认开了：只有关掉它，报价才会在界面上等着被点
  s.contracts.offerTimer = 0;
  tick(s, 1);
  for (let i = 0; i < 40 && !s.contracts.offers.length; i++) tick(s, 60);
  need(s.contracts.offers.length, '等了很久都没有报价出现');
  const btns = look(s, 2);
  const b = btns.find(x => x.data.bid && !x.disabled);
  need(b, '有报价但界面上没有可点的竞标按钮');
  const done0 = s.contracts.done, lost0 = s.contracts.bidLost;
  const [oid, qid] = b.data.bid.split(':');
  const act0 = s.contracts.active.length;
  const r = acceptOffer(s, oid, qid, rates(s));
  // ⚠️ 中标不是「立刻结算」：中了会生成一份**进行中的合同**（等交付倒计时），
  //    只有流标才记进 bidLost。原来断言 done/bidLost 变化，所以中标那次被判成失败（探针写错了）。
  const moved = s.contracts.active.length > act0
    || s.contracts.done > done0 || s.contracts.bidLost > lost0;
  if (!moved) {
    bad(`点了竞标按钮但什么也没发生：acceptOffer 返回 ${JSON.stringify(r)}，`
      + `offer 还在吗=${s.contracts.offers.some(o => o.id === oid)}，cooldown=${s.contracts.cooldown}`);
  }
  return `${r.win ? '中标' : '流标'}（胜率 ${(r.odds * 100).toFixed(0)}%）→ 进行中 ${act0} → ${s.contracts.active.length} 单`;
});

probe('合同 · 接单后能靠时间推进交付', () => {
  const s = lateState();
  s.contracts.offerTimer = 0;
  for (let i = 0; i < 60 && !s.contracts.active.length; i++) {
    tick(s, 60);
    const sug = suggestContract(s, rates(s));
    if (sug) acceptOffer(s, sug.offerId, sug.quote, rates(s));
  }
  need(s.contracts.active.length, '始终接不到任何合同');
  const done0 = s.contracts.done;
  for (let i = 0; i < 4000 && s.contracts.done === done0; i++) tick(s, 60);
  need(s.contracts.done > done0, '接了单但永远交付不了');
  return `交付 ${done0} → ${s.contracts.done} 单，合同收入占比 ${(s.contracts.earned / Math.max(1, s.contracts.earned + s.contracts.viaProduction) * 100).toFixed(1)}%`;
});

// ── 员工养成（2026-09-24 起 UI 删除、autoStaffTick 后台自动）——探针改为验证自动化 ──
probe('员工 · 自动化管理（加薪保忠诚）', () => {
  /**
   * 员工四按钮 UI 已删（假决策：最优解固定）。忠诚仍影响产出系数（staff.js loyaltyFactor），
   * 自动化必须真的兜住：扩张冲击把忠诚打下去之后，autoStaffTick 要在几秒内拉回来。
   */
  const s = lateState();
  s.autoStaff = true;
  s.resources.money = 1e15;
  s.staff.dev.loyalty = 50;                       // 低于 75 的保底线
  const R = rates(s);
  autoStaffTick(s, R);
  need(s.staff.dev.loyalty > 50, '自动化没有给忠诚低的组加薪');
  return `忠诚 50 → ${s.staff.dev.loyalty.toFixed(0)}（后台自动）`;
});

probe('员工 · 自动化管理（晋升与配股）', () => {
  const s = lateState();
  s.autoStaff = true;
  s.resources.money = 1e15;
  s.staff.dev.level = 10;
  s.staff.dev.loyalty = 60;
  const R = rates(s);
  autoStaffTick(s, R);
  need(s.staff.dev.promoted, '等级 10 但自动化没有晋升（管理层加成丢失）');
  need(s.staff.dev.immune || s.staff.dev.loyalty > 60, '晋升后没有配股锁忠诚（会吃扩张冲击）');
  return `程序员自动晋升 + 配股锁忠诚，产出系数 ×${loyaltyFactor(s, 'dev').toFixed(2)}`;
});

probe('员工 · UI 已删除（主界面无员工按钮）', () => {
  const s = lateState();
  const btns = look(s, 0);
  need(!btns.some(x => x.data.staff), '员工管理 UI 还在（应为后台自动化）');
  return '「人」tab 已并入主界面，员工转后台';
});

// ── 事件 ──
probe('事件 · 抉择弹窗可点且写进日志', () => {
  const s = lateState();
  s.act = 3;
  let ev = null;
  for (let i = 0; i < 400 && !ev; i++) { tick(s, 60); ev = pendingEvent(s); }
  need(ev, '等了很久都没有出现抉择事件');
  while (overlay.children.length) overlay.removeChild(overlay.children[0]);
  renderEvent(overlay, ev, () => {}, () => true);
  const btns = buttonsIn(overlay.children[0].innerHTML);
  const b = needBtn(btns, 'opt', '事件选项');
  const log0 = s.log.length;
  clickBtn(s, b);
  need(!pendingEvent(s), '点了选项但事件还在挂起（会永久卡住后续事件）');
  need(s.log.length > log0, '事件结果没有写进日志');
  return `「${ev.title}」已结算，日志 +${s.log.length - log0} 条`;
});

// ── 技能 ──
probe('技能 · 主动技能可释放', () => {
  const s = lateState();
  const btns = look(s, 0);
  const b = btns.find(x => x.data.skill && !x.disabled);
  need(b, '界面上没有可点的技能按钮');
  const st0 = JSON.stringify(s.skills || {});
  clickBtn(s, b);
  // ⚠️ 2026-09-26 第三批：健康 / 心气已删，技能的唯一可观测代价是冷却 —— 只判断技能状态变化。
  need(JSON.stringify(s.skills || {}) !== st0, '用了技能但没有任何变化（冷却没走）');
  return `释放「${b.label}」，技能冷却进入计时`;
});

// ── 融资 ──
probe('融资 · 到幕次会自动走完 7 轮并稀释股权', () => {
  const s = createState();
  const e0 = s.equity;
  // ⚠️ 融资按**幕内时间点**触发（不再「进幕即触发」），判据是真实秒 `s.elapsed` ——
  //    与日历（进度钟）已经是两条独立的轴，所以这里仍然要把 elapsed 拨到那一幕的触发点之后。
  for (let a = 1; a <= 8; a++) {
    s.act = a;
    s.elapsed = ACTS.slice(1, a + 1).reduce((x, y) => x + y.seconds, 0) - 1;
    for (let i = 0; i < 5; i++) tick(s, 1);
  }
  const n = s.finance.rounds.length;
  need(n === ROUNDS.length, `只走了 ${n}/${ROUNDS.length} 轮融资（全部到幕后应当走满）`);
  need(s.equity < e0, `走完 ${n} 轮融资但股权没有稀释`);
  return `${n}/${ROUNDS.length} 轮走完，持股 ${(e0 * 100).toFixed(1)}% → ${(s.equity * 100).toFixed(1)}%`;
});

probe('UI · 世界榜真的把「新」画出来（不是只算了没显示）', () => {
  // 复现「空降前 10」的那一个月，然后走真实渲染 —— 断言改的是界面，不只是 core 的返回值
  const s = createState();
  s.world = createWorld('B');
  let hit = null;
  for (let m = 0; m < 480 && !hit; m++) {
    const before = s.world.companies.length;
    advanceWorld(s.world, 1);
    if (s.world.companies.length > before) {
      const fresh = ranking(s.world, null, 1e9).all.filter(c => c.isNew && c.rank <= 10);
      if (fresh.length) hit = fresh[0];
    }
  }
  need(hit, '复现不出「空降前 10」的月份，无法验证渲染');

  const html = htmlOf(s, 3);                    // 3 = 「世界」tab
  const txt = visible(html);
  need(/class="drk new">新/.test(html), `HTML 里没有「新」标记（${hit.n} 应显示为「新」）`);
  need(/新/.test(txt), '玩家看到的文字里没有「新」');
  need(/▲|▼|─/.test(txt), '世界榜没有环比符号（▲▼─）');
  need(/↑|↓|─/.test(txt), '世界榜没有名次符号（↑↓─）');
  return `${hit.n} 空降第 ${hit.rank} 名 → 榜上显示「新」`;
});

// ── 时间 / 日期（2026-09-26 第二批 §2.6：进度钟）──
/**
 * 日历口径 = **幕次 + 幕内市值进度**：
 *   `p = clamp(市值 / 本幕门槛, 0, 1)`，月数在本幕 `ACTS[].years` 的区间里线性插值。
 * ⇒ 玩家玩得快、时间就走得快；卡在某一幕时**世界与玩家一起冻结**；
 *   第 8 幕打满（`p = 1`）**恰好**是 2061-08 —— 要求里那句「玩到最后时间刚刚好是结局」。
 */
probe('时间 · 日历由幕内市值进度派生（第 8 幕打满 = 2061-08 = 结局）', () => {
  // ① 幕月区间由 ACTS[].years 派生：八幕首尾相接，末值 = 420
  for (let a = 1; a <= 8; a++) {
    need(ACT_MONTHS[a], `第 ${a} 幕没有月区间（ACTS[].years 解析失败）`);
    if (a > 1) {
      need(ACT_MONTHS[a][0] === ACT_MONTHS[a - 1][1],
        `第 ${a} 幕起点 ${ACT_MONTHS[a][0]} 与上一幕终点 ${ACT_MONTHS[a - 1][1]} 不相接`);
    }
  }
  need(ACT_MONTHS[1][0] === 0, `第 1 幕起点应是 0 月（2026-08），实为 ${ACT_MONTHS[1][0]}`);
  need(ACT_MONTHS[8][1] === MONTHS_TOTAL, `第 8 幕终点应是 ${MONTHS_TOTAL} 月（= 2061-08）`);

  // ② 端点锚点 —— 就是用户那句要求
  const at = (act, p) => calMonthOf({ act }, { marketCap: p * ACTS[act].mcap });
  need(gameDate({ calMonth: at(1, 0) }) === '2026年8月',
    `第 1 幕起点应是 2026年8月，实为 ${gameDate({ calMonth: at(1, 0) })}`);
  need(at(8, 1) === MONTHS_TOTAL, `第 8 幕打满应是 ${MONTHS_TOTAL} 月，实为 ${at(8, 1)}`);
  need(gameDate({ calMonth: at(8, 1) }) === '2061年8月',
    `第 8 幕打满应是 2061年8月（结局），实为 ${gameDate({ calMonth: at(8, 1) })}`);
  need(gameYear({ calMonth: at(8, 1) }) === TOTAL_YEARS, `第 8 幕打满应是第 ${TOTAL_YEARS} 个游戏年`);

  // ③ 幕内线性插值 + 夹取
  need(at(4, 0.5) === 144, `第 4 幕半程应是 144 月（2038-08），实为 ${at(4, 0.5)}`);
  need(at(4, -1) === ACT_MONTHS[4][0] && at(4, 99) === ACT_MONTHS[4][1],
    '市值进度应被夹取到 [0, 1]（负值与超门槛都不许越界）');

  // ④ `gameMonths` 读的是派生缓存 `s.calMonth` —— 不再看 `s.elapsed`
  need(gameMonths({ calMonth: 6, elapsed: SEC_PER_YEAR * 30 }) === 6,
    'gameMonths 必须读 s.calMonth —— s.elapsed 已经不再驱动日历');
  need(gameMonths({ calMonth: MONTHS_TOTAL + 500 }) === MONTHS_TOTAL, '月数应封顶在 420');
  need(gameMonths({}) === 0, '没有缓存字段时应按 0 处理（新档第一帧 = 2026年8月）');
  return `1 幕 2026-08 → 8 幕打满 2061-08（${MONTHS_TOTAL} 月）；幕内按市值进度线性插值`;
});

// ── 世界市值榜：环比 / 名次变化（2026-09-25 用户要求）──
probe('世界榜 · 未上市时只给 TOP10，玩家那一行不出现', () => {
  /**
   * 第一批 §7 定下榜单只给 TOP10（不做「完整 100 名」的流水账）；
   * 2026-09-26 用户再加一条：**玩家只在上市（IPO 轮到账）后才进榜**。
   */
  const s = createState();
  s.world = createWorld('B', s.rngSeed || 20260924);
  advanceWorld(s.world, 36);
  // 让 gameMonths(s)（= floor(s.calMonth)）与 s.world.month 对齐（36 月）—— 否则 worldTick
  // 会把世界当「旧档」重建回进度所在月。calMonth 是派生缓存，这里直接摆好即可。
  s.calMonth = 36;
  s.act = 1;                                  // 第 1 幕 ⇒ 未上市（IPO 是第 7 轮，第 5 幕 70% 处）
  worldTick(s, rates(s));

  const worldHtml = htmlOf(s, 3);
  const rowCount = (worldHtml.match(/class="row/g) || []).length;
  need(rowCount === 10, `榜单行了 ${rowCount} 行 —— 未上市时应恰是 TOP10 的 10 行`);
  need(!/class="row me"/.test(worldHtml), '未上市时榜上不该出现自己那一行');
  need(/↑|↓|─|新/.test(visible(worldHtml)), '榜单没有名次变化符号（↑↓─ 或「新」）');
  return `未上市：榜单 ${rowCount} 行（恰为 TOP10，无自己那一行）`;
});

probe('世界榜 · 已上市且名次在 10 名以外时，自己那一行钉在榜底', () => {
  const s = createState();
  s.world = createWorld('B', s.rngSeed || 20260924);
  advanceWorld(s.world, 36);
  s.calMonth = 36;                           // 与世界月份对齐，见上一条
  s.act = 1;                                  // 市值很小 ⇒ 名次远在 10 名以外
  s.finance.rounds = ['ipo'];                 // 已上市
  worldTick(s, rates(s));
  need(s.worldRank > 10, `样本失效：第 1 幕的市值应让名次落在 10 名以外（实为 ${s.worldRank}）`);

  const html = htmlOf(s, 3);
  const rowCount = (html.match(/class="row/g) || []).length;
  need(rowCount === 11, `已上市时应是 TOP10 + 自己 = 11 行（实为 ${rowCount}）`);
  need((html.match(/class="row me"/g) || []).length === 1, '自己那一行应恰好出现一次');
  need(/第 \d+ 名/.test(html), '自己那一行没有报出名次');
  need(/class="row me"/.test(html.slice(html.lastIndexOf('class="row'))),
    '自己那一行没有钉在榜单最后一行');
  return `已上市 + 名次 ${s.worldRank}：榜单 ${rowCount} 行，自己那一行在最后`;
});

probe('世界榜 · 新入场公司标「新」而不是「─ 持平」', () => {
  // IPO_POOL 里的公司按年份空降，其中确有直接落到前 10 的（如 Anthropic y:2027）
  const w = createWorld('B');
  let found = null;
  for (let m = 1; m <= 480 && !found; m++) {
    const before = w.companies.length;
    advanceWorld(w, 1);
    if (w.companies.length === before) continue;
    const born = w.companies.slice(before);
    const { all } = ranking(w, null, 1e9);
    for (const c of born) {
      need(c.born === w.month, `${c.n} 入场时没有记 born（无法判定「新」）`);
      const r = all.find(x => x.n === c.n);
      need(r.isNew === true, `${c.n} 入场当月 isNew 应为 true`);
      need(r.rankDelta === null, `${c.n} 入场当月 rankDelta 应为 null（它上个月不在榜上），实为 ${r.rankDelta}`);
      if (r.rank <= 10 && !found) found = { n: c.n, rank: r.rank };
    }
  }
  need(found, '连续演化 480 个月都没有「空降前 10」的新公司 —— 断言样本失效');

  // 次月：不再标「新」，回到真实名次差
  advanceWorld(w, 1);
  const r2 = ranking(w, null, 1e9).all.find(x => x.n === found.n);
  need(r2.isNew === false, `${found.n} 入场次月仍被标成「新」`);
  need(typeof r2.rankDelta === 'number', `${found.n} 入场次月应回到真实名次差，实为 ${r2.rankDelta}`);
  return `${found.n} 空降第 ${found.rank} 名 → 当月显示「新」，次月转为 ↑/↓/─`;
});

probe('世界榜 · 名次变化按全榜算（榜外杀入 = 真实名次差）', () => {
  /**
   * 找一个**样本合格**的月份：① 无新公司入场（上月榜与本月榜同一批人，零和断言才严密）
   * ② 至少一家从 10 名以外杀进前 10（用户要的正是这种要如实显示 ↑N 的情况）。
   * 不能只挑「第 130 月」—— 前 10 之间的差距常常大到一个月内换不了位。
   */
  const w = createWorld('B');
  let M = 0;
  for (let m = 0; m < 480 && !M; m++) {
    const before = w.companies.length;
    advanceWorld(w, 1);
    if (w.companies.length !== before) continue;
    const { all } = ranking(w, null, 1e9);
    if (all.some(c => c.rank <= 10 && c.rankPrev > 10)) M = w.month;
  }
  need(M > 0, '连续 480 个月都没有「无新公司入场 且 有公司从榜外杀进前 10」的月份 —— 挑不到可验证的样本');

  const { all } = ranking(w, null, 1e9);
  const nonNew = all.filter(c => !c.isNew);
  need(nonNew.length === all.length, `第 ${M} 月本应无新公司入场，却有 ${all.length - nonNew.length} 家`);

  // ① rankPrev 必须等于**把世界退到上个月重排**出来的名次（独立复算，不是拿自己的公式自证）
  const wPrev = createWorld('B');
  advanceWorld(wPrev, M - 1);
  const prevRank = new Map(ranking(wPrev, null, 1e9).all.map(c => [c.n, c.rank]));
  for (const c of nonNew) {
    const r = prevRank.get(c.n);
    need(r != null, `${c.n} 在「上个月的世界」里找不到（出生月判定有问题）`);
    need(c.rankPrev === r, `${c.n} 上月名次 ${c.rankPrev} ≠ 复算的 ${r}`);
    need(c.rankDelta === c.rankPrev - c.rank, `${c.n} 名次差口径不对`);
  }

  // ② 用户要的场景：上月在 10 名以外、本月杀进前 10 → 必须如实显示 ↑N（不是「新」也不是「─」）
  const outside = all.filter(c => c.rank <= 10 && c.rankPrev > 10);
  need(outside.length > 0, `第 ${M} 月样本里没有「榜外杀入前 10」的公司`);
  const one = outside.sort((a, b) => b.rankPrev - a.rankPrev)[0];
  need(one.isNew === false, `${one.n} 从榜外杀入，但它被误判成「新」`);
  need(one.rankDelta === one.rankPrev - one.rank && one.rankDelta > 0,
    `${one.n} 从第 ${one.rankPrev} 名杀到第 ${one.rank} 名，应显示 ↑${one.rankPrev - one.rank}`);

  // ③ 名次是零和的：无新公司时，升的总名次必须等于降的总名次
  const sum = nonNew.reduce((a, c) => a + c.rankDelta, 0);
  need(sum === 0, `全榜 Σ名次差 应为 0（有升必有降），实为 ${sum}`);
  return `${one.n}：第 ${one.rankPrev} 名 → 第 ${one.rank} 名（↑${one.rankDelta}）｜ 第 ${M} 月全榜 Σ名次差 = 0`;
});

probe('世界榜 · 世界跑在前面时会被拉回日历所在月（不永久甩开）', () => {
  // 复现用户截图那份档：存档里的世界已经跑到 2031 年（month 60），而玩家的市值进度只到第 1 幕前段
  const s = createState();
  const seed = s.rngSeed || 20260924;
  s.world = createWorld('B', seed);
  advanceWorld(s.world, 60);
  const before = s.world.month;
  s.buildings.biz1 = 5;              // 有一点真实市值进度（否则 p = 0，日历停在起点，验不到回拉）
  tick(s, 1);
  const target = gameMonths(s);
  need(target < before, `样本失效：日历 ${target} 月应远早于世界的 ${before} 月`);

  need(s.world.month === target, `世界没被拉回（${before} → ${s.world.month}，应为 ${target}）`);
  // 回拉必须是**精确重建**：与「一份新档自然走到 target 月」逐家一致（世界是纯函数）
  const ref = createWorld('B', seed);
  advanceWorld(ref, target);
  const key = w => w.companies.map(c => `${c.n}:${c.cur.toFixed(6)}`).join('|');
  need(key(s.world) === key(ref), '回拉后的世界与「新档走到同一月」不一致 —— 世界不是纯函数？');
  return `旧档世界 ${before} 月 → ${s.world.month} 月，且与同期新档逐家一致`;
});

probe('时间 · 4× 只加速产出；日历只认市值进度（因此不白送难度折扣）', () => {
  /**
   * 语义（第二批 §2.6）：日历由**幕内市值进度**派生，而市值只由「建筑/人员/技能」决定。
   * 这里把「自动养成」关掉，把人员状态钉死成同一份 —— 于是两条路径的市值完全相同，
   * 日历就必然一字不差。倍数真正的作用是「更快买得起下一座建筑/下一次培训」，
   * 于是它变成**纯快进**：既加速产出，也（经由更多产能）加速日历，不再是一个白送难度的开关。
   */
  const T0 = 1_700_000_000_000;
  const a = createState(); a.speed = 1;
  const b = createState(); b.speed = 4;
  /**
   * ⚠️ 2026-09-26 第四批：本探针原来数 `resources.code`，而**日常事件不改代码**，所以天然干净；
   *    换成 `resources.money` 后，日常事件（如「陈阿姨来涨租了」资金 −N）会污染分子。
   *    又因为 b 跑 4× 游戏秒、会撞上 a 撞不到的日常事件，比值就不再是干净的 4.000。
   *    这里把事件计时器推到无穷远 + 关掉自动扩张，使「唯一变量 = 倍速」这条前提真正成立。
   */
  for (const s of [a, b]) {
    s.autoStaff = false; s.autoBuy = false;
    s.events.dailyTimer = 1e9; s.events.milestoneTimer = 1e9; s.events.choiceTimer = 1e9;
    s.buildings.biz1 = 5;                                                   // 同建筑、同人员
  }
  for (let i = 0; i < 60; i++) {
    tick(a, 1, T0 + i * 1000);
    tick(b, 1, T0 + i * 1000);
  }
  const ratio = b.resources.money / a.resources.money;
  need(Math.abs(ratio - 4) < 0.01, `4× 档产出只快了 ${ratio.toFixed(2)} 倍`);
  need(b.elapsed === a.elapsed, `4× 不该改变本局真实时长（${a.elapsed} vs ${b.elapsed}）`);
  need(gameMonths(a) > 0, '样本失效：日历根本没动，下面的断言什么也没验到');
  need(derived(a).marketCap === derived(b).marketCap, '同建筑同人员下市值应当完全相等');
  need(gameMonths(b) === gameMonths(a), '同市值下 4× 不该改变日历（日历只认市值，不认真实时间）');
  need(b.world.month === a.world.month, `4× 不该改变世界榜月份（${a.world.month} vs ${b.world.month}）`);
  return `同一段真实时间：产出 ${ratio.toFixed(2)}×，同市值下日历与世界榜完全一致（month ${a.world.month}）`;
});

probe('时间 · 挂机不涨进度 ⇒ 日期与世界榜一起冻结（零操作、零建筑）', () => {
  const T0 = 1_700_000_000_000;
  /**
   * 用户要求的那条语义的直接断言：**玩家玩得慢，时间就走得慢**。
   * 零操作、零建筑 ⇒ 市值恒为 0 ⇒ `p` 恒为 0 ⇒ 日历停在起点，世界榜一格都不走
   * （旧的墙钟口径下这里会走满 120 个月，正是「挂机被世界甩开」的根因）。
   */
  const s = createState();
  s.lastSeen = T0;
  need(gameMonths(s) === 0, `新档应从 month 0 开始，实为 ${gameMonths(s)}`);
  for (let i = 0; i < 120; i++) tick(s, 1, T0 + (i + 1) * 1000);
  need(s.elapsed === 120, `s.elapsed 仍应累加真实秒（离线结算靠它），实为 ${s.elapsed}`);
  need(s.lastSeen === T0 + 120 * 1000, `s.lastSeen 没跟上注入的 now（${s.lastSeen}）`);
  need(gameMonths(s) === 0, `零建筑时市值恒为 0，日历不该走（${gameDate(s)}）`);
  need(s.world && s.world.month === 0, `零进度时世界榜不该往前走（${s.world && s.world.month}）`);
  need(!Object.keys(s.buildings).length, '探针本身不该买任何东西（否则断言不再是「零操作」）');

  // 买入建筑 → 市值上升 → 进度上升 → 日历与世界榜同步前进
  s.buildings.biz1 = 5;
  const cap = derived(s).marketCap;
  need(cap > 0, '买了建筑市值还是 0');
  tick(s, 1, T0 + 121 * 1000);
  const m = gameMonths(s);
  need(m > 0, `市值升到 ${cap} 之后日历应前进（实为 ${gameDate(s)}）`);
  need(s.world.month === m, `世界榜月份 ${s.world.month} 没跟上日历 ${m}`);
  need(m === Math.floor(calMonthOf(s, derived(s))), '日历应恰好等于幕内进度对应的月数');
  return `零操作 120 秒：日历/世界榜全程停在 2026年8月；买入 5 座商务助理后 → ${gameDate(s)}（month ${m}）`;
});

// ── 音效开关（2026-09-24 收进设置弹窗）──
probe('音效 · 开关按钮可点', () => {
  const s = createState();
  const btns = look(s, 0);
  need(findAct(btns, 'settings'), '页头没有 ⚙ 设置入口');
  while (overlay.children.length) overlay.removeChild(overlay.children[0]);
  renderSettings(overlay, s);
  const b = findAct(buttonsIn(overlay.children[0].innerHTML), 'toggleMute');
  need(b, '设置弹窗里没有音效开关');
  const m0 = s.muted;
  clickBtn(s, b);
  need(s.muted !== m0, '点了开关但状态没变');
  while (overlay.children.length) overlay.removeChild(overlay.children[0]);
  return `静音 ${m0} → ${s.muted}（设置弹窗内）`;
});

// ── 退休（第三批：结局收敛为唯一的「登顶」）──
// 此处的「心结 · 清算弹窗可点且记录」「传承 · 转生重置并结算 LP」「传承三选一 · 转生后弹窗可买且生效」
// 三条探针随各自机制一起删（第三批 2026-09-26）：心结 / 传承 / 转生已整块删除。
probe('退休 · 登顶 = 唯一结局，未登顶只提示且不结束', () => {
  /**
   * 第三批口径：退休那一刻 `s.worldRank === 1` ⇒ 唯一结局「登顶」；否则只弹「未登顶」提示
   * + 「继续经营」出口，**主循环不停、游戏不结束**（见 `main.js` 的 `finishRetirement`）。
   * handler 现在是 `retire() { finishRetirement(); }` —— 这里照它走一遍判定与分支。
   */
  const s = lateState();
  s.act = 8;
  s.buildings.perp = 1;
  for (const g of STAFF) { s.staff[g.id].level = 8; s.staff[g.id].loyalty = 100; }

  // ① 退休按钮必须真的在界面上（动作从界面来）
  const b = findAct(look(s, 0), 'retire');
  need(b, '主界面上找不到「退休」按钮');

  // ② 登顶：worldRank = 1 ⇒ 结局弹窗，且只剩「关灯」一个出口
  s.worldRank = 1;
  const r1 = evaluateRetirement(s);
  need(r1.ending === 'top' && r1.rank === 1,
    `worldRank=1 应判「登顶」，实为 ending=${r1.ending} / rank=${r1.rank}`);
  while (overlay.children.length) overlay.removeChild(overlay.children[0]);
  renderRetirement(overlay, s, r1, 1e10, 1e11);
  const retHtml = overlay.children[0].innerHTML;
  need(visible(retHtml).includes(ENDING_TEXT.top.title), '登顶结局弹窗没有显示「登顶」标题');
  need(visible(retHtml).includes(endingName('top')), '结局标题与 endingName 对不上');
  need(findAct(buttonsIn(retHtml), 'retireClose') !== null, '结局弹窗没有「关灯」出口');

  // ③ 未登顶：worldRank = 2 ⇒ 只提示，带 data-close 的「继续经营」出口（主循环没停）
  s.worldRank = 2;
  const r2 = evaluateRetirement(s);
  need(r2.ending === null && r2.rank === 2,
    `worldRank=2 不该判结局，实为 ending=${r2.ending} / rank=${r2.rank}`);
  while (overlay.children.length) overlay.removeChild(overlay.children[0]);
  renderNotTop(overlay, r2.rank);
  const notHtml = overlay.children[0].innerHTML;
  need(/data-close/.test(notHtml), '「未登顶」提示没有「继续经营」（data-close）出口 —— 玩家会以为按钮坏了');
  need(findAct(buttonsIn(notHtml), 'retireClose') === null, '未登顶不该出现结局弹窗的「关灯」出口');

  // ④ worldRank 为 null（世界榜尚未建立）也按「未登顶」处理，不结束
  s.worldRank = null;
  const r3 = evaluateRetirement(s);
  need(r3.ending === null && r3.rank === null, 'worldRank 为空时应判「未登顶」且 rank 为 null');

  return `worldRank=1 → 结局「${ENDING_TEXT.top.title}」；=2 / null → 未登顶提示（继续经营），游戏不结束`;
});

// ── 离线 / 存档 ──
probe('离线 · 8h 上限成立，折扣由「等效进度 ≤ 全程 25%」反推', () => {
  /**
   * spec §9.1 断言 #2 的曲线层版本。三件事必须同时成立：
   *   ① cap —— 离开 8 小时与离开 24 小时收益**完全相等**（不是「约为」）；
   *   ② 折扣 —— 离开 2 小时 == 在线 2 小时 × OFFLINE_MODIFIER（第一批的 50% 已按新时长重推）；
   *   ③ 等效进度上限 —— OFFLINE_MODIFIER × cap ≤ 全程 25%。
   * ③ 是这一条真正的判据：一局从 50h 压到 4.5h 后，0.5 的折扣会让离线 8h ≈ 完成 89% 的一局，
   * 挂机反而成为最优解 —— 那与「离线也赚钱，但不如守着」的契约相反。
   */
  const T0 = 1_700_000_000_000;
  const mk = () => { const s = lateState(); s.savedAt = T0; s.lastSeen = T0; return s; };

  const a = mk(); const oa = applyOffline(a, T0 + 8 * 3600 * 1000);
  const b = mk(); const ob = applyOffline(b, T0 + 24 * 3600 * 1000);
  need(oa.capped === OFFLINE_CAP_SEC && ob.capped === OFFLINE_CAP_SEC,
    `8h/24h 都应结算 ${OFFLINE_CAP_SEC} 秒，实为 ${oa.capped} / ${ob.capped}`);
  need(oa.gained === ob.gained, `8h 与 24h 收益应完全相等（cap），实为 ${oa.gained} vs ${ob.gained}`);
  need(oa.cappedOut === false && ob.cappedOut === true, 'cappedOut 标记不对（弹窗要靠它说明「按上限结算」）');

  const c = mk(); const oc = applyOffline(c, T0 + 2 * 3600 * 1000);
  const online2h = oc.R.netMoney * 7200;
  need(Math.abs(oc.gained - online2h * OFFLINE_MODIFIER) <= online2h * 1e-9,
    `离开 2 小时应等于在线 2 小时 × ${OFFLINE_MODIFIER}，实为 ${oc.gained} vs ${online2h * OFFLINE_MODIFIER}`);

  // ③ 等效进度上限：全程 = 一局的游戏跨度 = SEC_PER_YEAR × NARRATIVE_YEARS（8 幕 = 35 个游戏年）
  const fullRun = SEC_PER_YEAR * NARRATIVE_YEARS;
  const equiv = OFFLINE_MODIFIER * OFFLINE_CAP_SEC;
  need(equiv <= fullRun * 0.25 + 1e-9,
    `8h 离线的等效进度 ${(equiv / 3600).toFixed(2)}h 超过了全程 ${(fullRun / 3600).toFixed(2)}h 的 25%`);
  need(OFFLINE_MODIFIER > 0, '折扣不能归零（离线收益是放置类的头号承诺）');
  return `cap 8h（8h = 24h = ${oa.gained.toExponential(2)}）｜折扣 ${OFFLINE_MODIFIER}（离线 2h = 在线 ${(OFFLINE_MODIFIER * 2).toFixed(2)}h）｜等效 ${(equiv / 3600).toFixed(2)}h ≤ 全程 25%`;
});

probe('离线结算 · 离开也能拿到收益，并如实报出名次移动', () => {
  const T0 = 1_700_000_000_000;
  const s = lateState();
  s.world = createWorld('B', s.rngSeed || 20260924);
  advanceWorld(s.world, 24);                  // 世界已经跑到第 24 月
  s.savedAt = T0; s.lastSeen = T0;
  const m0 = s.resources.money, e0 = s.elapsed;

  const off = applyOffline(s, T0 + 4 * 3600 * 1000);
  need(s.elapsed > e0, '离线后游戏时间没有推进');
  need(s.resources.money > m0 || off.gained > 0, '离线没有任何收益');
  need(typeof off.rankBefore === 'number' && typeof off.rankAfter === 'number',
    `有世界时必须报出名次（before=${off.rankBefore}, after=${off.rankAfter}）`);
  /**
   * ⚠️ 第二批 §2.6（进度钟）：世界榜**不再**跟着真实时间复利 —— 离线只加资源、不改产出，
   *    市值不变 ⇒ 进度不变 ⇒ 世界没有理由往前走。这里要的是「结算完世界与进度对齐」。
   *    （本探针的样本世界停在 month 24，而进度在 month 360 —— 所以它必然被追平到 360。）
   */
  need(s.world.month === gameMonths(s),
    `离线结算后世界榜应追平到玩家进度所在月（${s.world.month} vs ${gameMonths(s)}）`);
  need(s.lastSeen === T0 + 4 * 3600 * 1000, `s.lastSeen 没跟上注入的 now（${s.lastSeen}）`);
  return `离开 4 小时 → 收益 ${off.gained.toExponential(2)}，世界追平到 month ${s.world.month}，名次 ${off.rankBefore} → ${off.rankAfter}`;
});

probe('离线弹窗 · 离开多久 / 拿到什么 / 世界走了几个月都讲出来', () => {
  /**
   * A4（2026-09-24）起，离线必须有一页摘要；第一批 §2.3 又加了一条纪律：
   * **只报数字，不编造剧情** —— 「离线段假装做了交互决策」是同类游戏被批评最多的写法。
   */
  const T0 = 1_700_000_000_000;
  const s = lateState();
  s.world = createWorld('B', s.rngSeed || 20260924);
  advanceWorld(s.world, 24);
  s.savedAt = T0; s.lastSeen = T0;
  const off = applyOffline(s, T0 + 4 * 3600 * 1000);

  while (overlay.children.length) overlay.removeChild(overlay.children[0]);
  renderOffline(overlay, off);
  need(overlay.children.length, '离线弹窗没有渲染');
  const txt = visible(overlay.children[0].innerHTML);
  need(/离开的/.test(txt) && /小时/.test(txt), '弹窗没有说明离开了多久');
  need(/\+\s*[\d.]/.test(txt), '弹窗没有显示收益数字（带 + 号的行）');
  need(/收下/.test(txt), '弹窗没有「收下」按钮');
  need(/世界/.test(txt) && /月/.test(txt), '弹窗没有报出世界又走了几个月');
  /**
   * ⚠️ W2（2026-09-25 最终修复波）：弹窗里的收益行必须等于**实际入账量**。
   *
   * 实际入账是 `R.netMoney × capped × mod`（`save.js` 的 `applyOffline`），
   * 而弹窗曾漏乘离线折扣 `off.mod` —— 折扣 0.5 时就高报 **2 倍**。
   * 所以这里直接对**渲染出来的文字**断言，把 `off.mod` 从乘式里删掉必须变红。
   * ⚠️ 2026-09-26 第四批：原来还断言「代码 / 人脉」两行，两条链删除后只剩资金一行。
   */
  // ⚠️ 2026-09-26 第三批：离线折扣改为基准常量 OFFLINE_MODIFIER（原「按传承加成」的函数已删）。
  const mod = OFFLINE_MODIFIER;
  need(mod !== 1, `样本失效：本用例必须处在折扣生效的状态（mod ≠ 1，实为 ${mod}），否则断言恒真`);
  need(off.mod === mod, `弹窗拿到的 off.mod（${off.mod}）与 OFFLINE_MODIFIER（${mod}）不一致`);
  need(txt.includes(`+${fmt(off.gained)}`),
    `弹窗「资金」显示的不是实际入账量（应显示 +${fmt(off.gained)}）`);
  return `离线弹窗：离开 ${(off.capped / 3600).toFixed(1)}h、收益、世界 +${off.worldMonths} 月齐全；资金按折扣 ${mod} 入账`;
});

probe('存档 · 序列化往返一致', () => {
  const s = lateState();
  const back = deserialize(serialize(s));
  need(back.act === s.act, '幕次往返丢失');
  need(Math.abs(back.resources.money - s.resources.money) < 1e-6, '资金往返丢失');
  need(Object.keys(back.buildings).length === Object.keys(s.buildings).length, '建筑数量往返丢失');
  return `v${back.version} 存档往返一致（建筑 ${Object.keys(back.buildings).length} 种）`;
});

// ── 美术（给过实现，也要有探针）──
probe('美术 · 8 幕色调与插画都存在', () => {
  for (let a = 1; a <= 8; a++) {
    need(themeOf(a) && themeOf(a).accent, `第 ${a} 幕没有色调`);
  }
  return `8 幕色调齐备，当前幕「${themeOf(4).name}」`;
});

// 此处的「碎片 · 能随时间收集」探针随回忆碎片机制一起删（第三批 2026-09-26）：
// 碎片整块删除，已无「随时间收集」这条机制。

// ── 文案探针：玩家能读到的文字里不许出现「实现细节」──
probe('文案 · 可见文字不含 Markdown 与内部术语', () => {
  /**
   * 为什么要有这条：`renderChoice` 里曾经写着
   *    三条路线的**经济收益完全等价**，差异只在徽章与结局权重上。
   * Markdown 的星号**原样显示**在弹窗里；另外还有多处把「GDD 4.6」「设计目标 ≤30%」
   * 这类**只该存在于设计文档里的注解**直接渲染给了玩家。
   * 文案是产品的一部分，必须有探针守着。
   */
  const s = lateState();
  const BAD = [
    [/\*\*/, 'Markdown 粗体标记'],
    [/GDD/, '设计文档编号'],
    [/设计目标|设计文档|实现细节/, '设计注解'],
    [/\bNaN\b/, 'NaN'],
    [/\bundefined\b/, 'undefined'],
    [/\bnull\b/, 'null'],
    [/\[object/, '对象字符串化'],
    [/\bTODO\b|\bFIXME\b/, 'TODO 残留'],
  ];
  const hits = [];
  const scan = (label, text) => {
    for (const [p, why] of BAD) if (p.test(text)) hits.push(`${label} → ${why}`);
  };
  for (let tab = 0; tab < 5; tab++) scan(`标签页 ${tab}`, visible(htmlOf(s, tab)));
  for (const ev of [...ALL_EVENTS.daily, ...ALL_EVENTS.choice, ...ALL_EVENTS.milestone]) {
    scan(`事件「${ev.title}」`, visible(`${ev.text} ${(ev.options || [])
      .map(o => `${o.label} ${o.hint || ''}`).join(' ')}`));
  }
  for (const key of Object.keys(ENDING_TEXT)) {
    const t = ENDING_TEXT[key];
    scan(`结局「${t.title}」`, visible(`${t.line} ${t.body}`));
  }
  need(!hits.length, `发现 ${hits.length} 处：\n     ${hits.slice(0, 8).join('\n     ')}`);
  return `5 个标签页 + ${ALL_EVENTS.daily.length + ALL_EVENTS.choice.length + ALL_EVENTS.milestone.length} 条事件 + ${Object.keys(ENDING_TEXT).length} 个结局的文案都干净`;
});

// ── UI 密度探针：手机上不能一屏铺出几十行 ──
probe('UI · 可购买高亮（买得起的按钮带 buyable）', () => {
  /**
   * 放置类的标配反馈：「此刻买得起什么」一眼可见。
   * 没有它，玩家要逐个按钮点过去才知道（手机上尤其难受）。
   * 断言两层：建设页的产出建筑按钮 + 主界面的地标按钮，都在「钱够 → buyable / 钱不够 → 无」。
   */
  const s = createState();
  s.act = 3;                                         // 第 1 幕大部分建筑是 🔒 未解锁
  s.resources.money = 1e12;                          // 随便什么建筑都买得起
  const htmlRich = htmlOf(s, 1);
  const nBuy = (htmlRich.match(/class="buyable"/g) || []).length;
  need(nBuy >= 3, `钱够 + 已解锁时建设页应有 ≥3 个 buyable 按钮，实际 ${nBuy}`);
  const poor = createState();                        // 0 资金：谁都买不起
  need(!/class="buyable"/.test(htmlOf(poor, 1)) && !/class="buyable"/.test(htmlOf(poor, 0)),
    '0 资金时不应有任何 buyable 按钮');

  const richMain = htmlOf(s, 0);
  need(/class="buyable"[^>]*>买下 /.test(richMain.replace(/\n/g, '')) ||
    /class="buyable"/.test(richMain), '钱够时主界面地标按钮应带 buyable');
  return '钱够 → buyable（建设页 ≥3 + 地标 1）；0 资金 → 全部无';
});

probe('UI 结构 · 日志固定底部、弹窗遮罩层级、HUD 带单位', () => {
  /**
   * CSS 是 DOM stub **测不到**的（stub 没有 computed style），
   * 所以这里对样式表做结构断言 —— 三条都是用户在真机上截图报出来的问题：
   *   ① 日志在文档流里 → 主界面一长就「要滚到底才看得见」
   *   ② `.modal` 没有 z-index → 与 `.head`（z-index:10）打架，遮罩透出背景文字
   *   ③ HUD 裸数字 → 「资金 3.45」读不出是 3.45 块还是 3.45 万
   */
  const css = readFileSync(new URL('../src/ui/style.css', import.meta.url), 'utf8');
  const logBlock = (css.match(/\.log\s*{[^}]*}/) || [''])[0];
  need(/position:\s*fixed/.test(logBlock) && /bottom:\s*0/.test(logBlock),
    '日志没有固定在屏幕底部（position:fixed + bottom:0）');
  need(/z-index/.test(logBlock), '日志条没有 z-index（会被弹窗 / 新版本提示条压住）');
  const appBlock = (css.match(/#app\s*{[^}]*}/) || [''])[0];
  need(/1[57]\dpx/.test(appBlock),
    '#app 没有给固定日志让出底部留白 —— 最后一行内容会被日志压住');
  const modalBlock = (css.match(/\.modal\s*{[^}]*}/) || [''])[0];
  need(/z-index:\s*\d{3,}/.test(modalBlock),
    '.modal 没有 z-index —— .head 是 z-index:10，遮罩会和它打架（背景内容透出来）');
  need(/rgba\(0,\s*0,\s*0,\s*\.9\d\)/.test(modalBlock),
    '.modal 遮罩太透（<90%）—— OLED 上弹窗和背景文字会叠成一片');

  // HUD 单位
  const txt = visible(htmlOf(createState(), 0));
  need(txt.includes('¥'), 'HUD 的资金 / 市值没有 ¥ 单位（读不出量纲）');
  // ⚠️ 2026-09-26 第四批：代码 / 人脉两条链删除后，HUD 只剩「资金/秒」，没有「行 / 人」两种单位。
  need(/每秒 /.test(txt), 'HUD 的速率缺单位（应为「每秒 +X」）');
  return 'log fixed + z-index + #app 让位；.modal z-index + ≥90% 遮罩；HUD ¥ / 每秒速率带单位';
});

probe('UI · 每个标签页「不折叠就可见」的行数有上限', () => {
  /**
   * 「UI 合理性」必须有可度量的判据，否则每天都在凭感觉改。
   * 判据：**折叠起来的内容不算**，每个标签页默认展开的 `class="row"` 不超过 22 行。
   * 背景：传承页原来一次铺出 ~45 行（回忆图鉴 26 条 + 成就 11 条全展开），
   * 手机上要滑很久 —— A Dark Room 的做法是一屏只讲一件事。
   */
  const s = lateState();
  const LIMIT = 22;
  const report = [];
  for (let tab = 0; tab < TABS.length; tab++) {
    const html = htmlOf(s, tab).replace(/<details[\s\S]*?<\/details>/g, '');
    const rows = (html.match(/class="row"/g) || []).length;
    need(rows <= LIMIT, `${TABS[tab]} 未折叠就有 ${rows} 行（上限 ${LIMIT}），手机上要滑很久`);
    report.push(`${TABS[tab]} ${rows} 行`);
  }
  return report.join(' ｜ ');
});

// ── 结构性探针：渲染出的动作键都必须有人管 ──
probe('结构 · 渲染出的 data-* 动作键都有 dispatch 分支', () => {
  const s = lateState();
  for (let act = 1; act <= 8; act++) {
    s.act = act;
    for (let tab = 0; tab < 5; tab++) {
      for (const b of look(s, tab)) {
        for (const k of Object.keys(b.data)) {
          if (!HANDLED.has(k)) bad(`第 ${act} 幕 / 标签页 ${tab} 出现未接线的动作键 data-${k}`);
        }
      }
    }
  }
  return '5 个标签页 × 8 幕的所有按钮都已接线';
});

probe('结局 · 唯一结局「登顶」文案四条字段齐备', () => {
  /**
   * B4（2026-09-24）：结局 body 之后直接跳数据回执，「停得太突然」，所以加了 epilogue 收尾。
   * 第三批（2026-09-26）：8 个结局收敛为**唯一一个**「登顶」—— 这里只断言这一条的
   * title / line / body / epilogue 都非空（`ENDINGS` 也只有 `top` 一个 key）。
   */
  const t = ENDING_TEXT.top;
  need(t, 'ENDING_TEXT 里没有 top（唯一结局丢了）');
  for (const k of ['title', 'line', 'body', 'epilogue']) {
    need(typeof t[k] === 'string' && t[k].trim().length > 0,
      `唯一结局「登顶」的 ${k} 为空 —— 结局演出会缺一块`);
  }
  need(endingName('top') === t.title, `endingName('top') 应回 title「${t.title}」，实为「${endingName('top')}」`);
  return `唯一结局「${t.title}」：title / line / body / epilogue 齐备`;
});

// ══════════════════════════ 报告 ══════════════════════════
const ok = rows.filter(r => r.ok).length;
console.log('');
console.log('  ╔══════════════════════════════════════════════════════════════════════════════╗');
console.log('  ║  流程探针：每个流程都必须能在界面上点到、并且真的产生可见变化              ║');
console.log('  ╚══════════════════════════════════════════════════════════════════════════════╝');
console.log('');
for (const r of rows) {
  console.log(`  ${r.ok ? '✅' : '❌'} ${r.name.padEnd(30)} ${r.ev}`);
}
console.log('');
console.log(`  ${ok}/${rows.length} 个流程探针通过${ok === rows.length ? '' : `，${rows.length - ok} 个失败`}`);
console.log('');
console.log('BRIEF ' + JSON.stringify({ total: rows.length, ok, fail: rows.length - ok, failed: rows.filter(r => !r.ok).map(r => r.name) }));
console.log('');
process.exit(ok === rows.length ? 0 : 1);
