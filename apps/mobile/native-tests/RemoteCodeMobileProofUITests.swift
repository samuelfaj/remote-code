import CryptoKit
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

private struct BotMetadata: Decodable {
    let id: String
    let name: String
}

private struct ThreadMetadata: Decodable {
    let id: String
    let workspaceId: String
    let title: String
}

private struct RunMetadata: Decodable {
    let id: String
    let state: String
}

private struct InboxItemMetadata: Decodable {
    let id: String
    let title: String
    let state: String
    let runId: String?
}

private struct InboxListMetadata: Decodable {
    let items: [InboxItemMetadata]
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
        let hostLabel = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Host: ")).firstMatch
        let api = try XCTUnwrap(URL(string: String(hostLabel.label.dropFirst("Host: ".count))))

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
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        for character in submittedAction {
            actionInput.typeText(String(character))
        }
        app.keyboards.buttons["Return"].tap()
        app.staticTexts["Host connection"].firstMatch.tap()
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
    func testActionReceiptUnauthorizedClearsPrivateWorkspaceState() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        app.launch()
        let apiLabel = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Host: ")).firstMatch
        XCTAssertTrue(apiLabel.waitForExistence(timeout: 10))
        let api = try XCTUnwrap(URL(string: String(apiLabel.label.dropFirst("Host: ".count))))
        XCTAssertEqual(api.host, "127.0.0.1")
        XCTAssertEqual(api.port, 39211)
        signIn(app)
        try await observer.signIn(at: api, password: password)


        let runID = UUID().uuidString
        let workspaceName = "native-privacy-workspace-\(runID)"
        for _ in 0..<5 where !app.staticTexts["Workspaces"].exists {
            app.scrollViews.firstMatch.swipeUp()
        }
        XCTAssertTrue(app.staticTexts["Workspaces"].waitForExistence(timeout: 10))
        let workspaceNameInput = app.textFields["Workspace name"]
        workspaceNameInput.tap()
        workspaceNameInput.typeText(workspaceName)
        app.keyboards.buttons["Return"].tap()
        app.buttons["Create workspace"].tap()
        XCTAssertTrue(app.staticTexts["Workspace change confirmed."].waitForExistence(timeout: 15))
        app.buttons["Open workspace \(workspaceName)"].tap()
        XCTAssertTrue(app.staticTexts["Selected: \(workspaceName)"].waitForExistence(timeout: 10))
        let workspaceRows = try await observer.workspaceList(at: api)
        let workspace = try XCTUnwrap(workspaceRows.first { $0.name == workspaceName })
        let initialWorkspace = try await observer.workspace(at: api, id: workspace.id)
        XCTAssertEqual(initialWorkspace.name, workspaceName)

        func fixtureRequest(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> (Any, HTTPURLResponse) {
            var request = URLRequest(url: URL(string: path, relativeTo: api)!)
            request.httpMethod = method
            if let body {
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
            }
            let (data, response) = try await observer.data(for: request)
            return (try JSONSerialization.jsonObject(with: data), try XCTUnwrap(response as? HTTPURLResponse))
        }

        let (armed, armResponse) = try await fixtureRequest("/__test__/lose-action-response", method: "POST", body: ["privacyUnauthorizedReceipt": true])
        XCTAssertEqual(armResponse.statusCode, 200)
        XCTAssertEqual((armed as? [String: Any])?["armed"] as? Bool, true)
        let action = "native-privacy-action-\(runID)"
        let actionInput = app.textFields["Action"]
        for _ in 0..<5 where !actionInput.isHittable {
            app.scrollViews.firstMatch.swipeDown()
        }
        XCTAssertTrue(actionInput.isHittable)
        actionInput.tap()
        actionInput.typeText(action)
        app.keyboards.buttons["Return"].tap()
        app.buttons["Submit action"].tap()

        let (waitingData, waitingResponse) = try await fixtureRequest("/__test__/wait-privacy-receipt")
        XCTAssertEqual(waitingResponse.statusCode, 200)
        let waiting = try XCTUnwrap(waitingData as? [String: Any])
        let requestId = try XCTUnwrap(waiting["privacyReceiptRequestId"] as? String)
        XCTAssertEqual(waiting["privacyReceiptReads"] as? Int, 1)
        XCTAssertEqual(waiting["privacySessionRevocations"] as? Int, 1)
        XCTAssertEqual(UUID(uuidString: requestId)?.uuidString.lowercased(), requestId.lowercased())
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("connected", timeout: 5), "The native WebSocket must not report expiry before the held receipt lookup replies")
        XCTAssertTrue(app.staticTexts["Workspaces"].exists)
        XCTAssertTrue(app.staticTexts[workspaceName].exists)
        XCTAssertTrue(app.staticTexts["Selected: \(workspaceName)"].exists)
        let actionsBeforeReceiptReply = try await observer.actions(at: api)
        let matchingActionReceipts = actionsBeforeReceiptReply.filter { $0.action == action }
        XCTAssertEqual(matchingActionReceipts.count, 1)
        let actionReceipt = try XCTUnwrap(matchingActionReceipts.first)

        let (released, releaseResponse) = try await fixtureRequest("/__test__/release-privacy-receipt", method: "POST")
        XCTAssertEqual(releaseResponse.statusCode, 200)
        XCTAssertEqual((released as? [String: Any])?["released"] as? Bool, true)
        let connection = app.staticTexts.matching(identifier: "connection-status").firstMatch
        XCTAssertTrue(connection.waitForLabel("signed out", timeout: 10), "The real action receipt route's 401 must clear the native session")
        XCTAssertFalse(app.staticTexts["Workspaces"].exists)
        XCTAssertFalse(app.staticTexts[workspaceName].exists)
        XCTAssertFalse(app.staticTexts["Selected: \(workspaceName)"].exists)
        XCTAssertFalse(app.staticTexts["Receipt \(actionReceipt.id)"].exists)
        try await Task.sleep(nanoseconds: 1_500_000_000)
        XCTAssertEqual(connection.label, "signed out")
        XCTAssertFalse(app.staticTexts["Workspaces"].exists, "Late action callbacks must not restore private workspace state")
        XCTAssertFalse(app.staticTexts[workspaceName].exists)

        let (diagnosticData, diagnosticResponse) = try await fixtureRequest("/__test__/response-loss")
        XCTAssertEqual(diagnosticResponse.statusCode, 200)
        let diagnostics = try XCTUnwrap(diagnosticData as? [String: Any])
        XCTAssertEqual(diagnostics["lostResponse"] as? Bool, true)
        XCTAssertEqual(diagnostics["actionPosts"] as? Int, 1)
        XCTAssertEqual(diagnostics["receiptReads"] as? Int, 1)
        XCTAssertEqual(diagnostics["requestId"] as? String, requestId)
        XCTAssertEqual(diagnostics["privacyReceiptReads"] as? Int, 1)
        XCTAssertEqual(diagnostics["privacySessionRevocations"] as? Int, 1)
        XCTAssertEqual(diagnostics["privacyReceiptRequestId"] as? String, requestId)
        XCTAssertEqual(diagnostics["privacyReceiptResponseStatus"] as? Int, 401)
        let observedWorkspace = try await observer.workspace(at: api, id: workspace.id)
        XCTAssertEqual(observedWorkspace.name, workspaceName)
        XCTAssertEqual(observedWorkspace.archived, false)

