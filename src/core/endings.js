/**
 * 结局（GDD §5.3 第 4 问）
 * ===============================================================
 * 全作**只有一个结局**：公司市值登顶世界第一（`worldRank === 1`）。
 *
 * 判据源是 `s.worldRank` —— `world.js` 每 tick 已经维护它（与世界榜同一真相源），
 * 所以这里**不再另算一遍名次**，也不会出现「回执说第一、世界榜说第二」这类自相矛盾。
 *
 * ⚠️ 判定本身在 `engine.tick` 里（`s.worldRank === 1 ⇒ s.ending = 'top'`）—— 所以结局**自动触发**，
 *    「退休」按钮只是同一件事的**手动入口**（用户 2026-09-27：按钮要做成 HUD 上面的通栏横条）。
 *    下面这个函数就是那个入口用的：`rank === 1` ⇒ 弹结局；否则只提示，游戏继续。
 */

/**
 * 退休判定（「退休」按钮专用）。
 *
 * @returns {{ ending: 'top'|null, rank: number|null }}
 *   `rank === 1` ⇒ 唯一结局「登顶」；否则 `ending = null` —— **不结束游戏**，只提示。
 *   `rank` 可能为 `null`：世界榜是惰性初始化的（第一次 tick 才建表）。
 */
export function evaluateRetirement(s) {
  const rank = s.worldRank ?? null;
  return { ending: rank === 1 ? 'top' : null, rank };
}

/** 结局文案（`top` 为唯一一条） */
export const ENDING_TEXT = {
  top: {
    title: '登顶',
    line: '「榜上第一行，写的是我们的名字。」',
    body: '2066 年，全球市值榜刷新。第一行不再是那个熟悉的名字。\n三个人在会议室里把那页看完，谁都没有先说话。',
    epilogue: '那间出租屋的灯，当年就比别人亮得久。',
  },
};
