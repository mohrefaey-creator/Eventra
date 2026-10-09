import XCTest
@testable import MirrorLinkCore

final class HandoffTests: XCTestCase {
    private let config = BroadcastConfig(server: "https://mirror.example.com", code: "123456", deviceName: "My iPhone", quality: .sharp, requestedAt: 1)

    func testBodyCarriesEverythingTheServerNeeds() throws {
        let data = Handoff.body(for: config, id: "ABCDEF01-2345-6789-ABCD-EF0123456789")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(object, [
            "id": "ABCDEF01-2345-6789-ABCD-EF0123456789",
            "code": "123456",
            "server": "https://mirror.example.com",
            "name": "My iPhone",
            "quality": "sharp",
        ])
    }

    func testParsesTheServersAnswer() throws {
        let json = #"{"code":"654321","server":"http://192.168.1.5:3000","name":"","quality":"saver"}"#
        let got = try XCTUnwrap(Handoff.parse(Data(json.utf8), fallbackName: "iPhone", now: 50))
        XCTAssertEqual(got, BroadcastConfig(server: "http://192.168.1.5:3000", code: "654321", deviceName: "iPhone", quality: .saver, requestedAt: 50))
    }

    func testRejectsAnswersThatAreNotUsable() {
        for json in ["", "[]", #"{"code":"12345","server":"https://a.example"}"#, #"{"code":"123456"}"#, #"{"code":"123456","server":"not a server"}"#] {
            XCTAssertNil(Handoff.parse(Data(json.utf8), fallbackName: "x"), json)
        }
    }

    func testUnreachableServerIsReportedNotHidden() {
        // Port 9 on the loopback address (discard) refuses connections.
        let result = Handoff.fetch(id: "ABCDEF01-2345-6789-ABCD-EF0123456789", rendezvous: "http://127.0.0.1:9", fallbackName: "x", attempts: 1)
        guard case .failed = result else { return XCTFail("expected a failure, got \(result)") }
    }
}
