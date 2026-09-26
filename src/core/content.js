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
/** 第一条线的成本（元）—— 三条线共用同一个 `cost(n)`。**时间旋钮**：它只缩放「购买间隔」，不影响市值阶梯。 */
export const LINE_COST0 = 978.9;
/** 产品代际：每阶段 ×1.5（共 6 次 ⇒ 全程 ×11.4） */
export const GENERATION = 1.5;
/** 离线上限（秒） */
export const OFFLINE_CAP_SEC = 8 * 3600;
/** 离线折扣：等效游戏时间 = 真实离线秒 × 0.15 ⇒ 封顶只拿到全程 25% */
export const OFFLINE_MODIFIER = 0.15;
/** 待决事件积压上限（在线、离线同一条规则，GDD §1.5） */
export const PENDING_CAP = 3;
/**
 * 从第几幕起，年度事件**不再交给玩家**：直接按默认选项结算（GDD §1.5「前期玩家操作、后期自动化」）。
 * 第 6、7 幕正是「公司已经很大、三个人已经管不过来」的两幕 —— 那时玩家的动作只剩
 * 自动购买的方向（§1.6），年度事件由团队按保守项自行处理。
 */
export const AUTO_DECIDE_STAGE = 6;
/** 市盈率基准（按阶段） */
export const PE_BASE = [null, 12, 14, 16, 18, 22, 30, 40];
/** 市盈率夹取区间 —— 年度决策只能在这个区间里推它 */
export const PE_MIN = 8;
export const PE_MAX = 60;

/** 开局那一句（原 `ACT_NARRATION[1].open`；幕落地标系统已删，只留这一条） */
export const OPENING = '泡面凉了，报名表还在改。';

/**
 * 公司名随进程演化：**敲钟之后**改名（判据是「已上市」，不是「第几幕」——
 * 上市发生在第 4 幕幕末，按幕次判断会在同一幕里出现两个名字）。
 */
export const companyName = listed => (listed ? 'Abstract Inc' : 'Abstract Studio');

// ─────────────────────────── 七阶段（GDD §2）───────────────────────────
/**
 * `years` / `mcap` 是日历与世界榜的真相源（`format.js` 直接读这两个字段）。
 * `seconds` 是本阶段的目标时长，供标定器与验收带宽使用。
 * `goal` 是 HUD 与年度报告里的勾选项，**不额外加闸** —— 唯一的机械闸门是 `市值 ≥ mcap`。
 *
 * ⚠️ `goal` 的判据写在 `engine.stageGoalMet`，**每一条都必须在本幕之内被跨过**
 *    （否则玩家整幕只看到 `·`，目标就是一句假话）。七个阈值都是**实测反推**的
 *    （量尺：跑一局 best 策略，采样每一幕 25% / 50% / 75% / 100% 处的取值）：
 *    | 幕 | 目标 | 幕内跨过位置 |
 *    | 1 | 产品力 ≥ 1.05   | ~40%（1.042 → 1.170；第 1 幕只有 9 次购买，别指望 Lv5）|
 *    | 2 | 团队效率 ≥ 1.25 | ~38%（1.195 → 1.487）|
 *    | 3 | 份额 ≥ 35%      | ~58%（24.3% → 49.5%）|
 *    | 4 | 拿到 A 轮       | ~20%（A 轮落在第 4 幕日历年 2042）|
 *    | 5 | 年营收 ≥ 5 千万  | ~53%（1.9e7 → 2.5e8）|
 *    | 6 | 年营收 ≥ 50 亿   | ~55%（1.2e9 → 3.8e10）|
 *    | 7 | 登顶世界第一    | 结局那一刻 |
 *    份额口径：`100·年营收/(年营收 + 本幕市场年营收)`，幕末恒为 50% ⇒ 与 mcap 标定解耦。
 *    ⚠️ 第 5、6 幕**刻意不用名次**：实测玩家在整局里始终是世界榜最后一名（120/120），
 *       「前 100 / 前十 / 第一」三档全在第 7 幕一小时内依次跨过 —— 用作第 5/6 幕的目标
 *       等于永远不打勾。若要把名次拆到三幕，第 5 幕市值倍数会变成 3.9 万倍（2.16h，
 *       比后两幕之和还长），「幕弧长严格递增」必破。所以名次整块留在第 7 幕。
 *
 * ⚠️ `mcap` 是**标定产物**，不是手写的估计值：七个门槛由「七段目标时长 + 终局登顶线」反解而来
 *    （见 `tools/recalibrate-curve.mjs`）。改这里任何一个数 ⇒ 必须重跑 `npm run tune`。
 *    第 7 幕的门槛 = 世界榜第 1 名在 2061 年的市值 —— 所以「日历打满 2061」与「登顶」是同一刻。
 */
