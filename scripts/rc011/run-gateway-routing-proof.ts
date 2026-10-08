// RC-011 proof: a gateway authenticates a caller and forwards the API and the
// event socket to that account's own container, without leaking its routing
// token to the container, and it never hangs waiting for a dead upstream.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const repo = "/Users/samuelfajreldines/dev/new-remote-code";
const output = process.env.RC011_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const suffix = randomUUID().slice(0, 8);
const network = `rc011-net-${suffix}`;
const image = process.env.RC011_IMAGE ?? "sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e";
const label = "remotecode.rc011.gatewayproof";
const tokenA = `tok-a-${randomUUID()}`;
const tokenB = `tok-b-${randomUUID()}`;
const tokenDead = `tok-dead-${randomUUID()}`;
const passwordA = randomBytes(24).toString("base64url");
const passwordB = randomBytes(24).toString("base64url");
const names = { a: `rc011-a-${suffix}`, b: `rc011-b-${suffix}`, gateway: `rc011-gw-${suffix}` };
const volumes = { a: `rc011-a-${suffix}-data`, b: `rc011-b-${suffix}-data` };
const gatewayPort = 27_000 + Math.floor(Math.random() * 500);
const record: any = { network, names, gatewayPort, image, result: "unverified", scope: "RC-011 gateway routes accounts A and B to their own container" };

function command(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  record.commands ??= [];
  record.commands.push({ argv: args, exitCode: result.exitCode });
  if (result.exitCode) throw Error(result.stderr.toString().slice(0, 400));
  return result.stdout.toString().trim();
}

async function waitReady(url: string, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < end) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.status === 200) return;
      last = `status_${response.status}`;
    } catch (error) { last = String(error).slice(0, 80); }
    await delay(250);
  }
  throw Error(`never_ready_${url}_${last}`);
}

