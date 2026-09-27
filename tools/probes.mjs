#!/usr/bin/env node
/**
 * 流程探针（`npm run probe`，GDD §5.3）
 * ===============================================================
 * 用户要求：「一定要确保每个流程都有探针（保证游戏可达性）以及一定要进行真实模拟，
 *            而不是仅凭代码做模拟」。
 *
 * 所以本文件里的每条探针都守两条规矩：
 *   ① **动作从界面来**：先在真实渲染结果里找那个按钮（`buttonsIn(root.innerHTML)`），
 *      找不到就判失败 —— 这正是「凑够钱却没有按钮」那类 bug 的探针形态。
 *   ② **结果看可见状态**：断言状态/字符串真的变了，而不是断言「函数返回了 true」。
 *
 * 覆盖面（v4 重制）：
 *   §5.1 经济模型六条不变式 · §1.4 世界榜四条坑 · §1.5 年度决策 ·
 *   §1.6 自动购买 · §1.7 离线结算 · 存读档往返 · UI 接线一致性 · 真实启动烟测。
 *
 * ⚠️ 恒 exit 0；结论读末尾 `BRIEF`。`robust.mjs` 不读本文件（它读 headless-check）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { makeNode, buttonsIn } from './dom-stub.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ─────────────────────────── 假 DOM（比 dom-stub 略丰富）─────────────────────────── */
/**
 * probes 里有一条**真实启动烟测**要 `import('../src/main.js')`。
 * main.js 在顶层就会碰 `document.getElementById` / `window` / `location` /
 * `requestAnimationFrame` / `setInterval`，所以这里装一套够用的全局。
 * ⚠️ `requestAnimationFrame` 故意**不回调** —— 主循环只启动一次、不真跑，
 *    否则探针会挂在这里等一局 5 小时。
 * ⚠️ `setInterval` 包一层 `unref()` —— 否则 main.js 的自动存盘定时器会把 Node 进程吊住。
 */
const els = new Map();
const storage = new Map();
function makeEl(tag = 'div') {
  const n = makeNode(tag);
  n.append = (...cs) => { for (const c of cs) n.appendChild(c); };
  return n;
}
function installHarness() {
  globalThis.localStorage = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: k => { storage.delete(k); },
  };
  globalThis.document = {
    createElement: makeEl,
    getElementById: id => { if (!els.has(id)) els.set(id, makeEl('div')); return els.get(id); },
    addEventListener() {},
    body: makeEl('body'),
  };
  globalThis.window = { addEventListener() {}, PointerEvent: function PointerEvent() {} };
  globalThis.location = { reload() {} };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => {
    const t = realSetInterval(fn, ms);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };
}
installHarness();

/* ─────────────────────────── 被测模块（线上代码，不是副本）─────────────────────────── */
import {
  ACTS, LINES, LINE_IDS, EVENTS, eventsFor, eventById, PENDING_CAP, IPO_LINE,
  CURVE_RATIO, LINE_GROWTH, INCOME_SCALE, SEC_PER_YEAR, RESERVE_FRAC, MILESTONES,
  OFFLINE_CAP_SEC, OFFLINE_MODIFIER, PE_MIN, PE_MAX, PE_BASE, START_MCAP, LINE_COST0,
  valAt, winterAt, cycleAt, VAL_CYCLE_AMP, COST_CYCLE_AMP, CYCLE_MONTHS, ORDER_TIERS,
  FOUNDERS, agesAt, startYearOf, marginOf, salaryFrac, scaleFrac, companyName, lineName,
  AUTO_BUY_RESERVE, AUTO_BUY_RESERVE_EARLY, autoBuyReserveOf, MANUAL_GAIN, MANUAL_PAY, AUTO_DECIDE_STAGE,
} from '../src/core/content.js';
import {
  rates, derived, costOf, costFor, purchase, lineLevel, manualCostOf, canAffordManual,
  peOf, sharePctOf, lowestLine, spendableOf, reserveOf, tamOf, TAM0, TAM_GROWTH,
} from '../src/core/economy.js';
import {
  ordersTick, deliverOrder, ORDER_SLOTS, ORDER_EVERY_MONTHS,
  ORDER_LIFE_MONTHS, HOT_TIER, AUTO_DELIVER, liveOf, liveCount, hasHot, monthsLeftOf, valueOf,
  doneCount,
} from '../src/core/orders.js';
import {
  tick, pendingEvent, resolvePending, applyEffect, stageGoalMet, offlineRun, LOG_MAX,
  manualBuy,
} from '../src/core/engine.js';
import { ROUNDS, isListed } from '../src/core/finance.js';
import { ENDING_TEXT, evaluateRetirement } from '../src/core/endings.js';
import { applyOffline, save, load, wipe, disableSave, enableSave } from '../src/core/save.js';
import {
  createState, serialize, deserialize, SAVE_KEY, SAVE_VERSION,
} from '../src/core/state.js';
import {
  gameDate, gameYear, gameMonths, calMonthOf, ACT_MONTHS, MONTHS_TOTAL, TOTAL_YEARS,
} from '../src/core/format.js';
import {
  createWorld, advanceWorld, ranking, worldDate, worldTick, toUSD_T, RMB_PER_T_USD, cycleNotes,
} from '../src/core/world.js';
import {
  render, renderOffline, renderSettings, renderEnding, renderNotTop, closeModal, setTab,
  armDeleteSave, deleteSaveArmed, disarmDeleteSave, fmt,
} from '../src/ui/render.js';
import {
  bindActions, findActionEl, PRIMARY_EVENT, KEYBOARD_EVENT, ACTION_KEYS, ACTION_SELECTOR,
} from '../src/ui/bind.js';
import { CURVE_BAND, IDLE_BAND, TARGET_TOTAL_H, NARRATIVE_YEARS } from './curve-targets.mjs';

const root = makeNode('div');
const overlay = makeNode('div');

/* ─────────────────────────── 探针框架 ─────────────────────────── */
const rows = [];
function probe(name, fn) {
  try {
    const ev = fn();
    rows.push({ ok: true, name, ev: ev === undefined ? '已生效' : String(ev) });
  } catch (e) {
    rows.push({ ok: false, name, ev: e.message || String(e) });
  }
}
const need = (cond, msg) => { if (!cond) throw new Error(msg); };

