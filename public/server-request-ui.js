import { escapeHtml } from "./markdown.js";
import { providerDisplayName } from "./instance-switcher.js";

function decisionLabel(decision) {
  switch (decision) {
    case "accept":
    case "approved":
      return "允许一次";
    case "acceptForSession":
    case "approved_for_session":
      return "本会话允许";
    case "decline":
    case "denied":
      return "拒绝";
    case "cancel":
    case "abort":
      return "终止";
    default:
      return decision;
  }
}

export function renderServerRequestCard(request, { agentLabel = "" } = {}) {
  const resolvedLabel = agentLabel || providerDisplayName(request.provider);
  const id = escapeHtml(request.id);

  if (request.kind === "userInput") {
    const questions = Array.isArray(request.questions) ? request.questions : [];
    const qHtml = questions.map((q, qIdx) => {
      const qId = escapeHtml(q.id || `q_${qIdx}`);
      const options = Array.isArray(q.options) ? q.options : [];
      const inputType = q.multiSelect ? "checkbox" : "radio";
      const inputName = `q-${qIdx}`;
      const optsHtml = options.map((opt, oIdx) => {
        const val = escapeHtml(opt.label || opt);
        const desc = opt.description ? `<span class="sr-opt-desc">${escapeHtml(opt.description)}</span>` : "";
        return `
          <label class="sr-option">
            <input type="${inputType}" name="${inputName}" value="${val}" ${!q.multiSelect ? "required" : ""} />
            <span class="sr-opt-number" aria-hidden="true">${oIdx + 1}</span>
            <span class="sr-opt-main">
              <strong>${val}</strong>
              ${desc}
            </span>
          </label>
        `;
      }).join("");

      const allowOther = !options.length || q.isOther !== false;
      const otherOption = options.length && allowOther ? `
        <label class="sr-option sr-custom-option">
          <input type="${inputType}" name="${inputName}" data-answer-other ${!q.multiSelect ? "required" : ""} />
          <span class="sr-opt-main"><strong>其他 · 自行填写</strong></span>
        </label>` : "";
      const textAttrs = `class="sr-other-input" data-other-for="${qId}" aria-label="${escapeHtml(q.question || q.header || "你的回答")}" ${options.length ? "disabled" : "required"}`;
      const otherField = allowOther ? `<div class="sr-other-field" ${options.length ? "hidden" : ""}>
        ${q.isSecret
          ? `<input type="password" ${textAttrs} autocomplete="off" placeholder="输入你的回答" />`
          : `<textarea ${textAttrs} rows="2" placeholder="输入你的回答…"></textarea>`}
      </div>` : "";
      return `
        <fieldset class="sr-question" data-question-id="${qId}" data-multi="${q.multiSelect ? "1" : "0"}">
          <legend class="sr-q-header">${questions.length > 1 ? `${qIdx + 1}/${questions.length} · ` : ""}${escapeHtml(q.header || `问题 ${qIdx + 1}`)}<span class="sr-q-mode">${options.length ? (q.multiSelect ? "可多选" : "单选") : "自由填写"}</span></legend>
          <div class="sr-q-prompt">${escapeHtml(q.question || "")}</div>
          ${optsHtml ? `<div class="sr-options">${optsHtml}${otherOption}</div>` : ""}
          ${otherField}
        </fieldset>
      `;
    }).join("");

    return `
      <form class="server-request-card" data-request-id="${id}" data-kind="userInput">
        <div class="sr-head">
          <span class="sr-badge">${escapeHtml(resolvedLabel)}</span>
          <strong>${escapeHtml(request.title || `${resolvedLabel} 需要你的回答`)}</strong>
        </div>
        <div class="sr-input-hint">${request.isBlocking === false ? "任务在后台继续，你可以在这里补充回答。" : "选择或填写后提交，任务将继续。"}</div>
        <div class="sr-questions">${qHtml}</div>
        <div class="sr-actions">
          <button type="submit" class="btn-primary">提交回答</button>
          <button type="button" class="btn-secondary" data-decline-id="${id}">跳过回答</button>
        </div>
      </form>
    `;
  }

  if (request.kind === "acpPermission" && Array.isArray(request.options) && request.options.length) {
    const optButtons = request.options.map((opt) => {
      const optId = escapeHtml(opt.optionId || opt.id || "");
      const isDeny = String(opt.kind || "").includes("reject");
      return `<button type="button" class="${isDeny ? "btn-danger" : "btn-primary"}" data-request-id="${id}" data-option-id="${optId}">${escapeHtml(opt.name || optId)}</button>`;
    }).join("");
    return `
      <div class="server-request-card" data-request-id="${id}" data-kind="acpPermission">
        <div class="sr-head">
          <span class="sr-badge">${escapeHtml(resolvedLabel)}</span>
          <strong>${escapeHtml(request.title || `${resolvedLabel} 请求授权`)}</strong>
        </div>
        ${request.command ? `<pre class="sr-code">${escapeHtml(request.command)}</pre>` : ""}
        ${request.reason ? `<p class="sr-reason">${escapeHtml(request.reason)}</p>` : ""}
        <div class="sr-actions">${optButtons}</div>
      </div>
    `;
  }

  const decisions = Array.isArray(request.availableDecisions) && request.availableDecisions.length
    ? request.availableDecisions
    : ["accept", "acceptForSession", "decline"];

  const details = [];
  if (request.command) details.push(`<pre class="sr-code">${escapeHtml(request.command)}</pre>`);
  if (request.filePath) details.push(`<div class="sr-meta">目标文件：<code>${escapeHtml(request.filePath)}</code></div>`);
  if (request.cwd) details.push(`<div class="sr-meta">目录：<code>${escapeHtml(request.cwd)}</code></div>`);
  if (request.reason) details.push(`<p class="sr-reason">${escapeHtml(request.reason)}</p>`);

  return `
    <div class="server-request-card" data-request-id="${id}" data-kind="${escapeHtml(request.kind || "approval")}">
      <div class="sr-head">
        <span class="sr-badge">${escapeHtml(resolvedLabel)}</span>
        <strong>${escapeHtml(request.title || `${resolvedLabel} 请求授权`)}</strong>
      </div>
      ${details.join("")}
      <div class="sr-actions">
        ${decisions.map((d) => {
          const cls = (d === "decline" || d === "denied" || d === "cancel" || d === "abort")
            ? "btn-danger"
            : (d === "acceptForSession" || d === "approved_for_session" ? "btn-secondary" : "btn-primary");
          return `<button type="button" class="${cls}" data-request-id="${id}" data-decision="${escapeHtml(d)}">${escapeHtml(decisionLabel(d))}</button>`;
        }).join("")}
      </div>
    </div>
  `;
}

