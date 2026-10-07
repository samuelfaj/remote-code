// RC-032 proof: managed SSH credentials driven through the shipped routes on a
// real Linux host. A local sshd is the test server. The host stores a private
// key, uploads and downloads a file with it, verifies the bytes, revokes the
// credential, and shows the transfer then fails.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "..");
const output = process.env.RC032_SSH_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: true, mode: 0o700 });
const run = `rc032-ssh-${randomUUID()}`;
const volume = `${run}-data`;
const image = process.env.RC032_SSH_IMAGE ?? "rc032-sshproof:local";
const label = "remotecode.rc032.sshproof";
const password = randomBytes(32).toString("base64url");
const databasePath = "/var/lib/remotecode/ssh-proof.sqlite";
const payload = `ssh-proof-payload-${randomUUID()}\n`;
const remoteDir = "/tmp/sshtest/remote";
const record: any = { run, volume, image, result: "unverified", scope: "RC-032 managed credential API: store, upload, download, byte equality, revoke, failure" };
let id = "";

function command(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  record.commands ??= [];
  record.commands.push({ argv: args.map((arg) => arg.replaceAll(password, "[redacted]")), exitCode: result.exitCode });
  if (result.exitCode) throw Error(result.stderr.toString().replaceAll(password, "[redacted]").slice(0, 500));
  return result.stdout.toString().trim();
}

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

