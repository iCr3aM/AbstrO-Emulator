/**
 * 世界市值基线 —— 2026-09-24 实拍
 *
 * 数据来源：companiesmarketcap.com 实时榜（当日全市场 11,340 家 / 总市值 $153.049T）。
 * 这 100 家的名字、代码、市值、国家都是**真实值**，不是编造的；
 * 只有「它们未来怎么长」是模拟（见 world.js 的 MODELS）。
 *
 * c = 市值，单位**万亿美元**（ trillion USD，不是人民币！换算 RMB ×7.2）
 * s = 行业组（决定 μ，见 world.js MODELS）｜ co = 国家/地区
 */

/** 行业组：给玩家看的中文归类（纯展示用） */
export const SECTOR_LABEL = {
  ai: 'AI / 半导体', cloud: '软件 / 云', space: '太空 / 新范式',
  consumer: '消费 / 零售', health: '医疗 / 生物', finance: '金融',
  energy: '能源 / 矿业', industry: '工业 / 国防',
};

/**
 * Top100 实测（2026-09-24）
 */
export const TOP100 = [
  { n: '英伟达', t: 'NVDA', c: 5.375, s: 'ai', co: '美国' },
  { n: '苹果', t: 'AAPL', c: 4.920, s: 'consumer', co: '美国' },
  { n: '谷歌', t: 'GOOG', c: 4.099, s: 'cloud', co: '美国' },
  { n: '微软', t: 'MSFT', c: 3.657, s: 'cloud', co: '美国' },
  { n: '亚马逊', t: 'AMZN', c: 2.656, s: 'consumer', co: '美国' },
  { n: '台积电', t: 'TSM', c: 2.304, s: 'ai', co: '台湾' },
  { n: 'SpaceX', t: 'SPCX', c: 1.940, s: 'space', co: '美国' },
  { n: 'Meta', t: 'META', c: 1.933, s: 'cloud', co: '美国' },
  { n: '博通', t: 'AVGO', c: 1.664, s: 'ai', co: '美国' },
  { n: '沙特阿美', t: '2222', c: 1.660, s: 'energy', co: '沙特' },
  { n: '特斯拉', t: 'TSLA', c: 1.497, s: 'consumer', co: '美国' },
  { n: '三星电子', t: '005930', c: 1.369, s: 'ai', co: '韩国' },
  { n: '美光', t: 'MU', c: 1.186, s: 'ai', co: '美国' },
  { n: '伯克希尔', t: 'BRK-B', c: 1.088, s: 'finance', co: '美国' },
  { n: '礼来', t: 'LLY', c: 1.054, s: 'health', co: '美国' },
  { n: 'AMD', t: 'AMD', c: 1.004, s: 'ai', co: '美国' },
  { n: 'SK 海力士', t: '000660', c: 0.965, s: 'ai', co: '韩国' },
  { n: '摩根大通', t: 'JPM', c: 0.899, s: 'finance', co: '美国' },
  { n: '沃尔玛', t: 'WMT', c: 0.870, s: 'consumer', co: '美国' },
  { n: 'Visa', t: 'V', c: 0.688, s: 'finance', co: '美国' },
  { n: '埃克森美孚', t: 'XOM', c: 0.671, s: 'energy', co: '美国' },
  { n: '英特尔', t: 'INTC', c: 0.664, s: 'ai', co: '美国' },
  { n: '阿斯麦', t: 'ASML', c: 0.660, s: 'ai', co: '荷兰' },
  { n: '强生', t: 'JNJ', c: 0.657, s: 'health', co: '美国' },
  { n: '长鑫存储', t: '688825', c: 0.593, s: 'ai', co: '中国' },
  { n: '腾讯', t: '0700', c: 0.502, s: 'cloud', co: '中国' },
  { n: '万事达', t: 'MA', c: 0.496, s: 'finance', co: '美国' },
  { n: '艾伯维', t: 'ABBV', c: 0.468, s: 'health', co: '美国' },
  { n: 'Palantir', t: 'PLTR', c: 0.459, s: 'cloud', co: '美国' },
  { n: '建设银行', t: '601939', c: 0.428, s: 'finance', co: '中国' },
  { n: '思科', t: 'CSCO', c: 0.418, s: 'cloud', co: '美国' },
  { n: '甲骨文', t: 'ORCL', c: 0.407, s: 'cloud', co: '美国' },
  { n: '雪佛龙', t: 'CVX', c: 0.405, s: 'energy', co: '美国' },
  { n: '好市多', t: 'COST', c: 0.401, s: 'consumer', co: '美国' },
  { n: '美国银行', t: 'BAC', c: 0.395, s: 'finance', co: '美国' },
  { n: '可口可乐', t: 'KO', c: 0.384, s: 'consumer', co: '美国' },
  { n: '泛林集团', t: 'LRCX', c: 0.380, s: 'ai', co: '美国' },
  { n: '默沙东', t: 'MRK', c: 0.372, s: 'health', co: '美国' },
  { n: '应用材料', t: 'AMAT', c: 0.370, s: 'ai', co: '美国' },
  { n: '卡特彼勒', t: 'CAT', c: 0.368, s: 'industry', co: '美国' },
  { n: '罗氏', t: 'RO', c: 0.363, s: 'health', co: '瑞士' },
  { n: '农业银行', t: '601288', c: 0.358, s: 'finance', co: '中国' },
  { n: '工商银行', t: '1398', c: 0.348, s: 'finance', co: '中国' },
  { n: '宝洁', t: 'PG', c: 0.346, s: 'consumer', co: '美国' },
  { n: '戴尔', t: 'DELL', c: 0.344, s: 'ai', co: '美国' },
  { n: 'Arm', t: 'ARM', c: 0.343, s: 'ai', co: '英国' },
  { n: '汇丰', t: 'HSBC', c: 0.343, s: 'finance', co: '英国' },
  { n: '联合健康', t: 'UNH', c: 0.334, s: 'health', co: '美国' },
  { n: '通用电气', t: 'GE', c: 0.331, s: 'industry', co: '美国' },
  { n: 'Palo Alto', t: 'PANW', c: 0.319, s: 'cloud', co: '美国' },
  { n: '中国银行', t: '601988', c: 0.318, s: 'finance', co: '中国' },
  { n: '摩根士丹利', t: 'MS', c: 0.308, s: 'finance', co: '美国' },
  { n: '菲利普莫里斯', t: 'PM', c: 0.302, s: 'consumer', co: '美国' },
  { n: '奈飞', t: 'NFLX', c: 0.298, s: 'consumer', co: '美国' },
  { n: '家得宝', t: 'HD', c: 0.295, s: 'consumer', co: '美国' },
  { n: '加拿大皇家银行', t: 'RY', c: 0.277, s: 'finance', co: '加拿大' },
  { n: '阿里巴巴', t: 'BABA', c: 0.276, s: 'cloud', co: '中国' },
  { n: '壳牌', t: 'SHEL', c: 0.275, s: 'energy', co: '英国' },
  { n: '诺华', t: 'NVS', c: 0.274, s: 'health', co: '瑞士' },
  { n: '高盛', t: 'GS', c: 0.269, s: 'finance', co: '美国' },
  { n: '联发科', t: '2454', c: 0.265, s: 'ai', co: '台湾' },
  { n: 'CrowdStrike', t: 'CRWD', c: 0.265, s: 'cloud', co: '美国' },
  { n: '闪迪', t: 'SNDK', c: 0.260, s: 'ai', co: '美国' },
  { n: 'RTX', t: 'RTX', c: 0.259, s: 'industry', co: '美国' },
  { n: 'Arista', t: 'ANET', c: 0.256, s: 'cloud', co: '美国' },
  { n: '阿斯利康', t: 'AZN', c: 0.255, s: 'health', co: '英国' },
  { n: '三菱日联', t: 'MUFG', c: 0.254, s: 'finance', co: '日本' },
  { n: 'GE Vernova', t: 'GEV', c: 0.250, s: 'industry', co: '美国' },
  { n: '赛默飞', t: 'TMO', c: 0.250, s: 'health', co: '美国' },
  { n: '富国银行', t: 'WFC', c: 0.247, s: 'finance', co: '美国' },
  { n: '德州仪器', t: 'TXN', c: 0.246, s: 'ai', co: '美国' },
  { n: '西门子', t: 'SIE', c: 0.245, s: 'industry', co: '德国' },
  { n: '科磊', t: 'KLAC', c: 0.243, s: 'ai', co: '美国' },
  { n: '雀巢', t: 'NESN', c: 0.242, s: 'consumer', co: '瑞士' },
  { n: 'SAP', t: 'SAP', c: 0.241, s: 'cloud', co: '德国' },
  { n: '欧莱雅', t: 'OR', c: 0.234, s: 'consumer', co: '法国' },
  { n: 'Marvell', t: 'MRVL', c: 0.231, s: 'ai', co: '美国' },
  { n: '贵州茅台', t: '600519', c: 0.230, s: 'consumer', co: '中国' },
  { n: '软银', t: '9984', c: 0.228, s: 'finance', co: '日本' },
  { n: '中国石油', t: '0857', c: 0.224, s: 'energy', co: '中国' },
  { n: 'LVMH', t: 'MC', c: 0.224, s: 'consumer', co: '法国' },
  { n: '国际控股', t: 'IHC', c: 0.222, s: 'finance', co: '阿联酋' },
  { n: '丰田', t: 'TM', c: 0.222, s: 'consumer', co: '日本' },
  { n: '花旗', t: 'C', c: 0.221, s: 'finance', co: '美国' },
  { n: '安进', t: 'AMGN', c: 0.220, s: 'health', co: '美国' },
  { n: '中国移动', t: '0941', c: 0.218, s: 'cloud', co: '中国' },
  { n: '林德', t: 'LIN', c: 0.217, s: 'industry', co: '英国' },
  { n: '必和必拓', t: 'BHP', c: 0.216, s: 'energy', co: '澳洲' },
  { n: 'IBM', t: 'IBM', c: 0.214, s: 'cloud', co: '美国' },
  { n: '希捷', t: 'STX', c: 0.209, s: 'ai', co: '爱尔兰' },
  { n: '桑坦德', t: 'SAN', c: 0.207, s: 'finance', co: '西班牙' },
  { n: '高通', t: 'QCOM', c: 0.205, s: 'ai', co: '美国' },
  { n: '美国运通', t: 'AXP', c: 0.205, s: 'finance', co: '美国' },
  { n: '道达尔', t: 'TTE', c: 0.203, s: 'energy', co: '法国' },
  { n: '宁德时代', t: '300750', c: 0.202, s: 'industry', co: '中国' },
  { n: '安费诺', t: 'APH', c: 0.201, s: 'industry', co: '美国' },
  { n: '威瑞森', t: 'VZ', c: 0.196, s: 'cloud', co: '美国' },
  { n: '道明银行', t: 'TD', c: 0.196, s: 'finance', co: '加拿大' },
  { n: 'Salesforce', t: 'CRM', c: 0.196, s: 'cloud', co: '美国' },
  { n: '迪尔', t: 'DE', c: 0.190, s: 'industry', co: '美国' },
];

