import assert from "node:assert/strict";
import test from "node:test";
import { cleanPreviewText, displayThreadTitle, stripPromptNoise } from "../src/thread-display.mjs";
import {
  buildStructuredThreadTitle,
  cleanPromptForTitle,
  compactLegacyBracketTitle,
  computeTopicSimilarity,
  extractTopicTokens,
  extractUserPromptsFromTurns,
  isContinuationOrControlPrompt,
  isLowQualityTitle,
  isSubstantiveTaskPrompt,
  resolveAdaptiveThreadTitle,
  summarizeTaskTitle,
  TITLE_SCHEMA_VERSION,
} from "../src/thread-title.mjs";

test("summarizeTaskTitle cleans noise, boilerplate, fences, examples, and extracts concise core topic", () => {
  assert.equal(
    summarizeTaskTitle("<USER_REQUEST>\n优化 Agent Control 的会话标题生成与更新逻辑：当会话后续实际执行的任务与初始标题（例如“Claude 项目进度查询”）发生偏离时，自动重新总结并更新为更贴合当前内容的标题。\n</USER_REQUEST>"),
    "优化 Agent Control 的会话标题生成与更新逻辑",
  );

  assert.equal(
    summarizeTaskTitle("请你帮我看一下 Claude 项目的当前进度和阻塞情况，比如看看哪些分支还没合并。"),
    "Claude 项目的当前进度和阻塞情况",
  );

  assert.equal(
    summarizeTaskTitle("/goal 修复语音通话断线重连失败的问题，要求支持自动退避与提示\n```js\nthrow new Error('boom')\n```"),
    "修复语音通话断线重连失败的问题",
  );

  assert.equal(
    summarizeTaskTitle("帮我看看这个问题：\n排查 `src/provider-hub.mjs` 并发队列阻塞"),
    "排查 src/provider-hub.mjs 并发队列阻塞",
  );

  assert.equal(
    summarizeTaskTitle("```bash\nnpm test fail\n```", {
      assistantText: "好的，我已经定位并修复了 server.mjs 端口监听关闭泄漏问题。",
    }),
    "定位并修复了 server.mjs 端口监听关闭泄漏问题",
  );

  assert.equal(
    summarizeTaskTitle("# 任务：只发视频号《城市微纪录》（用户 2026-11-16 已授权发布）"),
    "只发视频号《城市微纪录》",
  );

  assert.equal(
    summarizeTaskTitle("先完整读取《demo-studio/assets/hero-prompt.md》，严格按提示词生成图片并保存为《demo-studio/assets/hero-card.png》。", { maxLength: 60 }),
    "严格按提示词生成图片并保存为《demo-studio/assets/hero-card.png》",
  );

  const cleaned = cleanPromptForTitle("查看 [设计文档](https://example.com/a/b) 以及 https://example.com/raw 修复登录超时");
  assert.equal(cleaned, "查看 设计文档 以及 修复登录超时");
});

test("isContinuationOrControlPrompt filters confirmations, goal continuations, test/commit commands, and deictic follow-ups", () => {
  const ignoredInputs = [
    "",
    "   ",
    "继续",
    "继续检查",
    "好的",
    "OK",
    "yes",
    "跑一下测试",
    "运行测试",
    "提交代码",
    "git push",
    "按方案 A 执行",
    "选 A",
    "/goal",
    "/compact",
    "[Goal 自动推进 · 第 2/20 轮核查]\n请核对当前任务的所有要求...",
    "这里还有问题\n<!-- GOAL_COMPLETE -->",
    "为什么还是不行？",
    "把这个也改了",
    "修一下刚才那个报错",
    "好了吗",
    "改好了吗",
    "要",
  ];
  for (const input of ignoredInputs) {
    assert.equal(isContinuationOrControlPrompt(input), true, `Expected continuation/control: ${JSON.stringify(input)}`);
  }

  const substantiveInputs = [
    "优化 Agent Control 的会话标题生成与更新逻辑",
    "修复登录接口超时与重试机制",
    "/goal 实现看板实时搜索过滤功能",
    "Add webhook signature verification for GitHub events",
  ];
  for (const input of substantiveInputs) {
    assert.equal(isContinuationOrControlPrompt(input), false, `Expected substantive: ${JSON.stringify(input)}`);
    assert.equal(isSubstantiveTaskPrompt(input), true, `Expected substantive task: ${JSON.stringify(input)}`);
  }

  assert.equal(isSubstantiveTaskPrompt("帮我检查一下问题"), false);
  assert.equal(isLowQualityTitle("新会话"), true);
  assert.equal(isLowQualityTitle("帮我看一下这个"), true);
  assert.equal(isLowQualityTitle("Claude 项目进度查询"), false);
});

