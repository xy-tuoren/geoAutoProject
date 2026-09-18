from __future__ import annotations

import io
import json

import pytest

from geoauto_u2.bridge import (
    APP_FOREGROUND_WAIT_S,
    BridgeError,
    U2Bridge,
    configure_utf8_standard_streams,
    parse_dumpsys_launcher_activity,
    parse_resolved_activity,
    serve,
)


class FakeJsonRpc:
    def __init__(self) -> None:
        self.configurator = None

    def setConfigurator(self, value):  # noqa: N802 - mirrors uiautomator2 API
        self.configurator = value


class FakeUiObject:
    def __init__(self, device) -> None:
        self.device = device

    def exists(self, timeout=None):
        self.device.events.append(("focused_exists", timeout))
        return True

    def set_text(self, text):
        self.device.events.append(("set_focused_text", text))


class FakeDevice:
    def __init__(self) -> None:
        self.settings = {}
        self.jsonrpc = FakeJsonRpc()
        self.device_info = {"model": "test"}
        self.info = {"currentPackageName": "example.app"}
        self.current_package = "example.app"
        self.screen_on_state = False
        self.stay_awake_value = "7"
        self.device_locked = True
        self.events = []

    def __call__(self, **selector):
        self.events.append(("selector", selector))
        return FakeUiObject(self)

    def dump_hierarchy(self, **kwargs):
        self.events.append(("dump_hierarchy", kwargs))
        return '<hierarchy rotation="0" />'

    def click(self, x, y):
        self.events.append(("click", x, y))

    def send_keys(self, text, clear=False):
        self.events.append(("send_keys", text, clear))

    def current_ime(self):
        return "original/.Ime"

    def set_input_ime(self, enabled=True):
        self.events.append(("set_input_ime", enabled))

    def shell(self, args):
        self.events.append(("shell", args))
        if args == ["settings", "get", "global", "stay_on_while_plugged_in"]:
            return type("ShellResult", (), {"output": self.stay_awake_value})()
        if args[:4] == ["settings", "put", "global", "stay_on_while_plugged_in"]:
            self.stay_awake_value = args[4]
            return type("ShellResult", (), {"output": ""})()
        if args == ["settings", "delete", "global", "stay_on_while_plugged_in"]:
            self.stay_awake_value = "null"
            return type("ShellResult", (), {"output": "Deleted 1 rows"})()
        if args == ["dumpsys", "trust"]:
            locked = 1 if self.device_locked else 0
            return type(
                "ShellResult",
                (),
                {"output": f'User "Owner" (id=0) (current): deviceLocked={locked}'},
            )()
        if args == ["dumpsys", "window", "windows"]:
            return type(
                "ShellResult",
                (),
                {
                    "output": "mObscuringWindow=Window{123 u0 example.app/example.app.MiniAppHostActivity0}"
                },
            )()
        if args[:3] == ["cmd", "package", "resolve-activity"]:
            package = args[-1]
            return type(
                "ShellResult",
                (),
                {"output": f"priority=0 preferredOrder=0 match=0x108000\n{package}/.MainActivity\n"},
            )()
        return type("ShellResult", (), {"output": ""})()

    def screen_on(self):
        self.events.append(("screen_on",))
        self.screen_on_state = True

    @property
    def info(self):
        return {
            "currentPackageName": "example.app",
            "screenOn": self.screen_on_state,
        }

    @info.setter
    def info(self, value):
        # Preserve compatibility with the simple fake's existing assignment.
        self._info = value

    def press(self, key):
        self.events.append(("press", key))

    def app_start(self, package, activity=None, wait=False, stop=False, use_monkey=False):
        self.events.append(("app_start", package, activity, wait, use_monkey))

    def app_stop(self, package):
        self.events.append(("app_stop", package))

    def app_wait(self, package, timeout=20.0, front=False):
        self.events.append(("app_wait", package, timeout, front))
        return 123 if self.current_package == package else 0

    def app_current(self):
        return {"package": self.current_package, "activity": ".MainActivity", "pid": 123}


class FakeOcrService:
    def __init__(self) -> None:
        self.params = None

    def recognize(self, params):
        self.params = params
        return {"engine": "fake", "results": [{"text": "小荷AI医生"}]}


