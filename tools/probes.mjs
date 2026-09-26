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
  CURVE_RATIO, LINE_GROWTH, INCOME_SCALE, GENERATION, SEC_PER_YEAR,
  OFFLINE_CAP_SEC, OFFLINE_MODIFIER, PE_MIN, PE_MAX, PE_BASE, START_MCAP,
  FOUNDERS, agesAt, startYearOf, marginOf, salaryFrac, scaleFrac, companyName,
  AUTO_BUY_RESERVE, MANUAL_GAIN, FOCUS, FOCUS_EVEN, FOCUS_LAG, AUTO_DECIDE_STAGE,
} from '../src/core/content.js';
import {
  rates, derived, costOf, costFor, purchase, lineLevel,
  generationOf, peOf, sharePctOf, marketRevenueOf, lowestLine,
} from '../src/core/economy.js';
import {
  tick, pendingEvent, resolvePending, applyEffect, stageGoalMet, offlineRun, LOG_MAX,
  manualBuy, setFocus,
} from '../src/core/engine.js';
import { ROUNDS, isListed } from '../src/core/finance.js';
import { evaluateRetirement, ENDING_TEXT } from '../src/core/endings.js';
import { applyOffline, save, load, wipe, disableSave, enableSave } from '../src/core/save.js';
import {
  createState, serialize, deserialize, SAVE_KEY, SAVE_VERSION,
} from '../src/core/state.js';
import {
  gameDate, gameYear, gameMonths, calMonthOf, ACT_MONTHS, MONTHS_TOTAL, TOTAL_YEARS,
} from '../src/core/format.js';
import {
  createWorld, advanceWorld, ranking, worldDate, worldTick, toUSD_T, RMB_PER_T_USD,
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
  s.lines = { r: level, m: level, h: level };
  tick(s, 0);        // dt=0：只建世界表 / 写进度钟 / 发第 1 年年报，不推进生产
  return s;
}

