#!/usr/bin/env bash
# RC-054's Linux host for the Windows leg: the same host the macOS proof starts
# locally, on a machine GitHub's Windows runner can reach. This is the
# instance's startup script; the passphrase and the branch come from instance
# metadata so they are not written into the repository.
#
#   gcloud compute instances add-metadata <vm> \
#     --metadata rc054-password=<passphrase>,rc054-branch=<branch>
set -euxo pipefail

exec > /var/log/rc054-prov.log 2>&1

meta() {
  curl -fsS -H 'Metadata-Flavor: Google' \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"
}

PASSWORD="$(meta rc054-password)"
BRANCH="$(meta rc054-branch)"

for _ in $(seq 1 60); do
  apt-get update && break
  sleep 5
done
DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io git openssl curl
systemctl enable --now docker

rm -rf /opt/repo
git clone --depth 1 --branch "$BRANCH" \
  https://github.com/samuelfaj/remote-code.git /opt/repo
cd /opt/repo
docker build -t remotecode/host:local -f prototype/Dockerfile .

# The macOS proof reuses the certificate and the environment names below; the
# web origin is the Windows runner's own Vite port, exactly as on this machine.
mkdir -p /opt/proof
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 2 \
  -keyout /opt/proof/key.pem -out /opt/proof/cert.pem \
  -subj "/CN=RemoteCode RC-054 proof" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

docker volume create rc054-data
docker run -d --name rc054-linux --restart unless-stopped \
  -p 0.0.0.0:8443:3000 -v rc054-data:/var/lib/remotecode \
  -e API_PORT=3000 -e DATABASE_PATH=/var/lib/remotecode/rc054.sqlite \
  -e REMOTECODE_AUTH_PASSWORD="$PASSWORD" \
  -e REMOTECODE_WEB_ORIGIN=http://127.0.0.1:37124 \
  -e REMOTECODE_DISPLAY=:99 \
  remotecode/host:local sleep infinity
docker cp /opt/proof/cert.pem rc054-linux:/proof-cert.pem
docker cp /opt/proof/key.pem rc054-linux:/proof-key.pem
docker exec rc054-linux bash -lc 'chmod 600 /proof-key.pem'
docker exec -d rc054-linux bash -lc "cd /workspace && DISPLAY=:99 API_PORT=3000 \
  DATABASE_PATH=/var/lib/remotecode/rc054.sqlite REMOTECODE_AUTH_PASSWORD='$PASSWORD' \
  REMOTECODE_WEB_ORIGIN='http://127.0.0.1:37124' \
  REMOTECODE_TLS_CERT=/proof-cert.pem REMOTECODE_TLS_KEY=/proof-key.pem \
  bun apps/api/src/index.ts > /var/log/rc054-api.log 2>&1"

for _ in $(seq 1 120); do
  curl -sk --fail https://127.0.0.1:8443/api/health/ready >/dev/null 2>&1 && break
  sleep 2
done
curl -sk --fail https://127.0.0.1:8443/api/health/ready > /var/log/rc054-ready
echo provisioned > /var/log/rc054-provisioned