test("buildStructuredThreadTitle omits prefix inside matching repo and uses concise dot prefix for sub-projects", () => {
  // 1. Same repo (agent-control) omits redundant project prefix and drops meta category labels.
  assert.equal(
    buildStructuredThreadTitle({
      seedText: "优化 Agent Control 的会话标题生成与更新逻辑",
      cwd: "/workspace/demo/agent-control",
    }).title,
    "优化会话标题生成与更新逻辑",
  );
  assert.equal(
    buildStructuredThreadTitle({
      seedText: "语音对话功能优化失效反馈",
      cwd: "/workspace/demo/agent-control",
    }).title,
    "语音对话功能优化失效反馈",
  );
  assert.equal(
    buildStructuredThreadTitle({
      seedText: "Agent 运行卡住排查",
      cwd: "/workspace/demo/agent-control",
    }).title,
    "Agent 运行卡住排查",
  );
  assert.equal(
    buildStructuredThreadTitle({
      seedText: "优化下codex输入的与预览",
      cwd: "/workspace/demo/agent-control",
    }).title,
    "优化 codex输入的与预览",
  );
  assert.equal(
    buildStructuredThreadTitle({
      seedText: "File Does Not Exist Error",
      cwd: "/workspace/demo/agent-control",
    }).title,
    "文件不存在报错处理",
  );
  assert.equal(
    buildStructuredThreadTitle({
      seedText: "Gemini Ultra Cloud Usage Capabilities",
      cwd: "/workspace/demo/agent-control",
    }).title,
    "Gemini云端用量能力",
  );

  // 2. Custom rules support sub-project "目标·动作" prefix without hardcoding private names.
  const customRules = {
    seriesTargets: [
      { target: "星火计划", domainKey: "series:spark", pattern: "星火计划", flags: "i", stripPattern: "《?星火计划》?", stripFlags: "g" },
      { target: "科普动效", domainKey: "series:science", pattern: "科普动效|科普动画|地球之旅", flags: "i", stripPattern: "(?:科普动效|科普动画)", stripFlags: "g" },
    ],
    appTargets: [
      { target: "DemoApp", domainKey: "app:demo-app", pattern: "demo-app|示例应用", flags: "i", stripPattern: "(?:demo-app|示例应用)", stripFlags: "gi" },
      { target: "翻译扩展", domainKey: "app:translator", pattern: "demo-translator|翻译扩展", flags: "i", stripPattern: "(?:demo-translator|翻译扩展)", stripFlags: "gi" },
    ],
    cwdRules: [
      { target: "DemoApp", domainKey: "app:demo-app", pattern: "(?:^|/)demo-app(?:/|$)", flags: "i", stripPattern: "(?:demo-app|示例应用)", stripFlags: "gi" },
      { target: "工单中心", domainKey: "app:tickets", pattern: "/tickets-workspace(?:/|$)", flags: "i", stripPattern: "工单中心", stripFlags: "g" },
    ],
    genericFallbackTargets: ["工单中心"],
  };

  assert.equal(
    buildStructuredThreadTitle({
      seedText: "使用 image-gen 技能，为《星火计划》ep01 顺序生成全三幕竖屏分镜图。",
      cwd: "/workspace/demo/creative-studio",
      customRules,
    }).title,
    "星火计划·ep01全三幕竖屏分镜",
  );
  assert.equal(
    buildStructuredThreadTitle({
      seedText: "先完整读取《星火计划/assets/hero-角色卡提示词.md》，严格按提示词生成图片并保存为《星火计划/assets/hero-角色卡.png》。",
      cwd: "/workspace/demo/creative-studio",
      customRules,
    }).title,
    "星火计划·生成hero角色卡",
  );
  assert.equal(
    buildStructuredThreadTitle({
      seedText: "# 任务：只发视频号《地球之旅》（用户 2026-11-16 已授权发布）",
      cwd: "/workspace/demo/creative-studio",
      customRules,
    }).title,
    "科普动效·只发视频号《地球之旅》",
  );
  assert.equal(
    buildStructuredThreadTitle({
      seedText: "优化示例应用卡片视觉",
      cwd: "/workspace/demo/creative-studio",
      customRules,
    }).title,
    "DemoApp·优化卡片视觉",
  );

  // 3. Home dir cross-repo detection & legacy bracket compaction.
  assert.equal(
    buildStructuredThreadTitle({
      seedText: "请使用浏览器端到端实测翻译扩展程序：/workspace/demo/demo-translator/extension",
      cwd: "/Users/demo",
      customRules,
    }).title,
    "翻译扩展·使用浏览器端到端实测程序",
  );
  assert.equal(
    compactLegacyBracketTitle("【Alpha｜转客户】提交返回504", { cwd: "/workspace/demo/tickets-workspace", customRules })?.title,
    "Alpha·转客户提交返回504",
  );
  assert.equal(
    compactLegacyBracketTitle("【Beta｜文件附件】历史文件需解冻", { cwd: "/workspace/demo/tickets-workspace", customRules })?.title,
    "Beta·历史文件需解冻",
  );
  assert.equal(
    compactLegacyBracketTitle("【AgentCtrl｜修复】语音对话功能优化失效反馈", { cwd: "/workspace/demo/agent-control" })?.title,
    "语音对话功能优化失效反馈",
  );
});

