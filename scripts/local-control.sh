#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

if [ "$(uname -s)" != "Darwin" ]; then
  exec "$NODE_BIN" "$ROOT_DIR/scripts/service.mjs" "$@"
fi

PORT="${PORT:-43310}"
DATA_DIR="${AGENT_CONTROL_DATA_DIR:-$HOME/Library/Application Support/Agent Control}"
LABEL="${AGENT_CONTROL_LABEL:-agent-control}"
PLIST_PATH="$HOME/Library/LaunchAgents/com.guuguo.agent-control.plist"
LOG_DIR="$DATA_DIR/logs"

usage() {
  cat <<EOF
用法: $0 <run|install|restart|uninstall|status|logs>

  run        前台启动本地 Agent Control 服务 (默认端口 ${PORT})
  install    安装并启动 macOS LaunchAgent (开机自启)
  restart    重启已安装的 macOS LaunchAgent 常驻服务
  uninstall  停止并移除 macOS LaunchAgent
  status     查看本地服务运行状态与访问地址
  logs       查看 LaunchAgent 最近日志
EOF
}

cmd="${1:-run}"

case "$cmd" in
  run)
    exec "$NODE_BIN" "$ROOT_DIR/src/server.mjs"
    ;;
  install)
    mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
    cat >"$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.guuguo.agent-control</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT_DIR/src/server.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>$PORT</string>
    <key>AGENT_CONTROL_DATA_DIR</key>
    <string>$DATA_DIR</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/stderr.log</string>
</dict>
</plist>
EOF
    launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
    launchctl load "$PLIST_PATH"
    echo "已安装并启动 LaunchAgent: $PLIST_PATH"
    ;;
  restart)
    exec "$NODE_BIN" "$ROOT_DIR/scripts/service.mjs" restart
    ;;
  uninstall)
    launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
    rm -f "$PLIST_PATH"
    echo "已移除 LaunchAgent: $PLIST_PATH"
    ;;
  status)
    LEASE_FILE="$DATA_DIR/control-runtime.json"
    if [ -f "$LEASE_FILE" ]; then
      cat "$LEASE_FILE"
    else
      echo "未检测到运行中的 Agent Control 租约 ($LEASE_FILE)"
      exit 1
    fi
    ;;
  logs)
    tail -n 60 "$LOG_DIR/stdout.log" "$LOG_DIR/stderr.log" 2>/dev/null || echo "暂无日志"
    ;;
  *)
    usage
    exit 2
    ;;
esac
