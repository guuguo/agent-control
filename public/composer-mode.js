import { iconSvg } from "./icons.js";

export function resolveComposerSubmission({
  hasActiveThread = false,
  isRunning = false,
  isSubmitting = false,
  isEditingQueue = false,
  mode = "auto",
  text = "",
  imageCount = 0,
} = {}) {
  if (isSubmitting) {
    return { action: "busy", canSubmit: false, buttonLabel: "发送中…" };
  }
  const hasPayload = Boolean(String(text || "").trim() || imageCount > 0);
  if (!hasPayload) {
    return {
      action: "noop",
      canSubmit: false,
      buttonLabel: isEditingQueue ? "保存更新" : "发送",
    };
  }
  if (isEditingQueue && hasActiveThread) {
    return { action: "update_queue", canSubmit: true, buttonLabel: "保存更新" };
  }
  if (!hasActiveThread) {
    return { action: "new", canSubmit: true, buttonLabel: "新建并发送" };
  }
  if (!isRunning) {
    return { action: "turn", canSubmit: true, buttonLabel: "发送" };
  }
  if (mode === "steer") {
    return { action: "steer", canSubmit: true, buttonLabel: "插话引导" };
  }
  return { action: "queue", canSubmit: true, buttonLabel: "加入排队" };
}

function isRetryableBusyConflictError(error) {
  if (!error) return false;
  if (Number(error.status) === 409) return true;
  const code = String(error.code || "").trim();
  if (code === "thread_busy" || code === "writer_conflict" || code === "codex_app_running") {
    return true;
  }
  const msg = String(error.message || "");
  return /already has an active writer|\bactive writer\b|thread is busy|正在运行|占用/i.test(msg);
}

export async function submitComposerRequest(post, { action, payload, options } = {}) {
  if (action !== "queue") {
    try {
      const result = await post("api/turn", { ...payload, steer: action === "steer" }, options);
      return { action, result };
    } catch (error) {
      if (action !== "turn" || !isRetryableBusyConflictError(error)) throw error;
    }
  }
  return { action: "queue", result: await post("api/thread/queue", payload, options) };
}

export function extractGoalDirective(text = "") {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/^\/goal(?:\s+([\s\S]*))?$/i);
  if (!match) return { hasDirective: false, cleanedText: trimmed };
  return {
    hasDirective: true,
    cleanedText: String(match[1] || "").trim() || trimmed,
  };
}

function escapeQueuedHtml(value = "") {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render readable multi-line queued messages panel above the composer.
 */
export function renderQueuedTurnsPanelHtml(items = [], { collapsed = false, editingId = "" } = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return "";

  const toggleHtml = `
    <button
      type="button"
      class="queued-panel-toggle"
      data-queue-toggle="1"
      aria-expanded="${collapsed ? "false" : "true"}"
      title="${collapsed ? "展开排队消息" : "收起排队消息"}"
    >${collapsed ? "▾ 展开" : "▴ 收起"}</button>
  `;

  const bodyHtml = collapsed
    ? ""
    : `
      <div class="queued-panel-list">
        ${list.map((item, idx) => {
          const pos = Number(item.position) || idx + 1;
          const isControl = item.canCancel !== false && (item.source || "control") === "control";
          const sourceLabel = item.sourceLabel || (isControl ? "控制端队列" : "桌面端队列");
          const rawText = String(item.text || "").trim();
          const imageCount = Number(item.imageCount) || (Array.isArray(item.images) ? item.images.length : 0);
          const displayText = rawText || (imageCount > 0 ? "（仅包含图片附件）" : "（排队指令）");
          const tags = [];
          tags.push(`<span class="queued-meta-tag ${isControl ? "is-control" : "is-native"}">${escapeQueuedHtml(sourceLabel)}</span>`);
          if (imageCount > 0) {
            tags.push(`<span class="queued-meta-tag is-media" title="包含 ${imageCount} 张图片">${iconSvg("image", { size: 11 })} ${imageCount}</span>`);
          }
          if (item.goalMode) {
            tags.push(`<span class="queued-meta-tag is-goal">${iconSvg("target", { size: 11 })} Goal</span>`);
          }
          const isEditing = Boolean(editingId && item.id === editingId);
          if (isEditing) {
            tags.push(`<span class="queued-meta-tag is-editing">编辑中</span>`);
          }
          const actionsHtml = isControl
            ? `
              <button
                type="button"
                class="queued-item-btn is-steer"
                data-queue-steer="${escapeQueuedHtml(item.id)}"
                title="不等当前轮次结束，直接插话引导进去"
                aria-label="直接引导进当前会话"
              >${iconSvg("steer", { size: 12 })}<span>引导</span></button>
              <button
                type="button"
                class="queued-item-btn is-edit"
                data-queue-edit="${escapeQueuedHtml(item.id)}"
                title="撤回到输入框编辑"
                aria-label="撤回到输入框编辑"
              >${iconSvg("edit", { size: 12 })}</button>
              <button
                type="button"
                class="queued-item-btn is-cancel"
                data-queue-cancel="${escapeQueuedHtml(item.id)}"
                title="取消这条排队"
                aria-label="取消这条排队"
              >${iconSvg("close", { size: 12 })}</button>
            `
            : `<span class="queued-readonly-hint" title="本地客户端原生排队，请在对应客户端中编辑或取消">只读</span>`;

          return `
            <div class="queued-item ${isControl ? "is-control" : "is-native"}${isEditing ? " is-editing" : ""}" data-queue-id="${escapeQueuedHtml(item.id)}">
              <span class="queued-item-index" aria-hidden="true">${pos}</span>
              <div class="queued-item-body">
                <div class="queued-item-text" title="${escapeQueuedHtml(rawText || displayText)}">${escapeQueuedHtml(displayText)}</div>
                <div class="queued-item-meta">${tags.join("")}</div>
              </div>
              <div class="queued-item-actions">${actionsHtml}</div>
            </div>
          `;
        }).join("")}
      </div>
    `;

  return `
    <div class="queued-panel ${collapsed ? "is-collapsed" : ""}">
      <div class="queued-panel-head">
        <div class="queued-panel-title">
          <span class="queued-panel-heading">排队消息</span>
          <span class="queued-panel-count">${list.length}</span>
          <span class="queued-panel-sub">当前轮次完成后自动发送</span>
        </div>
        ${toggleHtml}
      </div>
      ${bodyHtml}
    </div>
  `;
}
