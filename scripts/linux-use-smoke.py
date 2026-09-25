#!/usr/bin/env python3
import json
import os
import selectors
import subprocess
import sys

server_path = os.environ.get("LINUX_USE_SERVER", "/opt/linux-use/server.py")
process = subprocess.Popen(
    [sys.executable, server_path],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.DEVNULL,
    text=True,
    bufsize=1,
)
selector = selectors.DefaultSelector()
selector.register(process.stdout, selectors.EVENT_READ)


def request(request_id, method, params=None):
    message = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        message["params"] = params
    process.stdin.write(json.dumps(message) + "\n")
    process.stdin.flush()
    if not selector.select(timeout=5):
        raise TimeoutError(f"linux-use did not answer {method}")
    response = json.loads(process.stdout.readline())
    if response.get("id") != request_id or "error" in response:
        raise RuntimeError(f"linux-use request failed: {method}")
    return response["result"]


try:
    server = request(1, "initialize")["serverInfo"]
    tools = request(2, "tools/list")["tools"]
    doctor = json.loads(request(3, "tools/call", {"name": "doctor", "arguments": {}})["content"][0]["text"])
    windows = json.loads(request(4, "tools/call", {"name": "list_windows", "arguments": {}})["content"][0]["text"])

    proof_window = next((window for window in windows if "RemoteCode Linux proof" in window["title"]), None)
    if server.get("name") != "linux-use" or not proof_window:
        raise RuntimeError("Expected linux-use and the guest RemoteCode window on X11")
    if doctor.get("platform") != "linux" or doctor.get("session_type") != "x11" or not doctor.get("display"):
        raise RuntimeError("linux-use did not confirm a live Linux X11 display")
    if not doctor.get("wmctrl"):
        raise RuntimeError("linux-use did not find wmctrl")

    offered_tools = {tool["name"] for tool in tools}
    for unsupported in ("screenshot", "left_click", "type"):
        if unsupported not in offered_tools or unsupported not in doctor.get("unsupported", []):
            raise RuntimeError(f"linux-use did not mark {unsupported} unsupported")

    target = {"target_pid": proof_window["pid"], "target_window_id": proof_window["window_id"]}
    unsupported_confirmed = []
    unsupported_arguments = {
        "screenshot": target,
        "left_click": {**target, "expected_state_token": "rc003-unsupported-check", "coordinate": [0, 0]},
        "type": {**target, "expected_state_token": "rc003-unsupported-check", "text": "RC003 unsupported probe"},
    }
    for request_id, name in enumerate(("screenshot", "left_click", "type"), start=5):
        if name in doctor.get("supported_native_tools", []):
            raise RuntimeError(f"Refusing to invoke {name}: doctor reports it as supported")
        result = request(request_id, "tools/call", {"name": name, "arguments": unsupported_arguments[name]})
        detail = " ".join(item.get("text", "") for item in result.get("content", []))
        if not result.get("isError") or not any(term in detail.lower() for term in ("unsupported", "unavailable", "no action was performed", "imagemagick")):
            raise RuntimeError(f"linux-use did not explicitly reject unsupported {name}")
        unsupported_confirmed.append(name)

    print(json.dumps({
        "server": server,
        "x11": {"platform": doctor["platform"], "session_type": doctor["session_type"], "wmctrl": doctor["wmctrl"]},
        "proof_window_found": True,
        "window_count": len(windows),
        "unsupported_confirmed": unsupported_confirmed,
    }, sort_keys=True))
finally:
    selector.close()
    process.terminate()
    process.wait(timeout=5)
