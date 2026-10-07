// RC-048 proof. Two claims are checked against the real tree:
//   1. one shared client package covers every named domain, and neither app has
//      grown a second HTTP layer of its own;
//   2. the contract really is shared — change a type in the shared package and
//      BOTH apps stop type-checking, then restore the bytes and both pass again.
// The contract change is made in place and restored byte-for-byte in a finally
// block; the proof refuses to run if that file already has uncommitted changes.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../..");
const output = process.env.RC048_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });

const record: any = { result: "unverified", scope: "RC-048 one shared client core across web and mobile" };
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

function run(command: string[], cwd = repo) {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe", timeout: 600_000 });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function sources(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = `${directory}/${entry}`;
      let stat;
      try { stat = statSync(path); } catch { continue; }
      if (stat.isDirectory()) {
        if (entry === "node_modules" || entry === "ios" || entry === "android" || entry === ".expo") continue;
        walk(path);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
        // A test may drive fetch itself to intercept a route; the claim here is
        // about the production client code of each app.
        if (/\.(test|spec)\./.test(entry)) continue;
        found.push(path);
      }
    }
  };
  walk(root);
  return found;
}

try {
  // ---- 1. coverage and no second HTTP layer ----
  const index = readFileSync(resolve(repo, "packages/client/src/index.ts"), "utf8");
  const domains: Record<string, string[]> = {
    workspaces: ["workspaceFromValue", "workspaceListFromValue"],
    files: ["fileContentFromValue", "fileReceiptFromValue"],
    git: ["workspaceGitStatus", "workspaceGitDiff", "workspaceGitBranches", "commitGit"],
    terminal: ["terminalReferenceFromValue", "pendingTerminalStartFromValue"],
    threads: ["createThread", "listThreads", "postThreadMessage", "listThreadMessages", "readRunChanges"],
    bots: ["listBots", "createBot", "readBot"],
    routines: ["listSchedules", "createSchedule", "setScheduleEnabled"],
    screen: ["takeScreenPossession", "readScreenPossession"],
    offline: ["runMutation"],
  };
  const missing: string[] = [];
  for (const [domain, helpers] of Object.entries(domains)) {
    for (const helper of helpers) {
      if (!new RegExp(`\\b${helper}\\b`).test(index)) missing.push(`${domain}:${helper}`);
    }
  }
  if (missing.length) throw Error(`the_shared_package_does_not_cover_${missing.join(",")}`);
  record.coverage = Object.fromEntries(Object.entries(domains).map(([domain, helpers]) => [domain, helpers.length]));

  const secondLayers: string[] = [];
  for (const app of ["apps/web/src", "apps/mobile/src"]) {
    for (const file of sources(resolve(repo, app))) {
      const text = readFileSync(file, "utf8");
      if (/\baxios\b|XMLHttpRequest|\bfetch\s*\(/.test(text)) secondLayers.push(file.replace(`${repo}/`, ""));
    }
  }
  if (secondLayers.length) throw Error(`a_second_http_layer_appeared_${secondLayers.join(",")}`);
  record.noSecondHttpLayer = true;

  const importers: Record<string, number> = {};
  for (const app of ["apps/web/src", "apps/mobile"]) {
    importers[app] = sources(resolve(repo, app))
      .filter((file) => readFileSync(file, "utf8").includes("@remotecode/client")).length;
  }
  if (!importers["apps/web/src"] || !importers["apps/mobile"]) throw Error(`an_app_does_not_use_the_shared_package_${JSON.stringify(importers)}`);
  record.importers = importers;

  // ---- 2. the contract is shared: break it and both apps must notice ----
  // `createApiClient` is the one entry point every client of the package calls,
  // so changing its signature must stop both apps type-checking.
  const target = resolve(repo, "packages/client/src/index.ts");
  const original = readFileSync(target, "utf8");
  const originalDigest = digest(original);
  const status = run(["git", "status", "--porcelain", "--", "packages/client/src/index.ts"]);
  if (status.out.trim()) throw Error("the_contract_file_has_uncommitted_changes_refusing_to_edit_it");

  const baseline = run(["bun", "run", "typecheck"]);
  if (baseline.code !== 0) throw Error(`typecheck_does_not_pass_before_the_change_${baseline.out.slice(-300)}`);

  let broken = { code: 0, out: "" };
  try {
    const anchor = "export function createApiClient(origin: string, options: ApiClientOptions = {}) {";
    if (!original.includes(anchor)) throw Error("the_contract_anchor_was_not_found");
    writeFileSync(target, original.replace(anchor, "export function createApiClient(origin: string, contractChangeProbe: string, options: ApiClientOptions = {}) {"));
    broken = run(["bun", "run", "typecheck"]);
  } finally {
    writeFileSync(target, original);
  }
  if (digest(readFileSync(target, "utf8")) !== originalDigest) throw Error("the_contract_file_was_not_restored");
  if (broken.code === 0) throw Error("a_contract_change_did_not_break_either_client");
  const webDiagnostics = broken.out.split("\n").filter((line) => line.includes("apps/web/") && line.includes("error TS"));
  const mobileDiagnostics = broken.out.split("\n").filter((line) => line.includes("apps/mobile/") && line.includes("error TS"));
  if (!webDiagnostics.length || !mobileDiagnostics.length) {
    throw Error(`the_contract_change_did_not_reach_both_clients_web_${webDiagnostics.length}_mobile_${mobileDiagnostics.length}`);
  }

  const restored = run(["bun", "run", "typecheck"]);
  if (restored.code !== 0) throw Error(`typecheck_does_not_pass_after_the_restore_${restored.out.slice(-300)}`);

  record.contractChange = {
    changedFile: "packages/client/src/index.ts",
    webDiagnostics: webDiagnostics.length,
    mobileDiagnostics: mobileDiagnostics.length,
    typecheckBefore: baseline.code,
    typecheckWithChange: broken.code,
    typecheckAfterRestore: restored.code,
    restoredByteIdentical: true,
    firstBrokenDiagnostics: broken.out.split("\n").filter((line) => line.includes("error TS")).slice(0, 3),
  };
  record.result = "one_shared_core_covers_every_domain_and_a_contract_change_breaks_both_clients_then_passes_again_passed";
  console.log(JSON.stringify(record));
} catch (error) {
  record.error = String((error as Error)?.message ?? error);
  console.log(JSON.stringify(record));
  process.exitCode = 1;
}