export const ACTS = [
  null,
  { act: 1, years: '2026–2031', place: '出租屋',   goal: '产品力 ≥ 1.05',   pe: 12, seconds: 1080, mcap: 1.05e5 },
  { act: 2, years: '2031–2036', place: '车库',     goal: '团队效率 ≥ 1.25', pe: 14, seconds: 1620, mcap: 4.68e5 },
  { act: 3, years: '2036–2041', place: '写字楼',   goal: '份额 ≥ 35%',      pe: 16, seconds: 2160, mcap: 3.72e6 },
  { act: 4, years: '2041–2046', place: '海外分部', goal: '拿到 A 轮',        pe: 18, seconds: 2520, mcap: 1.15e8 },
  { act: 5, years: '2046–2051', place: '全球总部', goal: '年营收 ≥ 5 千万',  pe: 22, seconds: 2880, mcap: 7.52e9 },
  { act: 6, years: '2051–2056', place: '算力帝国', goal: '年营收 ≥ 50 亿',   pe: 30, seconds: 3240, mcap: 1.50e12 },
  { act: 7, years: '2056–2061', place: '天空塔',   goal: '登顶世界第一',     pe: 40, seconds: 3780, mcap: 1.76e15 },
];

/**
 * 上市线（元）：达到即上市（`finance.js` 据此发 `ipo` 轮，世界榜据此把玩家排进榜单）。
 * 数值 = `ACTS[4].mcap`，也就是**第 4 幕（融资幕）的出口**：A/B/C/Pre-IPO 四轮都在这一幕里到账，
 * 幕末市值一到就敲钟 —— 比旧口径（第 5 幕末）提前了整整一幕。
 */
export const IPO_LINE = ACTS[4].mcap;
/** 开局市值（元）= 起始年营收 × 第 1 阶段 PE —— 进度钟的「0 月」锚点（由 `format.js` 读） */
export const START_MCAP = INCOME_SCALE * SEC_PER_YEAR * ACTS[1].pe;

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

/**
 * 自动购买的「让路储备」：自动要攒够 `AUTO_BUY_RESERVE` 次购买额才动手。
 * 它不动「一次购买花一份钱」的算术（所以几乎不拖慢整体），唯一作用是
 * **给玩家留出一段买得起的窗口** —— 没有它，钱会在同一个 tick 里被自动买光，
 * 手动按钮永远点不动。K=2 ⇒ 约半个购买周期里按钮是亮的（那是「轮到你了」的信号）。
 */
export const AUTO_BUY_RESERVE = 2;

/**
 * 手动点击一次买几级（GDD §1.6）。手动与自动走**同一个** `purchase()`，
 * 唯一差别是这里的级数：自动只会「补等级最低的那条」且一次一级，
 * 手动由玩家指定投哪条、一次 `MANUAL_GAIN` 级 —— 也就是「自动是打折版，手动是满配」。
 * 手速不是变量（瓶颈永远是钱，不是手），只要跟着购买节律点，全程约快 2 倍。
 */
export const MANUAL_GAIN = 2;

