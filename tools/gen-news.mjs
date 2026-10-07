#!/usr/bin/env node
/**
 * 从 RSSHub 生成「时事」题目的数据文件。
 *
 * 用法：
 *   node tools/gen-news.mjs                      # 用默认源，本地 RSSHub
 *   RSSHUB=http://127.0.0.1:1200 node tools/gen-news.mjs
 *   node tools/gen-news.mjs --dry                # 只打印，不写文件
 *
 * 输出：
 *   news-data.js   —— 应用通过 <script src="news-data.js"> 读取 window.SPEAK60_NEWS
 *   没抓到时写入空数据（应用会自动隐藏「时事」分类，不会报错）
 *
 * 为什么用 script 标签而不是 fetch：
 *   本应用支持直接双击打开（file:// 协议），file:// 下 fetch 会被浏览器拦截，
 *   而普通 <script> 不受同源策略限制。所以数据走 JS 变量而不是 JSON。
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RSSHUB = (process.env.RSSHUB || "http://127.0.0.1:1200").replace(/\/$/, "");
const DRY = process.argv.includes("--dry");
const LIMIT_PER_SOURCE = 12;
const LIMIT_TOTAL = 48;

// 想换源就改这里。route 是 RSSHub 的路由；name 会标在数据里，方便你判断来源。
// tag 只是备注。weibo/zhihu 热搜噪音最多（见下面 BLOCK），默认没关，
// 嫌吵就把对应项注释掉。
const SOURCES = [
  { route: "caixin/latest",     name: "财新" },
  { route: "huxiu/article",     name: "虎嗅" },
  { route: "readhub/daily",     name: "Readhub" },
  { route: "guokr/scientific",  name: "果壳" },
  { route: "sspai/matrix",      name: "少数派" },
  { route: "36kr/newsflashes",  name: "36氪" },
];

/**
 * 过滤掉不适合当演讲题目的条目。
 * 搜索引擎热榜里混着三类东西：政治宣传、纯行情播报、明星八卦。
 * 拿来练即兴表达既不好讲，也有发布风险，所以直接挡掉。
 */
const BLOCK = [
  // 政治 / 宣传口径
  /总书记|主席|总理|中共中央|国务院|外交部|发言人|党委|党建|人大|政协|两会|党的二十大精神/,
  /祖国|爱国|统一|两岸|台湾问题|涉港|涉疆|涉藏|制裁|反制|批美|白宫|克里姆林宫/,
  // 纯行情播报，没法当话题展开
  /收盘|开盘|涨跌|指数|报收|上涨|下跌|涨停|跌停|盘中|股价|美元指数|油价|金价|汇率|市值|融资|营收|净利|财报/,
  // 体育比分与赛程
  /比赛结果|比分|夺冠|半决赛|决赛|联赛|世界杯|奥运会|亚运会|晋级|出局|乒协|国乒|球队|球员|转会/,
  // 娱乐八卦
  /恋情|分手|离婚|结婚|怀孕|生女|生子|出轨|绯闻|官宣|塌房|新恋情|结婚照/,
  // 突发灾难 / 案件类，不宜做练习素材
  /遇难|身亡|死亡|车祸|坠楼|失联|遇害|枪击|地震|洪水|爆炸|起火|坍塌/,
  // 营销号风格
  /网友|热搜第|冲上热搜|爆了|炸了|惊呆|唏嘘|泪目|扎心|破防|反转|笑死|绝了|太上头/,
  // 建议体 / 生活方式清单，没有可展开的观点
  /^建议|个建议|一定要|千万别|必看|盘点|合集|清单|种草|好物|穿搭|拍照|妆容|发型/,
  // 单点政经消息，读起来像通报
  /拟就|发布声明|召开会议|作出部署|印发|出台|草案|二审|一审|通报|回应称/,
];

const ENTITIES = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'",
  "&#39;": "'", "&nbsp;": " ",
};

function decode(s) {
  return s
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function stripTags(s) {
  return decode(String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, ""));
}