/* ─────────────────────────── 工具 ─────────────────────────── */
/** src/ 下所有 .js（源码审计类探针用） */
function walkSrc(dir, out = []) {
  let es;
  try { es = readdirSync(dir); } catch { return out; }
  for (const e of es) {
    if (e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkSrc(p, out);
    else if (/\.js$/.test(e)) out.push(p);
  }
  return out;
}
const SRC = walkSrc(join(ROOT, 'src')).map(p => {
  const raw = readFileSync(p, 'utf8');
  return {
    rel: relative(ROOT, p).replace(/\\/g, '/'),
    src: raw,
    code: stripComments(raw),      // 审计用：注释里写「零 Math.random()」不该被判成违规
  };
});
const srcOf = rel => SRC.find(f => f.rel === rel.replace(/\\/g, '/')).src;
const toolOf = rel => stripComments(readFileSync(join(ROOT, rel), 'utf8'));
/** 去掉块注释与行注释（保留 `https://` 这类带冒号的写法） */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 剥标签，只留玩家真正读到的文字 */
const visible = html => String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** 渲染主界面并把按钮解析出来 */
function look(s) {
  render(root, s);
  return buttonsIn(root.innerHTML);
}
/**
 * 页签下标 —— 与 `render.js` 的 `TABS` 同序（**创始人 / 公司 / 订单 / 市值榜**）。
 * 探针里不裸写数字：2026-09-27 调换过前两个页签，裸写的地方全要跟着改一遍。
 */
const TAB_FOUNDER = 0, TAB_COMPANY = 1, TAB_ORDER = 2, TAB_RANK = 3;

/**
 * 渲染**指定页签**并解析按钮。
 * ⚠️ 页签是 `render.js` 的模块级交互态，会跨探针残留 —— 凡是依赖「哪一页」的断言
 *    都必须显式 `setTab()`，不能沿用上一条探针留下的页。
 */
function lookTab(s, i) {
  setTab(i);
  return look(s);
}
/** 渲染设置/结局弹窗并解析按钮 */
function lookOverlay(html) { return buttonsIn(html); }

/** 造一个「已开局、中期」的存档：世界表与进度钟都已初始化 */
function midState(stage = 3, level = 30) {
  const s = createState();
  s.stage = stage;
  s.lines = bal(level);
  tick(s, 0);        // dt=0：只建世界表 / 写进度钟 / 发第 1 年年报，不推进生产
  return s;
}

/**
 * 五条线同级的「均衡档」（`n = ΣL/5`）—— **所有 fixture 都必须用它**。
 * ⚠️ 手写 `{ r: 30, m: 30, h: 30 }` 会把新增的 `c/d` 留成 0 级：
 *    收入少掉两个因子、`年营收/cost` 那条常数不变式直接失效 —— 而这不代表代码错了。
 */
const bal = n => Object.fromEntries(LINE_IDS.map(id => [id, n]));

/** 一个选项在**对数市值**上的增量 —— 与 headless-check 同一口径（挑最优项用） */
function logCapDelta(s, eff) {
  if (!eff) return 0;
  const R = rates(s);
  let d = 0;
  // 一笔现金能买几级 × 每级的对数市值增量（ln g = ln r / 线数）
  if (eff.cash) d += ((eff.cash * R.revenue) / costFor(s, LINE_IDS[0])) * Math.log(CURVE_RATIO) / LINES.length;
  for (const k of ['prod', 'share', 'team']) if (eff[k]) d += Math.log(eff[k]);
  if (eff.pe) d += Math.log(Math.max(1e-9, (peOf(s) + eff.pe) / peOf(s)));
  return d;
}

/**
 * 真跑一局（在线、1 秒逻辑步长）。
 * `strategy`：`'best'` 每年选对数市值增量最大的选项；`'idle'` 一条待决都不碰
 * —— 交给引擎的积压上限按默认选项结算（这正是 §1.5 要验的那条规则）。
 */
function play(strategy = 'best', maxSeconds = 60 * 3600) {
  const s = createState();
  const STEP = 1;
  let t = 0;
  /**
   * 逐幕记录目标的打勾时刻 —— 用来断言「`ACTS[].goal` 的每一条都在**本幕之内**被跨过」。
   * `first` = 第一次看到这一幕的时刻（用来抓「一进幕就成立」的假目标），
   * `last` = 最后一次看到这一幕的时刻（幕长），`hit` = 目标首次成立。
   */
  const marks = {};
  /**
   * 逐 tick 记录**玩家看到的市值** —— 「低谷可见」那条探针要用它。
   * `{ m: 游戏月, v: 市值, rev: 年营收, va: valAt(月), pe: 市盈率 }`：后三个只在报红时印出来，
   * 好让读的人一眼看出那一段是「估值周期砸的」还是「自动购买停摆砸的」（两种都在设计里）。
   *
   * ⚠️ 必须**逐 tick**，不能按月采样：日历是 `marketCapBase` 的分段对数插值，
   *    而年度决策会改 PE ⇒ base 一跳，日历就**跳过**某个月（月度采样点落空）。
   *    落空之后「补最近一个月」的写法会把**两个月的变化**记成**一个月的变化**，
   *    于是一段低谷被劈成两段、还凭空多出几个假低谷（实测：4 段被量成 7 段）。
   *    逐 tick 之后每个月有几十个采样点，下降沿是一整段连续采样 —— 与 `STEP`、倍速都无关。
   */
  const caps = [];
  while (!s.ending && t < maxSeconds) {
    t += STEP;
    tick(s, STEP);
    const a = s.stage;
    const m = (marks[a] = marks[a] || { first: t, last: t });
    m.last = t;
    const D0 = derived(s);
    caps.push({ m: gameMonths(s), v: D0.marketCap, pe: D0.pe, rev: D0.revenue, va: valAt(gameMonths(s)) });
    /**
     * ⚠️ 必须在 tick **之后**重算 R/D 再判目标：`tick` 内部是先算 D（此时还是上一幕的市场）
     *    再 `advanceStage`，所以它返回的那对 (R, D) 与「跨幕那一帧的新幕次」并不配套 ——
     *    拿它去判新幕的目标，第 3 幕的份额会在入场那一帧读到上一幕的 50%，误判成「一进幕就成立」。
     */
    if (m.hit === undefined) {
      const R2 = rates(s);
      if (stageGoalMet(s, R2, derived(s, R2))) m.hit = t;
    }
    const ev = pendingEvent(s);
    if (!ev) continue;
    if (strategy !== 'best') continue;
    const k = logCapDelta(s, ev.options[0].eff) >= logCapDelta(s, ev.options[1] && ev.options[1].eff) ? 0 : 1;
    resolvePending(s, s.pending[0].uid, k, rates(s));
  }
  return { s, seconds: t, marks, caps };
}

/* ── 一次真跑，多条探针共用（跑一局 ≈1s，跑两次太浪费）── */
const A = play('best');
const D = play('idle');

// ═══════════════════════════ §5.1 经济模型六条不变式 ═══════════════════════════

probe('① margin ≥ 0.20（八章全程）', () => {
  for (let a = 1; a <= 8; a++) {
    const m = marginOf(a);
    need(m >= 0.20 - 1e-12, `第 ${a} 章 margin=${m.toFixed(3)} < 0.20`);
    need(Math.abs(m - (1 - salaryFrac(a) - scaleFrac(a))) < 1e-12, `第 ${a} 章 margin 与两个 frac 不自洽`);
  }
  return `最低 ${Math.min(...ACTS.slice(1).map((_, i) => marginOf(i + 1))).toFixed(3)}（第 8 章）`;
});

probe('② upkeep 无加法项（严格等于 revenue × frac）', () => {
  for (let a = 1; a <= 8; a++) {
    const s = createState();
    s.stage = a;
    s.lines = { ...bal(9), r: 12, h: 15 };
    const R = rates(s);
    need(R.upkeep === R.revenue * R.frac, `第 ${a} 章 upkeep ≠ revenue·frac —— 出现了加法项`);
    need(R.net === R.revenue - R.upkeep, `第 ${a} 章 net ≠ revenue − upkeep`);
  }
  // 源码级：upkeep 那一行只能是乘法（旧版是 `revenue·k − 固定额`，gross 一小就永久负收入）
  const eco = srcOf('src/core/economy.js');
  need(/const upkeep = revenue \* frac;/.test(eco), 'upkeep 的写法变了 —— 请确认没有引入绝对额固定支出');
  return '净额恒等于比例式';
});

probe('③ 五个变量恒 ≥ 1，且「年营收 / 单次成本」与章节无关', () => {
  need(LINE_GROWTH >= 1, `LINE_GROWTH=${LINE_GROWTH} < 1`);
  for (const lv of [0, 1, 7, 40, 200]) {
    const s = createState();
    s.lines = bal(lv);
    const R = rates(s);
    const all = [R.prod, R.share, R.team, R.comp, R.chan];
    need(all.every(v => v >= 1), `Lv${lv} 出现 <1 的变量（${all.join('/')}）`);
  }
  /**
   * 删掉旧版 `GENERATION = 1.5^(stage−1)` 隐藏乘数之后才成立的关键事实：
   * `年营收 / cost(n) = INCOME_SCALE·SEC_PER_YEAR / LINE_COST0` 是**常数**。
   * 它是「一笔融资值多少次购买全程恒定」与「事件 cash 系数不必逐章缩放」的唯一依据。
   */
  const want = INCOME_SCALE * SEC_PER_YEAR / LINE_COST0;
  for (let a = 1; a <= 8; a++) {
    const s = createState();
    s.stage = a;
    s.lines = bal(30);        // 均衡档：n = ΣL/5
    const R = rates(s);
    const ratio = R.revenue / costOf(30);
    need(Math.abs(ratio / want - 1) < 1e-9, `第 ${a} 章 年营收/cost = ${ratio.toFixed(4)} ≠ ${want.toFixed(4)} —— 又出现了随章缩放的隐藏乘数`);
  }
  return `比值恒为 ${want.toFixed(2)}（三线均衡档）`;
});

probe('④ PE 夹取在 [8, 60] 内', () => {
  need(PE_MIN === 8 && PE_MAX === 60, `PE 区间是 [${PE_MIN}, ${PE_MAX}]`);
  for (let a = 1; a <= 8; a++) {
    for (const d of [-999, -50, 0, 50, 999]) {
      const s = createState();
      s.stage = a;
      s.mod.pe = d;
      const pe = peOf(s);
      need(pe >= PE_MIN && pe <= PE_MAX, `第 ${a} 章 mod.pe=${d} ⇒ PE=${pe} 越界`);
    }
  }
  return `基准 ${ACTS.slice(1).map(a => a.pe).join('/')}`;
});

probe('⑤ 五条线等级只增不减（源码审计）', () => {
  // 允许的写入形态只有两种：购买 +gain（economy）与读档夹取（state）
  const allowed = [
    /s\.lines\[id\] = lineLevel\(s, id\) \+ gain/,     // economy.purchase
    /merged\.lines\[l\.id\] = Math\.max\(0, Math\.floor/,  // state.deserialize 夹取
  ];
  const bad = [];
  for (const f of SRC) {
    for (const m of f.src.matchAll(/(\w[\w.$\[\]'"]*)\.lines\[[^\]]*\]\s*[-+*/]?=/g)) {
      const line = m[0];
      const full = f.src.slice(m.index, m.index + 120);
      if (allowed.some(re => re.test(full))) continue;
      bad.push(`${f.rel}: ${line}`);
    }
  }
  need(!bad.length, `出现了未授权的 lines 写入：${bad.join('；')}`);
  const s = createState();
  const before = { ...s.lines };
  purchase(s, 'r');                      // 买不起 ⇒ 不该变
  need(JSON.stringify(before) === JSON.stringify(s.lines), '买不起也改了等级');
  return '只有 +gain 与读档夹取两类写入';
});

probe('⑥ marketCap 对等级单调递增（五线分别验）', () => {
  for (let a = 1; a <= 8; a++) {
    for (const id of LINE_IDS) {
      const s = createState();
      s.stage = a;
      s.lines = bal(10);
      const lo = derived(s).marketCap;
      s.lines = { ...s.lines, [id]: 11 };
      const hi = derived(s).marketCap;
      need(hi > lo, `第 ${a} 章加 ${id} 一级后市值没涨（${lo} → ${hi}）`);
    }
  }
  return '五线各自单调';
});

// ═══════════════════════════ §1.4 世界市值榜的四条坑 ═══════════════════════════

probe('榜单只给前 20 名', () => {
  const w = createWorld('B');
  advanceWorld(w, 24);
  const { top, all } = ranking(w, null, 20);
  need(top.length === 20, `top.length=${top.length}`);
  need(top[19].rank === 20 && top[0].rank === 1, '名次不是 1..20 连续');
  need(all.length > top.length, '全量表应当比截断后的 top 长（渲染层要靠它找玩家行）');
  need(top.every(c => !c.me), '未上市却被排进了榜');
  return `${top.length} 家（全表 ${all.length} 家）`;
});

probe('未上市不进榜；上市后才出现「我们」', () => {
  const w = createWorld('B');
  advanceWorld(w, 24);
  need(!ranking(w, null, 10).all.some(c => c.me), '未上市（cap=null）时不该出现玩家');
  const withMe = ranking(w, 1e6, 10, null).all;
  need(withMe.some(c => c.me), '上市（cap>0）后应出现玩家行');
  const s = midState(3, 30);
  lookTab(s, 3);                                  // 榜单在「市值榜」页（第 4 个页签）
  need(!root.innerHTML.includes('class="row me"'), '未上市的主界面里出现了玩家行');
  need(visible(root.innerHTML).includes('未上市'), 'HUD 没写「未上市」');
  s.finance.rounds = ['angel', 'preA', 'a', 'b', 'c', 'preIpo', 'ipo'];
  lookTab(s, 3);
  need(root.innerHTML.includes('class="row me"'), '上市后榜单里没有玩家行');
  return '未上市 — / 上市进榜';
});

probe('上市且名次 > 20 时钉底（>100 只报「>100」、不画升降、市值恒两位小数）', () => {
  const s = midState(3, 30);
  s.finance.rounds = ['ipo'];
  lookTab(s, 3);
  const meRowIdx = root.innerHTML.indexOf('class="row me"');
  const sepIdx = root.innerHTML.indexOf('class="sep"');
  need(sepIdx >= 0, '名次 >20 时缺少分隔行 ⋯');
  need(meRowIdx > sepIdx, '玩家行没有排在分隔行之后（没钉到底部）');
  // 钉底那一行显示的是**公司名**，不是「我们」
  const meRow = root.innerHTML.slice(meRowIdx, root.innerHTML.indexOf('</div>', meRowIdx));
  need(meRow.includes(companyName(isListed(s))), `玩家行没显示公司名（应为 ${companyName(isListed(s))}）`);
  need(!root.innerHTML.includes('>我们<'), '榜单里还留着「我们」这个称呼');
  // 名次在 100 开外 ⇒ 具体名次没有信息量，只报 >100（HUD 与钉行同一口径）
  need(s.worldRank > 100, `这条断言要名次 >100 才成立（实得 ${s.worldRank}）`);
  need(root.innerHTML.includes('>100</span>'), '榜单钉行没有显示「>100」');
  need(root.innerHTML.includes('<b>>100</b>'), 'HUD 世界格没有显示「>100」');
  need(!root.innerHTML.includes('class="lines"'),
    '「市值榜」页里冒出了投资线 —— 页与页的内容必须互斥');
  // 100 名开外**连升降也不画**：那个区间里名次每天都在漂，↑3 / ↓5 只是噪声
  const dlt = /class="row me"[\s\S]*?<span class="dlt">([\s\S]*?)<\/span>/.exec(root.innerHTML);
  need(dlt && dlt[1] === '', `玩家在 >100 名时仍显示升降（实得 ${JSON.stringify(dlt && dlt[1])}）`);

  // 市值一律两位小数（「三位数就取整」已废弃）：造一家 $123.456T 的公司看渲染
  s.world.companies.forEach((c, i) => { c.cur = c.prev = i === 0 ? 123.456 : 1; });
  lookTab(s, 3);
  need(root.innerHTML.includes('>123.46<'), '三位数市值没有保留两位小数');
  return `名次 #${s.worldRank} ⇒ 钉底 + 报 >100 + 不画升降 ／ $123.456T ⇒ 123.46`;
});

probe('rankDelta：新入场为 null，且上月名次按全榜重排', () => {
  const w = createWorld('B');
  let bornAt = -1;
  for (let m = 1; m <= MONTHS_TOTAL && bornAt < 0; m++) {
    advanceWorld(w, 1);
    if (w.companies.some(c => c.born === w.month)) bornAt = w.month;
  }
  need(bornAt > 0, '一年内没有任何新公司入场 —— 这条坑测不到');
  const { all } = ranking(w, null, 1e9);
  const fresh = all.filter(c => c.isNew);
  need(fresh.length > 0, `第 ${bornAt} 月应有新入场公司`);
  for (const c of fresh) {
    need(c.rankDelta === null, `新入场「${c.n}」的 rankDelta = ${c.rankDelta}（应为 null，否则 UI 会把「新」误画成持平）`);
  }
  // 上月名次必须是**全榜**（含 10 名之外）重排的结果，否则「从第 15 杀进第 8」会显示不出来
  const nonNew = all.filter(c => !c.isNew);
  const byPrev = [...nonNew].sort((a, b) => b.prev - a.prev);
  byPrev.forEach((c, i) => { c._prevRank = i + 1; });
  let deepChecked = 0;
  for (const c of nonNew) {
    need(c.rankDelta === c._prevRank - c.rank,
      `「${c.n}」rankDelta=${c.rankDelta}，全榜重排应得 ${c._prevRank - c.rank}`);
    if (c.rank > 10 && c._prevRank > 10 && c.rankDelta !== 0) deepChecked += 1;
  }
  need(deepChecked > 0, '没有任何「10 名之外也发生名次变化」的样本 —— 全榜重排没被真正验到');
  return `第 ${bornAt} 月入场 ${fresh.length} 家；榜外换位 ${deepChecked} 家`;
});

// ═══════════════════════════ §1.5 年度决策 ═══════════════════════════

probe('每年恰好 1 条待决（决策 + 余留 + 积压默认 + 后期自动化 = 已过年数）', () => {
  const years = gameYear(A.s);
  const resolved = A.s.decisions;
  const left = A.s.pending.length;
  const spilled = A.s.overflowed;
  const auto = A.s.autoDecided;
  need(years > 1, `一局只过了 ${years} 年 —— 样本不成立`);
  need(resolved + left + spilled + auto === years,
    `${resolved} + ${left} + ${spilled} + ${auto} = ${resolved + left + spilled + auto} ≠ ${years} 年`);
  need(spilled === 0, `主动路径不该触发积压默认（实得 ${spilled} 条）`);
  need(auto > 0, `第 ${AUTO_DECIDE_STAGE} 幕起一条都没走「后期自动化」—— 样本不成立`);
  return `${years} 年 / 决策 ${resolved} 条 · 后期自动化 ${auto} 条`;
});

probe('积压上限 3：第 4 条起按默认选项结算', () => {
  need(PENDING_CAP === 3, `PENDING_CAP=${PENDING_CAP}`);
  need(D.s.pending.length <= PENDING_CAP, `挂机余留 ${D.s.pending.length} 条 > 上限`);
  need(D.s.overflowed > 0, '挂机一整局一条都没溢出 —— 「默认结算」这条规则没被走到');
  need(D.s.decisions === 0, `挂机路径不该有主动决策，却记了 ${D.s.decisions} 次`);
  return `溢出 ${D.s.overflowed} 条 · 余留 ${D.s.pending.length} 条`;
});

probe('default 一律是保守项（保住现金、不换乘数）', () => {
  for (const e of EVENTS) {
    need(e.options.length >= 2, `「${e.id}」选项不足 2 个`);
    need(e.default === 0, `「${e.id}」default=${e.default}（应统一取下标 0）`);
    const eff = e.options[e.default].eff;
    need(eff.cash > 0, `「${e.id}」默认项不含正现金（挂机会变穷）`);
    need(Object.keys(eff).length === 1, `「${e.id}」默认项除 cash 外还动了 ${Object.keys(eff).slice(1)}`);
  }
  return `${EVENTS.length} 条全部以保守项收尾`;
});

probe('每章事件池恒为 16 条（8 通用 + 8 专属）', () => {
  const generic = EVENTS.filter(e => e.stage === 0).length;
  need(generic === 8, `通用事件 ${generic} 条`);
  for (let a = 1; a <= 8; a++) {
    const pool = eventsFor(a);
    const own = pool.filter(e => e.stage === a).length;
    need(pool.length === 16, `第 ${a} 章池子 ${pool.length} 条`);
    need(own === 8, `第 ${a} 章专属 ${own} 条`);
    need(pool.every(e => eventById(e.id) === e), `第 ${a} 章有 id 对不上的事件`);
  }
  return `${ACTS.length - 1} 章 × 16 条`;
});

probe('选项效果只落在五个变量上', () => {
  const OK = new Set(['cash', 'prod', 'share', 'team', 'pe']);
  for (const e of EVENTS) {
    for (const o of e.options) {
      for (const k of Object.keys(o.eff || {})) need(OK.has(k), `「${e.id}」动了 ${k}（不在这五个变量里）`);
    }
  }
  return `${EVENTS.length} 条 × ${EVENTS[0].options.length} 项`;
});

probe('在线不弹窗：待决长在主界面，overlay 保持干净', () => {
  const s = midState(2, 20);
  need(s.pending.length > 0, '中期存档居然没有待决事件');
  lookTab(s, TAB_COMPANY);                        // 待决卡片长在「公司」页
  need(root.innerHTML.includes('class="pending"'), '主界面没有待决区');
  const opts = buttonsIn(root.innerHTML).filter(b => b.data.opt !== undefined);
  need(opts.length === 2, `主界面待决选项 ${opts.length} 个`);
  need(visible(root.innerHTML).includes(`/ ${PENDING_CAP} 条`), '待决角标没写「/ N 条」');
  need(overlay.innerHTML === '', '在线时不该有弹窗内容');
  return '角标 + 主界面选项';
});

probe('结算一条待决：uid 对不上返回 false（界面拿的是过期节点）', () => {
  const s = midState(2, 20);
  const uid = s.pending[0].uid;
  need(resolvePending(s, uid + 999, 0, rates(s)) === false, '过期 uid 竟然结算成功了');
  need(s.pending.length > 0, '过期 uid 把队列改了');
  const cash0 = s.money;
  need(resolvePending(s, uid, 0, rates(s)) === true, '有效 uid 结算失败');
  need(s.money > cash0, '保守项没给现金');
  need(s.decisions === 1, '决策计数没涨');
  return '过期 uid 被正确拒绝';
});

probe('效果落点：cash 按年营收缩放，三个乘数进 mod，pe 是加法', () => {
  const s = midState(2, 20);
  const R = rates(s);
  const m0 = s.money;
  applyEffect(s, { cash: 0.5 }, R);
  need(Math.abs(s.money - (m0 + R.revenue * 0.5)) < 1e-3, 'cash 没有按年营收缩放');
  const p0 = s.mod.prod;
  applyEffect(s, { prod: 1.5, share: 1.5, team: 1.5 }, R);
  need(Math.abs(s.mod.prod - p0 * 1.5) < 1e-12 && s.mod.share === 1.5 && s.mod.team === 1.5, '乘数没有累乘');
  const pe0 = s.mod.pe;
  applyEffect(s, { pe: 3 }, R);
  need(s.mod.pe === pe0 + 3, 'pe 不是加法');
  applyEffect(s, { cash: -1e9 }, R);
  need(s.money === 0, '现金被扣成负数（本作不许负资产）');
  return 'cash 缩放 / 乘数累乘 / pe 加法';
});

probe('全作零 Math.random', () => {
  const hits = SRC.filter(f => f.code.includes('Math.random')).map(f => f.rel);
  need(!hits.length, `出现随机数：${hits.join('、')}`);
  return `${SRC.length} 个文件全干净`;
});

probe('同一策略两次真跑逐位一致（事件按序轮转，不随机）', () => {
  const again = play('best');
  need(again.s.ending === A.s.ending, `结局不一致：${again.s.ending} vs ${A.s.ending}`);
  need(again.seconds === A.seconds, `收尾时刻不一致：${again.seconds} vs ${A.seconds}`);
  need(JSON.stringify(again.s.lines) === JSON.stringify(A.s.lines),
    `三条线等级不一致：${JSON.stringify(again.s.lines)} vs ${JSON.stringify(A.s.lines)}`);
  need(again.s.decisions === A.s.decisions,
    `决策次数不一致：${again.s.decisions} vs ${A.s.decisions}`);
  need(again.s.seen.join(',') === A.s.seen.join(','), '抽到的事件序列不一致');
  return `${A.seconds}s / Lv${A.s.lines.r}`;
});

// ═══════════════════════════ §1.6 自动购买 · 唯一结局 ═══════════════════════════

probe('自动购买：现金够就买「等级最低」那条线，均衡自动维持', () => {
  const s = createState();
  s.money = 0;
  tick(s, 0);
  need(lineLevel(s, 'r') === 0 && s.money === 0, '没钱也买了');
  // 给一笔够买十几次的钱，跑一小步（dt 足够短，只触发自动购买）
  // ⚠️ 闸门是「可动用现金 = 现金 × (1 − RESERVE_FRAC)」，所以放的是**现金**：
  //    要 20 份可动用就得放 `20 / (1 − RESERVE_FRAC)` 份 —— rf=0.80 下是 100 份成本。
  //    （旧版是「年营收 × 0.25」的储备金，与 `LINE_COST0` 无关，只按 costOf(0) 给钱
  //      会在 `LINE_COST0` 调小时突然翻红；现金基数没有这个耦合。）
  s.money = costOf(0) * 20 / (1 - RESERVE_FRAC);
  tick(s, 0.001);
  const lv = LINE_IDS.map(id => lineLevel(s, id));
  need(Math.max(...lv) - Math.min(...lv) <= 1, `自动购买后五线不再均衡：${lv.join('/')}`);
  need(Math.min(...lv) >= 2, `只买了 ${lv.join('/')}，一次 tick 的购买次数太少`);
  return `${lv.join('/')}（极差 ≤1）`;
});

probe('手动 = 满配、自动 = 打折版（同一条闸门，手动付 MANUAL_PAY 份钱换 MANUAL_GAIN 级）', () => {
  const s = midState(2, 20);
  s.money = 0;
  const want = lowestLine(s);
  const cost = costFor(s, want);
  // 「买的正是最便宜那条」= 五线共用 cost(n) 的直接推论
  const costs = LINE_IDS.map(id => costFor(s, id));
  need(cost === Math.min(...costs), '最低等级那条不是最便宜的 —— 五线 cost 不再共用');

  // ① 手动：付 `MANUAL_PAY` 份原价、涨 `MANUAL_GAIN` 级（界面印的价必须与真扣款同源）
  // ⚠️ 账上要放够「**可动用**那笔钱」：可动用 = 现金 × (1 − RESERVE_FRAC)，
  //    所以现金得是 `pay / (1 − F)`（储备是现金的函数，不是外加的一笔）。
  const pay = manualCostOf(s, want);
  need(Math.abs(pay - cost * MANUAL_PAY) < 1e-9, 'manualCostOf 与 cost × MANUAL_PAY 不一致');
  const money0 = pay / (1 - RESERVE_FRAC);
  s.money = money0;
  need(canAffordManual(s, want) === true, '钱刚够，按钮却是灭的');
  const lvManual = lineLevel(s, want);
  need(manualBuy(s, want) === true, '手动购买失败');
  need(lineLevel(s, want) === lvManual + MANUAL_GAIN, `手动只涨了 ${lineLevel(s, want) - lvManual} 级`);
  need(Math.abs(s.money - (money0 - pay)) < 1e-9, '手动扣款不是 MANUAL_PAY 份的钱');
  need(MANUAL_GAIN / MANUAL_PAY < 2, `手动钱效率 ${(MANUAL_GAIN / MANUAL_PAY).toFixed(2)} 级/份 —— 快过 3h 的根源`);

  // ② 自动：一级的原价，一次一级
  const id2 = lowestLine(s);
  const cost2 = costFor(s, id2);
  const money1 = cost2 / (1 - RESERVE_FRAC);
  s.money = money1;
  const lvAuto = lineLevel(s, id2);
  need(purchase(s, id2) === true, '自动购买失败');
  need(lineLevel(s, id2) === lvAuto + 1, '自动不是一次一级');
  need(Math.abs(s.money - (money1 - cost2)) < 1e-9, '自动扣款不对');
  need(MANUAL_GAIN > 1, `MANUAL_GAIN = ${MANUAL_GAIN} —— 手动没有分量`);
  need(MANUAL_PAY < MANUAL_GAIN, `MANUAL_PAY = ${MANUAL_PAY} —— 手动比原价买两级还贵，等于没有分量`);
  need(MANUAL_PAY > 1, `MANUAL_PAY = ${MANUAL_PAY} —— 退化成「买一送一」，一局只要 1.49h`);

  // ③ 让路：自动的动手门槛是「K 份钱」—— 没有它，手动永远点不动。
  //    ⚠️ 门槛是**两档**的（用户 2026-09-27「融资前只能玩家自己点击」）：融资前
  //       `AUTO_BUY_RESERVE_EARLY`、天使轮到账后 `AUTO_BUY_RESERVE`。断言必须走
  //       **同一个选择器**，否则量的是另一套规则。
  need(AUTO_BUY_RESERVE >= 2, `AUTO_BUY_RESERVE = ${AUTO_BUY_RESERVE} —— 没有给手动留窗口`);
  need(AUTO_BUY_RESERVE_EARLY > AUTO_BUY_RESERVE,
    `融资前 ${AUTO_BUY_RESERVE_EARLY} ≤ 融资后 ${AUTO_BUY_RESERVE} —— 「融资前玩家自己点」这句感觉不到`);
  const s2 = createState();
  s2.stage = 2; s2.money = 0;
  // `createState()` 的 `finance.rounds` 是空的 ⇒ 走的正是「融资前」那一档
  const kEarly = autoBuyReserveOf(s2);
  need(kEarly === AUTO_BUY_RESERVE_EARLY, '没融资却拿到了「融资后」的门槛');
  const idm = lowestLine(s2);
  const c0 = costFor(s2, idm);
  // 只放「`kEarly − 0.5` 份**可动用**的钱」：不够自动动手 ⇒ 这一段窗口留给了玩家
  const moneyEarly = c0 * (kEarly - 0.5) / (1 - RESERVE_FRAC);
  s2.money = moneyEarly;
  tick(s2, 0);
  need(s2.money >= moneyEarly - 1e-9, `自动把 ${kEarly - 0.5} 份钱花掉了 —— 手动窗口不存在`);
  // 天使轮到账 ⇒ 门槛回到自动化那一档（这里正是「融资前 / 融资后」的分界）
  const s3 = createState();
  s3.finance.rounds.push('angel');
  need(autoBuyReserveOf(s3) === AUTO_BUY_RESERVE, '融资到账后门槛没有回到融资后那一档');
  return `手动 +${MANUAL_GAIN} 级 / 自动 +1 级，让路储备 融资前 ${kEarly} 份 · 融资后 ${AUTO_BUY_RESERVE} 份`;
});

probe('唯一结局「登顶」：worldRank === 1 且无第二条结局', () => {
  need(Object.keys(ENDING_TEXT).length === 1 && ENDING_TEXT.top, `结局文案有 ${Object.keys(ENDING_TEXT).length} 条`);
  /**
   * 判据只有一个来源：`s.worldRank`。`engine.tick` 用它**自动**触发结局；
   * 「退休」横条走 `evaluateRetirement()` 读同一个字段 —— 两处不会打架，也不会出现
   * 「按钮说第一、世界榜说第二」。这里把那个函数的三条边界钉死。
   */
  need(evaluateRetirement({ worldRank: 1 }).ending === 'top', 'evaluateRetirement 对第 1 名没给出结局');
  need(evaluateRetirement({ worldRank: 2 }).ending === null, 'evaluateRetirement 对第 2 名也给了结局');
  need(evaluateRetirement({}).rank === null, 'worldRank 还没算出来时 rank 不是 null');
  need(A.s.ending === 'top', `真跑一局没有走到结局（ending=${A.s.ending ?? 'null'}）`);
  need(A.s.worldRank === 1, `结局时 worldRank=${A.s.worldRank}`);
  return '唯一结局可复现 · 退休入口只读 worldRank';
});

probe('阶段推进：唯一机械闸门是「市值 ≥ 本章 mcap」', () => {
  for (let a = 1; a <= 7; a++) {
    need(ACTS[a + 1].mcap > ACTS[a].mcap, `第 ${a} 章门槛没有严格递增`);
  }
  need(ACTS[1].mcap > START_MCAP, '第 1 章门槛低于开局市值 —— 一开局就会推进');
  need(IPO_LINE > ACTS[6].mcap && IPO_LINE < ACTS[7].mcap,
    `IPO_LINE=${IPO_LINE.toExponential(2)} 不在第 7 章区间 (${ACTS[6].mcap.toExponential(2)}, ${ACTS[7].mcap.toExponential(2)}) 内`);
  const s = midState(1, 0);
  need(s.stage === 1, '开局章次不是 1');
  need(!stageGoalMet(s, rates(s), derived(s)) || true, '目标判定不该抛错');
  return `${START_MCAP.toExponential(2)} → ${ACTS[8].mcap.toExponential(2)}（8 档）`;
});

probe('上市时点：第 7 章中段敲钟（不再与 A 轮挤在同一幕）', () => {
  // 七轮的年份必须落在**各自那一章**的区间里，否则会出现「先上市、后到账」
  const wantChapter = { angel: 2, preA: 2, a: 4, b: 4, c: 5, preIpo: 6 };
  for (const r of ROUNDS) {
    if (r.id === 'ipo') { need(r.year === null, 'IPO 不该看年份（它看市值）'); continue; }
    const ch = wantChapter[r.id];
    const [a0, a1] = /(\d{4})–(\d{4})/.exec(ACTS[ch].years).slice(1).map(Number);
    need(r.year >= a0 && r.year <= a1, `${r.name}（${r.year}）不在第 ${ch} 章区间 ${a0}–${a1} 内`);
  }
  // 「A 轮」与「IPO」必须**不在同一章** —— 这正是八章拆分要解决的那件事
  need(wantChapter.a !== 7, 'A 轮与 IPO 又挤回同一章了');
  // 端到端：市值越过 IPO_LINE 那一 tick 必须敲钟，且**仍停在第 7 章**（后面还有半章 + 第 8 章）
  // ⚠️ 等级不能硬编码（`IPO_LINE` 会随标定移动）—— 搜出「刚够上线」的那个 L。
  const s = createState();
  s.stage = 7;
  let L = 0;
  while (L < 400 && derived(s).marketCap < IPO_LINE) { L += 1; s.lines = bal(L); }
  tick(s, 0);
  need(isListed(s), `市值 ¥${(derived(s).marketCap).toExponential(3)} 越过上线却没敲钟`);
  need(s.stage === 7, `敲钟应发生在第 7 章之内（实得第 ${s.stage} 章）`);
  need(s.log.some(t => t.includes(companyName(true))), '敲钟没有改名日志');
  return `IPO 落在第 7 章：${IPO_LINE.toExponential(2)} ∈ (${ACTS[6].mcap.toExponential(2)}, ${ACTS[7].mcap.toExponential(2)})`;
});

probe('阶段目标：前七条都在**本章之内**被打勾，第八条 = 结局', () => {
  const { s, marks } = A;
  const out = [];
  for (let a = 1; a <= 7; a++) {
    const m = marks[a];
    need(m, `第 ${a} 章整章没被观察到`);
    need(m.hit !== undefined, `第 ${a} 章目标「${ACTS[a].goal}」整章都没打勾 —— 这是句假话`);
    need(m.hit > m.first, `第 ${a} 章目标「${ACTS[a].goal}」一进章就已经成立（${m.first}s 就为真）`);
    out.push(`${(100 * (m.hit - m.first) / Math.max(1, m.last - m.first)).toFixed(0)}%`);
  }
  const m8 = marks[8];
  need(m8 && m8.hit !== undefined, '第 8 章目标（登顶）整章没打勾');
  need(s.ending === 'top', `真跑一局没走到结局（ending=${s.ending ?? 'null'}）`);
  return `章内跨过位置 ${out.join(' / ')} · 第 8 章 = 结局`;
});

probe('赛道份额：以外生行业盘子 TAM(year) 为分母，从 0% 单调升到约 60%', () => {
  need(TAM_GROWTH > 1, `TAM_GROWTH=${TAM_GROWTH} ≤ 1`);
  // 开局：用户 2026-09-26 报过「一开始怎么可能份额有 40%」—— 必须就是「还没有份额」
  const open = sharePctOf(START_MCAP / PE_BASE[1], startYearOf(1));
  need(open < 1, `开局份额就有 ${open.toFixed(2)}% —— 又回到「一开始就有份额」的老毛病`);
  let prev = -1;
  for (let a = 1; a <= 8; a++) {
    const p = sharePctOf(ACTS[a].mcap / PE_BASE[a], startYearOf(a));
    need(p >= 0, `第 ${a} 章起份额为负：${p}`);
    need(p > prev, `第 ${a} 章起份额没有比上一章高（${p.toFixed(3)}% ≤ ${prev.toFixed(3)}%）`);
    prev = p;
  }
  // 终局（第 8 章末、2066 年）：用户 2026-09-27 要的「结局在 50% 左右」⇒ 55%–65%
  const endYear = Number(/(\d{4})\s*$/.exec(ACTS[8].years)[1]);
  const end = sharePctOf(ACTS[8].mcap / PE_BASE[8], endYear);
  need(end >= 55 && end <= 65, `终局份额 ${end.toFixed(1)}% —— 应在 55%–65%（赛道口径）`);
  return `开局 ${open.toFixed(3)}% → 终局 ${end.toFixed(1)}%（全程单调）`;
});

probe('投资线的份额渲染：八章全程都不越过 60%（修掉「饱和到 99%」）', () => {
  const out = [];
  for (let a = 1; a <= 8; a++) {
    const s = midState(a, a * 4);
    lookTab(s, TAB_FOUNDER);                    // 「份额」那一行在「创始人」页（投营销）
    const m = /赛道份额 ([\d.]+)%/.exec(visible(root.innerHTML));
    need(m, `第 ${a} 章投资线没显示份额百分比`);
    const p = Number(m[1]);
    need(p >= 0 && p <= 60 + 1e-9, `第 ${a} 章份额 ${p}% 越界`);
    out.push(p.toFixed(0));
  }
  setTab(0);
  return `1–8 章：${out.join('% / ')}%`;
});

probe('事件增强：选项按钮带效果数字；第 AUTO_DECIDE_STAGE 幕起不再打扰玩家', () => {
  // ① 数字：文案讲故事，数字讲代价
  const s = midState(3, 30);
  s.pending.length = 0;
  s.pending.push({ uid: 1, id: 'e31' });
  lookTab(s, TAB_COMPANY);
  const html = root.innerHTML;
  need(/<em class="eff">/.test(html), '事件选项上没有效果数字');
  need(visible(html).includes('现金 +3.0% 年营收'), `选项没写出现金代价：${visible(html).slice(0, 120)}`);
  need(visible(html).includes('产品力 ×1.015'), '选项没有写出乘数代价');

  // ② 自动化：后期幕的年度事件直接按保守项结算，不进待决队列（前期仍交给玩家）
  const early = midState(AUTO_DECIDE_STAGE - 1, 40);
  early.pending.length = 0;
  early.lastYear = 0;                 // 逼出一次年报
  tick(early, 0);
  need(early.pending.length === 1, `第 ${AUTO_DECIDE_STAGE - 1} 幕的年度事件没交给玩家（积压 ${early.pending.length}）`);

  const late = midState(AUTO_DECIDE_STAGE, 40);
  late.pending.length = 0;
  late.lastYear = 0;
  const dec = late.decisions;
  tick(late, 0);
  need(late.pending.length === 0, `第 ${AUTO_DECIDE_STAGE} 幕起仍把年度事件推给玩家（积压 ${late.pending.length}）`);
  need(late.decisions === dec, '自动化档不该增加玩家的决策数');
  return `选项带数字 · 第 ${AUTO_DECIDE_STAGE} 幕起自动按默认结算`;
});

probe('世界榜降噪：持平不画符号（一屏「─」是纯噪声）', () => {
  const src = srcOf('src/ui/render.js');
  need(!/class="flat"/.test(src), 'render.js 里还留着持平的「─」符号');
  need(!/flat/.test(src), 'render.js 里还留着 flat 的残留引用');
  return '持平行留空';
});

// ═══════════════════════════ 进度钟 / 世界同步 ═══════════════════════════

probe('进度钟：日历与年份都由市值派生（玩得快走得快）', () => {
  const slow = createState();
  tick(slow, 0);
  const fast = createState();
  fast.lines = bal(60);
  tick(fast, 0);
  need(gameMonths(slow) === 0, `开局应停在第 0 月，实得 ${gameMonths(slow)}`);
  need(gameMonths(fast) > 0, '市值更高却没有推进日历');
  need(fast.world.month === gameMonths(fast), `世界月 ${fast.world.month} 与日历 ${gameMonths(fast)} 不同步`);
  need(gameYear(fast) > gameYear(slow), '年份没有跟着市值走');
  need(gameDate(slow).includes('2026'), `开局日期是 ${gameDate(slow)}`);
  return `0 月 → ${gameMonths(fast)} 月（${gameDate(fast)}）`;
});

probe('进度钟单调不倒退（跨幕边界也不回跳）', () => {
  const months = [];
  const s = createState();
  s.lines = bal(0);
  for (let lv = 0; lv <= 200; lv += 2) {
    s.lines = bal(lv);
    months.push(calMonthOf(s, derived(s)));
  }
  for (let i = 1; i < months.length; i++) {
    need(months[i] >= months[i - 1] - 1e-9, `第 ${i} 个采样点日历倒退了（${months[i - 1]} → ${months[i]}）`);
  }
  need(months[months.length - 1] > 300, '满级也没有把日历推到最后 —— 锚点表可能断了');
  return `${months.length} 个采样点全程单调`;
});

probe('ACT_MONTHS 与 ACTS[].years 一致，且首尾相接铺满 480 月', () => {
  // 八章的年份跨度**不相等**（4/4/5/5/5/5/6/6 年）—— 所以这里只守「首尾相接 + 总长」，
  // 不守旧版那条「每章整 60 月」（它在八章下是假的）。
  need(ACT_MONTHS[1][0] === 0, `首章起点应为第 0 月（实得 ${ACT_MONTHS[1][0]}）`);
  for (let a = 1; a <= 8; a++) {
    const [m0, m1] = ACT_MONTHS[a];
    need(m1 - m0 >= 48 && m1 - m0 <= 72, `第 ${a} 章跨度 ${m1 - m0} 月（应在 48–72 之间）`);
    if (a > 1) need(ACT_MONTHS[a][0] === ACT_MONTHS[a - 1][1], `第 ${a} 章与前一章不相接`);
  }
  need(ACT_MONTHS[8][1] === MONTHS_TOTAL, `末值 ${ACT_MONTHS[8][1]} ≠ ${MONTHS_TOTAL}`);
  need(MONTHS_TOTAL === 480, `MONTHS_TOTAL=${MONTHS_TOTAL}（40 周年 = 480 月）`);
  need(TOTAL_YEARS === 40, `TOTAL_YEARS=${TOTAL_YEARS}`);
  need(NARRATIVE_YEARS === TOTAL_YEARS, '曲线目标里的叙事跨度与 format 不一致');
  return `2026–2066 逐章相接（末月 ${MONTHS_TOTAL}）`;
});

// ═══════════════════════════ §1.4 宏观周期（一局 4 段低谷）═══════════════════════════

/**
 * 这两条探针是「低调谷能不能被看见」的可断言形态（用户 2026-09-27）。
 *
 * ⚠️ 曾经的写法（`valAt = 1 + A·sin`）**永远红**，原因写在 content.js 的周期注释里：
 *    阶梯规定了月增速最低 +2.55%（第 1 章），而正弦的月跌幅上限只有 1.35% ⇒ 环比永不为负。
 *    现在形状换成锯齿（同一 ±25% 的带，压缩到 3 个月里释放），低谷才真的出现。
 */
probe('低谷可见：一局正好 4 段 ≥5% 的低谷', () => {
  const pts = A.caps;
  need(pts.length > 1000, `只采到 ${pts.length} 个 tick（一局没走完）`);
  /**
   * 低谷 = 「从上一处高点跌掉 `DIP_MIN` 以上、再创新高才算收口」的那一段。
   *
   * 为什么要**收口**而不是数「环比为负」：市值是 `阶梯 × valAt`，两者的月增速都只有百分之几，
   * 一个 tick 里的浮点抖动也算「环比为负」；而真实低谷的深度是 7% 量级。
   * 用 2% 的起步门槛把抖动滤掉（断言仍按 5%）⇒ 段数才是「玩家看得见的低谷」的条数。
   * ⚠️ 门槛不能取到 5% 以上：那就与下面的 `worst >= 0.05` 同义，断言变成自证。
   */
  const DIP_MIN = 0.02;
  const dips = [];
  let peak = null;
  let dip = null;
  for (const p of pts) {
    if (!peak || p.v >= peak.v) { if (dip) { dips.push(dip); dip = null; } peak = p; continue; }
    if (dip) { dip.to = p.m; if (p.v < dip.low.v) dip.low = p; continue; }
    if (1 - p.v / peak.v >= DIP_MIN) dip = { from: p.m, to: p.m, peak, low: p };
  }
  if (dip) dips.push(dip);
  const depth = g => 1 - g.low.v / g.peak.v;
  const show = g => `第 ${g.peak.m}→${g.low.m} 月 −${(depth(g) * 100).toFixed(1)}%`
    + `（rev ${(g.peak.rev / 1e8).toFixed(0)}→${(g.low.rev / 1e8).toFixed(0)}亿 ·`
    + ` val ${g.peak.va.toFixed(3)}→${g.low.va.toFixed(3)} · pe ${g.peak.pe}→${g.low.pe}）`;
  /**
   * ⚠️ 数的是 **≥5%** 的段，不是全部候选段：成本寒冬最深的那个月恰好压在缓跌段上时，
   *    自动购买会停摆几个月（`cost` 涨得比现金快）⇒ rev 持平而 `valAt` 仍在跌，
   *    于是多出一段 **2–3% 的浅坑**（实测第 341→346 月 −2.7%）。它是真实的、也是想要的
   *    （寒冬就该咬人），只是不是设计意义上的「一段低谷」——「一段低谷」的判据是 ≥5%。
   */
  const visible = dips.filter(g => depth(g) >= 0.05);
  need(visible.length === 4,
    `≥5% 的低谷 ${visible.length} 段（一局应为 4 段）—— 周期长度或市值阶梯动过。全部候选段：\n      `
    + dips.map(show).join('\n      '));
  return visible.map(show).join(' ｜ ')
    + (dips.length > visible.length ? `（另 ${dips.length - visible.length} 段浅坑 <5%）` : '');
});

probe('周期两端锚点不被污染：valAt(0)=valAt(480)=1、winterAt(0)=winterAt(480)=1、均值 0', () => {
  // 终局锚点：`ACTS[8].mcap` 是 `tune` 钉在「第 480 月世界榜首」上的，那一点两个乘数必须是 1
  need(Math.abs(valAt(0) - 1) < 1e-12 && Math.abs(valAt(MONTHS_TOTAL) - 1) < 1e-12,
    `valAt 端点不是 1（${valAt(0)} / ${valAt(MONTHS_TOTAL)}）—— 整条市值阶梯都要乘系数`);
  // 起点锚点：`costOf(n)` 的默认月是 0，探针与工具里那些老调用点全靠冬天乘数为 1
  need(Math.abs(winterAt(0) - 1) < 1e-12 && Math.abs(winterAt(MONTHS_TOTAL) - 1) < 1e-12,
    `winterAt 端点不是 1（${winterAt(0)} / ${winterAt(MONTHS_TOTAL)}）—— costOf(n) 的默认月不再等于基准价`);
  // 值域与均值：带是 ±25% ／ ∓30%，全程均值为 1（因为 480 恰好是 4 个整周期）
  // ⚠️ 取**整数月**：锯齿的顶点在 `u = CYCLE_RISE = 57`、谷底在 `u = 117`，都是整数月；
  //    取半月会永远差一点（量到 0.9912 而不是 1）。整数采样同时让均值精确为 0（两段三角配平）。
  let sum = 0, lo = Infinity, hi = -Infinity;
  for (let m = 0; m < MONTHS_TOTAL; m++) {
    const w = cycleAt(m);
    sum += w; lo = Math.min(lo, w); hi = Math.max(hi, w);
  }
  need(Math.abs(sum / MONTHS_TOTAL) < 1e-9, `cycleAt 全程均值 ${sum / MONTHS_TOTAL}（应为 0 —— 否则全程总产出被周期整体抬高或压低）`);
  need(Math.abs(lo + 1) < 1e-12 && Math.abs(hi - 1) < 1e-12, `cycleAt 值域 [${lo}, ${hi}]（应为 [−1, +1]）`);
  need(MONTHS_TOTAL / CYCLE_MONTHS === 4, `${MONTHS_TOTAL} ÷ ${CYCLE_MONTHS} ≠ 4 —— 一局不再正好 4 段`);
  need(Math.max(VAL_CYCLE_AMP, COST_CYCLE_AMP) <= 0.35,
    `幅度 ${VAL_CYCLE_AMP}/${COST_CYCLE_AMP} 超出「温和」档 —— 一局会被周期推出 [3,6]h`);
  return `估值 ±${VAL_CYCLE_AMP * 100}% ／ 成本 ∓${COST_CYCLE_AMP * 100}% ｜ 一局 ${MONTHS_TOTAL / CYCLE_MONTHS} 个整周期`;
});

/**
 * 用户 2026-09-27 报的「年营收 3.30 万亿、现金储备只有几百亿」= 这条恒等式取旧值 rf=0.25 的结果。
 * ```
 * 现金 / 年营收 ∈ [ K/(1−rf) − 1 , K/(1−rf) ] / (年营收/cost)
 * ```
 * `K = autoBuyReserveOf`（融资后 2），`年营收/cost = 41.02`（`LINE_COST0 = 8777`）⇒ rf=0.25 给 **4.1%–6.5%**
 * （比现实里最低的 SS&C 7.4% 还低），rf=0.80 给 **21.9%–24.4%**（Micron 25.7% 与 Microsoft 33.6% 之间）。
 *
 * ⚠️ 口径要**先除掉 `winterAt(月)`**：锯齿上沿是 `K × cost(月)`，而 `cost` 里带着成本寒冬 ⇒
 *    终局若落在寒冬月，原值会被 ±30% 推出带外 —— 那是周期噪声，不是模型错。
 *    除掉之后剩下的才是 `K/((1−rf)×41.02)` 这个纯常数带。
 */
probe('终局 现金/年营收 ∈ [0.20, 0.32]（先除掉成本寒冬的乘数）', () => {
  const s = A.s;
  const month = gameMonths(s);
  const R = rates(s);
  const ratio = s.money / winterAt(month) / R.revenue;
  need(ratio >= 0.20 && ratio <= 0.32,
    `终局 现金/年营收 = ${(ratio * 100).toFixed(1)}%（应落在 20%–32%）—— 就是用户报的「年营收几万亿、储备才几百亿」那一项`);
  return `${(ratio * 100).toFixed(1)}%（现金 ¥${fmt(s.money)} ／ 年营收 ¥${fmt(R.revenue)} · 第 ${month} 月 · 乘数 ${winterAt(month).toFixed(3)}）`;
});

probe('世界榜由玩家进度驱动（世界与日历同一真相源）', () => {
  const s = createState();
  s.lines = bal(40);
  tick(s, 0);
  const m = gameMonths(s);
  need(s.world.month === m, `世界推进到 ${s.world.month} 月，日历却是 ${m} 月`);
  const [y, mo] = worldDate(s.world);
  need(y >= 2026 && mo >= 1 && mo <= 12, `世界日期非法：${y}-${mo}`);
  // 旧档回拉：世界跑到前面时必须被拉回来（而不是永久卡住，把玩家甩开）
  s.world = createWorld('B');
  advanceWorld(s.world, m + 120);
  const ahead = s.world.month;
  tick(s, 0);
  need(s.world.month < ahead, `跑在前面的世界没有被拉回（停在 ${s.world.month} 月）`);
  need(s.world.month === gameMonths(s), `拉回后世界月 ${s.world.month} ≠ 日历 ${gameMonths(s)}`);
  return `世界月 = 日历月 = ${m}（曾跑到 ${ahead}）`;
});

probe('市值榜三层周期都写进日志：大盘峰谷 / 行业轮动 / 黑天鹅', () => {
  /**
   * 用户 2026-09-27：「市值榜的周期要有日志或者事件显示」。
   * 三层周期原本是**看不见的**（名次在动，但不知道为什么动），`cycleNotes()` 把它们写成人话。
   * 这里验三件事：① 幂等（同一区间跑两次逐字一致）；② 三种标签都真的会出现；
   * ③ **回拉分支不重播** —— 那是「重建 + 推进到 target」，在那里播报会把整局重放一遍。
   */
  const w = createWorld('B');
  advanceWorld(w, 480);
  const once = cycleNotes(0, 480, w);
  need(cycleNotes(0, 480, w).join('|') === once.join('|'), 'cycleNotes 不幂等（同区间两次结果不同）');
  const has = tag => once.some(t => t.startsWith(tag));
  need(has('【大盘】'), '一整局都没有大盘（泡沫峰谷 / AI 回撤）的播报');
  need(has('【轮动】'), '一整局都没有行业轮动的播报');
  need(has('【黑天鹅】'), '一整局都没有黑天鹅的播报');
  need(once.filter(t => t.startsWith('【黑天鹅】')).length <= 480, '黑天鹅播报条数超过月数（没有做到每月最多一条）');
  // 空区间 / 倒序区间都必须给空数组，否则回拉时会凭空多出几行
  need(cycleNotes(480, 480, w).length === 0, '空区间竟然有播报');
  need(cycleNotes(200, 100, w).length === 0, '倒序区间竟然有播报');
  // 回拉分支不重播：跑一次 tick 把世界推到 target，日志里周期条数应当等于 cycleNotes 的长度
  const s = createState();
  s.lines = bal(60);
  tick(s, 0);
  advanceWorld(s.world, gameMonths(s) + 240);        // 恶意把世界推到很前面
  tick(s, 0);                                        // 触发回拉
  const cyc = s.log.filter(t => /^【(大盘|轮动|黑天鹅)】/.test(t)).length;
  need(cyc < 60, `回拉分支把周期事件重播了（日志里 ${cyc} 条周期播报）`);
  return `${once.length} 条 · 大盘/轮动/黑天鹅齐 · 回拉不重播`;
});

probe('周期播报一局内每句最多一次（文案池按「第几条」轮取、不抽）', () => {
  /**
   * 用户 2026-09-27：「有些事件出现的描述太重复了……确保只保证一局最多重复两次或者一次」。
   * 改前：AI 回撤 5 条全同 / 泡沫见顶 4 条全同 / 泡沫见底 3 条全同 / 轮动 5 条全同 /
   *       黑天鹅 10 条只有 2 种句式（涨跌各一句，撞 6 / 4 次）。
   * 这条断言把「一局内每句都只出现一次」钉死 —— 以后谁把文案池改小到小于一局的条数，
   * 或把「轮取」改回「抽」，这里立刻红。
   */
  const w = createWorld('B');
  advanceWorld(w, 480);
  const once = cycleNotes(0, 480, w);
  const cat = t => (t.match(/^【([^】]+)】/) || [, '?'])[1];
  const groups = {};
  for (const t of once) (groups[cat(t)] ||= []).push(t);
  for (const [k, arr] of Object.entries(groups)) {
    const dup = arr.length - new Set(arr).size;
    need(dup === 0, `【${k}】${arr.length} 条里有 ${dup} 条重复：${arr.find((x, i) => arr.indexOf(x) !== i)}`);
  }
  // 池子真被跑起来：黑天鹅（一局 ~15 条）与轮动（一局 6 条）都得报够
  need(groups['黑天鹅'].length >= 6, `黑天鹅一局只报了 ${groups['黑天鹅'].length} 条`);
  const rot = groups['轮动'];
  need(rot.length >= 5, `轮动一局只报了 ${rot.length} 条`);
  // 轮动不能全报同一个行业（旧节律按 96 月采样，相位与轮次无关 ⇒ 5/5 全是「太空 / 新范式」）
  const sectors = new Set(rot.map(t => t.split(' —— ')[0]));
  need(sectors.size === rot.length, `轮动 ${rot.length} 条只落在 ${sectors.size} 个行业上：${[...sectors].join(' / ')}`);
  // 黑天鹅涨跌两个池子都要够一局用（最坏情况全压在一个方向上）
  const swans = groups['黑天鹅'];
  need(swans.filter(t => t.includes('暴涨')).length <= 12, '黑天鹅上涨条数超出上涨池（12 条）');
  need(swans.filter(t => t.includes('重挫')).length <= 12, '黑天鹅下跌条数超出下跌池（12 条）');
  const [bl, rl] = [groups['大盘'].length, rot.length];
  return `${once.length} 条全不重复 · 大盘 ${bl} · 轮动 ${rl}（${sectors.size} 个行业）· 黑天鹅 ${swans.length}`;
});

// ═══════════════════════════ §1.7 离线结算 ═══════════════════════════

probe('离线：等效游戏时间 = 真实秒 × 0.15，封顶 8 小时', () => {
  need(OFFLINE_CAP_SEC === 8 * 3600, `OFFLINE_CAP_SEC=${OFFLINE_CAP_SEC}`);
  need(Math.abs(OFFLINE_MODIFIER - 0.15) < 1e-12, `OFFLINE_MODIFIER=${OFFLINE_MODIFIER}`);
  const s = createState();
  const t0 = s.savedAt;
  const off = applyOffline(s, t0 + 24 * 3600 * 1000);
  need(off.capped === OFFLINE_CAP_SEC, `封顶后 ${off.capped}s`);
  need(off.cappedOut === true, '超过 8 小时没有标记 cappedOut');
  need(Math.abs(off.equiv - OFFLINE_CAP_SEC * OFFLINE_MODIFIER) < 1e-9, `等效 ${off.equiv}s`);
  need(off.equiv / (TARGET_TOTAL_H * 3600) <= 0.26, '封顶离线拿到了超过全程 26% 的进度');
  return `24h → 等效 ${(off.equiv / 60).toFixed(1)} 分`;
});

probe('离线：真实秒入 elapsed（倍速不放大），nowMs 是注入参数', () => {
  const s = createState();
  const t0 = s.savedAt;
  const e0 = s.elapsed;
  applyOffline(s, t0 + 3600 * 1000);
  need(Math.abs(s.elapsed - (e0 + 3600)) < 1e-6, `elapsed 增了 ${s.elapsed - e0}s（应为 3600）`);
  need(s.savedAt === t0 + 3600 * 1000, 'savedAt 没有被推进');
  // 时钟必须由调用方注入 —— core 自己读 Date.now() 的话，无头断言不可能复现。
  // 允许的白名单是「挂钟碰边」而非游戏逻辑：state 造时间戳 / save 的默认参数 /
  // engine 主循环里 performance.now() 的兜底。这张表一旦要加人，就得先问「为什么」。
  const CLOCK_ALLOW = { 'src/core/state.js': 4, 'src/core/save.js': 1, 'src/core/engine.js': 1 };
  for (const f of SRC.filter(x => x.rel.startsWith('src/core/'))) {
    const n = (f.code.match(/Date\.now\(\)/g) || []).length;
    const allow = CLOCK_ALLOW[f.rel] ?? 0;
    need(n <= allow, `${f.rel} 读了 ${n} 次挂钟（允许 ${allow}）—— 时间必须由调用方注入`);
  }
  need(/nowMs = Date\.now\(\)/.test(srcOf('src/core/save.js')), 'applyOffline 不再接收 nowMs 参数');
  return 'elapsed 只记真实秒';
});

probe('离线：只给一份报告，不逐帧重放，且世界/年份跟着走', () => {
  const s = createState();
  const t0 = s.savedAt;
  const off = applyOffline(s, t0 + 6 * 3600 * 1000);
  need(off.report, '离线 6 小时没有产出报告');
  for (const k of ['stageFrom', 'stageTo', 'monthsFrom', 'monthsTo', 'cashGained', 'pending']) {
    need(k in off.report, `报告缺字段 ${k}`);
  }
  need(off.report.monthsTo >= off.report.monthsFrom, '离线后日历倒退了');
  need(s.world.month === gameMonths(s), `离线后世界月 ${s.world.month} ≠ 日历 ${gameMonths(s)}`);
  need(gameYear(s) >= 1, '离线后年份非法');
  // 不逐帧重放：6 小时真实离线对应的等效游戏时间只有 54 分钟
  need(off.equiv < 6 * 3600, `等效时间 ${off.equiv}s 等于真实离线时间 —— 折扣没生效`);
  return `等效 ${(off.equiv / 60).toFixed(1)} 分 → 第 ${off.report.monthsTo} 月`;
});

probe('离线报告弹窗：一份、可关、无名次行', () => {
  renderOffline(overlay, {
    capped: OFFLINE_CAP_SEC, cappedOut: true, equiv: OFFLINE_CAP_SEC * OFFLINE_MODIFIER,
    report: { stageFrom: 1, stageTo: 2, monthsFrom: 0, monthsTo: 40, cashGained: 1.23e6, overflowed: 2, pending: 1 },
  });
  const html = overlay.innerHTML;
  need((html.match(/class="modal"/g) || []).length === 1, '离线报告不止一个弹窗');
  need(visible(html).includes('离开的这段时间'), '离线报告标题不对');
  need(!visible(html).includes('名次'), '离线报告里还留着名次行');
  need(visible(html).includes('已按 8 小时上限'), '没有提示封顶');
  const btns = lookOverlay(html);
  need(btns.some(b => b.data.close !== undefined), '离线报告没有关闭按钮');
  return '单弹窗 · 可关';
});

probe('offlineRun 不改玩家的 speed 与 elapsed（只借它算）', () => {
  const s = midState(2, 20);
  s.speed = 4;
  const e0 = s.elapsed;
  offlineRun(s, 600);
  need(s.speed === 4, `speed 被改成了 ${s.speed}`);
  need(Math.abs(s.elapsed - e0) < 1e-9, 'elapsed 被 offlineRun 改了');
  return 'speed / elapsed 保持不变';
});

// ═══════════════════════════ 存读档 ═══════════════════════════

probe('存档往返一致（serialize → deserialize → serialize）', () => {
  const s = midState(4, 33);
  const a = serialize(s);
  const back = deserialize(a);
  need(back, '反序列化返回 null');
  const b = serialize(back);
  const pick = t => {
    const o = JSON.parse(t);
    delete o.savedAt;
    return o;
  };
  need(JSON.stringify(pick(a)) === JSON.stringify(pick(b)), '往返后字段发生变化');
  need(back.version === SAVE_VERSION, `版本号变成 ${back.version}`);
  return `${Object.keys(JSON.parse(a)).length} 个字段一致`;
});

probe('calMonth 是派生缓存，不进存档', () => {
  const s = midState(4, 33);
  need(s.calMonth > 0, '中期存档的 calMonth 应当已被写值');
  const raw = JSON.parse(serialize(s));
  need(!('calMonth' in raw), '存档里出现了 calMonth');
  const back = deserialize(serialize(s));
  need(back.calMonth === 0, '读档后 calMonth 应为 0（等第一帧重算）');
  return '不入档，读档后由 tick 重算';
});

probe('旧版本（v20 及以前）一律判为不可迁移，给新档', () => {
  need(SAVE_VERSION === 21, `SAVE_VERSION=${SAVE_VERSION}`);
  for (const v of [1, 8, 18, 19, 20]) {
    need(deserialize(JSON.stringify({ version: v, act: 8, buildings: {} })) === null, `v${v} 竟然被迁移了`);
  }
  need(deserialize('{ 不是 JSON') === null, '坏 JSON 没有兜住');
  need(deserialize(null) === null, 'null 没有兜住');
  return 'v1/v8/v18/v19/v20 全部拒绝';
});

probe('手改存档被夹取到合法区间', () => {
  const s = createState();
  const raw = JSON.parse(serialize(s));
  raw.stage = 99;
  raw.lines = { r: -5, m: 3.7, h: 'x' };
  raw.pending = [{ uid: 1, id: 'e11' }, { uid: 2 }, null];
  const back = deserialize(JSON.stringify(raw));
  need(back.stage === ACTS.length - 1, `stage 夹到 ${back.stage}`);
  need(back.lines.r === 0, `负等级没夹到 0（${back.lines.r}）`);
  need(back.lines.m === 3, `小数等级没取整（${back.lines.m}）`);
  need(back.pending.length === 1, `坏待决没被过滤（${back.pending.length}）`);
  return 'stage/等级/待决都被夹紧';
});

probe('存盘闸门：disableSave 后任何路径都写不进', () => {
  const s = midState(2, 20);
  wipe();
  enableSave();
  need(save(s) === true, '正常存盘失败');
  need(load() !== null, '存了却读不回来');
  disableSave();
  need(save(s) === false, '关闸后仍然写进了一条');
  enableSave();
  wipe();
  need(load() === null, 'wipe 之后还能读回存档');
  return '闸门守住三条写盘路径';
});

// ═══════════════════════════ UI 接线一致性 ═══════════════════════════

/** 从源码里抽 `if (d.xxx !== undefined)` 的动作键集合 */
const dispatchKeysOf = src => new Set([...src.matchAll(/if \(d\.(\w+) !== undefined\)/g)].map(m => m[1]));

probe('ACTION_KEYS ≡ main.js 的 dispatch ≡ click-sim 的 dispatch', () => {
  const want = [...ACTION_KEYS].sort().join(',');
  const main = [...dispatchKeysOf(srcOf('src/main.js'))].sort().join(',');
  const sim = [...dispatchKeysOf(toolOf('tools/click-sim.mjs'))].sort().join(',');
  need(main === want, `main.js 的 dispatch = ${main}，ACTION_KEYS = ${want}`);
  need(sim === want, `click-sim 的 dispatch = ${sim}，ACTION_KEYS = ${want}`);
  return `${ACTION_KEYS.length} 条：${want}`;
});

probe('ACTION_SELECTOR 由 ACTION_KEYS 生成，主事件是 pointerdown', () => {
  for (const k of ACTION_KEYS) need(ACTION_SELECTOR.includes(`[data-${k}]`), `选择器漏了 data-${k}`);
  need((ACTION_SELECTOR.match(/\[/g) || []).length === ACTION_KEYS.length, '选择器里有游离分支');
  need(PRIMARY_EVENT === 'pointerdown', `主事件是 ${PRIMARY_EVENT}（每 150ms 重建 DOM，click 会被静默丢弃）`);
  need(KEYBOARD_EVENT === 'click', `键盘兜底事件是 ${KEYBOARD_EVENT}`);
  need(typeof findActionEl === 'function', 'findActionEl 没导出');
  return `${ACTION_SELECTOR.length} 字符 · ${PRIMARY_EVENT}`;
});

probe('渲染出的动作键全部落在 ACTION_KEYS 内（四个页签 + 三个弹窗）', () => {
  const s = midState(4, 33);
  s.finance.rounds = ['angel', 'preA', 'a', 'b', 'c', 'preIpo', 'ipo'];
  const stray = [];
  const collect = html => {
    for (const b of buttonsIn(html)) {
      for (const k of Object.keys(b.data)) if (!ACTION_KEYS.includes(k)) stray.push(`data-${k}`);
    }
  };
  // **四个页签都要收** —— 只收当前页，别的页上的动作键就从来没被审过
  for (const i of [0, 1, 2, 3]) collect((lookTab(s, i), root.innerHTML));
  collect((renderSettings(overlay, s), overlay.innerHTML));
  collect((renderEnding(overlay, s), overlay.innerHTML));
  collect((renderNotTop(overlay, 3), overlay.innerHTML));
  need(!stray.length, `出现了没人管的动作键：${[...new Set(stray)].join('、')}`);
  return '七个界面全部合规';
});

probe('主界面按钮齐全：五条线分两页 / 三个倍速 / 设置 / 待决两项', () => {
  const s = midState(2, 20);
  const company = lookTab(s, TAB_COMPANY);
  const founder = lookTab(s, TAB_FOUNDER);
  const buys = [...company, ...founder].filter(b => b.data.buy !== undefined);
  need(company.filter(b => b.data.buy !== undefined).length === 2, '公司页不是两条资产线');
  need(founder.filter(b => b.data.buy !== undefined).length === 3, '创始人页不是三条线');
  need(LINE_IDS.every(id => buys.some(b => b.data.buy === id)), '五条线的 id 不全');
  const speeds = company.filter(b => b.data.speed !== undefined).map(b => b.data.speed);
  need(speeds.join(',') === '1,4,8', `倍速按钮是 ${speeds.join(',')}`);
  need(company.some(b => b.data.settings !== undefined), '缺少设置按钮 ⚙');
  // **页头恒一行**（用户 2026-09-27）：日期与章名住在公司名下方（`.brand` 里那一行 span）；
  // 「退休」按钮**不住页头**，而且**只在登顶之后才出现** —— 这一条在非结局态就得守住，
  // 否则它会变成一颗常驻按钮（用户明确否决过两次）。
  const headHtml = /<header class="head">[\s\S]*?<\/header>/.exec(root.innerHTML)?.[0] || '';
  need(/class="brand"/.test(headHtml) && headHtml.includes(gameDate(s)),
    '页头里公司名与日期/章名没有收在同一块 `.brand` 里');
  need(!/data-retire/.test(headHtml), '退休按钮又挤回页头了（那正是页头折行的主因）');
  need(!/data-retire/.test(root.innerHTML), '还没登顶就挂出了「退休」按钮 —— 它只该在登顶后出现');
  need(!/class="date"/.test(root.innerHTML), '旧版独立的 `.date` 节点还在（页头会折行）');
  need(company.filter(b => b.data.opt !== undefined).length === 2, '待决选项不是两项');
  // 资产线在按钮上显示的是**按章取的名字** + 「资产」，不是固定的 id 名
  const companyText = visible((lookTab(s, TAB_COMPANY), root.innerHTML));
  for (const id of ['c', 'd']) {
    const l = LINES.find(x => x.id === id);
    need(companyText.includes(lineName(l, s.stage)) && companyText.includes(l.who),
      `公司页缺「${lineName(l, s.stage)}/${l.who}」`);
  }
  const founderText = visible((lookTab(s, TAB_FOUNDER), root.innerHTML));
  for (const id of ['r', 'm', 'h']) {
    const l = LINES.find(x => x.id === id);
    need(founderText.includes(l.name) && founderText.includes(l.who), `创始人页缺「${l.name}/${l.who}」`);
  }
  return `${buys.length} 条线分两页 · ${company.length} 个可点元素`;
});

probe('倍速按钮点亮的是当前档位（.on 唯一）', () => {
  const s = midState(2, 20);
  for (const v of [1, 4, 8]) {
    s.speed = v;
    lookTab(s, 0);
    const on = [...root.innerHTML.matchAll(/<button class="ic on" data-speed="(\d+)"/g)].map(m => m[1]);
    need(on.length === 1 && on[0] === String(v),
      `s.speed=${v} 时点亮的档位是 [${on.join(',')}] —— 玩家看不出当前几倍速`);
  }
  s.speed = 1;
  return '1× / 4× / 8× 各自唯一点亮';
});

probe('页签：四个页签各换内容，且这个态住在模块里（全量重建不丢）', () => {
  const s = midState(2, 20);
  lookTab(s, TAB_COMPANY);
  need(root.innerHTML.includes('class="lines"') && !root.innerHTML.includes('class="rank"'),
    '「公司」页应只有资产线与待决、没有榜单');
  const tabs = buttonsIn(root.innerHTML).filter(b => b.data.tab !== undefined);
  need(tabs.length === 4, `页签 ${tabs.length} 个（应为 4）`);
  for (const t of ['创始人', '公司', '订单', '市值榜']) {
    need(visible(root.innerHTML).includes(t), `页签缺「${t}」`);
  }
  // 四个页的内容两两互斥
  const look = i => { lookTab(s, i); return root.innerHTML; };
  const isRank = h => h.includes('class="rank"');
  const nLines = h => (h.match(/class="line"/g) || []).length;
  const nOrders = h => (h.match(/class="order"/g) || []).length;
  need(nLines(look(TAB_FOUNDER)) === 3 && !isRank(look(TAB_FOUNDER)), '「创始人」页不是三条线');
  need(nLines(look(TAB_COMPANY)) === 2 && !isRank(look(TAB_COMPANY)), '「公司」页不是两条资产线');
  // 待决卡片长在「公司」页（用户 2026-09-27 修正），且它的页签在有待决时亮起来
  need(look(TAB_COMPANY).includes('class="pending"'), '「公司」页没有待决卡片');
  need(/<button class="tab[^"]* hot" data-tab="1">/.test(look(TAB_COMPANY)), '有待决时「公司」页签没亮 .hot');
  need(!look(TAB_FOUNDER).includes('class="pending"'), '待决卡片不该出现在「创始人」页');
  need(look(TAB_ORDER).includes('class="orders"') && !isRank(look(TAB_ORDER)) && nOrders(look(TAB_ORDER)) >= 0, '「订单」页没有订单区');
  need(isRank(look(TAB_RANK)) && nLines(look(TAB_RANK)) === 0, '「市值榜」页应只有榜单');
  need(/<button class="tab on" data-tab="3">/.test(look(TAB_RANK)), '「市值榜」页的页签没有点亮');
  // 全量重建一次：页签状态若留在 DOM 的 class 上，这一下就会弹回默认页
  render(root, s);
  need(root.innerHTML.includes('class="rank"'), '重建一帧后页签弹回了默认页 —— 交互态没住在模块里');
  // 日志条与 HUD 跨页签常驻
  need(root.innerHTML.includes('class="log"'), '「市值榜」页把日志条弄丢了');
  need((root.innerHTML.match(/class="cell[ "]/g) || []).length === 4, '「市值榜」页把 HUD 弄丢了');
  setTab(0);
  return '四页内容互斥 · 状态存活于重建';
});

// ═══════════════════════════ 订单（现金的第二个来源）═══════════════════════════

probe('订单：零随机 —— 同一份存档永远跑出同一串档位与金额', () => {
  need(ORDER_TIERS.length === 6 && HOT_TIER === ORDER_TIERS[3].tier, '档位表被改过（大单门槛与档位表不再对齐）');
  // 源码级：orders.js 里不许出现 Math.random —— 否则无头工具断言不了任何东西
  // ⚠️ 先剥掉注释再判：文件头自己就写着「零 Math.random()」这句话，直接匹配会误伤。
  const raw = srcOf('src/core/orders.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
  need(!/Math\.random/.test(raw), 'orders.js 里出现了 Math.random（订单必须是确定性的）');
  /** 从 0 跑 48 个月，逐月记录 [在手档位串, 现金] */
  const run = () => {
    const s = createState();
    s.calMonth = 0;
    s.orders = { next: 0, live: [] };
    const seen = [];
    for (let m = 0; m <= 48; m++) {
      s.calMonth = m;
      ordersTick(s, rates(s));
      need(liveCount(s) <= ORDER_SLOTS, `第 ${m} 月在手 ${liveCount(s)} 条 > 上限 ${ORDER_SLOTS}`);
      seen.push(liveOf(s).map(o => `${o.tier}@${o.born}`).join(',') + `#${s.money.toFixed(4)}`);
    }
    return seen.join('|');
  };
  const one = run();
  need(one === run(), '同一份存档两次跑出不同的订单串 —— 订单里有随机');
  // 48 个月 ÷ 9 月/条 ≈ 6 条排期，而每条只放 12 个月 ⇒ 每条都会走一遍「到期自动交付」那条分支
  return `48 个月逐月一致 · 排期 ${ORDER_EVERY_MONTHS} 月/条 · 在手 ≤ ${ORDER_SLOTS}`;
});

probe('订单：槽位满时**跳过**这一条（不排队）—— 挂机不会一次涌出十几条', () => {
  const s = createState();
  s.calMonth = ORDER_EVERY_MONTHS;                  // 第 2 条该生成的月份（排期 9 月/条）
  s.orders = {
    next: 0,
    live: [0, 1, 2].map(i => ({ uid: 900 + i, tier: ORDER_TIERS[i].tier, born: 0 })),
  };
  s.uidSeq = 902;
  ordersTick(s, rates(s));
  need(liveCount(s) === 3, `槽位满时在手变成 ${liveCount(s)} 条`);
  need(liveOf(s).every(o => o.uid <= 902), '槽位满时仍然塞进了新单 —— 挂机会一次涌出十几条');
  need(s.orders.next === 2, `next 没有前进（${s.orders.next}）—— 攒着的单会在某个月一起冒出来`);
  return `3 / ${ORDER_SLOTS} 条封顶 · next 照常前进`;
});

probe('订单：准时交付 ×1.0、到期自动交付 ×0.9（两个价，没有第三个）', () => {
  need(AUTO_DELIVER === 0.9, `自动交付折扣是 ${AUTO_DELIVER}`);
  // ① 玩家点 ⇒ ×1.0
  const s = midState(3, 30);
  s.orders = { next: 1e9, live: [{ uid: 41, tier: ORDER_TIERS[3].tier, born: gameMonths(s) }] };
  const R = rates(s);
  const o = s.orders.live[0];
  const want = valueOf(R, o);
  let before = s.money;
  need(deliverOrder(s, 41, R), '交付失败（uid 对得上）');
  need(Math.abs(s.money - before - want) < 1e-6, `准时交付不是 ×1.0（实得 ${((s.money - before) / want).toFixed(3)}）`);
  need(liveCount(s) === 0, '交付后没有出队');
  need(deliverOrder(s, 41, R) === false, '同一个 uid 交付了两次（界面拿到过期节点时会白给钱）');
  // ② 到期未点 ⇒ ×0.9
  const s2 = midState(3, 30);
  const R2 = rates(s2);
  s2.orders = {
    next: 1e9,
    live: [{ uid: 51, tier: ORDER_TIERS[5].tier, born: gameMonths(s2) - ORDER_LIFE_MONTHS }],
  };
  const want2 = valueOf(R2, s2.orders.live[0]) * AUTO_DELIVER;
  const before2 = s2.money;
  ordersTick(s2, R2);
  need(liveCount(s2) === 0, '到期没有自动交付');
  need(Math.abs(s2.money - before2 - want2) < 1e-6, `自动交付不是 ×${AUTO_DELIVER}`);
  // ③ 报酬不进收入公式：发一笔订单钱，年营收一动不动
  const rev = rates(s2).revenue;
  const s3 = midState(3, 30);
  s3.orders = { next: 1e9, live: [{ uid: 61, tier: ORDER_TIERS[5].tier, born: gameMonths(s3) }] };
  deliverOrder(s3, 61, rates(s3));
  need(rates(s3).revenue === rev, '订单钱进了收入公式（年营收被订单抬高了）');
  /**
   * 一单的**档位均值**占年营收几个百分点 —— 用户 2026-09-27 报的就是这个数（当时 0.047 档）。
   * 它只算「档位」那一层；类别（均值 1.1875）与形态（均值 1.05）再各乘一次，
   * 所以真实单笔在 `档位均值 × 0.71 ~ 1.67` 之间浮动（最低档 × 最便宜形态 → 最高档 × 最贵形态）。
   */
  const meanPayEq = ORDER_TIERS.reduce((a, t) => a + t.payEq, 0) / ORDER_TIERS.length;
  const meanPct = meanPayEq / SEC_PER_YEAR * 100;
  need(meanPct >= 7, `一单档位均值只有 ${meanPct.toFixed(1)}% 年营收 —— 订单又退回「边角料」了`);
  return `×1.0 / ×${AUTO_DELIVER} · 一单档位均值 ≈ ${meanPct.toFixed(1)}% 年营收`;
});

probe('订单页：在手条数挂上页签、大单时页签亮起、交付按钮合规', () => {
  const s = midState(2, 20);
  s.orders = { next: 1e9, live: [] };
  const blank = lookTab(s, 2);
  need(root.innerHTML.includes('class="orders"') && root.innerHTML.includes('class="o-empty"'),
    '没有订单时订单页既没有订单区也没有空态');
  need(!blank.some(b => b.data.order !== undefined), '空态下却有交付按钮');
  // 普通单 + 大单
  const m0 = gameMonths(s);
  // 六档下「大单」= 下标 ≥ 3 的那一半（`orders.HOT_TIER`），所以第二条取第 5 档才亮
  s.orders.live = [
    { uid: 61, tier: ORDER_TIERS[0].tier, born: m0 },
    { uid: 62, tier: ORDER_TIERS[4].tier, born: m0 },
  ];
  const btns = lookTab(s, 2);
  // 普通单渲染成 class="order"，大单渲染成 class="order hot" —— 正则要同时认这两种
  need((root.innerHTML.match(/class="order[" ]/g) || []).length === 2, '两条在手订单没渲染出来');
  const hotRows = (root.innerHTML.match(/class="order hot"/g) || []).length;
  need(hotRows === 1, `大单高亮 ${hotRows} 行（应为 1 行 —— 普通单不该亮）`);
  // 页签：在手 2 条 ⇒ 角标 2；有大单 ⇒ .hot（不切页也该看见）
  const tabBtn = /<button class="([^"]*)" data-tab="2">([^<]*)<\/button>/.exec(root.innerHTML);
  need(tabBtn, '找不到订单页签');
  need(/\bhot\b/.test(tabBtn[1]), '在手有大单，订单页签却没亮');
  need(/2/.test(tabBtn[2]), `页签上没有在手条数（读到「${tabBtn[2]}」）`);
  // 交付按钮：data-order = uid，且按时长显示剩余月数
  const dels = btns.filter(b => b.data.order !== undefined);
  need(dels.length === 2, `交付按钮 ${dels.length} 个（应为 2）`);
  need(ACTION_KEYS.includes('order'), 'data-order 没进 bind.js 的动作键白名单 —— 点了会被当成杂音丢掉');
  need(dels.every(b => b.data.order === '61' || b.data.order === '62'), '交付按钮的 uid 对不上在手订单');
  need(visible(root.innerHTML).includes('剩余'), '交付单上没有剩余月数');
  /**
   * 两行布局 + 分割线 + 右上「已完成 N 项」（用户 2026-09-27）。
   * 一条单必须**恰好两个块**：`.o-nm`（甲方 + 报酬）与 `.o-act`（内容 + 剩余 + 按钮）——
   * 这样甲方永远在第一行、按钮永远在第二行右端，不会因为字数不同而版式乱掉。
   */
  need((root.innerHTML.match(/class="o-nm"/g) || []).length === 2, '订单没有按两行渲染（缺 .o-nm）');
  need((root.innerHTML.match(/class="o-act"/g) || []).length === 2, '订单没有按两行渲染（缺 .o-act）');
  need(/class="o-head">[\s\S]*?已完成 <b>/.test(root.innerHTML), '在手订单右上角没有「已完成 N 项」');
  need(doneCount(s) === 0, `还没交付就报「已完成 ${doneCount(s)} 项」`);
  need(!s.ending && deliverOrder(s, 62, rates(s)), '从界面拿到的大单交付不了');
  need(liveCount(s) === 1, '交付后在手条数没减');
  need(doneCount(s) === 1, `交付一单后累计数没 +1（实得 ${doneCount(s)}）`);
  setTab(0);
  return `在手 2 条 → 1 条 · 大单 1 行高亮 · 已完成 ${doneCount(s)} 项`;
});

probe('归零按钮（买不起）仍然是可点元素 —— 只是压暗', () => {
  const s = midState(2, 20);
  s.money = 0;
  const btns = lookTab(s, TAB_COMPANY);
  const buys = btns.filter(b => b.data.buy !== undefined);
  need(buys.length === 2 && buys.every(b => !b.disabled), '买不起的资产线按钮被 disabled 了（会点不动）');
  need(root.innerHTML.includes('dim'), '买不起时没有视觉提示');
  // 创始人页同理：三条线都不 disabled
  const f = lookTab(s, TAB_FOUNDER).filter(b => b.data.buy !== undefined);
  need(f.length === 3 && f.every(b => !b.disabled), '买不起的创始人线被 disabled 了');
  setTab(0);
  return '不 disabled，只压暗';
});

probe('登顶即定格：界面只剩回看，且 tick 不再改变任何东西', () => {
  const s = midState(5, 40);
  s.ending = 'top';
  s.pending = [{ uid: 9, id: 'e11' }];            // 定格时连待决选项也不许点
  // ⚠️ 待决选项 + 2 条资产线在「公司」页，3 条创始人线在另一页；
  //    倍速在页头（两页都渲染），所以只能从一页里数一次，否则会重复计数。
  const companyBtns = lookTab(s, TAB_COMPANY);
  const founderBtns = lookTab(s, TAB_FOUNDER);
  const frozen = companyBtns.filter(b => b.data.buy !== undefined || b.data.opt !== undefined)
    .concat(founderBtns.filter(b => b.data.buy !== undefined))
    .concat(founderBtns.filter(b => b.data.speed !== undefined));
  need(frozen.length === 2 + 2 + 3 + 3, `可点元素不是 10 个（实得 ${frozen.length}）`);
  need(frozen.every(b => b.disabled), '定格后仍有能点动的买卖 / 倍速 / 选项按钮');
  // 设置不许禁：它是删档的唯一入口。
  // 「退休」横条同样不许禁 —— 登顶之后点它就是「再看一遍结局」，禁掉反而没路回去看。
  need(companyBtns.some(b => b.data.settings !== undefined && !b.disabled), '定格把「设置」也禁掉了');
  need(companyBtns.some(b => b.data.retire !== undefined && !b.disabled), '定格把「退休」横条也禁掉了');
  need(!root.innerHTML.includes('已登顶 · 时间冻结'), '定格后还挂着旧版那条「已登顶 · 时间冻结」提示');
  // 冻结必须发生在引擎里，不能只是界面装样子
  const snap = JSON.stringify({
    money: s.money, elapsed: s.elapsed, stage: s.stage,
    lines: s.lines, calMonth: s.calMonth, rank: s.worldRank, hasWorld: !!s.world,
  });
  tick(s, 12345);
  need(JSON.stringify({
    money: s.money, elapsed: s.elapsed, stage: s.stage,
    lines: s.lines, calMonth: s.calMonth, rank: s.worldRank, hasWorld: !!s.world,
  }) === snap, '定格后 12345 秒的 tick 仍在推进（时间没冻结）');
  setTab(0);
  return '10 个按钮全禁 · tick 空转';
});

probe('两步删档：第一次只改文案，第二次才真删', () => {
  disarmDeleteSave();
  const s = midState(2, 20);
  renderSettings(overlay, s);
  need(overlay.innerHTML.includes('data-delete'), '设置弹窗里没有删档按钮');
  need(overlay.innerHTML.includes('data-close'), '设置弹窗里没有关闭按钮');
  need(visible(overlay.innerHTML).includes('删除全部数据'), '删档按钮文案不对');
  need(!visible(overlay.innerHTML).includes('再点一次'), '还没点就进入了确认态');
  need(deleteSaveArmed() === false, '武装态初始应为 false');
  armDeleteSave();
  need(deleteSaveArmed() === true, 'armDeleteSave 没生效');
  renderSettings(overlay, s);
  need(visible(overlay.innerHTML).includes('再点一次'), '确认文案没有出现（玩家看不到二次确认）');
  disarmDeleteSave();
  renderSettings(overlay, s);
  need(!visible(overlay.innerHTML).includes('再点一次'), 'disarm 之后确认态没复位');
  return '武装 → 确认 → 复位';
});

probe('设置里有音效开关，且开关反映 s.sfx（默认开）', () => {
  const s = midState(2, 20);
  need(s.sfx === true, '新档的音效开关默认不是「开」');
  renderSettings(overlay, s);
  need(overlay.innerHTML.includes('data-audio'), '设置弹窗里没有音效开关');
  need(visible(overlay.innerHTML).includes('音效：开'), '默认没显示成「音效：开」');
  s.sfx = false;
  renderSettings(overlay, s);
  need(visible(overlay.innerHTML).includes('音效：关'), '关掉后没显示成「音效：关」');
  s.sfx = true;
  return '音效：开 ↔ 关';
});

probe('pointerdown 只派发一次；指针来源的 click 不重复派发；键盘 detail=0 兜底', () => {
  const appBox = hookNode();
  const overlayBox = hookNode();
  const got = [];
  // `pointerEvents: true` 显式声明环境能力 —— bind.js 是在模块加载时读 `window.PointerEvent` 的，
  // 而静态 import 早于本文件的 `installHarness()`，所以不能靠全局装。
  bindActions({ app: appBox, overlay: overlayBox }, el => got.push(el.dataset), { pointerEvents: true });
  const el = targetOf({ buy: 'r' });
  const e = (detail = 1) => ({ target: el, cancelable: true, detail, stopPropagation() {}, preventDefault() {} });
  appBox.fire(PRIMARY_EVENT, e());
  need(got.length === 1, `pointerdown 派发了 ${got.length} 次`);
  appBox.fire(KEYBOARD_EVENT, e(1));                 // 指针来源的 click：应被忽略
  need(got.length === 1, '指针来源的 click 重复派发了一次（会变成买两份）');
  appBox.fire(KEYBOARD_EVENT, e(0));                 // 键盘来源：应被接收
  need(got.length === 2, '键盘（detail=0）兜底失效');
  appBox.fire(PRIMARY_EVENT, { target: targetOf(null), cancelable: true, detail: 1, stopPropagation() {}, preventDefault() {} });
  need(got.length === 2, '非动作元素的点击也被派发了');
  need(got[0].buy === 'r', '派发丢了 dataset');
  return '1 → 1 → 2';
});

probe('弹窗只有 data-close 关得掉（两步确认才看得见）', () => {
  const appBox = hookNode();
  const overlayBox = hookNode();
  const layer = makeNode('div');                       // 真正的弹窗层
  const s = midState(2, 20);
  const got = [];
  // 与 main.js **同源**：关闭调 render.js 的 `closeModal`（它负责把 overlay 清空）
  bindActions({ app: appBox, overlay: overlayBox }, el => {
    got.push(el.dataset);
    if (el.dataset.close !== undefined) closeModal(layer);
  }, { pointerEvents: true });
  renderSettings(layer, s);
  need(layer.innerHTML.includes('class="modal"'), '设置弹窗没渲染出来');
  const fire = target => overlayBox.fire(PRIMARY_EVENT, { target, cancelable: true, detail: 1, stopPropagation() {}, preventDefault() {} });
  // 不是 data-close 的按钮：弹窗必须留下（否则两步确认永远看不见）
  fire(targetOf({ delete: '1' }));
  need(layer.innerHTML.includes('class="modal"'), '点了非关闭按钮，弹窗就被摘掉了');
  need(got.length === 1 && got[0].delete === '1', `删档按钮没派发到（got=${JSON.stringify(got)}）`);
  // data-close：整层清空
  fire(targetOf({ close: '1' }));
  need(got.length === 2 && got[1].close === '1', '关闭按钮没派发到');
  need(layer.innerHTML === '',
    `关掉后 overlay 还剩 ${JSON.stringify(layer.innerHTML.slice(0, 24))}`
    + ' —— 只摘 .modal 会留下空白文本节点，#overlay:empty 不成立，遮罩会吃掉全页点击');
  return '非 close 保留 / close 清空';
});

probe('四个弹窗关掉后 overlay 都真正清空（#overlay:empty 才成立 ⇒ 遮罩与点击都恢复）', () => {
  const layer = makeNode('div');
  const s = midState(2, 20);
  const draws = [
    ['设置', () => renderSettings(layer, s)],
    ['结局', () => renderEnding(layer, s)],
    ['还差一点', () => renderNotTop(layer, 3)],
    ['离线报告', () => renderOffline(layer, { capped: OFFLINE_CAP_SEC, cappedOut: true, equiv: 60, report: null })],
  ];
  for (const [name, draw] of draws) {
    draw();
    need(layer.innerHTML.includes('class="modal"'), `${name}弹窗没渲染出来`);
    closeModal(layer);
    need(layer.innerHTML === '',
      `${name}关掉后 overlay 还剩 ${JSON.stringify(layer.innerHTML.slice(0, 24))}`
      + ' —— 遮罩不会消失，且它是 position:fixed/inset:0/z-index:10，会把全页点击都吃掉');
  }
  // JS 清空 + CSS 隐藏规则，两边合起来才等于「遮罩真的 disappears」
  const css = readFileSync(join(ROOT, 'src/ui/style.css'), 'utf8');
  need(/#overlay:empty\s*\{\s*display:\s*none/.test(css), 'style.css 里 #overlay:empty 的隐藏规则没了');
  return '四个弹窗关掉后都是空串';
});

/** 造一个「记事件」的容器（探针里手工派发用） */
function hookNode() {
  const n = makeNode('div');
  n.handlers = [];
  n.addEventListener = (type, fn) => { n.handlers.push({ type, fn }); };
  n.removeEventListener = () => {};
  n.fire = (type, ev) => { for (const h of n.handlers) if (h.type === type) h.fn(ev); };
  return n;
}
/** 造一个能被 `findActionEl` 命中的事件目标；`data = null` ⇒ 不可点 */
function targetOf(data) {
  const el = {
    dataset: data || {},
    disabled: false,
    closest(sel) { return sel === ACTION_SELECTOR && data ? el : null; },
  };
  return el;
}

probe('真实接线跑一遍：从渲染出的 HTML 点到待决选项与投资线', () => {
  const s = midState(2, 20);
  const appBox = hookNode();
  let bought = 0;
  let resolved = 0;
  bindActions({ app: appBox }, el => {
    const d = el.dataset;
    if (d.buy !== undefined) { if (purchase(s, d.buy)) bought += 1; return; }
    if (d.opt !== undefined) {
      const [uid, i] = String(d.opt).split(':');
      if (resolvePending(s, Number(uid), Number(i), rates(s))) resolved += 1;
    }
  });
  const fire = el => appBox.fire(PRIMARY_EVENT, { target: el, cancelable: true, detail: 1, stopPropagation() {}, preventDefault() {} });
  const btns = lookTab(s, TAB_COMPANY);           // 待决选项长在「公司」页
  const optBtn = btns.find(b => b.data.opt !== undefined);
  need(optBtn, '界面上找不到待决选项按钮');
  fire(targetOf(optBtn.data));
  need(resolved === 1, '点了选项却没有结算');
  need(s.decisions === 1, '决策计数没涨');
  need(s.pending.length === 0, '待决没有出队');
  // 现金：可动用那笔（现金 × (1 − RESERVE_FRAC)）要够付 MANUAL_PAY 份还富余
  s.money = manualCostOf(s, 'h') / (1 - RESERVE_FRAC);
  fire(targetOf({ buy: 'h' }));                          // h（投招聘）在「创始人」页
  need(bought === 1 && lineLevel(s, 'h') === 21, `投资线没买到（Lv${lineLevel(s, 'h')}）`);
  // 资产线在「公司」页 —— 两条资产线共用同一条闸门，也要真点一次
  s.money = manualCostOf(s, 'c') / (1 - RESERVE_FRAC);
  fire(targetOf({ buy: 'c' }));
  need(bought === 2 && lineLevel(s, 'c') === 21, `资产线没买到（Lv${lineLevel(s, 'c')}）`);
  return '选项 + 投资线都点到';
});

// ═══════════════════════════ 渲染烟测 ═══════════════════════════

probe('八个阶段逐一渲染都不抛错，且都有世界榜与四格 HUD', () => {
  for (let a = 1; a <= 8; a++) {
    // ⚠️ 这里**不 tick**：tick 会因为市值超门槛自动推章，测不到「第 a 章长什么样」
    const s = createState();
    s.stage = a;
    s.lines = bal(a * 4);
    lookTab(s, TAB_RANK);                       // 世界榜在「市值榜」页（第 4 个页签）
    const html = root.innerHTML;
    need(html.includes('世界市值榜'), `第 ${a} 章没有世界榜`);
    need(html.includes('单位：万亿美元'), `第 ${a} 章榜单没有单位标签`);
    need((html.match(/class="cell[ "]/g) || []).length === 4, `第 ${a} 章 HUD 不是四格`);
    need(html.includes(ACTS[a].place), `第 ${a} 章没显示地点（${ACTS[a].place}）`);
    need(visible(html).includes(ACTS[a].goal), `第 ${a} 章没显示目标`);
    // 五条线分两页 —— 两页都要看，不能只验其中一页
    lookTab(s, TAB_FOUNDER);
    need((root.innerHTML.match(/class="line"/g) || []).length === 3, `第 ${a} 章创始人页不是三条线`);
    lookTab(s, TAB_COMPANY);
    need((root.innerHTML.match(/class="line"/g) || []).length === 2, `第 ${a} 章公司页不是两条资产线`);
    lookTab(s, TAB_ORDER);
    need(root.innerHTML.includes('class="orders"'), `第 ${a} 章订单页没有订单区`);
  }
  setTab(0);
  return '1–8 章全部可渲染';
});

probe('创始人只出现在文案里，不进任何公式', () => {
  need(FOUNDERS.length === 3, `创始人有 ${FOUNDERS.length} 位`);
  for (const f of FOUNDERS) {
    need(typeof f.name === 'string' && f.name, `${f.id} 没有名字`);
    need(!('skill' in f) && !('hp' in f) && !('mood' in f), `${f.id} 还挂着已删系统的字段`);
  }
  const ages1 = agesAt(1);
  const ages8 = agesAt(8);
  need(startYearOf(8) - startYearOf(1) === 34, '章首年份跨度不是 34 年（2026 → 2060，40 周年）');
  need(ages8.zhong === ages1.zhong + 34, '年龄没有随阶段推进');
  const html = (setTab(TAB_FOUNDER), render(root, midState(3, 30)), root.innerHTML);
  need(FOUNDERS.every(f => html.includes(f.name)), '「创始人」页没有展示创始人');
  setTab(0);
  // 三人名不进 rates：改名后速率必须一模一样
  const s = midState(3, 30);
  const before = JSON.stringify(rates(s));
  FOUNDERS[0].name = 'X';
  const after = JSON.stringify(rates(s));
  FOUNDERS[0].name = '老钟';
  need(before === after, '改了创始人名字，速率竟然变了 —— 他进公式了');
  return `年龄 ${ages1.zhong}→${ages8.zhong}`;
});

probe('结局弹窗有关闭按钮，且弹窗里不出现名次', () => {
  const s = midState(8, 160);
  renderEnding(overlay, s);
  need(visible(overlay.innerHTML).includes(ENDING_TEXT.top.title), '结局标题不对');
  need(lookOverlay(overlay.innerHTML).some(b => b.data.close !== undefined), '结局弹窗没有关闭按钮');
  /**
   * 结局文案里**不许出现名次**（用户 2026-09-26：「退休为什么还显示了排名？我说过了不要显示」）。
   * 会报名次的那一份是**未登顶**时的 `renderNotTop()`（「现在是世界第 N 名」）——
   * 登顶了就不该再谈名次：第一行已经写的是你们的名字。
   */
  need(!/世界第/.test(visible(overlay.innerHTML)), '结局弹窗把名次写进来了');
  need(!/\d+\s*名/.test(visible(overlay.innerHTML)), '结局弹窗里还有数字名次');
  return '结局弹窗可关 · 不报名次';
});

probe('日志裁剪：不超过上限，且开局那句一定在', () => {
  const s = A.s;
  need(s.log.length <= LOG_MAX, `日志 ${s.log.length} 条 > 上限 ${LOG_MAX}`);
  need(s.log.some(t => t.includes('登顶')), '终局日志里没有登顶那条');
  // 年度报告写的是**日历 20xx 年**（用户 2026-09-27），不写「第 N 年」
  need(s.log.some(t => /【20\d\d 年】/.test(t)), '日志里没有年度报告（应写日历年份）');
  for (const t of s.log) need(typeof t === 'string' && t.length, '日志里出现了空行');
  return `${s.log.length}/${LOG_MAX} 条`;
});

probe('数字格式化：万亿/亿/万 口径正确', () => {
  need(fmt(1.76e15) === '1760.00万亿', `1.76e15 → ${fmt(1.76e15)}`);
  need(fmt(1.76e11) === '1760.00亿', `1.76e11 → ${fmt(1.76e11)}`);
  need(fmt(59280) === '5.93万', `59280 → ${fmt(59280)}`);
  need(fmt(0) === '0.00', `0 → ${fmt(0)}`);
  need(fmt(12345) === '1.23万', `12345 → ${fmt(12345)}`);
  const s = midState(1, 0);
  lookTab(s, 0);
  need(root.innerHTML.includes('¥'), '主界面里没有金额');
  return `${fmt(1.76e15)} / ${fmt(1.76e11)} / ${fmt(59280)}`;
});

// ═══════════════════════════ 验收带宽的自洽 ═══════════════════════════

probe('验收带宽自洽：A 档 ⊆ [3,6]、D 档 ⊆ [3,18]、目标合计 = 5.2h', () => {
  need(CURVE_BAND[0] === 3 && CURVE_BAND[1] === 6, `A 档带宽 ${CURVE_BAND}`);
  need(IDLE_BAND[0] === 3 && IDLE_BAND[1] === 18, `D 档带宽 ${IDLE_BAND}`);
  need(TARGET_TOTAL_H >= CURVE_BAND[0] && TARGET_TOTAL_H <= CURVE_BAND[1], '目标合计不在 A 档带宽内');
  need(IDLE_BAND[1] >= CURVE_BAND[1], 'D 档上限比 A 档还严 —— 要求「不决策不变慢」是自相矛盾的');
  return `目标 ${TARGET_TOTAL_H}h`;
});

probe('真跑一局：A 主动落在 [3,6]h，D 挂机落在 [3,18]h', () => {
  const a = A.seconds / 3600;
  const d = D.seconds / 3600;
  need(a >= CURVE_BAND[0] && a <= CURVE_BAND[1], `A 路径 ${a.toFixed(2)}h 出带 [${CURVE_BAND}]`);
  need(d >= IDLE_BAND[0] && d <= IDLE_BAND[1], `D 路径 ${d.toFixed(2)}h 出带 [${IDLE_BAND}]`);
  need(A.s.ending === 'top' && D.s.ending === 'top', '有路径没走到结局');
  return `A ${a.toFixed(2)}h ／ D ${d.toFixed(2)}h`;
});

probe('终局市值够得着同月榜首（登顶物理可达，且不虚高）', () => {
  const months = gameMonths(A.s);
  const w = createWorld('B');
  advanceWorld(w, months);
  const top1 = ranking(w, null, 1).top[0].cur;
  const me = toUSD_T(derived(A.s).marketCap);
  need(me >= top1, `终局 ${me.toFixed(1)}T < 第 ${months} 月榜首 ${top1.toFixed(1)}T`);
  need(me <= top1 * 1.25, `终局是同月榜首的 ${(me / top1).toFixed(2)}×（终局线虚高）`);
  return `${me.toFixed(1)}T vs 榜首 ${top1.toFixed(1)}T`;
});

probe('汇率与 GDD 一致：1 万亿 USD = 7.2e12 元', () => {
  need(RMB_PER_T_USD === 7.2e12, `RMB_PER_T_USD=${RMB_PER_T_USD}`);
  need(Math.abs(toUSD_T(7.2e12) - 1) < 1e-12, 'toUSD_T 换算不对');
  return '7.2e12';
});

probe('曲线目标与内容表一致：八章门槛严格递增、五条线共用同一个 g', () => {
  // 旧版这里守的是 `GENERATION === 1.5`（每幕 ×1.5 的隐藏乘数）—— 该常量已整块删除
  // （用户 2026-09-26「去掉繁杂的，只保留精华」），曲线改由 ACTS[].mcap 单独承担。
  for (let a = 1; a <= 7; a++) {
    need(ACTS[a + 1].mcap > ACTS[a].mcap, `第 ${a} 章门槛没有严格递增`);
  }
  need(ACTS[8].mcap / ACTS[1].mcap > 1e6, `八章跨度太小（${(ACTS[8].mcap / ACTS[1].mcap).toExponential(2)}）`);
  // 里程碑：严格递增、全部在前七章之内（第 8 章只留「登顶」一件事）
  for (let i = 1; i < MILESTONES.length; i++) {
    need(MILESTONES[i].v > MILESTONES[i - 1].v, `里程碑第 ${i} 项没有严格递增`);
  }
  need(MILESTONES[MILESTONES.length - 1].v < ACTS[8].mcap, '有个里程碑比第 8 章门槛还高 —— 它永远不会触发');
  need(LINES.length === 5, `投资线不是五条（实得 ${LINES.length}）`);
  need(Math.abs(LINE_GROWTH - CURVE_RATIO ** (1 / LINES.length)) < 1e-12, 'g ≠ r^(1/5)');
  need(LINE_GROWTH > 1 && LINE_GROWTH < CURVE_RATIO, 'g 没有落在 (1, r) 之间');
  need(SEC_PER_YEAR * TOTAL_YEARS / 3600 > 0, 'SEC_PER_YEAR 与年数不自洽');
  need(INCOME_SCALE > 0 && costOf(0) > 0, '开局系数非法');
  return `g=${LINE_GROWTH.toFixed(4)} ｜ 跨度 ${(ACTS[8].mcap / ACTS[1].mcap).toExponential(1)} ｜ 里程碑 ${MILESTONES.length} 条`;
});

// ═══════════════════════════ 真实启动烟测（最后跑）═══════════════════════════
/**
 * 前面所有探针都跑在**自己搭的**假 DOM 上；这一条 `import('../src/main.js')`
 * —— 把真正的入口连同离线结算、首帧 tick、接线、首帧渲染整条链跑一遍。
 *
 * 它守的是用户报过两次的那个 bug：**启动链上任何一步抛错 ⇒ `#app` 一个字都没有 ⇒ 纯黑屏**。
 * main.js 里的 `fatal()` 兜底会自己画一份错误面板，所以这里既要断言「有内容」，
 * 也要断言「不是那份错误面板」。
 */
const boot = { ok: false, note: '' };
try {
  const appEl = document.getElementById('app');
  const overlayEl = document.getElementById('overlay');
  storage.clear();
  await import('../src/main.js');
  const html = appEl.innerHTML || appEl.textContent || '';
  need(html.length > 0, '#app 一个字都没有（黑屏）');
  need(!html.includes('启动失败'), `启动链抛错：${visible(html).slice(0, 120)}`);
  // 首帧落在「创始人」页：投资线在、榜单不在（榜单在「市值榜」页，由页签探针覆盖）
  need(html.includes('class="lines"'), '首帧没有渲染出投资线（「创始人」页）');
  const btns = buttonsIn(html);
  need(btns.filter(b => b.data.buy !== undefined).length === 3, '首帧「创始人」页没有三条经营线按钮');
  need(btns.filter(b => b.data.tab !== undefined).length === 4, '首帧没有四个页签');
  need(html.includes('class="log"'), '首帧没有日志条');
  need(overlayEl && overlayEl.innerHTML !== undefined, 'overlay 容器没接上');
  boot.ok = true;
  boot.note = `首帧 ${html.length} 字符 / ${btns.length} 个按钮`;
} catch (e) {
  boot.note = e.message || String(e);
}
rows.push({ ok: boot.ok, name: '真跑 src/main.js：首帧不黑屏、无启动异常', ev: boot.note });

/* ─────────────────────────── 输出 ─────────────────────────── */
const pass = rows.filter(r => r.ok).length;
const fails = rows.filter(r => !r.ok);

console.log('');
console.log('  🧪 流程探针（GDD §5.3）—— 动作从界面来，结果看可见状态');
console.log('  ─'.repeat(34));
console.log(`  真跑两局：A 主动 ${(A.seconds / 3600).toFixed(2)}h ／ D 挂机 ${(D.seconds / 3600).toFixed(2)}h`
  + ` ｜ 源码审计 ${SRC.length} 个文件`);
console.log('');
for (const r of rows) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.ev ? `　（${r.ev}）` : ''}`);
console.log('');
console.log(`  ${pass}/${rows.length} 项通过${fails.length ? `，${fails.length} 项失败` : ''}`);
if (fails.length) for (const f of fails) console.log(`      ❌ ${f.name}：${f.ev}`);
console.log('');

console.log('BRIEF ' + JSON.stringify({
  pass, fail: fails.length, failed: fails.map(f => f.name),
  aHours: +(A.seconds / 3600).toFixed(2),
  dHours: +(D.seconds / 3600).toFixed(2),
  aEnding: A.s.ending, dEnding: D.s.ending,
  aDecisions: A.s.decisions, dOverflowed: D.overflowed,
  months: gameMonths(A.s),
  boot: boot.ok,
}));
