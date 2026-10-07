# Install RemoteCode yourself

This guide installs the self-managed RemoteCode host on a Linux server that already runs Docker. Everything it needs is public: the image is built from this repository, the data lives in a Docker volume you own, and an external supervisor watches the host. No paid account and no access to any internal service is required.

Every command below is meant to be run in order, from a checkout of this repository. The proof `scripts/rc059/run-install-proof.ts` extracts the fenced commands from this file and runs exactly them, so the document and the verified path cannot drift apart.

## 1. Check the requirements

You need Docker (Engine or Desktop) and this repository on disk. Nothing else: `git`, `curl` and `bash` are already inside the host image.

```bash
docker version
```

## 2. Choose the host credential

The host refuses to start without `REMOTECODE_AUTH_PASSWORD`, a passphrase of at least 16 characters. Generate one and keep it out of version control.

```bash
export REMOTECODE_AUTH_PASSWORD="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 24)"
```

## 3. Build the host image

The image contains the Elysia backend, the web client, Distill, the Linux GUI and the terminal runtime.

```bash
docker build -t remotecode/host:local -f prototype/Dockerfile .
```

## 4. Create the data volume

All durable state lives here: the SQLite database, workspace files, Bot profiles and backups. Deleting this volume deletes the installation's data, so keep it.

```bash
docker volume create remotecode-data
```

## 5. Start the host

The published ports bind to loopback only. Logins are refused over plain HTTP from a non-loopback peer, so put a TLS-terminating proxy in front before exposing it.

```bash
docker run -d --name remotecode --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -e REMOTECODE_AUTH_PASSWORD="$REMOTECODE_AUTH_PASSWORD" \
  -e REMOTECODE_WEB_ORIGIN="http://localhost:5173" \
  -v remotecode-data:/var/lib/remotecode \
  remotecode/host:local
```

## 6. Wait until the host answers

The readiness probe reports only when the database and the backend are usable.

```bash
until docker exec remotecode curl -fsS http://127.0.0.1:3000/api/health/ready >/dev/null 2>&1; do sleep 2; done
docker exec remotecode curl -fsS http://127.0.0.1:3000/api/health/ready
```

## 7. Start the external supervisor

The supervisor runs on the server, outside the container. It probes the Docker daemon, the container, the API and the GUI with hard deadlines, restarts the container at most twice, and reports a lock instead of pretending the host is healthy. It never deletes the data volume.

Run it once by hand: it prints one line and exits, with `0` when the host is healthy and `2` when it locked. Run the same command from your init system (a systemd service or a timer, or a `while true` loop) so a stuck host is detected.

```bash
RC019_CONTAINER=remotecode RC019_API_URL=http://127.0.0.1:3000/api/health/ready \
  bash scripts/rc019/host-supervisor.sh
cat /tmp/rc019-state.json
```

If it prints `locked: reported lock`, the Docker daemon is not answering. Its log states which probe is stuck, the data volume is left untouched, and the recovery is: fix Docker, then run the same command again. Do not delete the volume.

## 8. Sign in and create the first Bot

The API authenticates with a session cookie. Replace the placeholder password with the value from step 2 in your own shell.

```bash
docker exec remotecode sh -c "curl -fsS -c /var/lib/remotecode/cookies.txt -X POST http://127.0.0.1:3000/api/auth/login -H 'content-type: application/json' -d '{\"password\":\"$REMOTECODE_AUTH_PASSWORD\"}' >/dev/null && curl -fsS -b /var/lib/remotecode/cookies.txt -X POST http://127.0.0.1:3000/api/bots -H 'content-type: application/json' -d '{\"name\":\"FirstBot\",\"instructions\":\"Answer briefly.\"}'"
```

## 9. Back up, and restore when needed

A backup archives the database, the workspace files and the Bot profiles, with a manifest that hashes every member. A restore validates the archive before touching live data and reports what returned.

```bash
docker exec remotecode sh -c "curl -fsS -b /var/lib/remotecode/cookies.txt -X POST http://127.0.0.1:3000/api/backup -H 'content-type: application/json' -d '{}'"
```

Restoring takes the absolute archive path printed by the backup (it must stay inside `/var/lib/remotecode/backups`):

```bash
docker exec remotecode sh -c "curl -fsS -b /var/lib/remotecode/cookies.txt -X POST http://127.0.0.1:3000/api/restore -H 'content-type: application/json' -d '{\"archivePath\":\"/var/lib/remotecode/backups/ARCHIVE.tar.gz\"}'"
```

A successful restore answers `requiresNewLogin: true`: sessions from before the restore are invalidated on purpose, so sign in again with step 8. An archive that is truncated, has a missing manifest, or fails a member hash is refused with `invalid_backup` or `backup_corrupt`, and nothing is changed.

## 10. Stop and upgrade

Stop without losing anything, then rebuild and start again on the same volume:

```bash
docker stop remotecode
docker rm remotecode
```

Repeat steps 3 and 5 to run a newer image against the same `remotecode-data` volume.