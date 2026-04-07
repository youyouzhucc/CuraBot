/**
 * CuraBot 临床逻辑引擎（规则层）
 * - 标准化槽位管理
 * - 缺失信息追问
 * - 加权风险评分
 * - SOAP 结构化输出
 */

const REQUIRED_SLOTS = [
  "chief_complaint",
  "onset_duration",
  "frequency",
  "appetite",
  "spirit",
  "hydration_hint",
];

const SLOT_QUESTIONS = {
  chief_complaint: "你最担心的核心症状是哪个（例如呕吐、腹泻、咳嗽、排尿异常）？",
  onset_duration: "大概从什么时候开始的？是突然出现还是逐渐加重？",
  frequency: "过去 24 小时内大约发生了几次？",
  appetite: "现在食欲怎么样？完全不吃、吃得少，还是基本正常？",
  spirit: "精神状态如何？活跃、一般，还是明显萎靡？",
  hydration_hint: "有口腔发干、皮肤回弹慢、眼窝下陷等脱水迹象吗？",
};

const EMERGENCY_KEYWORDS = /(呼吸困难|张口呼吸|抽搐|昏迷|无尿|尿不出|持续呕吐|呕血|黑便|便血|血尿|中毒|误食百合|木糖醇|巧克力)/;

function safeText(v) {
  return String(v == null ? "" : v).trim();
}

function detectSpeciesFromText(text) {
  const t = safeText(text);
  const hitDog = /(狗狗|小狗|犬|汪)/.test(t);
  const hitCat = /(猫猫|小猫|猫咪|喵)/.test(t);
  if (hitDog && !hitCat) return "dog";
  if (hitCat && !hitDog) return "cat";
  return null;
}

function normalizeStructured(input) {
  const s = input && typeof input === "object" ? { ...input } : {};
  const out = {
    chief_complaint: safeText(s.chief_complaint),
    onset_duration: safeText(s.onset_duration),
    frequency: safeText(s.frequency),
    appetite: safeText(s.appetite),
    spirit: safeText(s.spirit),
    hydration_hint: safeText(s.hydration_hint),
    vomiting: safeText(s.vomiting),
    diarrhea: safeText(s.diarrhea),
    urination: safeText(s.urination),
    blood_sign: safeText(s.blood_sign),
    toxin_exposure: safeText(s.toxin_exposure),
    breathing_issue: safeText(s.breathing_issue),
    pain_level: safeText(s.pain_level),
  };
  return out;
}

function mergeStructured(base, extra) {
  const a = normalizeStructured(base);
  const b = normalizeStructured(extra);
  const out = { ...a };
  Object.keys(b).forEach((k) => {
    if (!out[k] && b[k]) out[k] = b[k];
  });
  return out;
}

function structuredFromVisionSummary(visionSummary) {
  const t = safeText(visionSummary);
  if (!t) return normalizeStructured({});
  return normalizeStructured({
    chief_complaint:
      /(呕吐|呕吐物|反流)/.test(t)
        ? "呕吐"
        : /(腹泻|稀便|便)/.test(t)
          ? "腹泻/排便异常"
          : /(尿|排尿|膀胱)/.test(t)
            ? "排尿异常"
            : "",
    blood_sign: /(血|血丝|暗红|咖啡色|黑便)/.test(t) ? "可疑出血" : "",
    toxin_exposure: /(异物|塑料|线状物|药片|毒物)/.test(t) ? "可疑暴露/异物" : "",
    hydration_hint: /(脱水|黏膜干|皮肤回弹慢)/.test(t) ? "疑似脱水" : "",
    vomiting: /(呕吐|反流)/.test(t) ? "是" : "",
    diarrhea: /(腹泻|稀便)/.test(t) ? "是" : "",
  });
}

function missingSlots(structured) {
  const s = normalizeStructured(structured);
  return REQUIRED_SLOTS.filter((k) => !safeText(s[k]));
}

function buildFollowUpQuestions(structured, limit) {
  const miss = missingSlots(structured);
  return miss.slice(0, Math.max(1, limit || 2)).map((k) => SLOT_QUESTIONS[k]).filter(Boolean);
}