test("resolveAdaptiveThreadTitle heals polluted history, protects concise Chinese titles, and locks against follow-up jitter", () => {
  // 1. Concise Chinese upstreamTitle is preserved instead of vague firstUserText or trailing follow-up.
  const memMonitor = resolveAdaptiveThreadTitle({
    cwd: "/workspace/demo/sys-monitor",
    upstreamTitle: "整机状态看板UI设计",
    firstUserText: "看下这个项目。 整机tab参考这个页面，精美展现这些我想要的信息。",
    lastUserText: "要",
    hasFollowUpTurns: true,
    autoTitle: "【系统监控｜任务】这个项目。 整机tab参考这个…",
    titleSchemaVersion: 2,
  });
  assert.equal(memMonitor.title, "整机状态看板UI设计");
  assert.equal(memMonitor.titleLocked, true);
  assert.equal(memMonitor.schemaVersion, TITLE_SCHEMA_VERSION);

  // 2. When firstUserText is empty on summary listThreads, lastUserText follow-up must NEVER overwrite good upstreamTitle.
  const claudeListHeal = resolveAdaptiveThreadTitle({
    cwd: "/workspace/demo/studio",
    upstreamTitle: "Claude 项目进度查询",
    firstUserText: "",
    lastUserText: "每天的价格大概降低多少",
    hasFollowUpTurns: true,
    autoTitle: "【Claude｜任务】每天的价格大概降低多少",
    titleSchemaVersion: 2,
  });
  assert.equal(claudeListHeal.title, "Claude·项目进度查询");
  assert.equal(claudeListHeal.titleLocked, true);

  // 3. Deictic first turn + English placeholder upstream resolves to the real substantive prompt.
  const pcWrap = resolveAdaptiveThreadTitle({
    cwd: "/workspace/demo/agent-control",
    upstreamTitle: "Bug Report And Screenshot",
    userPrompts: [
      "小助理 bug 等下发你图",
      "agent control 能不能弄一个pc的简单包装，我发现电脑用也挺方便的。",
    ],
    firstUserText: "小助理 bug 等下发你图",
    lastUserText: "agent control 能不能弄一个pc的简单包装，我发现电脑用也挺方便的。",
    hasFollowUpTurns: true,
    autoTitle: "【AgentCtrl｜任务】能不能弄一个pc的简单包装，我…",
    titleSchemaVersion: 2,
  });
  assert.equal(pcWrap.title, "弄一个pc的简单包装");
  assert.equal(pcWrap.titleLocked, true);

  // 4. Fuzzy short question stays unlocked until assistant reply/paths arrive, then locks.
  const draft = resolveAdaptiveThreadTitle({
    cwd: "/workspace/demo/studio",
    firstUserText: "看看示例应用是不是有bug",
    lastUserText: "看看示例应用是不是有bug",
  });
  assert.equal(draft.title, "示例应用是不是有bug");
  assert.equal(draft.titleLocked, false);

  const finalized = resolveAdaptiveThreadTitle({
    cwd: "/workspace/demo/studio",
    autoTitle: draft.autoTitleToSave,
    autoTitleSourceSig: draft.sourceSig,
    titleLocked: false,
    titleSchemaVersion: TITLE_SCHEMA_VERSION,
    firstUserText: "看看示例应用是不是有bug",
    lastUserText: "看看示例应用是不是有bug",
    assistantText: "已定位 demo-app 布局计算少了一次取模，修复并补单测。",
    touchedPaths: ["/workspace/demo/demo-app/src/layout.ts"],
  });
  assert.equal(finalized.titleLocked, true);

  // 5. Locked title never jitters on follow-ups, complaints, or side-questions about another plugin.
  const lockedSession = resolveAdaptiveThreadTitle({
    cwd: "/workspace/demo/agent-control",
    upstreamTitle: "语音对话功能优化失效反馈",
    autoTitle: "语音对话功能优化失效反馈",
    autoTitleSourceSig: "语音对话功能优化失效反馈",
    titleLocked: true,
    titleDomainKey: "app:agent-control",
    titleSchemaVersion: TITLE_SCHEMA_VERSION,
    userPrompts: [
      "语音对话功能这三次优化都完全不能用了：首先是识别异常",
      "改好了吗。另外claude 桌面app 有个账号明明可用的",
      "中文然后都按照你的建议来，另外升级 agent control 后，其他插件也需要一并改动吗",
    ],
    firstUserText: "语音对话功能这三次优化都完全不能用了：首先是识别异常",
    lastUserText: "中文然后都按照你的建议来，另外升级 agent control 后，其他插件也需要一并改动吗",
    hasFollowUpTurns: true,
  });
  assert.equal(lockedSession.title, "语音对话功能优化失效反馈");
  assert.equal(lockedSession.drifted, false);
  assert.equal(lockedSession.autoTitleToSave, null);

  // 6. Real cross-domain imperative task switch DOES update and re-lock.
  const drifted = resolveAdaptiveThreadTitle({
    upstreamTitle: "Claude 项目进度查询",
    autoTitle: "Claude·项目进度查询",
    autoTitleSourceSig: "帮我查一下 Claude 项目进度",
    titleLocked: true,
    titleDomainKey: "tool:claude",
    titleSchemaVersion: TITLE_SCHEMA_VERSION,
    userPrompts: [
      "帮我查一下 Claude 项目进度",
      "优化 Agent Control 的会话标题生成与更新逻辑：当会话后续实际执行的任务与初始标题发生偏离时，自动重新总结",
    ],
    firstUserText: "帮我查一下 Claude 项目进度",
    lastUserText: "优化 Agent Control 的会话标题生成与更新逻辑：当会话后续实际执行的任务与初始标题发生偏离时，自动重新总结",
    hasFollowUpTurns: true,
  });
  assert.equal(drifted.drifted, true);
  assert.equal(drifted.title, "AgentCtrl·优化会话标题生成与更新逻辑");
  assert.equal(drifted.autoTitleToSave, "AgentCtrl·优化会话标题生成与更新逻辑");
  assert.equal(drifted.titleLocked, true);

  // 7. Manual customName & upstreamCustomTitle always take priority and never get overwritten.
  const lockedByUser = resolveAdaptiveThreadTitle({
    customName: "我的固定标题",
    autoTitle: "旧自动标题",
    upstreamTitle: "Claude 项目进度查询",
    lastUserText: "完全不同的新任务重构鉴权模块",
    hasFollowUpTurns: true,
  });
  assert.equal(lockedByUser.title, "我的固定标题");
  assert.equal(lockedByUser.autoTitleToSave, null);
  assert.equal(lockedByUser.drifted, false);

  const lockedByClaudeRename = resolveAdaptiveThreadTitle({
    upstreamCustomTitle: "手工置顶名称",
    upstreamTitle: "手工置顶名称",
    lastUserText: "完全不同的新任务重构鉴权模块",
    hasFollowUpTurns: true,
  });
  assert.equal(lockedByClaudeRename.title, "手工置顶名称");
  assert.equal(lockedByClaudeRename.autoTitleToSave, null);

  // 8. Topic similarity weights brand tokens as low-weight to avoid false similarity.
  const sim = computeTopicSimilarity("Claude 项目进度查询", "修复 Claude 流式解析超时报错");
  assert.equal(sim.sharedHighWeightCount, 0);
  assert.ok(extractTopicTokens("修复 Claude 流式解析超时报错").get("claude") < 0.5);
});

