/**
 * ══════════════ UI 截图检查 ══════════════
 *
 * 为什么需要它：check / click / probe 全都跑在 DOM stub 里，**看不见排版**——
 * 「按钮换行」「文字叠在一起」「日志压住内容」这类问题只有真浏览器渲染才发现。
 * 本工具用 Playwright(Chromium) 把 dist 挂在真实部署路径 /studio/ 下，
 * 对 手机 / 桌面 × 新档（四页签）/ 末期存档（**只截市值榜**，见下）各截一张图，
 * 存到 `.codebuddy/ui-shots/`。
 *
 * ⚠️ 2026-09-28：末期档是**第 8 幕**，而第 8 幕起进了**冲刺段**（`engine.isSprint`）——
 *    界面被锁在市值榜、其余三个页签 `disabled`（用户诉求 #9：「登顶前无法操作，但能选择加速」）。
 *    所以末期档只有市值榜那一页是**可达**的，另外三页截图已无意义（点了也停在市值榜），
 *    这里改成只截市值榜，并**反过来断言**另外三个页签确实点不动 —— 冲刺段这道闸门
 *    因此也被真浏览器覆盖到。（新档那四页照旧，冲刺段只发生在第 8 幕。）
 *
 * late 模式注入一份第 8 幕的大数值存档 —— 验证「¥2500.00万亿」这种量级
 * 在 HUD / 榜单里不折行、不溢出（用户要求：数字变动之后不能换行）。
 * ⚠️ 那个量级的样本由 `hudCells` **合成**，不靠档里的真实现金 —— 真实现金必须小到
 *    `autoBuy` 买不动，理由见 `lateSaveJson`（现金一大，档会自己登顶、截图就变了样）。
 * ⚠️ 它**不是**「名次 > 20、截图里能看到钉底玩家行」的样本 —— 那份档实测名次 **6**，
 *    玩家行就排在榜内第 6 行（`render.rankBlock` 只在 `rank > RANK_SHOW(20)` 时才另起
 *    一个 `⋯` + 玩家行钉在榜底）。而且「第 8 幕 ∩ 名次 > 20」在真局里**不存在**：
 *    第 8 章门槛 187 万亿元，当时榜上第 20 名才 1.5 T USD（≈11 万亿元）—— 进第 8 章的人
 *    早就是第一了。所以这个钉底分支**只由 `probes.mjs` 的 DOM 桩覆盖**（「上市且名次 > 20
 *    时钉底」那条），截图这边照不到，这里如实记下、不再假装覆盖到。
 *    （2026-09-28 用户拍板：只把注释改准，不下调等级去凑那个名次。）
 *
 * 用法：先 `npm run build`，再 `node tools/ui-shots.mjs`
 * （无头截图是纯布局检查——看结构，不看美术。）
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createState, serialize, SAVE_KEY } from '../src/core/state.js';
import { LINE_IDS, ACTS } from '../src/core/content.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, '.codebuddy', 'ui-shots');
const PREFIX = '/studio/';                       // 与真实部署路径一致
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

/**
 * 末期存档：第 8 章、五条线各 Lv120、已上市。
 * 载入市值 **¥42.05 万亿元 = 5.84 万亿 USD** —— 足够大（HUD 市值格出现「万亿」），
 * 又不至于登顶（第 426 月榜首实测 14.12 T USD，这份档只到它的 41%）；实测名次 **6**。
 * ⚠️ 章次是**手工写 8** 的，不是算出来的：42 万亿元只够到第 7 章（门槛 `ACTS[7].mcap`
 *    = 2.59e13 元），写 8 是为了让截图覆盖**最终章**的界面 —— 五条线的终章名称、
 *    八条推幕行、HUD 目标「登顶世界第一」。`advanceStage` 只升不降，所以这个 8 会一直留着。
 * ⚠️ 五条线**同级**（`g^ΣL` 只由 ΣL 决定，所以加线不改市值）；漏掉 c/d 会少两个因子。
 * ⚠️ 章次是 8 ⇒ 页头品牌与榜单玩家行都取 `content.NAME_TIERS[8]` = **`AbstrO`**（不是 `Abstract Inc`）——
 *    公司名自 2026-09-28 起按**章**查表（五段阶梯），这些字符串都随本档的 `s.stage` 走。
 */
