// RC-042 phase 1: create the fixture the preview map must be configured with.
// Runs inside the account container over loopback (auth refuses plain HTTP from
// a non-loopback peer).
const base = process.env.RC042_API ?? "http://127.0.0.1:3000";
const password = process.env.RC042_AUTH_PASSWORD ?? "";

const login = await fetch(`${base}/api/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
});
if (login.status !== 200) throw Error(`login_${login.status}`);
const cookie = login.headers.get("set-cookie")!.split(";")[0];

async function call(path: string, method: string, body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

const workspace = await call("/api/workspaces", "POST", { name: "rc042-preview" });
if (workspace.status !== 201 && workspace.status !== 200) throw Error(`workspace_${workspace.status}_${JSON.stringify(workspace.body)}`);
const workspaceId = workspace.body?.id ?? workspace.body?.workspace?.id;
if (!workspaceId) throw Error(`workspace_id_missing_${JSON.stringify(workspace.body)}`);

const bots: Record<string, string> = {};
for (const name of ["PreviewA", "PreviewB"]) {
  const bot = await call("/api/bots", "POST", { name });
  if (bot.status !== 201) throw Error(`bot_${name}_${bot.status}_${JSON.stringify(bot.body)}`);
  bots[name] = bot.body.id;
}

console.log(JSON.stringify({ workspaceId, bots }));