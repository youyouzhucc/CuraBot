/**
 * JSON 决策树引擎 + HealthCheckSession + SOAP 报告 + 急诊中断（EmergencyTrigger）
 * 无后端数据库：会话仅存内存，便于后续替换为 HealthCheckSession API。
 */
(function (global) {
  function deepMerge(a, b) {
    if (!b || typeof b !== "object") return a;
    const out = a && typeof a === "object" ? a : {};
    Object.keys(b).forEach((k) => {
      const v = b[k];
      if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && out[k] !== null) {
        out[k] = deepMerge(out[k], v);
      } else {
        out[k] = v;
      }
    });
    return out;
  }

  /**
   * @param {string} species "cat"|"dog"
   * @param {object} tree health-decision-tree.json
   * @param {object} profile 来自引导问卷的 chatProfile
   */
  function createSession(species, tree, profile) {
    const entry =
      (tree.entryBySpecies && tree.entryBySpecies[species]) || tree.entry || null;
    const session = {
      species,
      tree,
      currentId: entry,
      path: [],
      tags: {
        base: {},
        chief: {},
        accompanying: {},
        temporal: {},
      },
      closedReason: null,
    };

    if (profile && typeof profile === "object") {
      if (profile.species) session.tags.base.species = profile.species;
      if (profile.gender) session.tags.base.gender = profile.gender;
      if (profile.neuter) session.tags.base.neuter = profile.neuter;
      if (profile.ageBand) session.tags.base.ageBand = profile.ageBand;
    }

    return session;
  }

  function getCurrentNode(session) {
    if (!session || !session.currentId || !session.tree || !session.tree.nodes) return null;
    return session.tree.nodes[session.currentId] || null;
  }

  function mergeOptionTags(session, tags) {
    if (!tags || typeof tags !== "object") return;
    ["base", "chief", "accompanying", "temporal"].forEach((dim) => {
      if (tags[dim]) session.tags[dim] = deepMerge(session.tags[dim] || {}, tags[dim]);
    });
  }

  /**
   * @returns {{ kind: "continue"|"emergency"|"done", node?: object, message?: string, closingNote?: string }}
   */
  function applyOption(session, option) {
    if (!session || !option) return { kind: "done" };

    const fromId = session.currentId;
    session.path.push({
      fromId,
      value: option.value,
      label: option.label,
    });

    mergeOptionTags(session, option.tags);

    if (option.emergencyTrigger) {
      session.currentId = null;
      session.closedReason = "emergency";
      return {
        kind: "emergency",
        message: option.emergencyMessage || "请尽快联系或前往动物医院。",
      };
    }

    const next = option.next;
    if (!next || next === "END") {
      session.currentId = null;
      session.closedReason = "complete";
      return { kind: "done" };
    }

    session.currentId = next;
    const node = getCurrentNode(session);
    if (!node) {
      session.closedReason = "complete";
      return { kind: "done" };
    }
    if (node.terminal) {
      session.currentId = null;
      session.closedReason = "complete";
      return { kind: "done", closingNote: node.prompt };
    }
    return { kind: "continue", node };
  }

  function petName(species) {
    return species === "dog" ? "狗狗" : "猫猫";
  }

  /** 基于标签生成兽医友好的 SOAP（非诊断） */
  function generateSOAP(session, chatProfile, extraSubjectiveLines) {
    const p = chatProfile || {};
    const t = (session && session.tags) || {};
    const base = t.base || {};
    const chief = t.chief || {};
    const acc = t.accompanying || {};
    const tmp = t.temporal || {};

    const spLab = petName(session.species);
    const lines = [];
    lines.push("【SOAP 简报】（供执业兽医沟通参考，非诊断、不开药）");
    lines.push("");
    lines.push("S（主观 Subjective）");
    lines.push(
      "- 家长主诉与观察：" +
        (chief.sign || chief.system
          ? [chief.system, chief.sign].filter(Boolean).join(" · ")
          : "（见决策路径与对话）")
    );
    if (acc.appetite_spirit) lines.push("- 食欲/精神：" + acc.appetite_spirit);
    if (acc.elimination) lines.push("- 排泄/呕吐概况：" + acc.elimination);
    if (acc.blood_stool) lines.push("- 出血/便色线索：" + acc.blood_stool + "（结膜充血、便血等需当面鉴别）");
    if (extraSubjectiveLines && extraSubjectiveLines.length) {
      extraSubjectiveLines.forEach((x) => lines.push("- " + x));
    }
    lines.push("");
    lines.push("O（客观 Objective）");
    lines.push(`- 物种：${spLab}（${base.species || session.species || "—"}）`);
    if (base.gender) lines.push("- 性别/去势：" + mapProfileValue("gender", base.gender) + " / " + mapProfileValue("neuter", base.neuter || p.neuter));
    if (base.ageBand) lines.push("- 年龄段：" + mapProfileValue("ageBand", base.ageBand));
    if (tmp.onset) lines.push("- 时效：" + tmp.onset);
    if (tmp.skin_course) lines.push("- 皮肤问题病程：" + tmp.skin_course);
    lines.push("- 决策路径节点数：" + (session.path ? session.path.length : 0));
    lines.push("");
    lines.push("A（评估 Assessment）");
    lines.push("- 机器人基于知识图谱与决策树的**风险分层提示**（非诊断）：");
    if (session.closedReason === "emergency") {
      lines.push("  · 曾触发急诊红线分支，建议按急诊或尽快门诊处理。");
    } else if (chief.system) {
      lines.push("  · 主诉方向：" + chief.system + " — 需结合体检与化验影像。");
    } else {
      lines.push("  · 信息仍不完整，需兽医当面检查。");
    }
    lines.push("");
    lines.push("P（计划 Plan）");
    lines.push("- 建议携带：既往疫苗/驱虫记录、近期饮食变化、用药史。");
    lines.push("- 根据症状：可能需血常规、生化、影像、尿液检查等（以兽医判断为准）。");
    lines.push("- 居家：勿自行使用人用止痛药；呕吐/腹泻可先记录频次再就诊。");
    lines.push("");
    lines.push("—— 由 CuraBot 决策树会话生成 ——");
    return lines.join("\n");
  }

  function mapProfileValue(key, v) {
    const maps = {
      gender: { male: "男生", female: "女生" },
      neuter: { yes: "已绝育", no: "未绝育", unknown: "不清楚" },
      ageBand: {
        young: "幼年",
        adult: "成年",
        senior: "老年",
      },
    };
    const m = maps[key];
    return (m && m[v]) || v || "—";
  }

  /** 用户口语 → 报告括号内医学提示（示例） */
  function glossForOwnerPhrase(text) {
    const t = String(text || "");
    const pairs = [
      [/眼睛红|眼红|眼白发红/, "结膜充血可能"],
      [/吐|呕吐/, "呕吐（需鉴别胃炎、异物、代谢等）"],
      [/拉稀|腹泻|软便/, "腹泻（需鉴别感染、寄生虫、饮食等）"],
      [/尿血|血尿/, "血尿（需尿检与影像鉴别）"],
    ];
    const notes = [];
    pairs.forEach(([re, note]) => {
      if (re.test(t)) notes.push(note);
    });
    return notes.length ? notes.join("；") : "";
  }

  global.CuraHealthDecisionEngine = {
    createSession,
    getCurrentNode,
    applyOption,
    generateSOAP,
    glossForOwnerPhrase,
    petName,
  };
})(typeof window !== "undefined" ? window : globalThis);
