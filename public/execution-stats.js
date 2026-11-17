import { escapeHtml } from "./markdown.js";
import { providerDisplayName } from "./instance-switcher.js";

export function formatExecutionDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return "—";
  const seconds = Math.max(0, Number(ms) / 1000);
  if (seconds < 60) return `${Number(seconds.toFixed(1))}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${Math.floor(seconds % 60)}秒`;
  return `${Math.floor(seconds / 3600)}小时${Math.floor(seconds / 60) % 60}分`;
}

const number = (value) => value === null || value === undefined ? "—" : Math.round(value).toLocaleString("zh-CN");
const effortLabel = (effort) => ({ minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" }[effort] || effort || "默认 / 未提供");
const statusLabel = (status) => ({ completed: "完成", failed: "失败", interrupted: "中断", running: "执行中", incomplete: "结束状态未记录" }[status] || status);
const sourceLabel = (source) => ({ reported: "协议上报", partial: "部分上报", estimated: "文本估算", unavailable: "未上报" }[source] || "未上报");

export function renderExecutionStatsHtml(snapshot, { days = 7, provider = "all", loading = false, error = "" } = {}) {
  const groups = snapshot?.groups || [];
  const runs = snapshot?.runs || [];
  const groupRows = groups.map((group) => `<tr>
    <td>${escapeHtml(providerDisplayName(group.provider))}</td>
    <td class="execution-model" title="${escapeHtml(group.model || "模型未提供")}">${escapeHtml(group.model || "模型未提供")}</td>
    <td>${escapeHtml(effortLabel(group.effort))}</td>
    <td title="完成 ${group.completed}，失败 ${group.failed}，中断 ${group.interrupted}，执行中 ${group.running}，结束未记录 ${group.incomplete}">${group.completed} / ${group.count}</td>
    <td>${formatExecutionDuration(group.medianMs)}</td><td>${formatExecutionDuration(group.p90Ms)}</td>
    <td>${formatExecutionDuration(group.firstResponseMs)}</td>
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
    <p class="execution-stats-note">每轮指令单独采样，/goal 续跑分轮记录。耗时含工具和审批等待，不含排队；首输出含思考。汇总用时仅统计成功轮次，Token 均值仅使用已确认的每轮协议用量。不同任务复杂度不能直接当作模型速度排名。${snapshot ? `记录起于 ${escapeHtml(new Date(snapshot.startedAt).toLocaleDateString("zh-CN"))}，更新于 ${escapeHtml(new Date(snapshot.updatedAt).toLocaleTimeString("zh-CN", { hour12: false }))}。` : ""}</p>
    ${error ? `<p class="execution-stats-error" role="status">${escapeHtml(error)}</p>` : ""}
    ${groups.length ? `<div class="execution-stats-scroll" role="region" aria-label="模型与思考强度对比" tabindex="0"><table class="execution-stats-table"><thead><tr>
      <th>Agent</th><th>模型</th><th>思考强度</th><th>完成 / 轮次</th><th>中位用时</th><th>P90 用时</th><th>中位首输出</th><th>均输入</th><th>均输出</th><th>均缓存读取</th><th>均推理</th><th>均工具次数</th><th>协议样本</th>
    </tr></thead><tbody>${groupRows}</tbody></table></div>` : (!error ? `<p class="execution-stats-note">${loading ? "正在读取执行记录…" : "暂无执行样本。启用后从新轮次开始记录，不推算历史耗时和 Token。"}</p>` : "")}
    ${runs.length ? `<details class="execution-stats-recent"><summary>最近 ${runs.length} 轮执行明细 · 最多保留 ${snapshot.retainedLimit} 轮</summary><div class="execution-stats-scroll" role="region" aria-label="执行明细" tabindex="0"><table class="execution-stats-table"><thead><tr><th>开始时间</th><th>会话入口</th><th>模型</th><th>强度</th><th>状态</th><th>耗时</th><th>首输出</th><th>输入</th><th>输出 / 估算</th><th>工具次数</th><th>Token 来源</th></tr></thead><tbody>${recentRows}</tbody></table></div></details>` : ""}
  </section>`;
}
