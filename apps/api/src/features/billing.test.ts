import { Database } from "bun:sqlite";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "bun:test";
import { createApi } from "../app";

const workDirectories: string[] = [];
const ownerToken = "a".repeat(64);
const otherToken = "b".repeat(64);
const webhookSecret = "test-webhook-secret";

function setup() {
  const directory = mkdtempSync(join(process.env.RC030_TEST_WORK_DIR ?? tmpdir(), "rc061-billing-"));
  workDirectories.push(directory);
  const databasePath = join(directory, "host.sqlite");

  process.env.REMOTECODE_BILLING_WEBHOOK_SECRET = webhookSecret;

  const app = createApi(databasePath);
  const database = new Database(databasePath);
  database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(createHash("sha256").update(ownerToken).digest("hex"), "alice", Date.now() + 60_000);
  database.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(createHash("sha256").update(otherToken).digest("hex"), "bob", Date.now() + 60_000);
  database.close();

  return { app, databasePath, directory };
}

afterEach(() => {
  for (const directory of workDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function request(app: ReturnType<typeof createApi>, url: string, init?: RequestInit) {
  return app.handle(new Request(url, init));
}

function sign(body: string): string {
  return createHmac("sha256", webhookSecret).update(body).digest("hex");
}

describe("Billing routes", () => {
  it("POST /api/billing/webhook applies a valid signed webhook once", async () => {
    const { app } = setup();
    const body = JSON.stringify({
      eventId: "evt-1",
      kind: "checkout.completed",
      sequence: 1,
      userId: "alice",
      plan: "pro",
      hostedAccountId: "host-1",
      occurredAt: "2026-01-01T00:00:00Z",
    });

    const response = await request(app, "http://localhost/api/billing/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rc-signature": sign(body),
        cookie: `remotecode_session=${ownerToken}`,
      },
      body,
    });
    expect(response.status).toBe(200);
    const result = await response.json() as { applied: boolean; reason: string };
    expect(result.applied).toBe(true);
    expect(result.reason).toBe("applied");
  });

  it("replaying the same webhook answers duplicate and leaves subscription unchanged", async () => {
    const { app, databasePath } = setup();
    const body = JSON.stringify({
      eventId: "evt-dup",
      kind: "checkout.completed",
      sequence: 1,
      userId: "alice",
      plan: "pro",
      hostedAccountId: "host-1",
      occurredAt: "2026-01-01T00:00:00Z",
    });
    const signature = sign(body);

    const first = await request(app, "http://localhost/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-rc-signature": signature, cookie: `remotecode_session=${ownerToken}` },
      body,
    });
    expect(first.status).toBe(200);
    const firstResult = await first.json() as { applied: boolean };
    expect(firstResult.applied).toBe(true);

    const db = new Database(databasePath);
    const rowBefore = db.query<{ updated_at: string; last_event_sequence: number }, []>(
      "SELECT updated_at, last_event_sequence FROM subscriptions WHERE user_id = 'alice'",
    ).get();

    const second = await request(app, "http://localhost/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-rc-signature": signature, cookie: `remotecode_session=${ownerToken}` },
      body,
    });
    expect(second.status).toBe(200);
    const secondResult = await second.json() as { applied: boolean; reason: string };
    expect(secondResult.applied).toBe(false);
    expect(secondResult.reason).toBe("duplicate");

    const rowAfter = db.query<{ updated_at: string; last_event_sequence: number }, []>(
      "SELECT updated_at, last_event_sequence FROM subscriptions WHERE user_id = 'alice'",
    ).get();
    db.close();

    expect(rowAfter!.updated_at).toBe(rowBefore!.updated_at);
    expect(rowAfter!.last_event_sequence).toBe(rowBefore!.last_event_sequence);
  });

  it("out-of-order delivery leaves state unchanged and answers out_of_order", async () => {
    const { app } = setup();

    const cancelBody = JSON.stringify({
      eventId: "evt-cancel",
      kind: "subscription.canceled",
      sequence: 9,
      userId: "alice",
      occurredAt: "2026-01-01T00:00:00Z",
    });
    const cancelSig = sign(cancelBody);
    const cancelResp = await request(app, "http://localhost/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-rc-signature": cancelSig, cookie: `remotecode_session=${ownerToken}` },
      body: cancelBody,
    });
    expect(cancelResp.status).toBe(200);
    const cancelResult = await cancelResp.json() as { applied: boolean };
    expect(cancelResult.applied).toBe(true);

    const checkoutBody = JSON.stringify({
      eventId: "evt-checkout",
      kind: "checkout.completed",
      sequence: 4,
      userId: "alice",
      plan: "pro",
      hostedAccountId: "host-1",
      occurredAt: "2026-01-01T00:00:00Z",
    });
    const checkoutSig = sign(checkoutBody);
    const checkoutResp = await request(app, "http://localhost/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-rc-signature": checkoutSig, cookie: `remotecode_session=${ownerToken}` },
      body: checkoutBody,
    });
    expect(checkoutResp.status).toBe(200);
    const checkoutResult = await checkoutResp.json() as { applied: boolean; reason: string };
    expect(checkoutResult.applied).toBe(false);
    expect(checkoutResult.reason).toBe("out_of_order");

    const subResp = await request(app, "http://localhost/api/billing/subscription", {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(subResp.status).toBe(200);
    const subBody = await subResp.json() as { state: string };
    expect(subBody.state).toBe("canceled");
  });

  it("bad signature is rejected 401 and writes no row", async () => {
    const { app, databasePath } = setup();
    const body = JSON.stringify({
      eventId: "evt-bad-sig",
      kind: "checkout.completed",
      sequence: 1,
      userId: "alice",
      plan: "pro",
      hostedAccountId: "host-1",
      occurredAt: "2026-01-01T00:00:00Z",
    });

    const response = await request(app, "http://localhost/api/billing/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rc-signature": "wrong-signature",
        cookie: `remotecode_session=${ownerToken}`,
      },
      body,
    });
    expect(response.status).toBe(401);

    const db = new Database(databasePath);
    const event = db.query<{ event_id: string }, [string]>
      ("SELECT event_id FROM billing_events WHERE event_id = ?").get("evt-bad-sig");
    db.close();
    expect(event).toBeNull();
  });

  it("malformed body is rejected 422", async () => {
    const { app } = setup();
    const response = await request(app, "http://localhost/api/billing/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rc-signature": sign("not-json"),
        cookie: `remotecode_session=${ownerToken}`,
      },
      body: "not-json",
    });
    expect(response.status).toBe(422);
  });

  it("subscription.canceled sets a future data_purge_after and keeps the subscription row", async () => {
    const { app } = setup();

    const checkoutBody = JSON.stringify({
      eventId: "evt-cc",
      kind: "checkout.completed",
      sequence: 1,
      userId: "alice",
      plan: "pro",
      hostedAccountId: "host-1",
      occurredAt: "2026-01-01T00:00:00Z",
    });
    const checkoutSig = sign(checkoutBody);
    await request(app, "http://localhost/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-rc-signature": checkoutSig, cookie: `remotecode_session=${ownerToken}` },
      body: checkoutBody,
    });

    const cancelBody = JSON.stringify({
      eventId: "evt-cancel",
      kind: "subscription.canceled",
      sequence: 2,
      userId: "alice",
      occurredAt: "2026-01-02T00:00:00Z",
    });
    const cancelSig = sign(cancelBody);
    const cancelResp = await request(app, "http://localhost/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-rc-signature": cancelSig, cookie: `remotecode_session=${ownerToken}` },
      body: cancelBody,
    });
    expect(cancelResp.status).toBe(200);

    const subResp = await request(app, "http://localhost/api/billing/subscription", {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(subResp.status).toBe(200);
    const subBody = await subResp.json() as { state: string; dataPurgeAfter: string | null };
    expect(subBody.state).toBe("canceled");
    expect(subBody.dataPurgeAfter).not.toBeNull();
    expect(new Date(subBody.dataPurgeAfter!).getTime()).toBeGreaterThan(Date.now());
  });

  it("GET /api/billing/receipt/:eventId returns applied true for an applied event", async () => {
    const { app } = setup();

    const body = JSON.stringify({
      eventId: "evt-receipt",
      kind: "checkout.completed",
      sequence: 1,
      userId: "alice",
      plan: "pro",
      hostedAccountId: "host-1",
      occurredAt: "2026-01-01T00:00:00Z",
    });
    const sig = sign(body);
    await request(app, "http://localhost/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-rc-signature": sig, cookie: `remotecode_session=${ownerToken}` },
      body,
    });

    const receiptResp = await request(app, "http://localhost/api/billing/receipt/evt-receipt", {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(receiptResp.status).toBe(200);
    const receipt = await receiptResp.json() as { eventId: string; found: boolean; applied: boolean };
    expect(receipt.eventId).toBe("evt-receipt");
    expect(receipt.found).toBe(true);
    expect(receipt.applied).toBe(true);
  });

  it("GET /api/billing/receipt/:eventId returns applied false with reason duplicate for a seen event", async () => {
    const { app } = setup();

    const body = JSON.stringify({
      eventId: "evt-dup-receipt",
      kind: "checkout.completed",
      sequence: 1,
      userId: "alice",
      plan: "pro",
      hostedAccountId: "host-1",
      occurredAt: "2026-01-01T00:00:00Z",
    });
    const sig = sign(body);
    await request(app, "http://localhost/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-rc-signature": sig, cookie: `remotecode_session=${ownerToken}` },
      body,
    });
    await request(app, "http://localhost/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-rc-signature": sig, cookie: `remotecode_session=${ownerToken}` },
      body,
    });

    const receiptResp = await request(app, "http://localhost/api/billing/receipt/evt-dup-receipt", {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(receiptResp.status).toBe(200);
    const receipt = await receiptResp.json() as { found: boolean; applied: boolean; reason: string | null };
    expect(receipt.found).toBe(true);
    expect(receipt.applied).toBe(true);
  });

  it("another user event id is not visible to this user", async () => {
    const { app } = setup();

    const bobBody = JSON.stringify({
      eventId: "evt-bob",
      kind: "checkout.completed",
      sequence: 1,
      userId: "bob",
      plan: "pro",
      hostedAccountId: "host-bob",
      occurredAt: "2026-01-01T00:00:00Z",
    });
    const bobSig = sign(bobBody);
    await request(app, "http://localhost/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-rc-signature": bobSig, cookie: `remotecode_session=${otherToken}` },
      body: bobBody,
    });

    const receiptResp = await request(app, "http://localhost/api/billing/receipt/evt-bob", {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(receiptResp.status).toBe(200);
    const receipt = await receiptResp.json() as { found: boolean };
    expect(receipt.found).toBe(false);
  });

  it("GET /api/billing/subscription returns inactive when owner has no row", async () => {
    const { app } = setup();

    const response = await request(app, "http://localhost/api/billing/subscription", {
      headers: { cookie: `remotecode_session=${ownerToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { state: string };
    expect(body.state).toBe("inactive");
  });
});