/**
 * CuraBot：分诊流程解释器（支持单选 / 多选合并严重程度）
 * 结论结构：紧急程度(level) + 一句话建议 + 详细说明 + 在家措施；表述对齐公开兽医共识（如 Merck Veterinary Manual、AAHA/AAFP 指南思路），非转载教科书全文。
 */
(function (global) {
  const LEVEL_ORDER = { routine: 0, monitor: 1, urgent: 2, emergency: 3 };

  /** detailExplain：症状与分诊逻辑；homeCare：可执行的家庭措施；oneLiner：就医优先级摘要 */
  const LEVEL_META = {
    emergency: {
      title: "【分诊】更像需要尽快去医院（急诊）的情况",
      oneLiner: "别耽搁，尽快去能看**急诊**的动物医院；路远或半夜可以先打电话，说清楚是啥动物、多重、哪里最不对劲。",
      detailExplain:
        "你勾的这些，听起来更像**不能在家干等**的那一类：比如喘得厉害、尿不出来、抽个不停、大出血或怀疑中毒等等——具体是啥病，要医生当面看、有的还要抽血拍片，**这里不能替你下诊断**。\n\n" +
        "路上可以记住三件事：**透气别捂太紧**；**别自己喂人吃的止痛药**；要不要催吐、怎么搬动，**听兽医电话或到现场再说**。\n\n" +
        "见医生时尽量说清楚：**啥时候开始的**、有没有越来越重、吐/拉/尿了几次、最后一顿吃喝啥时候、有没有乱吃东西或受伤；有照片视频更好。",
      homeCare:
        "• 路上开窗透气，别闷在又热又挤的地方。\n• 用手机记一下：几点开始不对劲、中间有没有好过。\n• 人用药、乱催吐、硬灌水都先别自己上，等兽医安排。",
      vetNeed:
        "**建议**：尽快前往具备急诊与重症监护能力的动物医院；路途较远或夜间可先致电医院，说明物种、体重与主要症状，便于院内准备。",
      body: "",
    },
    urgent: {
      title: "【分诊】建议一两天内约个门诊，别拖太久",
      oneLiner: "最好**今天到明天**能约上兽医门诊，让医生摸一摸、问清楚；小猫老狗或有慢性病的，心里不踏实就再早一点。",
      detailExplain:
        "从你勾的情况看，**不像「马上得冲急诊」那种，但也不适合一直拖着不看**。很多肠胃、泌尿、皮肤、疼啊蔫啊的问题，早去早安心，有的要验血验尿或拍个片才说得清，**这里同样不能代替医生诊断**。\n\n" +
        "去之前你可以随手记：**吃多少喝多少、吐/拉几次、尿尿费不费劲、精神咋样**；能拍个小视频更好。要是中间出现**喘不上气、肚子胀得发硬、完全尿不出、抽起来、牙龈白得吓人或发紫**，就改走急诊那条线。",
      homeCare:
        "• 继续盯紧吃喝拉撒，记个大概时间。\n• 吐的、拉的、尿团，可以拍照留着给医生看。\n• 人吃的感冒药、止痛药、抗生素**先别自己喂**。",
      vetNeed:
        "**建议**：优先预约全科或专科门诊；幼龄、老年或合并慢性病者宜适当提前。",
      body: "",
    },
    monitor: {
      title: "【分诊】先在家多盯几天，但别掉以轻心",
      oneLiner: "先**在家观察、记一记**；要是越来越糟、或者你心里一直不踏实，就**早点约门诊**——小猫老狗宁可多看一眼。",
      detailExplain:
        "按你这次勾的，**没踩中我们设的「必须马上急诊」那几条**，所以系统先归在「**在家多留意，有空让兽医瞧一眼**」这一类。\n\n" +
        "但这**不等于**一定没事——有些毛病要当面检查才看得出来。小猫、老猫老狗，或者本来就有慢性病的，很多医生也会建议**定期复查**。\n\n" +
        "出现下面任何一种都别拖：**完全尿不出**；安静待着也**像狗一样张嘴喘**；**牙龈发紫或发白**；一直吐不停；**肚子又胀又疼**——请重新用急先筛或直接去医院。",
      homeCare:
        "• 随便用本子或手机记：吃多少、喝多少、尿团/大便咋样、吐没吐、精神好不好。\n• 环境别太折腾，换粮也别太猛。\n• 一旦又像急症那条线了，点回「急先筛」或直接去急诊。",
      vetNeed:
        "**建议**：以观察为主；一旦出现急症表现或症状升级，请重新使用急先筛或直接前往急诊。",
      body: "",
    },
    routine: {
      title: "【分诊】更像日常/行为上的事，但仍建议让兽医把把关",
      oneLiner: "可以**预约普通门诊或行为咨询**；要是突然吃不下、乱尿、消瘦、瘸了之类，**先排除身体有没有病**再谈训练。",
      detailExplain:
        "整体听起来更像**可以一步步来**：换环境、减压力、做训练这类。但猫狗**乱发脾气、躲着不见人**，有时其实是**疼、激素、泌尿**身体问题装的，所以**第一次最好也让兽医简单体检一下**。\n\n" +
        "如果同时有**躲藏、咬人变凶、尿尿不对、体重掉得快**，别只当脾气问题。吃多少、胖瘦怎么管，跟兽医一起定比网上抄食谱靠谱。",
      homeCare:
        "• 想想最近有没有搬家、新宠物、换粮之类**诱因**，记给医生听。\n• 没查清有没有疼或生病前，别靠打骂硬压。\n• 体重、食量可以定期记一下，体检用得上。",
      vetNeed:
        "**建议**：预约常规门诊或行为咨询；任何新发躯体症状优先兽医评估。",
      body: "",
    },
  };

  function buildBodyFromParts(detailExplain, homeCare) {
    const parts = [detailExplain].filter(Boolean);
    if (homeCare && String(homeCare).trim()) {
      parts.push("【在家可以这样做】\n" + homeCare);
    }
    return parts.join("\n\n");
  }

  function oneLinerFromVetNeed(vetNeed) {
    if (!vetNeed) return "";
    return String(vetNeed)
      .replace(/^\*\*建议\*\*[：:\s]*/i, "")
      .replace(/\*\*/g, "")
      .trim();
  }

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

    let detailExplain = option.detailExplain != null ? option.detailExplain : meta.detailExplain || meta.body || "";
    if (option.body && option.detailExplain == null) {
      detailExplain = option.body;
    }

    let homeCare = meta.homeCare || "";
    if (option.homeCare) {
      homeCare = homeCare ? `${homeCare}\n${option.homeCare}` : option.homeCare;
    }

    const vetNeed = option.vetNeed || meta.vetNeed;
    let oneLiner = option.oneLiner || meta.oneLiner;
    if (!oneLiner) oneLiner = oneLinerFromVetNeed(vetNeed);

    const body = buildBodyFromParts(detailExplain, homeCare);

    return {
      level,
      title,
      oneLiner,
      detailExplain,
      homeCare,
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
      let detailExplain = o.detailExplain != null ? o.detailExplain : o.body || meta.detailExplain || meta.body || "";
      let homeCare = o.homeCare != null ? o.homeCare : meta.homeCare || "";
      if (o.homeCare && meta.homeCare) homeCare = `${meta.homeCare}\n${o.homeCare}`;
      else if (o.homeCare) homeCare = o.homeCare;
      const vetNeed = o.vetNeed || meta.vetNeed;
      let oneLiner = o.oneLiner || meta.oneLiner || oneLinerFromVetNeed(vetNeed);
      const body = buildBodyFromParts(detailExplain, homeCare);
      return {
        kind: "outcome",
        outcome: {
          level: o.level,
          title: o.title || meta.title,
          oneLiner,
          detailExplain,
          homeCare,
          body,
          vetNeed,
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
    let detailExplain = meta.detailExplain || meta.body || "";
    let homeCare = meta.homeCare || "";

    if (homeParts.length) {
      homeCare = homeCare
        ? `${homeCare}\n• ${homeParts.join("\n• ")}`
        : `• ${homeParts.join("\n• ")}`;
    }
    if (labels.length) {
      detailExplain = `你提到的情况包括：${labels.join("；")}。\n\n` + detailExplain;
    }

    const vetNeed = vetParts.length
      ? vetParts.filter((v, i, a) => a.indexOf(v) === i).join("\n")
      : meta.vetNeed;

    const oneLiner = vetParts.length ? oneLinerFromVetNeed(vetParts[0]) : meta.oneLiner || oneLinerFromVetNeed(meta.vetNeed);

    const body = buildBodyFromParts(detailExplain, homeCare);

    return {
      level: maxLevel,
      title: meta.title,
      oneLiner,
      detailExplain,
      homeCare,
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
