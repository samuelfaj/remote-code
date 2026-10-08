// RC-036 phase 1, inside the account container: a message carries an attachment,
// a run result carries the changed files and diff for that run, and the served
// diff is compared byte-for-byte with the workspace's own `git diff`.
import { setTimeout as delay } from "node:timers/promises";

const base = process.env.RC036_API ?? "http://127.0.0.1:3000";
const password = process.env.RC036_AUTH_PASSWORD ?? "";
const dataRoot = process.env.RC036_DATA_ROOT ?? "/var/lib/remotecode";
const record: any = { result: "unverified", scope: "RC-036 attachment stays in its thread, run diff matches the workspace" };
let cookie = "";

function local(command: string, cwd: string) {
  const result = Bun.spawnSync(["bash", "-lc", command], { cwd, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

export async function runInside() {
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
    });
    if (login.status !== 200) throw Error(`login_${login.status}`);
    cookie = login.headers.get("set-cookie")!.split(";")[0];

    const created = await api("/api/workspaces", "POST", { name: "rc036-journey" });
    if (created.status !== 201 && created.status !== 200) throw Error(`workspace_${created.status}_${JSON.stringify(created.body)}`);
    const workspaceId = created.body?.id ?? created.body?.workspace?.id;
    if (!workspaceId) throw Error(`workspace_id_missing_${JSON.stringify(created.body)}`);

    const folder = await api(`/api/workspaces/${workspaceId}/folder`, "POST", { requestId: crypto.randomUUID() });
    if (folder.status !== 200) throw Error(`folder_${folder.status}_${JSON.stringify(folder.body)}`);
    const folderPath = `${dataRoot}/workspaces/${workspaceId}`;

    // A real repository with a real change, so the diff is a real diff.
    local("git init -q . && git config user.email rc036@example.invalid && git config user.name rc036", folderPath);
    local("printf 'first line\\n' > notes.txt && git add notes.txt && git commit -qm one", folderPath);

    const threadA = await api(`/api/workspaces/${workspaceId}/threads`, "POST", { title: "Thread A" });
    if (threadA.status !== 201) throw Error(`thread_a_${threadA.status}_${JSON.stringify(threadA.body)}`);
    const threadB = await api(`/api/workspaces/${workspaceId}/threads`, "POST", { title: "Thread B" });
    if (threadB.status !== 201) throw Error(`thread_b_${threadB.status}`);

    const attached = await api(`/api/threads/${threadA.body.id}/messages`, "POST", { body: "here is the file", attachments: ["notes.txt"] });
    if (attached.status !== 201) throw Error(`message_${attached.status}_${JSON.stringify(attached.body)}`);
    const attachment = attached.body?.attachments?.[0];
    const onDisk = local("sha256sum notes.txt | cut -d' ' -f1", folderPath).out.trim();
    if (!attachment || attachment.path !== "notes.txt" || attachment.sha256 !== onDisk) {
      throw Error(`attachment_digest_${JSON.stringify(attachment)}_${onDisk}`);
    }

    // The attachment stays in its own thread.
    const threadBMessages = await api(`/api/threads/${threadB.body.id}/messages`);
    const aMessages = await api(`/api/threads/${threadA.body.id}/messages`);
    if ((threadBMessages.body?.messages ?? []).length !== 0) throw Error(`thread_b_not_empty_${JSON.stringify(threadBMessages.body)}`);
    if ((aMessages.body?.messages?.[0]?.attachments ?? []).length !== 1) throw Error("attachment_missing_from_its_thread");

    // Paths outside the workspace and paths that do not exist are refused.
    const escaped = await api(`/api/threads/${threadA.body.id}/messages`, "POST", { body: "escape", attachments: ["../escaped.txt"] });
    if (escaped.status !== 400) throw Error(`escaped_path_${escaped.status}_${JSON.stringify(escaped.body)}`);
    const missing = await api(`/api/threads/${threadA.body.id}/messages`, "POST", { body: "missing", attachments: ["not-there.txt"] });
    if (missing.status !== 404) throw Error(`missing_attachment_${missing.status}_${JSON.stringify(missing.body)}`);

    // The change the "request" asks for, made for real in the workspace.
    local("printf 'second line added by the change\\n' >> notes.txt", folderPath);
    const run = await api("/api/runs", "POST", { workspaceId, prompt: "apply the change and report it" });
    if (run.status !== 201 && run.status !== 200) throw Error(`run_${run.status}_${JSON.stringify(run.body)}`);
    const runId = run.body.id;

    let terminal = "";
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const state = await api(`/api/runs/${runId}`);
      terminal = state.body?.state ?? "";
      if (["completed", "failed", "interrupted"].includes(terminal)) break;
      await delay(500);
    }
    if (!terminal) throw Error("run_never_reached_a_terminal_state");

    const result = await api(`/api/threads/${threadA.body.id}/messages`, "POST", { body: "the change is done", runId });
    if (result.status !== 201) throw Error(`result_message_${result.status}_${JSON.stringify(result.body)}`);

    const messages = await api(`/api/threads/${threadA.body.id}/messages`);
    const resultMessage = (messages.body?.messages ?? []).find((message: any) => message.runId === runId);
    if (!resultMessage?.changes) throw Error(`result_message_has_no_changes_${JSON.stringify(messages.body).slice(0, 300)}`);

    // The served diff must be the workspace's own diff, not a reconstruction.
    const workspaceDiff = local("git diff -- notes.txt", folderPath).out;
    const servedDiff = resultMessage.changes.diff ?? "";
    if (servedDiff.trim() !== workspaceDiff.trim()) {
      throw Error(`served_diff_is_not_the_workspace_diff_${JSON.stringify(servedDiff).slice(0, 200)}_${JSON.stringify(workspaceDiff).slice(0, 200)}`);
    }
    if (!servedDiff.includes("second line added by the change")) throw Error("served_diff_missing_the_change");
    const changedPaths = (resultMessage.changes.files ?? []).map((file: any) => file.path);
    if (!changedPaths.includes("notes.txt")) throw Error(`changed_files_${JSON.stringify(changedPaths)}`);

    // The same run through its own route, and a run that is not this user's.
    const byRun = await api(`/api/runs/${runId}/changes`);
    if (byRun.status !== 200 || byRun.body?.diff?.trim() !== workspaceDiff.trim()) throw Error(`run_changes_${byRun.status}`);
    const unknownRun = await api(`/api/runs/${crypto.randomUUID()}/changes`);
    if (unknownRun.status !== 404) throw Error(`unknown_run_changes_${unknownRun.status}`);

    console.log(JSON.stringify({
      fixture: { workspaceId, folderPath, threadA: threadA.body.id, threadB: threadB.body.id, runId, runState: terminal },
      attachment: { path: attachment.path, sha256: attachment.sha256, size: attachment.size },
      isolation: { threadBMessageCount: 0, escapedPath: escaped.status, missingAttachment: missing.status },
      changes: { files: changedPaths, diffMatchesWorkspace: true, runRoute: byRun.status, unknownRun: unknownRun.status },
      result: "attachment_stayed_in_its_thread_and_the_served_diff_matched_the_workspace_passed",
    }));
  } catch (error) {
    record.error = String((error as Error)?.message ?? error);
    console.log(JSON.stringify(record));
    process.exitCode = 1;
  }
}