// swift-tools-version:5.7
import PackageDescription

// The platform-independent half of the iOS sender: pairing links, the signaling protocol and the
// session state machine. It has no UIKit/ReplayKit/WebRTC in it, so it also builds and is tested on Linux.
let package = Package(
    name: "MirrorLinkCore",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "MirrorLinkCore", targets: ["MirrorLinkCore"])],
    targets: [
        .target(name: "MirrorLinkCore"),
        .testTarget(name: "MirrorLinkCoreTests", dependencies: ["MirrorLinkCore"]),
    ]
)
