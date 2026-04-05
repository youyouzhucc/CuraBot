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
      title: "尿尿问题：更像要立刻去医院（尤其尿不出）",
      oneLiner: "**马上急诊**；跟医生说明「最后一次尿出来是什么时候、有没有吐、是不是一点都尿不出」。",
      detailExplain:
        "猫**尿很少、尿不出**，还疼、肚子不舒服或吐，首先要想到**尿道堵了**这类急事——堵久了会伤肾、全身恶化，**公猫更常见，但母猫也不能大意**。\n\n" +
        "是不是堵、怎么治，**必须医生摸肚子、做检查才能定**，这里不能代替诊断。",
      homeCare:
        "• 别硬灌水、别自己塞药或导尿。\n• 路上别太折腾，尽快送到能看猫急诊的医院。\n• 记一下：最后一次尿出来大概几点、尿团有多小、吐了几回。",
      vetNeed:
        "**建议**：立即赴急诊；向接诊人员说明「最后一次排尿时间、是否呕吐、是否完全无尿」。",
      refIds: ["feline-patient", "isfm", "silverstein-ecc", "mvm"],
    },
    dog_gdv_er: {
      level: "emergency",
      title: "肚子胀 + 干呕：像胃扭转那类急事（深胸大狗要格外当心）",
      oneLiner: "**马上联系能开刀的急诊医院**；路上别乱跑乱翻，车开稳一点。",
      detailExplain:
        "肚子**鼓得很快**、一直想吐却吐不出、难受或蔫，在深胸大狗身上要特别警惕**胃扭转**这类要抢时间的急症；也可能是别的急腹症，**都得医生拍片/体检才能分清**。\n\n" +
        "别为了「垫一口」大量喂水喂饭，反而耽误去医院。",
      homeCare:
        "• 出发前别大量喂水喂食。\n• 路上少颠簸；记一下肚子从啥时候开始胀、吐了几回。\n• 到医院说清楚品种、体型、症状多久了。",
      vetNeed: "**建议**：立即联系急诊外科；途中避免剧烈跑动。",
      refIds: ["fossum", "silverstein-ecc", "ecc-pocket", "mvm"],
    },
    dog_neuro_er: {
      level: "emergency",
      title: "抽抽、瘫了、叫不醒：别当小事",
      oneLiner: "**尽快急诊**；怀疑吃了啥坏的，把**包装或照片**带上。",
      detailExplain:
        "一直抽、突然站不起来、昏沉沉，可能是**中毒、脑子或脊柱的问题**等，有的几小时就变重，**必须医生查**。\n\n" +
        "别往嘴里塞东西防咬——容易伤你也帮不上忙。",
      homeCare:
        "• 记一下发作**从几点到几点、抽了几次**。\n• 有毒物把包装带上。\n• 搬运轻一点，少晃。",
      vetNeed: "**建议**：尽快急诊神经/急诊全科评估；必要时转诊影像或神经专科。",
      refIds: ["silverstein-ecc", "ettinger", "mvm"],
    },
    dog_resp_er: {
      level: "emergency",
      title: "喘得厉害、嘴发紫或发白：先当急事处理",
      oneLiner: "**尽快急诊**；说清楚**啥时候开始的**、有没有心脏病老毛病，路上别闷着。",
      detailExplain:
        "喘得费劲、嘴张着喘（要结合品种看）、**牙龈发紫或发白**，说明身体**可能缺氧或有严重心肺问题**，一般要吸氧、检查，**别在路上拖太久**。\n\n" +
        "扁脸狗、有心脏病史的更容易突然加重。",
      homeCare:
        "• 车里别关死窗闷着，也别大太阳底下晒。\n• 别使劲勒胸口。\n• 能数一下安静时一分钟喘多少下，告诉医生。",
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
      emergency: "紧急：更像要马上去医院（急诊）",
      urgent: "要紧：最好一两天内看门诊",
      monitor: "先观察：在家盯紧点，不放心就提前去",
      routine: "相对不急：仍建议有空让兽医把把关",
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
      "【Ta 大概啥情况（非诊断）】",
      detailExplain,
      "",
      "【在家你可以先这样做】",
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
        "更像要马上去医院（急诊）",
        "你勾的这些，听起来**很像不能拖的那种**：比如**几乎尿不出**、猫安静时还**像狗一样张嘴喘**、或者**嘴皮/牙龈发紫**——都可能很危险，要医生马上处理。\n\n" +
          "具体怎么治（吸不吸氧、补不补液等）**听医生的**；这里**不能诊断**也不能开药。",
        "• 把**啥时候开始不对劲、有没有越来越重**记一下；尿团、喘气可以拍视频。\n• 路上安静、通风，别捂太热。\n• 人吃的止痛药、镇静药**别自己喂**。",
        "尽快去能看急诊的医院；下面摘要带上，跟医生说清楚**从啥时候开始、有没有加重**。",
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
        "肚子胀 + 吐得厉害/精神很差：先当急事",
        "肚子**胀得明显**，又**吐个不停**或**一摸就疼**、**蔫到不行**，可能是**肠子堵了、肚子里积液、母猫子宫问题**等急事，有的会**很快恶化**。\n\n" +
          "**别自己喂止痛药、别硬灌吃的**；是不是、怎么治，医生摸完肚子、该拍片拍片。",
        "• 记一下：**肚子从啥时候胀、吐了几回、上次拉屎啥时候**。\n• 路上别晃太狠，别热敷乱揉肚子。\n• 以前开过刀、长期吃药的，一并告诉医生。",
        "尽快去急诊；跟医生说**胀得快不快、吐了几回、大便最近有没有**。",
        refIds,
        f,
        "cat"
      );
    }

    if (f.has("stool_melena") && (f.has("bar_b") || f.has("bar_c"))) {
      return finalize(
        "urgent",
        "黑便像柏油、精神又很差：别拖",
        "大便**又黑又黏像柏油**，猫又**蔫蔫的**，要想到**胃或上面肠子出血**的可能，有的会失血多，**不能当普通软便**。\n\n" +
          "具体原因要医生查；**人吃的止痛药很多对猫有毒，别自己喂**。",
        "• 看看**牙龈是不是特别白**、是不是一直睡。\n• 先别乱喂吃的，等医生安排。\n• 黑便拍个照，大概几次也记一下。",
        "**今天到明天**一定要让兽医看；要是**越来越白、越来越虚**，直接去急诊。",
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
        "好几条都不对劲：建议尽快让兽医全面看看",
        "你勾的这些里，至少有**一类值得认真对待**：比如尿尿费劲、带血，吐得多，疼、瘸，**皮发黄、牙龈发白**，喘得明显等等——有的要**验血验尿拍片**才说得清，**这里不能代替医生下结论**。\n\n" +
          "尽量**一两天内约上门诊**；把下面记录带给医生。",
        "• 继续记：**吃、喝、尿团、吐拉、精神**。\n• 别突然换粮加一堆零食，免得干扰判断。\n• 要是**完全尿不出、疼得受不了、蔫到不行**，改去急诊。",
        "**今天明天**尽量看上医生；中间**突然变差**就别等预约了，直接去急诊。",
        refIds,
        f,
        "cat"
      );
    }

    return finalize(
      "monitor",
      "先在家多盯几天，但别掉以轻心",
      "按你这次勾的，**没踩中我们设的「必须马上急诊」那几条**，所以先归在「**在家多留意，有空让兽医瞧一眼**」这一类。\n\n" +
        "但这**不等于**一定没事——有的问题要医生摸一摸、验一验才看得出来。**小猫、老猫、本来就有慢病的**，定期让医生看看更踏实。\n\n" +
        "要是出现：**完全尿不出**；安静待着也**张嘴喘**；**牙龈发紫或发白**；一直吐；**肚子又胀又疼**——别拖，重新用急先筛或直接去医院。",
      "• 随便记记：吃多少、喝多少、尿团大不大、吐没吐、精神咋样。\n• 猫砂盆常清，好看尿量有没有突然变少。\n• 人吃的药、网上乱买的「泌尿保健品」别自己乱喂，有疑问问兽医。",
      "**最近几天**最好能约个门诊让医生看一眼；小猫老猫或有慢病的，心里不踏实就**早点去**。",
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
        "怀疑吃了不该吃的：别先自己催吐",
        "狗误食**巧克力、葡萄、木糖醇、老鼠药、防冻液、人吃的止痛药**等，有的**拖不得**，但**要不要催吐、怎么救**得听兽医的，**别听网上偏方自己灌**。\n\n" +
          "不同东西危险程度和等待时间不一样，**尽快联系急诊或中毒热线**。",
        "• **包装、照片**留着；大概吃了多少、啥时候吃的记一下。\n• 路上看有没有抽、吐白沫、走路发飘。\n• 牛奶、油、乱喂药都先别上，等医生说话。",
        "**马上**联系能看急诊的医院或中毒咨询；带着**包装和照片**去。",
        new Set(["toxicology", "five-min-toxic", "silverstein-ecc", "mvm"]),
        f,
        "dog"
      );
    }

    if (f.has("d_heat_yes")) {
      return finalize(
        "emergency",
        "中暑/热坏了：当急事处理",
        "大太阳、闷热车里、剧烈运动后，狗可能**喘得厉害、流口水、站不稳、甚至迷糊**——扁脸狗、胖狗更容易中招。**降温、补液怎么弄要医生说了算**。\n\n" +
          "别用冰水全身泡，也别再跑跳折腾。",
        "• 用**凉水**擦脚垫、大腿根，别一猛子冰水里泡。\n• 车里开窗透气，别关死。\n• 啥时候晒的、跑了多久记一下。",
        "**尽快去急诊**；告诉医生**在哪儿热的、大概多久了**。",
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
        "吐、拉、不吃、瘸、蔫：建议尽快约门诊",
        "你勾的这些，说明**身体多半有点问题要查**：吐拉、不吃、瘸、精神差——小狗吐拉了容易**脱水没劲**，大狗瘸了要排除**骨头韧带**等问题，**具体得医生摸和验**。\n\n" +
          "可能要抽血验尿拍片，听医生安排。",
        "• 吐得厉害就先别乱喂；水怎么喝听医生电话或到现场再说。\n• 吐几次、拉啥样、哪条腿瘸记一下。\n• 人吃的止泻药、止痛药**别自己喂**。",
        "**尽快约上门诊**；要是**肚子胀想吐吐不出、拉血、抽起来、完全蔫了**，直接去急诊。",
        refIds,
        f,
        "dog"
      );
    }

    return finalize(
      "monitor",
      "先在家盯紧点，大狗也要防「胀肚子急症」",
      "按你勾的，**没像必须马上冲急诊那种**，但**尤其大个子、深胸的狗**，要是哪天**肚子突然胀、想吐吐不出**，还是要**当急事**。\n\n" +
        "平时**便血、抽、发烧、疼得叫**也别拖。吃多少、胖瘦怎么减，**跟兽医一起定**比乱节食强。",
      "• 记一记每天吃多少、拉啥样、玩多久。\n• 大狗**吃完饭别马上疯跑**；肚子突然鼓起来要警惕。\n• 每年体检能早发现不少问题。",
      "有空**约个常规门诊**；一不对劲就**升级去急诊**。",
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