test("Codex <image>, skill prefixes, truncated markdown links, and question replies are stripped from titles and previews", () => {
  const imageWrapped = '<image name=[Image #1] path="demo-studio/assets/hero.png">\n</image>\n使用 demo-image-gen 技能，为《星火计划》ep01 顺序生成全三幕竖屏分镜图。';
  assert.equal(
    summarizeTaskTitle(imageWrapped),
    "为《星火计划》ep01 顺序生成全三幕竖屏分镜图",
  );
  assert.equal(
    summarizeTaskTitle("使用 $imagegen / image_gen 工具生成 1 张透明底像素风成就徽章 PNG"),
    "生成 1 张透明底像素风成就徽章 PNG",
  );
  assert.equal(
    cleanPreviewText('当前尝试 [$video-prompt-compiler](/Users/demo/.agents/skills/video-prompt-compiler/SK…', 120),
    "当前尝试 $video-prompt-compiler",
  );
  assert.equal(
    stripPromptNoise('<send_user_message_question_reply>[{"question":"哪个时间点？","answer":"今天 09:28"}]</send_user_message_question_reply>'),
    "回答：今天 09:28",
  );
  assert.equal(isContinuationOrControlPrompt('<send_user_message_question_reply>[{"question":"哪天？","answer":"今天"}]</send_user_message_question_reply>'), true);
  assert.equal(isLowQualityTitle('<image name=[Image #1] path="demo…'), true);
  assert.equal(isLowQualityTitle("<send_user_message_question_rep…"), true);
  assert.equal(isLowQualityTitle("使用 demo-image-gen 和…"), true);
  assert.equal(isLowQualityTitle("使用 Redis 缓存数据"), false);

  const healed = resolveAdaptiveThreadTitle({
    autoTitle: "使用 demo-image-gen 和…",
    autoTitleSourceSig: "old",
    upstreamTitle: imageWrapped,
    firstUserText: imageWrapped,
  });
  assert.equal(healed.title, "ep01全三幕竖屏分镜");
  assert.equal(healed.autoTitleToSave, "ep01全三幕竖屏分镜");

  assert.equal(displayThreadTitle({ title: '<image name=[Image #1] path="a.png">', preview: "查看分镜脚本" }), "查看分镜脚本");

  const prompts = extractUserPromptsFromTurns([
    { items: [{ type: "userMessage", content: [{ type: "text", text: "第一句" }] }] },
    { items: [{ type: "userMessage", text: "第二句" }] },
  ]);
  assert.deepEqual(prompts, ["第一句", "第二句"]);
});

