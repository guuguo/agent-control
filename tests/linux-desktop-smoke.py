"""在 Xvfb 中运行真正的 GTK/WebKit；HTTP fixture 不连接任何模型。"""
import functools
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import traceback

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("linux_desktop", ROOT / "desktop/linux/agent-control.py")
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)
Gdk, Gio, GLib, Gtk, WebKit2 = desktop.Gdk, desktop.Gio, desktop.GLib, desktop.Gtk, desktop.WebKit2


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(200)
        if self.path == "/download":
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Disposition", 'attachment; filename="result.txt"')
            content = b"download fixture\n"
        elif self.path == "/health":
            self.send_header("Content-Type", "application/json")
            content = b'{"ok":true}'
        else:
            self.send_header("Content-Type", "text/html; charset=utf-8")
            content = (f'<title>{self.path}</title><h1>Agent Control — Linux</h1>'
                       '<a id="next" href="/details">Details</a> '
                       '<a id="popup" href="/popup" target="_blank">Open window</a> '
                       '<a id="external" href="https://example.com/">External</a> '
                       '<a id="download" href="/download" download>Download</a>').encode()
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


with tempfile.TemporaryDirectory(prefix="agent-control-linux-desktop-") as tmp:
    tmp = Path(tmp)
    home = tmp / "home with spaces"
    home.mkdir()
    env = {**os.environ, "HOME": str(home), "XDG_DATA_HOME": str(home / "data with spaces"), "PORT": "45432"}
    subprocess.run(["bash", str(ROOT / "desktop/linux/install-app.sh")], env=env, check=True)
    entry = Path(env["XDG_DATA_HOME"]) / "applications/com.guuguo.AgentControl.desktop"
    subprocess.run(["desktop-file-validate", str(entry)], check=True)
    info = Gio.DesktopAppInfo.new_from_filename(str(entry))
    assert info is not None
    launcher = home / ".local/bin/agent-control-desktop"
    _, command = GLib.shell_parse_argv(info.get_commandline())
    assert command == [str(launcher)], command
    subprocess.run([*command, "--check"], env=env, check=True)
    assert (Path(env["XDG_DATA_HOME"]) / "icons/hicolor/scalable/apps/agent-control.svg").exists()
    print("PASS: 桌面入口、带空格路径与启动器", flush=True)

    os.environ["AGENT_CONTROL_DATA_DIR"] = str(tmp / "runtime")
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    app = desktop.AgentControl(f"http://127.0.0.1:{server.server_port}/")
    state = {"step": 0, "error": None, "external": [], "download": False}

    def guarded(callback):
        @functools.wraps(callback)
        def run(*args):
            try:
                return callback(*args)
            except Exception:
                state["error"] = traceback.format_exc()
                app.quit()
                return False
        return run

    def click(selector):
        app.web.evaluate_javascript(f"document.querySelector('{selector}').click()", -1, None, None, None, None, None)

    @guarded
    def loaded(_web, event):
        if event != WebKit2.LoadEvent.FINISHED:
            return
        # load-finished 时 title 属性通知可能尚未到达，直接读取已加载的 DOM。
        app.web.evaluate_javascript("document.title", -1, None, None, None, page_ready, None)

    @guarded
    def page_ready(web, result, _data):
        title = web.evaluate_javascript_finish(result).to_string()
        step = state["step"]
        if step == 0:
            assert title == "/", title
            assert not app.back.get_sensitive()
            width, height = app.window.get_size()
            screenshot = Gdk.pixbuf_get_from_window(app.window.get_window(), 0, 0, width, height)
            screenshot.savev("/tmp/agent-control-linux-desktop.png", "png", [], [])
            state["step"] = 1
            click("#next")
        elif step == 1:
            assert title == "/details", title
            assert app.back.get_sensitive()
            state["step"] = 2
            app.web.go_back()
        elif step == 2:
            assert title == "/", title
            state["step"] = 3
            click("#popup")
        elif step == 3:
            assert title == "/popup", title
            print("PASS: 原生窗口、网页加载、返回和 target=_blank", flush=True)
            state["step"] = 4
            click("#external")
            GLib.timeout_add(100, after_external)

    @guarded
    def after_external():
        if not state["external"]:
            return True
        assert state["external"] == ["https://example.com/"]
        assert app.web.get_title() == "/popup"
        print("PASS: 站外链接交给系统浏览器", flush=True)
        click("#download")
        GLib.timeout_add(100, choose_download)
        return False

    @guarded
    def choose_download():
        for window in Gtk.Window.list_toplevels():
            if isinstance(window, Gtk.FileChooserDialog) and window.get_visible():
                window.set_current_folder(str(tmp))
                window.set_current_name("saved-result.txt")
                # 文件选择器异步读取目录，等下一轮事件后确认保存。
                GLib.timeout_add(500, lambda: window.response(Gtk.ResponseType.ACCEPT))
                GLib.timeout_add(100, finish_download)
                return False
        return True

    @guarded
    def finish_download():
        file = tmp / "saved-result.txt"
        if not file.exists() or file.read_bytes() != b"download fixture\n":
            return True
        state["download"] = True
        print("PASS: 原生保存对话框与实际下载内容", flush=True)
        app.quit()
        return False

    def timeout():
        state["error"] = f"原生冒烟超时，步骤 {state['step']}"
        app.quit()
        return False

    def activated(_app):
        app.web.connect("load-changed", loaded)

    app.connect_after("activate", activated)
    app.open_external = state["external"].append
    GLib.timeout_add_seconds(40, timeout)
    assert app.run(["linux-desktop-smoke"]) == 0
    assert state["error"] is None, state["error"]
    assert state["download"]
    # 退出壳以后 HTTP 后台仍能响应，没有向 systemd 发出 stop/restart。
    with desktop.urlopen(app.url + "health", timeout=2) as response:
        assert response.status == 200
    print("PASS: 关闭桌面窗口不关闭后台", flush=True)
    server.shutdown()
