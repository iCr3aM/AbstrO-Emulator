// 非 landmark 建筑成本批量缩放（2026-09-24 营收锚定轮）：
// 收入侧 rate ×0.02 已做，成本侧（房租/电费/scaleCost 是 gross 百分比）自适应 ✓，
// 唯一没缩的是 35 座建筑自身的购买成本 —— 一次性 ×0.02 对齐。
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/core/content.js';
const src = readFileSync(file, 'utf8').split('\n');
let n = 0;
const out = src.map(l => {
  if (/kind: '(money|mul)'/.test(l) && /cost: \{ money: ([0-9.e+]+) \}/.test(l)) {
    const m = l.match(/cost: \{ money: ([0-9.e+]+) \}/);
    const v = parseFloat(m[1]) * 0.02;
    n++;
    return l.replace(m[0], `cost: { money: ${v.toExponential(3)} }`);
  }
  return l;
});
writeFileSync(file, out.join('\n'));
console.log(`缩放 ${n} 座建筑成本 ×0.02`);
