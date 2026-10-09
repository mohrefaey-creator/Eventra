import XCTest
@testable import MirrorLinkCore

final class ServerInfoTests: XCTestCase {
    func testReadsStringAndArrayUrlsAndTurnCredentials() throws {
        let info = try ServerInfo.parse(
            """
            {"iceServers":[
              {"urls":"stun:stun.example.com:3478"},
              {"urls":["turn:turn.example.com:3478","turns:turn.example.com:5349"],"username":"u","credential":"p"}
            ],"senderOrigins":[]}
            """
        )
        XCTAssertEqual(info.iceServers, [
            IceServer(urls: ["stun:stun.example.com:3478"]),
            IceServer(urls: ["turn:turn.example.com:3478", "turns:turn.example.com:5349"], username: "u", credential: "p"),
        ])
    }

    func testFallsBackToAPublicStunServerWhenTheListIsMissingOrUnusable() throws {
        XCTAssertEqual(try ServerInfo.parse("{}"), ServerInfo.fallback)
        XCTAssertEqual(try ServerInfo.parse(#"{"iceServers":[]}"#), ServerInfo.fallback)
        XCTAssertEqual(try ServerInfo.parse(#"{"iceServers":[{"nourls":1}]}"#), ServerInfo.fallback)
    }

    func testRejectsAResponseThatIsNotJson() {
        XCTAssertThrowsError(try ServerInfo.parse("<html>502</html>"))
    }
}
