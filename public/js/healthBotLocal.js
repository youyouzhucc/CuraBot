/**
 * 本地兜底：基于知识库关键词与急诊红线的科普回复（非 LLM，不能诊断）。
 * 返回 severity（建议分层）与可选 followUpQuiz（症状追问选择题）。
 */
(function (global) {
  /** 猫排尿循证：临床维度分 0～5，未闭合前禁止「紧急」红线（与 healthBot / server 对齐） */
  function joinUserBlobForUro(history, quizLines) {
    const u = (history || [])
      .filter((h) => h.role === "user")
      .map((h) => String(h.content || "").replace(/^【用户已选档案】[\s\S]*?\n\n/, ""))
      .join("\n");
    const q = (quizLines || []).join("\n");
    return (u + "\n" + q).trim();
  }

  /** 最近一条用户原文（不含档案前缀），用于主诉路由 */
  function getLatestUserPlain(history) {
    const h = history || [];
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].role === "user") {
        return String(h[i].content || "").replace(/^【用户已选档案】[\s\S]*?\n\n/, "");
      }
    }
    return "";
  }

  /** 当前句是否明确在谈排尿/砂盆相关 */
  function urinaryIntentIn(text) {
    return /(没尿|无尿|不尿|尿不出|尿团|排尿|砂盆|蹲盆|滴尿|尿频|尿急|尿闭|尿血|血尿|舔尿道|排尿困难|尿量少)/.test(String(text || ""));
  }

  /**
   * 最新一条主诉明显是「非泌尿」时（如精神差、呕吐），用于退出泌尿专链，避免仍追问砂盆。
   * 若同句仍含排尿线索，则不算主诉转移。
   */
  function nonUrinaryChiefMessage(latest) {
    const t = String(latest || "").trim();
    if (!t) return false;
    if (urinaryIntentIn(t)) return false;
    return /(精神|萎靡|蔫|乏力|疲惫|嗜睡|不吃|拒食|呕吐|吐|拉稀|腹泻|软便|便秘|咳嗽|喘|皮肤|痒|瘸|跛|发烧|无力|没力气|没精打采|食欲差|没胃口|走路不稳|抽搐|昏迷|休克|粘膜|牙龈|苍白|发绀|CRT|脚垫冰凉|翻脚|瞳孔|鼻涕|喷嚏|口臭|差劲|不太好|不正常|子宫蓄脓|流脓|黄疸|糖尿病|甲亢|FIP|传腹)/.test(
      t
    );
  }

  /** 档案未选物种时，从对话里推断猫/狗，否则门控永远不生效 */
  function effectiveSpeciesFromBlob(profile, blob) {
    const b = String(blob || "");
    const fromProfile = profile && profile.species;
    if (fromProfile === "cat" || fromProfile === "dog") return fromProfile;
    if (/(狗|犬|狗狗)/.test(b) && !/(猫|喵|猫猫)/.test(b)) return "dog";
    if (/(猫|喵|猫猫)/.test(b)) return "cat";
    return fromProfile || null;
  }

  function computeCatUrinaryEvidence(history, profile, quizLines, ctx) {
    ctx = ctx || {};
    const blob = joinUserBlobForUro(history, quizLines);
    const sp = effectiveSpeciesFromBlob(profile, blob);
    const latest = getLatestUserPlain(history);
    const urinaryInBlobCat = /(没尿|无尿|不尿|尿不出|尿团|排尿|砂盆|蹲盆|滴尿|尿频|尿急|尿闭)/.test(blob);
    const urinaryInBlobDog = /(没尿|无尿|不尿|尿不出|排尿|滴尿|尿频|尿急|尿闭|尿血|血尿|费力)/.test(blob);
    const urinaryInLatest = urinaryIntentIn(latest);
    const uroSession = ctx.mandatoryThreadKind === "urinary";

    if (nonUrinaryChiefMessage(latest)) {
      return {
        threadActive: false,
        clinicalScore: 0,
        allowEmergencyTag: false,
        immediateDanger: false,
        strongNegative: false,
        blob,
        topicShiftOffUrinary: true,
        species: sp,
      };
    }

    const catThread =
      sp === "cat" &&
      !/(狗|犬)/.test(blob) &&
      (urinaryInLatest || (uroSession && urinaryInBlobCat));
    const dogThread =
      sp === "dog" &&
      !/(猫|喵)/.test(blob) &&
      (urinaryInLatest || (uroSession && urinaryInBlobDog));
    const threadActive = catThread || dogThread;
    if (!threadActive) {
      return {
        threadActive: false,
        clinicalScore: 0,
        allowEmergencyTag: false,
        immediateDanger: false,
        strongNegative: false,
        blob,
        species: sp,
      };
    }
    const immediateDanger =
      /(吐|呕).{0,28}(尿|无尿|尿不出|没尿)|(尿|没尿|无尿).{0,35}(吐|呕)/.test(blob) ||
      /(肚子|腹部).{0,12}(硬|胀|很胀|一碰就|不让碰).{0,20}(尿|排尿|没尿)/.test(blob) ||
      /(尿闭|完全尿不出|一滴尿).{0,12}(惨叫|痛苦|打滚|不停叫)/.test(blob);
    const strongNegative =
      /(精神好|食欲好|能吃能玩|和平时差不多|肚子软|肚子不硬|玩得正常)/.test(blob) &&
      !/(吐|呕|硬|胀|尿不出|尿闭|尿血|血尿)/.test(blob);

    let clinicalScore = 0;
    if (/(一天|整天|整日|24|两天|很久|小时|昨夜|今早|超过|12～|12-24|约12|十二)/.test(blob)) clinicalScore++;
    if (sp === "cat") {
      if (/(砂盆|猫砂|尿团|地毯|床底|隐蔽|检查|找过|都看过|别处|换砂)/.test(blob)) clinicalScore++;
      if (/(蹲盆|滴尿|频繁|挤不出|总去|尿不出来|几乎没有尿|没去砂盆|用力尿)/.test(blob)) clinicalScore++;
    } else {
      if (/(遛|户外|草地|检查|找过|都看过|别处|之前尿过)/.test(blob)) clinicalScore++;
      if (/(蹲|抬腿|滴尿|频繁|挤不出|总蹲|尿不出来|几乎没有尿|用力尿|做排尿姿势)/.test(blob)) clinicalScore++;
    }
    if (/(精神|食欲|不吃|萎靡|嗜睡|尚可|活跃|正常玩)/.test(blob)) clinicalScore++;
    if (/(吐|呕|胀|硬|疼|叫|舔尿道|舔生殖器|血尿|粉红)/.test(blob)) clinicalScore++;

    const allowEmergencyTag = immediateDanger || (clinicalScore >= 5 && !strongNegative);
    return {
      threadActive: true,
      clinicalScore,
      allowEmergencyTag,
      immediateDanger,
      strongNegative,
      blob,
      species: sp,
    };
  }

  /**
   * 按维度顺序返回下一道必答题；全部满足时返回 null（允许进入 LLM 总结）。
   * 与 compute 中 5 维正则一一对应。
   */
  function getNextCatUrinaryMandatoryQuestion(ev) {
    if (!ev || !ev.threadActive || ev.immediateDanger) return null;
    const b = ev.blob || "";
    const isDog = ev.species === "dog";
    const dims = isDog ? [
      {
        id: "time",
        test: () => /(一天|整天|整日|24|两天|很久|小时|昨夜|今早|超过|12～|12-24|约12|十二)/.test(b),
        text: "大概从什么时候发现排尿变少或排不出？",
        hint: "",
        options: ["昨晚起", "今天白天", "近一两天"],
      },
      {
        id: "env",
        test: () => /(遛|户外|草地|检查|找过|都看过|别处|之前尿过)/.test(b),
        text: "最近一次正常排尿是在什么时候、什么场景？在家有排尿吗？",
        hint: "",
        options: ["遛弯时尿过", "在家排尿量很少", "记不清上次正常排尿"],
      },
      {
        id: "behavior",
        test: () => /(蹲|抬腿|滴尿|频繁|挤不出|总蹲|尿不出来|几乎没有尿|用力尿|做排尿姿势)/.test(b),
        text: "排尿时有什么异常姿势吗？是频繁做排尿动作但尿不出，还是完全没有排尿表现？",
        hint: "",
        options: ["频繁蹲/抬腿但尿不出几滴", "完全没有排尿动作", "说不清，我再观察一下"],
      },
      {
        id: "spirit",
        test: () => /(精神|食欲|不吃|萎靡|嗜睡|尚可|活跃|正常玩)/.test(b),
        text: "现在精神、吃东西、喝水，和平时比怎么样？",
        hint: "",
        options: ["和平时差不多", "精神差或吃得少", "介于两者之间"],
      },
      {
        id: "systemic",
        test: () => /(吐|呕|胀|硬|疼|叫|舔生殖器|舔尿道|血尿|粉红)/.test(b),
        text: "有没有呕吐、肚子胀硬、频繁舔生殖器、尿色发粉或带血？",
        hint: "",
        options: ["没有这些情况", "有一项或多项", "不太确定"],
      },
    ] : [
      {
        id: "time",
        test: () => /(一天|整天|整日|24|两天|很久|小时|昨夜|今早|超过|12～|12-24|约12|十二)/.test(b),
        text: "大概从什么时候发现尿变少或没尿团？",
        hint: "",
        options: ["昨晚起", "今天白天", "近一两天"],
      },
      {
        id: "env",
        test: () => /(砂盆|猫砂|尿团|地毯|床底|隐蔽|检查|找过|都看过|别处|换砂)/.test(b),
        text: "常用砂盆、床底、地毯都看过吗？有没有可能尿在别处，或最近换砂、环境有变化？",
        hint: "",
        options: ["都看过了，别处也没发现", "可能尿在隐蔽处", "最近换砂或环境有变"],
      },
      {
        id: "behavior",
        test: () => /(蹲盆|滴尿|频繁|挤不出|总去|尿不出来|几乎没有尿|没去砂盆|用力尿)/.test(b),
        text: "是几乎不去猫砂盆，还是老去猫砂盆却几乎尿不出、只能滴几滴？",
        hint: "",
        options: ["几乎不去砂盆", "老去砂盆但尿不出几滴", "说不清，我再帮你对一下"],
      },
      {
        id: "spirit",
        test: () => /(精神|食欲|不吃|萎靡|嗜睡|尚可|活跃|正常玩)/.test(b),
        text: "现在精神、吃东西、喝水，和平时比怎么样？",
        hint: "",
        options: ["和平时差不多", "精神差或吃得少", "介于两者之间"],
      },
      {
        id: "systemic",
        test: () => /(吐|呕|胀|硬|疼|叫|舔尿道|血尿|粉红)/.test(b),
        text: "有没有吐、肚子胀硬或不让碰、一直舔尿道口、尿色发粉或带血？",
        hint: "",
        options: ["没有这些情况", "有一项或多项", "不太确定"],
      },
    ];
    for (let i = 0; i < dims.length; i++) {
      if (!dims[i].test()) return dims[i];
    }
    return null;
  }

  /** 简易风险展示分 0～100，仅用于家长理解「为何还不能下结论」 */
  function estimateUrinaryRiskDisplay(ev) {
    if (!ev || !ev.threadActive) return 0;
    let r = ev.clinicalScore * 18;
    if (ev.strongNegative) r -= 35;
    if (ev.immediateDanger) r = Math.max(r, 85);
    return Math.max(0, Math.min(100, Math.round(r)));
  }

  global.CuraCatUroEvidence = {
    compute: computeCatUrinaryEvidence,
    getNextMandatoryQuestion: getNextCatUrinaryMandatoryQuestion,
    estimateRiskDisplay: estimateUrinaryRiskDisplay,
    EMERGENCY_THRESHOLD: 5,
  };

  global.CuraChiefRouting = {
    getLatestUserPlain,
    urinaryIntentIn,
    nonUrinaryChiefMessage,
  };

  /**
   * 通用健康线索：未涉及猫排尿专链时，要求 5 个信息维度后再交给大模型总结（与猫排尿 gate 互斥）。
   */
  function computeGeneralClinicalEvidence(history, profile, quizLines, ctx) {
    const uro = computeCatUrinaryEvidence(history, profile, quizLines, ctx);
    if (uro.threadActive) {
      return {
        threadActive: false,
        clinicalScore: 0,
        allowEmergencyTag: true,
        immediateDanger: false,
        blob: uro.blob,
      };
    }
    const blob = joinUserBlobForUro(history, quizLines);
    const sp = effectiveSpeciesFromBlob(profile, blob);
    const trivial = /^(你好|在吗|谢谢|您好|哈喽|Hi|hi|在不在|有人吗)[\s！!。.]*$/i.test(String(blob).trim());
    const symptomMark =
      /(吐|呕|反流|腹泻|拉稀|软便|便秘|尿|排尿|尿频|尿血|尿闭|没尿|无尿|不尿|膀胱|粘膜|牙龈|苍白|发绀|青紫|休克|CRT|脱水|灌注|脚垫|皮肤回弹|皮肤|痒|掉毛|脱毛|皮屑|疹|瘸|跛|扭|骨折|骨裂|扭伤|脱臼|韧带|外伤|摔伤|撞伤|碾压|咳|喘|张口|呼吸|喷嚏|鼻涕|眼睛|流泪|耳|臭|牙齿|牙龈|口腔|发烧|抽|癫痫|瞳孔|瘫|抖|翻脚|精神|萎靡|不吃|拒食|消瘦|呕吐|血便|便血|胀|疼|痛|肿|流口水|口臭|不吃饭|不吃东西|喝水|多饮|少尿|跛行|抓挠|挠|红肿|里急后重|黑便|猫瘟|毛球|IBD|FLUTD|CKD|慢性肾病|黄疸|胆红素|耳螨|哮喘|鼻支|HCM|肥厚|血栓|子宫蓄脓|传腹|前庭|线状异物|食物过敏|糖尿病|血糖|甲亢|甲状腺|甲狀腺|眼黄|腹水)/;
    const threadActive =
      !trivial && symptomMark.test(blob) && (sp === "cat" || sp === "dog") && String(blob).trim().length >= 2;
    if (!threadActive) {
      return {
        threadActive: false,
        clinicalScore: 0,
        allowEmergencyTag: true,
        immediateDanger: false,
        blob,
      };
    }
    const immediateDanger =
      /(大量出血|口吐白沫|抽搐|昏迷|休克|喘不上气|窒息|无意识|体温\s*4[01]\b|体温\s*40[.\d]|体温\s*41|持续抽搐|撞车.*外伤|猫.*张口喘|安静时张口喘|粘膜.*发绀|牙龈.*发绀|抽搐.*失禁|膀胱.*硬.*无尿|超过\s*12.*小时.*无尿|12\s*小时.*几乎没尿|后肢.*瘫痪.*冰凉|后腿.*瘫痪.*冰凉|瘫痪.*后肢.*冰凉|脚垫.*冰凉.*瘫痪|子宫蓄脓|流脓.*分泌物|母猫.*腹大.*脓|黄疸.*呕|黄疸.*吐)/.test(
        blob
      );
    const circulationTrack =
      /(粘膜|牙龈|苍白|发绀|青紫|砖红|休克|CRT|毛细血管|皮肤回弹|脱水|脚垫冰凉|耳尖冰凉|循环|灌注)/.test(blob);
    const neuroTrack = /(抽搐|癫痫|瞳孔|翻脚|脊髓|瘫痪|意识不清|震颤|失禁|叫名字)/.test(blob);
    const urinaryTrack = /(尿闭|没尿|无尿|不尿|尿不出|尿频|尿急|尿血|血尿|滴尿|尿团|砂盆|排尿困难|舔尿道|FLUTD|FIC|结晶|结石|CKD|慢性肾病)/.test(
      blob
    );
    const metabolicTrack =
      /(黄疸|胆红素|皮肤发黄|眼黄|眼白发黄|糖尿病|血糖|甲亢|甲状腺|甲狀腺|FIP|传腹|猫传腹|腹水)/.test(blob);
    const respDetailTrack =
      /(喘|咳|呼吸费力|气促|张口呼吸|啰音|湿咳|异物|梗阻|端坐|气胸|肺水肿|泡沫痰|鼻支|疱疹|杯状|哮喘)/.test(blob);
    const giDetailTrack =
      /(吐|呕|反流|拉|泻|黑便|里急后重|祈祷|腹膜炎|腹胀|肠梗阻|粪臭|咖啡|猫瘟|线状异物|线形异物|泛白细胞|IBD|EPI)/.test(blob);
    const mobilityTrack =
      /(瘸|跛|扭|骨折|骨裂|扭伤|脱臼|韧带|外伤|摔伤|撞伤|碾压|步态|不愿走|关节|拖行|踮脚|不负重|不着地|后肢瘫|后腿瘫|血栓)/.test(blob);
    const skinTrack =
      /(皮肤|痒|掉毛|脱毛|秃|皮屑|红疹|湿疹|抓挠|瘙痒|皮疹|红肿|黑下巴|真菌|螨虫|跳蚤)/.test(blob);
    const dentalTrack = /(口臭|牙齿|牙龈|口腔|牙结石|咀嚼|进食困难|咬不动|流涎|刷牙|牙痛)/.test(blob);
    let clinicalScore = 0;
    if (circulationTrack) {
      /** 循环与灌注：粘膜、CRT、皮肤弹性、肢端温度、时间 */
      if (/(粉红|苍白|发绀|青紫|砖红|没细看|偏苍白)/.test(blob)) clinicalScore++;
      if (/(两秒|2秒|超过两秒|没试过|按压)/.test(blob)) clinicalScore++;
      if (/(立刻回弹|1-3秒|很慢|大于5秒|没试)/.test(blob)) clinicalScore++;
      if (/(温热|冰凉|没注意)/.test(blob)) clinicalScore++;
      if (/(今天|昨日|昨天|前天|小时|天|周|开始|多久|持续|几次|最近|刚才|刚刚|两天|三天)/.test(blob)) clinicalScore++;
    } else if (neuroTrack) {
      if (/(脚背|拖地|翻脚|尚可|没试)/.test(blob)) clinicalScore++;
      if (/(瞳孔|不等|同步|对称|没细看)/.test(blob)) clinicalScore++;
      if (/(全身抽搐|局部抽动|失禁|无反应|不太确定)/.test(blob)) clinicalScore++;
      if (/(意识|昏迷|清醒|叫名字)/.test(blob)) clinicalScore++;
      if (/(今天|昨日|昨天|小时|最近|刚才|两天|三天)/.test(blob)) clinicalScore++;
    } else if (urinaryTrack) {
      /** 泌尿：时间、程度、膀胱区手感、全身线索、排尿环境观察 */
      if (/(今天|昨日|昨天|前天|小时|天|周|开始|多久|持续|超过|12|昨夜|刚才|两天|三天)/.test(blob)) clinicalScore++;
      if (/(严重|轻|重|频繁|滴|几乎|完全|胀痛|一点点|很少)/.test(blob)) clinicalScore++;
      if (/(软|气球|鼓胀|硬|橘子|乒乓球|摸不到|没按|不让碰)/.test(blob)) clinicalScore++;
      if (/(精神|食欲|吃喝|萎靡|嗜睡|吐|呕|血尿)/.test(blob)) clinicalScore++;
      if (/(砂盆|尿团|蹲盆|检查|换砂|地毯|床底)/.test(blob)) clinicalScore++;
    } else if (metabolicTrack) {
      /** 黄疸、糖尿病/甲亢线索、FIP/腹水等慢病或全身表现（与化验强相关） */
      if (/(黄疸|胆红素|发黄|眼黄|牙龈黄)/.test(blob)) clinicalScore++;
      if (/(多饮|多尿|消瘦|多食|血糖|口渴)/.test(blob)) clinicalScore++;
      if (/(精神|食欲|呕吐|腹泻|不吃)/.test(blob)) clinicalScore++;
      if (/(腹水|传腹|FIP|发热|腹围)/.test(blob)) clinicalScore++;
      if (/(今天|昨日|最近|几天|一周|两周|老年|七岁|八岁)/.test(blob)) clinicalScore++;
    } else if (mobilityTrack) {
      /** 运动伤/跛行：五维与追问选项文案对齐（受伤机制、部位、负重、局部表现、时间） */
      if (/(摔|跌落|跳楼|撞|压|碾|咬|打斗|车祸|扭伤|不明|不清楚|不知道)/.test(blob)) clinicalScore++;
      if (/(前腿|后腿|左|右|单侧|两侧|一条腿|多条|左前|右前|左后|右后|多处)/.test(blob)) clinicalScore++;
      if (/(不负重|不着地|拖行|完全不敢|跛行明显|能走但|偶尔|不太确定)/.test(blob)) clinicalScore++;
      if (/(肿|胀|有肿胀|破皮|出血|伤口|看起来还好|还没细看|没细看)/.test(blob)) clinicalScore++;
      if (/(今天|昨日|昨天|前天|小时|天|周|开始|多久|持续|几次|最近|昨晚|今早|刚才|刚刚|上午|下午|两天|三天)/.test(blob))
        clinicalScore++;
    } else if (skinTrack) {
      /** 皮肤/被毛：时间、分布、瘙痒、皮损线索、环境与驱虫等 */
      if (/(今天|昨日|昨天|前天|小时|天|周|开始|多久|持续|几次|最近|昨晚|今早|刚才|刚刚|两天|三天|一周)/.test(blob))
        clinicalScore++;
      if (/(全身|局部|对称|耳|脸|四肢|肚子|背部|说不清)/.test(blob)) clinicalScore++;
      if (/(很痒|经常抓|偶尔抓|不太挠|不确定)/.test(blob)) clinicalScore++;
      if (/(红疹|皮屑|结痂|破损|露皮|外观还行|还没细看)/.test(blob)) clinicalScore++;
      if (/(驱虫|换粮|搬家|洗澡|香波|新环境|接触|用药|没有明显)/.test(blob)) clinicalScore++;
    } else if (dentalTrack) {
      /** 口腔/牙齿：时间、咀嚼、牙龈口腔、流涎口臭、其他背景 */
      if (/(今天|昨日|昨天|前天|小时|天|周|开始|多久|持续|几次|最近|刚才|两天|三天)/.test(blob)) clinicalScore++;
      if (/(咀嚼困难|偏侧嚼|软的不吃|不吃硬|进食正常|还行)/.test(blob)) clinicalScore++;
      if (/(出血|红肿|口臭很重|还可以|没细看)/.test(blob)) clinicalScore++;
      if (/(流涎|口水多|口臭|不明显)/.test(blob)) clinicalScore++;
      if (/(驱虫|换粮|用药|洁牙|拔牙|外伤|异物|没有明显)/.test(blob)) clinicalScore++;
    } else if (respDetailTrack) {
      if (/(费力|张口|咳嗽|端坐|湿咳|逆向|嘶嘶|咯咯)/.test(blob)) clinicalScore++;
      if (/(湿咳|嘶嘶|咯咯|逆向|无异常)/.test(blob)) clinicalScore++;
      if (/(端坐|侧卧|不愿躺)/.test(blob)) clinicalScore++;
      if (/(发绀|未见发绀|没看)/.test(blob)) clinicalScore++;
      if (/(今天|昨日|昨天|最近|刚才|小时|两天|三天)/.test(blob)) clinicalScore++;
    } else if (giDetailTrack) {
      if (/(抽动|反流|说不清)/.test(blob)) clinicalScore++;
      if (/(咖啡|血丝|粪臭|未消化|未见)/.test(blob)) clinicalScore++;
      if (/(祈祷|硬胀|触痛|尚可)/.test(blob)) clinicalScore++;
      if (/(黑便|里急后重|水样|未注意)/.test(blob)) clinicalScore++;
      if (/(今天|昨日|昨天|最近|刚才|两天|三天)/.test(blob)) clinicalScore++;
    } else {
      if (/(今天|昨日|昨天|前天|小时|天|周|开始|多久|持续|几次|最近|昨晚|今早|早晨|第|一直|从小|大约|大概|两天|三天|一周|昨夜|刚才|刚刚|上午|下午|晚间)/.test(
        blob
      ))
        clinicalScore++;
      if (/(严重|轻|重|频繁|偶尔|越来越|加重|好转|差不多|滴血|大量|很少|一点点|非常|特别|两次|三次|多次|一次|减轻|恶化)/.test(blob))
        clinicalScore++;
      if (/(精神|食欲|吃喝|喝水|饮水|不吃|拒食|萎靡|活跃|嗜睡|胃口|能吃|饮水量|多饮|少饮)/.test(blob)) clinicalScore++;
      if (/(吐|呕|拉|泻|便|尿|软|血|咳嗽|喘|喷嚏|皮肤|痒|瘸|跛|鼻|眼|耳|发烧|抖|走路|步态|舔|抓)/.test(blob))
        clinicalScore++;
      if (/(疫苗|驱虫|新粮|换粮|搬家|出门|用药|吃药|医院|接触|别的猫|别的狗|绝育|年龄|体重|新成员|寄养)/.test(blob))
        clinicalScore++;
    }
    const allowEmergencyTag = immediateDanger || clinicalScore >= 5;
    return {
      threadActive: true,
      clinicalScore,
      allowEmergencyTag,
      immediateDanger,
      blob,
    };
  }

  /**
   * 必填追问过程中，最新一条常为「（补充）…：选项」短句，不再含骨折/口臭等主诉词，
   * 仅用 latest 会误判为 general。此处对补充句改用整段 blob 做路由。
   */
  function routingTextForMandatory(history, blob) {
    const latest = getLatestUserPlain(history || []);
    const l = String(latest || "").trim();
    if (/^（补充）/.test(l)) return String(blob || "");
    return l;
  }

  function inferPrimaryConcern(latest) {
    const t = String(latest || "");
    if (urinaryIntentIn(t)) return "urinary";
    if (/(子宫蓄脓|外阴流脓|脓性分泌物|未绝育母猫)/.test(t)) return "gi";
    if (/(黄疸|胆红素|皮肤发黄|眼白发黄|FIP|传腹|猫传腹|腹水)/.test(t)) return "gi";
    if (/(糖尿病|血糖|甲亢|甲状腺|甲狀腺)/.test(t)) return "energy";
    if (/(粘膜|牙龈苍白|牙龈发|苍白|发绀|青紫|砖红|休克|CRT|毛细血管|皮肤回弹|脱水|脚垫冰凉|耳尖冰凉|循环不良|灌注)/.test(t))
      return "circulation";
    if (/(抽搐|癫痫|瞳孔|翻脚|脊髓|瘫痪|意识不清|震颤|失禁|叫名字无反应)/.test(t)) return "neuro";
    if (/(咳|喘|张口呼吸|呼吸费力|气促|啰音|湿咳|异物|梗阻|端坐|气胸|肺水肿)/.test(t)) return "resp";
    if (/(吐|呕|反流|拉|泻|软便|便秘|便血|水样|黑便|里急后重|祈祷姿势|腹胀|腹硬|猫瘟|IBD|线状异物)/.test(t)) return "gi";
    if (/(口臭|牙齿|牙龈红肿|口腔|牙结石|咀嚼|进食困难|咬不动|流涎|刷牙|牙痛)/.test(t)) return "dental";
    if (/(皮肤|痒|掉毛|脱毛|秃|皮屑|红疹|湿疹|抓挠|瘙痒|皮疹|红肿|黑下巴)/.test(t)) return "skin";
    if (/(瘸|跛|扭|走路|关节|不愿走|步态|腿|前腿|后腿|骨折|骨裂|扭伤|脱臼|韧带|外伤|摔伤|撞伤|碾压)/.test(t))
      return "mobility";
    if (/(精神|萎靡|蔫|乏力|疲惫|嗜睡|不吃|拒食|没力气|没精打采|食欲差|没胃口)/.test(t)) return "energy";
    return "general";
  }

  /** 按主诉调整追问顺序，使「精神差」先问精神/全身，而非机械按时间第一 */
  const GENERAL_DIM_ORDER = {
    circulation: ["circ_mm", "circ_crt", "circ_turgor", "circ_extremity", "time"],
    neuro: ["neuro_proprio", "neuro_pupil", "neuro_seizure", "neuro_conscious", "time"],
    energy: ["spirit", "time", "severity", "other_signs", "context"],
    gi: ["gi_vomit_type", "gi_content", "gi_abdomen", "gi_stool", "time"],
    skin: ["skin_pattern", "skin_itch", "skin_lesion", "skin_context", "time"],
    dental: ["dental_chew", "dental_gums", "dental_drool", "dental_context", "time"],
    resp: ["resp_pattern", "resp_sound", "resp_posture", "resp_mm", "time"],
    mobility: ["mobility_cause", "mobility_limb", "mobility_weight", "mobility_skin", "time"],
    urinary: ["time", "severity", "uro_bladder_feel", "spirit", "context"],
    general: ["time", "severity", "spirit", "other_signs", "context"],
  };

  /** 泌尿：膀胱区手感等物理线索（科普级自查，不能替代就诊） */
  function buildUrinaryClinicalDims(b) {
    const blob = String(b || "");
    return {
      uro_bladder_feel: {
        id: "uro_bladder_feel",
        test: () => /(软|气球|鼓胀|硬|橘子|乒乓球|没按|不让碰|摸不到)/.test(blob),
        text: "从大腿根部向前腹轻深按：膀胱区手感更像什么？（若明显抗拒或疼痛请停手）",
        options: ["软或未明显鼓胀、或摸不太到", "略鼓、像软气球", "很胀、像硬橘子或乒乓球", "不让碰或没试"],
      },
    };
  }

  /** 循环与灌注：粘膜颜色、CRT、皮肤弹性、肢端温度（临床 P1 底层线索，科普级） */
  function buildCirculationDims(b) {
    const blob = String(b || "");
    return {
      circ_mm: {
        id: "circ_mm",
        test: () => /(粉红|苍白|发绀|青紫|砖红|没细看|偏苍白)/.test(blob),
        text: "翻开嘴唇看牙龈/粘膜：颜色更接近哪一种？（可用手电筒辅助）",
        options: ["偏粉红接近正常", "偏苍白", "发紫或发绀", "深红/砖红或还没细看"],
      },
      circ_crt: {
        id: "circ_crt",
        test: () => /(两秒|2秒|超过两秒|没试过|按压牙龈)/.test(blob),
        text: "毛细血管再充盈（CRT）：用力压牙龈变白后松手，恢复粉红色大约多久？",
        options: ["约2秒内恢复", "超过2秒才恢复", "没试过", "不太会看"],
      },
      circ_turgor: {
        id: "circ_turgor",
        test: () => /(立刻回弹|1-3秒|很慢|大于5秒|没试)/.test(blob),
        text: "皮肤弹性：轻提肩胛骨上方皮肤松手后，回弹怎样？",
        options: ["几乎立刻回弹", "约1-3秒", "很慢或大于5秒", "没试"],
      },
      circ_extremity: {
        id: "circ_extremity",
        test: () => /(温热|冰凉|没注意)/.test(blob),
        text: "脚垫、耳尖摸起来温度怎样？",
        options: ["温热", "冰凉", "没注意"],
      },
    };
  }

  /** 神经：本体感觉、瞳孔、抽搐类型、意识（科普级分诊线索） */
  function buildNeuroDims(b) {
    const blob = String(b || "");
    return {
      neuro_proprio: {
        id: "neuro_proprio",
        test: () => /(脚背|拖地|翻脚|尚可|没试)/.test(blob),
        text: "走路时脚是否背屈拖地？或做「翻脚背」时能否马上翻正？",
        options: ["脚背拖地或步态怪", "翻脚反应差", "走姿尚可", "没试"],
      },
      neuro_pupil: {
        id: "neuro_pupil",
        test: () => /(瞳孔|不等|同步|对称|没细看)/.test(blob),
        text: "双眼瞳孔大小是否一致？用手机灯照一下，收缩是否同步？",
        options: ["左右明显不等", "光反射不同步", "看起来对称", "没细看"],
      },
      neuro_seizure: {
        id: "neuro_seizure",
        test: () => /(全身抽搐|局部抽动|失禁|无反应|不太确定)/.test(blob),
        text: "若有抽抖：更像全身抽搐还是局部？发作时有无大小便失禁？",
        options: ["全身抽搐伴失禁可能", "局部抖动、意识尚可", "叫名字几乎无反应", "不太确定"],
      },
      neuro_conscious: {
        id: "neuro_conscious",
        test: () => /(意识|昏迷|清醒|能回应)/.test(blob),
        text: "现在意识与反应：能认人、能回应呼唤吗？",
        options: ["清醒能回应", "萎靡但可互动", "意识差或昏迷样", "说不清"],
      },
    };
  }

  /** 呼吸：区分费力/咳嗽/声音/体位与缺氧（与循环粘膜可交叉参考） */
  function buildRespClinicalDims(b) {
    const blob = String(b || "");
    return {
      resp_pattern: {
        id: "resp_pattern",
        test: () => /(费力|张口|咳嗽|端坐|湿咳|逆向)/.test(blob),
        text: "更像哪一种？（猫安静时张口呼吸需高度重视）",
        options: ["呼吸费力或张口呼吸", "以咳嗽为主", "端坐不愿躺下", "逆向喷嚏样或不太明显"],
      },
      resp_sound: {
        id: "resp_sound",
        test: () => /(嘶嘶|咯咯|湿咳|逆向|无异常)/.test(blob),
        text: "呼吸或咳嗽时有无异常声音？",
        options: ["嘶嘶或咯咯声", "湿咳像有水", "逆向喷嚏", "无明显异常声"],
      },
      resp_posture: {
        id: "resp_posture",
        test: () => /(端坐|侧卧|不愿躺)/.test(blob),
        text: "更愿意哪种姿势？",
        options: ["端坐、不愿侧卧", "可以侧卧休息", "说不清"],
      },
      resp_mm: {
        id: "resp_mm",
        test: () => /(发绀|未见发绀|没看)/.test(blob),
        text: "粘膜有无发绀（青紫）？",
        options: ["有发绀", "未见发绀", "没看"],
      },
    };
  }

  /** 消化：反流 vs 呕吐、性状、腹部、排便（精细化） */
  function buildGiClinicalDims(b) {
    const blob = String(b || "");
    return {
      gi_vomit_type: {
        id: "gi_vomit_type",
        test: () => /(腹部抽动|反流|说不清)/.test(blob),
        text: "若有吐：更像呕吐（有干呕、腹部抽动）还是反流（食物突然涌出、管状）？",
        options: ["有明显腹部抽动像呕吐", "像反流瞬间涌出", "说不清或仅恶心"],
      },
      gi_content: {
        id: "gi_content",
        test: () => /(咖啡|血丝|粪臭|未消化|异物|未见)/.test(blob),
        text: "呕吐物或吐出物性状？",
        options: ["咖啡色或带血丝", "有粪臭味", "未消化食物为主", "未见或未吐"],
      },
      gi_abdomen: {
        id: "gi_abdomen",
        test: () => /(祈祷|硬胀|触痛|尚可)/.test(blob),
        text: "腹部：有无「祈祷姿势」、全腹发硬或一碰就躲/惨叫？",
        options: ["祈祷姿势（屁股翘）", "腹部硬胀", "触碰很痛或躲避", "尚可"],
      },
      gi_stool: {
        id: "gi_stool",
        test: () => /(黑便|里急后重|水样|未注意)/.test(blob),
        text: "大便情况？",
        options: ["黑便柏油样", "里急后重只出一点", "水样或稀", "尚未注意大便"],
      },
    };
  }

  /** 皮肤/掉毛：分布、瘙痒、皮损、环境与驱虫（时间线用通用 time） */
  function buildSkinDims(b) {
    const blob = String(b || "");
    return {
      skin_pattern: {
        id: "skin_pattern",
        test: () =>
          /(全身|对称|局部|耳|脸|四肢|肚子|背部|说不清)/.test(blob),
        text: "掉毛或皮疹主要在哪些部位？（选最接近的）",
        options: ["全身或对称性明显", "局部一团或几块", "耳脸四肢为主", "说不清哪里最明显"],
      },
      skin_itch: {
        id: "skin_itch",
        test: () => /(很痒|经常抓|偶尔抓|不太挠|不确定)/.test(blob),
        text: "瘙痒、抓挠或舔毛多吗？",
        options: ["很痒，经常抓挠或舔", "偶尔抓一下", "不太抓舔", "不确定"],
      },
      skin_lesion: {
        id: "skin_lesion",
        test: () => /(红疹|皮屑|结痂|破损|露皮|外观还行|还没细看)/.test(blob),
        text: "皮肤肉眼可见红疹、皮屑、结痂或破损露皮吗？",
        options: ["有红疹或皮屑", "有结痂、破损或露皮", "外观还行", "还没细看"],
      },
      skin_context: {
        id: "skin_context",
        test: () => /(驱虫|换粮|搬家|洗澡|香波|新环境|接触|用药|没有明显)/.test(blob),
        text: "最近有没有驱虫、换粮/搬家、洗澡香波换新，或接触其他动物？",
        options: ["有按时驱虫或刚换环境", "换粮或洗澡香波刚换", "接触新动物或用药", "没有明显变化"],
      },
    };
  }

  /** 口腔/牙齿：咀嚼、牙龈、流涎口臭、背景（时间用通用 time） */
  function buildDentalDims(b) {
    const blob = String(b || "");
    return {
      dental_chew: {
        id: "dental_chew",
        test: () => /(咀嚼困难|偏侧嚼|软的不吃硬|不吃硬|进食正常|还行)/.test(blob),
        text: "吃东西、啃咬时，TA 表现怎样？",
        options: ["咀嚼困难或偏侧嚼", "只吃软的不吃硬", "进食正常", "吃得很少"],
      },
      dental_gums: {
        id: "dental_gums",
        test: () => /(出血|红肿|口臭很重|还可以|没细看)/.test(blob),
        text: "牙龈或口腔你看到的状况？",
        options: ["牙龈红肿或出血", "口臭很重", "看起来还可以", "没敢细看"],
      },
      dental_drool: {
        id: "dental_drool",
        test: () => /(流涎|口水多|口臭明显|不明显)/.test(blob),
        text: "流口水或口臭明显吗？",
        options: ["口水多或流涎", "口臭很明显", "不太明显", "不太确定"],
      },
      dental_context: {
        id: "dental_context",
        test: () => /(驱虫|换粮|用药|洁牙|拔牙|外伤|异物|没有明显)/.test(blob),
        text: "近期有没有洁牙/拔牙、口腔外伤，或换粮用药、怀疑异物？",
        options: ["近期洁牙、拔牙或口腔外伤", "换粮或正在用药", "怀疑吞了异物", "没有明显变化"],
      },
    };
  }

  /** 骨折/跛行等：先问受伤机制与肢体，再问负重与局部，最后时间线（与 clinicalScore mobility 分支一致） */
  function buildMobilityDims(b) {
    const blob = String(b || "");
    return {
      mobility_cause: {
        id: "mobility_cause",
        test: () =>
          /(摔|跌落|跳楼|撞|压|碾|咬|打斗|车祸|扭伤|原因不明|不清楚|不知道|突然这样)/.test(blob),
        text: "大概是怎样受伤的，或你怎么注意到异常的？",
        options: ["高处跌落或摔伤", "被撞、被压或车祸碾到", "打斗、咬伤或原因不明", "说不清，突然就这样了"],
      },
      mobility_limb: {
        id: "mobility_limb",
        test: () =>
          /(左前腿|右前腿|左后腿|右后腿|前腿|后腿|左前|右前|左后|右后|单侧|两侧|一条腿|多条腿|多处|说不清哪条)/.test(blob),
        text: "更影响哪一侧或哪条腿？（选最接近的）",
        options: ["左前腿", "右前腿", "左后腿", "右后腿", "不止一条腿或多处", "单侧但说不清哪条"],
      },
      mobility_weight: {
        id: "mobility_weight",
        test: () =>
          /(完全不敢着地|拖行|不负重|不着地|跛行明显|能走但明显跛|偶尔瘸一下|不太确定)/.test(blob),
        text: "现在还能负重走路吗？",
        options: ["完全不敢着地或拖行", "能走但跛行很明显", "偶尔瘸一下不太明显", "不太确定"],
      },
      mobility_skin: {
        id: "mobility_skin",
        test: () =>
          /(有肿胀|有破皮|有出血|看起来还好|还没细看|局部还行)/.test(blob),
        text: "受伤部位有没有明显肿胀、破皮或出血？",
        options: ["有肿胀", "有破皮或出血", "看起来还好", "还没细看"],
      },
    };
  }

  function buildGeneralDims(b) {
    return {
      time: {
        id: "time",
        test: () =>
          /(今天|昨日|昨天|前天|小时|天|周|开始|多久|持续|几次|最近|昨晚|今早|早晨|第|一直|从小|大约|大概|两天|三天|一周|昨夜|刚才|刚刚|上午|下午|晚间)/.test(
            b
          ),
        text: "大概从什么时候开始的？持续多久或一天大概发作几次？",
        options: ["今天之内", "近两三天", "更久或记不清"],
      },
      severity: {
        id: "severity",
        test: () =>
          /(严重|轻|重|频繁|偶尔|越来越|加重|好转|差不多|滴血|大量|很少|一点点|非常|特别|两次|三次|多次|一次|减轻|恶化)/.test(b),
        text: "现在程度怎么样？和刚开始比是更重、差不多、还是有一点好转？",
        options: ["更重或更频繁", "差不多", "有好转"],
      },
      spirit: {
        id: "spirit",
        test: () => /(精神|食欲|吃喝|喝水|饮水|不吃|拒食|萎靡|活跃|嗜睡|胃口|能吃|饮水量|多饮|少饮)/.test(b),
        text: "精神、吃东西、喝水，跟平时比变化大吗？",
        options: ["和平时差不多", "明显变差", "有一点不一样"],
      },
      other_signs: {
        id: "other_signs",
        test: () =>
          /(吐|呕|拉|泻|便|尿|软|血|咳嗽|喘|喷嚏|皮肤|痒|瘸|跛|鼻|眼|耳|发烧|抖|走路|步态|舔|抓)/.test(b),
        text: "除了你现在说的，还有吐、拉稀、咳嗽喘、皮肤或走路不稳之类吗？",
        options: ["没有", "有，我补充一下", "不太确定"],
      },
      context: {
        id: "context",
        test: () =>
          /(疫苗|驱虫|新粮|换粮|搬家|出门|用药|吃药|医院|接触|别的猫|别的狗|绝育|年龄|体重|新成员|寄养)/.test(b),
        text: "最近有没有换粮、搬家、驱虫/疫苗、用药，或接触生病的动物？",
        options: ["没有明显变化", "有变化", "不太确定"],
      },
    };
  }

  function getNextGeneralMandatoryQuestion(ev, history) {
    if (!ev || !ev.threadActive || ev.immediateDanger) return null;
    const b = ev.blob || "";
    const routeSrc = routingTextForMandatory(history, b);
    const primary = inferPrimaryConcern(routeSrc);
    const order = GENERAL_DIM_ORDER[primary] || GENERAL_DIM_ORDER.general;
    let dimMap = buildGeneralDims(b);
    if (primary === "circulation") dimMap = Object.assign({}, buildCirculationDims(b), dimMap);
    else if (primary === "neuro") dimMap = Object.assign({}, buildNeuroDims(b), dimMap);
    else if (primary === "resp") dimMap = Object.assign({}, buildRespClinicalDims(b), dimMap);
    else if (primary === "gi") dimMap = Object.assign({}, buildGiClinicalDims(b), dimMap);
    else if (primary === "mobility") dimMap = Object.assign({}, buildMobilityDims(b), dimMap);
    else if (primary === "skin") dimMap = Object.assign({}, buildSkinDims(b), dimMap);
    else if (primary === "dental") dimMap = Object.assign({}, buildDentalDims(b), dimMap);
    else if (primary === "urinary") dimMap = Object.assign({}, buildUrinaryClinicalDims(b), dimMap);
    for (let i = 0; i < order.length; i++) {
      const dim = dimMap[order[i]];
      if (dim && !dim.test()) return dim;
    }
    return null;
  }

  global.CuraGeneralClinicalEvidence = {
    compute: computeGeneralClinicalEvidence,
    getNextMandatoryQuestion: getNextGeneralMandatoryQuestion,
    EMERGENCY_THRESHOLD: 5,
  };

  function speciesName(sp) {
    return sp === "dog" ? "犬" : "猫";
  }

  function petNickname(sp) {
    return sp === "dog" ? "狗狗" : "猫猫";
  }

  function findTopicByText(msg, knowledge, sp) {
    const dk = knowledge && knowledge.dailyKnowledge;
    if (!dk || !dk.modules) return null;
    for (const mod of dk.modules) {
      for (const t of mod.topics || []) {
        if (t.species && t.species.indexOf(sp) === -1) continue;
        const plain = String(t.title || "")
          .replace(/（[^）]*）/g, "")
          .replace(/\([^)]*\)/g, "")
          .trim();
        if (plain.length < 2) continue;
        const needles = [plain, ...plain.split(/[、，。]/).map((s) => s.trim()).filter((s) => s.length >= 2)];
        for (const n of needles) {
          if (n.length >= 2 && msg.indexOf(n) !== -1) return { module: mod, topic: t };
        }
      }
    }
    return null;
  }

  /** 与 healthBot.js 同步：强信号走急诊红线，不当作「仅模糊担心」 */
  function catUrinaryStrongSignal(msg) {
    const raw = String(msg || "");
    if (/(狗|犬)/.test(raw)) return false;
    const t = raw.replace(/\s/g, "");
    if (/(尿闭|尿不出|完全尿不出|一滴尿|尿道梗阻|尿血|血尿|粉红)/.test(t)) return true;
    if (
      /(一天|整天|整日|24小时|24h|两天|三天|多天|很久|超过\d{1,2}\s*小时|约12|12～24|12-24|昨夜|昨晚|今早)/.test(t) &&
      /(没尿|无尿|不尿|尿不出|无尿团|没见尿团|没有尿团|几乎没尿)/.test(t)
    ) {
      return true;
    }
    if (/(频繁|总|老|一直).{0,6}(蹲盆|猫砂).{0,8}(滴|少|没有|无|几乎)/.test(t)) return true;
    return false;
  }

  function matchEmergencyLine(msg, knowledge, sp, history, profile, quizLines) {
    const rows = (knowledge && knowledge.emergencyRedLines) || [];
    const shortOf = (row) => (row.action || "").slice(0, 220);
    const ev = computeCatUrinaryEvidence(history || [], profile || {}, quizLines || [], null);

    if (sp === "cat" && !/(狗|犬)/.test(ev.blob || msg)) {
      if (ev.threadActive) {
        if (!ev.allowEmergencyTag) {
          /* 循证未闭合：不因泌尿关键词触发 uro-cat 红线 */
        } else {
          const strong = catUrinaryStrongSignal(ev.blob);
          const uroHit = /(尿不|尿不出|尿闭|无尿|几滴|蹲盆|尿血)/.test(ev.blob) || strong;
          if (uroHit) {
            const compact = ev.blob.replace(/\s/g, "");
            const onlyVagueAnuria =
              !strong &&
              compact.length < 48 &&
              /没尿|不尿|无尿/.test(compact) &&
              !/(血|呕|吐|疼|痛|盆|滴|频|红|粉红)/.test(ev.blob);
            if (!onlyVagueAnuria) {
              const u = rows.find((r) => r.id === "uro-cat");
              if (u) return { row: u, short: shortOf(u) };
            }
          }
        }
      }
    }
    if (sp === "dog" && /(肚子胀|腹胀|鼓|干呕|呕不出|胃扭转|GDV)/i.test(msg)) {
      const g = rows.find((r) => r.id === "gdv-dog");
      if (g) return { row: g, short: shortOf(g) };
    }
    if (/(喘|呼吸).*(费力|困难|急促)|张口喘|发绀|粘膜.*紫/.test(msg)) {
      const r = rows.find((x) => x.id === "resp-distress");
      if (r) return { row: r, short: shortOf(r) };
    }
    if (/(抽搐|抽经|癫痫|昏迷|瘫痪|站不起来)/.test(msg)) {
      const r = rows.find((x) => x.id === "neuro-acute");
      if (r) return { row: r, short: shortOf(r) };
    }
    if (sp === "cat" && /(子宫蓄脓|外阴.*脓|流脓性分泌物|未绝育母猫.*(腹大|发热|吐))/.test(msg)) {
      const r = rows.find((x) => x.id === "pyometra-cat");
      if (r) return { row: r, short: shortOf(r) };
    }
    if (/(大出血|止不住|休克|牙龈白|脚垫凉)/.test(msg)) {
      const r = rows.find((x) => x.id === "hemorrhage-shock");
      if (r) return { row: r, short: shortOf(r) };
    }
    if (/(中毒|老鼠药|防冻液|巧克力|葡萄|木糖醇)/.test(msg)) {
      const r = rows.find((x) => x.id === "toxin-unknown");
      if (r) return { row: r, short: shortOf(r) };
    }
    return null;
  }

  /** 是否已包含时间线索（避免重复追问） */
  function hasTimeHint(msg) {
    return /(今天|昨日|昨天|前天|天前|小时|刚刚|一周|多日|三天|两天|一直|从小|慢性)/.test(msg);
  }

  /**
   * 在症状描述过程中插入选择题，便于分层建议（本地启发式）。
   * @param {string[]} answeredIds 已在本次会话中答过的追问 id（由 healthBot 维护）
   */
  function maybeFollowUpQuiz(msg, sp, severityPreempt, answeredIds) {
    const asked = answeredIds || [];
    if (severityPreempt === "emergency") return null;

    const nick = petNickname(sp);

    if (
      sp === "cat" &&
      asked.indexOf("uro_env") === -1 &&
      asked.indexOf("cat_uro") !== -1 &&
      /（补充）关于排尿/.test(msg)
    ) {
      return {
        id: "uro_env",
        prompt: "先排除「没找到尿团」的观察误差：是否已检查过常用猫砂盆及猫猫常去区域？",
        options: [
          { value: "checked_all", label: "都看过，确实没有尿团" },
          { value: "maybe_hidden", label: "可能在别处（床底、地毯等），不确定" },
          { value: "not_checked", label: "还没全面检查" },
        ],
      };
    }

    if (
      sp === "cat" &&
      asked.indexOf("uro_time") === -1 &&
      asked.indexOf("uro_env") !== -1 &&
      /（补充）先排除/.test(msg)
    ) {
      return {
        id: "uro_time",
        prompt: "距离上次看到比较正常的排尿或成形尿团，大约多久？",
        options: [
          { value: "lt12", label: "12 小时内" },
          { value: "12_24", label: "约 12～24 小时" },
          { value: "gt24", label: "超过 24 小时或几乎没看到" },
          { value: "unk", label: "说不清" },
        ],
      };
    }

    if (
      sp === "cat" &&
      asked.indexOf("cat_uro") === -1 &&
      /(没尿|无尿|不尿|尿不出|尿团|排尿|尿频|尿血)/.test(msg)
    ) {
      return {
        id: "cat_uro",
        prompt: "关于排尿，需要先确认现象：目前更接近哪一种？",
        options: [
          { value: "strain", label: "总去猫砂盆但只能滴尿或几乎挤不出" },
          { value: "anuria", label: "很久没看到排尿或几乎没有尿团" },
          { value: "blood", label: "尿量少、颜色深或见粉红/血色" },
          { value: "unclear", label: "还不确定，主要心里着急" },
        ],
      };
    }

    if (
      sp === "dog" &&
      asked.indexOf("dog_uro") === -1 &&
      /(没尿|无尿|不尿|尿不出|排尿|尿频|尿血|血尿|费力)/.test(msg)
    ) {
      return {
        id: "dog_uro",
        prompt: "关于排尿，需要先确认现象：目前更接近哪一种？",
        options: [
          { value: "strain", label: "频繁做排尿姿势但只能滴尿或几乎挤不出" },
          { value: "anuria", label: "很久没看到排尿" },
          { value: "blood", label: "尿量少、颜色深或带血" },
          { value: "unclear", label: "还不确定，主要心里担心" },
        ],
      };
    }

    if (
      asked.indexOf("onset") === -1 &&
      !hasTimeHint(msg) &&
      /吐|呕|腹泻|拉稀|软便|尿频|尿血|抽搐|瘸|跛|痒|抓/.test(msg)
    ) {
      return {
        id: "onset",
        prompt: `${nick}出现这种情况大概从什么时候开始的？`,
        options: [
          { value: "today", label: "今天" },
          { value: "1-2d", label: "最近 1～2 天" },
          { value: "3d+", label: "3 天以上" },
          { value: "unknown", label: "说不清楚" },
        ],
      };
    }

    if (
      asked.indexOf("spirit") === -1 &&
      /吐|呕|腹泻|拉稀|不吃|食欲|精神/.test(msg) &&
      !/(精神好|食欲好|吃喝正常)/.test(msg)
    ) {
      return {
        id: "spirit",
        prompt: `目前${nick}的精神和食欲怎么样？`,
        options: [
          { value: "poor", label: "精神差或不吃/吃得很少" },
          { value: "ok", label: "尚可，能吃喝" },
          { value: "normal", label: "基本正常" },
          { value: "unknown", label: "不确定" },
        ],
      };
    }

    // 兜底：正则未命中但消息涉及健康/症状，生成通用追问
    if (looksLikeHealthConcern(msg, asked)) {
      return buildGenericFollowUp(nick, asked);
    }

    return null;
  }

  /** 宽松检测消息是否涉及健康/症状（排除纯打招呼/感谢） */
  function looksLikeHealthConcern(msg, asked) {
    const t = (msg || "").trim();
    if (/^(你好|谢谢|嗯|好的|ok|谢|感谢|棒|明白|了解|收到|在吗|hi|hello)/i.test(t)) return false;
    if (t.length < 4) return false;
    // 已答过 onset+spirit 就不再弹通用追问
    if (asked && asked.indexOf("onset") !== -1 && asked.indexOf("spirit") !== -1) return false;
    return /(不吃|少吃|拒食|喝水多|喝水少|呼吸|咳|喘|打喷嚏|流涕|流鼻|眼睛|鼻子|耳朵|皮肤|掉毛|脱毛|红肿|肿|包|疙瘩|发烧|发热|体温|发抖|抖|无力|站不稳|不走|走不动|异常|不对劲|奇怪|担心|着急|怎么办|生病|不舒服|看医生|看兽医|症状|便秘|拉血|黑便|便血|口臭|流口水|打蔫|没精神|蔫了|趴着不动|不想动|挠|蹭|舔|结痂|毛粗|消瘦|体重|变瘦|变胖|喝水|多饮多尿)/.test(t);
  }

  /** 生成通用追问选择题，根据已回答问题动态选择 */
  function buildGenericFollowUp(nick, asked) {
    // 优先追问持续时间（如果还没问过）
    if (asked.indexOf("onset") === -1 && asked.indexOf("generic_onset") === -1) {
      return {
        id: "generic_onset",
        prompt: `${nick}出现这种情况大概多久了？`,
        options: [
          { value: "today", label: "今天刚发现" },
          { value: "1-2d", label: "1～2 天" },
          { value: "3d+", label: "3 天以上" },
          { value: "unknown", label: "不太确定" },
        ],
      };
    }
    // 然后追问精神食欲
    if (asked.indexOf("spirit") === -1 && asked.indexOf("generic_spirit") === -1) {
      return {
        id: "generic_spirit",
        prompt: `${nick}的精神和食欲目前怎么样？`,
        options: [
          { value: "poor", label: "精神差或不吃" },
          { value: "ok", label: "还行，能吃喝" },
          { value: "normal", label: "基本正常" },
          { value: "unknown", label: "不确定" },
        ],
      };
    }
    // 最后问有无其他伴随症状
    if (asked.indexOf("generic_other") === -1) {
      return {
        id: "generic_other",
        prompt: `除了这个，${nick}还有没有其他不对劲的地方？`,
        options: [
          { value: "vomit", label: "有呕吐或腹泻" },
          { value: "behavior", label: "行为异常（躲藏/嗜睡等）" },
          { value: "none", label: "暂时没发现其他问题" },
          { value: "other", label: "有，我补充说明" },
        ],
      };
    }
    return null;
  }

  /** 仅模糊排尿相关、缺少行为/时间细节时，走启发式问诊而非直接套急诊或知识条目 */
  function needsCatUrinaryHeuristic(msg, sp, history, profile, quizLines) {
    if (sp !== "cat" && sp !== "dog") return false;
    const ev = computeCatUrinaryEvidence(history || [], profile || {}, quizLines || [], null);
    const blob = ev.blob || msg;
    if (sp === "cat" && /(狗|犬)/.test(blob)) return false;
    if (sp === "dog" && /(猫|喵)/.test(blob)) return false;
    if (ev.threadActive && ev.allowEmergencyTag) return false;
    if (sp === "cat" && catUrinaryStrongSignal(blob) && ev.allowEmergencyTag) return false;
    if (!/(没尿|无尿|不尿|尿不出|没排尿|没有尿|尿团|排尿|一天|整天|小时|尿尿|尿血|血尿)/.test(blob)) return false;
    if (sp === "cat" && /(滴尿|频尿|尿血|粉红|呕|吐|精神差|不吃|疼|痛|尿闭|绝育|公猫|母猫|腹部|胀|血尿|蹲盆|舔尿道)/.test(blob)) {
      return false;
    }
    if (sp === "dog" && /(滴尿|频尿|粉红|呕|吐|精神差|不吃|疼|痛|尿闭|腹部|胀|蹲|抬腿|做排尿姿势|舔生殖器)/.test(blob)) {
      return false;
    }
    return true;
  }

  /**
   * 猫排尿追问链（cat_uro → uro_env → uro_time）完成后，根据合并消息做加权分层（非诊断）。
   */
  function synthesizeAfterCatUrinaryChain(msg, nick, profile) {
    const hasStrain = /滴尿|挤不出|总去猫砂盆/.test(msg);
    const hasAnuria = /很久没看到排尿|几乎没有尿团/.test(msg);
    const hasBlood = /粉红|血色|尿量少|颜色深/.test(msg);
    const unclearWorry = /还不确定|心里着急/.test(msg);

    const envCheckedAll = /都看过，确实没有尿团/.test(msg);
    const envHidden = /可能在别处|床底|地毯/.test(msg);
    const envNotChecked = /还没全面检查/.test(msg);

    const timeGt24 = /超过 24 小时|几乎没看到/.test(msg);
    const time12_24 = /12～24|约 12/.test(msg);
    const timeLt12 = /12 小时内/.test(msg);
    const timeUnk = /说不清/.test(msg);

    let severity = "unclear";
    let suggestNav = null;

    const lines = [];

    lines.push("### 现状评估");
    if (envNotChecked || envHidden) {
      lines.push(
        `你目前**还没完全排除「尿在隐蔽处」或观察误差**。在未确认砂盆与常去区域前，不宜把线上回复当作「已经尿闭」的结论。`
      );
      lines.push("");
      lines.push("### 建议下一步（黄）");
      lines.push(
        `- 先**全面检查**猫砂盆、垫料、床底、地毯等；必要时短期单盆单猫观察尿团大小。\n` +
          `- 若随后出现**频繁蹲盆却几乎无尿、痛苦叫喊、呕吐、精神极差或腹部胀硬**，请**不要等待**，联系急诊动物医院。`
      );
      return {
        text: lines.join("\n"),
        severity: "unclear",
        suggestNav: null,
      };
    }

    lines.push(
      "在猫科急诊判断里，**「多久没看到尿团」+「排尿姿势/是否痛苦」+「精神食欲」**比单一关键词更重要；以下仅作**家庭层面的风险分层**，不能替代兽医触诊与检查。"
    );

    lines.push("");
    lines.push("### 风险说明（非诊断）");
    if (timeGt24 && envCheckedAll && (hasStrain || hasAnuria)) {
      lines.push(
        "若已**较长时间**未见到像样尿团，且更接近「蹲盆却几乎无尿/仅滴尿」，在猫（尤其既往有泌尿问题史时）需要**优先排除**严重下泌尿道梗阻等急症可能——这类情况可能快速影响肾脏与全身状态。"
      );
      severity = "emergency";
      suggestNav = "emergency";
    } else if (hasBlood) {
      lines.push("带血或颜色异常的尿，通常需要**尽快门诊**做尿液与影像相关评估，不宜长期线上观察。");
      severity = "moderate";
    } else if (time12_24 && (hasStrain || hasAnuria)) {
      lines.push(
        "在约半天到一天的时间窗内，若仍表现为「用力排尿却几乎没有尿团」，**不建议继续纯家庭等待**；至少应在**当日**联系兽医评估。"
      );
      severity = "moderate";
    } else if (timeLt12 && (hasStrain || unclearWorry)) {
      lines.push(
        "时间尚短时，有时与应激、饮水量或砂盆偏好有关；但若**蹲盆频繁仍无尿团**或出现呕吐/萎靡，风险会快速上升。"
      );
      severity = "unclear";
    } else if (timeUnk || unclearWorry) {
      lines.push("信息仍偏少时，线上无法区分「暂时少尿」与需要急诊的情况，建议以**线下检查**为准。");
      severity = "unclear";
    } else {
      lines.push(
        "请把本次勾选的现象与时间表**原样带给兽医**，并补充精神、食欲、是否呕吐；是否急诊由现场评估更稳妥。"
      );
      severity = "moderate";
    }

    lines.push("");
    lines.push("### 行动建议");
    if (severity === "emergency") {
      lines.push(
        `- **红**：建议尽快联系**能接诊泌尿急诊**的动物医院，路上减少折腾；不要强行灌水、不要自行用药。\n` +
          `- 若 ${nick} **完全尿不出且呕吐或昏迷样**，以就近急诊为先。`
      );
    } else if (severity === "moderate") {
      lines.push(
        `- **黄**：建议**今日内**安排兽医门诊，带上本次对话要点；观察是否蹲盆更频、是否舔尿道口。\n` +
          `- 若几小时内仍完全无尿或更萎靡，请按急诊处理。`
      );
    } else {
      lines.push(
        `- **不明确**：可先完成环境排查与近距离观察；一旦出现**无尿团 + 呕吐/腹部胀硬/明显疼痛**，请转急诊。\n` +
          `- 仍担心时，**宁可提前门诊**澄清，也比线上猜诊断更安全。`
      );
    }

    const evSyn = computeCatUrinaryEvidence([{ role: "user", content: msg }], profile || {}, [], null);
    if (severity === "emergency" && !evSyn.allowEmergencyTag) {
      severity = "moderate";
      suggestNav = null;
    }

    return { text: lines.join("\n"), severity, suggestNav };
  }

  /**
   * 调用 /api/chat-local 轻量 LLM 端点；失败返回 null，调用方 fallback 到模板。
   */
  async function fetchLocalLlm(message, species, style, context) {
    try {
      const r = await fetch("/api/chat-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, species, context, style }),
      });
      const d = await r.json();
      return (d && d.reply) || null;
    } catch (_) {
      return null;
    }
  }

  async function reply(payload) {
    const { message, species, knowledge, answeredQuizIds, history, chatProfile, quizSupplementLines } = payload;
    const sp = species === "dog" ? "dog" : "cat";
    const msg = (message || "").trim();
    const nick = petNickname(sp);

    if (!msg) {
      const llm = await fetchLocalLlm("（用户发送了空消息）", sp, "greeting");
      return {
        text: llm || `可以说说${speciesName(sp)}的食欲、精神、呕吐、大小便里你最担心的一点；紧急情况请直接去医院。`,
        source: llm ? "local-llm" : "local",
        severity: "unclear",
      };
    }

    if (/^(谢谢|感谢|好的|明白|懂了|ok|okay|thx)/i.test(msg)) {
      const llm = await fetchLocalLlm(msg, sp, "acknowledgment");
      return {
        text: llm || "不客气。若症状加重或心里不踏实，建议尽快联系兽医。",
        source: llm ? "local-llm" : "local",
        severity: "normal",
      };
    }

    if (/^(你好|您好|哈喽|嗨|hi|hello|在吗)/i.test(msg)) {
      const llm = await fetchLocalLlm(msg, sp, "greeting");
      return {
        text: llm || `你好，我是 CuraBot。说说毛孩子怎么了，我来帮你梳理（科普参考，不替代兽医诊断）。`,
        source: llm ? "local-llm" : "local",
        severity: "normal",
      };
    }

    if (/(急症|急诊|红线|立刻去医院|别等)/.test(msg)) {
      return {
        text:
          "急症线索包括：喘得厉害/粘膜发紫发白、猫少尿无尿、狗腹胀干呕、大出血或休克、抽搐或意识不清、可疑中毒等。首页「这些情况要抓紧去医院」有展开说明。**很危险时请直接出发急诊。**",
        source: "local",
        severity: "emergency",
        suggestNav: "emergency",
      };
    }

    if (/(分诊|采集|清单|问卷)/.test(msg)) {
      return {
        text: "首页进入「从这里开始」可使用标准化采集与按症状分诊流程，把信息整理给兽医看。",
        source: "local",
        severity: "unclear",
        suggestNav: "triageMenu",
      };
    }

    if (
      needsCatUrinaryHeuristic(msg, sp, history, chatProfile, quizSupplementLines) &&
      answeredQuizIds.indexOf("cat_uro") === -1
    ) {
      const quiz = maybeFollowUpQuiz(msg, sp, null, answeredQuizIds);
      return {
        text:
          "### 先说明（科普）\n" +
          "在猫科里，「长时间没看到排尿」需要结合**猫砂盆观察、排尿姿势、伴随症状和时间线**一起看；**单凭一句担心不能判断**是否已经发生严重梗阻，也不能在线替代兽医触诊与化验。\n\n" +
          "### 请先选一项最接近的情况\n" +
          "若已**完全尿不出**且伴有**呕吐、精神极差或腹部胀硬**，请**不要等待选项**，尽快联系急诊动物医院。",
        source: "local",
        severity: "unclear",
        followUpQuiz: quiz,
      };
    }

    if (sp === "cat" && answeredQuizIds.indexOf("uro_time") !== -1) {
      if (answeredQuizIds.indexOf("spirit_post_uro") !== -1 && /（补充）.*便于你把信息带给兽医/.test(msg)) {
        return {
          text:
            "已记录精神与食欲情况。请把**前面勾选的现象与时间线**一并带给兽医现场评估。\n\n" +
            "若出现**完全尿不出 + 呕吐/昏迷样、或腹部明显胀硬**，请尽快改走急诊，不要等待线上回复。",
          source: "local",
          severity: "unclear",
        };
      }
      if (answeredQuizIds.indexOf("spirit_post_uro") === -1 && /距离上次看到比较正常的排尿/.test(msg)) {
        const syn = synthesizeAfterCatUrinaryChain(msg, nick, chatProfile);
        const spiritQuiz = {
          id: "spirit_post_uro",
          prompt: `目前${nick}的精神和食欲怎么样？（便于你把信息带给兽医）`,
          options: [
            { value: "poor", label: "精神差、不吃或吃得很少" },
            { value: "ok", label: "尚可，能吃喝" },
            { value: "vomit", label: "有呕吐或明显萎靡" },
            { value: "unknown", label: "说不清" },
          ],
        };
        return {
          text: syn.text,
          source: "local",
          severity: syn.severity,
          suggestNav: syn.suggestNav || undefined,
          followUpQuiz: spiritQuiz,
        };
      }
    }

    const em = matchEmergencyLine(msg, knowledge, sp, history, chatProfile, quizSupplementLines);
    if (em && em.row) {
      return {
        text:
          `你描述的情况**可能属于需要尽快就医甚至急诊的范畴**（与「${em.row.title}」相关）。\n\n` +
          `${em.short}${em.short.length >= 220 ? "…" : ""}\n\n` +
          `我无法在线确认是否急症，**请结合 ${nick} 的实时状态**；若符合任一条，建议尽快联系或前往动物医院。`,
        source: "local",
        severity: "emergency",
        suggestNav: "emergency",
      };
    }

    const hit = findTopicByText(msg, knowledge, sp);
    if (hit && hit.topic) {
      const t = hit.topic;
      const sci = (t.science || "").slice(0, 280);
      const quiz = maybeFollowUpQuiz(msg, sp, "moderate", answeredQuizIds);
      const llm = await fetchLocalLlm(msg, sp, "topic_explain", {
        title: t.title,
        science: sci,
        vetWhen: (t.vetWhen || "").slice(0, 200),
      });
      return {
        text: llm ||
          `从日常知识库里，与你描述较接近的条目是「${t.title}」。\n\n` +
          `**科学知识（节选）**：${sci}${(t.science || "").length > 280 ? "…" : ""}\n\n` +
          `**何时看兽医**：${(t.vetWhen || "").slice(0, 200)}${(t.vetWhen || "").length > 200 ? "…" : ""}\n\n` +
          `可点击下方按钮打开完整条目，或在首页日常知识里点同名卡片。`,
        source: llm ? "local-llm" : "local",
        severity: "moderate",
        suggestTopicId: t.id,
        followUpQuiz: quiz,
      };
    }

    const quizDefault = maybeFollowUpQuiz(msg, sp, null, answeredQuizIds);
    const llmFallback = await fetchLocalLlm(msg, sp, "followup");

    return {
      text: llmFallback ||
        `信息还不太够，我需要了解更多才能给你有针对性的建议。\n\n可以补充一下：品种年龄、具体症状、持续多久、精神食欲怎么样。`,
      source: llmFallback ? "local-llm" : "local",
      severity: "unclear",
      followUpQuiz: quizDefault,
    };
  }

  global.CuraHealthBotLocal = { reply, petNickname, speciesName };
})(typeof window !== "undefined" ? window : globalThis);
