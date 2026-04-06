/**
 * 校验 public/data/knowledge.json：JSON 可解析、references.id 唯一、
 * 各 topic 等处的 refIds 均指向已声明的参考文献。
 * 用法：node scripts/validate-knowledge.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const kp = path.join(root, "public", "data", "knowledge.json");

function collectRefIdUses(node, out, pathStr) {
  if (node == null) return;
  if (Array.isArray(node)) {
    node.forEach((x, i) => collectRefIdUses(x, out, `${pathStr}[${i}]`));
    return;
  }
  if (typeof node === "object") {
    if (Array.isArray(node.refIds)) {
      node.refIds.forEach((id, i) => {
        out.push({ id: String(id), where: `${pathStr}.refIds[${i}]` });
      });
    }
    for (const k of Object.keys(node)) {
      collectRefIdUses(node[k], out, pathStr ? `${pathStr}.${k}` : k);
    }
  }
}

let errors = [];
let raw;
try {
  raw = fs.readFileSync(kp, "utf8");
} catch (e) {
  console.error("FAIL: cannot read", kp, e.message);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  console.error("FAIL: JSON parse", e.message);
  process.exit(1);
}

const refs = data.references || [];
const seen = new Map();
for (const r of refs) {
  if (!r || !r.id) {
    errors.push("references entry missing id");
    continue;
  }
  if (seen.has(r.id)) errors.push(`duplicate references.id: ${r.id}`);
  seen.set(r.id, r);
}

const uses = [];
collectRefIdUses(data, uses, "knowledge");

for (const u of uses) {
  if (!seen.has(u.id)) errors.push(`unknown refIds id "${u.id}" at ${u.where}`);
}

if (!data.meta || !data.meta.governance) {
  errors.push("meta.governance missing (recommended for LLM safety appendix)");
}

if (errors.length) {
  console.error("knowledge.json validation FAILED:\n" + errors.map((e) => " - " + e).join("\n"));
  process.exit(1);
}

console.log("knowledge.json OK — references:", refs.length, "refId uses:", uses.length);