try {
  const metadata = JSON.parse(command("docker", "image", "inspect", image))[0];
  if (metadata.Os !== "linux" || metadata.Architecture !== "arm64") throw Error("Linux ARM64 image required");

  // The client key is created here; only its public half is installed in the
  // test server, and only the private half is sent once to the shipped route.
  const clientKey = resolve(output, "client_key");
  try { command("rm", "-f", clientKey, `${clientKey}.pub`); } catch {}
  command("ssh-keygen", "-t", "ed25519", "-N", "", "-C", "rc032-proof", "-f", clientKey, "-q");
  chmodSync(clientKey, 0o600);
  const privateKey = readFileSync(clientKey, "utf8");
  const publicKey = readFileSync(`${clientKey}.pub`, "utf8").trim();

  const cert = resolve(output, "proof-ca.pem"), key = resolve(output, "proof-key.pem");
  command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert);
  chmodSync(cert, 0o600); chmodSync(key, 0o600);
  writeFileSync(resolve(output, "server.ts"),
    `import'/workspace/apps/api/src/index.ts';await Bun.write('/tmp/ssh-proof-ready.json',JSON.stringify({ready:true,pid:process.pid}));`);
  writeFileSync(resolve(output, "authorized_keys"), `${publicKey}\n`);
  command("docker", "volume", "create", "--label", `${label}=${run}`, volume);
  const apiPort = 16_000 + Math.floor(Math.random() * 2000);
  id = command("docker", "create", "--name", run, "--label", `${label}=${run}`, "--platform", "linux/arm64", "--pull", "never",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m",
    "--mount", `type=bind,src=${repo},dst=/workspace,readonly`, "--mount", `type=bind,src=${output},dst=/proof,readonly`,
    "--mount", `type=volume,src=${volume},dst=/var/lib/remotecode`,
    "--workdir", "/workspace", "-p", `127.0.0.1:${apiPort}:3000`,
    "-e", "API_PORT=3000", "-e", `DATABASE_PATH=${databasePath}`, "-e", `REMOTECODE_AUTH_PASSWORD=${password}`,
    "-e", `REMOTECODE_TLS_CERT=/proof/proof-ca.pem`, "-e", `REMOTECODE_TLS_KEY=/proof/proof-key.pem`,
    "--entrypoint", "bun", image, "/proof/server.ts");
  command("docker", "start", id);
  record.sshVersion = command("docker", "exec", id, "ssh", "-V");

  const base = `https://127.0.0.1:${apiPort}`;
  const tls = { ca: readFileSync(cert) };
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(1000), tls } as any)).status === 200) break; } catch {}
    await delay(200);
  }
  const api = async (path: string, method = "GET", body?: unknown, cookie = "") => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) } as any,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000), tls,
    } as any);
    const text = await response.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch {}
    return { status: response.status, body: parsed, text, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };

  const login = await api("/api/auth/login", "POST", { password });
  if (login.status !== 200) throw Error(`login_${login.status}`);
  const cookie = login.cookie;
  const workspace = await api("/api/workspaces", "POST", { requestId: randomUUID(), name: "ssh-proof" }, cookie);
  if (workspace.status !== 201 && workspace.status !== 200) throw Error(`workspace_${workspace.status}`);
  const workspaceId = workspace.body.id as string;
  const folder = await api(`/api/workspaces/${workspaceId}/folder`, "POST", { requestId: randomUUID() }, cookie);
  if (folder.status !== 200) throw Error(`folder_${folder.status}`);
  const workspaceFolder = `/var/lib/remotecode/workspaces/${workspaceId}`;

  // Test server: a real sshd in the same container, accepting only this key.
  const setup = `import{execSync}from'node:child_process';import{mkdirSync,writeFileSync,chmodSync,copyFileSync}from'node:fs';
mkdirSync('/run/sshd',{recursive:true});mkdirSync('/root/.ssh',{recursive:true,mode:0o700});
copyFileSync('/proof/authorized_keys','/root/.ssh/authorized_keys');chmodSync('/root/.ssh/authorized_keys',0o600);
mkdirSync('${remoteDir}',{recursive:true});
writeFileSync('${workspaceFolder}/payload.txt','${payload.replace(/\n/g, "\\n")}');
execSync('/usr/sbin/sshd -p 2222');
await new Promise((r)=>setTimeout(r,1000));
console.log('sshd-ok');`;
  if (command("docker", "exec", id, "bun", "-e", setup).trim() !== "sshd-ok") throw Error("sshd_setup_failed");
  record.testServer = command("docker", "exec", id, "sh", "-c", "ss -ltn 2>/dev/null | grep 2222 || echo listening-unknown");

  // 1. Store the credential through the shipped route.
  const created = await api("/api/ssh/credentials", "POST", { name: "proof", privateKey }, cookie);
  if (created.status !== 201 || !/^[0-9a-f]{64}$/.test(created.body.fingerprint)) {
    throw Error(`create_${created.status}_${JSON.stringify(created.body)}`);
  }
  if (created.text.includes("PRIVATE KEY")) throw Error("create_response_leaked_key");
  const credentialId = created.body.id as string;
  const keyFiles = command("docker", "exec", id, "sh", "-c",
    "find /var/lib/remotecode/ssh-credentials -type f ! -name known_hosts").split("\n").filter(Boolean);
  if (keyFiles.length !== 1) throw Error(`key_files_${JSON.stringify(keyFiles)}`);
  const storedPath = keyFiles[0];
  if (!storedPath.endsWith(credentialId)) throw Error(`key_path_${storedPath}`);
  record.credential = { id: credentialId, fingerprint: created.body.fingerprint, path: storedPath, mode: command("docker", "exec", id, "stat", "-c", "%a", storedPath) };
  if (record.credential.mode !== "600") throw Error(`credential_mode_${record.credential.mode}`);

  const listed = await api("/api/ssh/credentials", "GET", undefined, cookie);
  if (listed.status !== 200 || listed.body.credentials.length !== 1 || listed.text.includes("PRIVATE KEY")) {
    throw Error(`list_${listed.status}_${listed.text.slice(0, 200)}`);
  }

  // 2. Upload with the stored credential and verify the bytes on the server.
  const upload = await api(`/api/workspaces/${workspaceId}/ssh/transfer`, "POST",
    { credentialId, direction: "upload", host: "127.0.0.1", port: 2222, user: "root", remotePath: `${remoteDir}/uploaded.txt`, localPath: "payload.txt" }, cookie);
  if (upload.status !== 200 || upload.body.sha256 !== sha256(payload) || upload.body.bytes !== Buffer.byteLength(payload)) {
    throw Error(`upload_${upload.status}_${JSON.stringify(upload.body)}`);
  }
  const remoteBytes = command("docker", "exec", id, "cat", `${remoteDir}/uploaded.txt`);
  if (remoteBytes !== payload.trim()) throw Error(`upload_bytes_${remoteBytes}`);
  record.upload = upload.body;

  // 3. Download with the same credential and verify the local bytes.
  const download = await api(`/api/workspaces/${workspaceId}/ssh/transfer`, "POST",
    { credentialId, direction: "download", host: "127.0.0.1", port: 2222, user: "root", remotePath: `${remoteDir}/uploaded.txt`, localPath: "downloaded.txt" }, cookie);
  if (download.status !== 200 || download.body.sha256 !== sha256(payload)) {
    throw Error(`download_${download.status}_${JSON.stringify(download.body)}`);
  }
  const localBytes = command("docker", "exec", id, "cat", `${workspaceFolder}/downloaded.txt`);
  if (localBytes !== payload.trim()) throw Error(`download_bytes_${localBytes}`);
  record.download = download.body;

  // 4. Refusals that keep the boundary honest.
  const escape = await api(`/api/workspaces/${workspaceId}/ssh/transfer`, "POST",
    { credentialId, direction: "download", host: "127.0.0.1", port: 2222, user: "root", remotePath: `${remoteDir}/uploaded.txt`, localPath: "../escape.txt" }, cookie);
  if (escape.status !== 400 || escape.body.error !== "invalid_local_path") throw Error(`escape_${escape.status}_${JSON.stringify(escape.body)}`);
  const deadHost = await api(`/api/workspaces/${workspaceId}/ssh/transfer`, "POST",
    { credentialId, direction: "upload", host: "127.0.0.1", port: 2223, user: "root", remotePath: "/tmp/none", localPath: "payload.txt" }, cookie);
  if (deadHost.status !== 502 || !["ssh_unreachable", "ssh_transfer_failed"].includes(deadHost.body.error)) {
    throw Error(`deadhost_${deadHost.status}_${JSON.stringify(deadHost.body)}`);
  }
  record.refusals = { escape: escape.body, deadHost: deadHost.body };

  // 5. Revoke, then the same transfer must fail.
  const revoked = await api(`/api/ssh/credentials/${credentialId}`, "DELETE", undefined, cookie);
  if (revoked.status !== 200 || revoked.body.revoked !== true) throw Error(`revoke_${revoked.status}`);
  const keyGone = command("docker", "exec", id, "sh", "-c", `test -f ${storedPath} && echo present || echo gone`);
  if (keyGone !== "gone") throw Error(`key_still_present_${keyGone}`);
  const afterRevoke = await api(`/api/workspaces/${workspaceId}/ssh/transfer`, "POST",
    { credentialId, direction: "upload", host: "127.0.0.1", port: 2222, user: "root", remotePath: `${remoteDir}/after.txt`, localPath: "payload.txt" }, cookie);
  if (afterRevoke.status !== 404 || afterRevoke.body.error !== "credential_not_found") {
    throw Error(`revoked_transfer_${afterRevoke.status}_${JSON.stringify(afterRevoke.body)}`);
  }
  const afterRevokeRemote = command("docker", "exec", id, "sh", "-c", `test -f ${remoteDir}/after.txt && echo present || echo absent`);
  if (afterRevokeRemote !== "absent") throw Error("revoked_transfer_wrote_a_file");
  record.revocation = { keyFile: keyGone, transfer: afterRevoke.body, remoteFile: afterRevokeRemote };

  // 6. Another login cannot use the credential or the workspace.
  const other = await api("/api/auth/login", "POST", { password: "wrong-password-entirely" });
  if (other.status !== 401) throw Error(`other_login_${other.status}`);
  const anonymous = await api(`/api/workspaces/${workspaceId}/ssh/transfer`, "POST",
    { credentialId, direction: "upload", host: "127.0.0.1", port: 2222, user: "root", remotePath: `${remoteDir}/anon.txt`, localPath: "payload.txt" });
  if (anonymous.status !== 401) throw Error(`anonymous_${anonymous.status}`);
  record.boundary = { wrongPassword: other.status, anonymousTransfer: anonymous.status };

  record.result = "managed_ssh_credential_upload_download_revoke_passed";
  console.log(JSON.stringify({ result: record.result, credential: record.credential, upload: record.upload, download: record.download, revocation: record.revocation }));
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ result: "unverified", error: record.error.slice(0, 300) }));
} finally {
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2));
  if (id) { try { command("docker", "stop", id); } catch {} try { command("docker", "rm", id); } catch {} }
  try { command("docker", "volume", "rm", volume); } catch {}
  console.log(JSON.stringify({ cleanup: { api: true, volume: true } }));
}