/**
 * 游戏内容总览（`npm run content`）
 * ===============================================================
 * 把散在内容模块（`event-data` / `content` / `endings`）里的**全部文本**按系统摊开，
 * 让作者能一次通读，而不是在几个文件之间来回跳。
 *
 * 它同时做 4 项自动检查（这些是「人眼通读容易漏、机器一眼就抓到」的）：
 *   ① 空字段 / 未填的占位
 *   ② 完全重复的正文
 *   ③ 过短的正文（写手最常留的坑：标题写了正文忘了）
 *   ④ 标点混用（中文行里出现半角逗号/句号，或结尾不加句号）
 *
 * 用法：
 *   npm run content            只看统计与检查结果
 *   npm run content events     只看事件
 *   npm run content all        全部摊开（很长）
 */

import { DAILY, CHOICE, MILESTONE } from '../src/core/event-data.js';
import { ENDING_TEXT } from '../src/core/endings.js';
import {
  ACTS, ACT_NARRATION, BUILDINGS, BY_ID, STAFF, ROLES, SKILLS, FOUNDERS,
  ROUTES, TECH_CHOICES, CONTRACT_TIERS, CLIENTS, FORMS, QUOTES, ENDINGS,
  CLIENT_NAMES, FORM_FITS,
} from '../src/core/content.js';
import { artOf } from '../src/core/art.js';

const arg = (process.argv[2] || '').toLowerCase();
const want = s => arg === 'all' || arg === s;

const line = (n = 60) => console.log('  ' + '─'.repeat(n));
const head = t => { console.log(''); line(); console.log(`  ${t}`); line(); };
const quote = t => String(t || '').split('\n').forEach(l => console.log(`    │ ${l}`));

// ═══════════════════════ 自动检查 ═══════════════════════
const problems = [];
const allTexts = [];

/** 收集「一段需要人写的东西」 */
function collect(where, id, text, { min = 4 } = {}) {
  const t = String(text ?? '').trim();
  if (!t) problems.push(`【空正文】${where} · ${id}`);
  else {
    if (t.length < min) problems.push(`【过短】${where} · ${id}：「${t}」（${t.length} 字）`);
    // 中文行里混用半角标点（排除英文缩写、数字、代码）
    if (/[\u4e00-\u9fa5]/.test(t) && /[\u4e00-\u9fa5][,;:!?]/.test(t)) {
      problems.push(`【标点】${where} · ${id}：中文里混了半角标点 —— 「${t.slice(0, 40)}」`);
    }
    allTexts.push({ where, id, t });
  }
}

/**
 * 叙事正文里的**系统术语**。
 *
 * 「不解释玩法」之外还要守住一条：**叙事不提系统语言**。
 * 玩家读到「某个组的等级第一次到了 5」会立刻出戏 ——
 * 「组」「等级」是界面上的概念，不是这个世界里的人会说的话。
 * 好的写法给画面（「他们不再需要你手把手带了」），坏的在报数值。
 *
 * ⚠️ 只查**正文**不查标题：里程碑的标题本来就会写数字（「市值过亿」「声誉到了 100」），
 *    那是刻意的「达成提示」，不算出戏。
 */
// ⚠️ 只留「在这个项目里**只能**是系统含义」的词。
//   「产出」「效率」不放进来 —— 它们是普通商务用语
//   （如 c17「产出不会体现在财报上」），放进来会假阳性。
const SYSTEM_WORDS = ['等级', '忠诚', '乘数', '冷却'];
function checkSystemWords(where, id, text) {
  const hit = SYSTEM_WORDS.filter(w => String(text || '').includes(w));
  if (hit.length) problems.push(`【系统术语】${where} · ${id}：正文里出现「${hit.join('、')}」—— ${text}`);
}

console.log('');
console.log('  📖 游戏内容总览');
console.log(`  运行时间 ${new Date().toLocaleString('zh-CN')}`);

