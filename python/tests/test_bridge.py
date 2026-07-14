from __future__ import annotations

import io
import json

import pytest

from geoauto_u2.bridge import BridgeError, U2Bridge, serve


class FakeJsonRpc:
    def __init__(self) -> None:
        self.configurator = None

    def setConfigurator(self, value):  # noqa: N802 - mirrors uiautomator2 API
        self.configurator = value


class FakeDevice:
    def __init__(self) -> None:
        self.settings = {}
        self.jsonrpc = FakeJsonRpc()
        self.device_info = {"model": "test"}
        self.info = {"currentPackageName": "example.app"}
        self.current_package = "example.app"
        self.events = []

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

    def press(self, key):
        self.events.append(("press", key))

    def app_start(self, package, wait=False, use_monkey=False):
        self.events.append(("app_start", package, wait, use_monkey))

    def app_wait(self, package, timeout=20.0, front=False):
        self.events.append(("app_wait", package, timeout, front))
        return 123 if self.current_package == package else 0

    def app_current(self):
        return {"package": self.current_package, "activity": ".MainActivity", "pid": 123}


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
    bridge.dispatch("click", {"x": 10, "y": 20})
    bridge.dispatch("send_keys", {"text": "腹泻怎么办", "clear": True})
    bridge.dispatch("press", {"key": "back"})
    bridge.dispatch("app_start", {"package": "example.app"})

    assert ("click", 10.0, 20.0) in device.events
    assert ("set_input_ime", True) in device.events
    assert ("send_keys", "腹泻怎么办", True) in device.events
    assert ("press", "back") in device.events
    assert ("app_start", "example.app", True, False) in device.events
    assert ("app_wait", "example.app", 8.0, True) in device.events


def test_app_start_rejects_silent_launch_failure():
    device = FakeDevice()
    device.current_package = "com.huawei.android.launcher"
    bridge = U2Bridge(lambda serial: device)
    bridge.dispatch("connect", {"serial": "SERIAL"})

    with pytest.raises(BridgeError, match="前台应用"):
        bridge.dispatch("app_start", {"package": "example.app"})


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
