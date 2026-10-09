import Foundation

/// Reads what a program's own code signature says about it: who signed it and which permissions (entitlements) it
/// carries. For the server's log only; it answers "did the re-signing tool really sign the broadcast part, and with what?".
enum SignatureReader {
    static func describe(executable url: URL?) -> String {
        guard let url = url, let data = try? Data(contentsOf: url, options: .mappedIfSafe) else { return "cannot read the program" }
        guard data.count > 64 else { return "program too small" }
        guard le32(data, 0) == 0xFEED_FACF else { return String(format: "not a plain 64-bit program (magic %08lx)", le32(data, 0)) }

        var offset = 32
        var signature: (start: Int, size: Int)?
        for _ in 0..<le32(data, 16) {
            guard offset + 16 <= data.count else { break }
            let command = le32(data, offset)
            let size = le32(data, offset + 4)
            if command == 0x1D { signature = (le32(data, offset + 8), le32(data, offset + 12)) }
            if size < 8 { break }
            offset += size
        }
        guard let sig = signature, sig.start > 0, sig.start + 12 <= data.count else { return "NOT SIGNED (no signature block)" }
        guard be32(data, sig.start) == 0xFADE_0CC0 else { return "signature block unreadable" }

        var identifier = "?"
        var team = "none"
        var adhoc = false
        var entitlements = "none"
        let count = min(be32(data, sig.start + 8), 16)
        for index in 0..<count {
            let entry = sig.start + 12 + index * 8
            guard entry + 8 <= data.count else { break }
            let blob = sig.start + be32(data, entry + 4)
            guard blob + 8 <= data.count else { continue }
            let length = be32(data, blob + 4)
            switch be32(data, blob) {
            case 0xFADE_0C02: // the code directory
                guard blob + 52 <= data.count else { continue }
                let version = be32(data, blob + 8)
                adhoc = (be32(data, blob + 12) & 0x2) != 0
                identifier = cString(data, blob + be32(data, blob + 20))
                if version >= 0x20200, be32(data, blob + 48) > 0 { team = cString(data, blob + be32(data, blob + 48)) }
            case 0xFADE_7171: // entitlements, as an XML property list
                guard length > 8, blob + length <= data.count else { continue }
                let xml = data.subdata(in: (blob + 8)..<(blob + length))
                if let plist = (try? PropertyListSerialization.propertyList(from: xml, options: [], format: nil)) as? [String: Any] {
                    entitlements = plist.keys.sorted().map { (key: String) -> String in
                        let value = plist[key]
                        if let text = value as? String { return "\(key)=\(text)" }
                        if let flag = value as? Bool { return "\(key)=\(flag)" }
                        if let list = value as? [String] { return "\(key)=[\(list.joined(separator: ","))]" }
                        return key
                    }.joined(separator: "; ")
                } else {
                    entitlements = "unreadable"
                }
            default:
                break
            }
        }
        return "signed as \(identifier), team \(team), ad-hoc \(adhoc), permissions: \(entitlements)"
    }

    private static func le32(_ d: Data, _ o: Int) -> Int {
        guard o >= 0, o + 4 <= d.count else { return 0 }
        return Int(d[o]) | Int(d[o + 1]) << 8 | Int(d[o + 2]) << 16 | Int(d[o + 3]) << 24
    }

    private static func be32(_ d: Data, _ o: Int) -> Int {
        guard o >= 0, o + 4 <= d.count else { return 0 }
        return Int(d[o]) << 24 | Int(d[o + 1]) << 16 | Int(d[o + 2]) << 8 | Int(d[o + 3])
    }

    private static func cString(_ d: Data, _ o: Int) -> String {
        guard o >= 0, o < d.count else { return "?" }
        var end = o
        while end < d.count, d[end] != 0, end - o < 200 { end += 1 }
        return String(decoding: d.subdata(in: o..<end), as: UTF8.self)
    }
}
