function isTerminalStatus(status) {
  return Boolean(status && status !== "running" && status !== "inProgress");
}

export function mergeLiveActivity(current = {}, incoming = {}, { expectedTurnId } = {}) {
  const previous = current ?? {};
  const next = incoming ?? {};
  if (expectedTurnId && next.turnId && next.turnId !== expectedTurnId) return previous;
  const sameTurn = previous.turnId && next.turnId && previous.turnId === next.turnId;
  if (sameTurn && isTerminalStatus(previous.status) && !isTerminalStatus(next.status)) return previous;
  return { ...previous, ...next };
}

const RAW_STATUS_NOISE_RE = /^(in_progress|inprogress|completed|pending|running|started|done|ok|tool_call|tool_call_update)$/i;

function extractShortFileFromPhase(rawPhase) {
  let text = String(rawPhase || "").trim();
  if (text.length >= 2 && ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'")))) {
    text = text.slice(1, -1).trim();
  }
  const prefixed = text.match(/^(?:File|Read|Edit|Write|Viewing|Editing)\s+(.+)$/i);
  const candidate = (prefixed ? prefixed[1] : text).replace(/^["']+|["']+$/g, "").trim();
  if (!candidate) return "";
  if (!prefixed && !/[\\/]/.test(candidate)) return "";
  const parts = candidate.split(/[/\\]+/).filter((seg) => seg && seg !== "." && seg !== "..");
  return parts.length ? parts[parts.length - 1] : "";
}

function mapEnglishPhaseToChinese(text, shortFile = "") {
  if (/^File\s+/i.test(text) && shortFile) return `正在处理 ${shortFile}…`;
  if (/(read_file|view_file|viewing|\bread\b|\binspect\b|\blist_dir|\blist\b)/i.test(text)) {
    return shortFile ? `正在查阅 ${shortFile}…` : "正在查阅文件…";
  }
  if (/(edit_file|write_file|replace_file|multi_edit|editing|\bedit\b|\bwrite\b|\bpatch\b|\bupdate\b)/i.test(text)) {
    return shortFile ? `正在修改 ${shortFile}…` : "正在修改代码…";
  }
  if (/(\btest\b|\bpytest\b|\bjest\b|\bvitest\b)/i.test(text)) return "正在运行测试…";
  if (/(\bcheck\b|\bbuild\b|\blint\b|\btsc\b)/i.test(text)) return "正在检查代码…";
  if (/(\bgit\b)/i.test(text)) return "正在检查仓库状态…";
  if (/(run_command|exec_command|\bbash\b|\bcommand\b|\bshell\b)/i.test(text)) return "正在执行命令…";
  if (/(search|grep|glob|find)/i.test(text)) return "正在检索代码…";
  if (/(exit_plan_mode|\bplan\b)/i.test(text)) return "正在整理方案…";
  return shortFile ? `正在处理 ${shortFile}…` : "正在执行操作…";
}

function cleanDisplayDetail(detail, phase, rawPhase) {
  if (!detail) return "";
  if (detail === phase || detail === rawPhase) return "";
  return detail;
}

export function humanizeLiveActivity(activity = {}, { isStreamingText = false } = {}) {
  if (isStreamingText) {
    return { phase: "正在生成回复…", detail: "" };
  }

  const rawPhase = String(activity?.phase || "").trim();
  const rawText = String(activity?.text || "").trim();

  let detail = "";
  if (rawText && !RAW_STATUS_NOISE_RE.test(rawText) && !/[\r\n]/.test(rawText) && rawText.length <= 90) {
    detail = rawText.length > 60 ? `${rawText.slice(0, 60).trim()}…` : rawText;
  }

  if (!rawPhase) {
    return { phase: "正在处理…", detail };
  }

  if (/^准备工具(?:\s+(.*))?$/.test(rawPhase)) {
    const toolPart = rawPhase.replace(/^准备工具\s*/, "").trim();
    const mapped = toolPart ? mapEnglishPhaseToChinese(toolPart, extractShortFileFromPhase(toolPart)) : "正在执行操作…";
    return { phase: mapped, detail: cleanDisplayDetail(detail, mapped, rawPhase) };
  }

  if (/[\u4e00-\u9fff]/.test(rawPhase)) {
    return {
      phase: rawPhase,
      detail: detail === rawPhase ? "" : detail,
    };
  }

  const shortFile = extractShortFileFromPhase(rawPhase);
  const phase = mapEnglishPhaseToChinese(rawPhase, shortFile);
  return {
    phase,
    detail: cleanDisplayDetail(detail, phase, rawPhase),
  };
}

export function bindFollowIntent(target, { pause, settle }) {
  if (!target) return () => {};
  let lastUpwardScrollAt = 0;
  let scrollSettleTimer = null;
  const settledUnlessRecentlyScrollingUp = () => {
    if (Date.now() - lastUpwardScrollAt < 280) return;
    settle();
  };
  const onWheel = (event) => {
    const dy = Number(event?.deltaY) || 0;
    if (dy < -1) {
      lastUpwardScrollAt = Date.now();
      if (scrollSettleTimer) {
        clearTimeout(scrollSettleTimer);
        scrollSettleTimer = null;
      }
      pause();
      return;
    }
    pause();
    if (dy > 1) {
      settledUnlessRecentlyScrollingUp();
    }
  };
  const onScroll = () => {
    if (scrollSettleTimer) clearTimeout(scrollSettleTimer);
    scrollSettleTimer = setTimeout(() => {
      scrollSettleTimer = null;
      settledUnlessRecentlyScrollingUp();
    }, 60);
  };
  const settleFromKeyboard = (event) => {
    if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
      lastUpwardScrollAt = Date.now();
      pause();
      return;
    }
    if (["ArrowDown", "PageDown", "End", " "].includes(event.key)) {
      settledUnlessRecentlyScrollingUp();
    }
  };
  target.addEventListener("wheel", onWheel, { passive: true });
  target.addEventListener("scroll", onScroll, { passive: true });
  target.addEventListener("touchstart", pause, { passive: true });
  target.addEventListener("touchend", settledUnlessRecentlyScrollingUp, { passive: true });
  target.addEventListener("pointerdown", pause, { passive: true });
  target.addEventListener("pointerup", settledUnlessRecentlyScrollingUp, { passive: true });
  target.addEventListener("keyup", settleFromKeyboard);
  return () => {
    if (scrollSettleTimer) clearTimeout(scrollSettleTimer);
    target.removeEventListener("wheel", onWheel);
    target.removeEventListener("scroll", onScroll);
    target.removeEventListener("touchstart", pause);
    target.removeEventListener("touchend", settledUnlessRecentlyScrollingUp);
    target.removeEventListener("pointerdown", pause);
    target.removeEventListener("pointerup", settledUnlessRecentlyScrollingUp);
    target.removeEventListener("keyup", settleFromKeyboard);
  };
}
