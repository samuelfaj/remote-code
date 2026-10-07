// RC-036 phase 2, after the API process has been restarted: the attachment and
// the run's changes must still be there, and must still belong to their thread.
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const base = process.env.RC036_API ?? "http://127.0.0.1:3000";
const password = process.env.RC036_AUTH_PASSWORD ?? "";
const threadA = process.env.RC036_THREAD_A ?? "";
const threadB = process.env.RC036_THREAD_B ?? "";
const runId = process.env.RC036_RUN_ID ?? "";
const folderPath = process.env.RC036_FOLDER ?? "";
const expectedSha = process.env.RC036_ATTACH_SHA ?? "";
const expectedSize = process.env.RC036_ATTACH_SIZE ?? "";
const record: any = { result: "unverified", scope: "RC-036 survives an API restart" };

function local(command: string, cwd: string) {
  const result = Bun.spawnSync(["bash", "-lc", command], { cwd, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  return result.stdout.toString();
}

export async function runInside() {
  try {
    let ready = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try { if ((await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(1500) })).status === 200) { ready = true; break; } } catch {}
      await delay(400);
    }
    if (!ready) throw Error("api_not_ready_after_restart");

    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
    });
    if (login.status !== 200) throw Error(`login_${login.status}`);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];

    const messages = await fetch(`${base}/api/threads/${threadA}/messages`, { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
    const body = await messages.json() as any;
    const list = body?.messages ?? [];
    const attached = list.find((message: any) => (message.attachments ?? []).length > 0);
    const result = list.find((message: any) => message.runId === runId);
    if (!attached) throw Error(`attachment_lost_after_restart_${JSON.stringify(body).slice(0, 300)}`);
    if (!result?.changes) throw Error(`changes_lost_after_restart_${JSON.stringify(body).slice(0, 300)}`);

    // The recorded digest is the file as it was when the message was written;
    // the workspace has changed since, so the check is that the record survived
    // unchanged and the file it points at is still readable.
    if (attached.attachments[0].sha256 !== expectedSha) throw Error(`attachment_digest_changed_${attached.attachments[0].sha256}_${expectedSha}`);
    if (String(attached.attachments[0].size) !== expectedSize) throw Error(`attachment_size_changed_${attached.attachments[0].size}_${expectedSize}`);
    if (!existsSync(`${folderPath}/notes.txt`)) throw Error("attachment_file_is_gone_from_the_workspace");

    const workspaceDiff = local("git diff -- notes.txt", folderPath);
    if ((result.changes.diff ?? "").trim() !== workspaceDiff.trim()) throw Error("diff_changed_after_restart");

    // The other thread still holds none of it.
    const other = await fetch(`${base}/api/threads/${threadB}/messages`, { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
    const otherBody = await other.json() as any;
    if ((otherBody?.messages ?? []).length !== 0) throw Error(`attachment_switched_thread_${JSON.stringify(otherBody).slice(0, 200)}`);

    // The run's changes are still reachable through the run route.
    const byRun = await fetch(`${base}/api/runs/${runId}/changes`, { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
    if (byRun.status !== 200) throw Error(`run_changes_after_restart_${byRun.status}`);

    console.log(JSON.stringify({
      result: "attachment_and_run_changes_survived_the_api_restart_passed",
      afterRestart: {
        messages: list.length,
        attachmentRecordUnchanged: true,
        attachmentFileStillReadable: true,
        diffStillMatchesWorkspace: true,
        otherThreadStillEmpty: true,
        runChangesRoute: byRun.status,
      },
    }));
  } catch (error) {
    record.error = String((error as Error)?.message ?? error);
    console.log(JSON.stringify(record));
    process.exitCode = 1;
  }
}