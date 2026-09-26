#!/usr/bin/env node
/**
 * 构建后处理：让「SFTP 上传 → 打开网页就能用最新版」这件事真的成立
 * ===============================================================
 * 做四件事：
 *   1. 给 dist/index.html 里的资源 URL 加 `?v=<构建时间>` —— 文件名不带哈希（方便覆盖上传），
 *      但 URL 每次都变（强制浏览器拉新文件）
 *   2. 往 index.html 注入 `window.__APP_VERSION__`，供运行时的版本比对使用
 *   3. 写入 `dist/version.json` —— 页面会定期（不缓存地）拉它，发现版本变了就提示刷新
 *   4. 打印一份 SFTP 上传清单
 *
 * ⚠️ 它必须排在 `vite build` 之后：`"build": "vite build && node tools/postbuild.mjs"`。
 */

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const HTML = join(DIST, 'index.html');

/** 版本号：可读的构建时间戳（本地时区） */
function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

const VERSION = process.env.BUILD_VERSION || stamp();

function human(bytes) {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} kB` : `${bytes} B`;
}

try {
  statSync(HTML);
} catch {
  console.error('✗ 找不到 dist/index.html —— 请先运行 `npx vite build`');
  process.exit(1);
}

let html = readFileSync(HTML, 'utf8');

// ── 1. 给 ./assets/... 的引用加版本查询串 ──
let stamped = 0;
html = html.replace(/(src|href)="(\.\/assets\/[^"?]+)"/g, (_m, attr, url) => {
  stamped += 1;
  return `${attr}="${url}?v=${VERSION}"`;
});

// ── 2. 注入版本号 + 一条「不缓存」的 meta ──
const head = [
  '  <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate" />',
  '  <meta http-equiv="Pragma" content="no-cache" />',
  `  <script>window.__APP_VERSION__="${VERSION}";</script>`,
].join('\n');

if (html.includes('</head>')) {
  html = html.replace('</head>', `${head}\n</head>`);
} else {
  html += `\n${head}\n`;
}

writeFileSync(HTML, html, 'utf8');

// ── 3. version.json（页面会 no-store 地拉它做版本比对）──
const versionJson = JSON.stringify({ version: VERSION, builtAt: new Date().toISOString() });
writeFileSync(join(DIST, 'version.json'), versionJson, 'utf8');

// ── 4. 上传清单 ──
const sizeOf = p => { try { return human(statSync(p).size); } catch { return '（缺失）'; } };
const stampCount = stamped;

console.log('');
console.log('  ✅ 构建后处理完成');
console.log('  ─'.repeat(32));
console.log(`  版本号        ${VERSION}`);
console.log(`  资源引用      ${stampCount} 处已加 ?v=${VERSION}`);
console.log(`  dist/index.html      ${sizeOf(HTML)}`);
console.log(`  dist/assets/index.js ${sizeOf(join(DIST, 'assets', 'index.js'))}`);
console.log(`  dist/assets/index.css ${sizeOf(join(DIST, 'assets', 'index.css'))}`);
console.log(`  dist/version.json    ${human(versionJson.length)}`);
console.log('');
console.log('  📦 SFTP 上传清单（把 dist/ 里的东西整个传到网站目录，保持目录结构）：');
console.log('     1. index.html');
console.log('     2. version.json');
console.log('     3. assets/index.js      ← 固定文件名，直接覆盖');
console.log('     4. assets/index.css     ← 固定文件名，直接覆盖');
console.log('');
console.log('  ⚠️ 关键：这 4 个文件必须**同一次上传完成**。');
console.log('     index.html 里带着 ?v=' + VERSION + '，只传 JS 不传 HTML（或反过来）会版本对不上。');
console.log('  ℹ️ 文件名不带哈希，所以不会在服务器上留下一堆历史文件；');
console.log('     ?v= 保证浏览器不会继续用旧缓存。');
console.log('');
