/**
 * daily-learner.js — CuraBot 每日自动学习脚本
 *
 * 功能：读取待学习主题 → 调 LLM 生成知识条目 → 写入草稿
 * 用法：node daily-learner.js          (独立运行)
 *       require("./daily-learner").run() (被 server.js 调用)
 */

const path = require("path");
const fs = require("fs");

/** 从 .env 加载配置 */
require("dotenv").config({ path: path.join(__dirname, ".env") });
if (fs.existsSync(path.join(__dirname, ".env.local"))) {
  require("dotenv").config({ path: path.join(__dirname, ".env.local"), override: true });
}

const TOPICS_PATH = path.join(__dirname, "data", "learning-topics.json");
const DRAFTS_PATH = path.join(__dirname, "data", "learning-drafts.json");
const KNOWLEDGE_PATH = path.join(__dirname, "public", "data", "knowledge.json");
const AUDIT_PATH = path.join(__dirname, "data", "learning-audit.jsonl");
const BATCH_SIZE = Number(process.env.LEARN_BATCH_SIZE) || 3;

/** 复用 server.js 相同的 LLM 配置解析 */
function resolveLlmConfig() {
  const ds = (process.env.DEEPSEEK_API_KEY || "").trim();
  const oa = (process.env.OPENAI_API_KEY || "").trim();
  const key = oa || ds;
  let base = (process.env.OPENAI_BASE_URL || "").trim().replace(/\/$/, "");
  let model = (process.env.OPENAI_MODEL || "").trim();
  const provider = (process.env.LLM_PROVIDER || "").toLowerCase().trim();
  if (!key) return { key: "", base: "", model: "" };
  if (!base) {
    if (ds && !oa) base = "https://api.deepseek.com/v1";
    else if (provider === "deepseek") base = "https://api.deepseek.com/v1";
    else base = "https://api.openai.com/v1";
  }
  if (!model) model = base.includes("deepseek.com") ? "deepseek-chat" : "gpt-4o-mini";
  return { key, base, model };
}

/** 从 knowledge.json 提取所有可用的 refIds */
function getValidRefIds() {
  try {
    const k = JSON.parse(fs.readFileSync(KNOWLEDGE_PATH, "utf8"));
    return (k.references || []).map((r) => r.id);
  } catch (_) {
    return ["mvm", "ettinger", "silverstein-ecc"];
  }
}

/** 从 knowledge.json 提取所有已有 topic ID（防重复） */
function getExistingTopicIds() {
  try {
    const k = JSON.parse(fs.readFileSync(KNOWLEDGE_PATH, "utf8"));
    const ids = new Set();
    if (k.dailyKnowledge && k.dailyKnowledge.modules) {
      for (const mod of k.dailyKnowledge.modules) {
        for (const t of mod.topics || []) {
          if (t.id) ids.add(t.id);
        }
      }
    }
    return ids;
  } catch (_) {
    return new Set();
  }
}

/** 调用 LLM 生成一条知识条目 */
async function generateTopic(query, species, validRefIds) {
  const { key, base, model } = resolveLlmConfig();
  if (!key) throw new Error("未配置 LLM API Key");

  const system = [
    "你是兽医科普编辑，为 CuraBot 宠物健康知识库生成标准条目。",
    "严格输出**纯 JSON**（不要 markdown 代码块、不要多余文字），格式如下：",
    "{",
    '  "id": "health-xxx-xxx"（英文短横线ID，如 health-heartworm-dog）,',
    '  "title": "中文标题（10-20字）",',
    '  "teaser": "一句话摘要（30字内）",',
    `  "species": ${JSON.stringify(species)},`,
    '  "science": "科学解释（100-200字，科普定位，不诊断不开药）",',
    '  "advice": ["家庭护理建议1", "建议2", "建议3"（3-5条）],',
    '  "vetWhen": "何时看兽医（50字内）",',
    `  "refIds": [从以下列表中选 1-3 个最相关的: ${validRefIds.slice(0, 30).join(", ")}]`,
    "}",
    "",
    "要求：",
    "- 科普定位，面向宠物主人，简体中文",
    "- 不确诊、不开药、不编造参考文献ID",
    "- science 字段要有实质内容，不要空泛",
    "- advice 要具体可操作",
  ].join("\n");

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);

  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `请为以下主题生成知识条目：${query}` },
        ],
        temperature: 0.3,
        max_tokens: 800,
      }),
      signal: ac.signal,
    });
    clearTimeout(timer);

    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`LLM HTTP ${r.status}: ${errText.slice(0, 200)}`);
    }

    const data = await r.json();
    const text =
      data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) throw new Error("LLM 返回空内容");

    // 提取 JSON（兼容 markdown 代码块包裹的情况）
    let jsonStr = text.trim();
    const mdMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (mdMatch) jsonStr = mdMatch[1].trim();

    const topic = JSON.parse(jsonStr);

    // 校验必填字段
    const required = ["id", "title", "teaser", "species", "science", "advice", "vetWhen"];
    for (const field of required) {
      if (!topic[field]) throw new Error(`缺少必填字段: ${field}`);
    }
    if (!Array.isArray(topic.advice) || topic.advice.length === 0) {
      throw new Error("advice 必须是非空数组");
    }
    if (!Array.isArray(topic.species)) {
      throw new Error("species 必须是数组");
    }

    // 过滤无效 refIds
    const validSet = new Set(validRefIds);
    topic.refIds = (topic.refIds || []).filter((id) => validSet.has(id));
    if (topic.refIds.length === 0) topic.refIds = ["mvm"];

    return topic;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

