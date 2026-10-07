#!/usr/bin/env python3
"""Drive the linux-use MCP for the RC-023 first-session proof.

On a real X11 display inside the container this proves the first-session path:
doctor reports the native tools, list_windows finds the target window,
screenshot returns real pixels plus a state token, a click focuses a field and
typing changes that window's pixels, and an obsolete target (stale token or a
foreign window id) is refused.

The X window title is not used as the readback: this Chromium build does not
propagate document.title to the window name, so the effect of typed input is
verified from the window's real pixels (its state token) instead.
"""
import base64
import hashlib
import json
import os
import subprocess
import sys
import time

SERVER = os.environ.get("LINUX_USE_SERVER", "/opt/linux-use/server.py")
TITLE_MATCH = os.environ.get("RC023_TITLE_MATCH", "RC023")
CLICK_TEXT = os.environ.get("RC023_TEXT", "rc023-note")
CLICK_X = int(os.environ.get("RC023_CLICK_X", "440"))
CLICK_Y = int(os.environ.get("RC023_CLICK_Y", "250"))

proc = subprocess.Popen([sys.executable, SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE, text=True, bufsize=1)
counter = 0
results = {}


def park_pointer():
    """Keep the pointer off the target before an input action.

    xdotool 'mousemove --sync' blocks forever when the pointer is already at
    the destination because no motion event is generated. Parking the pointer
    first makes the warp observable and keeps hover state out of screenshots,
    so a state token stays valid until the window really changes.
    """
    subprocess.run(["xdotool", "mousemove", "960", "660"], check=False, env=os.environ)


def call(method, params=None):
    global counter
    counter += 1
    message = {"jsonrpc": "2.0", "id": counter, "method": method}
    if params is not None:
        message["params"] = params
    proc.stdin.write(json.dumps(message) + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    if not line:
        raise RuntimeError(f"linux-use closed before answering {method}")
    response = json.loads(line)
    if "error" in response:
        return {"error": response["error"]}
    return response["result"]


def tool(name, arguments):
    result = call("tools/call", {"name": name, "arguments": arguments})
    if "error" in result:
        return {"error": result["error"]}
    text = result["content"][-1]["text"]
    is_error = bool(result.get("isError"))
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        payload = text
    return {"isError": is_error, "payload": payload, "content": result["content"]}


def windows():
    out = tool("list_windows", {})
    payload = out.get("payload")
    if isinstance(payload, dict) and "windows" in payload:
        return payload["windows"]
    if isinstance(payload, list):
        return payload
    raise RuntimeError(f"unexpected list_windows payload: {payload}")


def fail(message):
    print(json.dumps({"ok": False, "stage": message}))
    sys.exit(1)


def shot(target):
    out = tool("screenshot", {"target_pid": target["pid"], "target_window_id": target["window_id"]})
    if out.get("isError"):
        fail(f"screenshot refused: {out.get('payload')}")
    image = next((block for block in out["content"] if block.get("type") == "image"), None)
    if not image:
        fail("screenshot returned no image")
    raw = base64.b64decode(image["data"])
    if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
        fail("screenshot is not a PNG")
    metadata = json.loads(out["content"][-1]["text"])
    return {"png": raw, "sha256": hashlib.sha256(raw).hexdigest(), "token": metadata["state_token"]}


def click(target, token):
    out = tool("left_click", {"target_pid": target["pid"], "target_window_id": target["window_id"],
                              "expected_state_token": token, "coordinate": [CLICK_X, CLICK_Y]})
    return out


call("initialize")
doctor = tool("doctor", {})
if doctor.get("isError"):
    fail(f"doctor failed: {doctor.get('payload')}")
supported = doctor["payload"].get("supported_native_tools", [])
for required in ("list_windows", "screenshot", "left_click", "type"):
    if required not in supported:
        fail(f"doctor did not report {required}: {supported}")
results["doctor_supported"] = supported

target = next((w for w in windows() if TITLE_MATCH in str(w.get("title", ""))), None)
if not target:
    fail(f"no window matching {TITLE_MATCH}")
results["target"] = target


def wait_stable(target, stable=4, attempts=60):
    """Wait until the window holds the same observation for several samples.

    Chromium keeps repainting for a while after the window is mapped; acting
    before it settles makes a fresh state token look stale.
    """
    park_pointer()
    previous = shot(target)
    streak = 1
    for _ in range(attempts):
        time.sleep(0.5)
        park_pointer()
        current = shot(target)
        streak = streak + 1 if current["sha256"] == previous["sha256"] else 1
        previous = current
        if streak >= stable:
            return current
    fail("target window never settled to a stable observation")


# Observe the real state, then click the field inside the target window.
before = wait_stable(target)
results["screenshot_before"] = {"bytes": len(before["png"]), "sha256": before["sha256"][:16]}

park_pointer()
clicked = click(target, before["token"])
if clicked.get("isError"):
    fail(f"left_click refused: {clicked.get('payload')}")
results["left_click"] = clicked["payload"]

# Type a harmless marker; it must change the real window pixels.
focused = wait_stable(target)
park_pointer()
typed = tool("type", {"target_pid": target["pid"], "target_window_id": target["window_id"],
                      "expected_state_token": focused["token"], "text": CLICK_TEXT})
if typed.get("isError"):
    fail(f"type refused: {typed.get('payload')}")
results["type"] = typed["payload"]

after = wait_stable(target)
results["screenshot_after"] = {"bytes": len(after["png"]), "sha256": after["sha256"][:16]}
if after["sha256"] == before["sha256"]:
    fail("typing did not change the target window pixels")
if after["sha256"] == focused["sha256"]:
    fail("typing did not change the focused target state")

# Obsolete target: the pre-typing state token must now be rejected.
park_pointer()
stale = click(target, focused["token"])
results["stale_token_rejected"] = bool(stale.get("isError"))
if not stale.get("isError"):
    fail("a stale state token was accepted")

# Obsolete target: a foreign window id must be rejected.
foreign_id = next((w["window_id"] for w in windows() if w["window_id"] != target["window_id"]), None)
if foreign_id is None:
    results["foreign_window"] = "single-window desktop; used stale token only"
else:
    foreign = tool("type", {"target_pid": target["pid"], "target_window_id": foreign_id,
                            "expected_state_token": after["token"], "text": "should-not-apply"})
    results["foreign_window_rejected"] = bool(foreign.get("isError"))
    if not foreign.get("isError"):
        fail("an action on a foreign window was accepted")

results["unchanged_by_typing"] = CLICK_TEXT not in json.dumps(results["target"])
print(json.dumps({"ok": True, "results": results}))
