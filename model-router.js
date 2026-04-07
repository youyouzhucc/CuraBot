/**
 * 双模型路由层：
 * - DeepSeek：结构化临床追问/抽取
 * - Gemini：视觉分析与最终润色
 *
 * 注意：密钥仅从环境变量读取，不在代码写死。
 */

function hasDeepSeek() {
  return Boolean((process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || "").trim());
}

function hasGemini() {
  return Boolean((process.env.GEMINI_API_KEY || "").trim());
}

function getDeepSeekConfig() {
  const key = (process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || "").trim();
  const base = ((process.env.DEEPSEEK_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.deepseek.com/v1") + "")
    .trim()
    .replace(/\/$/, "");
  const model = (process.env.DEEPSEEK_MODEL || process.env.OPENAI_MODEL || "deepseek-chat").trim();
  return { key, base, model };
}

function getGeminiConfig() {
  const key = (process.env.GEMINI_API_KEY || "").trim();
  const model = (process.env.GEMINI_MODEL || "gemini-1.5-pro").trim();
  return { key, model };
}

function extractJsonObject(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

function heuristicClinicalExtraction(userText) {
  const t = String(userText || "");
  return {
    structured: {
      chief_complaint:
        /(吐|呕)/.test(t)
          ? "呕吐"
          : /(拉|泻|腹泻)/.test(t)
            ? "腹泻"
            : /(咳|喘|呼吸)/.test(t)
              ? "呼吸道异常"
              : /(尿|排尿)/.test(t)
                ? "排尿异常"
                : "",
      onset_duration: /(今天|昨天|前天|小时|天)/.test(t) ? "用户已提及时间线（待量化）" : "",
      frequency: /(次|频繁|一直|反复)/.test(t) ? "用户已提及频次（待量化）" : "",
      appetite: /(食欲|不吃|拒食|还吃)/.test(t) ? "用户已提及食欲变化" : "",
      spirit: /(精神|萎靡|活跃|没精神)/.test(t) ? "用户已提及精神状态" : "",
      hydration_hint: /(脱水|口干|皮肤回弹|眼窝)/.test(t) ? "用户提及脱水线索" : "",
      vomiting: /(吐|呕)/.test(t) ? "是" : "",
      diarrhea: /(拉|泻|腹泻)/.test(t) ? "是" : "",
      urination: /(尿|排尿|尿闭|血尿)/.test(t) ? "异常待确认" : "",
      blood_sign: /(血|黑便|呕血|血尿)/.test(t) ? "可疑" : "",
      toxin_exposure: /(误食|百合|巧克力|木糖醇|洋葱|葡萄)/.test(t) ? "可疑暴露" : "",
      breathing_issue: /(喘|呼吸困难|张口呼吸)/.test(t) ? "是" : "",
      pain_level: /(疼|痛|叫|弓背)/.test(t) ? "疑似疼痛" : "",
    },
  };
}

async function deepseekAnalyzeClinical({ userInput, species, history, schema }) {
  if (!hasDeepSeek()) {
    return { mode: "heuristic", ...heuristicClinicalExtraction(userInput) };
  }
  const { key, base, model } = getDeepSeekConfig();
  const sys =
    "你是宠物临床分诊结构化助手。仅输出 JSON，不要解释。根据输入提取结构化病史字段。未知字段填空字符串。";
  const usr = [
    `物种：${species || "unknown"}`,
    `目标 schema：${JSON.stringify(schema || [])}`,
    "请输出格式：",
    '{"structured":{"chief_complaint":"","onset_duration":"","frequency":"","appetite":"","spirit":"","hydration_hint":"","vomiting":"","diarrhea":"","urination":"","blood_sign":"","toxin_exposure":"","breathing_issue":"","pain_level":""}}',
    `用户输入：${String(userInput || "").slice(0, 3000)}`,
    `近期对话：${JSON.stringify((history || []).slice(-6))}`,
  ].join("\n");

  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 600,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: usr },
        ],
      }),
    });
    if (!r.ok) return { mode: `deepseek_http_${r.status}`, ...heuristicClinicalExtraction(userInput) };
    const j = await r.json().catch(() => ({}));
    const txt = j && j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : "";
    const obj = extractJsonObject(txt);
    if (!obj || !obj.structured) return { mode: "deepseek_parse_fallback", ...heuristicClinicalExtraction(userInput) };
    return { mode: "deepseek", structured: obj.structured };
  } catch (e) {
    return { mode: "deepseek_fetch_failed", ...heuristicClinicalExtraction(userInput) };
  }
}

async function geminiAnalyzeImage({ images, species, context }) {
  if (!hasGemini()) return { mode: "no_gemini", summary: "" };
  if (!Array.isArray(images) || !images.length) return { mode: "no_image", summary: "" };
  const { key, model } = getGeminiConfig();
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

  const imageParts = images
    .filter((x) => typeof x === "string" && x.trim())
    .slice(0, 3)
    .map((u) => ({ file_data: { mime_type: "image/*", file_uri: u } }));

  const prompt = [
    `当前物种：${species === "dog" ? "犬" : "猫"}`,
    `上下文：${String(context || "").slice(0, 600)}`,
    "请仅描述图像可见临床线索（颜色、形态、可见异常），不要确诊，不要给药。",
    "输出 80-140 字简洁中文。",
  ].join("\n");

  const body = {
    contents: [{ parts: [{ text: prompt }, ...imageParts] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 220 },
  };

  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { mode: `gemini_http_${r.status}`, summary: "" };
    const j = await r.json().catch(() => ({}));
    const txt =
      j &&
      j.candidates &&
      j.candidates[0] &&
      j.candidates[0].content &&
      Array.isArray(j.candidates[0].content.parts)
        ? j.candidates[0].content.parts.map((p) => p.text || "").join("\n").trim()
        : "";
    return { mode: "gemini", summary: txt };
  } catch (e) {
    return { mode: "gemini_fetch_failed", summary: "" };
  }
}

async function geminiComposeReport({ species, structured, triage, followUpQuestions, ragText, soap }) {
  if (!hasGemini()) return { mode: "fallback", text: "" };
  const { key, model } = getGeminiConfig();
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const prompt = [
    "你是宠物临床分诊沟通助手。要求：专业、温和、短句、不确诊、不提供剂量。",
    `物种：${species === "dog" ? "狗狗" : "猫猫"}`,
    `结构化病史：${JSON.stringify(structured)}`,
    `风险分层：${triage.level}（score=${triage.score}）`,
    `需补充问题：${JSON.stringify(followUpQuestions || [])}`,
    `RAG 参考：${String(ragText || "").slice(0, 1400)}`,
    `SOAP：${JSON.stringify(soap)}`,
    "请输出：1) 给家长的话（4-8行） 2) 下一步行动（最多3条） 3) 末尾单独一行【建议分层：紧急/中等/正常/不明确】",
  ].join("\n");

  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.25, maxOutputTokens: 520 },
      }),
    });
    if (!r.ok) return { mode: `gemini_http_${r.status}`, text: "" };
    const j = await r.json().catch(() => ({}));
    const txt =
      j &&
      j.candidates &&
      j.candidates[0] &&
      j.candidates[0].content &&
      Array.isArray(j.candidates[0].content.parts)
        ? j.candidates[0].content.parts.map((p) => p.text || "").join("\n").trim()
        : "";
    return { mode: "gemini", text: txt };
  } catch (e) {
    return { mode: "gemini_fetch_failed", text: "" };
  }
}

module.exports = {
  hasDeepSeek,
  hasGemini,
  deepseekAnalyzeClinical,
  geminiAnalyzeImage,
  geminiComposeReport,
};

