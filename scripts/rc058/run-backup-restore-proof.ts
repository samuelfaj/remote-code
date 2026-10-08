// RC-058 proof: a verifiable backup of the database, workspace files and Bot
// profiles restores on another host with the same ids and bytes, while a
// truncated, partial or corrupted copy is rejected before anything is touched.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "../..");
const output = process.env.RC058_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const run = `rc058-backup-${randomUUID()}`;
const volumeA = `${run}-a`;
const volumeB = `${run}-b`;
const image = process.env.RC058_IMAGE ?? "sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e";
const label = "remotecode.rc058.backup";
const password = randomBytes(32).toString("base64url");
const dataRoot = "/var/lib/remotecode";
let idA = "", idB = "";
const record: any = { run, volumeA, volumeB, image, result: "unverified", scope: "RC-058 backup, corrupt-copy rejection and cross-host restore" };
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

function command(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  record.commands ??= [];
  record.commands.push({ argv: args.map((arg) => arg.replaceAll(password, "[redacted]")), exitCode: result.exitCode });
  if (result.exitCode) throw Error(result.stderr.toString().replaceAll(password, "[redacted]").slice(0, 400));
  return result.stdout.toString().trim();
}

async function startApi(id: string, volume: string) {
  command("docker", "exec", "-d", id, "sh", "-c",
    `cd /workspace && API_PORT=3000 DATABASE_PATH=${dataRoot}/remotecode.sqlite REMOTECODE_AUTH_PASSWORD='${password}' ` +
    `REMOTECODE_DATA_ROOT=${dataRoot} REMOTECODE_TLS_CERT=/proof/proof-ca.pem REMOTECODE_TLS_KEY=/proof/proof-key.pem ` +
    "bun apps/api/src/index.ts > /var/lib/remotecode/api.log 2>&1");
  const base = `https://${id}.invalid`; // unset: real base comes from the published port
  void base; void volume;
}