        var logout = URLRequest(url: URL(string: "/api/auth/logout", relativeTo: api)!)
        logout.httpMethod = "POST"
        logout.setValue("application/json", forHTTPHeaderField: "Content-Type")
        logout.httpBody = Data("{}".utf8)
        let (_, logoutResponse) = try await observer.data(for: logout)
        XCTAssertEqual((logoutResponse as? HTTPURLResponse)?.statusCode, 204)
    }

    @MainActor
    func testWorkspaceUnauthorizedClearsBusyActionAndIgnoresOldReceiptAfterRelogin() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        app.launch()
        let apiLabel = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Host: ")).firstMatch
        XCTAssertTrue(apiLabel.waitForExistence(timeout: 10))
        let api = try XCTUnwrap(URL(string: String(apiLabel.label.dropFirst("Host: ".count))))
        XCTAssertEqual(api.host, "127.0.0.1")
        XCTAssertEqual(api.port, 39211)
        signIn(app)
        try await observer.signIn(at: api, password: password)

        let runID = UUID().uuidString
        let workspaceName = "native-privacy-workspace-\(runID)"
        for _ in 0..<5 where !app.staticTexts["Workspaces"].exists {
            app.scrollViews.firstMatch.swipeUp()
        }
        let workspaceNameInput = app.textFields["Workspace name"]
        XCTAssertTrue(workspaceNameInput.waitForExistence(timeout: 10))
        workspaceNameInput.tap()
        workspaceNameInput.typeText(workspaceName)
        app.keyboards.buttons["Return"].tap()
        app.buttons["Create workspace"].tap()
        XCTAssertTrue(app.staticTexts["Workspace change confirmed."].waitForExistence(timeout: 15))
        app.buttons["Open workspace \(workspaceName)"].tap()
        XCTAssertTrue(app.staticTexts["Selected: \(workspaceName)"].waitForExistence(timeout: 10))
        let workspaceRows = try await observer.workspaceList(at: api)
        let workspace = try XCTUnwrap(workspaceRows.first { $0.name == workspaceName })
        let originalMetadata = try await observer.workspace(at: api, id: workspace.id)
        XCTAssertEqual(originalMetadata.name, workspaceName)

        func fixtureRequest(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> (Any, HTTPURLResponse) {
            var request = URLRequest(url: URL(string: path, relativeTo: api)!)
            request.httpMethod = method
            if let body {
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
            }
            let (data, response) = try await observer.data(for: request)
            return (try JSONSerialization.jsonObject(with: data), try XCTUnwrap(response as? HTTPURLResponse))
        }

        let (armed, armResponse) = try await fixtureRequest("/__test__/lose-action-response", method: "POST", body: ["privacyUnauthorizedReceipt": true])
        XCTAssertEqual(armResponse.statusCode, 200)
        XCTAssertEqual((armed as? [String: Any])?["armed"] as? Bool, true)
        let action = "native-privacy-action-\(runID)"
        let actionInput = app.textFields["Action"]
        for _ in 0..<5 where !actionInput.isHittable {
            app.scrollViews.firstMatch.swipeDown()
        }
        XCTAssertTrue(actionInput.isHittable)
        actionInput.tap()
        actionInput.typeText(action)
        app.keyboards.buttons["Return"].tap()
        app.buttons["Submit action"].tap()

        let (waitingData, waitingResponse) = try await fixtureRequest("/__test__/wait-privacy-receipt")
        XCTAssertEqual(waitingResponse.statusCode, 200)
        let waiting = try XCTUnwrap(waitingData as? [String: Any])
        let requestId = try XCTUnwrap(waiting["privacyReceiptRequestId"] as? String)
        XCTAssertEqual(waiting["privacyReceiptReads"] as? Int, 1)
        XCTAssertEqual(waiting["privacySessionRevocations"] as? Int, 1)
        XCTAssertEqual(UUID(uuidString: requestId)?.uuidString.lowercased(), requestId.lowercased())
        let acceptedActions = try await observer.actions(at: api)
        XCTAssertEqual(acceptedActions.filter { $0.action == action }.count, 1, "The observer must see exactly one accepted action before workspace refresh")
        let actionReceipt = try XCTUnwrap(acceptedActions.first { $0.action == action })
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("connected", timeout: 3))
        XCTAssertFalse(app.buttons["Submit action"].isEnabled, "The original action must remain busy while its receipt lookup is held")

        for _ in 0..<5 where !app.buttons["Refresh workspaces"].isHittable {
            app.scrollViews.firstMatch.swipeUp()
        }
        let refresh = app.buttons["Refresh workspaces"]
        XCTAssertTrue(refresh.isEnabled && refresh.isHittable)
        refresh.tap()
        let connection = app.staticTexts.matching(identifier: "connection-status").firstMatch
        XCTAssertTrue(connection.waitForLabel("signed out", timeout: 5), "Workspace GET 401 must clear the root session while action receipt remains held")
        XCTAssertFalse(app.staticTexts["Workspaces"].exists)
        XCTAssertFalse(app.staticTexts[workspaceName].exists)
        XCTAssertFalse(app.staticTexts["Selected: \(workspaceName)"].exists)
        let signInButton = app.buttons["Sign in to host"]
        XCTAssertTrue(signInButton.waitForExistence(timeout: 5))
        let passwordInput = app.secureTextFields["Host password"]
        passwordInput.tap()
        passwordInput.typeText(password)
        app.staticTexts["Host connection"].firstMatch.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        XCTAssertTrue(signInButton.isEnabled && signInButton.isHittable, "Workspace expiry must clear action busy state while its old receipt request remains held")
        signInButton.tap()
        XCTAssertTrue(connection.waitForLabel("connected", timeout: 10))
        for _ in 0..<5 where !app.staticTexts[workspaceName].exists {
            app.scrollViews.firstMatch.swipeUp()
        }
        XCTAssertTrue(app.staticTexts["Workspaces"].exists)
        XCTAssertTrue(app.staticTexts[workspaceName].exists)
        XCTAssertFalse(app.staticTexts["Selected: \(workspaceName)"].exists, "A new login must not inherit the earlier workspace selection")

        let (released, releaseResponse) = try await fixtureRequest("/__test__/release-privacy-receipt", method: "POST")
        XCTAssertEqual(releaseResponse.statusCode, 200)
        XCTAssertEqual((released as? [String: Any])?["released"] as? Bool, true)
        var diagnostics: [String: Any] = [:]
        let oldReceiptDeadline = Date().addingTimeInterval(10)
        repeat {
            let (data, response) = try await fixtureRequest("/__test__/response-loss")
            XCTAssertEqual(response.statusCode, 200)
            diagnostics = try XCTUnwrap(data as? [String: Any])
            if diagnostics["privacyReceiptResponseStatus"] as? Int == 401 { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        } while Date() < oldReceiptDeadline
        XCTAssertEqual(diagnostics["privacyReceiptResponseStatus"] as? Int, 401, "The held old receipt must return 401 before checking replacement-session state")
        try await Task.sleep(nanoseconds: 1_500_000_000)
        XCTAssertTrue(connection.waitForLabel("connected", timeout: 5), "Old receipt 401 must not sign out the replacement session")
        XCTAssertTrue(app.staticTexts["Workspaces"].exists)
        XCTAssertTrue(app.staticTexts[workspaceName].exists)
        XCTAssertFalse(app.staticTexts["Selected: \(workspaceName)"].exists)
        let receiptCheck = app.buttons["Check action receipt"]
        XCTAssertTrue(receiptCheck.waitForExistence(timeout: 5))
        receiptCheck.tap()
        let recovery = app.staticTexts.matching(identifier: "action-recovery-status").firstMatch
        XCTAssertTrue(recovery.waitForLabelContaining("Confirmed receipt", timeout: 15), "Manual receipt check must clear the interrupted pending identity")
        XCTAssertTrue(recovery.label.contains(actionReceipt.id), "Manual recovery must show the canonical receipt held before relogin")
        XCTAssertTrue(app.staticTexts["Receipt \(actionReceipt.id)"].waitForExistence(timeout: 10))
        XCTAssertTrue(receiptCheck.waitForNonExistence(timeout: 5), "A confirmed receipt must clear pending action identity")
        let refreshedButton = app.buttons["Refresh workspaces"]
        for _ in 0..<5 where !refreshedButton.isHittable {
            app.scrollViews.firstMatch.swipeUp()
        }
        XCTAssertTrue(refreshedButton.isEnabled && refreshedButton.isHittable)
        refreshedButton.tap()
        XCTAssertTrue(app.staticTexts[workspaceName].waitForExistence(timeout: 10), "The replacement session must still complete a real workspace refresh")
        app.buttons["Open workspace \(workspaceName)"].tap()
        XCTAssertTrue(app.staticTexts["Selected: \(workspaceName)"].waitForExistence(timeout: 10))

        let (diagnosticData, diagnosticResponse) = try await fixtureRequest("/__test__/response-loss")
        XCTAssertEqual(diagnosticResponse.statusCode, 200)
        diagnostics = try XCTUnwrap(diagnosticData as? [String: Any])
        XCTAssertEqual(diagnostics["lostResponse"] as? Bool, true)
        XCTAssertEqual(diagnostics["actionPosts"] as? Int, 1, "Receipt recovery must not replay the action POST")
        XCTAssertEqual(diagnostics["receiptReads"] as? Int, 2)
        XCTAssertEqual(diagnostics["requestId"] as? String, requestId)
        XCTAssertEqual(diagnostics["privacyReceiptReads"] as? Int, 2)
        XCTAssertEqual(diagnostics["privacySessionRevocations"] as? Int, 1)
        XCTAssertEqual(diagnostics["privacyReceiptRequestId"] as? String, requestId)
        XCTAssertEqual(diagnostics["privacyReceiptResponseStatus"] as? Int, 200)
        let unchangedMetadata = try await observer.workspace(at: api, id: workspace.id)
        XCTAssertEqual(unchangedMetadata.id, originalMetadata.id)
        XCTAssertEqual(unchangedMetadata.name, workspaceName)
        let finalWorkspaces = try await observer.workspaceList(at: api)
        XCTAssertEqual(finalWorkspaces.count, 1)

        let signOut = app.buttons["Sign out"]
        for _ in 0..<5 where !signOut.isHittable {
            app.scrollViews.firstMatch.swipeDown()
        }
        XCTAssertTrue(signOut.isEnabled && signOut.isHittable)
        signOut.tap()
        XCTAssertTrue(connection.waitForLabel("signed out", timeout: 10))
        XCTAssertFalse(app.staticTexts["Workspaces"].exists)
        let revokedObserverSession = try await observer.get(URL(string: "/api/auth/session", relativeTo: api)!)
        XCTAssertEqual(revokedObserverSession.statusCode, 401)
    }

    @MainActor
    func testInstalledAppPreparesLinuxFolderAndCreatesFileFromConfirmedState() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        let (api, workspace) = try await fileWorkspace(app, observer: observer, prefix: "native-prepare-", prepareInApp: true)
        let path = "rc021-prepared-native.txt"
        let text = "native user-prepared folder"
        try app.textFields["New file path"].clearAndTypeText(path, in: app)
        try app.textViews["New file text"].clearAndTypeText(text, in: app)
        try tapFileControl("Create file", in: app)
        let status = app.staticTexts.matching(identifier: "file-status").firstMatch
        guard status.waitForLabelContaining("receipt confirmed", timeout: 12) else { XCTFail("The actual prepared folder must allow native CREATE"); return }
        try openNativeFile(path, in: app)
        XCTAssertEqual(app.textViews["File draft"].value as? String, text)
        let actual = try await observer.openFile(at: api, workspaceId: workspace.id, path: path)
        XCTAssertEqual(actual.content, text)
        XCTAssertFalse(app.buttons["Prepare workspace folder"].exists, "Confirmed folder must not offer a fresh preparation ID")
        XCTAssertFalse(app.staticTexts.matching(identifier: "pending-folder").firstMatch.exists)
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "Native file in explicitly user-prepared Linux folder"; shot.lifetime = .keepAlways; add(shot)
        app.terminate(); app.launch(); signIn(app)
        try selectFileWorkspace(workspace.name, in: app)
        try openNativeFile(path, in: app)
        XCTAssertEqual(app.textViews["File draft"].value as? String, text)
        XCTAssertFalse(app.staticTexts.matching(identifier: "pending-folder").firstMatch.exists)
        app.buttons["Sign out"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 10))
    }

    @MainActor
    func testInstalledAppKeepsDraftChangedDuringMovePreflightWithoutSendingPost() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        let (api, workspace) = try await fileWorkspace(app, observer: observer, prefix: "native-preflight-")
        let source = "native-preflight.txt"
        let destination = "native-preflight-moved.txt"
        let created = try await observer.createFile(at: api, workspaceId: workspace.id, path: source, content: "")
        try openNativeFile(source, in: app)
        let draft = app.textViews["File draft"]
        XCTAssertEqual(draft.value as? String, "")
        try app.textFields["Move destination path"].clearAndTypeText(destination, in: app)
        try await observer.armFileSaveLoss(at: api, nonce: UUID().uuidString, workspaceId: workspace.id, path: destination, kind: "move", sourcePath: source, phase: "preflight")
        let folderURL = URL(string: "/api/workspaces/\(workspace.id)/folder", relativeTo: api)!
        async let firstRead = observer.get(folderURL)
        async let secondRead = observer.get(folderURL)
        var concurrent = try await observer.fileSaveLossDiagnostics(at: api)
        for _ in 0..<20 where !concurrent.held {
            try await Task.sleep(nanoseconds: 100_000_000)
            concurrent = try await observer.fileSaveLossDiagnostics(at: api)
        }
        guard concurrent.held && concurrent.preflightGets == 1 else { XCTFail("Concurrent owner reads must reserve only one preflight hold"); return }
        try await observer.releaseFileSaveLoss(at: api)
        let readOne = try await firstRead
        let readTwo = try await secondRead
        XCTAssertEqual(readOne.statusCode, 200); XCTAssertEqual(readTwo.statusCode, 200)
        concurrent = try await observer.fileSaveLossDiagnostics(at: api)
        XCTAssertEqual(concurrent.preflightGets, 1, "One release must free the single held read without trapping another")
        try await observer.armFileSaveLoss(at: api, nonce: UUID().uuidString, workspaceId: workspace.id, path: destination, kind: "move", sourcePath: source, phase: "preflight")
        try tapFileControl("Move file", in: app)
        var diagnostics = try await observer.fileSaveLossDiagnostics(at: api)
        for _ in 0..<20 where !diagnostics.held {
            try await Task.sleep(nanoseconds: 100_000_000)
            diagnostics = try await observer.fileSaveLossDiagnostics(at: api)
        }
        guard diagnostics.held && diagnostics.phase == "preflight" && diagnostics.preflightGets == 1 else { XCTFail("The real folder preflight must be held before typing"); return }
        draft.tap(); draft.typeText("X")
        guard (draft.value as? String) == "X" else { XCTFail("The user must change the shipped draft while MOVE waits"); return }
        try await observer.releaseFileSaveLoss(at: api)
        let status = app.staticTexts.matching(identifier: "file-status").firstMatch
        guard status.waitForLabelContaining("current verified open file", timeout: 8) else { XCTFail("Changed draft must stop MOVE before identity or POST"); return }
        diagnostics = try await observer.fileSaveLossDiagnostics(at: api)
        XCTAssertEqual(diagnostics.mutationPosts, 0)
        XCTAssertNil(diagnostics.requestId)
        XCTAssertEqual(diagnostics.receiptGets, 0)
        XCTAssertEqual(draft.value as? String, "X", "Refusing MOVE must retain the later user draft")
        XCTAssertFalse(app.buttons["Check file receipt"].exists)
        XCTAssertFalse(app.buttons["Move file"].isEnabled)
        let current = try await observer.openFile(at: api, workspaceId: workspace.id, path: source)
        XCTAssertEqual(current.content, "")
        XCTAssertEqual(current.version, created.version)
        let absent = try await observer.get(URL(string: "/api/workspaces/\(workspace.id)/files/content?path=\(destination)", relativeTo: api)!)
        XCTAssertEqual(absent.statusCode, 404)
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "MOVE stopped after draft changed during actual preflight"; shot.lifetime = .keepAlways; add(shot)
        app.terminate(); app.launch(); signIn(app)
        try selectFileWorkspace(workspace.name, in: app)
        XCTAssertFalse(app.buttons["Check file receipt"].exists, "No unsent MOVE identity may block writes after relaunch")
        diagnostics = try await observer.fileSaveLossDiagnostics(at: api)
        XCTAssertEqual(diagnostics.mutationPosts, 0, "Relaunch must not submit the stopped MOVE")
        app.buttons["Sign out"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 10))
    }

    @MainActor
    func testInstalledAppSignsOutDuringMovePreflightWithoutSendingPost() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        let (api, workspace) = try await fileWorkspace(app, observer: observer, prefix: "native-preflight-logout-")
        let source = "native-preflight.txt"
        let destination = "native-preflight-moved.txt"
        let created = try await observer.createFile(at: api, workspaceId: workspace.id, path: source, content: "")
        try openNativeFile(source, in: app)
        try app.textFields["Move destination path"].clearAndTypeText(destination, in: app)
        try await observer.armFileSaveLoss(at: api, nonce: UUID().uuidString, workspaceId: workspace.id, path: destination, kind: "move", sourcePath: source, phase: "preflight")
        let unauthenticatedConfiguration = URLSessionConfiguration.ephemeral
        unauthenticatedConfiguration.httpCookieStorage = nil
        let unauthenticated = URLSession(configuration: unauthenticatedConfiguration)
        defer { unauthenticated.invalidateAndCancel() }
        var denied = URLRequest(url: URL(string: "/api/workspaces/\(workspace.id)/files/move", relativeTo: api)!)
        denied.httpMethod = "POST"; denied.setValue("application/json", forHTTPHeaderField: "Content-Type")
        denied.httpBody = try JSONSerialization.data(withJSONObject: ["requestId": UUID().uuidString, "sourcePath": source, "destinationPath": destination, "expectedVersion": created.version])
        let (_, deniedResponse) = try await unauthenticated.data(for: denied)
        guard (deniedResponse as? HTTPURLResponse)?.statusCode == 401 else { XCTFail("Unauthenticated MOVE must be refused before the native journey"); return }
        let deniedSave = try await unauthenticated.saveFileRaw(at: api, workspaceId: workspace.id, path: source, content: "must not be written", expectedVersion: created.version, requestId: UUID().uuidString)
        guard deniedSave.statusCode == 401 else { XCTFail("Unauthenticated SAVE must be refused before the native journey"); return }
        let counted = try await observer.fileSaveLossDiagnostics(at: api)
        guard counted.mutationPosts == 2 && counted.savePosts == 1 else { XCTFail("Preflight diagnostics must count denied MOVE and SAVE attempts even without a session"); return }
        try await observer.armFileSaveLoss(at: api, nonce: UUID().uuidString, workspaceId: workspace.id, path: destination, kind: "move", sourcePath: source, phase: "preflight")
        let tappedAt = try tapFileControl("Move file", in: app)
        let completedTapAt = ProcessInfo.processInfo.systemUptime
        var diagnostics = try await observer.fileSaveLossDiagnostics(at: api)
        for _ in 0..<20 where !diagnostics.held {
            try await Task.sleep(nanoseconds: 100_000_000)
            diagnostics = try await observer.fileSaveLossDiagnostics(at: api)
        }
        guard diagnostics.held && diagnostics.phase == "preflight" && diagnostics.preflightGets == 1 else { XCTFail("The real folder preflight must be held before sign-out"); return }
        app.buttons["Sign out"].tap()
        guard app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 5) else { XCTFail("Sign-out must confirm while file preflight is held"); return }
        XCTAssertFalse(app.textViews["File draft"].exists, "Sign-out must remove the private file editor")
        try await observer.signIn(at: api, password: password)
        try await observer.releaseFileSaveLoss(at: api)
        guard ProcessInfo.processInfo.systemUptime - tappedAt < 10 else { XCTFail("Release must precede the file deadline so timeout cannot substitute for session fencing"); return }
        let remaining = max(0, completedTapAt + 11 - ProcessInfo.processInfo.systemUptime)
        try await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 2), "The late folder result must not restore the signed-out editor")
        diagnostics = try await observer.fileSaveLossDiagnostics(at: api)
        XCTAssertEqual(diagnostics.mutationPosts, 0)
        XCTAssertNil(diagnostics.requestId)
        XCTAssertEqual(diagnostics.receiptGets, 0)
        let current = try await observer.openFile(at: api, workspaceId: workspace.id, path: source)
        XCTAssertEqual(current.content, ""); XCTAssertEqual(current.version, created.version)
        let absent = try await observer.get(URL(string: "/api/workspaces/\(workspace.id)/files/content?path=\(destination)", relativeTo: api)!)
        XCTAssertEqual(absent.statusCode, 404)
        app.terminate(); app.launch(); signIn(app)
        try selectFileWorkspace(workspace.name, in: app)
        XCTAssertTrue(app.staticTexts["Directory: Workspace root"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.textViews["File draft"].exists, "Re-login must not restore the old private editor without an explicit OPEN")
        XCTAssertFalse(app.textFields["Move destination path"].exists, "Re-login must not restore the old MOVE destination")
        XCTAssertFalse(app.buttons["Check file receipt"].exists, "An unsent MOVE must not survive sign-out or relaunch as a pending write")
        diagnostics = try await observer.fileSaveLossDiagnostics(at: api)
        XCTAssertEqual(diagnostics.mutationPosts, 0, "Re-login must not replay the signed-out MOVE")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "Native files after sign-out stopped held MOVE"; shot.lifetime = .keepAlways; add(shot)
        app.buttons["Sign out"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 10))
    }

    @MainActor
    func testInstalledAppCreatesMovesAndRefusesOccupiedStaleAndDirtyFiles() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        let (api, workspace) = try await fileWorkspace(app, observer: observer, prefix: "native-create-move-")
        let source = "native-create.txt"
        let original = "native created bytes"
        try app.textFields["New file path"].clearAndTypeText(source, in: app)
        try app.textViews["New file text"].clearAndTypeText(original, in: app)
        try tapFileControl("Create file", in: app)
        let status = app.staticTexts.matching(identifier: "file-status").firstMatch
        guard status.waitForLabelContaining("CREATE receipt confirmed", timeout: 15) else { XCTFail("Native CREATE must confirm before any follow-up mutation"); return }
        let created = try await observer.openFile(at: api, workspaceId: workspace.id, path: source)
        XCTAssertEqual(created.content, original)
        let createdVersion = try await observer.sha256(original)
        XCTAssertEqual(created.version, createdVersion)
        try await observer.createFile(at: api, workspaceId: workspace.id, path: "native-occupied.txt", content: "keep occupied target")
        try openNativeFile(source, in: app)
        try app.textFields["Move destination path"].clearAndTypeText("native-occupied.txt", in: app)
        try tapFileControl("Move file", in: app)
        guard status.waitForLabelContaining("target already exists", timeout: 15) else { XCTFail("Occupied destination must refuse MOVE"); return }
        XCTAssertFalse(app.buttons["Check file receipt"].exists)
        let occupied = try await observer.openFile(at: api, workspaceId: workspace.id, path: "native-occupied.txt")
        XCTAssertEqual(occupied.content, "keep occupied target")
        try tapFileControl("Read current file", in: app)
        guard status.waitForLabelContaining("Current host text and version read", timeout: 15) else { XCTFail("MOVE baseline must be explicitly read after refusal"); return }
        let draft = app.textViews["File draft"]
        try draft.clearAndTypeText("unsaved draft", in: app)
        XCTAssertFalse(app.buttons["Move file"].isEnabled, "MOVE must never save or move an unsaved draft")
        let untouched = try await observer.openFile(at: api, workspaceId: workspace.id, path: source)
        XCTAssertEqual(untouched.content, original)
        try draft.clearAndTypeText(original, in: app)
        let changed = "changed by second client"
        let external = try await observer.saveFileRaw(at: api, workspaceId: workspace.id, path: source, content: changed, expectedVersion: created.version, requestId: UUID().uuidString)
        XCTAssertEqual(external.statusCode, 201)
        try app.textFields["Move destination path"].clearAndTypeText("native-moved.txt", in: app)
        try tapFileControl("Move file", in: app)
        guard status.waitForLabelContaining("version conflict", timeout: 15) else { XCTFail("Native MOVE must show stale-version refusal"); return }
        let afterConflict = try await observer.openFile(at: api, workspaceId: workspace.id, path: source)
        XCTAssertEqual(afterConflict.content, changed)
        try tapFileControl("Read current file", in: app)
        guard status.waitForLabelContaining("Current host text and version read", timeout: 15) else { XCTFail("Conflict recovery requires an explicit current OPEN"); return }
        try draft.clearAndTypeText(changed, in: app)
        try tapFileControl("Move file", in: app)
        guard status.waitForLabelContaining("MOVE receipt confirmed", timeout: 15) else { XCTFail("Native MOVE must confirm before readback"); return }
        let old = try await observer.get(URL(string: "/api/workspaces/\(workspace.id)/files/content?path=\(source)", relativeTo: api)!)
        XCTAssertEqual(old.statusCode, 404)
        let moved = try await observer.openFile(at: api, workspaceId: workspace.id, path: "native-moved.txt")
        XCTAssertEqual(moved.content, changed)
        XCTAssertEqual(moved.version, afterConflict.version)
        try openNativeFile("native-moved.txt", in: app)
        XCTAssertEqual(draft.value as? String, changed)
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "Native current file after confirmed MOVE"; shot.lifetime = .keepAlways; add(shot)
        app.buttons["Sign out"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 10))
    }

    @MainActor
    func testInstalledAppRecoversCommittedCreateAndMoveWithoutReplayingPost() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        let (api, workspace) = try await fileWorkspace(app, observer: observer, prefix: "native-create-move-loss-")
        let source = "native-create-loss.txt"
        let text = "native CREATE after lost response"
        try app.textFields["New file path"].clearAndTypeText(source, in: app)
        try app.textViews["New file text"].clearAndTypeText(text, in: app)
        try await observer.armFileSaveLoss(at: api, nonce: UUID().uuidString, workspaceId: workspace.id, path: source, kind: "create")
        try tapFileControl("Create file", in: app)
        let status = app.staticTexts.matching(identifier: "file-status").firstMatch
        guard status.waitForLabelContaining("unknown", timeout: 15) else { XCTFail("Committed CREATE response loss must remain unknown"); return }
        var diagnostics = try await observer.fileSaveLossDiagnostics(at: api)
        XCTAssertTrue(diagnostics.held); XCTAssertEqual(diagnostics.kind, "create"); XCTAssertEqual(diagnostics.mutationPosts, 1)
        let createId = try XCTUnwrap(diagnostics.requestId)
        try await observer.releaseFileSaveLoss(at: api)
        app.terminate(); app.launch(); signIn(app)
        try selectFileWorkspace(workspace.name, in: app)
        try tapFileControl("Check file receipt", in: app)
        guard status.waitForLabelContaining("Historical file receipt confirmed", timeout: 15) else { XCTFail("Original CREATE identity must recover by GET"); return }
        diagnostics = try await observer.fileSaveLossDiagnostics(at: api)
        XCTAssertEqual(diagnostics.requestId, createId); XCTAssertEqual(diagnostics.mutationPosts, 1); XCTAssertGreaterThanOrEqual(diagnostics.receiptGets, 1)
        try openNativeFile(source, in: app)
        let draft = app.textViews["File draft"]
        XCTAssertEqual(draft.value as? String, text)
        try app.textFields["Move destination path"].clearAndTypeText("native-move-loss.txt", in: app)
        try await observer.armFileSaveLoss(at: api, nonce: UUID().uuidString, workspaceId: workspace.id, path: "native-move-loss.txt", kind: "move", sourcePath: source)
        try tapFileControl("Move file", in: app)
        guard status.waitForLabelContaining("unknown", timeout: 15) else { XCTFail("Committed MOVE response loss must remain unknown"); return }
        diagnostics = try await observer.fileSaveLossDiagnostics(at: api)
        XCTAssertTrue(diagnostics.held); XCTAssertEqual(diagnostics.kind, "move"); XCTAssertEqual(diagnostics.mutationPosts, 1)
        let moveId = try XCTUnwrap(diagnostics.requestId)
        try await observer.releaseFileSaveLoss(at: api)
        app.terminate(); app.launch(); signIn(app)
        try selectFileWorkspace(workspace.name, in: app)
        try tapFileControl("Check file receipt", in: app)
        guard status.waitForLabelContaining("Historical file receipt confirmed", timeout: 15) else { XCTFail("Original MOVE identity must recover by GET"); return }
        diagnostics = try await observer.fileSaveLossDiagnostics(at: api)
        XCTAssertEqual(diagnostics.requestId, moveId); XCTAssertEqual(diagnostics.mutationPosts, 1); XCTAssertGreaterThanOrEqual(diagnostics.receiptGets, 1)
        let moved = try await observer.openFile(at: api, workspaceId: workspace.id, path: "native-move-loss.txt")
        XCTAssertEqual(moved.content, text)
        let old = try await observer.get(URL(string: "/api/workspaces/\(workspace.id)/files/content?path=\(source)", relativeTo: api)!)
        XCTAssertEqual(old.statusCode, 404)
        try openNativeFile("native-move-loss.txt", in: app)
        XCTAssertEqual(app.textViews["File draft"].value as? String, text)
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "Native current file after receipt-only MOVE recovery"; shot.lifetime = .keepAlways; add(shot)
        app.buttons["Sign out"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 10))
    }

    @MainActor
    func testInstalledAppJoinsWebCreatedWorkspaceAndSavesSharedLinuxFile() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        defer { app.terminate(); observer.invalidateAndCancel() }
        let (api, workspace) = try await joinedFileWorkspace(app, observer: observer)
        let path = "cross-client.txt"
        let original = "web created on shared Linux host"
        let saved = "native save on shared Linux host"
        try openNativeFile(path, in: app)
        let status = app.staticTexts.matching(identifier: "file-status").firstMatch
        guard status.waitForLabelContaining("Text and version read from the host", timeout: 15) else { XCTFail("Native must OPEN the web-created file before editing"); return }
        let draft = app.textViews["File draft"]
        let opened = try await observer.openFile(at: api, workspaceId: workspace.id, path: path)
        let originalVersion = try await observer.sha256(original)
        guard opened.path == path && opened.content == original && opened.version == originalVersion && (draft.value as? String) == opened.content else { XCTFail("Native OPEN and real API bytes/version must match the web-created input"); return }
        guard app.staticTexts["\(path) · last read version available"].exists && !app.buttons["Check file receipt"].exists && !app.otherElements["pending-file"].exists && !app.staticTexts.matching(identifier: "pending-folder").firstMatch.exists else { XCTFail("SAVE requires a current OPEN without pending file or folder identity"); return }
        try draft.clearAndTypeText(saved, in: app)
        guard (draft.value as? String) == saved else { XCTFail("The actual File draft must contain the exact native SAVE proposal"); return }
        try tapFileControl("Save file", in: app)
        guard status.waitForLabelContaining("SAVE receipt confirmed", timeout: 15) else { XCTFail("Native SAVE must confirm before any follow-up; an unknown result must not be retried"); return }
        guard !app.buttons["Check file receipt"].exists && !app.otherElements["pending-file"].exists else { XCTFail("Confirmed SAVE must clear its pending identity"); return }
        try openNativeFile(path, in: app)
        guard status.waitForLabelContaining("Current host text and version read", timeout: 15) else { XCTFail("Historical SAVE receipt must be followed by current OPEN"); return }
        let actual = try await observer.openFile(at: api, workspaceId: workspace.id, path: path)
        let savedVersion = try await observer.sha256(saved)
        guard actual.path == path && actual.content == saved && actual.version == savedVersion && actual.version != opened.version && (draft.value as? String) == actual.content else { XCTFail("Current native OPEN and real API must show exact saved bytes/version"); return }
        XCTAssertTrue(app.staticTexts["\(path) · last read version available"].exists)
        XCTAssertFalse(app.staticTexts.matching(identifier: "pending-folder").firstMatch.exists)
        let rows = try await observer.workspaceList(at: api)
        let joined = rows.filter { $0.name.hasPrefix("rc021-joined-") }
        XCTAssertEqual(joined.count, 1)
        XCTAssertEqual(joined.first?.id, workspace.id)
        XCTAssertEqual(joined.first?.name, workspace.name)
    }

    @MainActor
    func testInstalledAppReadsJoinedWorkspaceAfterAPIContainerRecreationWithoutReplay() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        defer { app.terminate(); observer.invalidateAndCancel() }
        let (api, workspace) = try await joinedFileWorkspace(app, observer: observer)
        let path = "cross-client.txt"
        let saved = "native save on shared Linux host"
        try openNativeFile(path, in: app)
        let status = app.staticTexts.matching(identifier: "file-status").firstMatch
        guard status.waitForLabelContaining("Text and version read from the host", timeout: 15) else { XCTFail("Relaunched native app must explicitly OPEN current host text/version"); return }
        let actual = try await observer.openFile(at: api, workspaceId: workspace.id, path: path)
        let savedVersion = try await observer.sha256(saved)
        let draft = app.textViews["File draft"]
        guard actual.path == path && actual.content == saved && actual.version == savedVersion && (draft.value as? String) == actual.content else { XCTFail("Native UI and real API must retain exact native-saved bytes/version after API recreation"); return }
        XCTAssertTrue(app.staticTexts["\(path) · last read version available"].exists)
        XCTAssertFalse(app.buttons["Check file receipt"].exists, "Relaunch must not restore a completed SAVE as pending")
        XCTAssertFalse(app.otherElements["pending-file"].exists)
        XCTAssertFalse(app.staticTexts.matching(identifier: "pending-folder").firstMatch.exists)
        XCTAssertFalse(app.buttons["Prepare workspace folder"].exists, "Existing folder must not offer another preparation")
        XCTAssertFalse(app.buttons["Save file"].isEnabled, "Unchanged current OPEN must not propose another SAVE")
        let rows = try await observer.workspaceList(at: api)
        let joined = rows.filter { $0.name.hasPrefix("rc021-joined-") }
        XCTAssertEqual(joined.count, 1)
        XCTAssertEqual(joined.first?.id, workspace.id)
        XCTAssertEqual(joined.first?.name, workspace.name)
        for _ in 0..<8 where !draft.isHittable {
            let scroll = app.scrollViews.firstMatch
            if draft.frame.midY < scroll.frame.minY { scroll.swipeDown() } else { scroll.swipeUp() }
        }
        guard draft.isHittable else { XCTFail("Current shared file must be visible in the actual native screenshot"); return }
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "Joined native current file after API container recreation"; shot.lifetime = .keepAlways; add(shot)
    }

    @MainActor
    private func joinedFileWorkspace(_ app: XCUIApplication, observer: URLSession) async throws -> (URL, WorkspaceMetadata) {
        app.launch()
        let host = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Host: ")).firstMatch
        guard host.waitForExistence(timeout: 15) else { throw NSError(domain: "NativeFileProof", code: 10) }
        let api = try XCTUnwrap(URL(string: String(host.label.dropFirst("Host: ".count))))
        guard api.scheme == "https" && api.host == "127.0.0.1" else { XCTFail("Joined native observer must use the app's genuine HTTPS loopback origin"); throw NSError(domain: "NativeFileProof", code: 11) }
        if app.buttons["Sign in to host"].exists || !app.buttons["Sign out"].exists { signIn(app) }
        guard app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("connected", timeout: 15) else { throw NSError(domain: "NativeFileProof", code: 12) }
        try await observer.signIn(at: api, password: password)
        let rows = try await observer.workspaceList(at: api)
        let joined = rows.filter { $0.name.hasPrefix("rc021-joined-") }
        guard joined.count == 1 else { XCTFail("Joined proof requires exactly one existing web-created rc021-joined- workspace; found \(joined.count)"); throw NSError(domain: "NativeFileProof", code: 13) }
        let workspace = try XCTUnwrap(joined.first)
        let current = try await observer.workspace(at: api, id: workspace.id)
        guard current.id == workspace.id && current.name == workspace.name && current.archived == false else { XCTFail("Joined workspace must retain its real ID/name and remain active"); throw NSError(domain: "NativeFileProof", code: 14) }
        try tapFileControl("Refresh workspaces", in: app)
        try selectFileWorkspace(workspace.name, in: app)
        guard app.staticTexts["Selected: \(workspace.name)"].waitForExistence(timeout: 10) && app.staticTexts.matching(identifier: "folder-status").firstMatch.waitForLabel("Folder provisioned on Linux.", timeout: 15) else { throw NSError(domain: "NativeFileProof", code: 15) }
        return (api, workspace)
    }

    @MainActor
    private func fileWorkspace(_ app: XCUIApplication, observer: URLSession, prefix: String, prepareInApp: Bool = false) async throws -> (URL, WorkspaceMetadata) {
        app.launch()
        let host = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Host: ")).firstMatch
        XCTAssertTrue(host.waitForExistence(timeout: 15))
        let api = try XCTUnwrap(URL(string: String(host.label.dropFirst("Host: ".count))))
        XCTAssertEqual(api.scheme, "https"); XCTAssertEqual(api.host, "127.0.0.1")
        signIn(app); try await observer.signIn(at: api, password: password)
        let name = prefix + UUID().uuidString
        let input = app.textFields["Workspace name"]
        input.tap(); for character in name { input.typeText(String(character)) }
        app.staticTexts["Host connection"].firstMatch.tap()
        app.buttons["Create workspace"].tap()
        guard app.staticTexts["Workspace change confirmed."].waitForExistence(timeout: 15) else { throw NSError(domain: "NativeFileProof", code: 3) }
        try selectFileWorkspace(name, in: app)
        let rows = try await observer.workspaceList(at: api)
        let workspace = try XCTUnwrap(rows.first { $0.name == name })
        if prepareInApp {
            let status = app.staticTexts.matching(identifier: "file-status").firstMatch
            guard status.waitForLabelContaining("Folder not provisioned", timeout: 10) else { throw NSError(domain: "NativeFileProof", code: 8) }
            XCTAssertFalse(app.buttons["Create file"].isEnabled)
            try tapFileControl("Prepare workspace folder", in: app)
            guard status.waitForLabelContaining("Workspace folder confirmed", timeout: 12) else { throw NSError(domain: "NativeFileProof", code: 9) }
            XCTAssertTrue(app.staticTexts["Directory: Workspace root"].waitForExistence(timeout: 10))
        } else {
            try await observer.provisionFolder(at: api, workspaceId: workspace.id)
            try tapFileControl("Refresh folder and files", in: app)
        }
        return (api, workspace)
    }

    @MainActor
    private func selectFileWorkspace(_ name: String, in app: XCUIApplication) throws {
        let open = app.buttons["Open workspace \(name)"]
        guard open.waitForExistence(timeout: 10) else { throw NSError(domain: "NativeFileProof", code: 4) }
        open.tap()
        XCTAssertTrue(app.staticTexts["Selected: \(name)"].waitForExistence(timeout: 10))
    }

    @MainActor
    @discardableResult
    private func tapFileControl(_ label: String, in app: XCUIApplication) throws -> TimeInterval {
        if app.keyboards.firstMatch.exists { app.staticTexts["Files and editor"].firstMatch.tap() }
        guard app.keyboards.firstMatch.waitForNonExistence(timeout: 5) else { throw NSError(domain: "NativeFileProof", code: 5) }
        let control = app.buttons[label]
        guard control.waitForExistence(timeout: 10) else { throw NSError(domain: "NativeFileProof", code: 6) }
        for _ in 0..<8 where !control.isHittable {
            let scroll = app.scrollViews.firstMatch
            if control.frame.midY < scroll.frame.minY { scroll.swipeDown() } else { scroll.swipeUp() }
        }
        guard control.isEnabled && control.isHittable else { throw NSError(domain: "NativeFileProof", code: 7, userInfo: [NSLocalizedDescriptionKey: "Control not interactable: \(label)"]) }
        let tappedAt = ProcessInfo.processInfo.systemUptime
        control.tap()
        return tappedAt
    }

    @MainActor
    private func openNativeFile(_ path: String, in app: XCUIApplication) throws {
        try tapFileControl("Refresh folder and files", in: app)
        try tapFileControl("Open file \(path)", in: app)
        XCTAssertTrue(app.textViews["File draft"].waitForExistence(timeout: 10))
    }

    @MainActor
    func testInstalledAppListsOpensSavesLinuxWorkspaceFileAndRejectsStaleClient() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        app.launch()
        let hostLabel = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Host: ")).firstMatch
        XCTAssertTrue(hostLabel.waitForExistence(timeout: 15))
        let api = try XCTUnwrap(URL(string: String(hostLabel.label.dropFirst("Host: ".count))))
        XCTAssertEqual(api.scheme, "https")
        XCTAssertEqual(api.host, "127.0.0.1")
        signIn(app)
        try await observer.signIn(at: api, password: password)
        for _ in 0..<5 where !app.staticTexts["Workspaces"].exists { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(app.staticTexts["Workspaces"].waitForExistence(timeout: 10))
        let workspaceName = "native-file-workspace-\(UUID().uuidString)"
        let nameInput = app.textFields["Workspace name"]
        nameInput.tap(); nameInput.typeText(workspaceName)
        app.staticTexts["Host connection"].firstMatch.tap()
        app.buttons["Create workspace"].tap()
        XCTAssertTrue(app.staticTexts["Workspace change confirmed."].waitForExistence(timeout: 15))
        app.buttons["Open workspace \(workspaceName)"].tap()
        XCTAssertTrue(app.staticTexts["Selected: \(workspaceName)"].waitForExistence(timeout: 10))
        let workspaceRows = try await observer.workspaceList(at: api)
        let workspace = try XCTUnwrap(workspaceRows.first { $0.name == workspaceName })
        try await observer.provisionFolder(at: api, workspaceId: workspace.id)
        let filePath = "native-proof.txt"
        let original = "first native Linux bytes"
        let create = try await observer.createFile(at: api, workspaceId: workspace.id, path: filePath, content: original)
        XCTAssertEqual(create.path, filePath)
        let originalVersion = try await observer.sha256(original)
        XCTAssertEqual(create.version, originalVersion)
        for _ in 0..<5 where !app.staticTexts["Files and editor"].exists { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(app.staticTexts["Files and editor"].waitForExistence(timeout: 15))
        app.buttons["Refresh folder and files"].tap()
        XCTAssertTrue(app.buttons["Open file \(filePath)"].waitForExistence(timeout: 15))
        app.buttons["Open file \(filePath)"].tap()
        let content = app.textViews["File draft"]
        XCTAssertTrue(content.waitForExistence(timeout: 10))
        XCTAssertEqual(content.value as? String, original)
        let opened = try await observer.openFile(at: api, workspaceId: workspace.id, path: filePath)
        let save = "saved by the installed native client"
        let savedVersion = try await observer.sha256(save)
        try content.clearAndTypeText(save, in: app)
        XCTAssertEqual(content.value as? String, save, "The explicit SAVE proposal must contain only the new draft")
        app.staticTexts["Files and editor"].firstMatch.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        for _ in 0..<5 where !app.buttons["Save file"].isHittable { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(app.buttons["Save file"].isEnabled && app.buttons["Save file"].isHittable)
        app.buttons["Save file"].tap()
        guard app.staticTexts.matching(identifier: "file-status").firstMatch.waitForLabelContaining("SAVE receipt confirmed", timeout: 15) else {
            XCTFail("The native SAVE receipt must be visible before attempting the stale observer write")
            return
        }
        let staleID = UUID().uuidString
        let stale = try await observer.saveFileRaw(at: api, workspaceId: workspace.id, path: filePath, content: "stale overwrite", expectedVersion: opened.version, requestId: staleID)
        XCTAssertEqual(stale.statusCode, 409)
        XCTAssertEqual(stale.error, "version_conflict")
        let final = try await observer.openFile(at: api, workspaceId: workspace.id, path: filePath)
        XCTAssertEqual(final.content, save)
        XCTAssertEqual(final.version, savedVersion)
        app.buttons["Sign out"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 10))
    }

    @MainActor
    func testInstalledAppRetainsUnknownCommittedSaveAndRecoversByReceiptWithoutReplay() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        app.launch()
        let hostLabel = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Host: ")).firstMatch
        XCTAssertTrue(hostLabel.waitForExistence(timeout: 15))
        let api = try XCTUnwrap(URL(string: String(hostLabel.label.dropFirst("Host: ".count))))
        XCTAssertEqual(api.scheme, "https")
        XCTAssertEqual(api.host, "127.0.0.1")
        signIn(app)
        try await observer.signIn(at: api, password: password)
        for _ in 0..<5 where !app.staticTexts["Workspaces"].exists { app.scrollViews.firstMatch.swipeUp() }
        let workspaceName = "native-file-loss-workspace-\(UUID().uuidString)"
        let nameInput = app.textFields["Workspace name"]
        nameInput.tap(); nameInput.typeText(workspaceName); app.staticTexts["Host connection"].firstMatch.tap(); app.buttons["Create workspace"].tap()
        XCTAssertTrue(app.staticTexts["Workspace change confirmed."].waitForExistence(timeout: 15))
        app.buttons["Open workspace \(workspaceName)"].tap()
        XCTAssertTrue(app.staticTexts["Selected: \(workspaceName)"].waitForExistence(timeout: 10))
        let workspaceRows = try await observer.workspaceList(at: api)
        let workspace = try XCTUnwrap(workspaceRows.first { $0.name == workspaceName })
        try await observer.provisionFolder(at: api, workspaceId: workspace.id)
        let path = "native-loss.txt"; let original = "before committed loss"; let saved = "committed save after response loss"
        _ = try await observer.createFile(at: api, workspaceId: workspace.id, path: path, content: original)
        for _ in 0..<5 where !app.staticTexts["Files and editor"].exists { app.scrollViews.firstMatch.swipeUp() }
        app.buttons["Refresh folder and files"].tap(); XCTAssertTrue(app.buttons["Open file \(path)"].waitForExistence(timeout: 15)); app.buttons["Open file \(path)"].tap()
        let content = app.textViews["File draft"]; XCTAssertTrue(content.waitForExistence(timeout: 10)); try content.clearAndTypeText(saved, in: app)
        XCTAssertEqual(content.value as? String, saved, "The response-loss SAVE must send exactly the edited draft")
        app.staticTexts["Files and editor"].firstMatch.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        for _ in 0..<5 where !app.buttons["Save file"].isHittable { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(app.buttons["Save file"].isEnabled && app.buttons["Save file"].isHittable)
        try await observer.armFileSaveLoss(at: api, nonce: UUID().uuidString, workspaceId: workspace.id, path: path)
        app.buttons["Save file"].tap()
        let status = app.staticTexts.matching(identifier: "file-status").firstMatch
        XCTAssertTrue(status.waitForLabelContaining("unknown", timeout: 15), "Committed save response loss must leave visible unknown state")
        var diagnostics = try await observer.fileSaveLossDiagnostics(at: api)
        XCTAssertTrue(diagnostics.held)
        let requestId = try XCTUnwrap(diagnostics.requestId)
        XCTAssertEqual(diagnostics.savePosts, 1)
        try await observer.releaseFileSaveLoss(at: api)
        app.terminate(); app.launch(); signIn(app)
        for _ in 0..<5 where !app.staticTexts[workspaceName].exists { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(app.buttons["Open workspace \(workspaceName)"].waitForExistence(timeout: 10)); app.buttons["Open workspace \(workspaceName)"].tap()
        XCTAssertTrue(app.buttons["Check file receipt"].waitForExistence(timeout: 10)); app.buttons["Check file receipt"].tap()
        XCTAssertTrue(status.waitForLabelContaining("Historical file receipt confirmed", timeout: 15))
        diagnostics = try await observer.fileSaveLossDiagnostics(at: api)
        XCTAssertEqual(diagnostics.requestId, requestId)
        XCTAssertEqual(diagnostics.savePosts, 1, "Receipt recovery must not replay PUT")
        XCTAssertGreaterThanOrEqual(diagnostics.receiptGets, 1)
        let final = try await observer.openFile(at: api, workspaceId: workspace.id, path: path)
        XCTAssertEqual(final.content, saved)
        let savedVersion = try await observer.sha256(saved)
        XCTAssertEqual(final.version, savedVersion)
        app.buttons["Sign out"].tap(); XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 10))
    }

    @MainActor
    func testInstalledAppCreatesAndMutatesTwoWorkspaceMetadataRecords() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        app.launch()
        let apiLabel = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Host: ")).firstMatch
        XCTAssertTrue(apiLabel.waitForExistence(timeout: 10))
        let api = try XCTUnwrap(URL(string: String(apiLabel.label.dropFirst("Host: ".count))))
        XCTAssertEqual(api.host, "127.0.0.1")
        XCTAssertEqual(api.port, 39211, "Native workspace observer must use the runner's regular API port")
        signIn(app)
        try await observer.signIn(at: api, password: password)

        let nameA = "2026-10-01T12:34:56.789Z"
        let nameB = "2026-10-02T12:34:56.789Z"
        for _ in 0..<5 where !app.staticTexts["Workspaces"].exists {
            app.scrollViews.firstMatch.swipeUp()
        }
        XCTAssertTrue(app.staticTexts["Workspaces"].waitForExistence(timeout: 10))
        let nameInput = app.textFields["Workspace name"]
        nameInput.tap()
        for character in nameA { nameInput.typeText(String(character)) }
        XCTAssertEqual(nameInput.value as? String, nameA, "The first workspace input must preserve exact ISO-looking text")
        app.staticTexts["Host connection"].firstMatch.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        app.buttons["Create workspace"].tap()
        XCTAssertTrue(app.staticTexts["Workspace change confirmed."].waitForExistence(timeout: 15))
        app.buttons["Refresh workspaces"].tap()
        XCTAssertTrue(app.staticTexts[nameA].waitForExistence(timeout: 10))

        nameInput.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        if let currentName = nameInput.value as? String, !currentName.isEmpty {
            nameInput.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)).tap()
            for _ in 0..<(currentName.count + 2) { nameInput.typeText(XCUIKeyboardKey.delete.rawValue) }
        }
        XCTAssertEqual(nameInput.value as? String, "Workspace name", "The workspace name field must be empty before entering the second exact value")
        for character in nameB { nameInput.typeText(String(character)) }
        XCTAssertEqual(nameInput.value as? String, nameB, "The second workspace input must preserve exact ISO-looking text")
        app.staticTexts["Host connection"].firstMatch.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        app.buttons["Create workspace"].tap()
        XCTAssertTrue(app.staticTexts["Workspace change confirmed."].waitForExistence(timeout: 15))
        app.buttons["Refresh workspaces"].tap()
        XCTAssertTrue(app.staticTexts[nameB].waitForExistence(timeout: 10))
        let initialRows = try await observer.workspaceList(at: api)
        let workspaceA = try XCTUnwrap(initialRows.first { $0.name == nameA })
        let workspaceB = try XCTUnwrap(initialRows.first { $0.name == nameB })
        XCTAssertNotEqual(workspaceA.id, workspaceB.id)
        XCTAssertTrue(app.buttons["Open workspace \(nameA)"].exists)
        XCTAssertTrue(app.buttons["Open workspace \(nameB)"].exists)
        var observedA = try await observer.workspace(at: api, id: workspaceA.id)
        var observedB = try await observer.workspace(at: api, id: workspaceB.id)
        XCTAssertEqual(observedA.name, nameA)
        XCTAssertEqual(observedB.name, nameB)

        app.buttons["Open workspace \(nameA)"].tap()
        XCTAssertTrue(app.staticTexts["Selected: \(nameA)"].waitForExistence(timeout: 10))
        let renameInput = app.textFields["New workspace name"]
        let renamedA = "2026-10-03T12:34:56.789Z"
        renameInput.tap()
        for character in renamedA { renameInput.typeText(String(character)) }
        XCTAssertEqual(renameInput.value as? String, renamedA, "The renamed workspace input must preserve exact ISO-looking text")
        app.staticTexts["Host connection"].firstMatch.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        app.buttons["Rename workspace"].tap()
        XCTAssertTrue(app.staticTexts["Workspace change confirmed."].waitForExistence(timeout: 15))
        observedA = try await observer.workspace(at: api, id: workspaceA.id)
        observedB = try await observer.workspace(at: api, id: workspaceB.id)
        XCTAssertEqual(observedA.name, renamedA)
        XCTAssertEqual(observedB.name, nameB)

        app.buttons["Open workspace \(nameB)"].tap()
        XCTAssertTrue(app.staticTexts["Selected: \(nameB)"].waitForExistence(timeout: 10))
        app.buttons["Archive workspace"].tap()
        XCTAssertTrue(app.staticTexts["Workspace change confirmed."].waitForExistence(timeout: 15))
        app.buttons["Open workspace \(nameB)"].tap()
        XCTAssertTrue(app.staticTexts["Selected: \(nameB)"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Archived workspaces are read-only."].exists)
        XCTAssertFalse(app.buttons["Rename workspace"].exists)
        XCTAssertFalse(app.buttons["Archive workspace"].exists)
        observedB = try await observer.workspace(at: api, id: workspaceB.id)
        observedA = try await observer.workspace(at: api, id: workspaceA.id)
        XCTAssertEqual(observedB.archived, true)
        XCTAssertEqual(observedB.name, nameB)
        XCTAssertEqual(observedA.id, workspaceA.id)
        XCTAssertEqual(observedA.name, renamedA)

        let action = nameA
        for _ in 0..<5 where !app.textFields["Action"].isHittable {
            app.scrollViews.firstMatch.swipeDown()
        }
        let actionInput = app.textFields["Action"]
        XCTAssertTrue(actionInput.isHittable)
        actionInput.tap()
        for character in action { actionInput.typeText(String(character)) }
        app.keyboards.buttons["Return"].tap()
        app.staticTexts["Host connection"].firstMatch.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        XCTAssertEqual(actionInput.value as? String, action, "The action input must preserve canonical ISO-looking text")
        let submit = app.buttons["Submit action"]
        XCTAssertTrue(submit.isEnabled && submit.isHittable)
        submit.tap()
        XCTAssertTrue(app.staticTexts[action].waitForExistence(timeout: 15))
        let actionHistory = try await observer.actions(at: api)
        let actionReceipt = try XCTUnwrap(actionHistory.first { $0.action == action })
        XCTAssertTrue(app.staticTexts["Receipt \(actionReceipt.id)"].waitForExistence(timeout: 10))
        XCTAssertEqual(actionHistory.filter { $0.action == action }.count, 1)

        app.terminate()
        app.launch()
        signIn(app)
        for _ in 0..<5 where !app.staticTexts[renamedA].exists {
            app.scrollViews.firstMatch.swipeUp()
        }
        XCTAssertTrue(app.staticTexts[renamedA].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["\(nameB) (archived, read-only)"].waitForExistence(timeout: 10))
        observedA = try await observer.workspace(at: api, id: workspaceA.id)
        observedB = try await observer.workspace(at: api, id: workspaceB.id)
        XCTAssertEqual(observedA.name, renamedA)
        XCTAssertEqual(observedB.archived, true)

        app.buttons["Sign out"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 10))
        XCTAssertFalse(app.staticTexts["Workspaces"].exists, "Logout must hide the private workspace panel")
        let revokedSession = try await observer.get(URL(string: "/api/auth/session", relativeTo: api)!)
        let privateWorkspaceRead = try await observer.get(URL(string: "/api/workspaces", relativeTo: api)!)
        XCTAssertEqual(revokedSession.statusCode, 401)
        XCTAssertEqual(privateWorkspaceRead.statusCode, 401)
    }

    private func requestManifestPermissions(_ operation: String, using session: URLSession) async throws -> (Int, [String: Any]) {
        var request = URLRequest(url: URL(string: "/__test__/storage-manifest-permissions", relativeTo: api)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["operation": operation])
        let (data, response) = try await session.data(for: request)
        let status = try XCTUnwrap((response as? HTTPURLResponse)?.statusCode)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return (status, body)
    }

    private func setManifestPermissions(_ operation: String, using session: URLSession) async throws -> [String: Any] {
        let (status, body) = try await requestManifestPermissions(operation, using: session)
        XCTAssertEqual(status, 200, String(describing: body))
        return body
    }

    private func probeSpecialManifestMode(using session: URLSession) async throws -> (Bool, [String: Any]) {
        let (status, body) = try await requestManifestPermissions("set-special-bit", using: session)
        if status == 200 {
            XCTAssertEqual(body["changed"] as? Bool, true)
            return (true, body)
        }
        XCTAssertEqual(status, 409, String(describing: body))
        XCTAssertEqual(body["error"] as? String, "special_bit_unavailable")
        XCTAssertEqual(body["mode"] as? Int, body["originalMode"] as? Int)
        XCTAssertEqual(body["uid"] as? Int, body["originalUid"] as? Int)
        XCTAssertEqual(body["gid"] as? Int, body["originalGid"] as? Int)
        return (false, body)
    }

    @MainActor
    func testPendingActionAPrePostWriteFailureSendsNoActionAndBlocksSubmission() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        app.launch()
        signIn(app)
        try await observer.signIn(at: api, password: password)
        let (specialBitEnabled, specialMode) = try await probeSpecialManifestMode(using: observer)
        let originalMode = try XCTUnwrap(specialMode["originalMode"] as? Int)
        let specialDirectoryMode = try XCTUnwrap(specialMode["mode"] as? Int)
        XCTAssertEqual(originalMode & 0o7777, originalMode)
        XCTAssertEqual(specialDirectoryMode, specialBitEnabled ? originalMode | 0o2000 : originalMode)
        XCTAssertEqual(specialMode["uid"] as? Int, specialMode["originalUid"] as? Int)
        XCTAssertEqual(specialMode["gid"] as? Int, specialMode["originalGid"] as? Int)
        var arm = URLRequest(url: URL(string: "/__test__/lose-action-response", relativeTo: api)!)
        arm.httpMethod = "POST"
        arm.setValue("application/json", forHTTPHeaderField: "Content-Type")
        arm.httpBody = try JSONSerialization.data(withJSONObject: ["receiptFault": "none"])
        let (_, armedResponse) = try await observer.data(for: arm)
        XCTAssertEqual((armedResponse as? HTTPURLResponse)?.statusCode, 200)

        let action = "native-storage-before-post-\(UUID().uuidString)"
        let input = app.textFields["Action"]
        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        for character in action { input.typeText(String(character)) }
        app.keyboards.buttons["Return"].tap()
        app.staticTexts["Host connection"].firstMatch.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        XCTAssertEqual(input.value as? String, action, "The actual input must match the recorded action before testing storage failure")
        let permission = try await setManifestPermissions("deny-write", using: observer)
        XCTAssertEqual(permission["denied"] as? Bool, true)
        let deniedMode = try XCTUnwrap(permission["mode"] as? Int)
        let permissionOriginalMode = try XCTUnwrap(permission["originalMode"] as? Int)
        XCTAssertEqual(deniedMode, permissionOriginalMode & ~0o222)
        XCTAssertEqual(deniedMode & 0o2000, specialBitEnabled ? 0o2000 : originalMode & 0o2000, "The native write failure must preserve every special permission bit")
        XCTAssertEqual(permission["uid"] as? Int, permission["originalUid"] as? Int)
        XCTAssertEqual(permission["gid"] as? Int, permission["originalGid"] as? Int)
        let unauthenticated = URLSession(configuration: .ephemeral)
        for operation in ["deny-write", "restore"] {
            let (status, _) = try await requestManifestPermissions(operation, using: unauthenticated)
            XCTAssertEqual(status, 401, "Permission controls must reject unauthenticated \(operation) requests")
            let stillDenied = try await setManifestPermissions("inspect", using: observer)
            XCTAssertEqual(stillDenied["mode"] as? Int, deniedMode, "Unauthorized controls must not change the actual manifest directory mode")
            XCTAssertEqual(stillDenied["uid"] as? Int, permission["uid"] as? Int)
            XCTAssertEqual(stillDenied["gid"] as? Int, permission["gid"] as? Int)
        }
        let submit = app.buttons["Submit action"]
        XCTAssertTrue(submit.isEnabled && submit.isHittable)
        submit.tap()

        let recovery = app.staticTexts.matching(identifier: "action-recovery-status").firstMatch
        XCTAssertTrue(recovery.waitForLabelContaining("No action was sent", timeout: 10), "A real AsyncStorage manifest write error must stop before POST")
        XCTAssertFalse(submit.isEnabled, "Unavailable device storage must block resubmission until recovery")
        let diagnostics = try await observer.responseLossDiagnostics(at: api)
        XCTAssertEqual(diagnostics.actionPosts, 0)
        XCTAssertEqual(diagnostics.lostResponse, false)
        let actionsBeforeStorageRecovery = try await observer.actions(at: api)
        XCTAssertFalse(actionsBeforeStorageRecovery.contains { $0.action == action })
        let restored = try await setManifestPermissions("restore", using: observer)
        XCTAssertEqual(restored["restored"] as? Bool, true)
        XCTAssertEqual(restored["mode"] as? Int, permission["originalMode"] as? Int)
        XCTAssertEqual(restored["uid"] as? Int, permission["originalUid"] as? Int)
        XCTAssertEqual(restored["gid"] as? Int, permission["originalGid"] as? Int)
        if specialBitEnabled {
            let specialBitRestored = try await setManifestPermissions("restore-special-bit", using: observer)
            XCTAssertEqual(specialBitRestored["mode"] as? Int, originalMode)
            XCTAssertEqual(specialBitRestored["uid"] as? Int, specialMode["originalUid"] as? Int)
            XCTAssertEqual(specialBitRestored["gid"] as? Int, specialMode["originalGid"] as? Int)
        }
        app.terminate()
        var logout = URLRequest(url: URL(string: "/api/auth/logout", relativeTo: api)!)
        logout.httpMethod = "POST"
        logout.setValue("application/json", forHTTPHeaderField: "Content-Type")
        logout.httpBody = Data("{}".utf8)
        let (_, logoutResponse) = try await observer.data(for: logout)
        XCTAssertEqual((logoutResponse as? HTTPURLResponse)?.statusCode, 204)
        let revoked = try await observer.get(URL(string: "/api/auth/session", relativeTo: api)!)
        XCTAssertEqual(revoked.statusCode, 401)
    }

    @MainActor
    func testPendingActionZReceiptClearFailureRecoversOriginalReceiptAfterRelaunchWithoutReplay() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        app.launch()
        signIn(app)
        try await observer.signIn(at: api, password: password)
        let (specialBitEnabled, specialMode) = try await probeSpecialManifestMode(using: observer)
        let originalMode = try XCTUnwrap(specialMode["originalMode"] as? Int)
        let specialDirectoryMode = try XCTUnwrap(specialMode["mode"] as? Int)
        XCTAssertEqual(specialDirectoryMode, specialBitEnabled ? originalMode | 0o2000 : originalMode)
        XCTAssertEqual(specialMode["uid"] as? Int, specialMode["originalUid"] as? Int)
        XCTAssertEqual(specialMode["gid"] as? Int, specialMode["originalGid"] as? Int)
        var arm = URLRequest(url: URL(string: "/__test__/lose-action-response", relativeTo: api)!)
        arm.httpMethod = "POST"
        arm.setValue("application/json", forHTTPHeaderField: "Content-Type")
        arm.httpBody = try JSONSerialization.data(withJSONObject: ["receiptFault": "stall"])
        let (_, armedResponse) = try await observer.data(for: arm)
        XCTAssertEqual((armedResponse as? HTTPURLResponse)?.statusCode, 200)

        let action = "native-storage-after-receipt-\(UUID().uuidString)"
        let input = app.textFields["Action"]
        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        for character in action { input.typeText(String(character)) }
        app.keyboards.buttons["Return"].tap()
        app.staticTexts["Host connection"].firstMatch.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        XCTAssertEqual(input.value as? String, action, "The actual input must match the recorded action before testing receipt cleanup")
        app.buttons["Submit action"].tap()
        let pending = app.staticTexts.matching(identifier: "action-recovery-status").firstMatch
        guard pending.waitForLabelContaining("unknown", timeout: 12) else {
            let failedDiagnostics = try await observer.responseLossDiagnostics(at: api)
            let failedHistory = try await observer.actions(at: api)
            let connection = app.staticTexts.matching(identifier: "connection-status").firstMatch
            let error = app.staticTexts.matching(identifier: "connection-error").firstMatch
            let connectionLabel = connection.exists ? connection.label : "missing"
            let errorLabel = error.exists ? error.label : "none"
            let recoveryLabel = pending.exists ? pending.label : "missing"
            let submitEnabled = app.buttons["Submit action"].isEnabled
            XCTFail("The stalled first receipt did not leave the actual action pending: posts=\(failedDiagnostics.actionPosts), receiptReads=\(failedDiagnostics.receiptReads), requestId=\(failedDiagnostics.requestId), actions=\(failedHistory.map(\.action)), connection=\(connectionLabel), error=\(errorLabel), recovery=\(recoveryLabel), submitEnabled=\(submitEnabled)")
            return
        }
        var diagnostics = try await observer.responseLossDiagnostics(at: api)
        XCTAssertEqual(diagnostics.actionPosts, 1)
        XCTAssertEqual(diagnostics.receiptReads, 1)
        XCTAssertNotNil(UUID(uuidString: diagnostics.requestId))
        let permission = try await setManifestPermissions("deny-write", using: observer)
        XCTAssertEqual(permission["denied"] as? Bool, true)
        let deniedMode = try XCTUnwrap(permission["mode"] as? Int)
        let permissionOriginalMode = try XCTUnwrap(permission["originalMode"] as? Int)
        XCTAssertEqual(deniedMode, permissionOriginalMode & ~0o222)
        XCTAssertEqual(deniedMode & 0o2000, specialBitEnabled ? 0o2000 : originalMode & 0o2000, "The native removal failure must preserve every special permission bit")
        XCTAssertEqual(permission["uid"] as? Int, permission["originalUid"] as? Int)
        XCTAssertEqual(permission["gid"] as? Int, permission["originalGid"] as? Int)

        app.buttons["Check action receipt"].tap()
        XCTAssertTrue(pending.waitForLabelContaining("Confirmed receipt", timeout: 15))
        XCTAssertTrue(pending.label.contains("Device storage could not clear the pending identity"), "The confirmed receipt must remain visibly pending when manifest removal fails")
        XCTAssertFalse(app.buttons["Submit action"].isEnabled, "A confirmed receipt with a durable pending ID must not permit a second POST")
        let history = try await observer.actions(at: api)
        let receipts = history.filter { $0.action == action }
        XCTAssertEqual(receipts.count, 1)
        let original = try XCTUnwrap(receipts.first)
        XCTAssertTrue(pending.label.contains(original.id))
        diagnostics = try await observer.responseLossDiagnostics(at: api)
        XCTAssertEqual(diagnostics.actionPosts, 1)
        XCTAssertEqual(diagnostics.receiptReads, 2)
        XCTAssertEqual(UUID(uuidString: diagnostics.requestId)?.uuidString.lowercased(), diagnostics.requestId)
        let (canonicalData, canonicalResponse) = try await observer.data(from: URL(string: "/api/actions/receipts/\(diagnostics.requestId)", relativeTo: api)!)
        XCTAssertEqual((canonicalResponse as? HTTPURLResponse)?.statusCode, 200)
        let canonicalReceipt = try JSONDecoder().decode(ActionReceipt.self, from: canonicalData)
        XCTAssertEqual(canonicalReceipt.id, original.id)
        XCTAssertEqual(canonicalReceipt.action, action)

        let restored = try await setManifestPermissions("restore", using: observer)
        XCTAssertEqual(restored["restored"] as? Bool, true)
        XCTAssertEqual(restored["mode"] as? Int, permission["originalMode"] as? Int)
        XCTAssertEqual(restored["uid"] as? Int, permission["originalUid"] as? Int)
        XCTAssertEqual(restored["gid"] as? Int, permission["originalGid"] as? Int)
        app.terminate()
        app.launch()
        signIn(app)
        let check = app.buttons["Check action receipt"]
        XCTAssertTrue(check.waitForExistence(timeout: 10), "The persisted original request ID must return after process restart")
        check.tap()
        XCTAssertTrue(pending.waitForLabelContaining("Confirmed receipt", timeout: 15))
        XCTAssertTrue(pending.label.contains(original.id), "Manual recovery must reconcile the same canonical receipt")
        XCTAssertTrue(app.staticTexts["Receipt \(original.id)"].exists)
        XCTAssertTrue(check.waitForNonExistence(timeout: 5), "Successful post-restart receipt reconciliation must clear the original pending ID")
        diagnostics = try await observer.responseLossDiagnostics(at: api)
        XCTAssertEqual(diagnostics.actionPosts, 1, "Restored permissions and manual receipt recovery must not replay the action")
        XCTAssertEqual(diagnostics.receiptReads, 4, "The two app checks and one independent canonical API read must preserve one POST")
        XCTAssertEqual(UUID(uuidString: diagnostics.requestId)?.uuidString.lowercased(), diagnostics.requestId)
        let finalHistory = try await observer.actions(at: api)
        XCTAssertEqual(finalHistory.filter { $0.action == action }.map(\.id), [original.id])
        if specialBitEnabled {
            let specialBitRestored = try await setManifestPermissions("restore-special-bit", using: observer)
            XCTAssertEqual(specialBitRestored["mode"] as? Int, originalMode)
            XCTAssertEqual(specialBitRestored["uid"] as? Int, specialMode["originalUid"] as? Int)
            XCTAssertEqual(specialBitRestored["gid"] as? Int, specialMode["originalGid"] as? Int)
        }

        let cleanupPermission = try await setManifestPermissions("deny-write", using: observer)
        XCTAssertEqual(cleanupPermission["denied"] as? Bool, true)
        let cleanupOriginalMode = try XCTUnwrap(cleanupPermission["originalMode"] as? Int)
        XCTAssertEqual(cleanupPermission["mode"] as? Int, cleanupOriginalMode & ~0o222)
        XCTAssertEqual(cleanupPermission["uid"] as? Int, cleanupPermission["originalUid"] as? Int)
        XCTAssertEqual(cleanupPermission["gid"] as? Int, cleanupPermission["originalGid"] as? Int)
        var logout = URLRequest(url: URL(string: "/api/auth/logout", relativeTo: api)!)
        logout.httpMethod = "POST"
        logout.setValue("application/json", forHTTPHeaderField: "Content-Type")
        logout.httpBody = Data("{}".utf8)
        let (_, logoutResponse) = try await observer.data(for: logout)
        XCTAssertEqual((logoutResponse as? HTTPURLResponse)?.statusCode, 204)
        let expiredSession = try await observer.get(URL(string: "/api/auth/session", relativeTo: api)!)
        XCTAssertEqual(expiredSession.statusCode, 401)
        XCTAssertTrue(app.staticTexts.matching(identifier: "connection-status").firstMatch.waitForLabel("signed out", timeout: 15))
        let (unauthenticatedRestore, _) = try await requestManifestPermissions("restore", using: observer)
        XCTAssertEqual(unauthenticatedRestore, 401, "The process-owned cleanup must restore without an authenticated HTTP backdoor")
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
    func testInstalledAppResolvesACommittedButLostPossessionReleaseByReceipt() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        let (api, workspace) = try await fileWorkspace(app, observer: observer, prefix: "Lost")

        let possession = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Possession: ")).firstMatch
        guard possession.waitForExistence(timeout: 15) else {
            throw NSError(domain: "NativeSessionProof", code: 10, userInfo: [NSLocalizedDescriptionKey: "session panel is not reachable"])
        }
        try tapFileControl("Take over screen", in: app)
        guard possession.waitForLabelContaining("Possession: holder", timeout: 20) else {
            throw NSError(domain: "NativeSessionProof", code: 11, userInfo: [NSLocalizedDescriptionKey: "take-over never reached holder"])
        }

        // From here the server commits the release and then withholds the response.
        try await observer.armScreenLoss(at: api, workspaceId: workspace.id)
        try tapFileControl("Return screen", in: app)

        // The panel must settle instead of loading forever, must not claim a
        // definitive failure for a release that committed, and must end up
        // agreeing with the backend that the screen is free.
        let settled = app.staticTexts["session-status"]
        guard possession.waitForLabelContaining("Possession: none", timeout: 30) else {
            throw NSError(domain: "NativeSessionProof", code: 12, userInfo: [NSLocalizedDescriptionKey: "the panel never resolved the lost release: \(possession.label) / \(settled.label)"])
        }
        guard settled.waitForLabelContaining("No possession held", timeout: 10) else {
            throw NSError(domain: "NativeSessionProof", code: 14, userInfo: [NSLocalizedDescriptionKey: "the panel did not settle on the receipt: \(settled.label)"])
        }
        XCTAssertFalse(settled.label.localizedCaseInsensitiveContains("failed"))
        XCTAssertFalse(settled.label.localizedCaseInsensitiveContains("error"))
        XCTAssertFalse(settled.label.localizedCaseInsensitiveContains("too slow"))

        let diagnostics = try await observer.screenLossDiagnostics(at: api)
        XCTAssertEqual(diagnostics["releasePosts"] as? Int, 1, "the release must reach the server exactly once")

        // Let the withheld response arrive late. It says the release committed, so
        // it may confirm the client's state but it may not write a second time.
        try await observer.releaseScreenLoss(at: api)
        let after = try await observer.screenLossDiagnostics(at: api)
        XCTAssertEqual(after["releasePosts"] as? Int, 1, "the late response must not replay the release")
        XCTAssertEqual(after["held"] as? Bool, false, "the withheld response was never delivered")
    }

    @MainActor
    func testInstalledAppTakesOverAndReturnsTheScreenAndRefusesBotInput() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        let (api, workspace) = try await fileWorkspace(app, observer: observer, prefix: "Session")

        // The mobile client shows the session for the selected workspace.
        let possession = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Possession: ")).firstMatch
        guard possession.waitForExistence(timeout: 15) else {
            throw NSError(domain: "NativeSessionProof", code: 1, userInfo: [NSLocalizedDescriptionKey: "the session panel is not reachable for the selected workspace"])
        }
        XCTAssertTrue(possession.waitForLabelContaining("Possession: none", timeout: 15))

        // The Bot has observed this screen before any human control.
        let before = try await observer.screenObservation(at: api, workspaceId: workspace.id)
        XCTAssertEqual(before.status, 200, String(describing: before.body))
        let beforeToken = try XCTUnwrap(before.body["stateToken"] as? String)

        // The mobile client takes the screen over.
        try tapFileControl("Take over screen", in: app)
        guard possession.waitForLabelContaining("Possession: holder", timeout: 20) else {
            throw NSError(domain: "NativeSessionProof", code: 2, userInfo: [NSLocalizedDescriptionKey: "take-over never reached holder; the panel shows \(possession.label)"])
        }

        // While the human holds the screen the Bot is refused, and refused for that reason.
        let blocked = try await observer.screenAgentInput(at: api, workspaceId: workspace.id, stateToken: beforeToken)
        XCTAssertEqual(blocked.status, 409, String(describing: blocked.body))
        XCTAssertEqual(blocked.body["error"] as? String, "possession_held_by_user")

        // Returning the screen hands control back.
        try tapFileControl("Return screen", in: app)
        guard possession.waitForLabelContaining("Possession: none", timeout: 20) else {
            throw NSError(domain: "NativeSessionProof", code: 3, userInfo: [NSLocalizedDescriptionKey: "return never released; the panel shows \(possession.label)"])
        }

        // The observation taken before the take-over is stale, not silently accepted.
        let stale = try await observer.screenAgentInput(at: api, workspaceId: workspace.id, stateToken: beforeToken)
        XCTAssertEqual(stale.status, 409, String(describing: stale.body))
        XCTAssertEqual(stale.body["error"] as? String, "stale_observation")

        // A fresh observation after the return is accepted by the shipped route.
        let after = try await observer.screenObservation(at: api, workspaceId: workspace.id)
        XCTAssertEqual(after.status, 200, String(describing: after.body))
        XCTAssertNotNil(after.body["stateToken"] as? String)
        XCTAssertGreaterThan(try XCTUnwrap(after.body["epoch"] as? Int), try XCTUnwrap(before.body["epoch"] as? Int))

        // The run result the session shows is on screen, not only in the API.
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "session-result").firstMatch.exists)
    }

    @MainActor
    func testNavigationAcrossScreensJourney() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        app.launch()
        let host = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Host: ")).firstMatch
        XCTAssertTrue(host.waitForExistence(timeout: 15))
        let api = try XCTUnwrap(URL(string: String(host.label.dropFirst("Host: ".count))))
        signIn(app)
        try await observer.signIn(at: api, password: password)

        // Main actions: the app submits one through its own control while it is
        // on the workspaces screen, and the host holds it.
        let actionName = "native-nav-action-\(UUID().uuidString)"
        let actionInput = app.textFields["Action"]
        XCTAssertTrue(actionInput.waitForExistence(timeout: 15),
                      "The workspaces screen should offer the action field. Visible: \(app.debugDescription)")
        actionInput.tap()
        for character in actionName { actionInput.typeText(String(character)) }
        app.keyboards.buttons["Return"].tap()
        app.staticTexts["Host connection"].firstMatch.tap()
        let submit = app.buttons["Submit action"]
        XCTAssertTrue(submit.isEnabled && submit.isHittable, "Submit action must be interactable")
        submit.tap()
        XCTAssertTrue(app.staticTexts[actionName].waitForExistence(timeout: 15),
                      "The app's own submission should appear. Visible: \(app.debugDescription)")
        let namedReceipts = try await observer.actions(at: api)
        XCTAssertTrue(namedReceipts.contains(where: { $0.action == actionName }),
                      "The host should hold the action the app submitted; saw \(namedReceipts.map(\.action))")

        // A second, distinct action submitted outside the app: the host holds
        // both, and the tab below shows the one the app made.
        let observerAction = "native-nav-action-note-\(UUID().uuidString)"
        _ = try await observer.submitAction(at: api, action: observerAction)

        // The Actions tab shows the same receipt while the app holds it.
        let actionsTab = app.buttons["Actions"]
        XCTAssertTrue(actionsTab.waitForExistence(timeout: 10))
        actionsTab.tap()
        XCTAssertTrue(app.staticTexts[actionName].waitForExistence(timeout: 20),
                      "The Actions screen should show the submitted action. Visible: \(app.debugDescription)")
        app.buttons["Workspaces"].tap()

        // The host holds one workspace with a Bot, a thread, its message, an
        // Inbox item and an action; every screen below is compared with those
        // rows, not merely checked for being on screen.
        let workspaceName = "native-nav-workspace-\(UUID().uuidString)"
        let workspace = try await observer.createWorkspace(at: api, name: workspaceName)
        let botName = "native-nav-bot-\(UUID().uuidString)"
        let bot = try await observer.createBot(at: api, name: botName)
        let threadTitle = "native-nav-thread-\(UUID().uuidString)"
        let thread = try await observer.createThread(at: api, workspaceId: workspace.id, title: threadTitle)
        let messageBody = "native-nav-message-body"
        try await observer.postMessage(at: api, threadId: thread.id, body: messageBody)
        let inboxItem = try await observer.runToInboxItem(at: api, workspaceId: workspace.id, botId: bot.id)

        // Bots: the row is the Bot the host holds, addressed by its own label.
        let botsTab = app.buttons["Bots"]
        XCTAssertTrue(botsTab.waitForExistence(timeout: 10))
        botsTab.tap()
        XCTAssertTrue(app.buttons["Bot \(botName)"].waitForExistence(timeout: 20),
                      "The Bots screen should show the seeded Bot. Visible: \(app.debugDescription)")

        // Threads: the tab asks which workspace when a push did not name one.
        let threadsTab = app.buttons["Threads"]
        XCTAssertTrue(threadsTab.waitForExistence(timeout: 10))
        threadsTab.tap()
        let workspaceChoice = app.buttons["Threads for \(workspaceName)"]
        XCTAssertTrue(workspaceChoice.waitForExistence(timeout: 20),
                      "The Threads screen should offer the seeded workspace")
        workspaceChoice.tap()
        let threadRow = app.buttons["Thread \(threadTitle)"]
        XCTAssertTrue(threadRow.waitForExistence(timeout: 20),
                      "The workspace's threads should include the seeded thread. Visible: \(app.debugDescription)")
        threadRow.tap()
        XCTAssertTrue(app.staticTexts[messageBody].waitForExistence(timeout: 20),
                      "The thread should show the message the host holds. Visible: \(app.debugDescription)")

        // Inbox: the seeded item's own title.
        let inboxTab = app.buttons["Inbox"]
        XCTAssertTrue(inboxTab.waitForExistence(timeout: 10))
        inboxTab.tap()
        XCTAssertTrue(app.staticTexts[inboxItem].waitForExistence(timeout: 20),
                      "The Inbox screen should show the item the host recorded. Visible: \(app.debugDescription)")

    }

    /// RC-057 on iOS: the phone takes over the Bot's screen on a host that is
    /// already running (the Linux host behind the RC-057 loopback front), sends
    /// human input the host applies, is refused nothing while it holds, and
    /// recovers after the app is killed mid-hold.
    @MainActor
    func testTakeoverScreenOnHostWithHumanInput() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        app.launch()
        let host = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Host: ")).firstMatch
        XCTAssertTrue(host.waitForExistence(timeout: 15), "the app must show the host it was built for")
        let api = try XCTUnwrap(URL(string: String(host.label.dropFirst("Host: ".count))))
        signIn(app)
        try await observer.signIn(at: api, password: password)

        let workspaceName = "ios-takeover-\(UUID().uuidString)"
        let workspace = try await observer.createWorkspace(at: api, name: workspaceName)

        // The workspace the host holds, then its screen.
        try tapFileControl("Refresh workspaces", in: app)
        let open = app.buttons["Open workspace \(workspaceName)"]
        XCTAssertTrue(open.waitForExistence(timeout: 20), "the workspace the host holds must be listed")
        open.tap()
        let possession = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Possession: ")).firstMatch
        XCTAssertTrue(possession.waitForExistence(timeout: 20), "the session panel must be reachable")

        try tapFileControl("Take over screen", in: app)
        XCTAssertTrue(possession.waitForLabelContaining("Possession: holder", timeout: 30), "take-over must reach holder")
        // Human input the host applies: text and a click.
        let text = app.textFields["Screen text"]
        XCTAssertTrue(text.waitForExistence(timeout: 20), "the input row appears while this client holds the screen")
        text.tap()
        text.typeText("ios-human-input")
        try tapFileControl("Send screen text", in: app)
        let status = app.staticTexts["session-status"]
        XCTAssertTrue(status.waitForLabelContaining("The host applied the text.", timeout: 60),
                      "the host must apply the text; status: \(status.label)")
        try tapFileControl("Click screen centre", in: app)
        XCTAssertTrue(status.waitForLabelContaining("The host applied the click.", timeout: 60),
                      "the host must apply the click; status: \(status.label)")

        // While the human holds the screen the Bot must be refused.
        try await assertAgentRefused(observer: observer, api: api, workspaceId: workspace.id)

        // Control is returned through the same service, and the host's answer is
        // what the panel shows.
        try tapFileControl("Return screen", in: app)
        XCTAssertTrue(possession.waitForLabelContaining("Possession: none", timeout: 30),
                      "the host must confirm the screen was returned: \(possession.label)")

        // Killed mid-hold: the restarted client must hold nothing, and control
        // must be recoverable.
        app.terminate()
        app.launch()
        signIn(app)
        try await observer.signIn(at: api, password: password)
        try tapFileControl("Refresh workspaces", in: app)
        let reopen = app.buttons["Open workspace \(workspaceName)"]
        XCTAssertTrue(reopen.waitForExistence(timeout: 20))
        reopen.tap()
        let after = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Possession: ")).firstMatch
        XCTAssertTrue(after.waitForExistence(timeout: 20))
        XCTAssertFalse(after.label.contains("holder"),
                       "a client that was killed must not still appear to hold the screen")
        try tapFileControl("Take over screen", in: app)
        XCTAssertTrue(after.waitForLabelContaining("Possession: holder", timeout: 30),
                      "control must be recoverable after the drop")
    }

    /// The Bot may not act while the human holds the screen.
    private func assertAgentRefused(observer: URLSession, api: URL, workspaceId: String) async throws {
        var request = URLRequest(url: URL(string: "/api/workspaces/\(workspaceId)/screen/agent/input", relativeTo: api)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "stateToken": "ios-takeover-not-an-observation",
            "event": ["kind": "click", "x": 1, "y": 1],
        ])
        let (data, response) = try await observer.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 409,
                       "the host must refuse the agent while the human holds the screen")
        let body = String(data: data, encoding: .utf8) ?? ""
        XCTAssertTrue(body.contains("possession_held_by_user"),
                      "the refusal must name the human holding the screen: \(body)")
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

    // RC-066: the app shows a Bot's routines, and the host is the authority for
    // what that row says. The runner seeds the Bot and its routine and names
    // them in the launch environment.
    func testRoutinesFromHostJourney() async throws {
        let app = XCUIApplication(bundleIdentifier: "com.remotecode.mobileproof")
        let observer = URLSession(configuration: .ephemeral)
        app.launch()
        let host = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Host: ")).firstMatch
        XCTAssertTrue(host.waitForExistence(timeout: 15))
        let api = try XCTUnwrap(URL(string: String(host.label.dropFirst("Host: ".count))))
        signIn(app)
        try await observer.signIn(at: api, password: password)

        let environment = ProcessInfo.processInfo.environment
        let botName = try XCTUnwrap(environment["RC_NATIVE_TEST_BOT_NAME"],
                                    "the runner should pass the seeded Bot's name")
        let routineTime = try XCTUnwrap(environment["RC_NATIVE_TEST_ROUTINE_TIME"],
                                        "the runner should pass the routine's local time")
        let routineTimezone = try XCTUnwrap(environment["RC_NATIVE_TEST_ROUTINE_TIMEZONE"],
                                            "the runner should pass the routine's timezone")

        let botsTab = app.buttons["Bots"]
        XCTAssertTrue(botsTab.waitForExistence(timeout: 10))
        botsTab.tap()
        let botRow = app.buttons["Bot \(botName)"]
        XCTAssertTrue(botRow.waitForExistence(timeout: 20),
                      "The Bots screen should show the seeded Bot. Visible: \(app.debugDescription)")
        botRow.tap()
        XCTAssertTrue(app.staticTexts["Routines for \(botName)"].waitForExistence(timeout: 20),
                      "The Bot's detail should list its routines. Visible: \(app.debugDescription)")

        // The host's own record, so the row is compared with it rather than read
        // as the app's own opinion.
        let hostRoutines = try await observer.schedules(at: api)
        XCTAssertEqual(hostRoutines.count, 1, "the runner seeds exactly one routine: \(hostRoutines)")
        let seeded = try XCTUnwrap(hostRoutines.first)
        XCTAssertEqual(seeded.localTime, routineTime)
        XCTAssertEqual(seeded.timezone, routineTimezone)

        let expectedRow = "\(routineTime) (\(routineTimezone))"
        let routineRow = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", expectedRow)).firstMatch
        XCTAssertTrue(routineRow.waitForExistence(timeout: 20),
                      "The routine row should carry the host's local time and timezone. Visible: \(app.debugDescription)")
        let expectedState = seeded.enabled ? "enabled" : "paused"
        XCTAssertTrue(routineRow.label.contains(expectedState),
                      "The row should carry the host's state; saw \(routineRow.label)")
    }
}
}

