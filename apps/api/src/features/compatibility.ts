import { Elysia } from "elysia";

const currentApiVersion = 1;
const supportedClientVersions = { hosted: { minimum: 0, maximum: 1 }, selfManaged: { minimum: 0, maximum: 1 } };

export function clientVersionRejection(version: string | null) {
  if (version === null) return null;
  if (!/^(0|[1-9]\d*)$/.test(version)) return unsupportedClientVersion();
  const parsed = Number(version);
  if (!Number.isSafeInteger(parsed) || parsed < supportedClientVersions.hosted.minimum
    || parsed > supportedClientVersions.hosted.maximum) return unsupportedClientVersion();
  return null;
}

function unsupportedClientVersion() {
  return {
    error: "unsupported_client_version" as const,
    message: "This RemoteCode client version is not supported. Update the host or use a supported client version.",
    supportedClientVersions,
  };
}

export function compatibilityFeature() {
  return new Elysia({ name: "compatibility" })
    .get("/api/version", () => ({
      apiVersion: currentApiVersion,
      supportedClientVersions,
      capabilities: ["action-receipts", "event-snapshots-v1"],
    }))
    .onBeforeHandle({ as: "global" }, ({ request, set }) => {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/") || url.pathname.startsWith("/api/health/")
        || url.pathname === "/api/version" || url.pathname === "/api/events") return;

      const rejection = clientVersionRejection(request.headers.get("x-remotecode-client-version"));
      if (!rejection) return;
      set.status = 426;
      return rejection;
    });
}

export function eventClientVersionRejection(request: Request) {
  const url = new URL(request.url);
  return clientVersionRejection(url.searchParams.get("clientVersion"));
}
