// RC-038 proof: create, edit, hide and list Bots through the shipped routes on
// real Linux, with persistence across an API restart and owner isolation.
//
// Two distinct Bots are created with their own instructions and context; one is
// edited and hidden. The API container is restarted on the same volume and both
// are queried again. Another login and an unknown id must not reach either.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "../..");
const output = process.env.RC038_BOTS_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const run = `rc038-bots-${randomUUID()}`;
const volume = `${run}-data`;
const image = process.env.RC038_BOTS_IMAGE ?? "sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e";
const label = "remotecode.rc038.botsproof";
const password = randomBytes(32).toString("base64url");
const databasePath = "/var/lib/remotecode/bots-proof.sqlite";
let id = "";
const record: any = { run, volume, image, result: "unverified", scope: "RC-038 bots: create two, edit and hide one, restart and query both, owner isolation" };

function command(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  record.commands ??= [];
  record.commands.push({ argv: args.map((arg) => arg.replaceAll(password, "[redacted]")), exitCode: result.exitCode });
  if (result.exitCode) throw Error(result.stderr.toString().replaceAll(password, "[redacted]").slice(0, 400));
  return result.stdout.toString().trim();
}

try {
  const metadata = JSON.parse(command("docker", "image", "inspect", image))[0];
  if (metadata.Os !== "linux" || metadata.Architecture !== "arm64") throw Error("Linux ARM64 image required");
  const apiPort = 19_000 + Math.floor(Math.random() * 1500);
  const cert = resolve(output, "proof-ca.pem"), key = resolve(output, "proof-key.pem");
  command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert);
  chmodSync(cert, 0o600); chmodSync(key, 0o600);
  writeFileSync(resolve(output, "server.ts"),
    `import'/workspace/apps/api/src/index.ts';await Bun.write('/tmp/bots-ready.json',JSON.stringify({ready:true,pid:process.pid}));`);
  command("docker", "volume", "create", "--label", `${label}=${run}`, volume);
  id = command("docker", "create", "--name", run, "--label", `${label}=${run}`, "--platform", "linux/arm64", "--pull", "never",
    "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--mount", `type=bind,src=${repo},dst=/workspace,readonly`, "--mount", `type=bind,src=${output},dst=/proof,readonly`,
    "--mount", `type=volume,src=${volume},dst=/var/lib/remotecode`,
    "--workdir", "/workspace", "-p", `127.0.0.1:${apiPort}:3000`,
    "-e", "API_PORT=3000", "-e", `DATABASE_PATH=${databasePath}`, "-e", `REMOTECODE_AUTH_PASSWORD=${password}`,
    "-e", "REMOTECODE_TLS_CERT=/proof/proof-ca.pem", "-e", "REMOTECODE_TLS_KEY=/proof/proof-key.pem",
    "--entrypoint", "bun", image, "/proof/server.ts");
  command("docker", "start", id);

  const base = `https://127.0.0.1:${apiPort}`;
  const tls = { ca: readFileSync(cert) };
  const waitReady = async () => {
    const end = Date.now() + 40_000;
    while (Date.now() < end) {
      try { if ((await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(1000), tls } as any)).status === 200) return; } catch {}
      await delay(200);
    }
    throw Error("api_not_ready");
  };
  await waitReady();
  const api = async (path: string, method = "GET", body?: unknown, cookie = "") => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) } as any,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000), tls,
    } as any);
    const text = await response.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch {}
    return { status: response.status, body: parsed, text, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };

  const login = await api("/api/auth/login", "POST", { password });
  if (login.status !== 200) throw Error(`login_${login.status}`);
  const cookie = login.cookie;

  const alpha = { name: "Alpha", instructions: "Always answer in short sentences.", context: "Reviewing pull requests." };
  const beta = { name: "Beta", instructions: "Draft release notes from diffs.", context: "Release engineering." };
  const createdAlpha = await api("/api/bots", "POST", alpha, cookie);
  const createdBeta = await api("/api/bots", "POST", beta, cookie);
  if (createdAlpha.status !== 201 || createdBeta.status !== 201) {
    throw Error(`create_${createdAlpha.status}_${createdBeta.status}`);
  }
  if (createdAlpha.body.id === createdBeta.body.id) throw Error("bots_share_identity");
  record.created = { alpha: createdAlpha.body, beta: createdBeta.body };

  // Edit one and hide the other; neither may disturb the other's fields.
  const edited =
    await api(`/api/bots/${createdAlpha.body.id}`, "PATCH", { instructions: "Always answer in one terse line.", context: "Reviewing database migrations." }, cookie);
  const hidden = await api(`/api/bots/${createdBeta.body.id}`, "PATCH", { hidden: true }, cookie);
  if (edited.status !== 200 || edited.body.instructions !== "Always answer in one terse line.") {
    throw Error(`edit_${edited.status}_${JSON.stringify(edited.body)}`);
  }
  if (hidden.status !== 200 || hidden.body.hidden !== true || hidden.body.instructions !== beta.instructions) {
    throw Error(`hide_${hidden.status}_${JSON.stringify(hidden.body)}`);
  }
  const listed = await api("/api/bots", "GET", undefined, cookie);
  const byId = new Map(listed.body.bots.map((bot: any) => [bot.id, bot]));
  const alphaAfter = byId.get(createdAlpha.body.id) as any;
  const betaAfter = byId.get(createdBeta.body.id) as any;
  if (listed.status !== 200 || byId.size !== 2) throw Error(`list_${listed.status}_${listed.body?.bots?.length}`);
  if (alphaAfter.instructions !== "Always answer in one terse line." || alphaAfter.hidden !== false) throw Error(`alpha_after_${JSON.stringify(alphaAfter)}`);
  if (betaAfter.instructions !== beta.instructions || betaAfter.context !== beta.context || betaAfter.hidden !== true) {
    throw Error(`beta_after_${JSON.stringify(betaAfter)}`);
  }
  record.afterEdit = { alpha: alphaAfter, beta: betaAfter };

  // Another login must not reach either Bot.
  const otherToken = randomBytes(32).toString("hex");
  const otherHash = createHash("sha256").update(otherToken).digest("hex");
  const seedCode = `import{Database}from'bun:sqlite';const d=new Database(${JSON.stringify(databasePath)},{create:true});` +
    `d.exec('PRAGMA busy_timeout = 250');d.query('INSERT OR REPLACE INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')` +
    `.run(${JSON.stringify(otherHash)}, 'other-user', Date.now() + 600000);d.close();console.log('seeded')`;
  if (command("docker", "exec", id, "bun", "-e", seedCode) !== "seeded") throw Error("other_session_seed_failed");
  const otherCookie = `remotecode_session=${otherToken}`;
  const foreignGet = await api(`/api/bots/${createdAlpha.body.id}`, "GET", undefined, otherCookie);
  const foreignPatch = await api(`/api/bots/${createdAlpha.body.id}`, "PATCH", { instructions: "hijacked" }, otherCookie);
  const foreignList = await api("/api/bots", "GET", undefined, otherCookie);
  if (foreignGet.status !== 404 || foreignPatch.status !== 404) throw Error(`foreign_${foreignGet.status}_${foreignPatch.status}`);
  if (foreignList.status !== 200 || foreignList.body.bots.length !== 0) throw Error(`foreign_list_${foreignList.status}_${foreignList.body?.bots?.length}`);
  const anonymous = await api("/api/bots", "GET");
  const unknownId = await api(`/api/bots/${randomUUID()}`, "GET", undefined, cookie);
  if (anonymous.status !== 401) throw Error(`anonymous_${anonymous.status}`);
  if (unknownId.status !== 404) throw Error(`unknown_${unknownId.status}`);
  record.isolation = { foreignGet: foreignGet.status, foreignPatch: foreignPatch.status, foreignListCount: foreignList.body.bots.length, anonymous: anonymous.status, unknownId: unknownId.status };

  // Restart the API on the same volume: both Bots must come back unchanged.
  command("docker", "restart", id);
  await waitReady();
  const relogin = await api("/api/auth/login", "POST", { password });
  if (relogin.status !== 200) throw Error(`relogin_${relogin.status}`);
  const afterRestart = await api("/api/bots", "GET", undefined, relogin.cookie);
  const restartById = new Map(afterRestart.body.bots.map((bot: any) => [bot.id, bot]));
  const alphaRestart = restartById.get(createdAlpha.body.id) as any;
  const betaRestart = restartById.get(createdBeta.body.id) as any;
  if (afterRestart.status !== 200 || restartById.size !== 2) throw Error(`restart_list_${afterRestart.status}_${afterRestart.body?.bots?.length}`);
  if (alphaRestart.instructions !== alphaAfter.instructions || alphaRestart.context !== alphaAfter.context || alphaRestart.hidden !== false) {
    throw Error(`alpha_restart_${JSON.stringify(alphaRestart)}`);
  }
  if (betaRestart.instructions !== beta.instructions || betaRestart.hidden !== true) throw Error(`beta_restart_${JSON.stringify(betaRestart)}`);
  record.afterRestart = { alpha: alphaRestart, beta: betaRestart };

  record.result = "bots_created_edited_hidden_and_persisted_passed";
  console.log(JSON.stringify({ result: record.result, created: record.created, afterEdit: record.afterEdit, isolation: record.isolation, afterRestart: record.afterRestart }));
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.log(JSON.stringify({ result: "unverified", error: record.error.slice(0, 400) }));
} finally {
  if (id) { try { command("docker", "stop", id); } catch {} try { command("docker", "rm", id); } catch {} }
  try { command("docker", "volume", "rm", volume); } catch {}
  for (const file of ["proof-ca.pem", "proof-key.pem"]) { try { unlinkSync(resolve(output, file)); } catch {} }
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ cleanup: { api: true, volume: true } }));
}