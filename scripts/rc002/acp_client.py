#!/usr/bin/env python3
"""Minimal but complete ACP stdio client for RC-002 Linux Distill proof.

Handles: initialize, session/new, session/prompt, session/cancel,
session/request_permission, fs/*, terminal/*, and all session/update
notifications. Writes a full JSON transcript to --transcript.
"""
import argparse, json, os, subprocess, sys, threading, time, uuid

def log(f, *a):
    msg = " ".join(str(x) for x in a)
    print(msg, file=sys.stderr, flush=True)
    f.write(msg + "\n"); f.flush()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", required=True)
    ap.add_argument("--cwd", required=True)
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--transcript", required=True)
    ap.add_argument("--timeout", type=float, default=300)
    ap.add_argument("--interrupt-after", type=float, default=0)
    ap.add_argument("--model", default="")
    ap.add_argument("--session-id", default="")
    ap.add_argument("--agent-arg", action="append", default=[])
    a = ap.parse_args()

    tr = open(a.transcript, "w")
    env = dict(os.environ)
    proc = subprocess.Popen([a.bin, "agent", "stdio"] + a.agent_arg, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            bufsize=1, cwd=a.cwd, env=env)
    procs = {}   # terminalId -> Popen
    results = {} # id -> response
    events = []
    lock = threading.Lock()

    def send(obj):
        obj.setdefault("jsonrpc", "2.0")
        proc.stdin.write(json.dumps(obj) + "\n"); proc.stdin.flush()
        tr.write("OUT " + json.dumps(obj) + "\n"); tr.flush()

    def handle_server_request(d):
        tr.write("REQ " + json.dumps(d) + "\n"); tr.flush()
        m = d["method"]; p = d.get("params", {})
        try:
            if m == "session/request_permission":
                opts = p.get("options", [])
                chosen = None
                for pref in ("allow_always", "allow_once"):
                    for o in opts:
                        if o.get("kind") == pref: chosen = o["optionId"]; break
                    if chosen: break
                if not chosen:
                    for o in opts:
                        if "allow" in (o.get("optionId","")+o.get("kind","")): chosen = o["optionId"]; break
                if not chosen and opts: chosen = opts[0]["optionId"]
                send({"id": d["id"], "result": {"outcome": {"outcome": "selected", "optionId": chosen}}})
            elif m == "fs/read_text_file":
                with open(p["path"], "r", errors="replace") as fh: content = fh.read()
                send({"id": d["id"], "result": {"content": content}})
            elif m == "fs/write_text_file":
                os.makedirs(os.path.dirname(p["path"]) or ".", exist_ok=True)
                with open(p["path"], "w") as fh: fh.write(p.get("content", ""))
                send({"id": d["id"], "result": {}})
            elif m == "terminal/create":
                cmds = p.get("command", "")
                args = p.get("args", [])
                cp = subprocess.Popen([cmds] + args, cwd=p.get("cwd") or a.cwd,
                                      stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                tid = str(uuid.uuid4()); procs[tid] = cp
                send({"id": d["id"], "result": {"terminalId": tid}})
            elif m == "terminal/output":
                cp = procs[p["terminalId"]]; out, _ = cp.communicate(timeout=1)
                send({"id": d["id"], "result": {"output": out, "truncated": False, "exitStatus": {"exitCode": cp.returncode}}})
            elif m == "terminal/wait_for_exit":
                cp = procs[p["terminalId"]]; cp.wait()
                send({"id": d["id"], "result": {"exitCode": cp.returncode}})
            elif m == "terminal/kill":
                procs[p["terminalId"]].kill(); send({"id": d["id"], "result": {}})
            elif m == "terminal/release":
                procs.pop(p["terminalId"], None); send({"id": d["id"], "result": {}})
            else:
                send({"id": d["id"], "error": {"code": -32601, "message": "client method not implemented: " + m}})
        except Exception as e:
            send({"id": d["id"], "error": {"code": -32603, "message": str(e)}})

    def reader():
        for line in proc.stdout:
            line = line.strip()
            if not line: continue
            tr.write("IN  " + line + "\n"); tr.flush()
            try: d = json.loads(line)
            except Exception: continue
            if d.get("method") == "session/update":
                ev = d.get("params", {}).get("update", {})
                events.append(ev)
                continue
            if d.get("method") and d.get("id") is not None:
                threading.Thread(target=handle_server_request, args=(d,), daemon=True).start()
                continue
            if d.get("id") is not None and ("result" in d or "error" in d):
                with lock: results[d["id"]] = d

    t = threading.Thread(target=reader, daemon=True); t.start()

    def call(method, params, timeout):
        rid = str(uuid.uuid4())
        send({"id": rid, "method": method, "params": params})
        end = time.time() + timeout
        while time.time() < end:
            with lock:
                if rid in results: return results.pop(rid)
            if proc.poll() is not None: return {"error": {"message": "agent exited", "code": proc.returncode}}
            time.sleep(0.05)
        return {"error": {"message": "client timeout after %ss" % timeout, "code": "timeout"}}

    log(tr, "== initialize ==")
    init = call("initialize", {"protocolVersion": 1,
                "clientCapabilities": {"fs": {"readTextFile": True, "writeTextFile": True}, "terminal": True},
                "clientInfo": {"name": "rc002-acp-client", "version": "1"}}, 60)
    log(tr, "initialize ->", json.dumps(init)[:200])

    new = call("session/new", {"cwd": a.cwd, "mcpServers": []}, 120)
    sid = (new.get("result") or {}).get("sessionId", "")
    if not sid:
        log(tr, "session/new FAILED:", json.dumps(new)); print("RESULT", json.dumps({"ok": False, "stage": "session/new", "response": new})); proc.terminate(); return 2
    log(tr, "session/new -> sessionId", sid)
    if a.model:
        call("session/set_model", {"sessionId": sid, "modelId": a.model}, 30)

    cancel_info = {"sentAt": None}
    if a.interrupt_after > 0:
        def doom():
            time.sleep(a.interrupt_after)
            cancel_info["sentAt"] = time.time()
            log(tr, "== session/cancel ==")
            send({"method": "session/cancel", "params": {"sessionId": sid}})
            # allow the agent to report the interrupted final state, then hard-stop
            time.sleep(30)
            if proc.poll() is None:
                log(tr, "== hard terminate after cancel grace ==")
                proc.terminate()
        threading.Thread(target=doom, daemon=True).start()

    log(tr, "== session/prompt ==")
    res = call("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": a.prompt}]}, a.timeout)
    summary = {"interrupted": cancel_info["sentAt"] is not None,
               "cancelSentAt": cancel_info["sentAt"],
               "ok": "result" in res,
               "sessionId": sid,
               "stopReason": (res.get("result") or {}).get("stopReason"),
               "response": res,
               "eventKinds": [e.get("sessionUpdate") for e in events]}
    log(tr, "prompt ->", json.dumps(summary)[:400])
    tr.close()
    try: proc.terminate()
    except Exception: pass
    print("RESULT " + json.dumps(summary))
    return 0 if summary["ok"] else 1

if __name__ == "__main__":
    sys.exit(main())
