/**
 * 标准化健康采集：根据累积 flags 判定紧急程度，并生成可复制摘要。
 * 逻辑参考 ISFM、AAHA 急诊思路与猫科临床采集结构（非诊断）。
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
      title: "泌尿：疑似梗阻或尿闭 — 请尽快急诊",
      body:
        "猫咪「几乎无尿/滴尿很少」合并痛尿、精神差等，临床上属于**时间敏感**情况，可能与尿道梗阻相关；未绝育公猫更需警惕。\n\n请立即前往能做急诊的医院，不要强行灌水；是否导尿与治疗须由兽医决定。",
      vetNeed: "建议：尽快前往具备急诊能力的动物医院，并说明「尿少/尿不出已持续多久」。",
      refIds: ["feline-patient", "isfm", "silverstein-ecc"],
    },
    dog_gdv_er: {
      level: "emergency",
      title: "腹胀 + 干呕：请按急诊处理",
      body:
        "深胸犬出现**肚子胀、干呕或呕不出**，需优先排除胃扩张-扭转等急腹症，属于典型「不要在家等」的组合线索。\n\n请尽快前往具备急诊与手术能力的医院。",
      vetNeed: "建议：立即联系急诊外科/急诊中心，途中减少跑动。",
      refIds: ["fossum", "silverstein-ecc", "ecc-pocket"],
    },
    dog_neuro_er: {
      level: "emergency",
      title: "神经症状：请尽快急诊",
      body: "抽搐不止、突发瘫痪或意识明显异常，需尽快由兽医现场评估，排除中毒、代谢、脊柱与颅内等问题。",
      vetNeed: "建议：尽快急诊；记录发作时长与次数，勿往口腔塞物。",
      refIds: ["silverstein-ecc", "ettinger"],
    },
    dog_resp_er: {
      level: "emergency",
      title: "呼吸窘迫：请尽快急诊",
      body: "明显呼吸费力、张口呼吸或粘膜发绀，提示需紧急氧疗与病因排查。",
      vetNeed: "建议：尽快急诊，途中避免捂热与剧烈运动。",
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

  function buildCopyTemplate(species, flags) {
    const lines = [
      "【可复制 · 咨询/就诊信息模板】",
      "项目名称：CuraBot 标准化采集",
      (species === "dog" ? "犬" : "猫") + " · 基本情况（系统根据你的选项整理，请核对补充）：",
      "",
      buildSummaryLines(flags, species),
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
        "综合线索：建议按急诊处理",
        "你提供的信息里包含**需要尽快当面评估**的红线线索（例如泌尿梗阻风险、异常呼吸方式或严重循环/氧合问题线索）。\n\n本结果不能替代兽医诊断，但建议你**尽快**前往具备急诊能力的医院，并携带下方摘要。",
        "建议：尽快急诊；路上减少应激，勿自行使用处方药。",
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
        "腹部胀大合并明显全身症状：请尽快就医",
        "腹胀、呕吐或精神很差等组合，需排除急腹症、严重代谢问题等；不建议继续在家观察拖延。",
        "建议：尽快急诊或当日急诊门诊。",
        refIds,
        f,
        "cat"
      );
    }

    if (f.has("stool_melena") && (f.has("bar_b") || f.has("bar_c"))) {
      return finalize(
        "urgent",
        "黑便合并精神差：建议尽快就诊",
        "黑便柏油样提示上消化出血可能，合并精神沉郁需尽快化验与检查。",
        "建议：24 小时内门诊/急诊；不要自行喂人用止痛药。",
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
        "建议尽快安排兽医门诊",
        "多项线索提示需要**尽快**体格检查与化验鉴别（泌尿、消化、疼痛、代谢或心肺问题等均可能）。\n\n请把下方摘要带给医生，并尽量提供视频/照片。",
        "建议：尽快（今日至明日）就诊；若加重按急诊处理。",
        refIds,
        f,
        "cat"
      );
    }

    return finalize(
      "monitor",
      "可先预约门诊并持续观察",
      "目前线索更像**非最急**但仍建议形成完整记录：继续观察吃喝大小便与精神，若出现无尿/张口呼吸/粘膜发绀/持续呕吐等，请立刻重新评估或急诊。\n\n标准化信息有助于兽医更快判断。",
      "建议：预约门诊；心里不踏实或症状波动就提前就诊。",
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
        "可疑毒物摄入：请尽快联系急诊",
        "毒物种类与剂量决定处理，很多时候需要尽快启动解毒/支持治疗；不要自行催吐除非兽医指示。",
        "建议：携带包装/照片尽快急诊或致电动物毒物热线（以当地为准）。",
        new Set(["toxicology", "five-min-toxic", "silverstein-ecc"]),
        f,
        "dog"
      );
    }

    if (f.has("d_heat_yes")) {
      return finalize(
        "emergency",
        "中暑风险：请尽快急诊",
        "高温、闷热环境或闷热车内活动后出现明显异常，需紧急评估与支持治疗。",
        "建议：尽快急诊。",
        new Set(["silverstein-ecc", "bsava-ecc"]),
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
        "建议尽快兽医门诊",
        "你提供的信息提示需要尽快体检与基础化验（脱水、感染、疼痛、异物、关节问题等方向需鉴别）。",
        "建议：尽快预约；幼犬/小型犬呕吐腹泻更易脱水，别拖。",
        refIds,
        f,
        "dog"
      );
    }

    return finalize(
      "monitor",
      "可先观察并完善记录",
      "整体更像可观察范畴，但仍建议记录食欲、呕吐/腹泻次数与精神状态；出现异常呼吸、腹胀干呕、抽搐、便血等请立即就医。",
      "建议：观察并预约门诊；不适加重随时就诊。",
      refIds,
      f,
      "dog"
    );
  }

  function finalize(level, title, body, vetNeed, refIdsSet, flags, species) {
    const copyBlock = buildCopyTemplate(species, flags);
    const summary = buildSummaryLines(flags, species);
    return {
      level,
      title,
      body:
        body +
        "\n\n【已结构化记录要点】\n" +
        summary +
        "\n\n（以上条目由你的选择自动生成，可在就诊时口述或复制下方模板）",
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
    return {
      level: c.level,
      title: c.title,
      body: c.body + "\n\n【已结构化记录要点】\n" + summary,
      vetNeed: c.vetNeed,
      refIds: c.refIds,
      copyBlock: buildCopyTemplate(sp, f),
      intakeSummary: summary,
    };
  }

  global.CuraIntakeEval = {
    evaluateIntake,
    buildCopyTemplate,
    buildSummaryLines,
    getCritical,
    finalizeCritical,
    CAT_FLAG_LABELS,
    DOG_FLAG_LABELS,
  };
})(typeof window !== "undefined" ? window : globalThis);
