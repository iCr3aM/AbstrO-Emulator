#!/usr/bin/env node
/**
 * 构建产物验证（防白屏）
 * ===============================================================
 * 白屏有两类原因，这个脚本两类都检查：
 *
 *   A. **资源路径不对** —— 产物里出现绝对路径 `/assets/...`，上传到子目录就 404。
 *      检查：dist/index.html 里所有资源引用必须是相对路径（`./assets/...`）。
 *
 *   B. **JS 启动就抛异常** —— 路径对了但脚本一跑就崩，页面照样是白的。
 *      检查：用 DOM stub 真的 `import()` 构建出来的 bundle，跑几帧，看会不会抛。
 *
 * 由 `npm run build` 在 postbuild 之后自动调用。任何一项不过就**非零退出**，
 * 让构建失败而不是把白屏悄悄交出去。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const HTML = join(DIST, 'index.html');
const JS = join(DIST, 'assets', 'index.js');
const CSS = join(DIST, 'assets', 'index.css');

let failed = 0;
let warned = 0;
const ok = m => console.log(`  ✅ ${m}`);
const bad = m => { failed += 1; console.log(`  ❌ ${m}`); };
/** 提示：值得知道、但**不该中断构建**的事（例如「对方服务器要怎么配」这种我们改不了的） */
const warn = m => { warned += 1; console.log(`  ⚠️  ${m}`); };

console.log('');
console.log('  🔍 构建产物验证');
console.log('  ─'.repeat(32));

// ── 文件齐全 ──
for (const [label, p] of [['index.html', HTML], ['version.json', join(DIST, 'version.json')],
  ['assets/index.js', JS], ['assets/index.css', CSS]]) {
  if (existsSync(p)) ok(`${label} 存在`);
  else bad(`${label} 缺失`);
}
if (failed) process.exit(1);

const html = readFileSync(HTML, 'utf8');

// ── A. 路径必须相对 ──
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]);
const absolute = refs.filter(u => u.startsWith('/') && !u.startsWith('//'));
if (absolute.length) bad(`发现绝对路径资源引用：${absolute.join('、')} —— 上传到子目录会 404（白屏）`);
else ok(`资源路径全部为相对路径（${refs.length} 处）`);

// ── 文件名不带哈希 ──
if (/assets\/index\.(js|css)\?v=/.test(html)) ok('资源文件名不带哈希，且已加 ?v= 版本串（可安全覆盖上传）');
else bad('资源引用缺少 ?v= 版本串 —— SFTP 覆盖后浏览器可能继续用旧缓存');

// ── 版本号已注入 ──
if (/window\.__APP_VERSION__="\d+"/.test(html)) ok('已注入 window.__APP_VERSION__（运行时版本比对可用）');
else bad('缺少 window.__APP_VERSION__ 注入');

// ── B. bundle 能不能真的跑起来 ──
// 先把真定时器存下来：下面为了模拟浏览器会把 setTimeout/setInterval 打成空实现，
// 但 Node 的 fetch（undici）内部依赖真定时器，做 HTTP 测试前必须还原，
// 否则会得到一个非常误导人的 `fetch failed`。
const REAL_TIMERS = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
};

const node = () => {
  const el = {
    innerHTML: '', className: '', dataset: {}, children: [],
    querySelectorAll: () => [], querySelector: () => node(),
    appendChild(c) { el.children.push(c); }, remove() {}, onclick: null,
    setAttribute() {}, getAttribute: () => null,
  };
  return el;
};
const store = new Map();
let raf = 0;
globalThis.document = {
  createElement: node,
  getElementById: () => node(),
  querySelector: () => null,
  querySelectorAll: () => [],
  body: node(),
  head: node(),
  addEventListener() {},
};
// Vite 的 modulepreload polyfill 会用 MutationObserver（已在 vite.config.js 里关掉，这里双保险）
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.window = { addEventListener() {}, __APP_VERSION__: undefined };
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
globalThis.location = { href: 'http://localhost/', protocol: 'http:', replace() {} };
globalThis.requestAnimationFrame = cb => { if (raf++ < 4) cb(Date.now()); return raf; };
globalThis.cancelAnimationFrame = () => {};
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};