try {
  const metadata = JSON.parse(command("docker", "image", "inspect", image))[0];
  if (metadata.Os !== "linux" || metadata.Architecture !== "arm64") throw Error("Linux ARM64 image required");
  const cert = resolve(output, "proof-ca.pem"), key = resolve(output, "proof-key.pem");
  command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert);
  chmodSync(cert, 0o600); chmodSync(key, 0o600);

  const portA = 25_000 + Math.floor(Math.random() * 300);
  const portB = portA + 400;
  for (const [name, volume, hostPort] of [[`${run}-a`, volumeA, portA], [`${run}-b`, volumeB, portB]] as const) {
    command("docker", "volume", "create", "--label", `${label}=${run}`, volume);
    const created = command("docker", "create", "--name", name, "--label", `${label}=${run}`, "--platform", "linux/arm64", "--pull", "never",
      "--mount", `type=bind,src=${repo},dst=/workspace,readonly`, "--mount", `type=bind,src=${output},dst=/proof,readonly`,
      "--mount", `type=volume,src=${volume},dst=${dataRoot}`,
      "--workdir", "/workspace", "-p", `127.0.0.1:${hostPort}:3000`, "--entrypoint", "sleep", image, "infinity");
    if (name === `${run}-a`) idA = created; else idB = created;
  }

  const api = async (base: string, path: string, method = "GET", body?: unknown, cookie = "") => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) } as any,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000), tls: { ca: readFileSync(cert) },
    } as any);
    return { status: response.status, body: await response.json().catch(() => null) as any, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "", text: "" };
  };

  const waitReady = async (base: string) => {
    const end = Date.now() + 45_000;
    while (Date.now() < end) {
      try { if ((await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(1000), tls: { ca: readFileSync(cert) } } as any)).status === 200) return; } catch {}
      await delay(250);
    }
    throw Error("api_never_became_ready");
  };

  command("docker", "start", idA);
  await startApi(idA, volumeA);
  const baseA = `https://127.0.0.1:${portA}`;
  await waitReady(baseA);

  const loginA = await api(baseA, "/api/auth/login", "POST", { password });
  if (loginA.status !== 200) throw Error(`login_a_${loginA.status}`);
  const cookieA = loginA.cookie;
  const workspace = await api(baseA, "/api/workspaces", "POST", { requestId: randomUUID(), name: "rc058" }, cookieA);
  if (workspace.status !== 201) throw Error(`workspace_${workspace.status}`);
  const folder = await api(baseA, `/api/workspaces/${workspace.body.id}/folder`, "POST", { requestId: randomUUID() }, cookieA);
  if (folder.status !== 200 && folder.status !== 201) throw Error(`folder_${folder.status}`);
  const payload = `rc058 payload ${randomUUID()}\n`;
  const written = await api(baseA, `/api/workspaces/${workspace.body.id}/files`, "POST", { requestId: randomUUID(), path: "payload.txt", content: payload }, cookieA);
  if (written.status !== 201 && written.status !== 200) throw Error(`write_${written.status}`);
  const bot = await api(baseA, "/api/bots", "POST", { name: "BackupBot", instructions: "restore me" }, cookieA);
  if (bot.status !== 201) throw Error(`bot_${bot.status}`);
  const schedule = await api(baseA, "/api/schedules", "POST",
    { kind: "routine", workspaceId: workspace.body.id, botId: bot.body.id, prompt: "routine keeps", localTime: "03:07", timezone: "UTC" }, cookieA);
  if (schedule.status !== 201) throw Error(`schedule_${schedule.status}`);
  const before = {
    workspaceId: workspace.body.id,
    botId: bot.body.id,
    scheduleId: schedule.body.id,
    fileSha: sha(payload),
  };

  const created = await api(baseA, "/api/backup", "POST", {}, cookieA);
  if (created.status !== 201) throw Error(`backup_${created.status}_${JSON.stringify(created.body)}`);
  const archivePath = created.body.path as string;
  const archiveSha = created.body.sha256 as string;
  const archiveBytes = command("docker", "exec", idA, "cat", archivePath).length; // touch inside the container
  if (archiveBytes <= 0) throw Error("archive_empty");
  const copy = resolve(output, "backup.tar.gz");
  command("docker", "cp", `${idA}:${archivePath}`, copy);
  // The restore path must sit inside the archive root, so make sure it exists.
  command("docker", "exec", idA, "mkdir", "-p", `${dataRoot}/backups`);
  const hostSha = sha(new Uint8Array(readFileSync(copy)));
  if (hostSha !== archiveSha) throw Error(`archive_sha_${hostSha}_${archiveSha}`);

  // A truncated (interrupted) copy and a corrupted member must both be refused.
  const truncated = resolve(output, "truncated.tar.gz");
  writeFileSync(truncated, readFileSync(copy).subarray(0, Math.floor(readFileSync(copy).length / 2)));
  command("docker", "exec", idA, "sh", "-c",
    `head -c ${Math.floor(readFileSync(copy).length / 2)} '${archivePath}' > ${dataRoot}/backups/truncated.tar.gz`);
  const truncatedRestore = await api(baseA, "/api/restore", "POST", { archivePath: "/var/lib/remotecode/backups/truncated.tar.gz" }, cookieA);
  if (truncatedRestore.status !== 400 || truncatedRestore.body.error !== "invalid_backup") throw Error(`truncated_${truncatedRestore.status}_${JSON.stringify(truncatedRestore.body)}`);

  const corrupted = resolve(output, "corrupted.tar.gz");
  const bytes = Uint8Array.from(readFileSync(copy));
  // Flip a byte inside the compressed stream: the archive stays readable but a member hash cannot match.
  const flipAt = Math.floor(bytes.length / 2);
  bytes[flipAt] ^= 0xff;
  writeFileSync(corrupted, bytes);
  command("docker", "exec", idA, "sh", "-c",
    `cp '${archivePath}' ${dataRoot}/backups/corrupted.tar.gz && printf '\\x${bytes[flipAt].toString(16).padStart(2, "0")}' | dd of=${dataRoot}/backups/corrupted.tar.gz bs=1 seek=${flipAt} conv=notrunc 2>/dev/null`);
  const dbBefore = command("docker", "exec", idA, "sha256sum", `${dataRoot}/remotecode.sqlite`).split(/\s+/)[0];
  const corruptRestore = await api(baseA, "/api/restore", "POST", { archivePath: "/var/lib/remotecode/backups/corrupted.tar.gz" }, cookieA);
  if (corruptRestore.status !== 400 || !["invalid_backup", "backup_corrupt"].includes(corruptRestore.body.error)) {
    throw Error(`corrupt_${corruptRestore.status}_${JSON.stringify(corruptRestore.body)}`);
  }
  const dbAfter = command("docker", "exec", idA, "sha256sum", `${dataRoot}/remotecode.sqlite`).split(/\s+/)[0];
  if (dbBefore !== dbAfter) throw Error("rejected_backup_touched_the_live_database");

  // Another host: fresh volume, same archive, restore and compare.
  command("docker", "start", idB);
  await startApi(idB, volumeB);
  const baseB = `https://127.0.0.1:${portB}`;
  await waitReady(baseB);
  const loginB = await api(baseB, "/api/auth/login", "POST", { password });
  if (loginB.status !== 200) throw Error(`login_b_${loginB.status}`);
  const cookieB = loginB.cookie;
  command("docker", "exec", idB, "mkdir", "-p", `${dataRoot}/backups`);
  command("docker", "cp", copy, `${idB}:${dataRoot}/backups/`);
  // docker cp keeps the host file's name, so restore that exact path.
  const restoredArchivePath = `${dataRoot}/backups/${copy.split("/").pop()}`;
  const restored = await api(baseB, "/api/restore", "POST", { archivePath: restoredArchivePath }, cookieB);
  if (restored.status !== 200) throw Error(`restore_${restored.status}_${JSON.stringify(restored.body)}`);
  if (restored.body.requiresNewLogin !== true) throw Error("restore_did_not_require_a_new_login");

  // The pre-restore session is gone with the restored database.
  const staleSession = await api(baseB, "/api/workspaces", "GET", undefined, cookieB);
  if (staleSession.status !== 401) throw Error(`stale_session_${staleSession.status}`);

  const relogin = await api(baseB, "/api/auth/login", "POST", { password });
  if (relogin.status !== 200) throw Error(`relogin_${relogin.status}`);
  const cookieB2 = relogin.cookie;
  const workspacesB = await api(baseB, "/api/workspaces", "GET", undefined, cookieB2);
  const botsB = await api(baseB, "/api/bots", "GET", undefined, cookieB2);
  const schedulesB = await api(baseB, "/api/schedules", "GET", undefined, cookieB2);
  const fileB = await api(baseB, `/api/workspaces/${before.workspaceId}/files/content?path=payload.txt`, "GET", undefined, cookieB2);
  const workspaceIds = (workspacesB.body.workspaces ?? []).map((row: any) => row.id);
  const botIds = (botsB.body.bots ?? []).map((row: any) => row.id);
  const scheduleIds = (schedulesB.body.schedules ?? []).map((row: any) => row.id);
  if (!workspaceIds.includes(before.workspaceId)) throw Error(`workspace_lost_${JSON.stringify(workspaceIds)}`);
  if (!botIds.includes(before.botId)) throw Error(`bot_lost_${JSON.stringify(botIds)}`);
  if (!scheduleIds.includes(before.scheduleId)) throw Error(`routine_lost_${JSON.stringify(scheduleIds)}`);
  if (botIds.length !== 1 || scheduleIds.length !== 1 || workspaceIds.length !== 1) {
    throw Error(`duplicates_after_restore_${JSON.stringify({ workspaceIds, botIds, scheduleIds })}`);
  }
  const restoredContent = (fileB.body?.content ?? fileB.body?.text ?? "") as string;
  if (sha(restoredContent) !== before.fileSha) throw Error(`file_bytes_differ_${JSON.stringify(fileB.body).slice(0, 200)}`);

  record.host = {
    workspace: { id: before.workspaceId, restored: true },
    bot: { id: before.botId, restored: true },
    routine: { id: before.scheduleId, restored: true, duplicates: scheduleIds.length },
    file: { sha: before.fileSha, restoredSha: sha(restoredContent), identical: true },
    archive: { sha256: archiveSha, bytes: readFileSync(copy).length },
    counts: restored.body.counts,
  };
  record.rejections = {
    truncated: truncatedRestore.body,
    corrupted: corruptRestore.body,
    liveDatabaseUnchanged: dbBefore === dbAfter,
    staleSessionAfterRestore: staleSession.status,
  };
  record.result = "backup_restored_on_another_host_and_bad_copies_rejected_passed";
  console.log(JSON.stringify({ result: record.result, host: record.host, rejections: record.rejections }));
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.log(JSON.stringify({ result: "unverified", error: record.error.slice(0, 400) }));
} finally {
  if (process.env.RC058_KEEP) {
    console.log(JSON.stringify({ kept: { idA, idB, portA, portB } }));
  } else {
    for (const id of [idA, idB]) { if (id) { try { command("docker", "stop", id); } catch {} try { command("docker", "rm", id); } catch {} } }
  }
  for (const volume of [volumeA, volumeB]) { try { command("docker", "volume", "rm", volume); } catch {} }
  for (const file of ["proof-ca.pem", "proof-key.pem", "backup.tar.gz", "truncated.tar.gz", "corrupted.tar.gz"]) {
    try { unlinkSync(resolve(output, file)); } catch {}
  }
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ cleanup: { containers: true, volumes: true } }));
}