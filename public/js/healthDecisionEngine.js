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
      const closingNote = typeof option.closingNote === "string" && option.closingNote.trim() ? option.closingNote.trim() : undefined;
      return closingNote ? { kind: "done", closingNote } : { kind: "done" };
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
    lines.push("【给兽医看的就诊简报】（把情况说清楚，非诊断、不开药）");
    lines.push("");
    lines.push("一、家长主观描述（相当于 S）");
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
    lines.push("二、客观信息（相当于 O）");
    lines.push(`- 物种：${spLab}（${base.species || session.species || "—"}）`);
    if (base.gender) lines.push("- 性别/去势：" + mapProfileValue("gender", base.gender) + " / " + mapProfileValue("neuter", base.neuter || p.neuter));
    if (base.ageBand) lines.push("- 年龄段：" + mapProfileValue("ageBand", base.ageBand));
    if (tmp.onset) lines.push("- 时效：" + tmp.onset);
    if (tmp.skin_course) lines.push("- 皮肤问题病程：" + tmp.skin_course);
    lines.push("- 决策路径节点数：" + (session.path ? session.path.length : 0));
    lines.push("");
    lines.push("三、风险与关注（相当于 A，非诊断结论）");
    lines.push("- 机器人基于知识图谱与决策树的**风险分层提示**（非诊断）：");
    if (session.closedReason === "emergency") {
      lines.push("  · 曾触发急诊红线分支，建议按急诊或尽快门诊处理。");
    } else if (chief.system) {
      lines.push("  · 主诉方向：" + chief.system + " — 需结合体检与化验影像。");
    } else {
      lines.push("  · 信息仍不完整，需兽医当面检查。");
    }
    lines.push("");
    lines.push("四、就诊时可沟通的准备（相当于 P）");
    lines.push("- 建议携带：既往疫苗/驱虫记录、近期饮食变化、用药史。");
    lines.push("- 根据症状：可能需血常规、生化、影像、尿液检查等（以兽医判断为准）。");
    lines.push("- 居家：勿自行使用人用止痛药；呕吐/腹泻可先记录频次再就诊。");
    lines.push("");
    lines.push("—— 由 CuraBot 筛查会话整理 ——");
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

  /**
   * 决策树结束后根据标签与知识库拼一段结构化建议（科普，非诊断）。
   * @param {object|null} session HealthCheckSession
   * @param {object} knowledge knowledge.json 对象
   */
  function buildAdvicePlan(session, knowledge) {
    const k = knowledge || {};
    const redLines = k.emergencyRedLines || [];
    const species = (session && session.species) || "cat";
    const lines = [];
    lines.push("**根据筛查与知识库的参考建议（科普，不能代替兽医诊断）**");
    lines.push("");

    let levelText = "信息有限：请结合症状变化决定是否需要面诊；若加重或出现红旗信号，请优先联系医院。";
    let vetLine =
      "若出现精神差、拒食、持续呕吐/腹泻、便血或黑便、呕血、少尿无尿、呼吸困难、抽搐或明显疼痛，请尽快前往动物医院或急诊。";
    let homeLine = "可先记录症状出现时间、频次与饮食变化；避免自行使用人用止痛药、退烧药。";

    if (session && session.closedReason === "emergency") {
      levelText = "**高风险（急诊红线）**：请尽快就医或按急诊处理，勿自行用药掩盖症状。";
      vetLine = "请立即前往具备急诊能力的动物医院；途中可电话说明情况，疑似中毒请携带包装/照片。";
      homeLine = "转运前保持安静、减少应激；除非兽医电话指导，勿随意催吐、勿大量喂水喂食拖延出发。";
    } else if (session) {
      const t = session.tags || {};
      const chief = t.chief || {};
      const acc = t.accompanying || {};
      const accStr = JSON.stringify(acc);
      const chiefStr = [chief.system, chief.sign].filter(Boolean).join(" ");

      for (let i = 0; i < redLines.length; i++) {
        const rl = redLines[i];
        if (rl.species && rl.species.indexOf(species) === -1) continue;
        const title = rl.title || "";
        const signs = rl.signs || [];
        let hit = chiefStr && title && chiefStr.indexOf(title.slice(0, Math.min(4, title.length))) !== -1;
        if (!hit && signs.length) {
          hit = signs.some(function (s) {
            const needle = s.slice(0, Math.min(6, s.length));
            return needle && chiefStr.indexOf(needle) !== -1;
          });
        }
        if (hit && rl.action) {
          vetLine = rl.action;
          break;
        }
      }

      if (/血|呕血|吐血|便血|黑便|休克|抽|喘|尿不出|闭尿|胀得很快|意识/.test(accStr + chiefStr)) {
        levelText = "**中高风险**：建议尽快安排门诊；若症状加重或出现新红旗，请走急诊。";
      } else if (chief.system) {
        levelText = "**需关注**：主诉集中在「" + chief.system + "」相关，建议兽医面诊与必要检查。";
      }
    }

    lines.push("**1. 紧急程度**：" + levelText);
    lines.push("");
    lines.push("**2. 就医与何时去急诊**");
    lines.push("- " + vetLine);
    lines.push("- 就诊时建议携带：疫苗/驱虫记录、近期饮食与用药清单、呕吐/排便/排尿次数与时间记录。");
    lines.push("");
    lines.push("**3. 在家可做的准备（不替代就医）**");
    lines.push("- " + homeLine);
    lines.push("- 若已启用上传功能，可拍便便、呕吐物、皮肤、眼睛等辅助说明（仍以面诊为准）。");
    lines.push("");
    lines.push("**4. 可能与兽医沟通的检查方向（由兽医决定）**");
    const checks = [];
    const sys = session && session.tags && session.tags.chief ? String(session.tags.chief.system || "") : "";
    if (sys.indexOf("消化") !== -1) {
      checks.push("消化相关：血常规、生化、腹部影像、粪便检查等。");
    }
    if (sys.indexOf("皮肤") !== -1) {
      checks.push("皮肤相关：皮肤刮片、细胞学、寄生虫与过敏排查等。");
    }
    if (sys.indexOf("泌尿") !== -1) {
      checks.push("泌尿相关：尿液检查、影像、梗阻相关评估等。");
    }
    if (sys.indexOf("呼吸") !== -1) {
      checks.push("呼吸相关：听诊、影像、必要时氧疗与化验等。");
    }
    if (!checks.length) checks.push("以面诊体检与兽医判断的检查/化验方案为准。");
    checks.forEach(function (c) {
      lines.push("- " + c);
    });

    return lines.join("\n");
  }

  /** 用于助手气泡分层：与决策树标签一致，避免「紧急」后又出现「正常」。 */
  function deriveSeverityFromSession(session) {
    if (!session) return "normal";
    if (session.closedReason === "emergency") return "emergency";
    const t = session.tags || {};
    const chief = t.chief || {};
    const acc = t.accompanying || {};
    const tmp = t.temporal || {};
    const sigParts = [
      chief.sign,
      acc.appetite_spirit,
      acc.elimination,
      acc.blood_stool,
      tmp.onset,
      tmp.skin_course,
    ]
      .filter(Boolean)
      .join(" ");
    const blob = sigParts + JSON.stringify(acc);
    if (
      /血|呕血|吐血|便血|黑便|休克|抽搐|喘|呼吸困难|呼吸窘迫|呼吸很|尿不出|闭尿|胀得|扭转|意识不清|瘫|抽个不停/.test(
        blob
      )
    ) {
      return "emergency";
    }
    if (acc.appetite_spirit === "差" || /萎靡|不吃|精神很差|越来越差/.test(blob)) {
      return "moderate";
    }
    if (chief.system && /消化|泌尿|神经|呼吸|胸|腹/.test(String(chief.system))) {
      return "moderate";
    }
    if (tmp.onset === "急性" || /急性|突然|很快/.test(blob)) {
      return "moderate";
    }
    return "normal";
  }

  global.CuraHealthDecisionEngine = {
    createSession,
    getCurrentNode,
    applyOption,
    generateSOAP,
    buildAdvicePlan,
    deriveSeverityFromSession,
    glossForOwnerPhrase,
    petName,
  };
})(typeof window !== "undefined" ? window : globalThis);