/**
 * 个体 α（年化百分比）：同一行业内拉开差距，让换位有故事。
 * 事实依据写在注释里；没有依据的一律 0，不臆造。
 */
export const ALPHA = {
  NVDA: 0.02,   // 数据中心垄断延续
  AAPL: 0.01,   // 服务化
  INTC: -0.03,  // 代工追赶未成，长期掉队
  XOM: -0.01, CVX: -0.01, SHEL: -0.01, TTE: -0.01,  // 能源转型
  SPCX: 0.03,   // 星舰完全复用 + 轨道数据中心（2026-09 已实现亚轨道常态化商业运营）
  TSLA: 0.01,   // FSD 全球部署
  '0700': 0.005, BABA: 0.005,  // 中国互联网中性偏正面
  '9984': 0.01, // 软银押注 AI 资产重估
};

/**
 * 未来入场公司 —— 今天**未上市**但有公开估值/IPO 计划的真实公司。
 * y = 预计入场（上市/纳入榜）年份，c = 入场时市值（万亿 USD）
 *
 * 事实来源（2026-09-24 搜索）：
 *   Anthropic   9650 亿私募估值，IPO 目标 ~2 万亿（史上最大 IPO），原定 2026-11
 *   OpenAI      8520 亿私募估值，2026-09 宣布暂缓 IPO
 *   字节跳动    6000 亿美元非公开市场估值
 *   DeepSeek    1500 亿（中国独角兽榜第二）
 *   Stripe 1590 亿 / Databricks 1340 亿 / Anduril 610 亿 / Revolut 750 亿（胡润全球独角兽榜）
 *   Altos Labs  贝索斯投资的长寿生物，细胞重编程——暂无 IPO 计划，属合理预测
 */
