import Foundation
import XCTest

private struct ActionReceipt: Decodable {
    let id: String
    let action: String
    let createdAt: String
}

private struct ActionHistory: Decodable {
    let actions: [ActionReceipt]
}

private struct AuthReceiptLookup: Decodable {
    struct Receipt: Decodable {
        let requestId: String
        let kind: String
        let outcome: String
        let targetRequestId: String?
    }
    let receipt: Receipt
    let sessionStatus: String
}

final class RemoteCodeMobileProofUITests: XCTestCase {
    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
    }

    private var api: URL {
        URL(string: ProcessInfo.processInfo.environment["RC_NATIVE_TEST_API_ORIGIN"] ?? "http://127.0.0.1:39211")!
    }
    private let password = "remote-code-native-test-passphrase"

    @MainActor
    func testReadinessShowsRealSQLiteLockAndRecoversWithoutBlockingLogin() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        app.launch()
        let readiness = app.staticTexts.matching(identifier: "host-readiness").firstMatch
        XCTAssertTrue(readiness.waitForLabel("Host ready", timeout: 15))
        try await observer.signIn(at: api, password: password)
        try await setStorageLock(true, using: observer)
        let locked = try await observer.get(URL(string: "/api/health/ready", relativeTo: api)!)
        XCTAssertEqual(locked.statusCode, 503)
        XCTAssertTrue(readiness.waitForLabel("Host not ready", timeout: 15))
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "Native host readiness under SQLite lock"
        shot.lifetime = .keepAlways
        add(shot)
        try await setStorageLock(false, using: observer)
        let recovered = try await observer.get(URL(string: "/api/health/ready", relativeTo: api)!)
        XCTAssertEqual(recovered.statusCode, 200)
        XCTAssertTrue(readiness.waitForLabel("Host ready", timeout: 15))
        signIn(app)
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("connected", timeout: 15))
        let action = "native-health-\(UUID().uuidString)"
        let actionInput = app.textFields["Action"]
        actionInput.tap()
        actionInput.typeText(action)
        app.keyboards.buttons["Return"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        XCTAssertEqual(actionInput.value as? String, action)
        let submit = app.buttons["Submit action"]
        XCTAssertTrue(submit.isEnabled && submit.isHittable)
        submit.tap()
        XCTAssertTrue(app.staticTexts[action].waitForExistence(timeout: 15), "The installed app must submit after readiness recovers")
        let history = try await observer.actions(at: api)
        let receipt = try XCTUnwrap(history.first(where: { $0.action == action }))
        XCTAssertEqual(history.filter { $0.action == action }.count, 1)
        XCTAssertTrue(app.staticTexts["Receipt \(receipt.id)"].exists)
        app.buttons["Sign out"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 15))
    }

    private func setStorageLock(_ locked: Bool, using session: URLSession) async throws {
        var request = URLRequest(url: URL(string: locked ? "/__test__/storage-lock" : "/__test__/storage-unlock", relativeTo: api)!)
        if locked {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["locked": true])
        }
        let (_, response) = try await session.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    @MainActor
    func testInstalledAppUsesAuthenticatedSnapshotEventsAndReceipts() async throws {
        let runID = UUID().uuidString
        let apiSession = URLSession(configuration: .ephemeral)
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        app.launch()
        XCTAssertTrue(app.staticTexts["RemoteCode mobile"].waitForExistence(timeout: 15))

        let passwordInput = app.secureTextFields["Host password"]
        XCTAssertTrue(passwordInput.waitForExistence(timeout: 10))
        passwordInput.tap()
        passwordInput.typeText(password)
        app.staticTexts["Host connection"].firstMatch.tap()
        let signInButton = app.buttons["Sign in to host"]
        XCTAssertTrue(signInButton.isEnabled, "Entering the host password must enable the real sign-in action")
        signInButton.tap()
        let connection = app.staticTexts.matching(identifier: "connection-status").firstMatch
        XCTAssertTrue(connection.waitForExistence(timeout: 10))
        guard connection.waitForLabel("connected", timeout: 15) else {
            let error = app.staticTexts.matching(identifier: "connection-error").firstMatch
            XCTFail("The app did not apply the host snapshot. Status: \(connection.label); error: \(error.exists ? error.label : "none")")
            return
        }

        let eventAction = "native-event-\(runID)"
        try await apiSession.signIn(at: api, password: password)
        let eventReceipt = try await apiSession.submit(eventAction, at: api)
        XCTAssertTrue(app.staticTexts[eventAction].waitForExistence(timeout: 15), "The app must render an action broadcast over its authenticated WebSocket")
        XCTAssertTrue(app.staticTexts["Receipt \(eventReceipt.id)"].exists, "The live event receipt ID must match the API response")

        let submittedAction = "native-submit-\(runID)"
        let actionInput = app.textFields["Action"]
        XCTAssertTrue(actionInput.waitForExistence(timeout: 10))
        actionInput.tap()
        actionInput.typeText(submittedAction)
        app.keyboards.buttons["Return"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5), "The keyboard must be dismissed before tapping Submit action")
        XCTAssertEqual(actionInput.value as? String, submittedAction, "The submitted action must not be changed by keyboard suggestions")
        let submit = app.buttons["Submit action"]
        XCTAssertTrue(submit.isEnabled && submit.isHittable, "Native submit must be interactable after editing the action")
        submit.tap()
        guard app.staticTexts[submittedAction].waitForExistence(timeout: 15) else {
            let actions = try await apiSession.actions(at: api)
            let visibleError = app.staticTexts.matching(identifier: "connection-error").firstMatch
            XCTFail("Native submission did not appear. Input: \(String(describing: actionInput.value)); connection: \(connection.label); error: \(visibleError.exists ? visibleError.label : "none"); persisted actions: \(actions.map(\.action))")
            return
        }
        let history = try await apiSession.actions(at: api)
        let nativeReceipt = try XCTUnwrap(history.first(where: { $0.action == submittedAction }))
        XCTAssertTrue(app.staticTexts["Receipt \(nativeReceipt.id)"].waitForExistence(timeout: 10), "The displayed native receipt ID must match the authoritative API history")

        app.buttons["Sign out"].tap()
        XCTAssertTrue(connection.waitForLabel("signed out", timeout: 10))
        let sessionResponse = try await apiSession.get(URL(string: "/api/auth/session", relativeTo: api)!)
        XCTAssertEqual(sessionResponse.statusCode, 401, "Native sign-out must revoke the persisted host session")
        XCTAssertFalse(app.staticTexts["Receipt \(nativeReceipt.id)"].exists, "Signing out must clear the confirmed receipt from the app")
    }

    @MainActor
    func testPendingActionRecoversAfterLostResponseAndAppRestartWithoutReplay() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let apiSession = URLSession(configuration: .ephemeral)
        app.launch()
        signIn(app)
        try await apiSession.signIn(at: api, password: password)
        var arm = URLRequest(url: URL(string: "/__test__/lose-action-response", relativeTo: api)!)
        arm.httpMethod = "POST"
        arm.setValue("application/json", forHTTPHeaderField: "Content-Type")
        arm.httpBody = try JSONSerialization.data(withJSONObject: ["receiptFault": "stall"])
        let (_, armedResponse) = try await apiSession.data(for: arm)
        XCTAssertEqual((armedResponse as? HTTPURLResponse)?.statusCode, 200)

        let action = "native-recover-\(UUID().uuidString)"
        let input = app.textFields["Action"]
        input.tap()
        input.typeText(action)
        app.staticTexts["Host connection"].firstMatch.tap()
        app.buttons["Submit action"].tap()
        let recovery = app.staticTexts.matching(identifier: "action-recovery-status").firstMatch
        XCTAssertTrue(recovery.waitForLabelContaining("unknown", timeout: 20), "The stalled automatic receipt read must preserve an unknown action without replay")
        XCTAssertFalse(app.buttons["Submit action"].isEnabled)
        let check = app.buttons["Check action receipt"]
        XCTAssertTrue(check.waitForExistence(timeout: 5))
        XCTAssertTrue(recovery.label.contains("unknown"), "A failed automatic receipt observation must keep the action pending")
        XCTAssertFalse(app.buttons["Submit action"].isEnabled)
        XCTAssertGreaterThan(app.scrollViews.firstMatch.frame.minY, app.frame.minY, "Scrollable recovery content must begin below the system status area")
        let pendingScreenshot = XCTAttachment(screenshot: app.screenshot())
        pendingScreenshot.name = "Native pending action"
        pendingScreenshot.lifetime = .keepAlways
        add(pendingScreenshot)

        app.buttons["Sign out"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 10))
        XCTAssertFalse(recovery.exists, "An unresolved request must be hidden after sign-out, not erased from storage")
        signIn(app)
        XCTAssertTrue(app.buttons["Check action receipt"].waitForExistence(timeout: 10))
        app.terminate()
        app.launch()
        signIn(app)
        let restored = app.buttons["Check action receipt"]
        XCTAssertTrue(restored.waitForExistence(timeout: 10), "Pending identity must survive a real app process restart")
        let newInput = app.textFields["Action"]
        newInput.tap()
        newInput.typeText("Do not send while an earlier outcome is unknown")
        app.staticTexts["Host connection"].firstMatch.tap()
        XCTAssertFalse(app.buttons["Submit action"].isEnabled, "A nonempty draft must not bypass pending-action recovery")
        restored.tap()
        XCTAssertTrue(recovery.waitForLabelContaining("Confirmed receipt", timeout: 15))
        try await apiSession.signIn(at: api, password: password)
        let history = try await apiSession.actions(at: api)
        let matching = history.filter { $0.action == action }
        XCTAssertEqual(matching.count, 1)
        let receipt = try XCTUnwrap(matching.first)
        XCTAssertTrue(recovery.label.contains(receipt.id), "Recovery must show the canonical backend receipt")
        XCTAssertTrue(app.staticTexts["Receipt \(receipt.id)"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Check action receipt"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Submit action"].isEnabled)
        let (diagnosticData, diagnosticResponse) = try await apiSession.data(from: URL(string: "/__test__/response-loss", relativeTo: api)!)
        XCTAssertEqual((diagnosticResponse as? HTTPURLResponse)?.statusCode, 200)
        let diagnostics = try JSONDecoder().decode(NativeFailureDiagnostics.self, from: diagnosticData)
        XCTAssertTrue(diagnostics.lostResponse)
        XCTAssertTrue(diagnostics.failedRead)
        XCTAssertEqual(diagnostics.actionPosts, 1, "The app must never replay the POST during failure or process recovery")
        XCTAssertNotNil(UUID(uuidString: diagnostics.requestId))
        let (receiptData, receiptResponse) = try await apiSession.data(from: URL(string: "/api/actions/receipts/\(diagnostics.requestId)", relativeTo: api)!)
        XCTAssertEqual((receiptResponse as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(try JSONDecoder().decode(ActionReceipt.self, from: receiptData).id, receipt.id)
        let recoveredScreenshot = XCTAttachment(screenshot: app.screenshot())
        recoveredScreenshot.name = "Native recovered action"
        recoveredScreenshot.lifetime = .keepAlways
        add(recoveredScreenshot)

        app.buttons["Sign out"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 10))
        XCTAssertFalse(recovery.exists, "Sign-out must clear private recovery state from the view")
    }

    @MainActor
    func testActionDeadlineStartsAtTapAndIgnoresLateReceiptWithoutReplay() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        app.launch()
        signIn(app)
        try await observer.signIn(at: api, password: password)

        var arm = URLRequest(url: URL(string: "/__test__/lose-action-response", relativeTo: api)!)
        arm.httpMethod = "POST"
        arm.setValue("application/json", forHTTPHeaderField: "Content-Type")
        arm.httpBody = try JSONSerialization.data(withJSONObject: ["actionDeadline": true])
        let (_, armedResponse) = try await observer.data(for: arm)
        XCTAssertEqual((armedResponse as? HTTPURLResponse)?.statusCode, 200)

        let action = "native-deadline-\(UUID().uuidString)"
        let input = app.textFields["Action"]
        input.tap()
        input.typeText(action)
        app.keyboards.buttons["Return"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        app.staticTexts["Host connection"].firstMatch.tap()
        let submit = app.buttons["Submit action"]
        XCTAssertTrue(submit.isEnabled && submit.isHittable)
        let tappedAt = ProcessInfo.processInfo.systemUptime
        submit.tap()

        let recovery = app.staticTexts.matching(identifier: "action-recovery-status").firstMatch
        guard recovery.waitForLabelContaining("unknown", timeout: 12) else {
            XCTFail("The receipt that arrived after the tap deadline must not confirm the action")
            return
        }
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - tappedAt, 12)
        XCTAssertFalse(submit.isEnabled, "The pending action must remain blocked until its receipt is checked")
        XCTAssertTrue(app.buttons["Check action receipt"].exists)

        var diagnostics = try await observer.responseLossDiagnostics(at: api)
        XCTAssertTrue(diagnostics.lostResponse)
        XCTAssertEqual(diagnostics.actionPosts, 1, "An uncertain action must never be replayed")
        XCTAssertEqual(diagnostics.receiptReads, 1, "Only the bounded receipt read may run automatically")
        XCTAssertFalse(diagnostics.receiptDelayCompleted, "The server-side receipt response must still be held beyond the UI deadline")
        XCTAssertNotNil(UUID(uuidString: diagnostics.requestId))

        let receiptReleaseDeadline = Date().addingTimeInterval(5)
        while !diagnostics.receiptDelayCompleted && Date() < receiptReleaseDeadline {
            try await Task.sleep(nanoseconds: 100_000_000)
            diagnostics = try await observer.responseLossDiagnostics(at: api)
        }
        XCTAssertTrue(diagnostics.receiptDelayCompleted, "The committed receipt response must eventually arrive after the deadline")
        XCTAssertTrue(recovery.label.contains("unknown"), "A late canonical receipt must not clear the pending state")
        XCTAssertFalse(submit.isEnabled)

        app.buttons["Check action receipt"].tap()
        XCTAssertTrue(recovery.waitForLabelContaining("Confirmed receipt", timeout: 10))
        let history = try await observer.actions(at: api)
        let matching = history.filter { $0.action == action }
        XCTAssertEqual(matching.count, 1)
        let receipt = try XCTUnwrap(matching.first)
        XCTAssertTrue(recovery.label.contains(receipt.id))
        let confirmed = try await observer.responseLossDiagnostics(at: api)
        XCTAssertEqual(confirmed.actionPosts, 1)
        XCTAssertEqual(confirmed.receiptReads, 2)

        let (receiptData, receiptResponse) = try await observer.data(from: URL(string: "/api/actions/receipts/\(confirmed.requestId)", relativeTo: api)!)
        XCTAssertEqual((receiptResponse as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(try JSONDecoder().decode(ActionReceipt.self, from: receiptData).id, receipt.id)
        app.buttons["Sign out"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 10))
    }

    @MainActor
    func testActionPostAcceptedAfterTapDeadlineStaysUnknownUntilManualReceipt() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        app.launch()
        let apiLabel = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Host: ")).firstMatch
        XCTAssertTrue(apiLabel.waitForExistence(timeout: 10), "The installed app must identify its configured test API")
        let api = try XCTUnwrap(URL(string: String(apiLabel.label.dropFirst("Host: ".count))))
        XCTAssertEqual(api.host, "127.0.0.1", "The native failure test must use its local API")
        XCTAssertNotNil(api.port)
        signIn(app)
        XCTAssertFalse(app.buttons["Check action receipt"].exists, "A per-run API origin must not restore a previous action identity")
        try await observer.signIn(at: api, password: password)

        var arm = URLRequest(url: URL(string: "/__test__/lose-action-response", relativeTo: api)!)
        arm.httpMethod = "POST"
        arm.setValue("application/json", forHTTPHeaderField: "Content-Type")
        arm.httpBody = try JSONSerialization.data(withJSONObject: ["actionDeadlinePostDelay": true])
        let (_, armedResponse) = try await observer.data(for: arm)
        XCTAssertEqual((armedResponse as? HTTPURLResponse)?.statusCode, 200)

        let action = "native-postdeadline-\(UUID().uuidString)"
        let input = app.textFields["Action"]
        input.tap()
        input.typeText(action)
        app.keyboards.buttons["Return"].tap()
        app.scrollViews.firstMatch.swipeUp()
        XCTAssertEqual(input.value as? String, action)
        let submit = app.buttons["Submit action"]
        let keyboardVisible = app.keyboards.firstMatch.exists
        let connectionStatus = app.staticTexts.matching(identifier: "connection-status").firstMatch.label
        let priorReceiptCheck = app.buttons["Check action receipt"].exists
        XCTAssertFalse(priorReceiptCheck, "A per-run API origin must not restore an earlier test action")
        guard submit.isEnabled && submit.isHittable else {
            XCTFail("Submit must remain available after entering the action; keyboard=\(keyboardVisible), connection=\(connectionStatus), priorReceiptCheck=\(priorReceiptCheck)")
            let signOut = app.buttons["Sign out"]
            if signOut.exists {
                signOut.tap()
                XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 10))
            }
            return
        }
        let tappedAt = ProcessInfo.processInfo.systemUptime
        submit.tap()

        let recovery = app.staticTexts.matching(identifier: "action-recovery-status").firstMatch
        let tapDeadline = tappedAt + 10
        var unknownAtDeadline = false
        while ProcessInfo.processInfo.systemUptime < tapDeadline + 0.75 {
            if recovery.exists && recovery.label.contains("unknown") {
                unknownAtDeadline = true
                break
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - tappedAt, 11)

        let diagnostics = try await observer.responseLossDiagnostics(at: api)
        XCTAssertEqual(diagnostics.actionPosts, 1, "The real action POST must be pending before judging the tap deadline")
        XCTAssertFalse(diagnostics.actionPostDelayCompleted, "The API must still be before action acceptance at the client deadline")
        XCTAssertEqual(diagnostics.receiptReads, 0, "No automatic receipt request may extend the tap-relative deadline")
        XCTAssertNotNil(UUID(uuidString: diagnostics.requestId))
        let historyBeforeAcceptance = try await observer.actions(at: api)
        XCTAssertFalse(historyBeforeAcceptance.contains(where: { $0.action == action }))
        XCTAssertTrue(unknownAtDeadline, "The action must be unknown by the tap deadline while its real POST is pending; posts=\(diagnostics.actionPosts), accepted=\(diagnostics.actionPostDelayCompleted), receipts=\(diagnostics.receiptReads), matchingActions=\(historyBeforeAcceptance.filter { $0.action == action }.count)")
        XCTAssertFalse(submit.isEnabled, "An action awaiting reconciliation must remain pending")
        XCTAssertTrue(app.buttons["Check action receipt"].exists)
        let releaseAt = tappedAt + 11.5
        while ProcessInfo.processInfo.systemUptime < releaseAt {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - tappedAt, 12)

        var release = URLRequest(url: URL(string: "/__test__/release-action-post", relativeTo: api)!)
        release.httpMethod = "POST"
        let (_, releaseResponse) = try await observer.data(for: release)
        XCTAssertEqual((releaseResponse as? HTTPURLResponse)?.statusCode, 200)

        var completedDiagnostics = try await observer.responseLossDiagnostics(at: api)
        let postReleaseDeadline = Date().addingTimeInterval(5)
        while !completedDiagnostics.actionPostDelayCompleted && Date() < postReleaseDeadline {
            try await Task.sleep(nanoseconds: 100_000_000)
            completedDiagnostics = try await observer.responseLossDiagnostics(at: api)
        }
        XCTAssertTrue(completedDiagnostics.actionPostDelayCompleted, "The real API must accept the delayed action after the client deadline")
        try await Task.sleep(nanoseconds: 1_000_000_000)
        let acceptedDiagnostics = try await observer.responseLossDiagnostics(at: api)
        XCTAssertFalse(acceptedDiagnostics.lostResponse)
        XCTAssertEqual(acceptedDiagnostics.actionPosts, 1, "The action POST must never be replayed")
        XCTAssertEqual(acceptedDiagnostics.receiptReads, 0)
        XCTAssertTrue(recovery.label.contains("unknown"), "A server-side success after the deadline must not clear the pending state")
        XCTAssertFalse(submit.isEnabled)

        let history = try await observer.actions(at: api)
        let matching = history.filter { $0.action == action }
        XCTAssertEqual(matching.count, 1)
        let receipt = try XCTUnwrap(matching.first)
        let receiptCheck = app.buttons["Check action receipt"]
        guard receiptCheck.exists else {
            XCTFail("A late action result must remain unknown until a manual receipt check")
            let signOut = app.buttons["Sign out"]
            if signOut.exists {
                signOut.tap()
                XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 10))
            }
            return
        }
        receiptCheck.tap()
        XCTAssertTrue(recovery.waitForLabelContaining("Confirmed receipt", timeout: 10))
        XCTAssertTrue(recovery.label.contains(receipt.id))
        let confirmed = try await observer.responseLossDiagnostics(at: api)
        XCTAssertEqual(confirmed.actionPosts, 1)
        XCTAssertEqual(confirmed.receiptReads, 1)
        XCTAssertEqual(confirmed.requestId, diagnostics.requestId)

        let (receiptData, receiptResponse) = try await observer.data(from: URL(string: "/api/actions/receipts/\(confirmed.requestId)", relativeTo: api)!)
        XCTAssertEqual((receiptResponse as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(try JSONDecoder().decode(ActionReceipt.self, from: receiptData).id, receipt.id)
        app.buttons["Sign out"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 10))
    }

    @MainActor
    func testAutomaticActionReceiptAfterLostBody() async throws {
        try await verifyAutomaticActionReceipt(receiptFault: "fail")
    }

    @MainActor
    func testAutomaticActionReceiptStallEndsUnknownWithoutReplay() async throws {
        try await verifyAutomaticActionReceipt(receiptFault: "stall")
    }

    @MainActor
    func testAutomaticActionMalformedTimestampStaysUnknownWithoutReplay() async throws {
        try await verifyAutomaticActionReceipt(receiptFault: "malformed")
    }

    @MainActor
    private func verifyAutomaticActionReceipt(receiptFault: String) async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        app.launch()
        signIn(app)
        try await observer.signIn(at: api, password: password)
        var arm = URLRequest(url: URL(string: "/__test__/lose-action-response", relativeTo: api)!)
        arm.httpMethod = "POST"
        arm.setValue("application/json", forHTTPHeaderField: "Content-Type")
        arm.httpBody = try JSONSerialization.data(withJSONObject: ["receiptFault": receiptFault])
        let (_, armed) = try await observer.data(for: arm)
        XCTAssertEqual((armed as? HTTPURLResponse)?.statusCode, 200)
        let action = "native-auto-\(UUID().uuidString)"
        let input = app.textFields["Action"]
        input.tap()
        input.typeText(action)
        app.staticTexts["Host connection"].firstMatch.tap()
        let waitStartedAt = ProcessInfo.processInfo.systemUptime
        app.buttons["Submit action"].tap()
        let status = app.staticTexts.matching(identifier: "action-recovery-status").firstMatch
        if receiptFault != "fail" {
            XCTAssertTrue(status.waitForLabelContaining("unknown", timeout: 24))
            XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - waitStartedAt, 12, "Allow at most two seconds of UI scheduling beyond the ten-second request deadline")
            XCTAssertFalse(app.buttons["Submit action"].isEnabled)
            XCTAssertTrue(app.buttons["Check action receipt"].exists)
        } else {
            XCTAssertTrue(status.waitForLabelContaining("Confirmed receipt", timeout: 20))
            XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - waitStartedAt, 12, "Allow at most two seconds of UI scheduling beyond the ten-second request deadline")
            XCTAssertTrue(app.buttons["Check action receipt"].waitForNonExistence(timeout: 5))
        }
        let history = try await observer.actions(at: api)
        let receipt = try XCTUnwrap(history.first(where: { $0.action == action }))
        XCTAssertEqual(history.filter { $0.action == action }.count, 1)
        if receiptFault == "fail" { XCTAssertTrue(status.label.contains(receipt.id)) }
        let (data, _) = try await observer.data(from: URL(string: "/__test__/response-loss", relativeTo: api)!)
        let diagnostics = try JSONDecoder().decode(NativeFailureDiagnostics.self, from: data)
        XCTAssertTrue(diagnostics.lostResponse)
        XCTAssertTrue(diagnostics.failedRead)
        XCTAssertEqual(diagnostics.actionPosts, 1, "Uncertain POST must never be replayed")
        XCTAssertNotNil(UUID(uuidString: diagnostics.requestId))
        if receiptFault != "fail" {
            XCTAssertEqual(diagnostics.receiptReads, 1, "An unresolved automatic read must not clear the pending action")
            app.buttons["Check action receipt"].tap()
            XCTAssertTrue(status.waitForLabelContaining("Confirmed receipt", timeout: 15))
            let (laterData, _) = try await observer.data(from: URL(string: "/__test__/response-loss", relativeTo: api)!)
            let later = try JSONDecoder().decode(NativeFailureDiagnostics.self, from: laterData)
            XCTAssertEqual(later.receiptReads, 2)
        } else {
            XCTAssertEqual(diagnostics.receiptReads, 2, "A transient 503 permits one delayed read-only retry")
            XCTAssertEqual(diagnostics.receiptReadAtMs.count, 2)
            XCTAssertGreaterThanOrEqual(diagnostics.receiptReadAtMs[1] - diagnostics.receiptReadAtMs[0], 900, "The second receipt lookup must be delayed")
            let (receiptData, receiptResponse) = try await observer.data(from: URL(string: "/api/actions/receipts/\(diagnostics.requestId)", relativeTo: api)!)
            XCTAssertEqual((receiptResponse as? HTTPURLResponse)?.statusCode, 200)
            let mappedReceipt = try JSONDecoder().decode(ActionReceipt.self, from: receiptData)
            XCTAssertEqual(mappedReceipt.id, receipt.id)
            XCTAssertEqual(mappedReceipt.action, action)
        }
        app.buttons["Sign out"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 15))
    }

    @MainActor
    func testNativeLoginDeadlineStartsAtTapAndNeverReplays() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        app.launch()
        let apiLabel = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Host: ")).firstMatch
        XCTAssertTrue(apiLabel.waitForExistence(timeout: 10), "The installed app must identify its configured test API")
        let api = try XCTUnwrap(URL(string: String(apiLabel.label.dropFirst("Host: ".count))))
        XCTAssertEqual(api.host, "127.0.0.1", "The native failure test must use its local API")
        XCTAssertNotNil(api.port)
        XCTAssertFalse(app.buttons["Check auth receipt"].exists, "A per-run API origin must not restore an earlier login identity")
        try await observer.signIn(at: api, password: password)
        try await armAuthFault("login-before", using: observer, loginDeadline: true, at: api)
        enterPassword(app)
        let tappedAt = ProcessInfo.processInfo.systemUptime
        app.buttons["Sign in to host"].tap()

        let recovery = app.staticTexts.matching(identifier: "auth-recovery-status").firstMatch
        let tapDeadline = tappedAt + 13
        var unknownAtDeadline = false
        while ProcessInfo.processInfo.systemUptime < tapDeadline + 0.75 {
            if recovery.exists && recovery.label.contains("unknown") {
                unknownAtDeadline = true
                break
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - tappedAt, 14)

        let diagnosticsURL = URL(string: "/__test__/auth-diagnostics", relativeTo: api)!
        func diagnostics() async throws -> [String: Any] {
            let (data, response) = try await observer.data(from: diagnosticsURL)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        let beforeRelease = try await diagnostics()
        let originalRequestId = try XCTUnwrap(beforeRelease["loginRequestId"] as? String)
        XCTAssertNotNil(UUID(uuidString: originalRequestId))
        XCTAssertEqual(beforeRelease["loginPosts"] as? Int, 1, "The real keyed login must have reached the server before the tap deadline")
        XCTAssertEqual(beforeRelease["loginPostDelayCompleted"] as? Bool, false)
        let automaticReceiptReads = try XCTUnwrap(beforeRelease["loginReceiptReads"] as? Int)
        XCTAssertLessThanOrEqual(automaticReceiptReads, 1, "The sign-in may inspect its receipt at most once")
        XCTAssertEqual(beforeRelease["loginReceiptExists"] as? Bool, false, "The login handler has not accepted this request")
        XCTAssertTrue(unknownAtDeadline, "The login must be unknown by the tap deadline while its real POST is pending; posts=\(beforeRelease["loginPosts"] ?? "missing"), accepted=\(beforeRelease["loginPostDelayCompleted"] ?? "missing"), receipts=\(beforeRelease["loginReceiptReads"] ?? "missing"), receiptExists=\(beforeRelease["loginReceiptExists"] ?? "missing")")
        XCTAssertFalse(app.buttons["Sign in to host"].isEnabled)
        XCTAssertTrue(app.buttons["Check auth receipt"].exists)

        let releaseAt = tappedAt + 14.5
        while ProcessInfo.processInfo.systemUptime < releaseAt {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        var release = URLRequest(url: URL(string: "/__test__/release-login-post", relativeTo: api)!)
        release.httpMethod = "POST"
        let (_, releaseResponse) = try await observer.data(for: release)
        XCTAssertEqual((releaseResponse as? HTTPURLResponse)?.statusCode, 200)

        var afterRelease = try await diagnostics()
        let completionDeadline = Date().addingTimeInterval(5)
        while (afterRelease["loginPostDelayCompleted"] as? Bool) != true && Date() < completionDeadline {
            try await Task.sleep(nanoseconds: 100_000_000)
            afterRelease = try await diagnostics()
        }
        XCTAssertEqual(afterRelease["loginPostDelayCompleted"] as? Bool, true)
        XCTAssertEqual(afterRelease["loginPosts"] as? Int, 1, "The uncertain login must never be replayed")
        XCTAssertEqual(afterRelease["loginReceiptReads"] as? Int, automaticReceiptReads, "The expired operation must not start another automatic receipt lookup")
        XCTAssertTrue(recovery.label.contains("unknown"), "Late pre-acceptance rejection must not change the expired result")

        app.buttons["Check auth receipt"].tap()
        XCTAssertTrue(recovery.waitForLabelContaining("No auth receipt", timeout: 15))
        XCTAssertFalse(app.buttons["Sign in to host"].isEnabled)
        app.buttons["Revoke old login"].tap()
        XCTAssertTrue(recovery.waitForLabelContaining("revocation confirmed", timeout: 15))
        app.buttons["Sign in to host"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("connected", timeout: 15))
        let finalDiagnostics = try await diagnostics()
        XCTAssertEqual(finalDiagnostics["loginPosts"] as? Int, 2, "One timed-out login and one new login after explicit recovery are expected")
        XCTAssertEqual(finalDiagnostics["loginReceiptReads"] as? Int, automaticReceiptReads + 1, "Only the explicit manual receipt check may run after the deadline")
        XCTAssertEqual(finalDiagnostics["revokePosts"] as? Int, 1)
        XCTAssertEqual(finalDiagnostics["logoutPosts"] as? Int, 0)
        let newLoginRequestId = try XCTUnwrap(finalDiagnostics["loginRequestId"] as? String)
        XCTAssertNotEqual(newLoginRequestId, originalRequestId)
        app.buttons["Sign out"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 15))
    }

    @MainActor
    func testNativeLoginPreflightDeadlineSendsNoRequestAndAllowsManualRetry() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        app.launch()
        let apiLabel = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Host: ")).firstMatch
        XCTAssertTrue(apiLabel.waitForExistence(timeout: 10), "The installed app must identify its configured test API")
        let api = try XCTUnwrap(URL(string: String(apiLabel.label.dropFirst("Host: ".count))))
        XCTAssertEqual(api.host, "127.0.0.1", "The native preflight failure test must use its local API")
        XCTAssertFalse(app.buttons["Check auth receipt"].exists, "A per-run API origin must not restore an earlier login identity")
        try await observer.signIn(at: api, password: password)
        try await armAuthFault("login-before", using: observer, loginPreflightDeadline: true, at: api)
        enterPassword(app)

        let tappedAt = ProcessInfo.processInfo.systemUptime
        let signIn = app.buttons["Sign in to host"]
        signIn.tap()
        let (startedData, startedResponse) = try await observer.data(from: URL(string: "/__test__/wait-login-version", relativeTo: api)!)
        XCTAssertEqual((startedResponse as? HTTPURLResponse)?.statusCode, 200)
        let started = try XCTUnwrap(JSONSerialization.jsonObject(with: startedData) as? [String: Any])
        XCTAssertEqual(started["loginVersionRequests"] as? Int, 1)

        let oldPerRequestTimeoutAt = tappedAt + 11
        while ProcessInfo.processInfo.systemUptime < oldPerRequestTimeoutAt {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - tappedAt, 12)
        XCTAssertFalse(signIn.isEnabled, "The tap-relative 13-second budget must remain active after the old per-request timeout")
        let recovery = app.staticTexts.matching(identifier: "auth-recovery-status").firstMatch
        XCTAssertFalse(recovery.exists, "The host capability request has not reached the total deadline yet")

        XCTAssertTrue(recovery.waitForLabelContaining("The sign-in deadline expired before the host could be checked", timeout: 4))
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - tappedAt, 14.5)
        XCTAssertTrue(recovery.label.contains("No login request was sent"))
        XCTAssertTrue(signIn.isEnabled, "Capability expiry is a known no-effect result and permits a user-initiated retry")
        XCTAssertFalse(app.buttons["Check auth receipt"].exists, "No keyed login identity was saved before capability negotiation")

        let diagnosticsURL = URL(string: "/__test__/auth-diagnostics", relativeTo: api)!
        func diagnostics() async throws -> [String: Any] {
            let (data, response) = try await observer.data(from: diagnosticsURL)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        var beforeRelease = try await diagnostics()
        XCTAssertEqual(beforeRelease["loginVersionRequests"] as? Int, 1)
        XCTAssertEqual(beforeRelease["loginPosts"] as? Int, 0)
        XCTAssertNil(beforeRelease["loginRequestId"] as? String)
        XCTAssertEqual(beforeRelease["loginReceiptReads"] as? Int, 0)
        XCTAssertEqual(beforeRelease["loginReceiptExists"] as? Bool, false)

        var release = URLRequest(url: URL(string: "/__test__/release-login-version", relativeTo: api)!)
        release.httpMethod = "POST"
        let (_, releaseResponse) = try await observer.data(for: release)
        XCTAssertEqual((releaseResponse as? HTTPURLResponse)?.statusCode, 200)
        let (finishedData, finishedResponse) = try await observer.data(from: URL(string: "/__test__/wait-login-version-finished", relativeTo: api)!)
        XCTAssertEqual((finishedResponse as? HTTPURLResponse)?.statusCode, 200)
        let finished = try XCTUnwrap(JSONSerialization.jsonObject(with: finishedData) as? [String: Any])
        XCTAssertEqual(finished["loginVersionRequests"] as? Int, 1)
        XCTAssertEqual(finished["loginVersionRequestFinished"] as? Bool, true)
        beforeRelease = try await diagnostics()
        XCTAssertEqual(beforeRelease["loginPosts"] as? Int, 0, "A late capability response must not start the expired login")
        XCTAssertNil(beforeRelease["loginRequestId"] as? String)
        XCTAssertTrue(recovery.label.contains("No login request was sent"))

        signIn.tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("connected", timeout: 15), "A fresh user-initiated attempt may succeed after capability negotiation recovers")
        let afterRetry = try await diagnostics()
        XCTAssertEqual(afterRetry["loginVersionRequests"] as? Int, 2)
        XCTAssertEqual(afterRetry["loginPosts"] as? Int, 1, "Only the explicit retry may send a login")
        let freshRequestId = try XCTUnwrap(afterRetry["loginRequestId"] as? String)
        XCTAssertNotNil(UUID(uuidString: freshRequestId))
        XCTAssertEqual(afterRetry["loginReceiptExists"] as? Bool, true)
        app.buttons["Sign out"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 15))
    }

    @MainActor
    func testAuthBeforeAcceptanceRequiresFenceBeforeNewLogin() async throws {
        let observer = URLSession(configuration: .ephemeral)
        try await observer.signIn(at: api, password: password)
        try await armAuthFault("login-before", using: observer)
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        app.launch()
        enterPassword(app)
        app.buttons["Sign in to host"].tap()
        let recovery = app.staticTexts.matching(identifier: "auth-recovery-status").firstMatch
        XCTAssertTrue(recovery.waitForLabelContaining("unknown", timeout: 20))
        app.buttons["Check auth receipt"].tap()
        XCTAssertTrue(recovery.waitForLabelContaining("No auth receipt", timeout: 15))
        XCTAssertFalse(app.buttons["Sign in to host"].isEnabled, "Missing receipt is not proof of rollback")
        let (data, _) = try await observer.data(from: URL(string: "/__test__/auth-diagnostics", relativeTo: api)!)
        let diagnostics = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let oldId = try XCTUnwrap(diagnostics["loginRequestId"] as? String)
        var fence = URLRequest(url: URL(string: "/api/auth/login/\(oldId)/revoke", relativeTo: api)!)
        fence.httpMethod = "POST"
        fence.setValue("application/json", forHTTPHeaderField: "Content-Type")
        fence.httpBody = try JSONSerialization.data(withJSONObject: ["password": password, "requestId": UUID().uuidString])
        let (_, fenceResponse) = try await observer.data(for: fence)
        XCTAssertEqual((fenceResponse as? HTTPURLResponse)?.statusCode, 200)
        app.buttons["Check auth receipt"].tap()
        XCTAssertTrue(recovery.waitForLabelContaining("closed before acceptance", timeout: 15), "A fenced login must not appear as a created session")
        app.buttons["Revoke old login"].tap()
        XCTAssertTrue(recovery.waitForLabelContaining("revocation confirmed", timeout: 15))
        var delayed = URLRequest(url: URL(string: "/api/auth/login", relativeTo: api)!)
        delayed.httpMethod = "POST"
        delayed.setValue("application/json", forHTTPHeaderField: "Content-Type")
        delayed.httpBody = try JSONSerialization.data(withJSONObject: ["password": password, "requestId": oldId])
        let (_, response) = try await observer.data(for: delayed)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 409, "A delayed original login must be fenced at the real API")
        app.buttons["Sign in to host"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("connected", timeout: 15))
        app.buttons["Sign out"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 15))
    }

    @MainActor
    func testAuthSynthetic401AfterCommitKeepsOriginalPendingIdentity() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        try await observer.signIn(at: api, password: password)
        let diagnosticsURL = URL(string: "/__test__/auth-diagnostics", relativeTo: api)!
        func counters() async throws -> [String: Any] {
            let (data, response) = try await observer.data(from: diagnosticsURL)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        let initial = try await counters()
        try await armAuthFault("login-401", using: observer)
        app.launch()
        enterPassword(app)
        app.buttons["Sign in to host"].tap()
        let recovery = app.staticTexts.matching(identifier: "auth-recovery-status").firstMatch
        XCTAssertTrue(recovery.waitForLabelContaining("A session was created", timeout: 20), "Synthetic 401 must not erase a committed login identity")
        XCTAssertTrue(app.buttons["Check auth receipt"].exists)
        XCTAssertFalse(app.buttons["Sign in to host"].isEnabled)
        let afterLogin = try await counters()
        XCTAssertEqual(afterLogin["loginPosts"] as? Int, (initial["loginPosts"] as? Int ?? 0) + 1)
        let loginId = try XCTUnwrap(afterLogin["loginRequestId"] as? String)
        let loginLookup = try await observer.lookupAuthReceipt(at: api, requestId: loginId, password: password)
        XCTAssertEqual(loginLookup.receipt.outcome, "session_created", "The real host created the session despite synthetic 401")
        XCTAssertEqual(loginLookup.sessionStatus, "active")
        app.terminate()
        app.launch()
        enterPassword(app)
        app.buttons["Check auth receipt"].tap()
        XCTAssertTrue(recovery.waitForLabelContaining("matching cookie is not confirmed", timeout: 15))
        try await armAuthFault("revoke-401", using: observer)
        app.buttons["Revoke old login"].tap()
        XCTAssertTrue(recovery.waitForLabelContaining("unknown", timeout: 20), "Synthetic 401 must not replace a committed revocation identity with the old login")
        XCTAssertTrue(app.buttons["Check auth receipt"].exists)
        XCTAssertFalse(app.buttons["Sign in to host"].isEnabled)
        let afterRevoke = try await counters()
        XCTAssertEqual(afterRevoke["revokePosts"] as? Int, (initial["revokePosts"] as? Int ?? 0) + 1)
        let revokeId = try XCTUnwrap(afterRevoke["revokeRequestId"] as? String)
        XCTAssertNotEqual(revokeId, loginId)
        let revokeLookup = try await observer.lookupAuthReceipt(at: api, requestId: revokeId, password: password)
        XCTAssertEqual(revokeLookup.receipt.targetRequestId, loginId)
        XCTAssertEqual(revokeLookup.receipt.outcome, "login_revoked")
        app.terminate()
        app.launch()
        enterPassword(app)
        app.buttons["Check auth receipt"].tap()
        XCTAssertTrue(recovery.waitForLabelContaining("revocation confirmed", timeout: 15))
        XCTAssertTrue(app.buttons["Sign in to host"].isEnabled)
        let verified = try await counters()
        XCTAssertEqual(verified["loginPosts"] as? Int, (initial["loginPosts"] as? Int ?? 0) + 1, "Receipt reads must not replay the original login")
        XCTAssertEqual(verified["revokePosts"] as? Int, (initial["revokePosts"] as? Int ?? 0) + 1, "Receipt reads must not replay the revocation")
        app.buttons["Sign in to host"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("connected", timeout: 15))
        app.buttons["Sign out"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 15))
    }

    @MainActor
    func testAuthRecoveryRetainsIdentityAcrossRestartAndNeverReplays() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        app.launch()
        signIn(app)
        app.terminate()
        try await observer.signIn(at: api, password: password)
        try await armAuthFault("login-cookie", using: observer)
        app.launch()
        enterPassword(app)
        app.buttons["Sign in to host"].tap()
        let recovery = app.staticTexts.matching(identifier: "auth-recovery-status").firstMatch
        XCTAssertTrue(recovery.waitForLabelContaining("A session was created", timeout: 20))
        XCTAssertFalse(app.buttons["Sign in to host"].isEnabled)
        let (autoData, _) = try await observer.data(from: URL(string: "/__test__/auth-diagnostics", relativeTo: api)!)
        let auto = try XCTUnwrap(JSONSerialization.jsonObject(with: autoData) as? [String: Any])
        XCTAssertEqual(auto["loginPosts"] as? Int, 1)
        XCTAssertEqual(auto["loginReceiptReads"] as? Int, 1)
        app.terminate()
        app.launch()
        XCTAssertTrue(app.buttons["Check auth receipt"].waitForExistence(timeout: 15))
        enterPassword(app, value: "wrong-password")
        app.buttons["Check auth receipt"].tap()
        XCTAssertTrue(recovery.waitForLabelContaining("could not check", timeout: 15))
        XCTAssertFalse(app.buttons["Sign in to host"].isEnabled)
        app.buttons["Revoke old login"].tap()
        XCTAssertTrue(recovery.waitForLabelContaining("Revocation was rejected", timeout: 15))
        XCTAssertTrue(app.buttons["Revoke old login"].exists, "A definite credential rejection must keep the original login recoverable")
        app.terminate()
        app.launch()
        enterPassword(app)
        app.buttons["Check auth receipt"].tap()
        XCTAssertTrue(recovery.waitForLabelContaining("matching cookie is not confirmed", timeout: 15), "A receipt must not be confused with an authenticated native cookie")
        XCTAssertFalse(app.textFields["Action"].exists)
        try await armAuthFault("revoke-body", using: observer)
        app.buttons["Revoke old login"].tap()
        XCTAssertTrue(recovery.waitForLabelContaining("unknown", timeout: 20))
        app.terminate()
        app.launch()
        enterPassword(app)
        app.buttons["Check auth receipt"].tap()
        XCTAssertTrue(recovery.waitForLabelContaining("revocation confirmed", timeout: 15))
        XCTAssertTrue(app.buttons["Sign in to host"].isEnabled)
        let (data, _) = try await observer.data(from: URL(string: "/__test__/auth-diagnostics", relativeTo: api)!)
        let diagnostics = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(diagnostics["loginPosts"] as? Int, 1)
        XCTAssertEqual(diagnostics["revokePosts"] as? Int, 2, "One credential rejection and one distinct authorized revocation, with no replay")
        let loginId = try XCTUnwrap(diagnostics["loginRequestId"] as? String)
        let revokeId = try XCTUnwrap(diagnostics["revokeRequestId"] as? String)
        XCTAssertNotEqual(loginId, revokeId)
        XCTAssertNotNil(UUID(uuidString: loginId))
        XCTAssertNotNil(UUID(uuidString: revokeId))

        try await armAuthFault("login-body", using: observer)
        app.buttons["Sign in to host"].tap()
        let connection = app.staticTexts.matching(identifier: "connection-status").firstMatch
        if !connection.waitForLabel("connected", timeout: 15) {
            XCTAssertTrue(app.buttons["Check auth receipt"].isEnabled)
            app.buttons["Check auth receipt"].tap()
        }
        XCTAssertTrue(connection.waitForLabel("connected", timeout: 15), "Lost body requires a confirmed matching cookie, not a replay")
        try await armAuthFault("logout-body", using: observer)
        app.buttons["Sign out"].tap()
        XCTAssertTrue(recovery.waitForLabelContaining("unknown", timeout: 20))
        XCTAssertFalse(app.textFields["Action"].exists)
        app.terminate()
        app.launch()
        enterPassword(app)
        app.buttons["Check auth receipt"].tap()
        XCTAssertTrue(recovery.waitForLabelContaining("Sign-out confirmed", timeout: 15))
        try await observer.signIn(at: api, password: password)
        let (logoutData, _) = try await observer.data(from: URL(string: "/__test__/auth-diagnostics", relativeTo: api)!)
        let logoutDiagnostics = try XCTUnwrap(JSONSerialization.jsonObject(with: logoutData) as? [String: Any])
        XCTAssertEqual(logoutDiagnostics["loginPosts"] as? Int, 2, "Restarts and receipt checks must not replay login")
        XCTAssertEqual(logoutDiagnostics["logoutPosts"] as? Int, 1, "Logout recovery must only look up the original receipt")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "Native auth receipt recovery after restart"
        shot.lifetime = .keepAlways
        add(shot)
        app.buttons["Sign in to host"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("connected", timeout: 15))
        app.buttons["Sign out"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 15))
    }

    @MainActor
    func testStalledAutomaticLoginReceiptRetainsPendingIdentity() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        try await observer.signIn(at: api, password: password)
        try await armAuthFault("login-cookie-stall", using: observer)
        app.launch()
        enterPassword(app)
        let loginStartedAt = Date()
        app.buttons["Sign in to host"].tap()
        let recovery = app.staticTexts.matching(identifier: "auth-recovery-status").firstMatch
        XCTAssertFalse(app.buttons["Sign in to host"].isEnabled)
        XCTAssertTrue(recovery.waitForLabelContaining("unknown", timeout: 15))
        XCTAssertLessThan(Date().timeIntervalSince(loginStartedAt), 14.5, "Automatic auth observation must finish within its post-persistence deadline")
        let (data, _) = try await observer.data(from: URL(string: "/__test__/auth-diagnostics", relativeTo: api)!)
        let diagnostics = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(diagnostics["loginPosts"] as? Int, 1)
        XCTAssertEqual(diagnostics["loginReceiptReads"] as? Int, 1)
        app.terminate()
        app.launch()
        XCTAssertTrue(app.buttons["Check auth receipt"].waitForExistence(timeout: 15))
        enterPassword(app)
        app.buttons["Check auth receipt"].tap()
        XCTAssertTrue(recovery.waitForLabelContaining("matching cookie is not confirmed", timeout: 15))
        app.buttons["Revoke old login"].tap()
        XCTAssertTrue(recovery.waitForLabelContaining("revocation confirmed", timeout: 15))
        app.buttons["Sign in to host"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("connected", timeout: 15))
        app.buttons["Sign out"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 15))
    }

    @MainActor
    private func enterPassword(_ app: XCUIApplication, value: String? = nil) {
        let input = app.secureTextFields["Host password"]
        XCTAssertTrue(input.waitForExistence(timeout: 15))
        input.tap()
        input.typeText(value ?? password)
        app.staticTexts["Host connection"].firstMatch.tap()
    }

    private func armAuthFault(_ fault: String, using session: URLSession, loginDeadline: Bool = false, loginPreflightDeadline: Bool = false, at baseURL: URL? = nil) async throws {
        var request = URLRequest(url: URL(string: "/__test__/auth-fault", relativeTo: baseURL ?? api)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["fault": fault]
        if loginDeadline { body["loginDeadline"] = true }
        if loginPreflightDeadline { body["loginPreflightDeadline"] = true }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (_, response) = try await session.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    @MainActor
    private func signIn(_ app: XCUIApplication) {
        let input = app.secureTextFields["Host password"]
        XCTAssertTrue(input.waitForExistence(timeout: 15))
        input.tap()
        input.typeText(password)
        app.staticTexts["Host connection"].firstMatch.tap()
        app.buttons["Sign in to host"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("connected", timeout: 15))
    }
}

private struct NativeFailureDiagnostics: Decodable {
    let lostResponse: Bool
    let failedRead: Bool
    let receiptReads: Int
    let receiptReadAtMs: [Int]
    let receiptDelayCompleted: Bool
    let actionPostDelayCompleted: Bool
    let actionPosts: Int
    let requestId: String
}

private extension XCUIElement {
    func waitForLabelContaining(_ expected: String, timeout: TimeInterval) -> Bool {
        let predicate = NSPredicate(format: "label CONTAINS %@", expected)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: self)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    func waitForLabel(_ expected: String, timeout: TimeInterval) -> Bool {
        let predicate = NSPredicate(format: "label == %@", expected)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: self)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }
}