def test_bridge_configures_dynamic_ui_timeouts_and_dispatches_commands():
    device = FakeDevice()
    bridge = U2Bridge(lambda serial: device)

    result = bridge.dispatch("connect", {"serial": "SERIAL"})
    assert result["serial"] == "SERIAL"
    assert device.settings["wait_timeout"] == 2.0
    assert device.jsonrpc.configurator == {
        "waitForIdleTimeout": 0,
        "waitForSelectorTimeout": 0,
    }

    assert bridge.dispatch("dump_hierarchy", {}) == '<hierarchy rotation="0" />'
    assert bridge.dispatch("current_app", {}) == {
        "package": "example.app",
        "activity": ".MainActivity",
        "pid": 123,
    }
    assert bridge.dispatch("foreground_window", {}) == {
        "package": "example.app",
        "activity": "example.app.MiniAppHostActivity0",
    }
    bridge.dispatch("click", {"x": 10, "y": 20})
    bridge.dispatch("send_keys", {"text": "腹泻怎么办", "clear": True})
    bridge.dispatch("set_focused_text", {"text": "腹泻怎么办"})
    bridge.dispatch("press", {"key": "back"})
    bridge.dispatch("app_start", {"package": "example.app"})
    bridge.dispatch("app_stop", {"package": "example.app"})

    assert ("click", 10.0, 20.0) in device.events
    assert ("set_input_ime", True) in device.events
    assert ("send_keys", "腹泻怎么办", True) in device.events
    assert ("selector", {"focused": True}) in device.events
    assert ("set_focused_text", "腹泻怎么办") in device.events
    assert ("press", "back") in device.events
    assert ("app_start", "example.app", ".MainActivity", False, False) in device.events
    assert ("app_wait", "example.app", APP_FOREGROUND_WAIT_S, True) in device.events
    assert ("app_stop", "example.app") in device.events


def test_bridge_wakes_device_sets_usb_stay_awake_and_restores_original_value():
    device = FakeDevice()
    bridge = U2Bridge(lambda serial: device)
    bridge.dispatch("connect", {"serial": "SERIAL"})

    prepared = bridge.dispatch("prepare_device_power", {})

    assert prepared == {
        "screen_was_on": False,
        "screen_on": True,
        "wake_performed": True,
        "stay_awake_original": "7",
        "stay_awake_applied": "2",
        "lock_state": {
            "locked": True,
            "method": "dumpsys_trust_device_locked",
        },
    }
    assert ("screen_on",) in device.events
    assert device.stay_awake_value == "2"

    device.device_locked = False
    assert bridge.dispatch("device_lock_state", {})["locked"] is False
    assert bridge.dispatch(
        "restore_device_power", {"stay_awake_original": prepared["stay_awake_original"]}
    ) is True
    assert device.stay_awake_value == "7"


def test_visible_keyguard_is_locked_even_when_trust_reports_device_unlocked():
    class TrustedLockscreenDevice(FakeDevice):
        def shell(self, args):
            if args == ["dumpsys", "window", "policy"]:
                return type(
                    "ShellResult",
                    (),
                    {"output": "KeyguardServiceDelegate\n  showing=true\n  secure=false"},
                )()
            return super().shell(args)

    device = TrustedLockscreenDevice()
    device.device_locked = False
    bridge = U2Bridge(lambda serial: device)
    bridge.dispatch("connect", {"serial": "SERIAL"})

    assert bridge.dispatch("device_lock_state", {}) == {
        "locked": True,
        "method": "window_policy_keyguard_delegate",
    }


def test_app_start_rejects_silent_launch_failure():
    device = FakeDevice()
    device.current_package = "com.huawei.android.launcher"
    bridge = U2Bridge(lambda serial: device)
    bridge.dispatch("connect", {"serial": "SERIAL"})

    with pytest.raises(BridgeError, match="前台应用"):
        bridge.dispatch("app_start", {"package": "example.app"})


def test_foreground_window_falls_back_to_huawei_z_ordered_window_list():
    class HuaweiDevice(FakeDevice):
        def shell(self, args):
            self.events.append(("shell", args))
            return type(
                "ShellResult",
                (),
                {
                    "output": """
Window #0 Window{15a3099 u0 GestureNavAnim}:
Window #7 Window{14b5771 u0 DockedStackDivider}:
Window #8 Window{15a31b9 u0 com.ss.android.article.news/com.android.bytedance.search.SearchActivity}:
Window #9 Window{14ab409 u0 com.ss.android.article.news/com.ss.android.article.news.activity.MainActivity}:
mObscuringWindow=null
"""
                },
            )()

    bridge = U2Bridge(lambda serial: HuaweiDevice())
    bridge.dispatch("connect", {"serial": "HUAWEI"})

    assert bridge.dispatch("foreground_window", {}) == {
        "package": "com.ss.android.article.news",
        "activity": "com.android.bytedance.search.SearchActivity",
    }


def test_ocr_is_device_independent_and_uses_structured_service():
    ocr = FakeOcrService()
    bridge = U2Bridge(lambda serial: FakeDevice(), ocr_service=ocr)

    result = bridge.dispatch("ocr_recognize", {"image_base64": "aW1hZ2U="})

    assert result == {"engine": "fake", "results": [{"text": "小荷AI医生"}]}
    assert ocr.params == {"image_base64": "aW1hZ2U="}


