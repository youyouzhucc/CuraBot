/**
 * CuraBot：分诊流程解释器（支持单选 / 多选合并严重程度）
 */
(function (global) {
  const LEVEL_ORDER = { routine: 0, monitor: 1, urgent: 2, emergency: 3 };

  const LEVEL_META = {
    emergency: {
      title: "需要尽快去医院（急诊）",
      body:
        "这些情况在兽医临床上往往很“赶时间”。请现在就联系能看急诊的医院，路上保持安静、通风，别捂得太热；不要自己给宠物吃人用止痛药或随意催吐（除非兽医在电话里明确让你这么做）。",
      vetNeed: "建议：尽快前往具备急诊能力的动物医院。",
    },
    urgent: {
      title: "建议尽快预约看医生",
      body:
        "不算最急那一档，但最好在几小时到一天内让兽医当面检查，必要时做化验。期间可以先把症状发生时间、次数、饮食排便情况记下来或录一小段视频，方便医生判断。",
      vetNeed: "建议：尽快（今天或明天）安排门诊。",
    },
    monitor: {
      title: "可以先在家密切观察",
      body:
        "目前更像是可以先观察的情况，但请继续留意有没有变严重。可以把吃喝、大小便、精神状态记下来；一旦出现喘不上气、尿不出来、一直吐、精神很差等情况，请重新用「急事先筛」或直接去急诊。",
      vetNeed: "建议：先观察；若变差或心里不踏实，就预约门诊。",
    },
    routine: {
      title: "更适合慢慢约门诊或做行为调整",
      body:
        "整体更像日常门诊或行为咨询能处理的问题。若同时有不吃、不尿、明显疼痛等身体信号，仍建议先让兽医排除身体疾病，再谈训练和行为。",
      vetNeed: "建议：预约门诊或行为咨询；有身体异常时优先看兽医。",
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
