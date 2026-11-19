import { escapeHtml } from "./markdown.js";
import { compactModelBadgeLabel, providerDisplayName } from "./instance-switcher.js";

export function formatExecutionDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return "—";
  const seconds = Math.max(0, Number(ms) / 1000);
  if (seconds < 60) return `${Number(seconds.toFixed(1))}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${Math.floor(seconds % 60)}秒`;
  return `${Math.floor(seconds / 3600)}小时${Math.floor(seconds / 60) % 60}分`;
}

export function formatTokensPerSec(value, source = "reported") {
  if (value === null || value === undefined || !Number.isFinite(Number(value)) || Number(value) <= 0) return "—";
  const n = Number(value);
  const formatted = n >= 10 ? String(Math.round(n)) : n.toFixed(1);
  return `${source === "estimated" ? "≈" : ""}${formatted} tok/s`;
}

const number = (value) => value === null || value === undefined ? "—" : Math.round(value).toLocaleString("zh-CN");
const shortEffortLabel = (effort) => ({ minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" }[effort] || effort || "");
const effortLabel = (effort) => shortEffortLabel(effort) || "默认 / 未提供";
const statusLabel = (status) => ({ completed: "完成", failed: "失败", interrupted: "中断", running: "执行中", incomplete: "结束状态未记录" }[status] || status);
const sourceLabel = (source) => ({ reported: "协议上报", partial: "部分上报", estimated: "文本估算", unavailable: "未上报" }[source] || "未上报");

function formatGroupShortName(group = {}) {
  const rawModel = String(group.model || "").trim();
  const base = rawModel ? (compactModelBadgeLabel(rawModel) || rawModel) : "未记录模型";
  const eff = shortEffortLabel(group.effort);
  return eff ? `${base}（${eff}）` : base;
}

function formatGroupHeadlineName(group = {}) {
  const prov = providerDisplayName(group.provider);
  return `${prov} · ${formatGroupShortName(group)}`;
}

function latencyToneClass(firstMs) {
  if (firstMs === null || firstMs === undefined || !Number.isFinite(Number(firstMs))) return "";
  if (Number(firstMs) <= 5000) return "execution-latency-fast";
  if (Number(firstMs) >= 15000) return "execution-latency-slow";
  return "";
}

function selectWinner(candidates, scoreFn, betterFn) {
  let best = null;
  let bestScore = null;
  for (const g of candidates) {
    const sc = scoreFn(g);
    if (sc === null || sc === undefined || !Number.isFinite(Number(sc))) continue;
    if (!best || betterFn(sc, bestScore, g, best)) {
      best = g;
      bestScore = sc;
    }
  }
  return best;
}

export function buildExecutionSummary(snapshot, { days = 7 } = {}) {
  const groups = Array.isArray(snapshot?.groups) ? snapshot.groups : [];
  let totalRuns = 0;
  let totalCompleted = 0;
  for (const g of groups) {
    totalRuns += Number(g?.count) || 0;
    totalCompleted += Number(g?.completed) || 0;
  }
  const overallSuccessRate = totalRuns > 0 ? Math.round((totalCompleted / totalRuns) * 100) : null;

  const hasReliableNamed = groups.filter((g) => (Number(g?.completed) || 0) >= 3 && String(g?.model || "").trim());
  const hasNamed = groups.filter((g) => (Number(g?.completed) || 0) >= 1 && String(g?.model || "").trim());
  const hasCompleted = groups.filter((g) => (Number(g?.completed) || 0) >= 1);
  const candidates = hasReliableNamed.length ? hasReliableNamed : (hasNamed.length ? hasNamed : hasCompleted);

  const fastestFirstOutput = selectWinner(
    candidates,
    (g) => g.firstResponseMs,
    (a, b, ga, gb) => a < b || (a === b && (ga.completed || 0) > (gb.completed || 0)),
  );
  const fastestThroughput = selectWinner(
    candidates,
    (g) => g.medianTokensPerSec,
    (a, b, ga, gb) => {
      if (a !== b) return a > b;
      const repA = ga.tokensPerSecSource === "reported" ? 1 : 0;
      const repB = gb.tokensPerSecSource === "reported" ? 1 : 0;
      return repA !== repB ? repA > repB : (ga.completed || 0) > (gb.completed || 0);
    },
  );
  const fastestTurn = selectWinner(
    candidates,
    (g) => g.medianMs,
    (a, b, ga, gb) => a < b || (a === b && (ga.completed || 0) > (gb.completed || 0)),
  );
  const mostUsed = selectWinner(
    groups,
    (g) => Number(g?.count) || 0,
    (a, b, ga, gb) => a > b || (a === b && (ga.completed || 0) > (gb.completed || 0)),
  );
  const slowestCandidate = selectWinner(
    candidates.filter((g) => (Number(g?.completed) || 0) >= 3 && (Number(g?.medianMs) || 0) >= 120000),
    (g) => g.medianMs,
    (a, b) => a > b,
  );
  const slowestNotable = slowestCandidate && slowestCandidate !== fastestTurn ? slowestCandidate : null;

  const windowLabel = { 1: "近24小时", 7: "近7天", 30: "近30天", 0: "全部" }[Number(days)] || `近${days}天`;
  const sentences = [];
  if (totalRuns > 0) {
    sentences.push(`${windowLabel}共完成 ${totalCompleted.toLocaleString("zh-CN")} / ${totalRuns.toLocaleString("zh-CN")} 轮（成功率 ${overallSuccessRate}%）。`);
  }
  const highlights = [];
  if (mostUsed && totalRuns > 0) {
    highlights.push(`最常用主力是 ${formatGroupHeadlineName(mostUsed)}（${mostUsed.count} 轮，中位 ${formatExecutionDuration(mostUsed.medianMs)}）`);
  }
  if (fastestFirstOutput) {
    highlights.push(`开口最快的是 ${formatGroupHeadlineName(fastestFirstOutput)}（首次延迟 ${formatExecutionDuration(fastestFirstOutput.firstResponseMs)}）`);
  }
  if (fastestThroughput) {
    highlights.push(`出字最快的是 ${formatGroupHeadlineName(fastestThroughput)}（${formatTokensPerSec(fastestThroughput.medianTokensPerSec, fastestThroughput.tokensPerSecSource)}）`);
  }
  if (highlights.length) sentences.push(`${highlights.join("；")}。`);
  if (slowestNotable) {
    sentences.push(`耗时最重的是 ${formatGroupHeadlineName(slowestNotable)}（中位 ${formatExecutionDuration(slowestNotable.medianMs)}）。`);
  }

  return {
    totalRuns,
    totalCompleted,
    overallSuccessRate,
    fastestFirstOutput,
    fastestThroughput,
    fastestTurn,
    mostUsed,
    slowestNotable,
    headlineText: sentences.join(""),
  };
}

export function renderExecutionStatsHtml(snapshot, { days = 7, provider = "all", loading = false, error = "" } = {}) {
  const groups = Array.isArray(snapshot?.groups) ? snapshot.groups : [];
  const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : [];
  const summary = buildExecutionSummary(snapshot, { days });

  const frequentGroups = groups.filter((g) => (Number(g?.count) || 0) >= 2);
  const displayGroups = frequentGroups.length >= 3 ? frequentGroups : groups;
  const maxSpeed = Math.max(1, ...displayGroups.map((g) => Number(g?.medianTokensPerSec) || 0));
  const hiddenNoiseCount = Math.max(0, groups.length - displayGroups.length);

  const summaryCardsHtml = groups.length ? `
    <div class="execution-summary-grid" role="region" aria-label="核心结论概览">
      <div class="execution-summary-card">
        <div class="execution-summary-label">开口最快（首次延迟）</div>
        <div class="execution-summary-value ${latencyToneClass(summary.fastestFirstOutput?.firstResponseMs)}">${summary.fastestFirstOutput ? escapeHtml(formatExecutionDuration(summary.fastestFirstOutput.firstResponseMs)) : "—"}</div>
        <div class="execution-summary-model" title="${escapeHtml(summary.fastestFirstOutput ? formatGroupHeadlineName(summary.fastestFirstOutput) : "")}">${summary.fastestFirstOutput ? escapeHtml(formatGroupShortName(summary.fastestFirstOutput)) : "暂无达标样本"}</div>
        <div class="execution-summary-sub">${summary.fastestFirstOutput ? `${escapeHtml(providerDisplayName(summary.fastestFirstOutput.provider))} · ${summary.fastestFirstOutput.completed} 轮完成` : "等待新轮次采样"}</div>
      </div>
      <div class="execution-summary-card">
        <div class="execution-summary-label">出字最快（吐字速度）</div>
        <div class="execution-summary-value">${summary.fastestThroughput ? escapeHtml(formatTokensPerSec(summary.fastestThroughput.medianTokensPerSec, summary.fastestThroughput.tokensPerSecSource)) : "暂无速率"}</div>
        <div class="execution-summary-model" title="${escapeHtml(summary.fastestThroughput ? formatGroupHeadlineName(summary.fastestThroughput) : "")}">${summary.fastestThroughput ? escapeHtml(formatGroupShortName(summary.fastestThroughput)) : "暂无输出 Token 样本"}</div>
        <div class="execution-summary-sub">${summary.fastestThroughput ? `${escapeHtml(providerDisplayName(summary.fastestThroughput.provider))} · ${summary.fastestThroughput.tokensPerSecSource === "estimated" ? "文本估算" : "协议上报"}（${summary.fastestThroughput.speedSampleCount || summary.fastestThroughput.completed} 轮）` : "部分 Agent 未上报输出 Token"}</div>
      </div>
      <div class="execution-summary-card">
        <div class="execution-summary-label">完事最快（整轮中位）</div>
        <div class="execution-summary-value">${summary.fastestTurn ? escapeHtml(formatExecutionDuration(summary.fastestTurn.medianMs)) : "—"}</div>
        <div class="execution-summary-model" title="${escapeHtml(summary.fastestTurn ? formatGroupHeadlineName(summary.fastestTurn) : "")}">${summary.fastestTurn ? escapeHtml(formatGroupShortName(summary.fastestTurn)) : "暂无达标样本"}</div>
        <div class="execution-summary-sub">${summary.fastestTurn ? `${escapeHtml(providerDisplayName(summary.fastestTurn.provider))} · 90% 在 ${escapeHtml(formatExecutionDuration(summary.fastestTurn.p90Ms))} 内` : "含工具与思考总耗时"}</div>
      </div>
      <div class="execution-summary-card">
        <div class="execution-summary-label">最常用主力</div>
        <div class="execution-summary-value">${summary.mostUsed ? `${Number(summary.mostUsed.count).toLocaleString("zh-CN")} 轮` : "—"}</div>
        <div class="execution-summary-model" title="${escapeHtml(summary.mostUsed ? formatGroupHeadlineName(summary.mostUsed) : "")}">${summary.mostUsed ? escapeHtml(formatGroupShortName(summary.mostUsed)) : "—"}</div>
        <div class="execution-summary-sub">${summary.mostUsed && summary.totalRuns ? `${escapeHtml(providerDisplayName(summary.mostUsed.provider))} · 占 ${Math.round((summary.mostUsed.count / summary.totalRuns) * 100)}% · 成功率 ${Math.round((summary.mostUsed.completed / Math.max(1, summary.mostUsed.count)) * 100)}%` : "暂无"}</div>
      </div>
    </div>
    ${summary.headlineText ? `<div class="execution-summary-verdict">${escapeHtml(summary.headlineText)}</div>` : ""}
  ` : "";

  const humanRows = displayGroups.map((group) => {
    const rate = group.count > 0 ? Math.round((group.completed / group.count) * 100) : 0;
    const speedVal = group.medianTokensPerSec;
    const speedText = formatTokensPerSec(speedVal, group.tokensPerSecSource);
    const speedPct = speedVal ? Math.max(8, Math.min(100, Math.round((Number(speedVal) / maxSpeed) * 100))) : 0;
    const toneCls = latencyToneClass(group.firstResponseMs);
    const titleTip = [
      `完整模型: ${group.model || "模型未提供"}`,
      `思考强度: ${effortLabel(group.effort)}`,
      group.p90Ms !== null && group.p90Ms !== undefined ? `90% 耗时在 ${formatExecutionDuration(group.p90Ms)} 内` : "",
      group.meanToolCalls !== null && group.meanToolCalls !== undefined ? `平均调用工具 ${Number(group.meanToolCalls).toFixed(1)} 次` : "",
    ].filter(Boolean).join(" · ");
    return `<tr title="${escapeHtml(titleTip)}">
      <td class="execution-model"><span class="execution-human-name">${escapeHtml(formatGroupShortName(group))}</span><span class="execution-human-prov">${escapeHtml(providerDisplayName(group.provider))}</span></td>
      <td>${group.completed}/${group.count} 轮（${rate}%）</td>
      <td class="${toneCls}">${escapeHtml(formatExecutionDuration(group.firstResponseMs))}</td>
      <td>${speedVal ? `<span class="execution-speed-cell"><span>${escapeHtml(speedText)}</span><span class="execution-speed-bar" aria-hidden="true"><span class="execution-speed-fill" style="width:${speedPct}%"></span></span></span>` : "—"}</td>
      <td>${escapeHtml(formatExecutionDuration(group.medianMs))}</td>
    </tr>`;
  }).join("");

  const groupRows = groups.map((group) => `<tr>
    <td>${escapeHtml(providerDisplayName(group.provider))}</td>
    <td class="execution-model" title="${escapeHtml(group.model || "模型未提供")}">${escapeHtml(group.model || "模型未提供")}</td>
    <td>${escapeHtml(effortLabel(group.effort))}</td>
    <td title="完成 ${group.completed}，失败 ${group.failed}，中断 ${group.interrupted}，执行中 ${group.running}，结束未记录 ${group.incomplete}">${group.completed} / ${group.count}</td>
    <td>${formatExecutionDuration(group.medianMs)}</td><td>${formatExecutionDuration(group.p90Ms)}</td>
    <td>${formatExecutionDuration(group.firstResponseMs)}</td>
    <td>${escapeHtml(formatTokensPerSec(group.medianTokensPerSec, group.tokensPerSecSource))}</td>
    <td>${number(group.meanInputTokens)}</td><td>${number(group.meanOutputTokens)}</td>
    <td>${number(group.meanCachedTokens)}</td><td>${number(group.meanReasoningTokens)}</td>
    <td>${group.meanToolCalls === null ? "—" : Number(group.meanToolCalls.toFixed(1))}</td>
    <td>${group.reportedCount} / ${group.completed}</td>
  </tr>`).join("");

  const recentRows = runs.map((run) => `<tr>
    <td>${escapeHtml(new Date(run.startedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }))}</td>
    <td><button type="button" class="execution-thread-link" data-execution-thread="${escapeHtml(run.threadId)}" title="打开对应会话">${escapeHtml(providerDisplayName(run.provider))} · ${escapeHtml(run.profileId || "默认")}</button></td>
    <td class="execution-model" title="${escapeHtml(run.model || "模型未提供")}">${escapeHtml(run.model || "模型未提供")}</td><td>${escapeHtml(effortLabel(run.effort))}</td>
    <td>${escapeHtml(statusLabel(run.status))}${run.goalMode ? " · /goal" : ""}</td>
    <td>${formatExecutionDuration(run.durationMs)}</td><td>${formatExecutionDuration(run.firstResponseMs)}</td>
    <td>${number(run.inputTokens)}</td><td>${run.outputTokens !== null ? number(run.outputTokens) : (run.estimatedOutputTokens > 0 ? `≈${number(run.estimatedOutputTokens)}` : "—")}</td>
    <td>${run.toolCalls}</td><td>${escapeHtml(sourceLabel(run.tokenSource))}</td>
  </tr>`).join("");

  return `<section class="execution-stats" aria-label="Agent 执行统计">
    <div class="execution-stats-heading"><strong>执行统计</strong><div class="execution-stats-controls">
      <label>范围 <select data-execution-days aria-label="统计时间范围" ${loading ? "disabled" : ""}>${[[1, "近24小时"], [7, "近7天"], [30, "近30天"], [0, "全部"]].map(([value, label]) => `<option value="${value}"${Number(days) === value ? " selected" : ""}>${label}</option>`).join("")}</select></label>
      <label>Agent <select data-execution-provider aria-label="统计 Agent" ${loading ? "disabled" : ""}>${["all", "codex", "claude", "antigravity", "grok", "qoder"].map((value) => `<option value="${value}"${provider === value ? " selected" : ""}>${value === "all" ? "全部" : escapeHtml(providerDisplayName(value))}</option>`).join("")}</select></label>
      <button type="button" class="telemetry-action-btn" data-execution-refresh ${loading ? "disabled" : ""}>${loading ? "读取中…" : "刷新统计"}</button>
    </div></div>
    ${error ? `<p class="execution-stats-error" role="status">${escapeHtml(error)}</p>` : ""}
    ${summaryCardsHtml}
    <p class="execution-stats-note">整轮耗时含工具与审批等待；标 ≈ 为流式估算速度，不同任务复杂度仅供参考。${snapshot ? `记录起于 ${escapeHtml(new Date(snapshot.startedAt).toLocaleDateString("zh-CN"))}，更新于 ${escapeHtml(new Date(snapshot.updatedAt).toLocaleTimeString("zh-CN", { hour12: false }))}。` : ""}</p>
    ${groups.length ? `<div class="execution-stats-scroll" role="region" aria-label="模型速度与稳定性人话榜" tabindex="0"><table class="execution-stats-table is-human"><thead><tr>
      <th>模型与档位</th><th>常用 / 成功率</th><th>首次延迟</th><th>吐字速度</th><th>整轮中位耗时</th>
    </tr></thead><tbody>${humanRows}</tbody></table></div>` : (!error ? `<p class="execution-stats-note">${loading ? "正在读取执行记录…" : "暂无执行样本。启用后从新轮次开始记录，不推算历史耗时和 Token。"}</p>` : "")}
    ${groups.length ? `<details class="execution-stats-raw"><summary>查看完整原始指标表（共 ${groups.length} 组${hiddenNoiseCount > 0 ? `，含 ${hiddenNoiseCount} 组仅 1 轮样本` : ""} · 含 P90 与 Token 均值）</summary><div class="execution-stats-scroll" role="region" aria-label="模型与思考强度对比" tabindex="0"><table class="execution-stats-table"><thead><tr>
      <th>Agent</th><th>模型</th><th>思考强度</th><th>完成 / 轮次</th><th>中位用时</th><th>P90 用时</th><th>中位首输出</th><th>吐字速度</th><th>均输入</th><th>均输出</th><th>均缓存读取</th><th>均推理</th><th>均工具次数</th><th>协议样本</th>
    </tr></thead><tbody>${groupRows}</tbody></table></div></details>` : ""}
    ${runs.length ? `<details class="execution-stats-recent"><summary>最近 ${runs.length} 轮执行明细 · 最多保留 ${snapshot.retainedLimit} 轮</summary><div class="execution-stats-scroll" role="region" aria-label="执行明细" tabindex="0"><table class="execution-stats-table"><thead><tr><th>开始时间</th><th>会话入口</th><th>模型</th><th>强度</th><th>状态</th><th>耗时</th><th>首输出</th><th>输入</th><th>输出 / 估算</th><th>工具次数</th><th>Token 来源</th></tr></thead><tbody>${recentRows}</tbody></table></div></details>` : ""}
  </section>`;
}