def test_protocol_returns_structured_errors_instead_of_hanging():
    output = io.StringIO()
    serve(
        io.StringIO('{"id":1,"method":"health","params":{}}\n'),
        output,
        U2Bridge(lambda serial: FakeDevice()),
    )
    response = json.loads(output.getvalue())
    assert response["id"] == 1
    assert response["ok"] is False
    assert response["error"]["type"] == "BridgeError"


def test_protocol_forces_utf8_when_windows_pipe_defaults_to_cp936():
    device = FakeDevice()
    requests = (
        '{"id":1,"method":"connect","params":{"serial":"SERIAL"}}\n'
        '{"id":2,"method":"send_keys","params":{"text":"测试","clear":false}}\n'
    ).encode("utf-8")
    input_stream = io.TextIOWrapper(io.BytesIO(requests), encoding="cp936")
    output_bytes = io.BytesIO()
    output_stream = io.TextIOWrapper(output_bytes, encoding="cp936")

    configure_utf8_standard_streams(input_stream, output_stream)
    serve(input_stream, output_stream, U2Bridge(lambda serial: device))
    output_stream.flush()

    assert ("send_keys", "测试", False) in device.events
    assert '"ok": true' in output_bytes.getvalue().decode("utf-8")


def test_parse_resolved_activity_reads_brief_component_line():
    output = (
        "priority=2000 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\n"
        "com.aurora.xiaohe.aidoctor/.splash.SplashActivity\n"
    )
    assert parse_resolved_activity(output, "com.aurora.xiaohe.aidoctor") == ".splash.SplashActivity"
    assert parse_resolved_activity("No activity found", "com.aurora.xiaohe.aidoctor") is None
    assert parse_resolved_activity(output, "com.other.app") is None


def test_parse_dumpsys_launcher_activity_prefers_nearby_launcher_component():
    output = """
Activity Resolver Table:
  Non-Data Actions:
      android.intent.action.MAIN:
        31c4d1c example.app/.SplashActivity filter 8a1b2c3
          Action: "android.intent.action.MAIN"
          Category: "android.intent.category.LAUNCHER"
        4ab12 example.app/.TvAlias filter 99aa
          Action: "android.intent.action.MAIN"
          Category: "android.intent.category.LEANBACK_LAUNCHER"
"""
    assert parse_dumpsys_launcher_activity(output, "example.app") == ".SplashActivity"
    assert parse_dumpsys_launcher_activity(output, "missing.app") is None


def test_app_start_resolves_launcher_activity_and_does_not_use_monkey():
    device = FakeDevice()
    bridge = U2Bridge(lambda serial: device)
    bridge.dispatch("connect", {"serial": "SERIAL"})

    result = bridge.dispatch("app_start", {"package": "example.app"})

    assert result["package"] == "example.app"
    assert result["launch_activity"] == ".MainActivity"
    assert ("app_start", "example.app", ".MainActivity", False, False) in device.events
    assert all(event[0] != "app_start" or event[4] is False for event in device.events if event[0] == "app_start")


def test_app_start_falls_back_to_dumpsys_when_resolve_activity_is_empty():
    class DumpsysOnlyDevice(FakeDevice):
        def shell(self, args):
            if args[:3] == ["cmd", "package", "resolve-activity"]:
                self.events.append(("shell", args))
                return type("ShellResult", (), {"output": "No activity found"})()
            if args[:2] == ["dumpsys", "package"]:
                self.events.append(("shell", args))
                return type(
                    "ShellResult",
                    (),
                    {
                        "output": (
                            "android.intent.action.MAIN:\n"
                            "  31c4d1c example.app/.SplashActivity filter\n"
                            '    Category: "android.intent.category.LAUNCHER"\n'
                        )
                    },
                )()
            return super().shell(args)

    device = DumpsysOnlyDevice()
    bridge = U2Bridge(lambda serial: device)
    bridge.dispatch("connect", {"serial": "SERIAL"})

    result = bridge.dispatch("app_start", {"package": "example.app"})

    assert result["launch_activity"] == ".SplashActivity"
    assert ("app_start", "example.app", ".SplashActivity", False, False) in device.events


def test_app_start_does_not_fall_back_to_monkey_when_activity_cannot_be_resolved():
    class NoLauncherDevice(FakeDevice):
        def shell(self, args):
            if args[:3] == ["cmd", "package", "resolve-activity"] or args[:2] == ["dumpsys", "package"]:
                self.events.append(("shell", args))
                return type("ShellResult", (), {"output": "No activity found"})()
            return super().shell(args)

    device = NoLauncherDevice()
    bridge = U2Bridge(lambda serial: device)
    bridge.dispatch("connect", {"serial": "SERIAL"})

    with pytest.raises(BridgeError, match="无法解析"):
        bridge.dispatch("app_start", {"package": "example.app"})
    assert not any(event[0] == "app_start" for event in device.events)
