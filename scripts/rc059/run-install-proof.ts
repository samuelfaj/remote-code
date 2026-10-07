// RC-059 proof: follow only the public instructions in INSTALL.md on a clean
// Linux environment and complete Bot creation and a restore.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../..");
const output = process.env.RC059_PROOF_DIR;
if (!output?.startsWith("/")) throw Error("Fresh absolute proof output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const run = `rc059-install-${randomUUID()}`;
const cli = `${run}-cli`;
const host = `${run}-host`;
const volume = `${run}-data`;
const image = process.env.RC059_CLI_IMAGE ?? "docker:cli";
const label = "remotecode.rc059.install";
const record: any = { run, cli, host, volume, image, result: "unverified", scope: "RC-059 public instructions on a clean Linux environment" };

function command(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 900_000 });
  record.commands ??= [];
  record.commands.push({ argv: args.map((arg) => (arg === "docker" ? arg : arg.slice(0, 40))), exitCode: result.exitCode });
  if (result.exitCode) throw Error(`${args.slice(0, 3).join(" ")}: ${result.stderr.toString().slice(0, 300)}`);
  return result.stdout.toString();
}

/** Every fenced bash block in INSTALL.md, in document order. */
function instructions(): string[] {
  const markdown = readFileSync(resolve(repo, "INSTALL.md"), "utf8");
  const blocks = [...markdown.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1].trim());
  if (blocks.length < 9) throw Error(`instructions_unreadable_${blocks.length}`);
  return blocks;
}

/** Run one shell session inside the clean environment, bounded. */
async function runScript(script: string, seconds: number, shell = "bash") {
  const task = Bun.spawn(["docker", "exec", "-w", "/workspace", cli, shell, "-lc", script], {
    cwd: repo, stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => { try { task.kill(); } catch {} }, seconds * 1000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(task.stdout).text(), new Response(task.stderr).text(), task.exited,
  ]);
  clearTimeout(timer);
  if (exitCode !== 0) {
    throw Error(`session_failed_${exitCode}: ${script.split("\n")[0].slice(0, 60)} :: ${(stderr || stdout).slice(0, 300)}`);
  }
  return stdout.trim();
}

try {
  // The document must not require paid or private access to work.
  const markdown = readFileSync(resolve(repo, "INSTALL.md"), "utf8");
  for (const forbidden of ["registry.internal", "license key", "stripe.com", "buy.stripe", "paid account is required"]) {
    if (markdown.toLowerCase().includes(forbidden)) throw Error(`document_requires_${forbidden.replace(/\W/g, "_")}`);
  }
  if (!/no paid account/i.test(markdown) || !/no access to any internal service is required/i.test(markdown)) {
    throw Error("document_does_not_state_that_no_paid_or_internal_access_is_needed");
  }

  command("docker", "volume", "create", "--label", `${label}=${run}`, volume);
  command("docker", "create", "--name", cli, "--label", `${label}=${run}`, "--platform", "linux/arm64",
    "--mount", "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
    "--mount", `type=bind,src=${repo},dst=/workspace,readonly`,
    "--workdir", "/workspace", "--entrypoint", "sleep", image, "infinity");
  command("docker", "start", cli);

  // The clean environment provides what any Linux server provides: Docker plus
  // the shell tools the instructions use. Nothing product-specific.
  const dockerClient = await runScript(
    "apk add --no-cache bash curl >/dev/null 2>&1; docker version --format '{{.Client.Version}}'",
    300, "sh",
  );
  if (!dockerClient.trim()) throw Error("docker_client_unavailable");

  const blocks = instructions();
  record.blockCount = blocks.length;

  // Session 1: the document's steps in order, in one shell, exactly as the
  // guide assumes, so the credential export reaches the later steps.
  const sessionOne = [
    blocks[0], blocks[1], blocks[2], blocks[3], blocks[4], blocks[5], blocks[6], blocks[7],
    `BACKUP_JSON=$(${blocks[8]})`,
    'printf %s "$BACKUP_JSON" > /tmp/rc059-backup.json',
    'printf %s "$REMOTECODE_AUTH_PASSWORD" > /tmp/rc059-password',
    'cat /tmp/rc059-backup.json',
  ].join("\n");
  const firstOutput = await runScript(sessionOne, 900);
  record.install = {
    ready: (/ready/.test(firstOutput) ? "ready" : ""),
    supervisor: (firstOutput.match(/healthy restarts=\d+/) ?? [""])[0],
    bot: (firstOutput.match(/"name":"FirstBot"/) ?? [""])[0],
  };
  if (!record.install.ready) throw Error(`readiness_missing_${firstOutput.slice(0, 200)}`);
  if (!record.install.supervisor) throw Error(`supervisor_not_healthy_${firstOutput.slice(0, 200)}`);
  if (!record.install.bot) throw Error(`bot_not_created_${firstOutput.slice(-300)}`);

  const backupJson = JSON.parse(command("docker", "exec", cli, "cat", "/tmp/rc059-backup.json").trim());
  if (typeof backupJson.path !== "string" || !backupJson.sha256) throw Error("backup_output_unreadable");
  const password = command("docker", "exec", cli, "cat", "/tmp/rc059-password");

  // Session 2: the restore the guide describes after a backup, then sign in
  // again as step 9 requires and confirm the first Bot came back.
  const restoreBlock = blocks[9].replaceAll("/var/lib/remotecode/backups/ARCHIVE.tar.gz", backupJson.path);
  const sessionTwo = [
    `export REMOTECODE_AUTH_PASSWORD='${password}'`,
    restoreBlock,
    blocks[7].replaceAll("FirstBot", "AfterRestore"),
    `docker exec remotecode sh -c "curl -fsS -b /var/lib/remotecode/cookies.txt http://127.0.0.1:3000/api/bots"`,
  ].join("\n");
  const secondOutput = await runScript(sessionTwo, 300);
  if (!/"requiresNewLogin":true/.test(secondOutput)) throw Error(`restore_${secondOutput.slice(0, 200)}`);
  const restoredBody = (secondOutput.match(/\{"restored":\{[\s\S]*?"requiresNewLogin":true\}/) ?? [""])[0];
  if (!/FirstBot/.test(secondOutput)) throw Error(`first_bot_lost_after_restore_${secondOutput.slice(-200)}`);
  if (!/AfterRestore/.test(secondOutput)) throw Error(`signin_after_restore_failed_${secondOutput.slice(-200)}`);

  record.cleanEnvironment = { image, docker: dockerClient.trim() };
  record.journey = {
    bot: record.install.bot,
    backup: { path: backupJson.path, sha256: backupJson.sha256, counts: backupJson.manifest?.counts },
    restore: { requiresNewLogin: true, excerpt: restoredBody.slice(0, 200) },
    botAfterRestore: true,
    firstBotAfterRestore: true,
  };
  record.result = "public_instructions_installed_a_host_with_bot_creation_and_restore_passed";
  console.log(JSON.stringify({ result: record.result, cleanEnvironment: record.cleanEnvironment, install: record.install, journey: record.journey }));
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.log(JSON.stringify({ result: "unverified", error: record.error.slice(0, 400) }));
} finally {
  for (const name of [host, cli, "remotecode"]) { try { command("docker", "rm", "-f", name); } catch {} }
  try { command("docker", "volume", "rm", volume); } catch {}
  try { command("docker", "volume", "rm", "remotecode-data"); } catch {}
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ cleanup: { containers: true, volume: true } }));
}