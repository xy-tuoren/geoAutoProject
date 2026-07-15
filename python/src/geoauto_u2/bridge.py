from __future__ import annotations

import json
import logging
import os
import re
import sys
import traceback
from collections.abc import Callable
from typing import Any, TextIO

import uiautomator2 as u2


class BridgeError(RuntimeError):
    """Raised when a bridge request is invalid or the device is unavailable."""


def configure_utf8_standard_streams(*streams: TextIO | None) -> None:
    """Keep the JSON-lines protocol UTF-8 on Windows redirected pipes."""
    for stream in streams:
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="strict")


class U2Bridge:
    def __init__(self, connector: Callable[[str], Any] = u2.connect) -> None:
        self._connector = connector
        self._device: Any | None = None
        self._serial: str | None = None

    def _require_device(self) -> Any:
        if self._device is None:
            raise BridgeError("uiautomator2 device is not connected")
        return self._device

    def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        if method == "connect":
            serial = str(params.get("serial") or "").strip()
            if not serial:
                raise BridgeError("connect requires a device serial")
            adb_path = str(params.get("adb_path") or "").strip()
            if adb_path:
                os.environ["ADBUTILS_ADB_PATH"] = adb_path
            self._device = self._connector(serial)
            self._serial = serial
            self._configure(self._device)
            return {"serial": serial, "device_info": self._device.device_info}

        device = self._require_device()
        if method == "health":
            return {"serial": self._serial, "info": device.info}
        if method == "current_app":
            return device.app_current()
        if method == "foreground_window":
            result = device.shell(["dumpsys", "window", "windows"])
            output = str(getattr(result, "output", result) or "")
            match = re.search(
                r"(?:mCurrentFocus|mObscuringWindow)=.*?\s([A-Za-z0-9._]+)/([A-Za-z0-9._$]+)",
                output,
            )
            if not match:
                raise BridgeError("无法从系统窗口状态读取当前前台 Activity")
            return {"package": match.group(1), "activity": match.group(2)}
        if method == "dump_hierarchy":
            return device.dump_hierarchy(
                compressed=bool(params.get("compressed", False)),
                pretty=False,
                max_depth=int(params.get("max_depth", 70)),
            )
        if method == "click":
            device.click(float(params["x"]), float(params["y"]))
            return True
        if method == "send_keys":
            # Install/select openatx FastInputIME before clearing so Compose is
            # never asked to execute clearTextField/setText through semantics.
            original_ime = device.current_ime()
            try:
                device.set_input_ime(True)
                device.send_keys(
                    str(params.get("text", "")),
                    clear=bool(params.get("clear", False)),
                )
            finally:
                if original_ime and device.current_ime() != original_ime:
                    device.shell(["ime", "set", original_ime])
            return True
        if method == "press":
            device.press(str(params["key"]))
            return True
        if method == "app_start":
            package = str(params.get("package") or "").strip()
            if not package:
                raise BridgeError("app_start requires a package")
            # Huawei's launcher/search can intercept the monkey-based launch.
            # uiautomator2 reports no error in that case, so use the resolved
            # Activity path and verify that the requested package is actually
            # in the foreground before allowing the workflow to continue.
            device.app_start(package, wait=True, use_monkey=False)
            pid = device.app_wait(package, timeout=8.0, front=True)
            current = device.app_current()
            if not pid or current.get("package") != package:
                actual = current.get("package") or "unknown"
                raise BridgeError(
                    f"应用启动后前台应用不正确：expected={package}, actual={actual}"
                )
            return current
        raise BridgeError(f"unknown bridge method: {method}")

    @staticmethod
    def _configure(device: Any) -> None:
        device.settings["wait_timeout"] = 2.0
        device.settings["max_depth"] = 70
        device.jsonrpc.setConfigurator(
            {"waitForIdleTimeout": 0, "waitForSelectorTimeout": 0}
        )


def serve(
    input_stream: TextIO = sys.stdin,
    output_stream: TextIO = sys.stdout,
    bridge: U2Bridge | None = None,
) -> None:
    bridge = bridge or U2Bridge()
    for raw_line in input_stream:
        line = raw_line.strip()
        if not line:
            continue
        request_id: Any = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            method = str(request.get("method") or "")
            params = request.get("params") or {}
            if not isinstance(params, dict):
                raise BridgeError("params must be an object")
            result = bridge.dispatch(method, params)
            response = {"id": request_id, "ok": True, "result": result}
        except Exception as error:  # noqa: BLE001 - protocol must report every failure
            traceback.print_exc(file=sys.stderr)
            response = {
                "id": request_id,
                "ok": False,
                "error": {"type": type(error).__name__, "message": str(error)},
            }
        output_stream.write(json.dumps(response, ensure_ascii=False) + "\n")
        output_stream.flush()


def main() -> None:
    configure_utf8_standard_streams(sys.stdin, sys.stdout, sys.stderr)
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    serve()


if __name__ == "__main__":
    main()
