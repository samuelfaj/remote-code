FROM oven/bun:1.3.13

ARG DISTILL_VERSION=2.0.33
ARG DISTILL_SHA256_AARCH64=f270e93957452d63526a5b42c0e2ae7c2f0307ae71df03b7a45a2679663a6473
ARG DISTILL_SHA256_X86_64=b132c32acbecf887c9ea2a1f93e6eb62c27b5f090e9a3c6eb708224a8c25bfcc
ARG LINUX_USE_COMMIT=ee0231ce80c56bbeec2daa68363c9e4477a4a923

ENV DISPLAY=:99 \
    XDG_SESSION_TYPE=x11 \
    API_PORT=3000 \
    DATABASE_PATH=/var/lib/remotecode/remotecode.sqlite

VOLUME ["/var/lib/remotecode"]

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates chromium curl git imagemagick nodejs openbox python3 wmctrl x11-apps x11-utils xdotool xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
         amd64) dsha="$DISTILL_SHA256_X86_64" ;; \
         arm64) dsha="$DISTILL_SHA256_AARCH64" ;; \
         *) echo "unsupported arch $arch" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/samuelfaj/distill/releases/download/v$DISTILL_VERSION/distill-linux-$([ "$arch" = amd64 ] && echo x86_64 || echo aarch64)" -o /usr/local/bin/distill \
    && echo "$dsha  /usr/local/bin/distill" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/distill \
    && useradd --create-home --uid 1001 rcagent \
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
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/client/package.json packages/client/package.json
RUN bun install --frozen-lockfile
COPY apps/api apps/api
COPY apps/web apps/web
COPY apps/mobile apps/mobile
COPY packages/client packages/client
COPY playwright.config.ts ./
COPY scripts/linux-use-smoke.py scripts/linux-use-smoke.py
COPY scripts/linux-guest-browser-proof.mjs scripts/linux-guest-browser-proof.mjs
COPY scripts/rc002/acp_client.py scripts/rc002/acp_client.py
COPY scripts/rc023/linux-use-session.py scripts/rc023/linux-use-session.py
COPY prototype/start.sh prototype/start.sh
RUN chmod 0755 prototype/start.sh

# ImageMagick embeds the current time in PNG output, so the same window would
# hash differently on every capture and linux-use would always reject its own
# state token as stale. Reproducible-build mode makes the bytes depend only on
# the pixels. Scoped to runtime, after the build steps above.
ENV SOURCE_DATE_EPOCH=0

EXPOSE 3000 5173
CMD ["./prototype/start.sh"]