test("resolveAdaptiveThreadTitle preserves Codex customer-issue-maintainer bracket titles even when autoTitle was locked", () => {
  const multiSegmentTicket = resolveAdaptiveThreadTitle({
    cwd: "/workspace/byai/客户问题解决",
    autoTitle: "客户问题排查",
    autoTitleSourceSig: "帮我看下这个客户问题",
    titleLocked: true,
    titleSchemaVersion: TITLE_SCHEMA_VERSION,
    upstreamTitle: "【剧狐｜道静｜微信消息｜OPPO X6】CRM 后台缺失",
    firstUserText: "帮我看下剧狐这个客户微信消息怎么缺失了",
    hasFollowUpTurns: true,
  });
  assert.equal(multiSegmentTicket.title, "【剧狐｜道静｜微信消息｜OPPO X6】CRM 后台缺失");
  assert.equal(multiSegmentTicket.autoTitleToSave, null);
  assert.equal(multiSegmentTicket.titleLocked, true);

  const singleSegmentTicket = resolveAdaptiveThreadTitle({
    cwd: "/workspace/byai/客户问题解决",
    autoTitle: "微信接口排查",
    titleLocked: true,
    titleSchemaVersion: TITLE_SCHEMA_VERSION,
    upstreamTitle: "【微信OpenAPI】增量查询返回历史发送消息",
    upstreamCustomTitle: "【微信OpenAPI】增量查询返回历史发送消息",
  });
  assert.equal(singleSegmentTicket.title, "【微信OpenAPI】增量查询返回历史发送消息");
  assert.equal(singleSegmentTicket.autoTitleToSave, null);
});
