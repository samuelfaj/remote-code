// RC-039 proof: enabled skills and Bot memory survive a restart and stay
// private to one Bot and its owner.
//
// Two Bots get different skills and different facts through the shipped routes;
// each query returns only its own content, and a real API restart on the same
// volume preserves both.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "../..");
const output = process.env.RC039_MEMORY_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const run = `rc039-memory-${randomUUID()}`;
const volume = `${run}-data`;
const image = process.env.RC039_MEMORY_IMAGE ?? "sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e";
const label = "remotecode.rc039.memoryproof";
const password = randomBytes(32).toString("base64url");
const databasePath = "/var/lib/remotecode/rc039-memory.sqlite";
let id = "";
const record: any = { run, volume, image, result: "unverified", scope: "RC-039 bot skills and memory: distinct per Bot, isolated, surviving a real restart" };

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
  const apiPort = 19_600 + Math.floor(Math.random() * 1200);
  const cert = resolve(output, "proof-ca.pem"), key = resolve(output, "proof-key.pem");
  command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert);
  chmodSync(cert, 0o600); chmodSync(key, 0o600);
  writeFileSync(resolve(output, "server.ts"),
    `import'/workspace/apps/api/src/index.ts';await Bun.write('/tmp/rc039-ready.json',JSON.stringify({ready:true,pid:process.pid}));`);
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

  const alpha = await api("/api/bots", "POST", { name: "MemoryAlpha", instructions: "Keep the user's preferences." }, cookie);
  const beta = await api("/api/bots", "POST", { name: "MemoryBeta", instructions: "Track release facts." }, cookie);
  if (alpha.status !== 201 || beta.status !== 201) throw Error(`create_${alpha.status}_${beta.status}`);

  const alphaSkills = ["code-review", "summarize"];
  const betaSkills = ["release-notes"];
  if ((await api(`/api/bots/${alpha.body.id}/skills`, "PUT", { skills: alphaSkills }, cookie)).status !== 200) throw Error("alpha_skills_failed");
  if ((await api(`/api/bots/${beta.body.id}/skills`, "PUT", { skills: betaSkills }, cookie)).status !== 200) throw Error("beta_skills_failed");

  const alphaFacts = ["Alpha prefers terse answers.", "Alpha reviews pull requests."];
  const betaFacts = ["Beta ships on Fridays.", "Beta drafts release notes."];
  for (const text of alphaFacts) {
    const created = await api(`/api/bots/${alpha.body.id}/memory`, "POST", { text }, cookie);
    if (created.status !== 201) throw Error(`alpha_memory_${created.status}`);
  }
  for (const text of betaFacts) {
    const created = await api(`/api/bots/${beta.body.id}/memory`, "POST", { text }, cookie);
    if (created.status !== 201) throw Error(`beta_memory_${created.status}`);
  }

  const alphaMemory = await api(`/api/bots/${alpha.body.id}/memory`, "GET", undefined, cookie);
  const betaMemory = await api(`/api/bots/${beta.body.id}/memory`, "GET", undefined, cookie);
  const alphaView = await api(`/api/bots/${alpha.body.id}`, "GET", undefined, cookie);
  const betaView = await api(`/api/bots/${beta.body.id}`, "GET", undefined, cookie);
  if (JSON.stringify(alphaMemory.body.entries.map((entry: any) => entry.text)) !== JSON.stringify(alphaFacts)) {
    throw Error(`alpha_memory_${JSON.stringify(alphaMemory.body)}`);
  }
  if (JSON.stringify(betaMemory.body.entries.map((entry: any) => entry.text)) !== JSON.stringify(betaFacts)) {
    throw Error(`beta_memory_${JSON.stringify(betaMemory.body)}`);
  }
  if (JSON.stringify(alphaView.body.skills) !== JSON.stringify(alphaSkills) || JSON.stringify(betaView.body.skills) !== JSON.stringify(betaSkills)) {
    throw Error(`skills_${JSON.stringify({ alpha: alphaView.body.skills, beta: betaView.body.skills })}`);
  }
  const alphaTexts = alphaMemory.body.entries.map((entry: any) => entry.text).join("\n");
  const betaTexts = betaMemory.body.entries.map((entry: any) => entry.text).join("\n");
  if (betaFacts.some((fact) => alphaTexts.includes(fact)) || alphaFacts.some((fact) => betaTexts.includes(fact))) {
    throw Error("one_bot_reads_the_other_bots_memory");
  }
  record.beforeRestart = { alpha: { skills: alphaView.body.skills, facts: alphaMemory.body.entries.map((e: any) => e.text) }, beta: { skills: betaView.body.skills, facts: betaMemory.body.entries.map((e: any) => e.text) } };

  // Another login must not read either Bot's memory or skills.
  const otherToken = randomBytes(32).toString("hex");
  const otherHash = createHash("sha256").update(otherToken).digest("hex");
  const seed = `import{Database}from'bun:sqlite';const d=new Database(${JSON.stringify(databasePath)},{create:true});` +
    `d.exec('PRAGMA busy_timeout = 250');d.query('INSERT OR REPLACE INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')` +
    `.run(${JSON.stringify(otherHash)}, 'other-user', Date.now() + 600000);d.close();console.log('seeded')`;
  if (command("docker", "exec", id, "bun", "-e", seed) !== "seeded") throw Error("other_session_seed_failed");
  const otherCookie = `remotecode_session=${otherToken}`;
  const foreignMemory = await api(`/api/bots/${alpha.body.id}/memory`, "GET", undefined, otherCookie);
  const foreignSkills = await api(`/api/bots/${alpha.body.id}/skills`, "PUT", { skills: ["hijack"] }, otherCookie);
  const anonymous = await api(`/api/bots/${alpha.body.id}/memory`);
  if (foreignMemory.status !== 404 || foreignSkills.status !== 404 || anonymous.status !== 401) {
    throw Error(`isolation_${foreignMemory.status}_${foreignSkills.status}_${anonymous.status}`);
  }
  record.isolation = { foreignMemory: foreignMemory.status, foreignSkills: foreignSkills.status, anonymous: anonymous.status };

  // Restart on the same volume: skills and memory must come back unchanged.
  command("docker", "restart", id);
  await waitReady();
  const relogin = await api("/api/auth/login", "POST", { password });
  if (relogin.status !== 200) throw Error(`relogin_${relogin.status}`);
  const alphaAfter = await api(`/api/bots/${alpha.body.id}/memory`, "GET", undefined, relogin.cookie);
  const betaAfter = await api(`/api/bots/${beta.body.id}/memory`, "GET", undefined, relogin.cookie);
  const alphaViewAfter = await api(`/api/bots/${alpha.body.id}`, "GET", undefined, relogin.cookie);
  const betaViewAfter = await api(`/api/bots/${beta.body.id}`, "GET", undefined, relogin.cookie);
  if (JSON.stringify(alphaAfter.body.entries.map((entry: any) => entry.text)) !== JSON.stringify(alphaFacts)) {
    throw Error(`alpha_after_restart_${JSON.stringify(alphaAfter.body)}`);
  }
  if (JSON.stringify(betaAfter.body.entries.map((entry: any) => entry.text)) !== JSON.stringify(betaFacts)) {
    throw Error(`beta_after_restart_${JSON.stringify(betaAfter.body)}`);
  }
  if (JSON.stringify(alphaViewAfter.body.skills) !== JSON.stringify(alphaSkills) || JSON.stringify(betaViewAfter.body.skills) !== JSON.stringify(betaSkills)) {
    throw Error(`skills_after_restart_${JSON.stringify({ alpha: alphaViewAfter.body.skills, beta: betaViewAfter.body.skills })}`);
  }
  record.afterRestart = { alpha: { skills: alphaViewAfter.body.skills, facts: alphaAfter.body.entries.map((e: any) => e.text) }, beta: { skills: betaViewAfter.body.skills, facts: betaAfter.body.entries.map((e: any) => e.text) } };

  record.result = "bot_skills_and_memory_persist_and_stay_private_passed";
  console.log(JSON.stringify({ result: record.result, beforeRestart: record.beforeRestart, afterRestart: record.afterRestart, isolation: record.isolation }));
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