export const IPO_POOL = [
  { n: 'Anthropic', t: 'ANT', y: 2027, c: 1.60, s: 'cloud', co: '美国' },
  { n: 'Stripe', t: 'STRP', y: 2028, c: 0.25, s: 'finance', co: '美国' },
  { n: 'Databricks', t: 'DTBR', y: 2028, c: 0.22, s: 'cloud', co: '美国' },
  { n: 'Revolut', t: 'RVOL', y: 2028, c: 0.10, s: 'finance', co: '英国' },
  { n: 'Binance', t: 'BNB', y: 2028, c: 0.09, s: 'finance', co: '全球' },
  { n: 'OpenAI', t: 'OAI', y: 2029, c: 1.20, s: 'cloud', co: '美国' },
  { n: 'Anduril', t: 'ANDL', y: 2029, c: 0.12, s: 'industry', co: '美国' },
  { n: '希音', t: 'SHEIN', y: 2029, c: 0.09, s: 'consumer', co: '中国' },
  { n: '大疆', t: 'DJI', y: 2029, c: 0.08, s: 'industry', co: '中国' },
  { n: 'Mistral AI', t: 'MSTR', y: 2029, c: 0.11, s: 'cloud', co: '法国' },
  { n: '字节跳动', t: 'BD', y: 2030, c: 0.90, s: 'consumer', co: '中国' },
  { n: '蚂蚁集团', t: 'ANTG', y: 2030, c: 0.12, s: 'finance', co: '中国' },
  { n: '荣耀', t: 'HONOR', y: 2030, c: 0.10, s: 'consumer', co: '中国' },
  { n: 'DeepSeek', t: 'DS', y: 2031, c: 0.35, s: 'cloud', co: '中国' },
  { n: 'Figure AI', t: 'FIGR', y: 2034, c: 0.20, s: 'space', co: '美国' },
  { n: 'Altos Labs', t: 'ALTOS', y: 2036, c: 0.40, s: 'health', co: '美国' },
  { n: '联邦聚变', t: 'CFS', y: 2038, c: 0.15, s: 'energy', co: '美国' },
];