/** 读取草稿文件 */
function readDrafts() {
  try {
    return JSON.parse(fs.readFileSync(DRAFTS_PATH, "utf8"));
  } catch (_) {
    return { drafts: [], lastRun: null };
  }
}

/** 写入草稿文件 */
function writeDrafts(data) {
  fs.writeFileSync(DRAFTS_PATH, JSON.stringify(data, null, 2), "utf8");
}

/** 记录审计日志 */
function auditLog(action, detail) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    action,
    ...detail,
  });
  fs.appendFileSync(AUDIT_PATH, line + "\n", "utf8");
}

/** 主运行函数 */
async function run() {
  console.log(`[daily-learner] 开始运行 ${new Date().toISOString()}`);

  // 读取主题列表
  let topicsData;
  try {
    topicsData = JSON.parse(fs.readFileSync(TOPICS_PATH, "utf8"));
  } catch (e) {
    console.error("[daily-learner] 无法读取 learning-topics.json:", e.message);
    return { ok: false, error: "topics_not_found" };
  }

  // 筛选未完成的主题
  const pending = topicsData.topics.filter((t) => !t.done);
  if (pending.length === 0) {
    console.log("[daily-learner] 所有主题已完成，无需学习");
    return { ok: true, learned: 0, message: "all_done" };
  }

  const batch = pending.slice(0, BATCH_SIZE);
  const validRefIds = getValidRefIds();
  const existingIds = getExistingTopicIds();
  const draftsData = readDrafts();
  const draftIds = new Set((draftsData.drafts || []).map((d) => d.topic && d.topic.id));

  let successCount = 0;
  const results = [];

  for (const item of batch) {
    try {
      console.log(`[daily-learner] 生成: ${item.query}`);
      const topic = await generateTopic(item.query, item.species, validRefIds);

      // 检查重复
      if (existingIds.has(topic.id) || draftIds.has(topic.id)) {
        topic.id = topic.id + "-" + Date.now().toString(36).slice(-4);
      }

      const draft = {
        draftId: "draft-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
        createdAt: new Date().toISOString(),
        sourceQuery: item.query,
        targetModule: item.module || "diet",
        topic,
      };

      draftsData.drafts.push(draft);
      draftIds.add(topic.id);
      item.done = true;
      successCount++;
      results.push({ query: item.query, id: topic.id, ok: true });
      console.log(`[daily-learner] ✅ ${topic.id}: ${topic.title}`);

      auditLog("generated", { topicId: topic.id, query: item.query });
    } catch (e) {
      console.error(`[daily-learner] ❌ ${item.query}: ${e.message}`);
      results.push({ query: item.query, ok: false, error: e.message });
      auditLog("error", { query: item.query, error: e.message });
    }
  }

  // 清理 30 天前的草稿
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  draftsData.drafts = draftsData.drafts.filter((d) => {
    return new Date(d.createdAt).getTime() > thirtyDaysAgo;
  });

  draftsData.lastRun = new Date().toISOString();
  writeDrafts(draftsData);

  // 更新主题列表
  fs.writeFileSync(TOPICS_PATH, JSON.stringify(topicsData, null, 2), "utf8");

  const summary = {
    ok: true,
    learned: successCount,
    total: batch.length,
    remaining: topicsData.topics.filter((t) => !t.done).length,
    results,
  };
  console.log(`[daily-learner] 完成: ${successCount}/${batch.length} 成功, 剩余 ${summary.remaining} 个主题`);
  return summary;
}

// 支持独立运行
if (require.main === module) {
  run().then((r) => {
    console.log("[daily-learner] 结果:", JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  });
}

module.exports = { run, readDrafts, writeDrafts, getExistingTopicIds, auditLog };