/**
 * 自动购买的**方向**（GDD §1.6）。玩家在「公司」页选一条：
 *   · `even`（默认）= 永远买等级最低的那条 —— 均衡，与旧版完全一致；
 *   · 某条线 id   = 自动优先买它，但**失衡会自动回补**：一旦它比最低的那条高出
 *                   `FOCUS_LAG` 级，这一 tick 就改买最低的（三条线共用成本曲线，
 *                   偏科会按 `(r/g)^L` 指数级变慢，所以方向只能"偏一点"，不能偏死）。
 * 这就是「前期玩家操作、后期玩家做大方向决策」里那个**方向**。
 */
export const FOCUS_EVEN = 'even';
/** 方向线最多领先最低线几级（到线就回补） */
export const FOCUS_LAG = 3;
/** 方向选项（第一个是均衡，其余与三条线同名） */
export const FOCUS = [{ id: FOCUS_EVEN, name: '均衡' }, ...LINES.map(l => ({ id: l.id, name: l.name }))];

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
 * 池子 = **3 条通用**（`stage: 0`，每幕都能抽到）+ **每幕 3 条专属** ⇒ 每幕的池子恒为 6 条。
 * 文案取自旧版 `event-data.js`（`docs/archive/2026-09-26-pre-reset/`）的通用题材与阶段专属题材，
 * 逐条筛掉的：引用**已删系统**的（员工个体 / 合同竞标 / 技能冷却 / 健康 / 心气 / 关系 / 声望 / 传承）、
 * 以及**落不到可用变量上**的（旧版的 `rep` / `loyalty` / `weight` 三个出口已随系统删除）。
 *
 * 形态固定为 `{ id, stage, title, body, options, default }`：
 *   · `stage` = 0 表示任何阶段都可能抽到；
 *   · `options[].eff` 只落在四个变量上：`cash / prod / share / team`；
 *   · `cash` 的单位是**年营收**（金额随公司成长自动缩放）；
 *   · `default` 是积压超限与离线结算时用的选项下标（§1.5）—— 一律取**保守项**（下标 0）。
 *
 * ⚠️ **量级是标定的一部分，不是文学自由度。** 一局要抽 35 次决策，任何**系统性偏置**都会复利：
 *    · `time/次购买 = LINE_COST0 / (INCOME_SCALE · gen · F · (1−frac))` ⇒ 三线乘数 `F` 直接压缩整局时长；
 *    · 现金按「能多买几次」折算成对数市值：`Δln(mcap) = 0.0407 · c · INCOME_SCALE · gen · SEC_PER_YEAR / LINE_COST0`
 *      —— 同样一笔钱，幕次越靠后「买得起更多次」⇒ 绝对值必须**逐幕缩小**，否则后期一笔就能跳幕；
 *    · 所以专属事件的两项写作 `{ cash: +u }` / `{ cash: −u, X: 1.015 }`，`u = 0.02 / GEN^(s−1)`
 *      —— 这样两项在「对数市值」上量级相当（互为取舍），且跨幕权重恒定。
 *    · `pe` **刻意不参与**：`pe` 的分母是幕基准（12…40），±1 在第一幕就是 +8% 市值 ⇒ 抽 35 次必然爆表。
 *      结局的空隙由「三线乘数 + 现金」两个通道自己撑开。
 *    改这里任何数字 ⇒ 必须重跑 `npm run tune` → `npm run check` → `npm run robust`。
 */