/** 一个选项在**对数市值**上的增量 —— 与 headless-check 同一口径（挑最优项用） */
function logCapDelta(s, eff) {
  if (!eff) return 0;
  const R = rates(s);
  let d = 0;
  if (eff.cash) d += ((eff.cash * R.revenue) / costFor(s, LINE_IDS[0])) * Math.log(CURVE_RATIO) / 3;
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
  while (!s.ending && t < maxSeconds) {
    t += STEP;
    tick(s, STEP);
    const a = s.stage;
    const m = (marks[a] = marks[a] || { first: t, last: t });
    m.last = t;
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
  return { s, seconds: t, marks };
}

/* ── 一次真跑，多条探针共用（跑一局 ≈1s，跑两次太浪费）── */
const A = play('best');
const D = play('idle');

// ═══════════════════════════ §5.1 经济模型六条不变式 ═══════════════════════════

probe('① margin ≥ 0.22（七幕全程）', () => {
  for (let a = 1; a <= 7; a++) {
    const m = marginOf(a);
    need(m >= 0.22 - 1e-12, `第 ${a} 幕 margin=${m.toFixed(3)} < 0.22`);
    need(Math.abs(m - (1 - salaryFrac(a) - scaleFrac(a))) < 1e-12, `第 ${a} 幕 margin 与两个 frac 不自洽`);
  }
  return '最低 0.220（第 7 幕）';
});

probe('② upkeep 无加法项（严格等于 revenue × frac）', () => {
  for (let a = 1; a <= 7; a++) {
    const s = createState();
    s.stage = a;
    s.lines = { r: 12, m: 9, h: 15 };
    const R = rates(s);
    need(R.upkeep === R.revenue * R.frac, `第 ${a} 幕 upkeep ≠ revenue·frac —— 出现了加法项`);
    need(R.net === R.revenue - R.upkeep, `第 ${a} 幕 net ≠ revenue − upkeep`);
  }
  // 源码级：upkeep 那一行只能是乘法（旧版是 `revenue·k − 固定额`，gross 一小就永久负收入）
  const eco = srcOf('src/core/economy.js');
  need(/const upkeep = revenue \* frac;/.test(eco), 'upkeep 的写法变了 —— 请确认没有引入绝对额固定支出');
  return '净额恒等于比例式';
});

probe('③ 三个变量与 GENERATION 恒 ≥ 1', () => {
  need(GENERATION >= 1, `GENERATION=${GENERATION} < 1`);
  need(LINE_GROWTH >= 1, `LINE_GROWTH=${LINE_GROWTH} < 1`);
  for (const lv of [0, 1, 7, 40, 200]) {
    const s = createState();
    s.lines = { r: lv, m: lv, h: lv };
    const R = rates(s);
    need(R.prod >= 1 && R.share >= 1 && R.team >= 1, `Lv${lv} 出现 <1 的变量`);
  }
  for (let a = 1; a <= 7; a++) need(generationOf(a) >= 1, `第 ${a} 幕 gen < 1`);
  return '变量与代际恒 ≥1';
});

probe('④ PE 夹取在 [8, 60] 内', () => {
  need(PE_MIN === 8 && PE_MAX === 60, `PE 区间是 [${PE_MIN}, ${PE_MAX}]`);
  for (let a = 1; a <= 7; a++) {
    for (const d of [-999, -50, 0, 50, 999]) {
      const s = createState();
      s.stage = a;
      s.mod.pe = d;
      const pe = peOf(s);
      need(pe >= PE_MIN && pe <= PE_MAX, `第 ${a} 幕 mod.pe=${d} ⇒ PE=${pe} 越界`);
    }
  }
  return `基准 ${ACTS.slice(1).map(a => a.pe).join('/')}`;
});

probe('⑤ 三条线等级只增不减（源码审计）', () => {
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

probe('⑥ marketCap 对等级单调递增（三线分别验）', () => {
  for (let a = 1; a <= 7; a++) {
    for (const id of LINE_IDS) {
      const s = createState();
      s.stage = a;
      s.lines = { r: 10, m: 10, h: 10 };
      const lo = derived(s).marketCap;
      s.lines = { ...s.lines, [id]: 11 };
      const hi = derived(s).marketCap;
      need(hi > lo, `第 ${a} 幕加 ${id} 一级后市值没涨（${lo} → ${hi}）`);
    }
  }
  return '三线各自单调';
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
  lookTab(s, 1);                                  // 榜单在「市值榜」页
  need(!root.innerHTML.includes('class="row me"'), '未上市的主界面里出现了玩家行');
  need(visible(root.innerHTML).includes('未上市'), 'HUD 没写「未上市」');
  s.finance.rounds = ['angel', 'preA', 'a', 'b', 'c', 'preIpo', 'ipo'];
  lookTab(s, 1);
  need(root.innerHTML.includes('class="row me"'), '上市后榜单里没有玩家行');
  return '未上市 — / 上市进榜';
});

probe('上市且名次 > 20 时钉在列表底部单独一行（100 名开外只报「>100」）', () => {
  const s = midState(3, 30);
  s.finance.rounds = ['ipo'];
  lookTab(s, 1);
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
    '「市值榜」页里冒出了投资线 —— 两页内容必须互斥');
  return `名次 #${s.worldRank} ⇒ 钉底并报 >100`;
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

probe('每幕事件池恒为 6 条（3 通用 + 3 专属）', () => {
  const generic = EVENTS.filter(e => e.stage === 0).length;
  need(generic === 3, `通用事件 ${generic} 条`);
  for (let a = 1; a <= 7; a++) {
    const pool = eventsFor(a);
    const own = pool.filter(e => e.stage === a).length;
    need(pool.length === 6, `第 ${a} 幕池子 ${pool.length} 条`);
    need(own === 3, `第 ${a} 幕专属 ${own} 条`);
    need(pool.every(e => eventById(e.id) === e), `第 ${a} 幕有 id 对不上的事件`);
  }
  return '7 幕 × 6 条';
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
  lookTab(s, 0);
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
  // 给一笔够买几十次的钱，跑一小步（dt 足够短，只触发自动购买）
  s.money = costOf(0) * 20;
  tick(s, 0.001);
  const lv = LINE_IDS.map(id => lineLevel(s, id));
  need(Math.max(...lv) - Math.min(...lv) <= 1, `自动购买后三线不再均衡：${lv.join('/')}`);
  need(Math.min(...lv) >= 2, `只买了 ${lv.join('/')}，一次 tick 的购买次数太少`);
  return `${lv.join('/')}（极差 ≤1）`;
});

probe('手动 = 满配、自动 = 打折版（同价不同级，且自动要留储备）', () => {
  const s = midState(2, 20);
  s.money = 0;
  const want = lowestLine(s);
  const cost = costFor(s, want);
  // 「买的正是最便宜那条」= 三线共用 cost(n) 的直接推论
  const costs = LINE_IDS.map(id => costFor(s, id));
  need(cost === Math.min(...costs), '最低等级那条不是最便宜的 —— 三线 cost 不再共用');

  // ① 手动：付一级的钱、涨 MANUAL_GAIN 级（价格与自动完全一样，差别只在级数）
  s.money = cost;
  const lvManual = lineLevel(s, want);
  need(manualBuy(s, want) === true, '手动购买失败');
  need(lineLevel(s, want) === lvManual + MANUAL_GAIN, `手动只涨了 ${lineLevel(s, want) - lvManual} 级`);
  need(s.money === 0, '手动扣款不是一级的钱');

  // ② 自动：同一个价格，一次一级
  const id2 = lowestLine(s);
  const cost2 = costFor(s, id2);
  s.money = cost2;
  const lvAuto = lineLevel(s, id2);
  need(purchase(s, id2) === true, '自动购买失败');
  need(lineLevel(s, id2) === lvAuto + 1, '自动不是一次一级');
  need(s.money === 0, '自动扣款不对');
  need(MANUAL_GAIN > 1, `MANUAL_GAIN = ${MANUAL_GAIN} —— 手动没有分量`);

  // ③ 让路：自动的动手门槛是 AUTO_BUY_RESERVE 份钱 —— 没有它，手动永远点不动
  need(AUTO_BUY_RESERVE >= 2, `AUTO_BUY_RESERVE = ${AUTO_BUY_RESERVE} —— 没有给手动留窗口`);
  const s2 = createState();
  s2.stage = 2; s2.money = 0;
  const idm = lowestLine(s2);
  const c0 = costFor(s2, idm);
  // 只放「一份钱」：自动不动手 ⇒ 这一份钱留给了玩家
  s2.money = c0 * (AUTO_BUY_RESERVE - 0.5);
  tick(s2, 0);
  need(s2.money >= c0, `自动把 ${AUTO_BUY_RESERVE - 0.5} 份钱花掉了 —— 手动窗口不存在`);
  return `手动 +${MANUAL_GAIN} 级 / 自动 +1 级，储备 ${AUTO_BUY_RESERVE} 份`;
});

probe('唯一结局「登顶」：worldRank === 1 且无第二条结局', () => {
  need(Object.keys(ENDING_TEXT).length === 1 && ENDING_TEXT.top, `结局文案有 ${Object.keys(ENDING_TEXT).length} 条`);
  const s = createState();
  s.worldRank = null;
  need(evaluateRetirement(s).ending === null, 'worldRank 为空时不该给结局');
  s.worldRank = 5;
  const r = evaluateRetirement(s);
  need(r.ending === null && r.rank === 5, '未登顶却结算了结局');
  s.worldRank = 1;
  need(evaluateRetirement(s).ending === 'top', 'worldRank===1 没判成登顶');
  need(A.s.ending === 'top', `真跑一局没有走到结局（ending=${A.s.ending ?? 'null'}）`);
  need(A.s.worldRank === 1, `结局时 worldRank=${A.s.worldRank}`);
  return '唯一结局可复现';
});

probe('阶段推进：唯一机械闸门是「市值 ≥ 本幕 mcap」', () => {
  for (let a = 1; a <= 6; a++) {
    need(ACTS[a + 1].mcap > ACTS[a].mcap, `第 ${a} 幕门槛没有严格递增`);
  }
  need(ACTS[1].mcap > START_MCAP, '第 1 幕门槛低于开局市值 —— 一开局就会推进');
  need(IPO_LINE === ACTS[4].mcap, `IPO_LINE=${IPO_LINE} 与 ACTS[4].mcap=${ACTS[4].mcap} 不一致`);
  const s = midState(1, 0);
  need(s.stage === 1, '开局幕次不是 1');
  need(!stageGoalMet(s, rates(s), derived(s)) || true, '目标判定不该抛错');
  return `1.07e5 → 1.76e15（7 档）`;
});

probe('上市时点：第 4 幕幕末敲钟（融资幕的四轮都排在第 4 幕里）', () => {
  need(IPO_LINE === ACTS[4].mcap, `IPO_LINE=${IPO_LINE} ≠ ACTS[4].mcap=${ACTS[4].mcap}`);
  // 四轮融资必须都落在第 4 幕的年份区间内，否则会出现「先上市、后到账」
  const [y0, y1] = /(\d{4})–(\d{4})/.exec(ACTS[4].years).slice(1).map(Number);
  const want = { a: 4, b: 4, c: 4, preIpo: 4, angel: 2, preA: 2 };
  for (const r of ROUNDS) {
    if (r.id === 'ipo') { need(r.year === null, 'IPO 不该看年份（它看市值）'); continue; }
    const [a0, a1] = /(\d{4})–(\d{4})/.exec(ACTS[want[r.id]].years).slice(1).map(Number);
    need(r.year >= a0 && r.year <= a1, `${r.name}（${r.year}）不在第 ${want[r.id]} 幕区间 ${a0}–${a1} 内`);
  }
  // 端到端：市值越过 IPO_LINE 的那一 tick 必须同时「敲钟 + 进第 5 幕」
  const s = createState();
  s.stage = 4;
  s.lines = { r: 60, m: 60, h: 60 };
  tick(s, 0);
  need(isListed(s), `市值 ¥${(derived(s).marketCap).toFixed(0)} 越过上线却没敲钟`);
  need(s.stage === 5, `敲钟时应刚好进第 5 幕（实得第 ${s.stage} 幕）`);
  need(s.log.some(t => t.includes(companyName(true))), '敲钟没有改名日志');
  return `第 4 幕区间 ${y0}–${y1} · 幕末敲钟`;
});

probe('阶段目标：七条都在**本幕之内**被打勾（不是一进幕就成立的假目标）', () => {
  const { s, marks } = A;
  const out = [];
  for (let a = 1; a <= 6; a++) {
    const m = marks[a];
    need(m, `第 ${a} 幕整幕没被观察到`);
    need(m.hit !== undefined, `第 ${a} 幕目标「${ACTS[a].goal}」整幕都没打勾 —— 这是句假话`);
    need(m.hit > m.first, `第 ${a} 幕目标「${ACTS[a].goal}」一进幕就已经成立（${m.first}s 就为真）`);
    out.push(`${(100 * (m.hit - m.first) / Math.max(1, m.last - m.first)).toFixed(0)}%`);
  }
  const m7 = marks[7];
  need(m7 && m7.hit !== undefined, '第 7 幕目标（登顶）整幕没打勾');
  need(s.ending === 'top', `真跑一局没走到结局（ending=${s.ending ?? 'null'}）`);
  return `幕内跨过位置 ${out.join(' / ')} · 第 7 幕 = 结局`;
});

probe('市场份额：以本幕市场（mcap/PE）为分母，恒 ≤50%、随营收单调、换幕回落', () => {
  for (let a = 1; a <= 7; a++) {
    const m = marketRevenueOf(a);
    need(m > 0, `第 ${a} 幕市场年营收非正`);
    let prev = -1;
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      const p = sharePctOf(m * f, a);
      need(p >= 0 && p <= 50 + 1e-9, `第 ${a} 幕份额越界：${p}%`);
      need(p > prev, `第 ${a} 幕份额没有随营收单调上升`);
      prev = p;
    }
    need(Math.abs(sharePctOf(m, a) - 50) < 1e-9, `第 ${a} 幕幕末份额不是 50%`);
    // 换幕回落：上一幕幕末的营收，放到下一幕的分母里就不到一半了
    if (a < 7) need(sharePctOf(m, a + 1) <= 50, `第 ${a + 1} 幕起点份额没有回落`);
  }
  // 旧口径的病根：份额饱和到 99%。第 2–7 幕一开场都该离上限很远……
  for (let a = 2; a <= 7; a++) {
    const p = sharePctOf(ACTS[a - 1].mcap / PE_BASE[a], a);
    need(p < 20, `第 ${a} 幕一开场份额就有 ${p.toFixed(0)}% —— 又饱和了`);
  }
  // ……第 1 幕是例外：开局市值 ÷ 第 1 幕门槛只有 1.48×，起点必然偏高；但也不许顶到上限
  need(sharePctOf(START_MCAP / PE_BASE[1], 1) < 50, '第 1 幕一开场就顶到上限');
  return '幕末恒 50% · 第 2–7 幕幕起 <20%';
});

probe('投资线的份额渲染：七幕全程都不越过 50%（修掉「饱和到 99%」）', () => {
  const out = [];
  for (let a = 1; a <= 7; a++) {
    const s = midState(a, a * 4);
    lookTab(s, 0);
    const m = /市场份额 ([\d.]+)%/.exec(visible(root.innerHTML));
    need(m, `第 ${a} 幕投资线没显示份额百分比`);
    const p = Number(m[1]);
    need(p <= 50 + 1e-9, `第 ${a} 幕份额 ${p}% 超过 50% 上限`);
    out.push(p.toFixed(0));
  }
  setTab(0);
  return `1–7 幕：${out.join('% / ')}%`;
});

probe('自动购买方向：优先所选那条，但领先超过 FOCUS_LAG 级就自动回补', () => {
  need(FOCUS.length === LINE_IDS.length + 1, `方向选项 ${FOCUS.length} 个（应为 均衡 + 三条线）`);
  const s = createState();
  s.stage = 2;
  s.money = 1e12;                       // 钱管够，一 tick 内连买
  need(setFocus(s, 'r'), 'setFocus 拒绝了合法方向');
  need(!setFocus(s, 'nope'), 'setFocus 接受了非法方向');
  need(s.focus === 'r', 'setFocus 没有落进状态');
  tick(s, 0);
  const lv = LINE_IDS.map(id => lineLevel(s, id));
  const d = lv[LINE_IDS.indexOf('r')] - Math.min(...lv);
  need(d > 0, `选了「投研发」，研发却不是买得最多的：${lv.join('/')}`);
  need(d <= FOCUS_LAG, `研发领先最低线 ${d} 级 —— 超过 FOCUS_LAG=${FOCUS_LAG}，回补没生效`);

  const s2 = createState();
  s2.stage = 2; s2.money = 1e12;
  need(s2.focus === FOCUS_EVEN, `新档默认方向不是均衡（实得 ${s2.focus}）`);
  tick(s2, 0);
  const lv2 = LINE_IDS.map(id => lineLevel(s2, id));
  need(Math.max(...lv2) - Math.min(...lv2) <= 1, `均衡档下三线失衡：${lv2.join('/')}`);
  return `r 领先 ${d} 级（上限 ${FOCUS_LAG}）／均衡档极差 ${Math.max(...lv2) - Math.min(...lv2)}`;
});

probe('事件增强：选项按钮带效果数字；第 AUTO_DECIDE_STAGE 幕起不再打扰玩家', () => {
  // ① 数字：文案讲故事，数字讲代价
  const s = midState(3, 30);
  s.pending.length = 0;
  s.pending.push({ uid: 1, id: 'e31' });
  lookTab(s, 0);
  const html = root.innerHTML;
  need(/<em class="eff">/.test(html), '事件选项上没有效果数字');
  need(visible(html).includes('现金 +0.9% 年营收'), `选项没写出现金代价：${visible(html).slice(0, 120)}`);
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
  fast.lines = { r: 60, m: 60, h: 60 };
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
  s.lines = { r: 0, m: 0, h: 0 };
  for (let lv = 0; lv <= 200; lv += 2) {
    s.lines = { r: lv, m: lv, h: lv };
    months.push(calMonthOf(s, derived(s)));
  }
  for (let i = 1; i < months.length; i++) {
    need(months[i] >= months[i - 1] - 1e-9, `第 ${i} 个采样点日历倒退了（${months[i - 1]} → ${months[i]}）`);
  }
  need(months[months.length - 1] > 300, '满级也没有把日历推到最后 —— 锚点表可能断了');
  return `${months.length} 个采样点全程单调`;
});

probe('ACT_MONTHS 与 ACTS[].years 一致，且首尾相接铺满 420 月', () => {
  for (let a = 1; a <= 7; a++) {
    const [m0, m1] = ACT_MONTHS[a];
    need(m1 - m0 === 60, `第 ${a} 幕跨度 ${m1 - m0} 月（应为 60）`);
    if (a > 1) need(ACT_MONTHS[a][0] === ACT_MONTHS[a - 1][1], `第 ${a} 幕与前一幕不相接`);
  }
  need(ACT_MONTHS[7][1] === MONTHS_TOTAL, `末值 ${ACT_MONTHS[7][1]} ≠ ${MONTHS_TOTAL}`);
  need(TOTAL_YEARS === 35, `TOTAL_YEARS=${TOTAL_YEARS}`);
  need(NARRATIVE_YEARS === TOTAL_YEARS, '曲线目标里的叙事跨度与 format 不一致');
  return '2026–2061 逐幕相接';
});

probe('世界榜由玩家进度驱动（世界与日历同一真相源）', () => {
  const s = createState();
  s.lines = { r: 40, m: 40, h: 40 };
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

probe('旧版本（v18 及以前）一律判为不可迁移，给新档', () => {
  need(SAVE_VERSION === 19, `SAVE_VERSION=${SAVE_VERSION}`);
  for (const v of [1, 8, 18]) {
    need(deserialize(JSON.stringify({ version: v, act: 8, buildings: {} })) === null, `v${v} 竟然被迁移了`);
  }
  need(deserialize('{ 不是 JSON') === null, '坏 JSON 没有兜住');
  need(deserialize(null) === null, 'null 没有兜住');
  return 'v1/v8/v18 全部拒绝';
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

probe('渲染出的动作键全部落在 ACTION_KEYS 内（主界面 + 两个弹窗）', () => {
  const s = midState(4, 33);
  s.finance.rounds = ['angel', 'preA', 'a', 'b', 'c', 'preIpo', 'ipo'];
  const stray = [];
  const collect = html => {
    for (const b of buttonsIn(html)) {
      for (const k of Object.keys(b.data)) if (!ACTION_KEYS.includes(k)) stray.push(`data-${k}`);
    }
  };
  // 两个页签都要收 —— 只收当前页等于「市值榜」上的动作键从来没被审过
  collect((lookTab(s, 0), root.innerHTML));
  collect((lookTab(s, 1), root.innerHTML));
  collect((renderSettings(overlay, s), overlay.innerHTML));
  collect((renderEnding(overlay, s), overlay.innerHTML));
  collect((renderNotTop(overlay, 5), overlay.innerHTML));
  need(!stray.length, `出现了没人管的动作键：${[...new Set(stray)].join('、')}`);
  return '五个界面全部合规';
});

probe('主界面按钮齐全：三条投资线 / 三个倍速 / 设置 / 退休 / 待决两项', () => {
  const s = midState(2, 20);
  const btns = lookTab(s, 0);
  const buys = btns.filter(b => b.data.buy !== undefined);
  need(buys.length === 3, `投资线按钮 ${buys.length} 个`);
  need(LINE_IDS.every(id => buys.some(b => b.data.buy === id)), '三条线的 id 不全');
  const speeds = btns.filter(b => b.data.speed !== undefined).map(b => b.data.speed);
  need(speeds.join(',') === '1,4,8', `倍速按钮是 ${speeds.join(',')}`);
  need(btns.some(b => b.data.settings !== undefined), '缺少设置按钮 ⚙');
  need(btns.some(b => b.data.retire !== undefined), '缺少退休按钮');
  need(btns.filter(b => b.data.opt !== undefined).length === 2, '待决选项不是两项');
  const labels = visible(root.innerHTML);
  for (const l of LINES) need(labels.includes(l.name) && labels.includes(l.who), `投资线缺「${l.name}/${l.who}」`);
  return `${btns.length} 个可点元素`;
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

probe('页签：切到「市值榜」换内容，且这个态住在模块里（全量重建不丢）', () => {
  const s = midState(2, 20);
  lookTab(s, 0);
  need(root.innerHTML.includes('class="lines"') && !root.innerHTML.includes('class="rank"'),
    '「公司」页应只有投资线、没有榜单');
  const tabs = buttonsIn(root.innerHTML).filter(b => b.data.tab !== undefined);
  need(tabs.length === 2, `页签 ${tabs.length} 个（应为 2）`);
  need(visible(root.innerHTML).includes('公司') && visible(root.innerHTML).includes('市值榜'), '两个页签的文案不全');
  lookTab(s, 1);
  need(root.innerHTML.includes('class="rank"') && !root.innerHTML.includes('class="lines"'),
    '「市值榜」页应只有榜单、没有投资线');
  need(/<button class="tab on" data-tab="1">/.test(root.innerHTML), '「市值榜」页的页签没有点亮');
  // 全量重建一次：页签状态若留在 DOM 的 class 上，这一下就会弹回「公司」
  render(root, s);
  need(root.innerHTML.includes('class="rank"'), '重建一帧后页签弹回了「公司」—— 交互态没住在模块里');
  // 日志条与 HUD 跨页签常驻
  need(root.innerHTML.includes('class="log"'), '「市值榜」页把日志条弄丢了');
  need((root.innerHTML.match(/class="cell"/g) || []).length === 4, '「市值榜」页把 HUD 弄丢了');
  setTab(0);
  return '两页内容互斥 · 状态存活于重建';
});

probe('归零按钮（买不起）仍然是可点元素 —— 只是压暗', () => {
  const s = midState(2, 20);
  s.money = 0;
  const btns = lookTab(s, 0);
  const buys = btns.filter(b => b.data.buy !== undefined);
  need(buys.length === 3 && buys.every(b => !b.disabled), '买不起的投资线按钮被 disabled 了（会点不动）');
  need(root.innerHTML.includes('dim'), '买不起时没有视觉提示');
  return '不 disabled，只压暗';
});

probe('登顶即定格：界面只剩回看，且 tick 不再改变任何东西', () => {
  const s = midState(5, 40);
  s.ending = 'top';
  s.pending = [{ uid: 9, id: 'e11' }];            // 定格时连待决选项也不许点
  const btns = lookTab(s, 0);
  const frozen = btns.filter(b =>
    b.data.buy !== undefined || b.data.speed !== undefined || b.data.opt !== undefined);
  need(frozen.length === 3 + 3 + 2, `可点元素不是 8 个（实得 ${frozen.length}）`);
  need(frozen.every(b => b.disabled), '定格后仍有能点动的买卖 / 倍速 / 选项按钮');
  // 退休与设置不许禁：前者是结局弹窗的入口，后者是删档的唯一入口
  need(btns.some(b => b.data.retire !== undefined && !b.disabled), '定格把「退休」也禁掉了');
  need(btns.some(b => b.data.settings !== undefined && !b.disabled), '定格把「设置」也禁掉了');
  need(root.innerHTML.includes('已登顶 · 时间冻结'), '定格后没有挂出「已登顶 · 时间冻结」');
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
  return '8 个按钮全禁 · tick 空转';
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
    ['还差一点', () => renderNotTop(layer, 5)],
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
  const btns = lookTab(s, 0);
  const optBtn = btns.find(b => b.data.opt !== undefined);
  need(optBtn, '界面上找不到待决选项按钮');
  fire(targetOf(optBtn.data));
  need(resolved === 1, '点了选项却没有结算');
  need(s.decisions === 1, '决策计数没涨');
  need(s.pending.length === 0, '待决没有出队');
  s.money = costFor(s, 'h');
  fire(targetOf({ buy: 'h' }));
  need(bought === 1 && lineLevel(s, 'h') === 21, `投资线没买到（Lv${lineLevel(s, 'h')}）`);
  return '选项 + 投资线都点到';
});

// ═══════════════════════════ 渲染烟测 ═══════════════════════════

probe('七个阶段逐一渲染都不抛错，且都有世界榜与四格 HUD', () => {
  for (let a = 1; a <= 7; a++) {
    // ⚠️ 这里**不 tick**：tick 会因为市值超门槛自动推幕，测不到「第 a 幕长什么样」
    const s = createState();
    s.stage = a;
    s.lines = { r: a * 4, m: a * 4, h: a * 4 };
    lookTab(s, 1);
    const html = root.innerHTML;
    need(html.includes('世界市值榜'), `第 ${a} 幕没有世界榜`);
    need(html.includes('单位：万亿美元'), `第 ${a} 幕榜单没有单位标签`);
    need((html.match(/class="cell"/g) || []).length === 4, `第 ${a} 幕 HUD 不是四格`);
    need(html.includes(ACTS[a].place), `第 ${a} 幕没显示地点（${ACTS[a].place}）`);
    need(visible(html).includes(ACTS[a].goal), `第 ${a} 幕没显示目标`);
    // 投资线在「公司」页 —— 两页都要看一眼，不能只验其中一页
    lookTab(s, 0);
    need((root.innerHTML.match(/class="line"/g) || []).length === 3, `第 ${a} 幕投资线不是三条`);
  }
  setTab(0);
  return '1–7 幕全部可渲染';
});

probe('创始人只出现在文案里，不进任何公式', () => {
  need(FOUNDERS.length === 3, `创始人有 ${FOUNDERS.length} 位`);
  for (const f of FOUNDERS) {
    need(typeof f.name === 'string' && f.name, `${f.id} 没有名字`);
    need(!('skill' in f) && !('hp' in f) && !('mood' in f), `${f.id} 还挂着已删系统的字段`);
  }
  const ages1 = agesAt(1);
  const ages7 = agesAt(7);
  need(startYearOf(7) - startYearOf(1) === 30, '幕首年份跨度不是 30 年');
  need(ages7.zhong === ages1.zhong + 30, '年龄没有随阶段推进');
  const html = (render(root, midState(3, 30)), root.innerHTML);
  need(FOUNDERS.every(f => html.includes(f.name)), '主界面没有展示创始人');
  // 三人名不进 rates：改名后速率必须一模一样
  const s = midState(3, 30);
  const before = JSON.stringify(rates(s));
  FOUNDERS[0].name = 'X';
  const after = JSON.stringify(rates(s));
  FOUNDERS[0].name = '老钟';
  need(before === after, '改了创始人名字，速率竟然变了 —— 他进公式了');
  return `年龄 ${ages1.zhong}→${ages7.zhong}`;
});

probe('结局弹窗与「还差一点」弹窗都有关闭按钮', () => {
  const s = midState(7, 160);
  renderEnding(overlay, s);
  need(visible(overlay.innerHTML).includes(ENDING_TEXT.top.title), '结局标题不对');
  need(lookOverlay(overlay.innerHTML).some(b => b.data.close !== undefined), '结局弹窗没有关闭按钮');
  renderNotTop(overlay, 3);
  need(visible(overlay.innerHTML).includes('世界第'), '未登顶提示没有写明名次');
  need(lookOverlay(overlay.innerHTML).some(b => b.data.close !== undefined), '未登顶弹窗没有关闭按钮');
  return '两个弹窗都可关';
});

probe('日志裁剪：不超过上限，且开局那句一定在', () => {
  const s = A.s;
  need(s.log.length <= LOG_MAX, `日志 ${s.log.length} 条 > 上限 ${LOG_MAX}`);
  need(s.log.some(t => t.includes('登顶')), '终局日志里没有登顶那条');
  need(s.log.some(t => t.includes('【第')), '日志里没有年度报告');
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

probe('验收带宽自洽：A 档 ⊆ [3,6]、D 档 ⊆ [3,18]、目标合计 = 4.8h', () => {
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

probe('曲线目标与内容表一致：七幕门槛严格递增、代际 ×1.5', () => {
  need(GENERATION === 1.5, `GENERATION=${GENERATION}`);
  need(ACTS[7].mcap / ACTS[1].mcap > 1e9, '七幕跨度太小');
  const genSum = LINES.length;   // 三条线共用同一个 g ⇒ 只需要一个 cost(n)
  need(genSum === 3, '投资线不是三条');
  need(Math.abs(LINE_GROWTH - CURVE_RATIO ** (1 / 3)) < 1e-12, 'g ≠ r^(1/3)');
  need(SEC_PER_YEAR * TOTAL_YEARS / 3600 > 0, 'SEC_PER_YEAR 与年数不自洽');
  need(INCOME_SCALE > 0 && costOf(0) > 0, '开局系数非法');
  return `g=${LINE_GROWTH.toFixed(4)}`;
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
  // 首帧落在「公司」页：投资线在、榜单不在（榜单在「市值榜」页，由页签探针覆盖）
  need(html.includes('class="lines"'), '首帧没有渲染出投资线（「公司」页）');
  const btns = buttonsIn(html);
  need(btns.filter(b => b.data.buy !== undefined).length === 3, '首帧没有三条投资线按钮');
  need(btns.filter(b => b.data.tab !== undefined).length === 2, '首帧没有两个页签');
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