function scoreRisk(structured, rawText) {
  const s = normalizeStructured(structured);
  const blob = [rawText || "", ...Object.values(s)].join(" ");
  let score = 0;
  const hits = [];

  const add = (cond, val, reason) => {
    if (!cond) return;
    score += val;
    hits.push({ weight: val, reason });
  };

  add(/(呕吐|吐|反流)/.test(blob) && /(频繁|多次|>?\s*5|5次|六次|七次)/.test(blob), 6, "频繁呕吐");
  add(/(牙龈发白|发绀|紫绀|呼吸困难|张口呼吸|抽搐|昏迷)/.test(blob), 5, "急危生命体征");
  add(/(误食|吞食).*(百合|巧克力|木糖醇|葡萄|洋葱|杀虫剂|药片)/.test(blob), 10, "潜在中毒暴露");
  add(/(尿不出|无尿|24小时没尿|完全没尿|闭尿)/.test(blob), 6, "疑似尿闭");
  add(/(呕血|便血|黑便|血尿)/.test(blob), 5, "出血风险信号");
  add(/(精神差|萎靡|不吃不喝|拒食|持续疼痛)/.test(blob), 4, "全身状态变差");
  add(/(精神正常|食欲正常|还能玩|活跃)/.test(blob), -2, "一般状态尚可");

  let level = "unclear";
  if (score >= 9) level = "emergency";
  else if (score >= 4) level = "moderate";
  else if (score <= 0) level = "normal";
  else level = "unclear";

  if (EMERGENCY_KEYWORDS.test(blob) && level !== "emergency") {
    level = "moderate";
  }

  return { score, level, hits };
}

function buildSoap({ species, userMessage, structured, visionSummary, triage, planText }) {
  const sp = species === "dog" ? "犬" : "猫";
  const s = normalizeStructured(structured);
  const triageLine =
    triage.level === "emergency"
      ? "高风险，建议尽快急诊评估。"
      : triage.level === "moderate"
        ? "中等风险，建议尽快门诊。"
        : triage.level === "normal"
          ? "低风险，建议观察并复评。"
          : "信息不足，需补充关键病史。";
  return {
    S: `家长主诉：${safeText(userMessage) || "（未提供）"}`,
    O: `物种：${sp}；视觉线索：${safeText(visionSummary) || "未上传图片或无有效视觉结论"}；结构化要点：${JSON.stringify(s)}`,
    A: `分诊评分：${triage.score}；风险分层：${triage.level}；判断：${triageLine}`,
    P:
      safeText(planText) ||
      "先补齐缺失病史（起病时间、频次、精神食欲、脱水迹象）；若出现呼吸困难、抽搐、持续无尿、明显出血等红旗信号，立即就医。",
  };
}

function enforceClinicalGuardrail({ reply, triageLevel, missingSlots, userInput }) {
  let out = safeText(reply);
  if (!out) return out;
  const missCount = Array.isArray(missingSlots) ? missingSlots.length : 0;
  const hasEmergencyWord = EMERGENCY_KEYWORDS.test(String(userInput || ""));
  const lvl = safeText(triageLevel || "unclear");
  let finalLevel = lvl || "unclear";
  if ((finalLevel === "normal" && missCount >= 2) || finalLevel === "unclear") {
    finalLevel = "不明确";
  } else if (finalLevel === "moderate") {
    finalLevel = "中等";
  } else if (finalLevel === "emergency") {
    finalLevel = "紧急";
  } else {
    finalLevel = "正常";
  }
  if (hasEmergencyWord) {
    out =
      "⚠ 建议优先联系附近动物医院或急诊，必要时立即出发就医。\n" +
      out.replace(/^⚠.*\n?/, "");
    if (finalLevel === "正常") finalLevel = "中等";
  }
  out = out.replace(/【\s*建议分层\s*[：:]\s*(紧急|中等|正常|不明确)\s*】/g, "").trim();
  out += `\n\n【建议分层：${finalLevel}】`;
  return out;
}

module.exports = {
  REQUIRED_SLOTS,
  detectSpeciesFromText,
  normalizeStructured,
  mergeStructured,
  structuredFromVisionSummary,
  missingSlots,
  buildFollowUpQuestions,
  scoreRisk,
  buildSoap,
  enforceClinicalGuardrail,
};

