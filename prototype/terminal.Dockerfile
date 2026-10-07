# The workspace shell the terminal feature spawns.
#
# The terminal contract accepts only an image whose environment is exactly the
# canned PATH/TERM/BUN_* set (apps/api/src/features/terminals.ts
# publicImageEnvironment), so this adds git without adding any ENV: the host
# image, which carries extra variables such as DISPLAY, is refused as a
# terminal image.
FROM oven/bun:1.3.13

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*