/**
 * 死代码审计（`npm run dead`）
 * ===============================================================
 * 作者要求「看下哪些是没用的模块（和游戏内容无关的），我们要做加减法」。
 *
 * **为什么要写成脚本而不是靠眼睛看**：靠感觉删东西必然删错 ——
 * 要么漏掉（某个导出早就没人用了），要么误删（它其实被 tools/ 里的自检用着）。
 * 这个脚本做一件很窄但很硬的事：**列出「导出后从未在本仓库任何地方被引用」的符号**，
 * 以及**从未被任何文件 import 的模块**。
 *
 * ⚠️ 它只给**候选**，不自动删。原因：
 *   · `export` 出去的东西可能被外部（未来代码 / 文档）引用；
 *   · 通过 `import * as ns` 或字符串拼接的使用，本脚本扫不到；
 *   · 有些导出是**刻意**的（例如给 tools/ 用的测试钩子）。
 * 所以最后一步永远是人来看一眼再动手。
 *
 * 它**能**可靠抓到的：
 *   · 定义了却从没被调用的内部函数（`function foo()` 只出现一次）
 *   · 导出了却零引用的符号
 *   · 没人 import 的模块文件
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['src', 'tools', 'steam'].filter(Boolean);

/** 递归收集 .js / .mjs 文件 */
function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.refs' || e === 'dist' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs)$/.test(e)) out.push(p);
  }
  return out;
}

const files = SCAN_DIRS.flatMap(d => walk(join(ROOT, d)));
const sources = new Map(files.map(f => [f, readFileSync(f, 'utf8')]));

/** 收集每个文件的导出符号 */
function exportsOf(src) {
  const out = [];
  // export function foo / export async function foo / export const foo / export let foo
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    out.push({ name: m[1], index: m.index });
  }
  // export { a, b as c }
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push({ name, index: m.index });
    }
  }
  // export default —— 单独处理
  if (/^\s*export\s+default/m.test(src)) out.push({ name: 'default', index: 0 });
  return out;
}

/** 一个标识符在整个仓库里出现几次（含自身定义处） */
function countUsages(name, selfFile) {
  const re = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`, 'g');
  let total = 0;
  const where = [];
  for (const [f, src] of sources) {
    const n = (src.match(re) || []).length;
    if (!n) continue;
    total += n;
    where.push({ file: relative(ROOT, f), n: f === selfFile ? n - 1 : n });
  }
  return { total, where: where.filter(w => w.n > 0) };
}

const rel = f => relative(ROOT, f).replace(/\\/g, '/');
const unusedExports = [];
const usedInToolsOnly = [];

for (const [file, src] of sources) {
  if (!rel(file).startsWith('src/')) continue;          // 只审 src/，tools/ 是工具不是产品
  for (const e of exportsOf(src)) {
    if (e.name === 'default') continue;
    const { total, where } = countUsages(e.name, file);
    if (total <= 1) unusedExports.push({ file: rel(file), name: e.name });
    else if (where.every(w => w.file.startsWith('tools/'))) usedInToolsOnly.push({ file: rel(file), name: e.name });
  }
}

/** 没人 import 的模块 */
const orphanFiles = [];
for (const [file] of sources) {
  const r = rel(file);
  if (!r.startsWith('src/')) continue;
  const base = r.split('/').pop().replace(/\.js$/, '');
  const isEntry = /(^|\/)main\.js$/.test(r);
  if (isEntry) continue;
  // 在其它文件里找 `from '.../base.js'` 或 `from './base.js'`
  let imported = false;
  for (const [f2, s2] of sources) {
    if (f2 === file) continue;
    const re = new RegExp(`from\\s+['"][^'"]*/${base}\\.js['"]`);
    if (re.test(s2)) { imported = true; break; }
  }
  if (!imported) orphanFiles.push(r);
}

console.log('');
console.log('  🔍 死代码审计（只给候选，删除前请人工确认）');
console.log('  ─'.repeat(32));
console.log(`  扫描 ${files.length} 个文件（src / tools）`);
console.log('');

if (orphanFiles.length) {
  console.log(`  ⚠️  没有任何文件 import 的模块（${orphanFiles.length} 个）：`);
  for (const f of orphanFiles) console.log(`      ${f}`);
} else {
  console.log('  ✅ 没有孤立模块：每个 src/ 下的文件都至少被 import 一次');
}
console.log('');

if (unusedExports.length) {
  console.log(`  ⚠️  导出后全仓库零引用（${unusedExports.length} 个）：`);
  for (const u of unusedExports) console.log(`      ${u.file}  →  ${u.name}`);
} else {
  console.log('  ✅ 没有零引用的导出');
}
console.log('');

if (usedInToolsOnly.length) {
  console.log(`  ℹ️  只被 tools/ 用到（属于「测试钩子」，不是死代码，${usedInToolsOnly.length} 个）：`);
  for (const u of usedInToolsOnly) console.log(`      ${u.file}  →  ${u.name}`);
  console.log('');
}

console.log(`  ⚠️  本脚本扫不到「通过命名空间 import（import * as）或字符串拼接的使用」`);
console.log('');
