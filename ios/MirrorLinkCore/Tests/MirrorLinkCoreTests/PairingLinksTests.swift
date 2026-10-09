import XCTest
@testable import MirrorLinkCore

final class PairingLinksTests: XCTestCase {
    func testParsesTheLinkTheReceiverQrCodeCarries() {
        XCTAssertEqual(
            PairingLinks.parse("https://mirror.example.com/send?code=123456"),
            PairingLink(server: "https://mirror.example.com", code: "123456")
        )
    }

    func testKeepsAPortAndToleratesAnEncodedOrSpacedCode() {
        XCTAssertEqual(
            PairingLinks.parse("https://192.168.1.5:3443/send?code=123%20456"),
            PairingLink(server: "https://192.168.1.5:3443", code: "123456")
        )
    }

    func testParsesTheAppDeepLinkTheWebSenderPageProduces() {
        XCTAssertEqual(
            PairingLinks.parse("mirrorlink://join?server=https%3A%2F%2Fmirror.example.com&code=654321"),
            PairingLink(server: "https://mirror.example.com", code: "654321")
        )
    }

    func testRejectsAnythingThatIsNotAPairingLink() {
        let bad = [
            "",
            "hello",
            "https://mirror.example.com/send",
            "https://mirror.example.com/send?code=12345",
            "https://mirror.example.com/send?code=abcdef",
            "ftp://mirror.example.com/send?code=123456",
            "mirrorlink://join?code=123456",
            "mirrorlink://join?server=ftp%3A%2F%2Fx&code=123456",
            "not a url at all ?code=123456",
        ]
        for text in bad {
            XCTAssertNil(PairingLinks.parse(text), "should reject: '\(text)'")
        }
    }

    func testNormalizesWhatAPersonTypesIntoAServerOrigin() {
        XCTAssertEqual(PairingLinks.normalizeServer("mirror.example.com"), "https://mirror.example.com")
        XCTAssertEqual(PairingLinks.normalizeServer("  https://mirror.example.com/  "), "https://mirror.example.com")
        XCTAssertEqual(PairingLinks.normalizeServer("http://10.0.0.5:3000/some/path?x=1"), "http://10.0.0.5:3000")
        XCTAssertEqual(PairingLinks.normalizeServer("http://[::1]:3000"), "http://[::1]:3000")
        XCTAssertNil(PairingLinks.normalizeServer(""))
        XCTAssertNil(PairingLinks.normalizeServer("   "))
        XCTAssertNil(PairingLinks.normalizeServer("ftp://mirror.example.com"))
        XCTAssertNil(PairingLinks.normalizeServer("https://"))
        XCTAssertNil(PairingLinks.normalizeServer("two words"))
    }

    func testNormalizesCodesToDigits() {
        XCTAssertEqual(PairingLinks.normalizeCode("123 456"), "123456")
        XCTAssertEqual(PairingLinks.normalizeCode("123-456"), "123456")
        XCTAssertEqual(PairingLinks.normalizeCode("abc"), "")
    }

    func testBuildsTheWebSocketUrl() {
        XCTAssertEqual(PairingLinks.webSocketUrl("https://mirror.example.com"), "wss://mirror.example.com/ws")
        XCTAssertEqual(PairingLinks.webSocketUrl("http://10.0.0.5:3000"), "ws://10.0.0.5:3000/ws")
    }
}
