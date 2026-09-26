/**
 * ══════════════ UI 截图检查 ══════════════
 *
 * 为什么需要它：check / play / probe 全都跑在 DOM stub 里，**看不见排版**——
 * 「按钮换行」「文字叠在一起」「日志压住内容」这类问题只有真浏览器渲染才发现。
 * 本工具用 Playwright(Chromium) 把 dist 挂在真实部署路径 /studio/ 下，
 * 对 4 个标签页 × 手机/桌面 × 新档/晚期存档 各截一张图（共 16 张），存到 `.codebuddy/ui-shots/`。
 *
 * late 模式注入一个第 8 幕的大数值存档 —— 验证「¥65049.02万亿」这种量级
 * 在 HUD / 页面里不折行、不溢出（用户要求：数字变动之后不能换行）。
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
import { BUILDINGS, ACTS } from '../src/core/content.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, '.codebuddy', 'ui-shots');
const PREFIX = '/studio/';                       // 与真实部署路径一致
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

/** 末期存档：第 8 幕、全建筑、大数值（量级对齐真实终局：¥数万亿） */
function lateSaveJson() {
  const s = createState();
  s.rngSeed = 20260809;
  s.act = 8;
  s.introSeen = true;
  // ⚠️ 2026-09-26 第二批 §2.6（进度钟）：日历现在由「幕次 + 幕内市值进度」派生，
  //    而这份档全建筑 ×6 ⇒ 市值必然远超第 8 幕门槛 ⇒ 日历自动落在第 8 幕末（2061年8月，结局），
  //    与「第 8 幕」的语义一致。下面这行 `elapsed` 与日历无关了，留着是因为**融资到点**
  //    仍按真实秒判定 —— 拨大它才能让截图里出现「7 轮融资已到账」等末期状态。
  s.elapsed = ACTS.slice(1, 8).reduce((a, x) => a + x.seconds, 0);
  for (const b of BUILDINGS) {
    if (b.kind === 'landmark') s.buildings[b.id] = 1;
    else s.buildings[b.id] = 6;
  }
  s.resources.money = 2.5e15;
  s.resources.rep = 2500;
  s.peakMarketCap = 6.5e13;
  // ⚠️ 2026-09-26 第三批：传承 / LP 已随减法整块删除，存档里不再有该字段 —— 不再写入。
  s.log.push('第 8 幕 · 交接与退休 —— 办公室安静下来，只剩三个人。');
  s.log.push('【里程碑】市值突破 1 万亿');
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

let fails = 0;
for (const vp of VIEWPORTS) {
  for (const era of ['fresh', 'late']) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    // late 模式：**应用启动前**注入第 8 幕大数值存档。
    // ⚠️ 不能 goto 之后再用 localStorage.setItem + reload —— reload 会触发
    //    beforeunload 自动存盘，把注入的档**覆盖回新档**（和删档是同一个坑）。
    if (era === 'late') {
      const json = lateSaveJson();
      await ctx.addInitScript(([key, j]) => localStorage.setItem(key, j), [SAVE_KEY, json]);
    }

    await page.goto(base);
    // 首访会弹开场介绍 —— 点「开工」进主界面
    const intro = page.locator('[data-intro]');
    if (await intro.count()) await intro.click();

    for (let tab = 0; tab < 4; tab++) {   // 2026-09-24 新增「世界」tab：4 个标签页
      await page.click(`[data-tab="${tab}"]`);
      await page.waitForTimeout(250);                  // 等 draw() 至少跑两帧（150ms 全量重建）
      const file = join(OUT, `${vp.name}-${era}-tab${tab}.png`);
      // fullPage：截整页而不是只截视口 —— 手机上长页面底部的重叠问题（日志条压内容）只有全页截图才看得见（2026-09-24 用户要求「截完整」）
  await page.screenshot({ path: file, fullPage: true });
      console.log(`  📸 ${vp.name}/${era} tab${tab} → ${file}`);
    }

    // 一行显示检查（语义分两级）：
    //   **失败** = 横向溢出（scrollWidth > clientWidth —— 真的装不下）
    //   **警告** = .tag / 按钮纵向折行（「应该一行」的东西换行了，人工看截图定夺）
    //   .foot / 说明段落**允许**多行（它们本来就是段落），不检查
    const layout = await page.evaluate(() => {
      const wrap = [];
      const horiz = [];
      for (const el of document.querySelectorAll('.tag, .row button, .hud .cell')) {
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
      for (const el of document.querySelectorAll('.row, .head, .foot, .nar, .hud')) {
        if (el.scrollWidth > el.clientWidth + 1) {
          const kids = [...el.children].map(k => `${(k.className || k.tagName).toString().slice(0, 20)}:w${Math.round(k.getBoundingClientRect().width)}:sw${k.scrollWidth}`).join(' | ');
          horiz.push(`${el.className}（横向溢出）「${el.textContent.trim().slice(0, 24)}」${kids}`);
        }
      }
      return { wrap, horiz };
    });
    for (const o of layout.wrap) console.log(`  ⚠️ 纵向折行（人工确认）：${o}`);
    for (const o of layout.horiz) { console.log(`  ❌ 横向溢出：${o}`); fails++; }
    if (errors.length) { console.log(`  ❌ 页面 JS 错误：${errors.join(' | ')}`); fails++; }
    await ctx.close();
  }
}

await browser.close();
server.close();
console.log(fails ? `\n❌ ${fails} 处溢出/错误（见上）` : '\n✅ 截图完成，无溢出、无 JS 错误');
process.exit(fails ? 1 : 0);
