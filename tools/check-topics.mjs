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
  // 深度研究现在也是一个普通分类，可以和别的分类同时勾选、进同一个抽题池，
  // 所以它和普通分类重名同样要报（抽题池会去重，导致界面题数和实际池子对不上）。
  for (const t of n.topics) {
    if (owner.has(t) && !dup.includes(t)) flag.push(`与「${owner.get(t)}」重复: ${t}`);
    else owner.set(t, n.label);
  }
  if (flag.length) bad++;
  console.log(n.label.padEnd(20) + String(n.topics.length).padStart(4) + (flag.length ? "  ⚠ " + flag.join("; ") : ""));
}
console.log("─".repeat(30));
console.log("合计".padEnd(20) + String(total).padStart(4));

// 题库冻结：2026-10 定的口径是「宁少勿多，先不加题」，压到了 500 题以内。
// 真要加题，就调高这个上限，并在提交信息里说清为什么值得破例——
// 别悄悄加，题库变多这件事上一轮就是这样失控的。
const MAX_TOPICS = 500;
if (total > MAX_TOPICS) {
  console.log(`\n⚠ 题库共 ${total} 题，超过上限 ${MAX_TOPICS} 题。`);
  console.log(`  当前口径是暂时不加题。确有必要加，请调高 tools/check-topics.mjs 里的 MAX_TOPICS 并说明理由。`);
  bad++;
}

if (bad) {
  console.log(`\n⚠ ${bad} 个分类有问题，见上面标注。`);
  process.exit(1);
}
console.log("\n✓ 无重复、无冲突");