// ── ① 八幕 ──
head('① 八幕（地点 / 年份 / 地标 / 幕启幕落 / 市值门槛）');
for (let a = 1; a <= 8; a++) {
  const A = ACTS[a];
  const n = ACT_NARRATION[a] || {};
  console.log(`  ${a}幕 · ${A.place}｜${A.years}｜地标「${(BY_ID[A.landmark] || {}).name || A.landmark}」`);
  console.log(`     幕启：${n.open || '（缺）'}`);
  console.log(`     幕落：${n.close || '（缺）'}`);
  // 市值门槛（第一批 §5）：达成即自动进入下一幕，所以它是这一刻度的唯一判据。
  // 第 8 幕是最后一幕（canAdvance 在 s.act >= 8 时恒 false），不存在「第 9 幕」。
  console.log(a < 8
    ? `     市值门槛：市值 ≥ ${A.mcap.toExponential(2)} 即自动进入第 ${a + 1} 幕`
    : `     市值门槛：市值 ≥ ${A.mcap.toExponential(2)}（第 8 幕是最后一幕，不会自动推进）`);
  collect('幕次叙事', `${a}幕·幕启`, n.open);
  collect('幕次叙事', `${a}幕·幕落`, n.close);
}

// ── ② 创始人 / 技能 ──
head('② 三位创始人 · 技能');
for (const f of FOUNDERS) {
  const sk = SKILLS[f.id] || {};
  const p = sk.passive || {};
  const act = sk.active || {};
  console.log(`  ${f.name}（${f.birth} 年生 · ${f.skill} · ${f.bonus}）`);
  // 被动只留名字：`passive.desc` 已于 2026-09-26（第二批 §5）从 content.js 删除 ——
  // 技能行右侧那行说明现在写的是「剩余 X 分」（唯一一段倒计时），效果文案不再展示。
  // ⚠️ 第三批：小朱的被动「稳定之手」随健康 / 心气一起删（N2 ②：它已永不可能成立）。
  if (p.name) console.log(`     被动「${p.name}」`);
  console.log(`     主动「${act.name || '—'}」：${act.desc || '—'}` +
    `（冷却 ${act.cdSec ? (act.cdSec / 60) + ' 分' : '—'}）`);
  collect('技能', `${f.name}·主动`, act.desc);
}
for (const [id, g] of Object.entries(ROLES)) {
  console.log(`  晋升 · ${g.name}：${g.effect}`);
}

// ── ③ 建筑 ──
head(`③ 建筑（${BUILDINGS.length} 座）`);
for (let a = 1; a <= 8; a++) {
  const list = BUILDINGS.filter(b => b.act === a);
  if (!list.length) continue;
  console.log(`  ${a}幕：${list.map(b => b.name + (b.kind === 'landmark' ? '(地标)' : '')).join('、')}`);
}

// ── ④ 事件 ──
const evAll = [
  ['日常', DAILY], ['抉择', CHOICE], ['里程碑', MILESTONE],
];
head(`④ 事件（日常 ${DAILY.length} / 抉择 ${CHOICE.length} / 里程碑 ${MILESTONE.length}）`);
for (const [kind, list] of evAll) {
  console.log(`  ── ${kind}（${list.length} 条）──`);
  for (const e of list) {
    collect('事件', `${kind}·${e.id}`, e.text);
    checkSystemWords('事件', `${kind}·${e.id}`, e.text);
    if (want('events') || want('events_' + kind)) {
      console.log(`   ▸ ${e.title}`);
      quote(e.text);
      if (e.options) e.options.forEach((o, i) => console.log(`       [${i}] ${o.label} —— ${o.hint || ''}`));
      if (e.eff) console.log(`       eff: ${JSON.stringify(e.eff)}`);
    }
  }
  const noTitle = list.filter(e => !e.title).length;
  const short = list.filter(e => (e.text || '').length < 12).length;
  console.log(`     总 ${list.length} 条｜缺标题 ${noTitle}｜正文 <12 字 ${short}`);
}

// ── ⑤ 结局 ──
// ⚠️ 第三批（结局收敛，2026-09-26）：全游戏**只剩一个**结局 —— 公司成为世界第一市值的公司。
//    散伙 / 破产 / 各路线分支结局与 `FAILURE` 常量一起删除（破产只保留可恢复的减速压力 PRESSURE）。
//    这里的统计口径也随之简化：不再分「主 N + 失败 M」。
head(`⑤ 结局（${Object.keys(ENDINGS).length} 个：认公司成为世界第一市值才触发）`);
for (const [k, v] of Object.entries(ENDINGS)) {
  const t = ENDING_TEXT[k] || {};
  console.log(`  ▸ ${t.title || k}`);
  collect('结局', k + '·line', t.line, { min: 6 });
  collect('结局', k + '·body', t.body, { min: 20 });
  if (want('endings') || want('all')) { quote(t.line); quote(t.body); }
}

