/**
 * 全量内容数据（唯一数据源）—— 重制版 v4
 * ===============================================================
 * 原则（GDD §5.1）：**只有一个乘积**。没有加法桶、没有隐藏乘数层、没有绝对额固定支出。
 *
 * 数值的验收与标定由 `tools/*.mjs` 负责；本文件只放「事实」：
 *   常数 → `ACTS` 七阶段 → 三条线 → 创始人叙事 → 年度决策事件。
 *
 * ⚠️ 改本文件任何数字之后必须重跑：`npm run tune` → `npm run check` → `npm run robust`。
 */

// ─────────────────────────── 常数（GDD §5.2）───────────────────────────
/** 一游戏年 = 494 秒；35 年 = 4.80 h（GDD §2 的七段时长之和） */
export const SEC_PER_YEAR = 494;
/** 成本曲线比：`cost(n) = LINE_COST0 · r^n`，三条线共用 */
export const CURVE_RATIO = 1.13;
/** 效果曲线比：`g = r^(1/3)` —— 让**每次购买的间隔恒定**（放置类的标准手感） */
export const LINE_GROWTH = CURVE_RATIO ** (1 / 3);
/** 每秒收入的基准系数（元/秒）—— 三人接零活的底料，防「0 收入 ⇒ 买不起 ⇒ 永远 0 收入」的死锁 */
export const INCOME_SCALE = 12;
/** 第一条线的成本（元）—— 三条线共用同一个 `cost(n)` */
export const LINE_COST0 = 500;
/** 产品代际：每阶段 ×1.5（共 6 次 ⇒ 全程 ×11.4） */
export const GENERATION = 1.5;
/** 达到即上市，同时是第 5 阶段的市值门槛（元） */
export const IPO_LINE = 2.0e12;
/** 离线上限（秒） */
export const OFFLINE_CAP_SEC = 8 * 3600;
/** 离线折扣：等效游戏时间 = 真实离线秒 × 0.15 ⇒ 封顶只拿到全程 25% */
export const OFFLINE_MODIFIER = 0.15;
/** 待决事件积压上限（在线、离线同一条规则，GDD §1.5） */
export const PENDING_CAP = 3;
/** 市盈率基准（按阶段） */
export const PE_BASE = [null, 12, 14, 16, 18, 22, 30, 40];
/** 市盈率夹取区间 —— 年度决策只能在这个区间里推它 */
export const PE_MIN = 8;
export const PE_MAX = 60;

/** 开局那一句（原 `ACT_NARRATION[1].open`；幕落地标系统已删，只留这一条） */
export const OPENING = '泡面凉了，报名表还在改。';

/** 公司名随进程演化：IPO（第 5 阶段）后改名 */
export const companyName = stage => (stage >= 5 ? 'Abstract Inc' : 'Abstract Studio');

// ─────────────────────────── 七阶段（GDD §2）───────────────────────────
/**
 * `years` / `mcap` 是日历与世界榜的真相源（`format.js` 直接读这两个字段）。
 * `seconds` 是本阶段的目标时长，供标定器与验收带宽使用。
 * `goal` 是年度报告里的勾选项，**不额外加闸** —— 唯一的机械闸门是 `市值 ≥ mcap`。
 */
export const ACTS = [
  null,
  { act: 1, years: '2026–2031', place: '出租屋',   goal: '产品力 ≥ 3.0',      pe: 12, seconds: 1080, mcap: 2.6e7 },
  { act: 2, years: '2031–2036', place: '车库',     goal: '净收入转正',         pe: 14, seconds: 1620, mcap: 4.3e8 },
  { act: 3, years: '2036–2041', place: '写字楼',   goal: '份额 ≥ 15%',        pe: 16, seconds: 2160, mcap: 7.2e9 },
  { act: 4, years: '2041–2046', place: '海外分部', goal: '拿到 A 轮',          pe: 18, seconds: 2520, mcap: 1.2e11 },
  { act: 5, years: '2046–2051', place: '全球总部', goal: '市值 ≥ IPO_LINE',   pe: 22, seconds: 2880, mcap: IPO_LINE },
  { act: 6, years: '2051–2056', place: '算力帝国', goal: '进世界前十',         pe: 30, seconds: 3240, mcap: 3.3e13 },
  { act: 7, years: '2056–2061', place: '天空塔',   goal: 'worldRank === 1',   pe: 40, seconds: 3780, mcap: 5.6e14 },
];

// ─────────────────────────── 三条投资线（GDD §1.2）───────────────────────────
/**
 * 三条线**完全对称**：同一个 `cost(n)`、同一个 `g`。偏科会按 `(r/g)^L = 1.085^L`
 * 指数级变慢 ⇒ 「三条线都要投」是公式强制的，不靠玩家自觉。
 */
export const LINES = [
  { id: 'r', name: '投研发', who: '老钟', label: '产品力' },
  { id: 'm', name: '投营销', who: '小严', label: '市场份额' },
  { id: 'h', name: '投招聘', who: '小朱', label: '团队效率' },
];
export const LINE_IDS = LINES.map(l => l.id);

// ─────────────────────────── 支出与净利率（GDD §5.1）───────────────────────────
/** 工资占营收比例：26% → 36% */
const SALARY_FRAC = [null, 0.26, 0.28, 0.30, 0.32, 0.34, 0.35, 0.36];
/** 规模维护占营收比例：6% → 42%（公司越大，管理/协调/合规/内耗越贵） */
const SCALE_FRAC = [null, 0.06, 0.11, 0.17, 0.24, 0.31, 0.37, 0.42];

