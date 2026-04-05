/**
 * 标准化健康采集：根据累积 flags 判定紧急程度，并生成结构化摘要。
 * 表述对齐公开兽医共识（Merck Veterinary Manual、AAHA/AAFP 指南、小动物内科/急诊/营养学教材体系），非转载受版权保护的全文。
 */
(function (global) {
  const REF = {
    er: ["silverstein-ecc", "bsava-ecc", "ecc-pocket", "feline-patient", "isfm"],
    ur: ["ettinger", "mvm", "feline-patient", "isfm"],
    gi: ["ettinger", "nelson", "mvm"],
    beh: ["overall-behavior", "isfm", "low-stress"],
    dogEr: ["fossum", "silverstein-ecc", "toxicology"],
  };

  const CAT_FLAG_LABELS = {
    age_kitten: "年龄：幼猫(<12月龄)",
    age_adult: "年龄：成年",
    age_senior: "年龄：老年(≥11岁)",
    sex_m_neutered: "性别：公，已绝育",
    sex_m_intact: "性别：公，未绝育",
    sex_f_neutered: "性别：母，已绝育",
    sex_f_intact: "性别：母，未绝育",
    breed_dsh: "品种：混血/家猫",
    breed_risk: "品种：布偶/英短等需关注遗传/心脏问题品种",
    breed_fold: "品种：折耳（骨骼相关风险）",
    breed_other: "品种：其他登记品种",
    wt_stable: "体重：近期稳定",
    wt_loss: "体重：近期下降",
    wt_gain: "体重：近期发胖",
    bar_a: "精神：BAR 活泼敏锐",
    bar_b: "精神：沉郁/躲藏",
    bar_c: "精神：嗜睡/反应差",
    appetite_ok: "食欲：正常",
    appetite_up: "食欲：亢进",
    appetite_down: "食欲：减退",
    appetite_absent: "食欲：废绝",
    water_ok: "饮水：正常",
    water_poly: "饮水：明显增多(多饮)",
    water_low: "饮水：明显减少",
    temp_hot: "体温估计：耳朵/肉垫发烫",
    temp_ok: "体温估计：接近平时",
    temp_cold: "体温估计：发凉",
    vomit_none: "呕吐：无",
    vomit_occ: "呕吐：偶尔",
    vomit_freq: "呕吐：频繁(>3次/日)",
    vomit_bile: "呕吐物：黄绿色/胆汁样",
    vomit_blood: "呕吐物：带血或咖啡渣样",
    vomit_hair: "呕吐物：毛球或未消化食物为主",
    stool_ok: "排便：成形正常",
    stool_soft: "排便：软便",
    stool_watery: "排便：稀/水样",
    stool_constipated: "排便：便秘/羊粪球",
    stool_melena: "排便：黑便柏油样(上消化出血可能)",
    stool_hematochezia: "排便：鲜血便",
    abd_soft: "腹部：柔软无抵抗",
    abd_tight: "腹部：紧绷/压痛",
    abd_distended: "腹部：胀大",
    uri_ok: "泌尿：排尿顺畅、尿量观感正常",
    uri_pollakiuria: "泌尿：尿频/尿少/滴尿",
    uri_obstruction: "泌尿：无尿或几乎尿不出(梗阻风险)",
    uri_strain: "泌尿：排尿嚎叫/痛尿",
    uri_house: "泌尿：盆外乱尿",
    urine_clear: "尿色：淡黄清亮",
    urine_dark: "尿色：深茶色",
    urine_blood: "尿色：洗肉水样/血尿",
    resp_ok: "呼吸：静息时呼吸次数观感正常",
    resp_fast: "呼吸：静息时明显偏快或费力",
    resp_open_mouth: "呼吸：张口呼吸(猫安静时异常)",
    resp_abdominal: "呼吸：明显腹式呼吸",
    mm_pink: "粘膜：粉红",
    mm_pale: "粘膜：苍白",
    mm_cyanotic: "粘膜：发绀(紫)",
    mm_icteric: "粘膜：黄染",
    hide_no: "行为：未见明显躲藏",
    hide_yes: "行为：躲床底/柜内等阴暗处",
    gait_ok: "步态：正常",
    gait_lame: "步态：跛行",
    gait_paresis: "步态：后肢无力或拖行(血栓等风险线索)",
    groom_ok: "理毛：正常",
    groom_excess: "理毛：过度舔舐局部",
    groom_unkempt: "理毛：毛发凌乱不理毛",
    env_change: "环境：近期搬家/新宠物/换粮等变化",
    env_stable: "环境：近期无上述大变化",
  };

  const DOG_FLAG_LABELS = {
    d_age_pup: "年龄：幼年",
    d_age_adult: "年龄：成年",
    d_age_senior: "年龄：老年",
    d_sex_m_n: "性别：公，已绝育",
    d_sex_m_i: "性别：公，未绝育",
    d_sex_f_n: "性别：母，已绝育",
    d_sex_f_i: "性别：母，未绝育",
    d_size_s: "体型：小型犬",
    d_size_m: "体型：中型犬",
    d_size_l: "体型：大型/深胸犬(胃扩张-扭转风险相对较高)",
    d_bar_a: "精神：反应好",
    d_bar_b: "精神：蔫/躲藏",
    d_bar_c: "精神：昏睡/几乎无反应",
    d_app_ok: "食欲：正常",
    d_app_down: "食欲：减退",
    d_app_absent: "食欲：废绝",
    d_water_ok: "饮水：正常",
    d_water_poly: "饮水：增多",
    d_gdv_no: "腹胀/干呕：无此组表现",
    d_gdv_yes: "腹胀/干呕：肚子胀+干呕或呕不出(急诊线索)",
    d_vomit_none: "呕吐：无",
    d_vomit_some: "呕吐：有",
    d_diarrhea_none: "腹泻：无",
    d_diarrhea_yes: "腹泻：有",
    d_stool_blood: "粪便：带血或黑便",
    d_neuro_ok: "神经：无抽搐/瘫痪",
    d_neuro_bad: "神经：抽搐或突发瘫痪",
    d_resp_ok: "呼吸：大致正常",
    d_resp_bad: "呼吸：费力/张口喘/紫绀",
    d_lame_no: "跛行：无",
    d_lame_yes: "跛行：有",
    d_toxin_no: "毒物：无明确误食",
    d_toxin_yes: "毒物：可疑误食毒物/巧克力/葡萄/药物等",
    d_heat_no: "中暑：无高温暴晒史",
    d_heat_yes: "中暑：高温环境或运动后 collapse",
  };

  const CRITICAL = {
    cat_uro_er: {
      level: "emergency",
      title: "泌尿急症风险：疑似尿道梗阻（需兽医立即评估）",
      oneLiner: "立即赴急诊；向接诊人员说明最后一次排尿时间、是否呕吐、是否完全无尿。",
      detailExplain:
        "猫下泌尿道疾病（FLUTD）中，**少尿/无尿**合并痛性排尿、腹部不适或呕吐时，需**优先排除尿道梗阻**。梗阻可迅速导致高钾血症、急性肾损伤与全身恶化，属于**时间敏感急症**；未绝育公猫风险更高，但任何性别均不能完全排除。\n\n" +
        "**非诊断声明**：本结论仅为分诊线索。确诊依赖兽医触诊膀胱、影像与实验室检查。病理与处置思路可参考 Merck Veterinary Manual 等公开资料中猫下泌尿道疾病章节。",
      homeCare:
        "• 勿强行灌水、随意使用利尿药或自行导尿。\n• 转运中减少应激，尽快抵达具备猫科急诊能力的医院。\n• 记录末次排尿时间、尿量观感与呕吐次数，就诊时口述。",
      vetNeed:
        "**建议**：立即赴急诊；向接诊人员说明「最后一次排尿时间、是否呕吐、是否完全无尿」。",
      refIds: ["feline-patient", "isfm", "silverstein-ecc", "mvm"],
    },
    dog_gdv_er: {
      level: "emergency",
      title: "疑似急腹症：胃扩张-扭转（GDV）高危线索",
      oneLiner: "立即联系具备急诊外科能力的医院；途中避免剧烈跑动与翻滚。",
      detailExplain:
        "**胃扩张-扭转（GDV）**多见于深胸大型犬，典型表现包括腹部胀满、干呕或无法呕吐、烦躁不安或虚弱；可迅速进展为休克，属外科急症（参见《犬猫急诊与重症监护》类教材中的急腹症鉴别思路）。\n\n" +
        "亦需与其他急腹症鉴别（异物、扭转等），**必须由兽医影像与体检确认**。",
      homeCare:
        "• 转运前勿大量喂水喂食，以免加重胃扩张与麻醉风险。\n• 途中保持平稳、减少颠簸；记录腹胀开始时间与干呕次数。\n• 到达医院后主动说明品种、体型与症状进展速度。",
      vetNeed: "**建议**：立即联系急诊外科；途中避免剧烈跑动。",
      refIds: ["fossum", "silverstein-ecc", "ecc-pocket", "mvm"],
    },
    dog_neuro_er: {
      level: "emergency",
      title: "急性神经症状：需排除中毒、代谢与脊髓/颅内病变",
      oneLiner: "尽快急诊；必要时转诊影像或神经专科；携带毒物包装（如有）。",
      detailExplain:
        "持续抽搐、急性瘫痪或意识障碍可能涉及**中毒、代谢紊乱、颅内出血、椎间盘突出、感染**等多种病因，部分情况可在数小时内恶化（与《犬猫内科学》中神经急症鉴别思路一致）。",
      homeCare:
        "• 勿向口腔塞物以防咬伤；记录发作起止时间、频率与持续时间。\n• 疑似毒物请携带包装、照片或残留物。\n• 转运时保持安静、避免过度摇晃。",
      vetNeed: "**建议**：尽快急诊神经/急诊全科评估；必要时转诊影像或神经专科。",
      refIds: ["silverstein-ecc", "ettinger", "mvm"],
    },
    dog_resp_er: {
      level: "emergency",
      title: "呼吸窘迫：需紧急氧疗与病因鉴别",
      oneLiner: "尽快急诊；说明起病缓急、品种与既往心肺病史。",
      detailExplain:
        "明显呼吸用力、张口呼吸（需结合品种与情境）、粘膜发绀或苍白，提示**氧合不足或严重心肺/全身性疾病**，常需吸氧、影像与实验室检查。\n\n" +
        "短头品种犬与某些心脏病患犬更易出现急性失代偿，**不宜长时间运输延误**（与急诊重症公开论述一致）。",
      homeCare:
        "• 途中避免高温、密闭车厢与过度应激。\n• 不要强行抱紧胸部，保持气道通畅与通风。\n• 记录静息呼吸频率与是否腹式呼吸，便于兽医分诊。",
      vetNeed: "**建议**：尽快急诊；说明起病缓急与既往心肺病史。",
      refIds: ["silverstein-ecc", "ettinger", "mvm"],
    },
  };

  function labelFor(flag, species) {
    if (species === "dog") return DOG_FLAG_LABELS[flag] || flag;
    return CAT_FLAG_LABELS[flag] || flag;
  }

  function buildSummaryLines(flags, species) {
    const lines = [...flags].map((f) => "· " + labelFor(f, species));
    return lines.join("\n");
  }

  function levelLabelForCopy(level) {
    const m = {
      emergency: "紧急 — 需尽快急诊评估",
      urgent: "中等 — 建议尽快门诊（24–48 小时内优先）",
      monitor: "低等 — 以观察与记录为主（出现红旗症状须复查）",
      routine: "不明确/择期 — 仍建议兽医复核排除躯体病",
    };
    return m[level] || level;
  }

  function buildFullCopyTemplate(level, species, flags, oneLiner, detailExplain, homeCare) {
    const summary = buildSummaryLines(flags, species);
    const lines = [
      "【可复制 · 咨询/就诊信息模板】",
      "项目名称：CuraBot 标准化采集",
      `【紧急程度】${levelLabelForCopy(level)}`,
      `【一句话建议】${oneLiner}`,
      "",
      "【症状与分诊说明（非诊断）】",
      detailExplain,
      "",
      "【在家可以这样做】",
      homeCare,
      "",
      "【已结构化记录要点】",
      summary,
      "",
      (species === "dog" ? "犬" : "猫") + " · 基本情况（请核对补充）：",
      "",
      summary,
      "",
      "持续时间：____（请手写补充）",
      "用药/保健品：____（请手写补充）",
      "化验单：如有 CBC/生化请一并携带或上传",
      "照片/视频：呼吸姿势、步态、呕吐物/粪便如有请拍摄",
      "",
      "想咨询的问题：________________",
    ];
    return lines.join("\n");
  }

  /** @deprecated 仅兼容；新流程请使用 buildFullCopyTemplate */
  function buildCopyTemplate(species, flags) {
    const summary = buildSummaryLines(flags, species);
    return [
      "【可复制 · 咨询/就诊信息模板】",
      "项目名称：CuraBot 标准化采集",
      (species === "dog" ? "犬" : "猫") + " · 基本情况（系统根据你的选项整理，请核对补充）：",
      "",
      summary,
      "",
      "持续时间：____（请手写补充）",
      "用药/保健品：____（请手写补充）",
      "化验单：如有 CBC/生化请一并携带或上传",
      "照片/视频：呼吸姿势、步态、呕吐物/粪便如有请拍摄",
      "",
      "想咨询的问题：________________",
    ].join("\n");
  }

  function evaluateCat(flags) {
    const f = new Set(flags);
    const refIds = new Set(["feline-patient", "isfm", "mvm", "ettinger", "aaha"]);

    if (
      f.has("uri_obstruction") ||
      f.has("resp_open_mouth") ||
      f.has("mm_cyanotic")
    ) {
      return finalize(
        "emergency",
        "综合线索：符合急诊分诊优先级（非诊断）",
        "你的选项中出现**与猫急诊高度相关**的组合线索：例如**少尿/无尿或排尿极度困难**（需排除尿道梗阻）、**静息张口呼吸**（猫异常）、或**粘膜发绀**（提示氧合严重不足）。上述情况在临床上常需**尽快稳定生命体征并做针对性检查**。\n\n" +
          "本工具**不构成诊断**；处置包括是否吸氧、补液、导尿、镇痛等，均须由兽医根据体检与化验决定。Merck Veterinary Manual 宠物主人版「犬猫急诊」条目对转运与沟通有公开说明，可辅助理解。",
        "• 准备携带：症状时间线、尿团/呼吸短视频、既往病史与用药清单。\n• 转运中保持安静、通风，勿强行保定或捂热。\n• 未经兽医指导勿喂人用止痛药或镇静剂。",
        "尽快前往具备急诊能力的医院；携带下方摘要并说明症状持续时间与加重趋势。",
        refIds,
        f,
        "cat"
      );
    }

    if (
      f.has("abd_distended") &&
      (f.has("vomit_freq") || f.has("bar_c") || f.has("abd_tight"))
    ) {
      ["silverstein-ecc", "ettinger"].forEach((x) => refIds.add(x));
      return finalize(
        "emergency",
        "急腹症线索：腹胀合并呕吐或重度全身症状",
        "猫出现**腹部胀大**并合并**频繁呕吐、腹部压痛或精神极差**时，需优先排除**肠梗阻、积液、子宫蓄脓（未绝育母猫）**等急腹症或全身危重状态；部分病例可在短时间内恶化（与急诊重症教材中的急腹症红旗一致）。\n\n" +
          "请**不要**自行喂止痛药或强行灌食；确诊依赖兽医触诊与影像。",
        "• 记录腹胀出现时间、呕吐次数、最后一次排便/排气时间。\n• 就诊途中避免剧烈晃动；不要热敷或按摩腹部。\n• 携带既往手术史与用药记录（如有）。",
        "尽快急诊；向兽医说明腹胀进展速度、呕吐次数及末次排便情况。",
        refIds,
        f,
        "cat"
      );
    }

    if (f.has("stool_melena") && (f.has("bar_b") || f.has("bar_c"))) {
      return finalize(
        "urgent",
        "上消化道出血线索：黑便（柏油样）合并全身症状",
        "**柏油样黑便**常与上消化道出血相关，合并精神沉郁时需尽快评估失血与凝血风险；鉴别包括胃炎、异物、肝胰疾病、凝血障碍等，依赖化验与影像（参见小动物内科公开章节中的上消化出血鉴别思路）。\n\n" +
          "**勿**使用人用 NSAID；就诊时携带粪便照片。",
        "• 观察牙龈颜色、心率观感与是否持续嗜睡。\n• 暂禁食并避免剧烈运动，直至兽医评估。\n• 记录黑便次数与大致量，供门诊参考。",
        "24 小时内急诊或门诊；若牙龈苍白或虚弱加重，按急诊处理。",
        refIds,
        f,
        "cat"
      );
    }

    if (
      f.has("uri_pollakiuria") ||
      f.has("uri_strain") ||
      f.has("urine_blood") ||
      f.has("appetite_absent") ||
      f.has("vomit_freq") ||
      (f.has("bar_b") && f.has("hide_yes")) ||
      f.has("gait_paresis") ||
      f.has("resp_fast") ||
      f.has("mm_pale") ||
      f.has("mm_icteric")
    ) {
      ["wsava-aafp", "silverstein-ecc"].forEach((x) => refIds.add(x));
      return finalize(
        "urgent",
        "多项阳性线索：建议尽快完整兽医评估",
        "你提供的信息包含**至少一类需要优先排除**的临床线索（如泌尿刺激/感染或梗阻前期表现、明显消化道症状、显著疼痛或活动障碍、黄疸或贫血征象、明显呼吸或循环代偿变化等）。\n\n" +
          "兽医通常会结合体格检查、血常规/生化、尿液检查、影像等逐步缩小鉴别诊断（与《犬猫内科学》中系统评估思路一致）；请携带下方摘要与影像资料。",
        "• 继续记录食欲、饮水、尿团大小与排尿姿势。\n• 避免突然换粮或额外零食干扰判断。\n• 若出现无尿、剧痛或精神极差，立即改按急诊处理。",
        "今日至明日门诊；若任何症状急剧恶化，改走急诊。",
        refIds,
        f,
        "cat"
      );
    }

    return finalize(
      "monitor",
      "可先加强观察并准备就诊资料（仍建议门诊复核）",
      "当前结构化线索**未触发**本工具内置的最高级别急诊规则，但仍可能存在需要体检才能发现的疾病。\n\n" +
        "AAHA/AAFP 类预防医学与猫健康公开指南普遍强调：即使症状轻微，幼龄、老年或慢性病猫也应定期兽医随访。\n\n" +
        "若出现**完全无尿、静息张口呼吸、粘膜发绀或苍白、持续呕吐、腹痛腹胀**等，请立即重新评估。",
      "• 建立简单日志：进食、饮水、尿团、呕吐/腹泻、呼吸与精神。\n• 保持猫砂盆清洁，便于观察尿量变化。\n• 避免自行使用人用药物或非处方「泌尿保健品」替代就诊。",
      "可预约近期门诊做基础体检与尿液检查；幼龄/老年猫或合并慢性病者宜更积极。",
      refIds,
      f,
      "cat"
    );
  }

  function evaluateDog(flags) {
    const f = new Set(flags);
    const refIds = new Set(["mvm", "ettinger", "nelson", "aaha"]);

    if (f.has("d_gdv_yes")) {
      return finalizeCritical("dog_gdv_er", f);
    }
    if (f.has("d_neuro_bad")) {
      return finalizeCritical("dog_neuro_er", f);
    }
    if (f.has("d_resp_bad") || (f.has("d_stool_blood") && f.has("d_bar_c"))) {
      return finalizeCritical("dog_resp_er", f);
    }
    if (f.has("d_toxin_yes")) {
      return finalize(
        "emergency",
        "疑似毒物暴露：需按毒理学原则紧急评估",
        "犬常见高风险摄入包括**巧克力、葡萄/葡萄干、木糖醇、某些人用止痛药/抗抑郁药、杀鼠剂、防冻液**等；临床表现与潜伏期因毒物而异，部分需**在特定时间窗内**处理（毒理学与急诊公开资料均有强调）。\n\n" +
          "**不要**自行催吐，除非兽医根据物种与毒物种类明确指示；保留包装、估算体重与摄入量。Merck Veterinary Manual 中毒条目可辅助理解就诊沟通要点。",
        "• 保留毒物包装、照片或残留物；记录发现时间与大概摄入量。\n• 途中保持安静，观察是否抽搐、流涎或共济失调。\n• 未经兽医确认勿喂牛奶、油类或「家庭偏方」。",
        "立即联系急诊兽医或当地动物毒物咨询渠道；携带毒物包装与照片。",
        new Set(["toxicology", "five-min-toxic", "silverstein-ecc", "mvm"]),
        f,
        "dog"
      );
    }

    if (f.has("d_heat_yes")) {
      return finalize(
        "emergency",
        "热相关急症（中暑/高热）风险",
        "犬中暑可表现为**高热、过度喘鸣、流涎、共济失调、虚脱或意识障碍**；短头品种与肥胖犬更易发生。处理以**逐步降温（避免冰水浸泡）与静脉支持**为主，须兽医监护（与《犬猫急诊与重症监护》公开论述一致）。\n\n" +
          "运输途中保持通风，勿再剧烈运动。",
        "• 用凉水打湿脚垫与腹股沟，避免冰水浸泡全身。\n• 保持气道通畅，勿将犬锁在密闭车厢。\n• 记录暴露时间与活动量，便于兽医分诊。",
        "尽快急诊；说明暴露环境、气温与起病时间。",
        new Set(["silverstein-ecc", "bsava-ecc", "mvm"]),
        f,
        "dog"
      );
    }

    if (
      f.has("d_app_absent") ||
      f.has("d_vomit_some") ||
      f.has("d_diarrhea_yes") ||
      f.has("d_lame_yes") ||
      f.has("d_bar_c")
    ) {
      return finalize(
        "urgent",
        "建议尽快兽医门诊（全身体检 + 基础化验）",
        "线索提示可能存在需鉴别的**消化道、泌尿、肌肉骨骼、疼痛或全身感染/代谢**等问题。幼犬与小型犬在呕吐腹泻时**脱水与低血糖风险更高**；大型犬跛行需排除**骨科、十字韧带与免疫介导性疾病**等（与《犬猫内科学》鉴别思路一致）。\n\n" +
          "兽医可能建议血常规、生化、尿液、粪便、影像等组合检查。",
        "• 少量多次提供饮水（仅在兽医建议前可试；若频繁呕吐则先禁食并尽快就医）。\n• 记录呕吐/腹泻次数、粪便性状与跛行肢别。\n• 避免自行使用人用止泻药或止痛药。",
        "尽快预约门诊；若出现腹胀干呕、便血、抽搐或精神极差，立即急诊。",
        refIds,
        f,
        "dog"
      );
    }

    return finalize(
      "monitor",
      "可先观察并完善记录（深胸犬仍需警惕急腹症）",
      "当前未触发最高级别急诊规则，但**大型深胸犬**仍应对**腹胀+干呕**保持警惕；任何**便血、黑便、抽搐、高热、明显疼痛**应及时就医。\n\n" +
        "营养与体重管理可参考《犬猫营养学》与兽医共同制定饲喂方案的原则；本工具不提供具体配方或剂量。",
      "• 记录饮食种类、食量、排便与活动量。\n• 深胸犬避免餐后大量奔跑；观察腹部是否突然胀大。\n• 预防医学与年度体检有助于早期发现问题（AAHA 预防医学思路）。",
      "常规门诊随访；不适加重立即急诊。",
      refIds,
      f,
      "dog"
    );
  }

  function finalize(level, title, detailExplain, homeCare, oneLiner, refIdsSet, flags, species) {
    const summary = buildSummaryLines(flags, species);
    const vetNeed = `**建议**：${oneLiner}`;
    const body =
      detailExplain +
      "\n\n【在家可以这样做】\n" +
      homeCare +
      "\n\n【已结构化记录要点】\n" +
      summary +
      "\n\n（以上条目由你的选择自动生成，可在就诊时口述或复制下方模板）";
    const copyBlock = buildFullCopyTemplate(level, species, flags, oneLiner, detailExplain, homeCare);
    return {
      level,
      title,
      oneLiner,
      detailExplain,
      homeCare,
      body,
      vetNeed,
      refIds: [...refIdsSet],
      copyBlock,
      intakeSummary: summary,
    };
  }

  function evaluateIntake(species, flags) {
    if (species === "dog") return evaluateDog(flags);
    return evaluateCat(flags);
  }

  function getCritical(key) {
    return CRITICAL[key] || null;
  }

  function finalizeCritical(key, flags) {
    const c = CRITICAL[key];
    if (!c) return null;
    const sp = key.indexOf("dog_") === 0 ? "dog" : "cat";
    const f = flags instanceof Set ? flags : new Set(flags);
    const summary = buildSummaryLines(f, sp);
    const body =
      c.detailExplain +
      "\n\n【在家可以这样做】\n" +
      c.homeCare +
      "\n\n【已结构化记录要点】\n" +
      summary +
      "\n\n（以上条目由你的选择自动生成，可在就诊时口述或复制下方模板）";
    return {
      level: c.level,
      title: c.title,
      oneLiner: c.oneLiner,
      detailExplain: c.detailExplain,
      homeCare: c.homeCare,
      body,
      vetNeed: c.vetNeed,
      refIds: c.refIds,
      copyBlock: buildFullCopyTemplate(c.level, sp, f, c.oneLiner, c.detailExplain, c.homeCare),
      intakeSummary: summary,
    };
  }

  global.CuraIntakeEval = {
    evaluateIntake,
    buildCopyTemplate,
    buildFullCopyTemplate,
    buildSummaryLines,
    getCritical,
    finalizeCritical,
    CAT_FLAG_LABELS,
    DOG_FLAG_LABELS,
  };
})(typeof window !== "undefined" ? window : globalThis);
