from __future__ import annotations

import io
import json

from geoauto_u2.bridge import U2Bridge, serve


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
    assert ("app_start", "example.app", True, True) in device.events


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
