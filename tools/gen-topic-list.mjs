#!/usr/bin/env node
/**
 * 从 index.html 生成 题库清单.md（题库清单是派生物，不要手改）。
 * 改完题目跑一下：node tools/gen-topic-list.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = await readFile(join(ROOT, "index.html"), "utf8");

/** 取某个 "topics: [" 之后的完整数组内容（括号配对，避免贪婪匹配跨块） */
function grabArray(text, from) {
  const k = text.indexOf("[", text.indexOf("topics: [", from));
  let depth = 0;
  for (let i = k; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]") {
      depth--;
      if (depth === 0) return text.slice(k, i + 1);
    }
  }
  throw new Error("数组括号不配对");
}

function topics(text, from) {
  return [...grabArray(text, from).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

// 深度研究先定义（它同时是 NICHES 的最后一项）
const research = { id: "deep-research", label: "深度研究", topics: topics(html, html.indexOf("var RESEARCH = {")) };

const niches = [];
{
  const base = html.indexOf("var NICHES = [\n    {");
  const rest = html.slice(base);
  const starts = [...rest.matchAll(/\n    \{\n      id: "/g)].map((m) => m.index);
  starts.push(rest.length);
  for (let i = 0; i < starts.length - 1; i++) {
    const blk = rest.slice(starts[i], starts[i + 1]);
    // NICHES 的最后一项是 `RESEARCH` 这个引用，不是字面量块，跳过（上面已单独解析）
    const idm = /id: "([^"]+)"/.exec(blk);
    const lm = /label: "([^"]+)"/.exec(blk);
    if (!idm || !lm) continue;
    niches.push({ id: idm[1], label: lm[1], topics: topics(blk, 0) });
  }
}

// 分组顺序（与界面无关，纯粹是这份文档的可读性分组）
const GROUPS = [
  { title: "通用 · 日常与思维", ids: ["daily", "mental-model"] },
  { title: "专业 · 你手上的领域", ids: ["ai-agent", "solo", "startup", "money", "dev"] },
  { title: "人文 · 文学 / 心理学 / 哲学", ids: ["literature", "psychology", "philosophy"] },
  { title: "身心状态", ids: ["wellbeing"] },
  { title: "深度研究 · 认知偏误与博弈论", ids: ["deep-research"] },
];
const byId = new Map([...niches, research].map((n) => [n.id, n]));
const listed = new Set(GROUPS.flatMap((g) => g.ids));
const missing = [...byId.keys()].filter((id) => !listed.has(id));
if (missing.length) throw new Error("有分类没进分组：" + missing.join(", "));

const all = [...byId.values()];
const total = all.reduce((a, n) => a + n.topics.length, 0);

const out = [];
out.push("# 即兴一分钟 · 完整题库");
out.push("");
out.push(`**${all.length} 个分类共 ${total} 题** ｜ 任一分类都可自由组合 ｜ 合计 **${total} 题**`);
out.push("");
out.push("**抽题范围严格生效**：设置里勾了哪些分类、或顶部下拉选了哪一个，抽出来的题就一定落在那个范围内。");
out.push("两种模式（临场直接讲 / 先查再讲）共用同一套范围，模式只决定要不要先给研究时间。");
out.push("");
out.push("> 本文件由 `node tools/gen-topic-list.mjs` 从 `index.html` 生成，不要手改。");
out.push("");
out.push("## 目录");
out.push("");
for (const g of GROUPS) {
  for (const id of g.ids) {
    const n = byId.get(id);
    out.push(`- [${n.label}](#${n.label}) — ${n.topics.length} 题`);
  }
}
for (const g of GROUPS) {
  out.push("");
  out.push("---");
  out.push("");
  out.push("# " + g.title);
  for (const id of g.ids) {
    const n = byId.get(id);
    out.push("");
    out.push("## " + n.label);
    out.push("");
    out.push(`共 ${n.topics.length} 题。`);
    out.push("");
    n.topics.forEach((t, i) => out.push(`${i + 1}. ${t}`));
  }
}
out.push("");

const target = join(ROOT, "题库清单.md");
const text = out.join("\n");
const prev = await readFile(target, "utf8").catch(() => null);
await writeFile(target, text, "utf8");
console.log(
  prev === text
    ? `✓ 题库清单.md 已是最新（${all.length} 类 · ${total} 题）`
    : `✓ 已重新生成 题库清单.md（${all.length} 类 · ${total} 题${prev ? "" : "，原文件不存在"}）`
);
