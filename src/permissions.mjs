export const PERMISSION_MODES = Object.freeze(["safe", "workspace", "full", "turbo", "plan"]);
export const DEFAULT_PERMISSION_MODE = "workspace";

export function normalizePermissionMode(mode, fallback = DEFAULT_PERMISSION_MODE) {
  const normalized = String(mode || "").trim().toLowerCase();
  if (PERMISSION_MODES.includes(normalized)) return normalized;
  return fallback;
}

export function isTurboPermissionMode(mode) {
  return normalizePermissionMode(mode) === "turbo";
}

export function isBypassPermissionMode(mode) {
  const normalized = normalizePermissionMode(mode);
  return normalized === "turbo" || normalized === "full";
}

export function codexExecutionPolicy(mode = "workspace") {
  switch (normalizePermissionMode(mode)) {
    case "safe":
    case "plan":
      return {
        approvalPolicy: "on-request",
        sandbox: "read-only",
        sandboxPolicy: { type: "readOnly" },
      };
    case "full":
    case "turbo":
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
    default:
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        sandboxPolicy: { type: "workspaceWrite" },
      };
  }
}

export function claudePermissionMode(mode = "workspace") {
  switch (normalizePermissionMode(mode)) {
    case "safe":
      return "default";
    case "plan":
      return "plan";
    case "full":
    case "turbo":
      return "bypassPermissions";
    default:
      return "acceptEdits";
  }
}

export function antigravityModeId(mode = "workspace") {
  switch (normalizePermissionMode(mode)) {
    case "safe":
      return "default";
    case "plan":
      return "plan";
    case "full":
    case "turbo":
      return "auto";
    default:
      return "accept-edits";
  }
}

export function grokPermissionArgs(mode = "workspace") {
  switch (normalizePermissionMode(mode)) {
    case "safe":
      return ["--permission-mode", "default"];
    case "plan":
      return ["--permission-mode", "plan"];
    case "full":
    case "turbo":
      return ["--always-approve"];
    default:
      return [
        "--permission-mode",
        "acceptEdits",
        "--allow",
        "Read(**)",
        "--allow",
        "Grep(**)",
        "--allow",
        "Edit(**)",
        "--allow",
        "Write(**)",
      ];
  }
}