try {
  await import(pathToFileURL(JS).href);
  ok(`构建产物启动成功（跑过 ${raf} 帧，无异常抛出）`);
} catch (e) {
  bad(`构建产物启动失败：${e && e.message ? e.message : e}`);
}

// ── C. 端到端：把 dist 挂在**真实部署路径**下用 HTTP 跑一遍 ──
// 这条是「白屏」那个 bug 的直接回归测试：静态托管在子目录时，
// 绝对路径 /assets/x.js 会 404。这里真的去请求一次，404 就是失败。
{
  // 还原真定时器，否则 undici 会直接失败（见文件上方 REAL_TIMERS 的注释）
  Object.assign(globalThis, REAL_TIMERS);

  const { createServer } = await import('node:http');
  const { readFile } = await import('node:fs/promises');
  /**
   * 这里必须用**真实的上线路径**，不能用 `/my-game/` 这种占位符。
   * 本作的部署目标是 `https://icr3am.com/studio/` —— 换成假路径的话，
   * 这条测试就退化成「子目录能跑」的一般性结论，而测不出「这个子目录能不能跑」。
   */
  const PREFIX = '/studio/';
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };

  const server = createServer(async (req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (!p.startsWith(PREFIX)) { res.writeHead(404); res.end(); return; }
    p = p.slice(PREFIX.length) || 'index.html';
    const file = join(DIST, p);
    try {
      const body = await readFile(file);
      const ext = p.slice(p.lastIndexOf('.'));
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;

  try {
    const page = await fetch(base);
    if (!page.ok) throw new Error(`index.html 返回 ${page.status}`);
    const body = await page.text();

    const assets = [...body.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map(m => m[1]);
    if (!assets.length) throw new Error('页面里没有找到任何相对资源引用');

    for (const a of assets) {
      const url = new URL(a, base).href;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${a} → HTTP ${r.status}（上传到子目录后会白屏）`);
    }
    ok(`上线路径端到端：${base} 打开正常，${assets.length} 个资源全部 200`);

    const vj = await fetch(new URL('./version.json', base).href);
    if (!vj.ok) throw new Error(`version.json 返回 ${vj.status}`);
    const info = await vj.json();
    ok(`version.json 可访问，版本 ${info.version}（运行时刷新提示可用）`);

    /**
     * ⚠️ 无尾斜杠是**这个部署方式最容易踩的坑**，所以专门测一次。
     *
     * 如果玩家打开的是 `https://icr3am.com/studio`（**没有**结尾的 `/`），
     * 浏览器会把 `./assets/index.js` 解析成 `https://icr3am.com/assets/index.js` → 404 → 白屏。
     * 而且**这不是产物的问题**，产物已经全用相对路径了 —— 只能靠服务器把它 301 到 `/studio/`。
     *
     * 所以这里只**验证这个坑真实存在**并给出配置，不判失败（我们改不了对方的服务器）。
     */
    const noSlash = await fetch(base.replace(/\/$/, ''), { redirect: 'manual' });
    if (noSlash.status >= 300 && noSlash.status < 400) {
      ok('无尾斜杠 `/studio` 已被服务器重定向 —— 这个坑已经堵上');
    } else {
      warn('服务器没有把 `/studio` 重定向到 `/studio/`（本地模拟的服务器本来就不重定向）。'
        + '上线后请确认 nginx 里有一行：`location = /studio { return 301 /studio/; }`，'
        + '否则打开无斜杠地址会白屏。');
    }
  } catch (e) {
    bad(`上线路径端到端失败：${e.message}`);
  } finally {
    server.close();
  }
}

console.log('');
if (failed) {
  console.log(`  ✗ 有 ${failed} 项检查未通过 —— 这样的产物上传上去就是白屏，已中止构建。`);
  console.log('');
  process.exit(1);
}
console.log('  ✓ 产物可以直接 SFTP 上传，打开不会白屏。');
if (warned) console.log(`  （另有 ${warned} 条提示，见上方 ⚠️ —— 它们不阻断构建）`);
console.log('');
