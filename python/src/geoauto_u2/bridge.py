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

from geoauto_u2.ocr import OcrService


class BridgeError(RuntimeError):
    """Raised when a bridge request is invalid or the device is unavailable."""


def _shell_output(device: Any, args: list[str]) -> str:
    result = device.shell(args)
    return str(getattr(result, "output", result) or "").strip()


def _device_lock_state(device: Any) -> dict[str, Any]:
    trust = _shell_output(device, ["dumpsys", "trust"])
    # The first deviceLocked value belongs to the current Android user. Ignore
    # later managed-profile values, which may stay locked independently.
    trust_match = re.search(r"\bdeviceLocked=(true|false|1|0)\b", trust, re.IGNORECASE)
    trust_locked = (
        trust_match.group(1).lower() in {"true", "1"} if trust_match else None
    )

    policy = _shell_output(device, ["dumpsys", "window", "policy"])
    patterns = (
        (r"\bmShowingLockscreen=(true|false)\b", "window_policy_showing_lockscreen"),
        (r"KeyguardServiceDelegate[\s\S]*?\bshowing=(true|false)\b", "window_policy_keyguard_delegate"),
        (r"\bmIsShowing=(true|false)\b", "window_policy_keyguard_monitor"),
    )
    policy_locked = None
    policy_method = None
    for pattern, method in patterns:
        match = re.search(pattern, policy, re.IGNORECASE)
        if match:
            policy_locked = match.group(1).lower() == "true"
            policy_method = method
            break
    # A trusted/non-secure keyguard may report deviceLocked=0 while its visible
    # lockscreen still covers every app. Treat either positive signal as locked.
    if policy_locked is True:
        return {"locked": True, "method": policy_method}
    if trust_locked is not None:
        return {"locked": trust_locked, "method": "dumpsys_trust_device_locked"}
    if policy_locked is not None:
        return {"locked": policy_locked, "method": policy_method}
    return {"locked": None, "method": "unknown"}


def _restore_stay_awake(device: Any, original_value: Any) -> None:
    if original_value is None or str(original_value).strip().lower() in {"", "null", "none"}:
        _shell_output(device, ["settings", "delete", "global", "stay_on_while_plugged_in"])
    else:
        _shell_output(
            device,
            ["settings", "put", "global", "stay_on_while_plugged_in", str(original_value).strip()],
        )


def configure_utf8_standard_streams(*streams: TextIO | None) -> None:
    """Keep the JSON-lines protocol UTF-8 on Windows redirected pipes."""
    for stream in streams:
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="strict")


class U2Bridge:
    def __init__(
        self,
        connector: Callable[[str], Any] = u2.connect,
        ocr_service: OcrService | None = None,
    ) -> None:
        self._connector = connector
        self._ocr_service = ocr_service or OcrService()
        self._device: Any | None = None
        self._serial: str | None = None

    def _require_device(self) -> Any:
        if self._device is None:
            raise BridgeError("uiautomator2 device is not connected")
        return self._device

    def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        if method == "ocr_recognize":
            return self._ocr_service.recognize(params)
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
                # Some Huawei WindowManager builds omit mCurrentFocus and
                # mFocusedApp entirely. Their `windows` dump is ordered from
                # top to bottom, so the first component-backed Activity window
                # is the foreground application window. System decorations
                # such as StatusBar/GestureNav do not contain a component.
                match = re.search(
                    r"^\s*Window #\d+ Window\{[^\n]*?\su\d+\s+"
                    r"([A-Za-z0-9._]+)/([A-Za-z0-9._$]*Activity[A-Za-z0-9._$]*)\}:",
                    output,
                    re.MULTILINE,
                )
            if not match:
                raise BridgeError("无法从系统窗口状态读取当前前台 Activity")
            return {"package": match.group(1), "activity": match.group(2)}
        if method == "prepare_device_power":
            original_raw = _shell_output(
                device, ["settings", "get", "global", "stay_on_while_plugged_in"]
            )
            original_value = None if original_raw.lower() in {"", "null", "none"} else original_raw
            info = device.info
            screen_was_on = bool(info.get("screenOn"))
            try:
                if not screen_was_on:
                    device.screen_on()
                # Android bitmask: AC=1, USB=2. Keep the device awake while it
                # is connected to the workstation without changing timeout.
                _shell_output(
                    device,
                    ["settings", "put", "global", "stay_on_while_plugged_in", "2"],
                )
                return {
                    "screen_was_on": screen_was_on,
                    "screen_on": bool(device.info.get("screenOn")),
                    "wake_performed": not screen_was_on,
                    "stay_awake_original": original_value,
                    "stay_awake_applied": "2",
                    "lock_state": _device_lock_state(device),
                }
            except Exception:
                _restore_stay_awake(device, original_value)
                raise
        if method == "device_lock_state":
            return _device_lock_state(device)
        if method == "restore_device_power":
            _restore_stay_awake(device, params.get("stay_awake_original"))
            return True
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
        if method == "set_focused_text":
            field = device(focused=True)
            if not field.exists(timeout=1.0):
                raise BridgeError("未找到当前聚焦的输入控件，已停止替换文本")
            field.set_text(str(params.get("text", "")))
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
        if method == "app_stop":
            package = str(params.get("package") or "").strip()
            if not package:
                raise BridgeError("app_stop requires a package")
            device.app_stop(package)
            return True
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
