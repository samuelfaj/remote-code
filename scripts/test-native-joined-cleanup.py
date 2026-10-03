"""Check the native runner's fail-closed cleanup without touching real resources."""
import argparse
import json
import pathlib
import subprocess
import textwrap

parser = argparse.ArgumentParser()
parser.add_argument("--work-dir", type=pathlib.Path, required=True)
args = parser.parse_args()
args.work_dir.mkdir(mode=0o700)
runner = pathlib.Path(__file__).with_name("run-mobile-native-test.sh").read_text()
cleanup = runner[runner.index("cleanup() {"):runner.index("trap 'cleanup $?'")]
container_id = "a" * 64
for case in ("inspect-failed", "malformed-record", "wrong-owner", "wrong-name", "state-unreadable", "container-list-unavailable", "volume-list-unavailable", "success"):
    directory = args.work_dir / case
    directory.mkdir(mode=0o700)
    cert = directory / "ca.pem"
    key = directory / "key.pem"
    cert.write_text("owned certificate")
    key.write_text("owned key")
    record = {"containerId": container_id, "name": "owned-api", "ownedDeviceId": ""}
    if case == "wrong-owner":
        record["ownedDeviceId"] = "another-device"
    if case == "wrong-name":
        record["name"] = "borrowed-api"
    if case in ("malformed-record", "wrong-owner", "wrong-name", "success"):
        (directory / "joined-current-container.json").write_text("{" if case == "malformed-record" else json.dumps(record))
    harness = textwrap.dedent("""\
        set -euo pipefail
        WORK_DIR="$1"; CASE="$2"; DOCKER_ID="$3"; DOCKER_NAME=owned-api
        JOINED_VOLUME=owned-volume; OWNED_DEVICE_ID=""; API_PID=""
        TLS_CERT="$WORK_DIR/ca.pem"; TLS_KEY="$WORK_DIR/key.pem"
        docker() {
          printf '%s\n' "$*" >> "$WORK_DIR/docker-calls.txt"
          case "$1" in
            inspect)
              [[ "$CASE" != inspect-failed ]] || return 1
              printf '%s /owned-api \n' "$DOCKER_ID" ;;
            exec)
              [[ "$CASE" != state-unreadable ]] || return 1
              printf '{"quickCheck":[{"quick_check":"ok"}]}\n' ;;
            rm) return 0 ;;
            ps) [[ "$CASE" != container-list-unavailable ]] ;;
            volume)
              case "$2" in inspect) printf '\n';; rm) return 0;; ls) [[ "$CASE" != volume-list-unavailable ]];; *) return 99;; esac ;;
            *) return 99 ;;
          esac
        }
        """) + cleanup + "\ncleanup 0\n"
    result = subprocess.run(["bash", "-c", harness, "cleanup-check", str(directory), case, container_id], capture_output=True, text=True)
    (directory / "stderr.txt").write_text(result.stderr)
    calls = (directory / "docker-calls.txt").read_text().splitlines() if (directory / "docker-calls.txt").exists() else []
    if case == "success":
        assert result.returncode == 0, (case, result.stderr)
        assert not cert.exists() and not key.exists()
        assert any(call.startswith("rm -f ") for call in calls)
        assert "volume rm owned-volume" in calls
        assert json.loads((directory / "joined-cleanup.json").read_text())["removed"] is True
    elif case in ("container-list-unavailable", "volume-list-unavailable"):
        assert result.returncode != 0 and not (directory / "joined-cleanup.json").exists(), (case, result.stderr)
        assert any(call.startswith("rm -f ") for call in calls), (case, calls)
        assert ("volume rm owned-volume" in calls) == (case == "volume-list-unavailable"), (case, calls)
        assert not cert.exists() and not key.exists()
    else:
        assert result.returncode != 0, (case, result.stderr)
        assert cert.read_text() == "owned certificate" and key.read_text() == "owned key", case
        assert not any(call.startswith("rm ") or call.startswith("volume rm ") for call in calls), (case, calls)
        if case in ("malformed-record", "wrong-owner", "wrong-name"):
            assert calls == [], (case, calls)
        assert (directory / "retained-linux-container.json").exists(), case
        assert (directory / "retained-joined-volume.json").exists(), case
    print(f"PASS {case}: actual runner cleanup, simulated Docker boundary")