private struct FileCreateReceipt: Decodable {
    let path: String
    let version: String
}

private struct FileContent: Decodable {
    let path: String
    let content: String
    let version: String
}

private struct FileSaveResult: Decodable {
    let path: String
    let version: String
}

private struct FileSaveError: Decodable {
    let error: String
}

private struct FileLossDiagnostics: Decodable {
    let kind: String
    let mutationPosts: Int
    let phase: String
    let preflightGets: Int
    let held: Bool
    let requestId: String?
    let savePosts: Int
    let receiptGets: Int
}

private struct WorkspaceMetadata: Decodable {
    let id: String
    let name: String
    let createdAt: String
    let archived: Bool?
}

private struct WorkspaceMetadataList: Decodable {
    let workspaces: [WorkspaceMetadata]
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
    func clearAndTypeText(_ text: String, in app: XCUIApplication) throws {
        tap()
        if (value as? String) != "" {
            press(forDuration: 1.2)
            if app.staticTexts["Type English and Portuguese"].waitForExistence(timeout: 2) {
                app.buttons["Continue"].tap()
                press(forDuration: 1.2)
            }
            let selectAll = app.descendants(matching: .any).matching(identifier: "Select All").firstMatch
            guard selectAll.waitForExistence(timeout: 5) else {
                throw NSError(domain: "NativeFileProof", code: 1, userInfo: [NSLocalizedDescriptionKey: "The native text selection menu must offer Select All"])
            }
            selectAll.tap()
            typeText(XCUIKeyboardKey.delete.rawValue)
            guard (value as? String) == "" else {
                throw NSError(domain: "NativeFileProof", code: 2, userInfo: [NSLocalizedDescriptionKey: "Text selection must clear the old draft before typing"])
            }
        }
        for character in text { typeText(String(character)) }
        guard (value as? String) == text else { throw NSError(domain: "NativeFileProof", code: 8, userInfo: [NSLocalizedDescriptionKey: "Exact draft input was not preserved"]) }
    }

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

private struct HostSchedule: Decodable {
    let id: String
    let localTime: String
    let timezone: String
    let enabled: Bool
}

private struct HostScheduleList: Decodable {
    let schedules: [HostSchedule]
}

private extension URLSession {
    func schedules(at baseURL: URL) async throws -> [HostSchedule] {
        let (data, response) = try await data(from: URL(string: "/api/schedules", relativeTo: baseURL)!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try JSONDecoder().decode(HostScheduleList.self, from: data).schedules
    }
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

    func armScreenLoss(at baseURL: URL, workspaceId: String) async throws {
        var request = URLRequest(url: URL(string: "/__test__/screen-loss-arm", relativeTo: baseURL)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["workspaceId": workspaceId])
        let (data, response) = try await self.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, String(describing: String(data: data, encoding: .utf8)))
    }