// ── ⑥ 合同 ──
/**
 * 客户名真实性检查。
 * 作者要求：**游戏内出现的公司都应当是现实中存在（或存在过）的**。
 * 「一家 XX」「某 XX」这类是**编造的类别描述**，不算真名 —— 扫出来给作者看。
 *
 * ⚠️ 只查客户名，不查叙事正文：正文里「一位老员工」「楼下便利店」是正常的人物/场景描写，
 *    它们不是「公司名」，不该被这条规则管。
 */
{
  const FICTION = /一家|某个|某家|那家|一家|XX|某某/;
  for (const [cat, bands] of Object.entries(CLIENT_NAMES)) {
    for (const [band, names] of Object.entries(bands)) {
      for (const n of names) {
        if (FICTION.test(n)) {
          problems.push(`【虚构名】客户 ${cat}/${band}：「${n}」—— 应换成真实存在的公司`);
        }
      }
    }
  }
  // 国际覆盖：intl 一栏要有足够的地区和量级
  const intlCount = Object.values(CLIENT_NAMES.intl || {}).reduce((a, v) => a + v.length, 0);
  console.log(`  国际客户名 ${intlCount} 个（覆盖东南亚/南亚 · 日欧 · 全球巨头）`);
  if (intlCount < 15) problems.push(`【国际覆盖】intl 只有 ${intlCount} 个名字，偏少`);
}
head('⑥ 合同：等级 / 客户 / 形态 / 报价话术');
console.log(`  等级 ${CONTRACT_TIERS.length}：${CONTRACT_TIERS.map(t => t.name || t.id).join('、')}`);
console.log(`  客户 ${CLIENTS.length}：${CLIENTS.map(c => c.name).join('、')}`);
console.log(`  形态 ${FORMS.length}：${FORMS.map(f => f.name).join('、')}`);
console.log(`  报价话术 ${QUOTES.length} 条：`);
// 只有 3 条，一律显示（原来只在 want('contracts') 时显示，看上去像「3 条但一条都没印出来」）
QUOTES.forEach(q => console.log(`    · ${typeof q === 'string' ? q : (q.text || q.label || JSON.stringify(q))}`));

/**
 * 可行域审计（2026-09-25 修「永辉超市买芯片」）：
 * 列出所有**真的会出现**的 (等级 × 客户类别 × 形态) 组合。
 * 判据是「客户类别的 tiers 里有这个等级」且「FORMS_FITS[类别] 里有这个形态」——
 * 与 `contracts.makeOffer` 的抽法完全一致，所以这里印出来的就是玩家会看到的。
 */
{
  console.log('  可行域（等级 × 类别 → 形态）：');
  for (const t of CONTRACT_TIERS) {
    for (const c of CLIENTS) {
      if (c.tiers && !c.tiers.includes(t.id)) continue;                    // 这类客户接不起这个等级
      const ok = FORM_FITS[c.id];
      const fs = ok ? FORMS.filter(f => ok.includes(f.id)) : FORMS;
      console.log(`    · ${t.id.padEnd(2)} × ${c.name} → ${fs.map(f => f.name).join('、')}`);
    }
  }
  // 反向检查：不该存在的组合，必须真的不存在
  const impossible = [
    ['small', 'S', '小客户不该接到 S 级'],
    ['small', 'ST', '小客户不该接到最高级'],
    ['small', 'cobuild', '小客户不该「一起研发」'],
    ['small', 'floor', '小客户不该有「保底单」'],
  ];
  for (const [cat, key, why] of impossible) {
    const c = CLIENTS.find(x => x.id === cat);
    const isTier = !!CONTRACT_TIERS.find(t => t.id === key);
    const hit = isTier
      ? (c.tiers && c.tiers.includes(key))
      : (FORM_FITS[cat] || []).includes(key);
    if (hit) problems.push(`【可行域】${cat} × ${key} 仍然可能出现 —— ${why}`);
  }
  if (problems.some(p => p.startsWith('【可行域】'))) {
    console.log('    ⚠️ 可行域异常，见下方问题列表');
  } else {
    console.log('    ✓ 不存在 small × S/ST、small × cobuild/floor');
  }
}

