/**
 * 轻量「检索增强」：基于 dailyKnowledge 标题/摘要关键词与用户消息重叠度打分，
 * 取 top-k 片段注入大模型 system（非向量库；后续可换 embedding）。
 */
const fs = require("fs");
const path = require("path");

let cached = null;

function topicMatchesSpecies(topic, species) {
  const sp = species === "dog" ? "dog" : "cat";
  if (!topic.species || topic.species.length === 0) return true;
  return topic.species.indexOf(sp) !== -1;
}

function flattenDailyTopics(knowledge) {
  const out = [];
  const dk = knowledge && knowledge.dailyKnowledge;
  if (!dk || !dk.modules) return out;
  for (const mod of dk.modules) {
    for (const t of mod.topics || []) {
      out.push({ moduleTitle: mod.title || "", topic: t });
    }
  }
  return out;
}

/** 与 dailyKnowledge 结构兼容；条目带 _private 时检索加权 */
function flattenPrivateTopics(root) {
  const out = [];
  const mods = root && root.modules;
  if (!Array.isArray(mods)) return out;
  for (const mod of mods) {
    for (const t of mod.topics || []) {
      const topic = Object.assign({}, t, { _private: true });
      out.push({ moduleTitle: mod.title || "私人笔记", topic });
    }
  }
  return out;
}

/** 与 healthBot 一致：去掉档案前缀再匹配关键词 */
function stripProfilePrefix(msg) {
  return String(msg || "").replace(/^【用户已选档案】[\s\S]*?\n\n/, "").trim();
}

function pickTeaser(topic, species) {
  const sp = species === "dog" ? "dog" : "cat";
  if (sp === "dog" && topic.teaserDog) return topic.teaserDog;
  if (sp === "cat" && topic.teaserCat) return topic.teaserCat;
  return (topic.teaser || "").trim();
}

function keywordBuckets(text) {
  const s = String(text || "")
    .replace(/[（）()\[\]「」《》]/g, " ")
    .replace(/\s+/g, "");
  const parts = s.split(/[、，。；：\n]/).map((x) => x.trim()).filter((x) => x.length >= 2);
  const uni = new Set(parts);
  return [...uni];
}

function scoreMatch(userMsg, moduleTitle, topic, species) {
  const m = String(userMsg || "").replace(/\s/g, "");
  if (!m) return 0;
  let score = 0;
  const seen = new Set();
  const blobs = [
    moduleTitle,
    topic.title || "",
    topic.teaser || "",
    topic.teaserDog || "",
    topic.teaserCat || "",
    pickTeaser(topic, species),
  ];
  for (const b of blobs) {
    for (const kw of keywordBuckets(b)) {
      if (seen.has(kw)) continue;
      seen.add(kw);
      if (m.indexOf(kw) !== -1) score += Math.min(24, kw.length * 3);
    }
  }
  const plainTitle = String(topic.title || "").replace(/\s/g, "");
  if (plainTitle.length >= 4 && m.indexOf(plainTitle) !== -1) score += 28;
  if (topic._private) score = Math.floor(score * 1.34);
  return score;
}

function buildSnippet(moduleTitle, topic, maxLen, species) {
  const sci = (topic.science || "").replace(/\s+/g, " ").trim().slice(0, 260);
  const vet = (topic.vetWhen || "").replace(/\s+/g, " ").trim().slice(0, 200);
  const teaser = pickTeaser(topic, species).replace(/\s+/g, " ").trim().slice(0, 160);
  const lines = [
    `「${moduleTitle}」· ${topic.title || ""}`,
    teaser ? `卡片摘要：${teaser}` : "",
    sci ? `科学要点（节选）：${sci}` : "",
    vet ? `何时看兽医（节选）：${vet}` : "",
  ].filter(Boolean);
  let text = lines.join("\n");
  if (text.length > maxLen) text = text.slice(0, maxLen) + "…";
  return text;
}

/**
 * @param {string} userMsg
 * @param {string} species "cat"|"dog"
 * @param {string} publicDir
 * @param {{ limit?: number, maxSnippetLen?: number }} options
 */
function retrieveDailyKnowledgeSnippets(userMsg, species, publicDir, options) {
  const opts = options || {};
  const limit = opts.limit != null ? opts.limit : Number(process.env.RAG_TOP_K) || 3;
  const maxSnippetLen = opts.maxSnippetLen != null ? opts.maxSnippetLen : 400;
  const fp = path.join(publicDir, "data", "knowledge.json");
  if (!cached || cached.filePath !== fp) {
    const raw = fs.readFileSync(fp, "utf8");
    cached = { filePath: fp, knowledge: JSON.parse(raw) };
  }
  const flat = flattenDailyTopics(cached.knowledge);
  const pfp = path.join(publicDir, "data", "private-knowledge.json");
  let privFlat = [];
  if (fs.existsSync(pfp)) {
    try {
      const pk = JSON.parse(fs.readFileSync(pfp, "utf8"));
      privFlat = flattenPrivateTopics(pk);
    } catch (e) {
      /* ignore */
    }
  }
  const flatAll = flat.concat(privFlat);
  const stripped = stripProfilePrefix(userMsg);
  const scored = [];
  const spNorm = species === "dog" ? "dog" : "cat";
  for (const { moduleTitle, topic } of flatAll) {
    if (!topicMatchesSpecies(topic, species)) continue;
    const sc = scoreMatch(stripped, moduleTitle, topic, spNorm);
    scored.push({ moduleTitle, topic, sc });
  }
  scored.sort((a, b) => b.sc - a.sc);
  const positive = scored.filter((x) => x.sc > 0).slice(0, limit);
  const snippets = positive.map((x) => ({
    score: x.sc,
    topicId: x.topic.id || "",
    text: buildSnippet(x.moduleTitle, x.topic, maxSnippetLen, spNorm),
  }));
  return {
    hit: snippets.length > 0,
    snippets,
    topScore: scored.length ? scored[0].sc : 0,
  };
}

function formatRagSystemBlock(result) {
  const header =
    "【检索背景·日常知识摘要】以下片段来自内置科普卡片与（若有）主人投喂的私人笔记，仅用于辅助措辞与联想；不是用户自述，也不是化验/影像结果。不得把片段说成「用户已经检查过」或「已经确诊」。若条目标注为私人笔记，可温和体现「结合你记录的经验」，但仍不得捏造事实。";
  if (!result.hit || !result.snippets.length) {
    return (
      header +
      "\n（当前表述未命中具体卡片关键词；请勿捏造百科条目、检查项目或病名诊断。）"
    );
  }
  const body = result.snippets
    .map((s, i) => `${i + 1}. [${s.topicId || "topic"}]\n${s.text}`)
    .join("\n\n");
  return `${header}\n${body}`;
}

function reloadKnowledgeCache() {
  cached = null;
}

module.exports = {
  retrieveDailyKnowledgeSnippets,
  formatRagSystemBlock,
  reloadKnowledgeCache,
};
