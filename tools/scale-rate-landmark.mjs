// 营收锚定基线：money 链 rate ×0.02 + landmark 成本 ×0.02（等比基线，
// 交给标定器迭代时长，锚定由 MILESTONES/r 1.5 结构阻尼实现）
// ⚠️ 上面那个标定器（tools/auto-calibrate.mjs）已在曲线层 Task 1 删掉，重新标定改走
//    tools/recalibrate-curve.mjs。本脚本的 landmark 分支也随之失效：造价已派生自 ACTS[].mcap，
//    文件里再没有可乘的数字（`cost: { money: landmarkCost(N) }`），只有 money 链 rate 仍会被改。
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/core/content.js';
const src = readFileSync(file, 'utf8').split('\n');
let n = 0;
const out = src.map(l => {
  let line = l;
  if (/kind: 'money'/.test(l)) {
    const m = line.match(/rate: ([0-9.e+]+)/);
    if (m) { line = line.replace(m[0], `rate: ${(parseFloat(m[1]) * 0.02).toExponential(3)}`); n++; }
  }
  if (/kind: 'landmark'/.test(l)) {
    const m = line.match(/cost: \{ money: ([0-9.e+]+) \}/);
    if (m) { line = line.replace(m[0], `cost: { money: ${(parseFloat(m[1]) * 0.02).toExponential(3)} }`); n++; }
  }
  return line;
});
writeFileSync(file, out.join('\n'));
console.log(`缩放 ${n} 处（money rate 7 + landmark 8）`);
