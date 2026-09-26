import { run } from './playthrough.mjs';
const fmt = n => n >= 1e12 ? (n / 1e12).toFixed(2) + '万亿'
  : n >= 1e8 ? (n / 1e8).toFixed(2) + '亿'
  : n >= 1e4 ? (n / 1e4).toFixed(1) + '万' : n.toFixed(1);

for (const seed of [20260809, 20260810]) {
  try {
    const r = run('m' + seed, { style: 'greedy', seed, resolveKnots: true });
    const s = r.s;
    console.log(`--- seed ${seed}：${r.end}，${(r.seconds / 3600).toFixed(1)}h ---`);
    console.log('净资产(现金):', fmt(s.resources.money), '元');
    console.log('声誉:', Math.round(s.resources.rep || 0), '｜ 持股:', (s.equity * 100).toFixed(1) + '%');
    console.log('峰值市值:', fmt(s.peakMarketCap || 0), '元');
  } catch (e) {
    console.log('seed', seed, '测量失败：', e.message);
  }
}