private extension URLSession {
    func responseLossDiagnostics(at baseURL: URL) async throws -> NativeFailureDiagnostics {
        let (data, response) = try await data(from: URL(string: "/__test__/response-loss", relativeTo: baseURL)!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try JSONDecoder().decode(NativeFailureDiagnostics.self, from: data)
    }

    func lookupAuthReceipt(at baseURL: URL, requestId: String, password: String) async throws -> AuthReceiptLookup {
        var request = URLRequest(url: URL(string: "/api/auth/receipts/\(requestId)/lookup", relativeTo: baseURL)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["password": password])
        let (data, response) = try await self.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try JSONDecoder().decode(AuthReceiptLookup.self, from: data)
    }
    func signIn(at baseURL: URL, password: String) async throws {
        var request = URLRequest(url: URL(string: "/api/auth/login", relativeTo: baseURL)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("http://localhost:5173", forHTTPHeaderField: "Origin")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["password": password])
        let (_, response) = try await data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    func submit(_ action: String, at baseURL: URL) async throws -> ActionReceipt {
        var request = URLRequest(url: URL(string: "/api/actions", relativeTo: baseURL)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["action": action])
        let (data, response) = try await data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 201)
        return try JSONDecoder().decode(ActionReceipt.self, from: data)
    }

    func actions(at baseURL: URL) async throws -> [ActionReceipt] {
        let (data, response) = try await data(from: URL(string: "/api/actions", relativeTo: baseURL)!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try JSONDecoder().decode(ActionHistory.self, from: data).actions
    }

    func get(_ url: URL) async throws -> HTTPURLResponse {
        let (_, response) = try await data(from: url)
        return try XCTUnwrap(response as? HTTPURLResponse)
    }
}
