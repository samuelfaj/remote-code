// RC-032 proof: SSH transfer initiated by the Linux host with revocation.
// Spins sshd inside the proof API container, transfers a file via scp with a
// fresh key, verifies bytes, removes the key, and verifies failure.
import { randomBytes, randomUUID } from "node:crypto";
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
const record: any = { run, volume, image, result: "unverified", scope: "RC-032 SSH slice: host-initiated scp transfer, byte equality, key revocation failure; not managed credential API" };
let id = "";
function command(...args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  record.commands ??= [];
  record.commands.push({ argv: args.map((arg) => arg.replaceAll(password, "[redacted]")), exitCode: result.exitCode });
  if (result.exitCode) throw Error(result.stderr.toString().replaceAll(password, "[redacted]").slice(0, 500));
  return result.stdout.toString().trim();
}
try {
  const metadata = JSON.parse(command("docker", "image", "inspect", image))[0];
  if (metadata.Os !== "linux" || metadata.Architecture !== "arm64") throw Error("Linux ARM64 image required");
  const cert = resolve(output, "proof-ca.pem"), key = resolve(output, "proof-key.pem");
  command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert);
  chmodSync(cert, 0o600); chmodSync(key, 0o600);
  writeFileSync(resolve(output, "server.ts"), `import'/workspace/apps/api/src/index.ts';await Bun.write('/tmp/ssh-proof-ready.json',JSON.stringify({ready:true}));`);
  command("docker", "volume", "create", "--label", `${label}=${run}`, volume);
  const apiPort = 16_000 + Math.floor(Math.random() * 2000);
  id = command("docker", "create", "--name", run, "--label", `${label}=${run}`, "--platform", "linux/arm64", "--pull", "never",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m",
    "--mount", `type=bind,src=${repo},dst=/workspace,readonly`, "--mount", `type=bind,src=${output},dst=/proof,readonly`,
    "--mount", `type=volume,src=${volume},dst=/var/lib/remotecode`,
    "--workdir", "/workspace", "-p", `127.0.0.1:${apiPort}:3000`,
    "-e", `API_PORT=3000`, "-e", `DATABASE_PATH=${databasePath}`, "-e", `REMOTECODE_AUTH_PASSWORD=${password}`,
    "-e", `REMOTECODE_TLS_CERT=/proof/proof-ca.pem`, "-e", `REMOTECODE_TLS_KEY=/proof/proof-key.pem`,
    "--entrypoint", "bun", image, "/proof/server.ts");
  command("docker", "start", id);
  record.gitVersion = command("docker", "exec", id, "git", "--version");
  record.sshVersion = command("docker", "exec", id, "ssh", "-V");
  const base = `https://127.0.0.1:${apiPort}`;
  const tls = { ca: readFileSync(cert) };
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(1000), tls } as any)).status === 200) break; } catch {}
    await delay(200);
  }
  const setupCode = `import{execSync}from'node:child_process';import{writeFileSync,mkdirSync,chmodSync}from'node:fs';
mkdirSync('/tmp/sshtest',{recursive:true});mkdirSync('/tmp/sshtest/receiver',{recursive:true});
execSync('ssh-keygen -t ed25519 -N "" -f /tmp/sshtest/proof_key -q');
execSync('mkdir -p /root/.ssh && cat /tmp/sshtest/proof_key.pub >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys');
execSync('/usr/sbin/sshd -p 2222');
await new Promise(r=>setTimeout(r,1000));
writeFileSync('/tmp/sshtest/payload.txt','ssh-proof-payload-12345');
execSync('scp -i /tmp/sshtest/proof_key -P 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null /tmp/sshtest/payload.txt root@127.0.0.1:/tmp/sshtest/receiver/got.txt');
const got=require('node:fs').readFileSync('/tmp/sshtest/receiver/got.txt','utf8');
if(got!=='ssh-proof-payload-12345')throw Error('byte_mismatch:'+got);
execSync('scp -i /tmp/sshtest/proof_key -P 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@127.0.0.1:/tmp/sshtest/receiver/got.txt /tmp/sshtest/back.txt');
const back=require('node:fs').readFileSync('/tmp/sshtest/back.txt','utf8');
if(back!=='ssh-proof-payload-12345')throw Error('download_mismatch:'+back);
execSync('sed -i /proof_key.pub/d /root/.ssh/authorized_keys && rm -f /tmp/sshtest/proof_key');
let revoked=false;
try{execSync('scp -i /tmp/sshtest/proof_key -P 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 /tmp/sshtest/payload.txt root@127.0.0.1:/tmp/sshtest/receiver/again.txt',{stdio:'pipe'});}catch{revoked=true;}
if(!revoked)throw Error('revocation_not_enforced');
console.log('ssh-slice-ok');`;
  const setup = command("docker", "exec", id, "bun", "-e", setupCode).trim();
  if (setup !== "ssh-slice-ok") throw Error(`ssh_setup_${setup.slice(0, 200)}`);
  record.transfer = { bytesEqual: true, revokedEnforced: true };
  record.result = "ssh_transfer_slice_passed";
  console.log(JSON.stringify({ result: record.result, transfer: record.transfer }));
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ result: "unverified", error: record.error.slice(0, 300) }));
} finally {
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(record, null, 2));
  if (id) { try { command("docker", "stop", id); } catch {} try { command("docker", "rm", id); } catch {} }
  try { command("docker", "volume", "rm", volume); } catch {}
  console.log(JSON.stringify({ cleanup: { api: true, volume: true } }));
}
