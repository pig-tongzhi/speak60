#!/usr/bin/env node
/**
 * 题库自检：题数、重复、id/标签唯一性、可疑的浅题。
 * 改完题目跑一下：node tools/check-topics.mjs
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = await readFile(join(ROOT, "index.html"), "utf8");

/** 取某个 "topics: [" 之后的完整数组内容（做括号配对，避免贪婪匹配跨块） */
function grabArray(text, from) {
  const k = text.indexOf("[", text.indexOf("topics: [", from));
  let depth = 0;
  for (let i = k; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]") {
      depth--;
      if (depth === 0) return { body: text.slice(k, i + 1), end: i };
    }
  }
  throw new Error("数组括号不配对");
}

const niches = [];
{
  const start = html.indexOf("var RESEARCH = {");
  const r = grabArray(html, start);
  niches.push({ id: "deep-research", label: "深度研究", topics: [...r.body.matchAll(/"([^"]+)"/g)].map((m) => m[1]) });
}
{
  const base = html.indexOf("var NICHES = [\n    {");
  const rest = html.slice(base);
  const starts = [...rest.matchAll(/\n    \{\n      id: "/g)].map((m) => m.index);
  starts.push(rest.length);
  for (let i = 0; i < starts.length - 1; i++) {
    const blk = rest.slice(starts[i], starts[i + 1]);
    const id = /id: "([^"]+)"/.exec(blk)[1];
    const label = /label: "([^"]+)"/.exec(blk)[1];
    const { body } = grabArray(blk, 0);
    niches.push({ id, label, topics: [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]) });
  }
}

let bad = 0;
const seenIds = new Set();
const owner = new Map();
console.log("分类                 题数");
console.log("─".repeat(30));
let total = 0;
for (const n of niches) {
  total += n.topics.length;
  const dup = n.topics.filter((t, i) => n.topics.indexOf(t) !== i);
  const flag = [];
  if (seenIds.has(n.id)) flag.push("id 重复");
  seenIds.add(n.id);
  if (dup.length) flag.push("内部重复: " + [...new Set(dup)].join("/"));
  // 深度研究是「先查再讲」模式的独立抽题池，不与主池混合，
  // 所以它和普通分类重名不影响抽题，不报。
  if (n.id !== "deep-research") {
    for (const t of n.topics) {
      if (owner.has(t) && !dup.includes(t)) flag.push(`与「${owner.get(t)}」重复: ${t}`);
      else owner.set(t, n.label);
    }
  }
  if (flag.length) bad++;
  console.log(n.label.padEnd(20) + String(n.topics.length).padStart(4) + (flag.length ? "  ⚠ " + flag.join("; ") : ""));
}
console.log("─".repeat(30));
console.log("合计".padEnd(20) + String(total).padStart(4));
if (bad) {
  console.log(`\n⚠ ${bad} 个分类有问题，见上面标注。`);
  process.exit(1);
}
console.log("\n✓ 无重复、无冲突");