export function collectUserInputAnswers(request, formElement) {
  const answers = {};
  const fields = [...formElement.querySelectorAll(".sr-question")];
  for (const [index, q] of (request?.questions || []).entries()) {
    const qId = String(q.id || `q_${index}`);
    const field = fields.find((el) => el.dataset.questionId === qId);
    const inputs = [...(field?.querySelectorAll("input:checked:not([data-answer-other])") || [])];
    const selected = inputs.map((el) => el.value).filter(Boolean);
    const otherInput = field?.querySelector("[data-other-for]");
    const otherValue = otherInput?.disabled ? "" : String(otherInput?.value || "").trim();
    if (otherValue) selected.push(otherValue);
    if (!selected.length) throw new Error(`请选择或填写「${q.header || q.question || `问题 ${index + 1}`}」的回答`);
    answers[qId] = { answers: selected };
  }
  return answers;
}

export function syncUserInputQuestion(target) {
  const question = target.closest(".sr-question");
  const toggle = question?.querySelector("[data-answer-other]");
  if (!toggle) return;
  const field = question.querySelector(".sr-other-field");
  const input = question.querySelector("[data-other-for]");
  field.hidden = !toggle.checked;
  input.disabled = !toggle.checked;
  input.required = toggle.checked;
}

// Keep live form elements when another request arrives or SSE reconnects.
export function syncServerRequestCards(dock, requests) {
  const previous = new Map([...dock.children].map((el) => [el.dataset.requestId, el]));
  requests.forEach((request, index) => {
    const html = renderServerRequestCard(request);
    let card = previous.get(request.id);
    if (!card || card._acRequestHtml !== html) {
      card?.remove();
      const template = dock.ownerDocument.createElement("template");
      template.innerHTML = html;
      card = template.content.firstElementChild;
      card._acRequestHtml = html;
    }
    previous.delete(request.id);
    if (dock.children[index] !== card) dock.insertBefore(card, dock.children[index] || null);
  });
  for (const card of previous.values()) card.remove();
}