// ── ⑦ 路线抉择 ──
head('⑦ 路线抉择（每幕三条）');
TECH_CHOICES.forEach((row, act) => {
  if (act === 0 || !row) return;
  const three = ['tech', 'biz', 'org'].map(k => `${ROUTES[k].label}：${row[k] || '—'}`);
  console.log(`  ${act} 幕：${three.join(' ｜ ')}`);
});

// ── ⑧ ASCII 插画 ──
/**
 * 字符的**显示宽度**（等宽字体下的列数）。
 * ⚠️ 不能用 `str.length` —— 中文与全角标点是**双宽**，一个字符占两列。
 * 这正是插画能不能对齐的判据（先前我用「是不是制表符/方块」来判，判错了方向）。
 */
const dw = ch => {
  const c = ch.codePointAt(0);
  const wide = (c >= 0x1100 && c <= 0x115f)
    || c === 0x2329 || c === 0x232a
    || (c >= 0x2e80 && c <= 0xa4cf)
    || (c >= 0xac00 && c <= 0xd7a3)
    || (c >= 0xf900 && c <= 0xfaff)
    || (c >= 0xfe30 && c <= 0xfe6f)
    || (c >= 0xff00 && c <= 0xff60)
    || (c >= 0xffe0 && c <= 0xffe6)
    || (c >= 0x20000 && c <= 0x3fffd);
  return wide ? 2 : 1;
};
const widthOf = s => [...s].reduce((a, ch) => a + dw(ch), 0);

head('⑧ ASCII 插画');
for (const k of ['desk', 'server', 'bell', 'door']) {
  const a = artOf(k);
  if (!a) { console.log(`  ${k}：（缺失）`); continue; }
  const lines = a.split('\n');
  const widths = lines.map(widthOf);
  console.log(`  ${k}：${lines.length} 行 ｜ 各行显示宽度 ${widths.join('/')} 列`);
  /**
   * ⚠️ 这条检查**不能**写成「各行宽度必须一致」—— 那是假阳性：
   *   · `bell` 是钟的**轮廓**，本来就是上窄下宽，宽度不一致正是它要的效果；
   *   · `desk` / `door` 的说明文字在图**下方**，差 1 列无所谓。
   * 真正要抓的是：**有内容明显戳出画框**。
   * 所以拿「画框行的最大宽度」当基准，只有**超出 2 列以上**才算问题。
   */
  const frameMax = Math.max(...widths.filter(w => w <= Math.min(...widths) + 4));
  const over = widths.filter(w => w > frameMax + 2);
  if (over.length) {
    problems.push(`【插画】${k}：有 ${over.length} 行显示宽度 ${over.join('/')} 列，`
      + `超出画框 ${frameMax} 列 —— 右边缘会被戳出来（多半是汉字「双宽」造成的）`);
  }
  if (want('art') || want('all')) lines.forEach(l => console.log(`    │${l}│  (${widthOf(l)} 列)`));
}

// ═══════════════════════ 检查结果 ═══════════════════════
head('🔍 内容自动检查');
const dup = new Map();
for (const t of allTexts) {
  const key = t.t;
  if (!dup.has(key)) dup.set(key, []);
  dup.get(key).push(`${t.where}·${t.id}`);
}
const dups = [...dup.entries()].filter(([, v]) => v.length > 1);
if (dups.length) {
  console.log(`  ⚠️  完全重复的正文 ${dups.length} 组：`);
  for (const [t, where] of dups) console.log(`      「${t.slice(0, 30)}」← ${where.join(' / ')}`);
  console.log('');
}
if (problems.length) {
  console.log(`  ⚠️  共 ${problems.length} 条待看：`);
  for (const p of problems.slice(0, 40)) console.log(`      ${p}`);
  if (problems.length > 40) console.log(`      …还有 ${problems.length - 40} 条`);
} else {
  console.log('  ✅ 没有空正文 / 过短正文 / 中文半角标点 / 插画宽度问题');
}

const totalChars = allTexts.reduce((a, t) => a + t.t.length, 0);
console.log('');
console.log(`  正文总量：${allTexts.length} 段 · ${totalChars} 字 · 平均 ${(totalChars / allTexts.length).toFixed(1)} 字/段`);
console.log(`  （想看全文：npm run content events|endings|contracts|art|all）`);
console.log('');