export const EVENTS = [
  // ── 通用（每幕都可能抽到；`u` 取中段值，早期偏强、后期偏弱，是刻意的质地）──
  { id: 'g01', stage: 0, title: '经济寒冬', body: '同行开始裁员。你们的现金流只够撑半年。',
    options: [{ text: '收缩，砍掉所有非必要开支', eff: { cash: 0.008 } },
              { text: '逆势加投市场', eff: { cash: -0.008, share: 1.005 } }], default: 0 },
  { id: 'g02', stage: 0, title: '一个新的技术风口', body: '每天都有三篇分析说这是未来。也可能只是今年的说法。',
    options: [{ text: '观望，把钱留给确定的事', eff: { cash: 0.008 } },
              { text: '全力押注，先做出来', eff: { cash: -0.008, prod: 1.005 } }], default: 0 },
  { id: 'g03', stage: 0, title: '一篇负面报道', body: '标题很刺眼，内容只有一半是真的。转发量比你们的用户量还大。',
    options: [{ text: '不回应，让它自己过去', eff: { cash: 0.008 } },
              { text: '公开回应，把数据摊开', eff: { cash: -0.008, share: 1.005 } }], default: 0 },

  // ── 第 1 幕 · 出租屋 ──────────────────────────────
  { id: 'e11', stage: 1, title: '第一个客户要改需求', body: '第三个通宵了。对面说：「要不你先改，钱的事好说。」',
    options: [{ text: '加钱才改', eff: { cash: 0.02 } },
              { text: '免费改，把人留住', eff: { cash: -0.02, prod: 1.015 } }], default: 0 },
  { id: 'e12', stage: 1, title: '一个「来钱快」的外包单', body: '三周交付，报酬是你们半年的收入。但它和技术方向没什么关系。',
    options: [{ text: '接，先把钱赚到', eff: { cash: 0.02 } },
              { text: '拒，专注自己的产品', eff: { cash: -0.02, prod: 1.015 } }], default: 0 },
  { id: 'e13', stage: 1, title: '陈阿姨来涨租了', body: '「周边都涨了，你们也涨一点吧。」她说这话的时候没看你。',
    options: [{ text: '跟她磨一磨，先按原价续', eff: { cash: 0.02 } },
              { text: '认了，顺手把工位扩一扩', eff: { cash: -0.02, team: 1.015 } }], default: 0 },

  // ── 第 2 幕 · 车库 ────────────────────────────────
  { id: 'e21', stage: 2, title: '核心工程师被挖角', body: '对方开出的薪水是你们的两倍。他还没答应，但也没有拒绝。',
    options: [{ text: '放他走，祝他顺利', eff: { cash: 0.013 } },
              { text: '加薪留人', eff: { cash: -0.013, team: 1.015 } }], default: 0 },
  { id: 'e22', stage: 2, title: '机房跳闸', body: '半夜三点，一排电源烧了。备件要现钱。',
    options: [{ text: '先凑合，等这阵忙完', eff: { cash: 0.013 } },
              { text: '立刻换新，顺便扩容', eff: { cash: -0.013, prod: 1.015 } }], default: 0 },
  { id: 'e23', stage: 2, title: '竞对的报价又低了', body: '客户把对方的报价单转发给你们，问能不能再谈谈。',
    options: [{ text: '不跟，把价值讲清楚', eff: { cash: 0.013 } },
              { text: '跟价，先把份额拿下', eff: { cash: -0.013, share: 1.015 } }], default: 0 },

  // ── 第 3 幕 · 写字楼 ──────────────────────────────
  { id: 'e31', stage: 3, title: '监管问询', body: '一封挂号信，要求在十天内说明数据合规流程。',
    options: [{ text: '派一个人应付一下', eff: { cash: 0.009 } },
              { text: '全力配合整改', eff: { cash: -0.009, prod: 1.015 } }], default: 0 },
  { id: 'e32', stage: 3, title: '开源还是闭源', body: '把核心框架开源，能换来生态，也会让对手少走两年弯路。',
    options: [{ text: '闭源，守住壁垒', eff: { cash: 0.009 } },
              { text: '开源', eff: { cash: -0.009, share: 1.015 } }], default: 0 },
  { id: 'e33', stage: 3, title: '要不要搬进更贵的写字楼', body: '客户来了会更有面子，员工通勤也更方便。租金是现在的三倍。',
    options: [{ text: '不搬，钱花在产品上', eff: { cash: 0.009 } },
              { text: '搬', eff: { cash: -0.009, team: 1.015 } }], default: 0 },

  // ── 第 4 幕 · 海外分部 ────────────────────────────
  { id: 'e41', stage: 4, title: '要不要出海', body: '东南亚的代理商自己找上门了。第一个月的数据好得不真实。',
    options: [{ text: '稳健：先做两个市场', eff: { cash: 0.006 } },
              { text: '激进：一年铺六个国家', eff: { cash: -0.006, share: 1.015 } }], default: 0 },
  { id: 'e42', stage: 4, title: '投资人递来对赌协议', body: '钱很多，条件也很硬：三年内不达标，你们要回购。',
    options: [{ text: '不签，慢慢来', eff: { cash: 0.006 } },
              { text: '签', eff: { cash: -0.006, prod: 1.015 } }], default: 0 },
  { id: 'e43', stage: 4, title: '税务稽查', body: '税务局来了两个人，要调过去三年的账。',
    options: [{ text: '自己扛，把材料理清楚', eff: { cash: 0.006 } },
              { text: '请最好的律所，顺手把流程合规化', eff: { cash: -0.006, team: 1.015 } }], default: 0 },

  // ── 第 5 幕 · 全球总部 ────────────────────────────
  { id: 'e51', stage: 5, title: '增发窗口', body: '投行说，下半年的窗口最好——公司已经上市一年，现在是再融一笔的时候。',
    options: [{ text: '再等一个更漂亮的季度', eff: { cash: 0.004 } },
              { text: '现在就发', eff: { cash: -0.004, share: 1.015 } }], default: 0 },
  { id: 'e52', stage: 5, title: '被邀请参与行业标准制定', body: '要投入大量工程师去开会、写文档。产出不会体现在财报上。',
    options: [{ text: '派一个人应付一下', eff: { cash: 0.004 } },
              { text: '全力投入', eff: { cash: -0.004, team: 1.015 } }], default: 0 },
  { id: 'e53', stage: 5, title: '猎头盯上了整个算法团队', body: '这次不是挖一个人，是想把整个组端走。',
    options: [{ text: '赌他们不会走', eff: { cash: 0.004 } },
              { text: '集体加薪，期权重签', eff: { cash: -0.004, team: 1.015 } }], default: 0 },

  // ── 第 6 幕 · 算力帝国 ────────────────────────────
  { id: 'e61', stage: 6, title: '算力短缺', body: '上游的排期已经排到明年。自建意味着一次很大的资本开支。',
    options: [{ text: '加价外采，先保住交付', eff: { cash: 0.003 } },
              { text: '自建集群', eff: { cash: -0.003, prod: 1.015 } }], default: 0 },
  { id: 'e62', stage: 6, title: '实体清单', body: '一纸清单下来，高端芯片买不到了。供应链的人连夜打电话来。',
    options: [{ text: '收缩业务，保住现金流', eff: { cash: 0.003 } },
              { text: '全面转国产替代', eff: { cash: -0.003, prod: 1.015 } }], default: 0 },
  { id: 'e63', stage: 6, title: '东芝想被你们收购', body: '他们有上百年的行业积累，也有一堆历史和债务。',
    options: [{ text: '不收，自己长', eff: { cash: 0.003 } },
              { text: '收下来，整合进体系', eff: { cash: -0.003, share: 1.015 } }], default: 0 },

  // ── 第 7 幕 · 天空塔 ──────────────────────────────
  { id: 'e71', stage: 7, title: '登顶前夜', body: '榜一和榜二之间，只差一个季度。所有人都在看着你们。',
    options: [{ text: '稳住基本盘', eff: { cash: 0.002 } },
              { text: '全押', eff: { cash: -0.002, share: 1.015 } }], default: 0 },
  { id: 'e72', stage: 7, title: '合并的邀请', body: '对手开出条件：合并之后，你们的名字会留在子品牌那一栏。',
    options: [{ text: '独立走下去', eff: { cash: 0.002 } },
              { text: '接受合并', eff: { cash: -0.002, share: 1.015 } }], default: 0 },
  { id: 'e73', stage: 7, title: '核心要不要开源', body: '底层引擎的代码就在仓库里。社区请愿已经有四万条签名。',
    options: [{ text: '保留商业版', eff: { cash: 0.002 } },
              { text: '全部开放，只留服务', eff: { cash: -0.002, share: 1.015 } }], default: 0 },
];

export const eventById = id => EVENTS.find(e => e.id === id) || null;

/** 该阶段可抽的事件池（含通用事件） */
export const eventsFor = stage => EVENTS.filter(e => e.stage === 0 || e.stage === stage);
