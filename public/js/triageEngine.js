/**
 * CuraBot：分诊流程解释器（支持单选 / 多选合并严重程度）
 */
(function (global) {
  const LEVEL_ORDER = { routine: 0, monitor: 1, urgent: 2, emergency: 3 };

  const LEVEL_META = {
    emergency: {
      title: "【分诊】提示需尽快急诊评估（非诊断）",
      body:
        "综合你勾选的症状组合，从**急诊分诊优先级**上看，更接近需要**尽快由执业兽医当面评估**，并可能需要**急诊支持治疗**的一类情况。临床上与此相关的常见方向包括：呼吸道窘迫、疑似泌尿梗阻（尤其公猫）、急性神经症状、难以控制的出血、疑似中毒或休克前状态等——具体病因需体检、化验与影像鉴别，本工具**不下诊断**。\n\n" +
        "**处置原则（与主流小动物急诊教材一致）**：优先确认**气道—呼吸—循环**是否稳定；转运途中保持通风、避免过度包裹导致过热；疼痛与用药须由兽医决定，**勿自行使用人用 NSAID/止痛药**；是否催吐仅能在兽医指导下进行。\n\n" +
        "**就诊沟通要点**：起病时间、是否进行性加重、呕吐/腹泻/排尿次数、最后一次进食饮水、误食史或创伤史；有条件可携带粪便/尿样照片或视频。延伸阅读可参考《默克兽医手册》宠物主人版中「犬猫急诊时该怎么做」等条目。",
      vetNeed:
        "**建议**：尽快前往具备急诊与重症监护能力的动物医院；路途较远或夜间可先致电医院，说明物种、体重与主要症状，便于院内准备。",
    },
    urgent: {
      title: "【分诊】建议尽快门诊（24–48 小时内优先）",
      body:
        "当前线索提示**不宜长期拖延**，建议在**数小时至一两天内**安排兽医门诊，以便完成体格检查，并按需要做血常规、生化、尿液检查、影像等，用于鉴别感染、炎症、疼痛、代谢紊乱、泌尿/消化/皮肤等常见问题。\n\n" +
        "在就诊前可系统记录：**食欲/饮水量、呕吐与排便次数、排尿是否费力、精神状态、跛行与否**，并拍摄短视频，有助于缩小鉴别范围。若期间出现喘憋、腹胀伴干呕、无尿、抽搐或粘膜苍白/发绀等，请改按急诊处理。\n\n" +
        "本结论为**分诊参考**，不能替代兽医诊断。",
      vetNeed:
        "**建议**：优先预约全科或专科门诊；幼龄、老年或合并慢性病者宜适当提前。",
    },
    monitor: {
      title: "【分诊】可先密切观察并完善记录",
      body:
        "就目前信息而言，更接近**可先加强观察、同时准备就诊资料**的情形，但仍需持续关注是否出现**红旗症状**（如进行性嗜睡、拒食拒水、反复呕吐、排尿困难、呼吸频率或用力度明显增加等）。\n\n" +
        "建议建立简单日志：时间轴上的症状、饮食与大小便情况；若症状反复或超过 24–48 小时无改善，仍应预约门诊以排除潜在疾病。\n\n" +
        "若心理不确定或物种为幼龄/老年，**宁可提前门诊**求安心。",
      vetNeed:
        "**建议**：以观察为主；一旦出现急症表现或症状升级，请重新使用急先筛或直接前往急诊。",
    },
    routine: {
      title: "【分诊】倾向门诊/行为管理（仍需排除躯体病）",
      body:
        "线索整体更符合**择期门诊、环境管理或行为干预**可逐步处理的问题；但犬猫的「行为问题」常与疼痛、内分泌、泌尿等疾病重叠，**仍建议首次由兽医做基础体检**，再制定训练或行为方案。\n\n" +
        "若同时存在躲藏、攻击性突然加重、排尿异常或体重变化，请优先排查躯体疾病。",
      vetNeed:
        "**建议**：预约常规门诊或行为咨询；任何新发躯体症状优先兽医评估。",
    },
  };

  function filterOptionBySpecies(option, species) {
    if (!option.species || option.species.length === 0) return true;
    return option.species.indexOf(species) !== -1;
  }

  function getStep(flow, stepId) {
    if (!flow || !flow.steps) return null;
    return flow.steps[stepId] || null;
  }

  function mergeOutcomeFromOption(option) {
    const level = option.level;
    const meta = LEVEL_META[level] || {};
    const title = option.title || meta.title;
    let body = meta.body || "";
    if (option.body) body = option.body;
    if (option.homeCare) {
      body = body ? `${body}\n\n【在家可以这样做】\n${option.homeCare}` : option.homeCare;
    }
    const vetNeed = option.vetNeed || meta.vetNeed;
    return {
      level,
      title,
      body,
      vetNeed,
      refIds: option.refIds || [],
    };
  }

  function resolveOption(option, species) {
    if (!filterOptionBySpecies(option, species)) return { skip: true };
    if (option.outcome && option.next === "OUTCOME") {
      const o = option.outcome;
      const meta = LEVEL_META[o.level] || {};
      let body = o.body || meta.body || "";
      if (o.homeCare) body += (body ? "\n\n" : "") + `【在家可以这样做】\n${o.homeCare}`;
      return {
        kind: "outcome",
        outcome: {
          level: o.level,
          title: o.title || meta.title,
          body,
          vetNeed: o.vetNeed || meta.vetNeed,
          refIds: o.refIds || [],
        },
      };
    }
    if (option.level) {
      const merged = mergeOutcomeFromOption(option);
      return { kind: "outcome", outcome: merged };
    }
    if (option.next) {
      return { kind: "step", stepId: option.next };
    }
    return { kind: "unknown" };
  }

  /** 多选：取最高严重级别，合并在家建议与就医提示 */
  function mergeMultiOptions(selectedOptions, species) {
    const usable = selectedOptions.filter((o) => filterOptionBySpecies(o, species));
    let maxLevel = "routine";
    let maxRank = -1;
    const refSet = new Set();
    const homeParts = [];
    const vetParts = [];
    const labels = [];

    usable.forEach((opt) => {
      if (opt.label) labels.push(opt.label);
      if (opt.level) {
        const r = LEVEL_ORDER[opt.level] ?? 0;
        if (r > maxRank) {
          maxRank = r;
          maxLevel = opt.level;
        }
      }
      if (opt.homeCare) homeParts.push(opt.homeCare);
      if (opt.vetNeed) vetParts.push(opt.vetNeed);
      (opt.refIds || []).forEach((id) => refSet.add(id));
    });

    const meta = LEVEL_META[maxLevel] || LEVEL_META.monitor;
    let body = meta.body;
    if (homeParts.length) {
      body += `\n\n【结合你勾选的情况，在家可以这样做】\n• ${homeParts.join("\n• ")}`;
    }
    if (labels.length) {
      body = `你提到的情况包括：${labels.join("；")}。\n\n` + body;
    }
    const vetNeed = vetParts.length
      ? vetParts.filter((v, i, a) => a.indexOf(v) === i).join("\n")
      : meta.vetNeed;

    return {
      level: maxLevel,
      title: meta.title,
      body,
      vetNeed,
      refIds: Array.from(refSet),
    };
  }

  global.CuraTriageEngine = {
    LEVEL_META,
    LEVEL_ORDER,
    filterOptionBySpecies,
    getStep,
    resolveOption,
    mergeMultiOptions,
    listFlowKeys(knowledge) {
      return Object.keys(knowledge.triageFlows || {});
    },
    getVisibleOptions(step, species) {
      if (!step || !step.options) return [];
      return step.options.filter((o) => filterOptionBySpecies(o, species));
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
