import MirrorLinkCore
import ReplayKit
import UIKit

/// The small screen iOS shows inside its own "Screen Broadcast" box once MirrorLink is picked. It asks for the
/// code and hands it straight to the broadcast part. Apple provides this hand-over so that it works however the
/// app was installed: it needs no shared storage between the app and its extensions, which a free Apple ID
/// signed through Sideloadly does not allow.
final class SetupViewController: UIViewController, UITextFieldDelegate {
    private let defaults = UserDefaults.standard
    private let codeField = UITextField()
    private let nameField = UITextField()
    private let serverField = UITextField()
    private lazy var qualityControl = UISegmentedControl(items: Quality.allCases.map(\.label))
    private let problemLabel = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        build()
        prefill()
        Diag.log("setup screen shown", as: "setup")
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if (codeField.text ?? "").isEmpty { codeField.becomeFirstResponder() }
    }

    // MARK: - actions

    @objc private func startTapped() {
        let code = PairingLinks.normalizeCode(codeField.text ?? "")
        guard code.count == 6 else { return problem("Type the 6-digit code shown on the receiving screen.") }
        guard let server = PairingLinks.normalizeServer(serverField.text ?? "") else { return problem("The server address is not valid.") }
        let typedName = (nameField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let name = typedName.isEmpty ? UIDevice.current.name : typedName
        let quality = Quality.allCases[qualityControl.selectedSegmentIndex]

        defaults.set(server, forKey: "server")
        defaults.set(name, forKey: "deviceName")
        defaults.set(quality.rawValue, forKey: "quality")

        let info: [String: NSCoding & NSObjectProtocol] = [
            "server": server as NSString,
            "code": code as NSString,
            "name": name as NSString,
            "quality": quality.rawValue as NSString,
        ]
        Diag.log("setup done, code ends \(code.suffix(2)), server \(server)", server: server, as: "setup")
        extensionContext?.completeRequest(withBroadcast: URL(string: server) ?? URL(string: "https://mirror.example.com")!, setupInfo: info)
    }

    @objc private func cancelTapped() {
        extensionContext?.cancelRequest(withError: NSError(domain: "MirrorLink", code: -1, userInfo: nil))
    }

    @objc private func codeEdited() {
        let digits = String(PairingLinks.normalizeCode(codeField.text ?? "").prefix(6))
        codeField.text = digits.count > 3 ? "\(digits.prefix(3)) \(digits.dropFirst(3))" : digits
        problemLabel.text = nil
    }

    private func problem(_ text: String) {
        problemLabel.text = text
    }

    // MARK: - form

    private func prefill() {
        let configured = Bundle.main.object(forInfoDictionaryKey: "MirrorLinkServer") as? String ?? ""
        let fallback = configured.isEmpty || configured.contains("$(") ? "https://mirror.example.com" : configured
        serverField.text = PairingLinks.normalizeServer(defaults.string(forKey: "server") ?? "") ?? fallback
        nameField.text = defaults.string(forKey: "deviceName")
        nameField.placeholder = UIDevice.current.name
        let quality = Quality.from(key: defaults.string(forKey: "quality"))
        qualityControl.selectedSegmentIndex = Quality.allCases.firstIndex(of: quality) ?? 0
        // When the app could share its form (an Xcode build), start from what was typed there.
        if let suite = AppIdentity.sharedSuite(), let saved = SharedStore.load(suite: suite) {
            codeField.text = saved.code.count == 6 ? "\(saved.code.prefix(3)) \(saved.code.dropFirst(3))" : saved.code
            serverField.text = saved.server
            nameField.text = saved.deviceName
            qualityControl.selectedSegmentIndex = Quality.allCases.firstIndex(of: saved.quality) ?? 0
        }
    }

    private func build() {
        let title = UILabel()
        title.text = "Start mirroring"
        title.font = .systemFont(ofSize: 22, weight: .bold)
        title.accessibilityTraits = .header

        codeField.placeholder = "123 456"
        codeField.font = .monospacedDigitSystemFont(ofSize: 30, weight: .semibold)
        codeField.textAlignment = .center
        codeField.keyboardType = .numberPad
        codeField.textContentType = .oneTimeCode
        codeField.borderStyle = .roundedRect
        codeField.addTarget(self, action: #selector(codeEdited), for: .editingChanged)
        codeField.accessibilityLabel = "Pairing code"

        for field in [nameField, serverField] {
            field.borderStyle = .roundedRect
            field.autocorrectionType = .no
            field.autocapitalizationType = .none
            field.returnKeyType = .done
            field.delegate = self
        }
        serverField.keyboardType = .URL

        problemLabel.font = .preferredFont(forTextStyle: .footnote)
        problemLabel.textColor = .systemRed
        problemLabel.numberOfLines = 0

        var start = UIButton.Configuration.filled()
        start.title = "Start Broadcast"
        start.cornerStyle = .large
        let startButton = UIButton(configuration: start)
        startButton.addTarget(self, action: #selector(startTapped), for: .touchUpInside)

        var cancel = UIButton.Configuration.plain()
        cancel.title = "Cancel"
        let cancelButton = UIButton(configuration: cancel)
        cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)

        let buttons = UIStackView(arrangedSubviews: [cancelButton, startButton])
        buttons.axis = .horizontal
        buttons.spacing = 12
        buttons.distribution = .fillEqually

        let stack = UIStackView(arrangedSubviews: [
            title,
            labelled("Code shown on the receiving screen", codeField),
            labelled("Name of this device", nameField),
            labelled("Server", serverField),
            labelled("Quality", qualityControl),
            problemLabel,
            buttons,
        ])
        stack.axis = .vertical
        stack.spacing = 12
        stack.isLayoutMarginsRelativeArrangement = true
        stack.layoutMargins = UIEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)

        let scroll = UIScrollView()
        scroll.keyboardDismissMode = .interactive
        scroll.addSubview(stack)
        view.addSubview(scroll)
        scroll.translatesAutoresizingMaskIntoConstraints = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor),
            codeField.heightAnchor.constraint(equalToConstant: 52),
            startButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
        ])
    }

    private func labelled(_ text: String, _ control: UIView) -> UIView {
        let label = UILabel()
        label.text = text
        label.font = .preferredFont(forTextStyle: .footnote)
        label.textColor = .secondaryLabel
        let box = UIStackView(arrangedSubviews: [label, control])
        box.axis = .vertical
        box.spacing = 4
        return box
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return true
    }
}
