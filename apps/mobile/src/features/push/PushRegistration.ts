import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { mapNotificationToDestination } from "../../navigation/notification-routing";
import type { NotificationDestination } from "../../navigation/types";

const deviceIdKey = "remotecode.push.deviceId";

export type PushRegistrationResult =
  | { success: true; deviceId: string; platform: string; token: string; permission: string }
  | { success: false; reason: string; details: unknown };

function randomDeviceId() {
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  return `install-${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// One push device per install. Registering under the session id instead would
// make every sign-in a new device, and each new row would receive its own copy
// of every alert.
export async function installDeviceId(storage: Pick<typeof AsyncStorage, "getItem" | "setItem"> = AsyncStorage) {
  const stored = await storage.getItem(deviceIdKey);
  if (stored) return stored;
  const created = randomDeviceId();
  await storage.setItem(deviceIdKey, created);
  return created;
}

export async function registerForPushNotifications(
  origin: string,
  storage: Pick<typeof AsyncStorage, "getItem" | "setItem"> = AsyncStorage,
): Promise<PushRegistrationResult> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    return { success: false, reason: "push_not_supported_on_this_platform", details: Platform.OS };
  }
  const deviceId = await installDeviceId(storage);

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== "granted") {
    return { success: false, reason: "permission_denied", details: "Push notification permission was not granted." };
  }

  let token: string;
  try {
    // The Expo push token needs a project id; without one the call throws and
    // the registration stops here rather than claiming a token it never had.
    token = (await Notifications.getExpoPushTokenAsync({ projectId: process.env.EXPO_PUBLIC_PROJECT_ID })).data;
  } catch (error) {
    return { success: false, reason: "token_unavailable", details: error instanceof Error ? error.message : String(error) };
  }

  const response = await fetch(`${origin}/api/push/devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId, platform: Platform.OS, token, permission: "granted" }),
  });
  if (!response.ok) {
    return { success: false, reason: "registration_failed", details: await response.json().catch(() => ({})) };
  }
  return { success: true, deviceId, platform: Platform.OS, token, permission: "granted" };
}

export function handleNotificationTap(
  notification: Notifications.Notification,
): NotificationDestination | null {
  const content = notification.request.content as { data?: { deepLink?: unknown } };
  const deepLink = content.data?.deepLink;
  if (typeof deepLink !== "object" || deepLink === null) return null;
  return mapNotificationToDestination(deepLink as Record<string, unknown>);
}