/** 把标题整理成适合当「题目」的短语 */
function toTopic(raw) {
  let t = stripTags(raw).replace(/\s+/g, " ").trim();
  // 财新等源的栏目前缀，如「【商圈】烈酒之王…」；以及各种装饰性首尾符号
  t = t.replace(/^[【\[（(][^】\]）)]{1,6}[】\]）)]\s*/, "");
  t = t.replace(/[【\[（(]?[^】\]）)]{0,6}[】\]）)]\s*$/, (m) => (/[】\])]$/.test(m) ? "" : m));
  t = t.replace(/^[\s·•\-—|、,，。]+/, "").replace(/[\s·•\-—|、,，。]+$/, "").trim();
  // 去掉来源后缀
  t = t.replace(/[-_|]\s*(澎湃新闻|36氪|少数派|知乎|微博|财新|虎嗅|果壳|Readhub).*$/i, "").trim();

  // 不做截断：中英混排的标题很难判断「词边界」，半截的题目（「…性能超自」）
  // 比长题目难用得多。太长的直接交给 isUsable 丢掉，池子够大。
  return t.trim();
}

function isUsable(t) {
  if (t.length < 6 || t.length > 40) return false;
  if (BLOCK.some((re) => re.test(t))) return false;
  // 纯数字/符号为主的不像话题
  if ((t.match(/[\u4e00-\u9fa5a-zA-Z]/g) || []).length < 4) return false;
  return true;
}

/** 从 RSS/Atom 里取标题。先按 <item>/<entry> 切块，避免把频道标题当条目 */
function extractTitles(xml) {
  const titles = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/g) || [];
  const scope = blocks.length ? blocks : [xml];
  for (const b of scope) {
    const m = b.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (m) titles.push(m[1]);
  }
  return titles;
}

async function fetchSource(src) {
  const url = `${RSSHUB}/${src.route}`;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) {
      console.log(`  ✗ ${src.name.padEnd(8)} HTTP ${res.status}  (${src.route})`);
      return [];
    }
    const xml = await res.text();
    const all = extractTitles(xml).map(toTopic).filter(Boolean);
    const kept = [...new Set(all.filter(isUsable))];
    const dropped = all.length - kept.length;
    const uniq = kept.slice(0, LIMIT_PER_SOURCE);
    console.log(
      `  ✓ ${src.name.padEnd(8)} 取 ${String(uniq.length).padStart(2)} 条` +
        (dropped > 0 ? `（过滤掉 ${dropped} 条）` : "") +
        `  (${src.route})`
    );
    return uniq.map((t) => ({ topic: t, source: src.name }));
  } catch (e) {
    console.log(`  ✗ ${src.name.padEnd(8)} ${e.name === "AbortError" ? "超时" : e.message}`);
    return [];
  }
}

function renderData(payload) {
  const json = JSON.stringify(payload, null, 2)
    .split("\n")
    .map((l, i) => (i === 0 ? l : "  " + l))
    .join("\n");
  return `/* 由 tools/gen-news.mjs 自动生成，不要手改。
   重新生成：node tools/gen-news.mjs
   抓取时间与来源见文件内字段。 */
window.SPEAK60_NEWS = ${json};
`;
}

async function main() {
  console.log(`RSSHub: ${RSSHUB}\n`);
  const results = await Promise.all(SOURCES.map(fetchSource));

  const seen = new Set();
  const picked = [];
  // 轮流从各源取，避免被某一个源刷满
  for (let round = 0; round < LIMIT_PER_SOURCE; round++) {
    for (const list of results) {
      const item = list[round];
      if (!item) continue;
      if (seen.has(item.topic)) continue;
      seen.add(item.topic);
      picked.push(item);
      if (picked.length >= LIMIT_TOTAL) break;
    }
    if (picked.length >= LIMIT_TOTAL) break;
  }

  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const payload = {
    generatedAt: stamp,
    sources: SOURCES.map((s) => ({ name: s.name, route: s.route })),
    topics: picked.map((p) => p.topic),
    items: picked,
  };

  console.log(`\n抓取到 ${picked.length} 条题目（目标上限 ${LIMIT_TOTAL}）`);
  if (!picked.length) {
    console.log("⚠ 一条都没抓到，将写入空数据；应用会自动隐藏「时事」分类。");
  }
  console.log(`生成时间: ${stamp}`);

  if (DRY) {
    console.log("\n--dry 模式，不写文件。前 10 条预览：");
    picked.slice(0, 10).forEach((p, i) => console.log(`  ${i + 1}. [${p.source}] ${p.topic}`));
    return;
  }

  const out = join(ROOT, "news-data.js");
  await writeFile(out, renderData(payload), "utf8");
  console.log(`\n已写入 ${out}`);
  console.log("刷新页面即可看到「时事」分类（若这条没抓到，分类会自动消失）。");
}

main().catch((e) => {
  console.error("生成失败:", e);
  process.exit(1);
});
