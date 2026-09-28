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
        var request = URLRequest(url: URL(string: "/__test__/storage-lock", relativeTo: api)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["locked": locked])
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
        let (_, armedResponse) = try await apiSession.data(for: arm)
        XCTAssertEqual((armedResponse as? HTTPURLResponse)?.statusCode, 200)

        let action = "native-recover-\(UUID().uuidString)"
        let input = app.textFields["Action"]
        input.tap()
        input.typeText(action)
        app.staticTexts["Host connection"].firstMatch.tap()
        app.buttons["Submit action"].tap()
        let recovery = app.staticTexts.matching(identifier: "action-recovery-status").firstMatch
        XCTAssertTrue(recovery.waitForLabelContaining("outcome is unknown", timeout: 20), "Lost response must preserve an unknown action, not claim failure or replay")
        XCTAssertFalse(app.buttons["Submit action"].isEnabled)
        let check = app.buttons["Check action receipt"]
        XCTAssertTrue(check.waitForExistence(timeout: 5))
        check.tap()
        XCTAssertTrue(recovery.waitForLabelContaining("could not check", timeout: 15), "A failed receipt observation must keep the action pending")
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
        XCTAssertTrue(app.buttons["Submit action"].isEnabled)
        XCTAssertFalse(app.buttons["Check action receipt"].exists)
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
        XCTAssertTrue(recovery.waitForLabelContaining("unknown", timeout: 20), "Synthetic 401 must not erase a committed login identity")
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
        XCTAssertTrue(recovery.waitForLabelContaining("unknown", timeout: 20))
        XCTAssertFalse(app.buttons["Sign in to host"].isEnabled)
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
    private func enterPassword(_ app: XCUIApplication, value: String? = nil) {
        let input = app.secureTextFields["Host password"]
        XCTAssertTrue(input.waitForExistence(timeout: 15))
        input.tap()
        input.typeText(value ?? password)
        app.staticTexts["Host connection"].firstMatch.tap()
    }

    private func armAuthFault(_ fault: String, using session: URLSession) async throws {
        var request = URLRequest(url: URL(string: "/__test__/auth-fault", relativeTo: api)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["fault": fault])
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