/**
 * 黑马池 —— 每**局**随机抽一部分入场（`world.js` 用世界种子哈希决定）。
 *
 * 为什么抽而不是全放：榜单需要「有些公司你上一周目没见过」。固定 17 家必然入场 +
 * 随机 4-6 家黑马，既守住真实感（大票一定有），又给每个存档不同的世界。
 * ⚠️ 随机取自 `(世界种子, 序号)` 的哈希，**不消耗玩家随机数** —— 所以既确定可复现，
 *    又不会干扰事件/竞标的随机序列（矩阵种子不会被带偏）。
 *
 * 全部是**今天真实存在**的公司（2026-09 搜索），上市年份属合理预测。
 */
export const DARK_HORSES = [
  { n: '月之暗面', t: 'MOON', y: 2030, c: 0.30, s: 'cloud', co: '中国' },
  { n: 'MiniMax', t: 'MMAX', y: 2031, c: 0.25, s: 'cloud', co: '中国' },
  { n: 'Cerebras', t: 'CBRS', y: 2030, c: 0.28, s: 'ai', co: '美国' },
  { n: 'Groq', t: 'GROQ', y: 2030, c: 0.22, s: 'ai', co: '美国' },
  { n: '星源智', t: 'XYAI', y: 2032, c: 0.08, s: 'space', co: '中国' },
  { n: 'Thinking Machines', t: 'TML', y: 2033, c: 0.35, s: 'cloud', co: '美国' },
  { n: '1X 科技', t: 'ONEX', y: 2033, c: 0.12, s: 'space', co: '挪威' },
  { n: 'Neuralink', t: 'NLNK', y: 2035, c: 0.18, s: 'health', co: '美国' },
  { n: 'Insitro', t: 'INST', y: 2036, c: 0.10, s: 'health', co: '美国' },
  { n: 'PsiQuantum', t: 'PSIQ', y: 2037, c: 0.15, s: 'ai', co: '美国' },
  { n: 'Helion Energy', t: 'HLON', y: 2038, c: 0.20, s: 'energy', co: '美国' },
  { n: '未知的 AGI 公司', t: '?', y: 2044, c: 0.30, s: 'space', co: '未知' },
];