const at = (t, stage) => t[Math.max(1, Math.min(7, stage | 0))];
export const salaryFrac = stage => at(SALARY_FRAC, stage);
export const scaleFrac = stage => at(SCALE_FRAC, stage);
/** 净利率 = 1 − 工资 − 规模维护。终局 0.22 ⇒ 现金堆积被天然钳制。 */
export const marginOf = stage => 1 - salaryFrac(stage) - scaleFrac(stage);

// ─────────────────────────── 三位创始人（纯叙事，GDD §1.2）───────────────────────────
/**
 * 三人**不进任何公式**。年龄按出生年 + 阶段起点年推算 ——
 * 旧版是一张 8 行手写表，七阶段制下它必然与 `ACTS[].years` 脱节，所以改为派生。
 */
export const FOUNDERS = [
  { id: 'zhong', name: '老钟', role: '技术', birth: 1998 },
  { id: 'yan', name: '小严', role: '商务', birth: 1999 },
  { id: 'zhu', name: '小朱', role: '运营', birth: 2001 },
];

/** 第 stage 阶段起点年（2026 / 2031 / …） */
export const startYearOf = stage => {
  const m = /(\d{4})/.exec((ACTS[stage] || ACTS[1]).years || '');
  return m ? Number(m[1]) : 2026;
};

/** 该阶段的三人年龄（纯展示） */
export const agesAt = stage => {
  const y = startYearOf(stage);
  return Object.fromEntries(FOUNDERS.map(f => [f.id, y - f.birth]));
};

// ─────────────────────────── 年度决策事件（GDD §1.5 / §3.4）───────────────────────────
/**
 * ⚠️ **占位池**。GDD §3.4 要求「旧版 122 条文案逐条筛」，那一步属于「内容数据」层，
 *    尚未落地；这里只放够跑通机制的最小集合（每阶段 1 条 + 1 条通用）。
 *
 * 形态固定为 `{ id, stage, title, body, options, default }`：
 *   · `stage` = 0 表示任何阶段都可能抽到；
 *   · `options[].eff` 只能落在五个变量上：`cash / prod / share / team / pe`；
 *   · `cash` 的单位是**年营收**（金额随公司成长自动缩放，不会出现「第一幕的 600 万到第七幕还在用」）。
 *   · `default` 是积压超限与离线结算时用的选项下标（§1.5）。
 */
export const EVENTS = [
  {
    id: 'e01', stage: 1, title: '第一个客户要改需求',
    body: '第三个通宵了。对面说：「要不你先改，钱的事好说。」',
    options: [
      { text: '免费改，把人留住', eff: { prod: 1.08 } },
      { text: '加钱才改', eff: { cash: 0.12, team: 0.97 } },
    ],
    default: 0,
  },
  {
    id: 'e02', stage: 0, title: '经济寒冬',
    body: '同行开始裁员。你们的现金流只够撑半年。',
    options: [
      { text: '收缩，砍掉所有非必要开支', eff: { cash: 0.25, share: 0.96 } },
      { text: '逆势加投市场', eff: { cash: -0.20, share: 1.10 } },
    ],
    default: 0,
  },
  {
    id: 'e03', stage: 2, title: '竞对来挖人',
    body: '猎头把电话打到了工位上。开的价比你们高四成。',
    options: [
      { text: '加薪留人', eff: { cash: -0.15, team: 1.12 } },
      { text: '祝他前程似锦', eff: { team: 0.94 } },
    ],
    default: 0,
  },
  {
    id: 'e04', stage: 3, title: '监管问询',
    body: '一封挂号信，要求在十天内说明数据合规流程。',
    options: [
      { text: '全力配合整改', eff: { cash: -0.12, pe: 2 } },
      { text: '请最好的律所，同时铺公关', eff: { cash: -0.22, share: 1.08 } },
    ],
    default: 0,
  },
  {
    id: 'e05', stage: 4, title: '要不要出海',
    body: '东南亚的代理商自己找上门了。第一个月的数据好得不真实。',
    options: [
      { text: '激进：一年铺六个国家', eff: { cash: -0.30, share: 1.14 } },
      { text: '稳健：先做两个市场', eff: { cash: -0.12, share: 1.05, pe: 1 } },
    ],
    default: 1,
  },
  {
    id: 'e06', stage: 5, title: '上市窗口',
    body: '投行说，下半年的窗口最好。错过了，可能要再等一年。',
    options: [
      { text: '提前发', eff: { cash: 0.50, pe: -3 } },
      { text: '再等一个更漂亮的季度', eff: { pe: 3 } },
    ],
    default: 1,
  },
  {
    id: 'e07', stage: 6, title: '算力短缺',
    body: '上游的排期已经排到明年。自建意味着一次很大的资本开支。',
    options: [
      { text: '自建集群', eff: { cash: -0.45, prod: 1.15 } },
      { text: '加价外采', eff: { cash: -0.18, team: 1.06 } },
    ],
    default: 1,
  },
  {
    id: 'e08', stage: 7, title: '登顶前夜',
    body: '榜一和榜二之间，只差一个季度。所有人都在看着你们。',
    options: [
      { text: '全押', eff: { cash: -0.50, prod: 1.10, share: 1.10, team: 1.10 } },
      { text: '稳住基本盘', eff: { pe: 4 } },
    ],
    default: 1,
  },
];

export const eventById = id => EVENTS.find(e => e.id === id) || null;

/** 该阶段可抽的事件池（含通用事件） */
export const eventsFor = stage => EVENTS.filter(e => e.stage === 0 || e.stage === stage);
