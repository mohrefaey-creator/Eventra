import XCTest
@testable import MirrorLinkCore

final class SharedStoreTests: XCTestCase {
    private let suite = "mirrorlink.tests.\(UUID().uuidString)"

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suite)
        super.tearDown()
    }

    func testTheAppAndItsExtensionArriveAtTheSameGroup() {
        XCTAssertEqual(SharedStore.groupIdentifier(forBundleIdentifier: "com.example.mirror"), "group.com.example.mirror")
        XCTAssertEqual(SharedStore.groupIdentifier(forBundleIdentifier: "com.example.mirror.broadcast"), "group.com.example.mirror")
        XCTAssertEqual(SharedStore.groupIdentifier(forBundleIdentifier: nil), "group.com.mohrefaey.mirrorlink")
    }

    func testAConfigSurvivesARoundTrip() {
        let config = BroadcastConfig(server: "https://m.example.com", code: "123456", deviceName: "iPad", quality: .sharp, requestedAt: 1_000)
        XCTAssertTrue(SharedStore.save(config, suite: suite))
        XCTAssertEqual(SharedStore.load(suite: suite, now: 1_100), config)
    }

    func testAStaleOrClearedConfigIsIgnored() {
        let config = BroadcastConfig(server: "https://m.example.com", code: "123456", deviceName: "iPad", quality: .balanced, requestedAt: 1_000)
        XCTAssertTrue(SharedStore.save(config, suite: suite))
        XCTAssertNil(SharedStore.load(suite: suite, now: 1_000 + SharedStore.maxRequestAge + 1))
        SharedStore.clearConfig(suite: suite)
        XCTAssertNil(SharedStore.load(suite: suite, now: 1_001))
    }

    func testStatusRoundTripsAndANewRequestResetsIt() {
        let status = BroadcastStatus(phase: .ended, message: "The receiving screen declined.", isProblem: true, updatedAt: 5)
        SharedStore.write(status, suite: suite)
        XCTAssertEqual(SharedStore.readStatus(suite: suite), status)
        let config = BroadcastConfig(server: "https://m.example.com", code: "123456", deviceName: "iPad", quality: .saver, requestedAt: 10)
        XCTAssertTrue(SharedStore.save(config, suite: suite))
        XCTAssertNil(SharedStore.readStatus(suite: suite))
    }

    func testQualityKeysAndFallback() {
        XCTAssertEqual(Quality.from(key: "sharp"), .sharp)
        XCTAssertEqual(Quality.from(key: "nonsense"), .balanced)
        XCTAssertEqual(Quality.from(key: nil), .balanced)
        XCTAssertEqual(Quality.allCases.map(\.longEdge), [1280, 1920, 960])
    }
}
