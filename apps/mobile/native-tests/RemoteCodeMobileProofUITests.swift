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
        app.staticTexts["Confirmed receipts"].firstMatch.tap()
        app.buttons["Submit action"].tap()
        XCTAssertTrue(app.staticTexts[submittedAction].waitForExistence(timeout: 15))
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
