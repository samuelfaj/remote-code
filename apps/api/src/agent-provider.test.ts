import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { createApi } from "./app";

// A stand-in for `distill models`: it prints what the report has to read, and
// nothing else. Real Distill is exercised by the dev host.
const probeStub = join(import.meta.dir, "features/provider-stub.sh");
const testPassword = "local-test-password";
const credential = "OPENROUTER_API_KEY";

function tempDb(label: string) {
  return join(mkdtempSync(join(tmpdir(), `rc-provider-${label}-`)), "remotecode.sqlite");
}

async function api(
  label: string,
  providerConfig: Record<string, unknown>,
) {
  const app = createApi(
    tempDb(label),
    undefined,
    { password: testPassword },
    undefined,
    undefined,
    undefined,
    providerConfig,
  );
  const response = await app.handle(new Request("https://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: testPassword }),
  }));
  if (response.status !== 200) throw new Error("login failed");
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("cookie missing");
  return { app, cookie };
}

async function provider(app: ReturnType<typeof createApi>, cookie: string) {
  const response = await app.handle(new Request("https://localhost/api/agent/provider", {
    headers: { cookie },
  }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, text: "" };
}

describe("agent provider report", () => {
  it("refuses an unauthenticated request", async () => {
    const { app } = await api("anonymous", { command: probeStub, model: "openai/gpt-4o-mini" });
    const response = await app.handle(new Request("https://localhost/api/agent/provider"));
    expect(response.status).toBe(401);
  });

  it("reports unconfigured when the host has no agent model", async () => {
    const { app, cookie } = await api("unconfigured", {
      command: probeStub,
      model: "",
      credentialVariable: credential,
      env: { PATH: process.env.PATH, PROBE_MODE: "connected" },
    });
    const { body } = await provider(app, cookie);
    expect(body.configured).toBe(false);
    expect(body.state).toBe("unconfigured");
    expect(String(body.detail)).toContain("No agent model");
  });

  it("reports unauthenticated and names the missing credential variable", async () => {
    const { app, cookie } = await api("unauthenticated", {
      command: probeStub,
      model: "openai/gpt-4o-mini",
      baseUrl: "https://openrouter.ai/api/v1",
      credentialVariable: credential,
      env: { PATH: process.env.PATH, PROBE_MODE: "unauthenticated" },
    });
    const { body } = await provider(app, cookie);
    expect(body.provider).toBe("OpenRouter");
    expect(body.credentialPresent).toBe(false);
    expect(body.state).toBe("unauthenticated");
    expect(String(body.detail)).toContain(credential);
    expect(body.models).toContain("grok-4.6");
  });

  it("reports connected with the models the agent lists, and never the credential value", async () => {
    const { app, cookie } = await api("connected", {
      command: probeStub,
      model: "openai/gpt-4o-mini",
      baseUrl: "https://openrouter.ai/api/v1",
      credentialVariable: credential,
      env: { PATH: process.env.PATH, PROBE_MODE: "connected", [credential]: "probe-secret-value" },
    });
    const { body } = await provider(app, cookie);
    expect(body.state).toBe("connected");
    expect(body.models).toEqual(["grok-4.6", "remotecode-agent"]);
    expect(body.model).toBe("openai/gpt-4o-mini");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("probe-secret-value");
    expect(serialized).not.toContain("probe-secret");
  });

  it("reports unavailable when the agent cannot be asked", async () => {
    const { app, cookie } = await api("unavailable", {
      command: "/nonexistent/distill-provider-probe",
      model: "openai/gpt-4o-mini",
      credentialVariable: credential,
      env: { PATH: process.env.PATH, [credential]: "probe-secret-value" },
    });
    const { body } = await provider(app, cookie);
    expect(body.state).toBe("unavailable");
    expect(String(body.detail).length).toBeGreaterThan(0);
  });
});