    func screenLossDiagnostics(at baseURL: URL) async throws -> [String: Any] {
        let (data, response) = try await self.data(from: URL(string: "/__test__/screen-loss-diagnostics", relativeTo: baseURL)!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    func releaseScreenLoss(at baseURL: URL) async throws {
        var request = URLRequest(url: URL(string: "/__test__/screen-loss-release", relativeTo: baseURL)!)
        request.httpMethod = "POST"
        let (data, response) = try await self.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, String(describing: String(data: data, encoding: .utf8)))
    }

    func screenObservation(at baseURL: URL, workspaceId: String) async throws -> (status: Int, body: [String: Any]) {
        var request = URLRequest(url: URL(string: "/api/workspaces/\(workspaceId)/screen/agent/observation", relativeTo: baseURL)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["agentId": "native-proof"])
        let (data, response) = try await data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let body = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any]) ?? [:]
        return (status, body)
    }

    func screenAgentInput(at baseURL: URL, workspaceId: String, stateToken: String) async throws -> (status: Int, body: [String: Any]) {
        var request = URLRequest(url: URL(string: "/api/workspaces/\(workspaceId)/screen/agent/input", relativeTo: baseURL)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["stateToken": stateToken, "event": ["kind": "key", "key": "Shift"]])
        let (data, response) = try await data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let body = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any]) ?? [:]
        return (status, body)
    }

    func signIn(at baseURL: URL, password: String) async throws {
        var request = URLRequest(url: URL(string: "/api/auth/login", relativeTo: baseURL)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(baseURL.scheme == "https" ? "https://localhost" : "http://localhost:5173", forHTTPHeaderField: "Origin")
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

    func workspaceList(at baseURL: URL) async throws -> [WorkspaceMetadata] {
        let (data, response) = try await data(from: URL(string: "/api/workspaces", relativeTo: baseURL)!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try JSONDecoder().decode(WorkspaceMetadataList.self, from: data).workspaces
    }

    func workspace(at baseURL: URL, id: String) async throws -> WorkspaceMetadata {
        let (data, response) = try await data(from: URL(string: "/api/workspaces/\(id)", relativeTo: baseURL)!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try JSONDecoder().decode(WorkspaceMetadata.self, from: data)
    }

    func armFileSaveLoss(at baseURL: URL, nonce: String, workspaceId: String, path: String, kind: String = "save", sourcePath: String? = nil, phase: String? = nil) async throws {
        var request = URLRequest(url: URL(string: "/__test__/file-save-loss-arm", relativeTo: baseURL)!)
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body = ["nonce": nonce, "workspaceId": workspaceId, "path": path]
        if kind != "save" { body["kind"] = kind }
        if let sourcePath { body["sourcePath"] = sourcePath }
        if let phase { body["phase"] = phase }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (_, response) = try await data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    func fileSaveLossDiagnostics(at baseURL: URL) async throws -> FileLossDiagnostics {
        let (data, response) = try await data(from: URL(string: "/__test__/file-save-loss-diagnostics", relativeTo: baseURL)!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try JSONDecoder().decode(FileLossDiagnostics.self, from: data)
    }

    func releaseFileSaveLoss(at baseURL: URL) async throws {
        var request = URLRequest(url: URL(string: "/__test__/file-save-loss-release", relativeTo: baseURL)!)
        request.httpMethod = "POST"
        let (_, response) = try await data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    func provisionFolder(at baseURL: URL, workspaceId: String) async throws {
        var request = URLRequest(url: URL(string: "/api/workspaces/\(workspaceId)/folder", relativeTo: baseURL)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["requestId": UUID().uuidString])
        let (_, response) = try await data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let (_, ready) = try await data(from: URL(string: "/api/workspaces/\(workspaceId)/folder", relativeTo: baseURL)!)
        XCTAssertEqual((ready as? HTTPURLResponse)?.statusCode, 200)
    }

    func createFile(at baseURL: URL, workspaceId: String, path: String, content: String) async throws -> FileCreateReceipt {
        var request = URLRequest(url: URL(string: "/api/workspaces/\(workspaceId)/files", relativeTo: baseURL)!)
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["requestId": UUID().uuidString, "path": path, "content": content])
        let (data, response) = try await data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 201)
        return try JSONDecoder().decode(FileCreateReceipt.self, from: data)
    }

    func openFile(at baseURL: URL, workspaceId: String, path: String) async throws -> FileContent {
        let (data, response) = try await data(from: URL(string: "/api/workspaces/\(workspaceId)/files/content?path=\(path)", relativeTo: baseURL)!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try JSONDecoder().decode(FileContent.self, from: data)
    }

    func saveFile(at baseURL: URL, workspaceId: String, path: String, content: String, expectedVersion: String, requestId: String) async throws -> FileSaveResult {
        let result = try await saveFileRaw(at: baseURL, workspaceId: workspaceId, path: path, content: content, expectedVersion: expectedVersion, requestId: requestId)
        XCTAssertEqual(result.statusCode, 201)
        return try JSONDecoder().decode(FileSaveResult.self, from: result.data)
    }

    func saveFileRaw(at baseURL: URL, workspaceId: String, path: String, content: String, expectedVersion: String, requestId: String) async throws -> (statusCode: Int, error: String?, data: Data) {
        var request = URLRequest(url: URL(string: "/api/workspaces/\(workspaceId)/files/content", relativeTo: baseURL)!)
        request.httpMethod = "PUT"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["requestId": requestId, "path": path, "content": content, "expectedVersion": expectedVersion])
        let (data, response) = try await data(for: request)
        let status = try XCTUnwrap((response as? HTTPURLResponse)?.statusCode)
        let error = (try? JSONDecoder().decode(FileSaveError.self, from: data))?.error
        return (status, error, data)
    }

    func sha256(_ content: String) async throws -> String {
        SHA256.hash(data: Data(content.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    func actions(at baseURL: URL) async throws -> [ActionReceipt] {
        let (data, response) = try await data(from: URL(string: "/api/actions", relativeTo: baseURL)!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try JSONDecoder().decode(ActionHistory.self, from: data).actions
    }

    func createWorkspace(at baseURL: URL, name: String) async throws -> WorkspaceMetadata {
        var request = URLRequest(url: URL(string: "/api/workspaces", relativeTo: baseURL)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["name": name, "requestId": UUID().uuidString])
        let (data, response) = try await data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 201)
        return try JSONDecoder().decode(WorkspaceMetadata.self, from: data)
    }

    func createBot(at baseURL: URL, name: String) async throws -> BotMetadata {
        var request = URLRequest(url: URL(string: "/api/bots", relativeTo: baseURL)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["name": name, "instructions": "Test bot"])
        let (data, response) = try await data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 201)
        return try JSONDecoder().decode(BotMetadata.self, from: data)
    }

    func createThread(at baseURL: URL, workspaceId: String, title: String) async throws -> ThreadMetadata {
        var request = URLRequest(url: URL(string: "/api/workspaces/\(workspaceId)/threads", relativeTo: baseURL)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["title": title, "requestId": UUID().uuidString])
        let (data, response) = try await data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 201)
        return try JSONDecoder().decode(ThreadMetadata.self, from: data)
    }

    func postMessage(at baseURL: URL, threadId: String, body: String) async throws {
        var request = URLRequest(url: URL(string: "/api/threads/\(threadId)/messages", relativeTo: baseURL)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["body": body, "requestId": UUID().uuidString])
        let (_, response) = try await data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 201)
    }

    func startRun(at baseURL: URL, workspaceId: String, botId: String, prompt: String) async throws -> RunMetadata {
        var request = URLRequest(url: URL(string: "/api/runs", relativeTo: baseURL)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["workspaceId": workspaceId, "botId": botId, "prompt": prompt, "requestId": UUID().uuidString])
        let (data, response) = try await data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 201)
        return try JSONDecoder().decode(RunMetadata.self, from: data)
    }

    func getRun(at baseURL: URL, id: String) async throws -> RunMetadata {
        let (data, response) = try await data(from: URL(string: "/api/runs/\(id)", relativeTo: baseURL)!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try JSONDecoder().decode(RunMetadata.self, from: data)
    }

    func listInbox(at baseURL: URL) async throws -> [InboxItemMetadata] {
        let (data, response) = try await data(from: URL(string: "/api/inbox", relativeTo: baseURL)!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try JSONDecoder().decode(InboxListMetadata.self, from: data).items
    }

    /// Sends a task as a run and returns the title of the Inbox item the host
    /// records for that run, whichever way the run ends.
    func runToInboxItem(at baseURL: URL, workspaceId: String, botId: String) async throws -> String {
        let run = try await startRun(at: baseURL, workspaceId: workspaceId, botId: botId,
                                     prompt: "native-nav-run-\(UUID().uuidString)")
        var observed: [String] = []
        for _ in 0..<120 {
            let items = try await listInbox(at: baseURL)
            observed = items.map(\.title)
            if let item = items.first(where: { $0.runId == run.id }) { return item.title }
            try await Task.sleep(nanoseconds: 500_000_000)
        }
        XCTFail("The host recorded no Inbox item for run \(run.id) (saw \(observed))")
        return ""
    }

    func submitAction(at baseURL: URL, action: String) async throws -> ActionReceipt {
        var request = URLRequest(url: URL(string: "/api/actions", relativeTo: baseURL)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["action": action])
        let (data, response) = try await data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 201)
        return try JSONDecoder().decode(ActionReceipt.self, from: data)
    }

    func get(_ url: URL) async throws -> HTTPURLResponse {
        let (_, response) = try await data(from: url)
        return try XCTUnwrap(response as? HTTPURLResponse)
    }
}