try {
  const metadata = JSON.parse(command("docker", "image", "inspect", image))[0];
  if (metadata.Os !== "linux" || metadata.Architecture !== "arm64") throw Error("Linux ARM64 image required");
  const cert = `${output}/rc011.pem`, key = `${output}/rc011-key.pem`;
  command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=rc011",
    "-addext", `subjectAltName=DNS:${names.a},DNS:${names.b},DNS:rc011-gw,IP:127.0.0.1`, "-keyout", key, "-out", cert);
  command("docker", "network", "create", "--label", `${label}=${suffix}`, network);

  for (const [key, name] of [["a", names.a], ["b", names.b]] as const) {
    const password = key === "a" ? passwordA : passwordB;
    command("docker", "volume", "create", "--label", `${label}=${suffix}`, volumes[key]);
    command("docker", "create", "--name", name, "--label", `${label}=${suffix}`, "--platform", "linux/arm64", "--pull", "never",
      "--network", network, "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
      "--mount", `type=bind,src=${repo},dst=/workspace,readonly`,
      "--mount", `type=bind,src=${output},dst=/proof,readonly`,
      "--mount", `type=volume,src=${volumes[key]},dst=/var/lib/remotecode`,
      "--workdir", "/workspace",
      "-e", "API_PORT=3000", "-e", `DATABASE_PATH=/var/lib/remotecode/${key}.sqlite`, "-e", `REMOTECODE_AUTH_PASSWORD=${password}`,
      "-e", "REMOTECODE_TLS_CERT=/proof/rc011.pem", "-e", "REMOTECODE_TLS_KEY=/proof/rc011-key.pem",
      "--entrypoint", "sleep", image, "infinity");
    command("docker", "start", name);
    command("docker", "exec", "-d", name, "bash", "-lc",
      `cd /workspace && API_PORT=3000 DATABASE_PATH=/var/lib/remotecode/${key}.sqlite REMOTECODE_AUTH_PASSWORD='${password}' REMOTECODE_TLS_CERT=/proof/rc011.pem REMOTECODE_TLS_KEY=/proof/rc011-key.pem bun apps/api/src/index.ts > /var/lib/remotecode/api.log 2>&1`);
  }
  // The containers publish no ports: the caller can only reach them through the gateway.
  const published = command("docker", "ps", "--filter", `label=${label}=${suffix}`, "--format", "{{.Names}} {{.Ports}}");
  if (/0\.0\.0\.0:|:::/.test(published.replace(`${names.gateway}`, ""))) throw Error(`account_container_publishes_a_port_${published}`);

  const routes = { [tokenA]: `https://${names.a}:3000`, [tokenB]: `https://${names.b}:3000`, [tokenDead]: "https://rc011-dead:3000" };
  command("docker", "create", "--name", names.gateway, "--label", `${label}=${suffix}`, "--platform", "linux/arm64", "--pull", "never",
    "--network", network, "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--mount", `type=bind,src=${repo},dst=/workspace,readonly`,
    "--mount", `type=bind,src=${output},dst=/proof,readonly`,
    "--workdir", "/workspace", "-p", `127.0.0.1:${gatewayPort}:8080`,
    "-e", `RC011_ROUTES=${JSON.stringify(routes)}`, "-e", "RC011_UPSTREAM_CA=/proof/rc011.pem", "-e", "RC011_PORT=8080", "-e", "RC011_UPSTREAM_TIMEOUT_MS=2000",
    "--entrypoint", "bun", image, "apps/gateway/src/index.ts");
  command("docker", "start", names.gateway);

  const gateway = `http://127.0.0.1:${gatewayPort}`;
  await waitReady(`${gateway}/healthz`, 30_000);

  const call = async (path: string, token: string, options: { method?: string; body?: unknown; cookie?: string } = {}) => {
    const response = await fetch(gateway + path, {
      method: options.method ?? "GET",
      headers: {
        "x-rc-gateway-token": token,
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch {}
    return { status: response.status, body: parsed, text, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "", marker: response.headers.get("x-rc-gateway") };
  };

  // Authentication at the gateway.
  const noToken = await fetch(`${gateway}/api/workspaces`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.status).catch(() => 0);
  const badToken = await call("/api/workspaces", "not-a-token");
  if (noToken !== 401 || badToken.status !== 401) throw Error(`gateway_auth_${noToken}_${badToken.status}`);

  const loginA = await call("/api/auth/login", tokenA, { method: "POST", body: { password: passwordA } });
  const loginB = await call("/api/auth/login", tokenB, { method: "POST", body: { password: passwordB } });
  if (loginA.status !== 200 || loginB.status !== 200) throw Error(`logins_${loginA.status}_${loginB.status}`);
  if (loginA.marker !== "1") throw Error("proxied_response_missing_gateway_marker");

  const workspaceA = await call("/api/workspaces", tokenA, { method: "POST", body: { requestId: randomUUID(), name: "account-a" }, cookie: loginA.cookie });
  const workspaceB = await call("/api/workspaces", tokenB, { method: "POST", body: { requestId: randomUUID(), name: "account-b" }, cookie: loginB.cookie });
  if (workspaceA.status !== 201 || workspaceB.status !== 201) throw Error(`workspaces_${workspaceA.status}_${workspaceB.status}`);

  const listA = await call("/api/workspaces", tokenA, { cookie: loginA.cookie });
  const listB = await call("/api/workspaces", tokenB, { cookie: loginB.cookie });
  const idsA = (listA.body.workspaces ?? []).map((row: any) => row.id);
  const idsB = (listB.body.workspaces ?? []).map((row: any) => row.id);
  if (!idsA.includes(workspaceA.body.id)) throw Error("account_a_cannot_see_its_own_workspace");
  if (idsA.includes(workspaceB.body.id)) throw Error("account_a_saw_account_b_workspace");
  if (idsB.includes(workspaceA.body.id)) throw Error("account_b_saw_account_a_workspace");
  const crossRead = await call(`/api/workspaces/${workspaceA.body.id}`, tokenB, { cookie: loginB.cookie });
  if (crossRead.status !== 404) throw Error(`account_b_read_account_a_resource_${crossRead.status}`);

  // The event socket is forwarded too.
  const snapshot = await new Promise<any>((resolveSocket, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/api/events`, {
      headers: { "x-rc-gateway-token": tokenA, cookie: loginA.cookie, origin: "http://localhost:5173" },
    } as any);
    const timer = setTimeout(() => { try { socket.close(); } catch {} reject(new Error("events_timeout")); }, 15_000);
    socket.addEventListener("message", (event) => { clearTimeout(timer); resolveSocket(JSON.parse(String((event as MessageEvent).data))); socket.close(); });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("events_error")); });
  });
  if (snapshot?.type !== "snapshot") throw Error(`events_not_forwarded_${JSON.stringify(snapshot).slice(0, 120)}`);

  // The routing token never entered the account containers.
  for (const name of [names.a, names.b]) {
    const env = command("docker", "exec", name, "env");
    if (env.includes("RC011") || env.includes(tokenA) || env.includes(tokenB)) throw Error(`routing_token_inside_${name}`);
  }

  // A dead upstream is a bounded failure, not a hang.
  const started = Date.now();
  const dead = await call("/api/workspaces", tokenDead);
  const elapsed = Date.now() - started;
  if (dead.status !== 503 || (dead.body?.error ?? "") !== "upstream_unavailable") throw Error(`dead_upstream_${dead.status}_${JSON.stringify(dead.body)}`);
  if (elapsed > 8_000) throw Error(`dead_upstream_took_${elapsed}ms`);

  // The caller cannot reach an account container's internal port directly.
  const containerIp = command("docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", names.a);
  let directReachable = false;
  try {
    const direct = await fetch(`http://${containerIp}:3000/api/health/ready`, { signal: AbortSignal.timeout(3000) });
    directReachable = direct.status === 200;
  } catch { directReachable = false; }
  if (directReachable) throw Error(`caller_reached_internal_port_${containerIp}`);

  record.routing = {
    accounts: { a: { workspaceId: workspaceA.body.id, visible: idsA.length }, b: { workspaceId: workspaceB.body.id, visible: idsB.length } },
    crossRead: crossRead.status,
    gatewayAuth: { noToken, badToken: badToken.status },
    events: snapshot.type,
    tokenInContainers: false,
    deadUpstream: { status: dead.status, error: dead.body.error, elapsedMs: elapsed },
    directInternalPort: { containerIp, reachable: directReachable },
  };
  record.result = "gateway_routed_both_accounts_without_leaking_its_token_passed";
  console.log(JSON.stringify({ result: record.result, routing: record.routing }));
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.log(JSON.stringify({ result: "unverified", error: record.error.slice(0, 400) }));
} finally {
  if (process.env.RC011_KEEP) {
    console.log(JSON.stringify({ kept: { network, names, volumes, gatewayPort } }));
  } else {
    for (const name of [names.gateway, names.a, names.b]) { try { command("docker", "rm", "-f", name); } catch {} }
    for (const volume of [volumes.a, volumes.b]) { try { command("docker", "volume", "rm", volume); } catch {} }
    try { command("docker", "network", "rm", network); } catch {}
  }
  writeFileSync(`${output}/evidence.json`, JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ cleanup: { containers: !process.env.RC011_KEEP, network: !process.env.RC011_KEEP } }));
}