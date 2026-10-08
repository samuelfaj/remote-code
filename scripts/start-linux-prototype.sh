#!/bin/sh
set -eu

IMAGE=${RC003_IMAGE:-remotecode-rc003:local}
CONTAINER=${RC003_CONTAINER:-new-remote-code-rc003-proof}
LINUX_USE_COMMIT=${LINUX_USE_COMMIT:-fe6b2048f71685672ceeec34a8e765540bc8ba55}

if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "Container $CONTAINER already exists; refusing to replace it." >&2
  exit 1
fi

docker build --platform linux/amd64 \
  --build-arg LINUX_USE_COMMIT="$LINUX_USE_COMMIT" \
  -f prototype/Dockerfile -t "$IMAGE" .
docker run --rm --name "$CONTAINER" --platform linux/amd64 \
  -p 127.0.0.1:33100:3000 -p 127.0.0.1:35173:5173 "$IMAGE"
