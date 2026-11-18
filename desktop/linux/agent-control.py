#!/usr/bin/env python3
"""Linux 原生窗口；控制台和任务生命周期仍由后台服务管理。"""
import os
from pathlib import Path
import subprocess
import sys
import threading
from urllib.parse import urlsplit
from urllib.request import urlopen

try:
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("Gdk", "3.0")
    gi.require_version("WebKit2", "4.1")
    from gi.repository import Gdk, Gio, GLib, Gtk, WebKit2
except (ImportError, ValueError) as error:
    print("缺少 Linux 桌面依赖：" + str(error), file=sys.stderr)
    print("Ubuntu/Debian: sudo apt install python3-gi gir1.2-gtk-3.0 gir1.2-webkit2-4.1", file=sys.stderr)
    print("Fedora: sudo dnf install python3-gobject gtk3 webkit2gtk4.1", file=sys.stderr)
    sys.exit(1)


class AgentControl(Gtk.Application):
    def __init__(self, url):
        super().__init__(application_id="com.guuguo.AgentControl", flags=Gio.ApplicationFlags.FLAGS_NONE)
        self.url = url
        self.window = None

    def do_activate(self):
        if self.window:
            self.window.present()
            return
        GLib.set_application_name("Agent Control")
        Gtk.Settings.get_default().set_property("gtk-application-prefer-dark-theme", True)
        self.window = Gtk.ApplicationWindow(application=self, title="Agent Control")
        self.window.set_default_size(1280, 840)
        self.window.set_size_request(760, 520)
        self.window.set_icon_name("agent-control")
        header = Gtk.HeaderBar(title="Agent Control", show_close_button=True)
        self.window.set_titlebar(header)

        self.back = self.button(header, "go-previous-symbolic", "返回（Alt+←）", lambda *_: self.web.go_back())
        self.button(header, "go-home-symbolic", "回到控制台", lambda *_: self.web.load_uri(self.url))
        self.button(header, "view-refresh-symbolic", "刷新（Ctrl+R）", lambda *_: self.reload())
        self.button(header, "web-browser-symbolic", "在浏览器打开", lambda *_: self.open_external(self.web.get_uri() or self.url), end=True)

        data = Path(os.environ.get("AGENT_CONTROL_DATA_DIR") or Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / "agent-control")
        manager = WebKit2.WebsiteDataManager(base_data_directory=str(data / "desktop/webkit"), base_cache_directory=str(data / "desktop/cache"))
        context = WebKit2.WebContext.new_with_website_data_manager(manager)
        context.connect("download-started", self.download_started)
        self.web = WebKit2.WebView.new_with_context(context)
        self.web.connect("decide-policy", self.decide_policy)
        self.web.connect("permission-request", self.permission_request)
        self.web.get_back_forward_list().connect("changed", lambda *_: self.back.set_sensitive(self.web.can_go_back()))
        self.web.connect("load-changed", self.load_changed)
        self.web.connect("load-failed", self.load_failed)
        self.back.set_sensitive(False)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.notice = Gtk.InfoBar(message_type=Gtk.MessageType.WARNING, show_close_button=True)
        self.notice.set_no_show_all(True)
        self.notice_label = Gtk.Label(label="", wrap=True)
        self.notice.get_content_area().add(self.notice_label)
        self.notice.get_content_area().show_all()
        self.notice.connect("response", lambda *_: self.notice.hide())
        box.pack_start(self.notice, False, False, 0)
        box.pack_start(self.web, True, True, 0)
        self.window.add(box)
        self.window.connect("key-press-event", self.key_press)
        self.window.show_all()
        # 仅在本机服务未就绪时尝试 start；从不 restart/stop 正在执行的任务。
        threading.Thread(target=self.load_console, daemon=True).start()

    @staticmethod
    def button(header, icon, tooltip, callback, end=False):
        button = Gtk.Button.new_from_icon_name(icon, Gtk.IconSize.BUTTON)
        button.set_tooltip_text(tooltip)
        button.connect("clicked", callback)
        (header.pack_end if end else header.pack_start)(button)
        return button

    def load_console(self):
        parsed = urlsplit(self.url)
        if parsed.hostname in ("127.0.0.1", "localhost", "::1"):
            try:
                with urlopen(f"{parsed.scheme}://{parsed.netloc}/health", timeout=2):
                    pass
            except OSError:
                try:
                    subprocess.run(["systemctl", "--user", "start", "agent-control.service"], timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                except (OSError, subprocess.TimeoutExpired):
                    pass
        GLib.idle_add(self.web.load_uri, self.url)

    def show_notice(self, message):
        self.notice_label.set_text(message)
        self.notice.show()

    def reload(self):
        if self.web.get_uri():
            self.web.reload()
        else:
            self.web.load_uri(self.url)

    def load_changed(self, _web, event):
        if event == WebKit2.LoadEvent.COMMITTED:
            self.notice.hide()

    def load_failed(self, _web, _event, _uri, error):
        if not error.matches(WebKit2.network_error_quark(), WebKit2.NetworkError.CANCELLED):
            self.show_notice("页面暂时无法打开。请确认后台服务已启动，再点击刷新。")
        return False

    def open_external(self, uri):
        try:
            Gtk.show_uri_on_window(self.window, uri, Gdk.CURRENT_TIME)
        except GLib.Error as error:
            self.show_notice("无法打开链接：" + error.message)

    def decide_policy(self, _web, decision, kind):
        if kind == WebKit2.PolicyDecisionType.RESPONSE:
            if not decision.is_mime_type_supported():
                decision.download()
                return True
            return False
        if kind not in (WebKit2.PolicyDecisionType.NAVIGATION_ACTION, WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION):
            return False
        action = decision.get_navigation_action()
        uri = action.get_request().get_uri()
        parsed = urlsplit(uri)
        home = urlsplit(self.url)
        if parsed.scheme in ("http", "https"):
            if (parsed.scheme, parsed.netloc) != (home.scheme, home.netloc):
                decision.ignore()
                self.open_external(uri)
                return True
            if kind == WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION:
                decision.ignore()
                self.web.load_uri(uri)
                return True
        elif parsed.scheme not in ("about", "blob", "data"):
            decision.ignore()
            if parsed.scheme in ("mailto", "tel"):
                self.open_external(uri)
            return True
        return False

    def download_started(self, _context, download):
        download.connect("decide-destination", self.download_destination)
        download.connect("failed", lambda _download, error: self.show_notice("下载未完成：" + error.message) if not error.matches(WebKit2.download_error_quark(), WebKit2.DownloadError.CANCELLED_BY_USER) else None)

    def permission_request(self, _web, request):
        # 语音输入需要原生授权入口；不静默允许麦克风或摄像头。
        if not isinstance(request, WebKit2.UserMediaPermissionRequest):
            return False
        devices = "麦克风和摄像头" if request.props.is_for_video_device else "麦克风"
        dialog = Gtk.MessageDialog(transient_for=self.window, modal=True, message_type=Gtk.MessageType.QUESTION, buttons=Gtk.ButtonsType.YES_NO, text=f"允许当前控制台使用{devices}吗？")
        dialog.format_secondary_text(self.web.get_uri() or self.url)
        response = dialog.run()
        dialog.destroy()
        (request.allow if response == Gtk.ResponseType.YES else request.deny)()
        return True

    def download_destination(self, download, filename):
        chooser = Gtk.FileChooserDialog(title="保存文件", parent=self.window, action=Gtk.FileChooserAction.SAVE)
        chooser.add_buttons("取消", Gtk.ResponseType.CANCEL, "保存", Gtk.ResponseType.ACCEPT)
        chooser.set_do_overwrite_confirmation(True)
        chooser.set_current_folder(GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) or str(Path.home()))
        chooser.set_current_name(Path(filename).name)
        if chooser.run() == Gtk.ResponseType.ACCEPT:
            download.set_allow_overwrite(True)
            download.set_destination(Path(chooser.get_filename()).as_uri())
        else:
            download.cancel()
        chooser.destroy()
        return True

    def key_press(self, _window, event):
        if event.state & Gdk.ModifierType.MOD1_MASK and event.keyval == Gdk.KEY_Left:
            self.web.go_back()
        elif event.state & Gdk.ModifierType.CONTROL_MASK and event.keyval in (Gdk.KEY_r, Gdk.KEY_R):
            self.reload()
        elif event.state & Gdk.ModifierType.CONTROL_MASK and event.keyval in (Gdk.KEY_q, Gdk.KEY_Q):
            self.quit()
        else:
            return False
        return True


if __name__ == "__main__":
    if "--check" in sys.argv:
        sys.exit(0)
    url = os.environ.get("AGENT_CONTROL_URL") or f"http://127.0.0.1:{os.environ.get('PORT', '43310')}/"
    if urlsplit(url).scheme not in ("http", "https") or not urlsplit(url).hostname:
        sys.exit("AGENT_CONTROL_URL 必须是 http(s) 地址")
    sys.exit(AgentControl(url).run([sys.argv[0]]))