function lateSaveJson() {
  const s = createState();
  s.stage = 8;
  s.lines = Object.fromEntries(LINE_IDS.map(id => [id, 120]));
  /**
   * ⚠️ **现金必须小到买不动**（2026-09-28 修，用户报「截图里怎么是 3000 万亿美元」）。
   *
   * `autoBuy` 的门槛是 `可动用 = 现金 × (1 − RESERVE_FRAC) = 现金 × 0.2 ≥ K × 单价`
   * （`K = autoBuyReserveOf = 2`，已上市）⇒ **现金 ≥ 10 × cost(120) 就会开买**，
   * 而 `cost(120) = 2.05e10 元` ⇒ 门槛是 **2.05e11 元（205 亿元）**。
   * 原来的 `2.5e15` 是这条门槛的 **12000 倍** ⇒ 页一打开（约 1.5 s）就狂买了 321 级，
   * 市值从 5.85 T 冲到 **14961 T** 并**直接登顶**：截图里于是出现了 `3054.71` 的玩家行
   * 和一块「退休」横条 —— 而这份档自己灌进去的日志恰恰写着「不要走到这里」。
   *
   * 现在取 `5e10`（500 亿元）：不到门槛的四分之一。
   * ⚠️ **开销不止营收**：实测这份档一进来就会触发一条年度决策（`eff.cash = 0.1`，效果按
   *    `年营收 × cash` 折算 ⇒ **+840 亿元**，与年营收同阶）。所以要按
   *    `500 + 840 = 1340 亿 < 2050 亿` 来配 —— 取 1.5e11 就会被那一下推过门槛，
   *    实测买了 5 级（ΣL 600 → 605，市值 5.72 → 6.32 T）。
   * ⚠️ 取 `5e10` 后**不是一格不买**：实测 90 tick 买了 1 级、300 tick 共 2 级
   *    （ΣL 600 → 602，5.85 → 5.96 T，`rank` 6），之后现金回落到门槛下方就彻底静止
   *    （600 tick 与 300 tick 的 ΣL 都是 602）。**没有登顶**，这才是这条注释要保的东西。
   *
   * ⚠️ 副作用（不是取舍，是算术上就不可能）：HUD 现金格不会再有「万亿」量级的样本。
   *   `市值 ÷ 单价 ≈ 2051` 是个**常量** —— 五条线的 `cost ∝ r^n = g^(5n)`，
   *   而 `市值 ∝ g^(ΣL)`，两条曲线同底同指数。所以「现金 ≥ 10 × 单价」等价于
   *   「现金 ≥ 市值 ÷ 205」。要让现金显示到 1 万亿美元，市值得先有 205 万亿美元，
   *   而第 426 月的榜首才 14.12 T ⇒ **任何现金上万亿的档，必然已经登顶**。
   *   「大数值不折行」因此由 `市值 / 年营收` 两格（实测 ¥42.05万亿 / ¥836.37亿）
   *   与下面 `hudCells` 的合成文本（`¥2500.00万亿`）一起覆盖，不靠这份档的真实现金。
   */
  s.money = 5e10;
  s.finance = { rounds: ['angel', 'preA', 'a', 'b', 'c', 'preIpo', 'ipo'] };
  /**
   * ⚠️ 这条原来写的是 `【登顶】不要走到这里 —— 这份档停在名次 10 名之外。`
   *    两处都是假的：档实测名次 6，而且它**本来就不该登顶**（登顶了下面的守卫会报红）。
   *    在一份「不许登顶」的档里塞一条【登顶】流水，等于给截图留一句自己拆自己台的话。
   *    换成一条 `cycleNotes` 真会发出的【大盘】文案（第 396 月见底那句），
   *    颜色档（`render.LOG_TAGS`）也照旧被覆盖到（用户 2026-09-28 拍板「只把注释改准」）。
   */
  s.log.push('【大盘】估值水位见底，被砍最狠的先动。');
  s.log.push('【IPO】到账 1.23万亿（公开发行）');
  s.log.push('（回忆）对面那栋楼挂上了寒武纪的牌子。');
  /**
   * **八条推幕行全部灌进来**（用户 2026-09-27 拍板「可加年份 / 字可以短一些」）。
   * 一局真实跑到第 8 章要好几个小时，截图检查等不到，所以这里直接按 `engine.advanceStage`
   * 的同一拼法把八条都写进流水 —— 这样下面那条「日志一行放得下」的像素断言才能**八条全量**量到，
   * 而不是只量到开局那一两条。（拼法与线上同源：`ACTS[].years` 前四位 + 地名 + `open`。）
   */
  for (const a of ACTS.filter(Boolean)) s.log.push(`${a.years.slice(0, 4)}年【${a.place}】${a.open}`);
  return serialize(s);
}

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (!p.startsWith(PREFIX)) { res.writeHead(404); res.end(); return; }
  p = p.slice(PREFIX.length) || 'index.html';
  try {
    res.writeHead(200, { 'Content-Type': MIME[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream' });
    res.end(await readFile(join(DIST, p)));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },   // iPhone 12/13/14
  { name: 'desktop', width: 1280, height: 800 },
];

/** 四个页签各截一张 —— 只截一个页签等于另外几页的排版从来没被看过 */
const TABS = [
  { name: 'founder', label: '创始人', idx: 0, want: { lines: true, rank: false, orders: false } },
  { name: 'co', label: '公司', idx: 1, want: { lines: true, rank: false, orders: false } },
  { name: 'order', label: '订单', idx: 2, want: { lines: false, rank: false, orders: true } },
  { name: 'rank', label: '市值榜', idx: 3, want: { lines: false, rank: true, orders: false } },
];

let fails = 0;
for (const vp of VIEWPORTS) {
  for (const era of ['fresh', 'late']) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    // late 模式：**应用启动前**注入末期存档。
    // ⚠️ 不能 goto 之后再用 localStorage.setItem + reload —— reload 会触发
    //    beforeunload 自动存盘，把注入的档**覆盖回新档**（和删档是同一个坑）。
    if (era === 'late') {
      const json = lateSaveJson();
      await ctx.addInitScript(([key, j]) => localStorage.setItem(key, j), [SAVE_KEY, json]);
    }

    await page.goto(base);
    await page.waitForTimeout(400);                 // 等 draw() 至少跑两帧（150ms 全量重建）
    /**
     * 点掉任何遮罩 —— 那层 `rgba(0,0,0,.6)` 会把整页压暗、排版看不清。
     * ⚠️ 2026-09-28 更正：末期档**不再**会自己爬到 #1（现金已配到 `autoBuy` 门槛之下，
     *    理由见 `lateSaveJson`），所以这里点的是**离线报告**这类开局就会弹的窗；fresh 档本无弹窗。
     *    之所以仍然循环点 —— 弹窗什么时候冒出来并不确定（比如正好在「点掉上一张」之后），
     *    点到遮罩真的没了为止。
     */
    const dismissModal = async () => {
      for (let i = 0; i < 6; i++) {
        const shown = await page.evaluate(() => {
          const ov = document.querySelector('#overlay');
          if (!ov || getComputedStyle(ov).display === 'none') return false;
          const el = ov.querySelector('[data-close]');
          if (el) el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
          return true;
        });
        if (!shown) return;
        await page.waitForTimeout(200);
      }
    };

    /**
     * HUD **同一行两格等高、且不随文字变化**（用户 2026-09-27：「现金那一格会随文字变化跳动
     * 格子高度……我要确保所有的框都是固定的」）。
     * 光量「当前高度」抓不住这个 bug（两帧都是短数字，看不出来），所以量两次：
     *   ① 当前高度 —— **上行两格（现金 / 市值）必须相等，下行两格（净利率＋世界 / 目标）必须相等**。
     *      上行 4 行（可动用 / 储备、年营收 / 相比上月）、下行 3 行 ⇒ 行高约 `90px` / `74px`
     *      （2026-09-28 前是四格一律 `90px`，用户「第三个和第四个 UI 框可以把高度缩小了，
     *      因为现在没有第四行了」之后改成上行 4 行预算、下行 3 行预算）。
     *      ⚠️ **不断言上下行相等**：那正是本次要取消的东西。跨行相等也不再是需求 ——
     *      锁的是「同一 grid 行里不许被最高的那格撑开、且不许随字数变」。
     *   ② 把每个数值行 / 副行换成**最长的现实文本**（`¥2500.00万亿`）后再量 —— 高度必须一模一样。
     *      这条才是真断言：格子一旦跟着字数长高，这里立刻红。
     * ⚠️ 只塞 `b` / `u`，不碰 `i`：标签行没有 `nowrap`，塞超长串会自己折行，那是假阳性。
     * ⚠️ **fresh 档的市值格现在是骨架态**（大字 `—`、`PE —`，天使轮到账后才解锁，见 `render.hud`）——
     *    行高断言不受影响正因为它会把每个 `b` 都换成 `¥2500.00万亿` 再量，与档里原本是 `—` 还是数值无关。
     */
    const hudCells = await page.evaluate(() => {
      const cells = [...document.querySelectorAll('.hud .cell')];
      const before = cells.map(c => Math.round(c.getBoundingClientRect().height));
      for (const el of document.querySelectorAll('.hud .cell b')) el.textContent = '¥2500.00万亿';
      for (const el of document.querySelectorAll('.hud .cell u')) el.textContent = '可动用 ¥2500.00万亿';
      const after = cells.map(c => Math.round(c.getBoundingClientRect().height));
      return { before, after };
    });
    if (hudCells.before.length !== 4) {
      console.log(`  ❌ HUD 格数不是 4（量到 ${hudCells.before.length}）`); fails++;
    } else {
      const [r1a, r1b, r2a, r2b] = hudCells.before;
      if (r1a !== r1b) { console.log(`  ❌ HUD 上行两格不等高：现金 ${r1a} / 市值 ${r1b}`); fails++; }
      if (r2a !== r2b) { console.log(`  ❌ HUD 下行两格不等高：世界 ${r2a} / 目标 ${r2b}`); fails++; }
      if (!(r2a < r1a)) { console.log(`  ❌ HUD 下行没有比上行矮（${r2a} ≥ ${r1a}）—— 3 行预算没生效`); fails++; }
    }
    if (hudCells.before.join() !== hudCells.after.join()) {
      console.log(`  ❌ HUD 高度随文字变长而变：${hudCells.before.join('/')} → ${hudCells.after.join('/')}`); fails++;
    }

    /**
     * **每一条日志都必须一行放得下** ——
     * 推幕行（`2030年【车库】…`，用户 2026-09-27 拍板 #1 时的原话：「字可以短一些（确保手机端
     * 日志栏一行能够显示不换行就行）」）与周期播报（`【黑天鹅】/【大盘】/【轮动】`，同日
     * 「30 条既有周期播报可以顺手收短」）走同一条闸门。
     *
     * 判据不能是「有没有换行」—— 块级元素里文字换行**根本不会造成横向溢出**，
     * `scrollWidth > clientWidth` 那一套完全看不见，所以反过来量：
     * 把这条日志**按现在的字体强行写成一行**，看它需要多宽，再比这一行的实际可用宽。
     *
     * ⚠️ 克隆体不能直接挂到 `body` 下就量：`.log .li` 是**后代选择器**，脱离了 `.log` 就吃不到
     *    12px，会按 body 的 14px 算（偏大），把本来放得下的行报成红。所以字体四个属性显式抄过去。
     * ⚠️ 量的是 `clientWidth`（不是 `offsetWidth`）：日志条 `overflow-y: auto`，桌面端会占掉一条
     *    滚动条宽度 —— 那正是真实可用宽，少算反而会放过真换行的行。
     */
    const logFit = await page.evaluate(() => {
      const bad = [];
      let opening = 0, width = 0;
      for (const el of document.querySelectorAll('.log .li')) {
        const t = el.textContent.trim();
        if (!t) continue;
        if (/^\d{4}年【/.test(t)) opening++;          // 推幕行：年份 + 地名 + 专属开场
        const cs = getComputedStyle(el);
        const probe = document.createElement('div');
        probe.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:nowrap;visibility:hidden';
        probe.style.fontSize = cs.fontSize;
        probe.style.fontWeight = cs.fontWeight;
        probe.style.fontFamily = cs.fontFamily;
        probe.style.letterSpacing = cs.letterSpacing;
        probe.textContent = t;
        document.body.appendChild(probe);
        const need = Math.ceil(probe.getBoundingClientRect().width);
        probe.remove();
        width = Math.max(width, need);
        const have = el.clientWidth;
        if (need > have) bad.push(`「${t}」需 ${need}px / 可用 ${have}px`);
      }
      return { bad, opening, width };
    });
    // 只列前 5 条：真出问题的时候，一屏 30 行会把别的结论淹掉
    for (const o of logFit.bad.slice(0, 5)) { console.log(`  ❌ 日志一行放不下：${o}`); }
    if (logFit.bad.length > 5) console.log(`  ❌ 另有 ${logFit.bad.length - 5} 条同样放不下（共 ${logFit.bad.length} 条）`);
    fails += logFit.bad.length;
    // 末期档里那 8 条推幕行是**灌进去的**（`lateSaveJson`），量不到就说明样本没生效
    if (era === 'late' && logFit.opening < 8) {
      console.log(`  ❌ 末期档里只量到 ${logFit.opening} 条推幕行（应 8 条）—— 样本没生效`); fails++;
    }
    console.log(`  📏 最宽的日志 ${logFit.width}px / 可用 ${logFit.bad.length ? '—' : '366px（一行放得下）'}`);

    /**
     * 第 8 幕是**冲刺段**：只有市值榜可达，其余三个页签 `disabled`（点了也停在市值榜）。
     * 所以末期档**只截市值榜**，并在这里反过来断言那三个页签确实点不动 ——
     * 这道闸门因此也被真浏览器覆盖到（`probes.mjs` 那边是 DOM 桩版本）。
     */
    if (era === 'late') {
      const locks = await page.evaluate(() => {
        const ds = [0, 1, 2].map(i => {
          const el = document.querySelector(`[data-tab="${i}"]`);
          return !!(el && el.disabled);
        });
        const f = document.querySelector('[data-tab="0"]');     // 试着点「创始人」
        if (f) f.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        return ds;
      });
      await page.waitForTimeout(250);
      const onTop = await page.evaluate(() => {
        const on = document.querySelector('.tab.on');
        return on ? on.textContent.trim().replace(/\s+\d+$/, '') : '—';
      });
      if (locks.some(v => !v)) { console.log(`  ❌ 冲刺段（第 8 幕）有页签没 disabled：${locks.join('/')}（顺序 创始人/公司/订单）`); fails++; }
      if (onTop !== '市值榜') { console.log(`  ❌ 冲刺段点了「创始人」页签，高亮却跑到「${onTop}」`); fails++; }
    }

    const tabs = era === 'late' ? [TABS[3]] : TABS;    // 末期档只剩市值榜可达（见上）
    for (const tb of tabs) {
      // ⚠️ 不能用 `page.click()`：本页每 150ms 整页重建一次，元素随时可能被换掉。
      //    直接派发 `pointerdown`（`bind.js` 的 `PRIMARY_EVENT`）最稳。
      await page.evaluate(i => {
        const el = document.querySelector(`[data-tab="${i}"]`);
        if (el) el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      }, tb.idx);
      await page.waitForTimeout(250);
      await dismissModal();                        // 遮罩不许进截图（见上面的说明）

      const file = join(OUT, `${vp.name}-${era}-${tb.name}.png`);
      // fullPage：截整页而不是只截视口 —— 手机上长页面底部的重叠问题（日志条压内容）只有全页截图才看得见
      await page.screenshot({ path: file, fullPage: true });
      console.log(`  📸 ${vp.name}/${era}/${tb.label} → ${file}`);

      // 一行显示检查（语义分两级）：
      //   **失败** = 横向溢出（scrollWidth > clientWidth —— 真的装不下）
      //   **警告** = 按钮/单元格纵向折行（「应该一行」的东西换行了，人工看截图定夺）
      const layout = await page.evaluate(() => {
        const wrap = [];
        const horiz = [];
        // ⚠️ HUD 不量「整格行数」—— 一格本来就有 3–4 行，量整格永远是「折行」。
        //    HUD 改量**每一行**（`b` / `u` 各是一个行盒）；整格等高与「不许随字数长高」
        //    由上面的 hudCells 两次测量负责。
        for (const el of document.querySelectorAll('.tag, .line .btn, .order .btn, .hud .cell b, .hud .cell u, .cost, .ic, .tab')) {
          const cs = getComputedStyle(el);
          const contentH = el.clientHeight
            - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
            - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth);
          const lines = contentH / parseFloat(cs.lineHeight || cs.fontSize);
          if (lines > 1.7 && el.textContent.trim()) {
            wrap.push(`${el.className || el.tagName}「${el.textContent.trim().slice(0, 24)}…」≈${lines.toFixed(1)} 行`);
          }
          if (el.scrollWidth > el.clientWidth + 1) {
            horiz.push(`${el.className || el.tagName}「${el.textContent.trim().slice(0, 24)}…」`);
          }
        }
        for (const el of document.querySelectorAll('.row, .head, .foot, .hud, .rank-head, .tabs')) {
          if (el.scrollWidth > el.clientWidth + 1) {
            const kids = [...el.children].map(k => `${(k.className || k.tagName).toString().slice(0, 20)}:w${Math.round(k.getBoundingClientRect().width)}:sw${k.scrollWidth}`).join(' | ');
            horiz.push(`${el.className}（横向溢出）「${el.textContent.trim().slice(0, 24)}」${kids}`);
          }
        }
        /**
         * 榜单五列**必须逐行同左同右**（用户 2026-09-27：「排版能否优化？固定位置」）。
         * 每行都是**各自的** grid 容器 ⇒ 只要有一列写成 `auto`，列宽就跟着这一行的内容算，
         * 于是「27.97」那一行会把环比 / 升降两列一起往左推，而「9.17」那行又推回来。
         * 这一条只有**真浏览器**能量：DOM stub 没有布局，`npm run probe` 永远看不见。
         */
        const colDrift = [];
        const rankRows = [...document.querySelectorAll('.rank .row')];
        if (rankRows.length > 1) {
          for (const cls of ['no', 'nm', 'dlt', 'mom', 'cap']) {
            const boxes = rankRows.map(r => r.querySelector('.' + cls)).filter(Boolean)
              .map(el => el.getBoundingClientRect());
            if (!boxes.length) continue;
            // ⚠️ 左边缘与右边缘**分开**求极差 —— 混在一个集合里算，极差必然 ≥ 列宽，永远报假红（踩过）。
            const spread = side => Math.round(
              Math.max(...boxes.map(b => b[side])) - Math.min(...boxes.map(b => b[side])));
            const l = spread('left'), rt = spread('right');
            if (l > 1 || rt > 1) {
              colDrift.push(`.${cls} 在 ${boxes.length} 行之间错位（左差 ${l}px / 右差 ${rt}px）`);
            }
          }
        }
        const on = document.querySelector('.tab.on');
        const ov = document.querySelector('#overlay');
        return {
          wrap, horiz, colDrift,
          hasRank: !!document.querySelector('.rank'),
          hasLines: !!document.querySelector('.lines'),
          hasOrders: !!document.querySelector('.orders'),
          hasLog: !!document.querySelector('.log'),
          tabOn: on ? on.textContent.trim().replace(/\s+\d+$/, '') : '—',
          hasMe: !!document.querySelector('.row.me'),
          // 真浏览器里量遮罩：`closeModal` 之后 `#overlay:empty` 必须成立、`display` 必须回到 none。
          // 「关掉弹窗还在 / 还吃掉全页点击」那个 bug 只有这一条能在真实 CSS 下抓住。
          overlayShown: !!ov && getComputedStyle(ov).display !== 'none',
        };
      });
      for (const o of layout.wrap) console.log(`  ⚠️ 纵向折行（人工确认）：${o}`);
      for (const o of layout.horiz) { console.log(`  ❌ 横向溢出：${o}`); fails++; }
      for (const o of layout.colDrift) { console.log(`  ❌ 榜单列没固定：${o}`); fails++; }
      // 结构自检：日志条跨页签常驻；两页内容互斥（公司页有投资线无榜单，市值榜页反过来）
      if (!layout.hasLog) { console.log('  ❌ 主界面里没有日志条'); fails++; }
      if (layout.overlayShown) { console.log('  ❌ 弹窗关闭后遮罩层还在（#overlay:empty 不成立）'); fails++; }
      if (layout.tabOn !== tb.label) { console.log(`  ❌ 页签高亮不对：「${tb.label}」页亮的是「${layout.tabOn}」`); fails++; }
      // 结构自检：四页内容互斥 —— 公司/创始人各只有投资线，订单页只有订单区，市值榜页只有榜单
      const got = { lines: layout.hasLines, rank: layout.hasRank, orders: layout.hasOrders };
      for (const [k, v] of Object.entries(tb.want)) {
        if (got[k] !== v) { console.log(`  ❌ 「${tb.label}」页的 .${k} ${got[k] ? '出现了' : '不见了'}（应${v ? '有' : '无'}）`); fails++; }
      }
      if (era === 'late' && tb.idx === 3 && !layout.hasMe) {
        console.log('  ❌ 末期档（已上市）榜单里没有玩家行'); fails++;
      }
    }

    /**
     * 末期档**不许登顶**（2026-09-28 补，用户报「截图里怎么是 3000 万亿美元」）——
     * 这份档是「第 8 幕大数值、名次十名之外」的**布局样本**；一旦登顶，「退休」横条
     * 与登顶日志会一起进截图，后期排版检查从此失真。
     * ⚠️ 少了这一条，档里的现金一旦配大（`autoBuy` 会把它花掉、市值复利上去），
     *    截图就**悄悄地**变成另一回事 —— 用户正是这样发现那张 3054 万亿美元的图的。
     * 放在页签循环**之后**：登顶不是开局就在的，得让这几秒跑完才判得准。
     */
    if (era === 'late') {
      const topped = await page.evaluate(() => !!document.querySelector('[data-retire]'));
      if (topped) {
        console.log('  ❌ 末期档已经登顶（应停在名次十名之外）—— 档里的现金配大了，autoBuy 把市值买了上去');
        fails++;
      }
    }
    if (errors.length) { console.log(`  ❌ 页面 JS 错误：${errors.join(' | ')}`); fails++; }
    await ctx.close();
  }
}

await browser.close();
server.close();
console.log(fails ? `\n❌ ${fails} 处溢出/错误（见上）` : '\n✅ 截图完成，无溢出、无 JS 错误');
process.exit(fails ? 1 : 0);
