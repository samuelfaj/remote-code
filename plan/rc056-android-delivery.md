# RC-056: Deliver Android App — Final Report

## Completed work

### 1. Android project generated
- Ran `bunx expo prebuild --platform android --no-install` from `apps/mobile/`
- `apps/mobile/android/` now exists as a real Gradle project in the repo
- Package ID: `com.remotecode.mobileproof` (already set in `app.json`)
- Android project includes: `app/`, `build.gradle`, `gradle/`, `gradlew`, `settings.gradle`
- `minSdk 24`, `compileSdk 36`, `targetSdk 36`, `buildTools 36.0.0`
- No `apps/mobile/android/` edits were needed — the package ID was already configured in `app.json`

### 2. AVD created and booted
- AVD name: `rc056-android`
- Device: Pixel (Google)
- Target: Google APIs, Android 15 (API 35), `google_apis/arm64-v8a`
- Boot args: `-no-window -no-audio -gpu swiftshader_indirect -no-snapshot -no-boot-anim -no-metrics`
- Emulator was online: `emulator-5554device`, `sys.boot_completed=1`
- Android version: 15 (VanillaIceCream), model: `sdk_gphone64_arm64`

### 3. Debug app build started
- Command: `bunx expo run:android` (started in background)
- Gradle 8.14.3 downloaded successfully
- NDK 27.1.12297006 accepted and installing
- Build was running ~6+ minutes before being stopped
- App was not yet installed on the emulator

### 4. Tests and typecheck
- `bun test apps/mobile`: **18 pass, 0 fail, 84 expect calls** (navigation tests + file-rules tests)
- `bun run typecheck`: **passed** (`tsc --noEmit -p tsconfig.json` — no errors)

## What remains unverified

1. **App build and install** — `bunx expo run:android` was stopped before completion. The app has not been installed on the emulator.
2. **Proof script** (`scripts/rc056/run-android-proof.sh`) — not yet written. The task requires a shell script that:
   - Starts the API on this Mac on a free port
   - Boots the emulator, installs the app
   - Drives the journey with `adb shell input` / `adb shell am`
   - Verifies push registration, Inbox item survival after force-stop, and routing to the correct thread
3. **Push routing proof** — the task requires proving the host dispatcher sends the item's destination to a local stand-in (reusing the RC-047 approach), then feeding the payload through `mapNotificationToDestination`/`handleNotificationTap`. FCM is not available on this Mac.
4. **Android UI changes** — no Android-specific UI changes were made. The React Native app renders the same UI on Android as iOS (same `App.tsx`, same navigation, same screens). The `app.json` already had `android.package` configured.

## Ceiling explicitly recorded

- **On-device Google transport (FCM) unverified** — no FCM credentials or Google Cloud project is configured in this environment. The proof script will use the same local push provider stand-in approach as RC-047 (`scripts/rc047/push-endpoint.ts`) to prove the dispatcher sends the payload to the configured endpoint, then feed that payload through the shipped `mapNotificationToDestination` handler.
- **Android-specific API changes not made** — the API (`apps/api/src/features/push.ts`) already supports `platform: "android"` in the push device registration and delivery dispatch. No API changes are needed.

## Key files and paths

- Android project: `apps/mobile/android/`
- App config: `apps/mobile/app.json` (android.package = `com.remotecode.mobileproof`)
- Push registration: `apps/mobile/src/features/push/PushRegistration.ts`
- Notification routing: `apps/mobile/src/navigation/notification-routing.ts`
- Push API: `apps/api/src/features/push.ts`
- RC-055 proof (reference): `scripts/rc055/run-push-routing-proof.ts`
- RC-047 proof (reference): `scripts/rc047/run-push-proof.ts`
- Push endpoint stand-in: `scripts/rc047/push-endpoint.ts`
