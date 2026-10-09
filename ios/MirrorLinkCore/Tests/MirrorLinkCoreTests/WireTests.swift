import XCTest
@testable import MirrorLinkCore

/// The JSON shapes here are exactly what public/send.js and public/receive.js exchange.
final class WireTests: XCTestCase {
    private func json(_ text: String) -> [String: Any] {
        ((try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]) ?? [:]
    }

    func testJoinAndLeaveMatchTheWireProtocol() {
        let join = json(Wire.join(code: "123456", name: "Sam's tablet"))
        XCTAssertEqual(join["type"] as? String, "join")
        XCTAssertEqual(join["code"] as? String, "123456")
        XCTAssertEqual(join["name"] as? String, "Sam's tablet")
        XCTAssertEqual(json(Wire.leave())["type"] as? String, "leave")
    }

    func testAnOfferIsWrappedTheWayTheBrowserExpects() {
        let msg = json(Wire.description(SessionDescription(type: "offer", sdp: "v=0\r\n")))
        XCTAssertEqual(msg["type"] as? String, "signal")
        let d = (msg["data"] as? [String: Any])?["description"] as? [String: Any]
        XCTAssertEqual(d?["type"] as? String, "offer")
        XCTAssertEqual(d?["sdp"] as? String, "v=0\r\n")
    }

    func testACandidateCarriesTheThreeFieldsAddIceCandidateNeeds() {
        let msg = json(Wire.candidate(IceCandidate(sdpMid: "0", sdpMLineIndex: 1, candidate: "candidate:1 1 udp 1 10.0.0.2 5000 typ host")))
        let c = (msg["data"] as? [String: Any])?["candidate"] as? [String: Any]
        XCTAssertEqual(c?["candidate"] as? String, "candidate:1 1 udp 1 10.0.0.2 5000 typ host")
        XCTAssertEqual(c?["sdpMid"] as? String, "0")
        XCTAssertEqual(c?["sdpMLineIndex"] as? Int, 1)
    }

    func testACandidateWithoutAnMidSurvivesARoundTrip() {
        let sent = Wire.candidate(IceCandidate(sdpMid: nil, sdpMLineIndex: 0, candidate: "candidate:9"))
        XCTAssertEqual(Wire.parse(sent), .candidate(IceCandidate(sdpMid: nil, sdpMLineIndex: 0, candidate: "candidate:9")))
    }

    func testParsesEveryMessageTheServerAndReceiverCanSend() {
        XCTAssertEqual(Wire.parse(#"{"type":"waiting"}"#), .waiting)
        XCTAssertEqual(Wire.parse(#"{"type":"accepted"}"#), .accepted)
        XCTAssertEqual(Wire.parse(#"{"type":"rejected","reason":"timeout"}"#), .rejected(reason: "timeout"))
        XCTAssertEqual(Wire.parse(#"{"type":"rejected"}"#), .rejected(reason: "denied"))
        XCTAssertEqual(Wire.parse(#"{"type":"ended"}"#), .ended)
        XCTAssertEqual(Wire.parse(#"{"type":"host-left"}"#), .hostLeft)
        XCTAssertEqual(Wire.parse(#"{"type":"error","code":"bad-code"}"#), .error(code: "bad-code"))
        XCTAssertEqual(
            Wire.parse(#"{"type":"signal","data":{"description":{"type":"answer","sdp":"v=0"}}}"#),
            .description(SessionDescription(type: "answer", sdp: "v=0"))
        )
        XCTAssertEqual(
            Wire.parse(#"{"type":"signal","data":{"candidate":{"candidate":"candidate:1","sdpMid":"0","sdpMLineIndex":0}}}"#),
            .candidate(IceCandidate(sdpMid: "0", sdpMLineIndex: 0, candidate: "candidate:1"))
        )
    }

    func testGarbageNeverFails() {
        let inputs = ["", "not json", "[]", "{}", #"{"type":5}"#, #"{"type":"signal"}"#, #"{"type":"signal","data":{}}"#, #"{"type":"nope"}"#]
        for input in inputs {
            XCTAssertEqual(Wire.parse(input), .unknown, "input: '\(input)'")
        }
    }
}
