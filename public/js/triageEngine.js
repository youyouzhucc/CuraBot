/**
 * CuraBot 分诊流程解释器：读取 knowledge.json 中的 triageFlows，
 * 按物种过滤选项，将 level / next / OUTCOME 解析为统一 outcome 对象。
 */
(function (global) {
  const LEVEL_META = {
    emergency: {
      title: "急诊：请尽快前往具备急诊能力的动物医院",
      body:
        "上述线索与急诊重症医学中“时间敏感”情况有重叠。请立即联系就近急诊；途中减少应激、保持通风，勿自行使用处方药或盲目催吐（除非兽医明确指示）。",
    },
    urgent: {
      title: "尽快就诊（urgent）",
      body:
        "建议在数小时至 24 小时内安排兽医门诊，完成体格检查与必要化验；若症状加重请重新使用红线筛查。",
    },
    monitor: {
      title: "可先观察并记录",
      body:
        "保持环境安静与充足饮水（除非兽医曾嘱咐限制饮水）；记录症状时间线与视频，若出现红线表现请立即就医。",
    },
    routine: {
      title: "常规门诊 / 行为咨询",
      body:
        "适合预约门诊或行为咨询逐步处理；若合并疼痛或身体异常线索，仍建议兽医排除医学问题后再以行为干预为主。",
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

  function resolveOption(option, species) {
    if (!filterOptionBySpecies(option, species)) return { skip: true };
    if (option.outcome && option.next === "OUTCOME") {
      return {
        kind: "outcome",
        outcome: {
          level: option.outcome.level,
          title: option.outcome.title,
          body: option.outcome.body,
          refIds: option.outcome.refIds || [],
        },
      };
    }
    if (option.level) {
      const meta = LEVEL_META[option.level] || {};
      return {
        kind: "outcome",
        outcome: {
          level: option.level,
          title: meta.title,
          body: meta.body,
          refIds: option.refIds || [],
        },
      };
    }
    if (option.next) {
      return { kind: "step", stepId: option.next };
    }
    return { kind: "unknown" };
  }

  global.CuraTriageEngine = {
    LEVEL_META,
    filterOptionBySpecies,
    getStep,
    resolveOption,
    listFlowKeys(knowledge) {
      return Object.keys(knowledge.triageFlows || {});
    },
    getVisibleOptions(step, species) {
      if (!step || !step.options) return [];
      return step.options.filter((o) => filterOptionBySpecies(o, species));
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
