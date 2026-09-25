FROM --platform=linux/amd64 oven/bun:1.3.13

ARG DISTILL_SHA256=6e21372a858f7b563e038b6f0bdf3dd7da2e8d02f6cc9dfe2e9aca3b269e19a0
ARG LINUX_USE_COMMIT=fe6b2048f71685672ceeec34a8e765540bc8ba55

ENV DISPLAY=:99 \
    XDG_SESSION_TYPE=x11 \
    API_PORT=3000

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates chromium curl git nodejs openbox python3 wmctrl x11-utils xdotool xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://github.com/samuelfaj/distill/releases/download/v2.0.14/distill-linux-x86_64 -o /usr/local/bin/distill \
    && echo "$DISTILL_SHA256  /usr/local/bin/distill" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/distill \
    && git init /opt/linux-use \
    && git -C /opt/linux-use remote add origin https://github.com/samuelfaj/linux-use.git \
    && git -C /opt/linux-use fetch --depth=1 origin "$LINUX_USE_COMMIT" \
    && git -C /opt/linux-use checkout --detach FETCH_HEAD \
    && test "$(git -C /opt/linux-use rev-parse HEAD)" = "$LINUX_USE_COMMIT" \
    && rm -rf /opt/linux-use/.git

WORKDIR /workspace
COPY package.json bun.lock tsconfig.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/client/package.json packages/client/package.json
RUN bun install --frozen-lockfile
COPY apps/api apps/api
COPY apps/web apps/web
COPY packages/client packages/client
COPY playwright.config.ts ./
COPY scripts/linux-use-smoke.py scripts/linux-use-smoke.py
COPY scripts/linux-guest-browser-proof.mjs scripts/linux-guest-browser-proof.mjs
COPY prototype/start.sh prototype/start.sh
RUN chmod 0755 prototype/start.sh

EXPOSE 3000 5173
CMD ["./prototype/start.sh"]
