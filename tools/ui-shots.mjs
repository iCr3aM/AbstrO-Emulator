/**
 * ══════════════ UI 截图检查 ══════════════
 *
 * 为什么需要它：check / click / probe 全都跑在 DOM stub 里，**看不见排版**——
 * 「按钮换行」「文字叠在一起」「日志压住内容」这类问题只有真浏览器渲染才发现。
 * 本工具用 Playwright(Chromium) 把 dist 挂在真实部署路径 /studio/ 下，
 * 对 手机 / 桌面 × 新档 / 末期存档 × 四个页签 各截一张图（共 16 张），存到 `.codebuddy/ui-shots/`。
 *
 * late 模式注入一份第 8 幕的大数值存档 —— 验证「¥2500.00万亿」这种量级
 * 在 HUD / 榜单里不折行、不溢出（用户要求：数字变动之后不能换行）。
 * 该档刻意停在「已上市但名次 > 20」，好把榜单底部那行钉死的玩家行也截进去。
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
import { LINE_IDS } from '../src/core/content.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, '.codebuddy', 'ui-shots');
const PREFIX = '/studio/';                       // 与真实部署路径一致
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

/**
 * 末期存档：第 8 章、五条线各 Lv120、已上市但名次 > 10。
 * 市值约 5.8 万亿 USD —— 足够大（HUD 出现「万亿」），又不至于登顶（否则结局弹窗会盖住主界面）。
 * ⚠️ 章次写 8 而不是 7：第 7 章的门槛是 1.99e13 元，这个档一进第 7 章就会被推走。
 * ⚠️ 五条线**同级**（`g^ΣL` 只由 ΣL 决定，所以加线不改市值）；漏掉 c/d 会少两个因子。
 */
function lateSaveJson() {
  const s = createState();
  s.stage = 8;
  s.lines = Object.fromEntries(LINE_IDS.map(id => [id, 120]));
  s.money = 2.5e15;
  s.finance = { rounds: ['angel', 'preA', 'a', 'b', 'c', 'preIpo', 'ipo'] };
  s.log.push('【登顶】不要走到这里 —— 这份档停在名次 10 名之外。');
  s.log.push('【IPO】到账 1.23万亿（公开发行）');
  s.log.push('（回忆）对面那栋楼挂上了寒武纪的牌子。');
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
     * 末期档会在开跑后自己爬到 #1 并弹出「登顶」结局弹窗（真实行为），
     * 那层 `rgba(0,0,0,.6)` 遮罩会把整页压暗、排版看不清。
     * ⚠️ 不能只点一次 —— 弹窗不是开局就在的（公司爬到第一才弹），
     *    而且可能正好在「点掉上一张」之后才冒出来。所以点到遮罩真的没了为止。
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

    for (const tb of TABS) {
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
        for (const el of document.querySelectorAll('.tag, .line .btn, .order .btn, .hud .cell, .cost, .ic, .tab')) {
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
        const on = document.querySelector('.tab.on');
        const ov = document.querySelector('#overlay');
        return {
          wrap, horiz,
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

    if (errors.length) { console.log(`  ❌ 页面 JS 错误：${errors.join(' | ')}`); fails++; }
    await ctx.close();
  }
}

await browser.close();
server.close();
console.log(fails ? `\n❌ ${fails} 处溢出/错误（见上）` : '\n✅ 截图完成，无溢出、无 JS 错误');
process.exit(fails ? 1 : 0);
