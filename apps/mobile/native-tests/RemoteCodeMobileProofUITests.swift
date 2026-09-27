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
}

private extension XCUIElement {
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
