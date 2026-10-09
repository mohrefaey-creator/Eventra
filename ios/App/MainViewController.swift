import MirrorLinkCore
import ReplayKit
import UIKit

/// The one screen of the app: the receiver's code, a few options, and a Start button that opens iOS's own
/// broadcast sheet. The actual capture runs in the broadcast extension (see Broadcast/SampleHandler.swift).
final class MainViewController: UIViewController, UITextFieldDelegate {
    private let defaults = UserDefaults.standard
    private lazy var groupSuite: String? = AppIdentity.sharedSuite()
    private var refreshTimer: Timer?

    private var server: String
    private var quality: Quality
    private var statusToken: AnyObject?

    private let scroll = UIScrollView()
    private let stack = UIStackView()
    private let serverLabel = UILabel()
    private let changeButton = UIButton(type: .system)
    private let codeField = UITextField()
    private let nameField = UITextField()
    private lazy var qualityControl = UISegmentedControl(items: Quality.allCases.map(\.label))
    private let startButton = UIButton(type: .system)
    private let statusLabel = UILabel()
    private let diagnosticsLabel = UILabel()
    private let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 200, height: 54))

    init() {
        let configured = Bundle.main.object(forInfoDictionaryKey: "MirrorLinkServer") as? String ?? ""
        let fallback = configured.contains("$(") || configured.isEmpty ? "https://mirror.example.com" : configured
        let saved = UserDefaults.standard
        server = PairingLinks.normalizeServer(saved.string(forKey: "server") ?? "") ?? fallback
        quality = Quality.from(key: saved.string(forKey: "quality"))
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    // MARK: - lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        buildUI()
        showServer()
        reflectBroadcast()
        NotificationCenter.default.addObserver(self, selector: #selector(captureChanged), name: UIScreen.capturedDidChangeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(captureChanged), name: UIApplication.didBecomeActiveNotification, object: nil)
        statusToken = DarwinNotifier.observe(DarwinNotifier.statusChanged) { [weak self] in self?.reflectBroadcast() }
        LocalNetworkPermission.requestOnce()
        syncForm()
        // The extension ignores a request older than ten minutes, so keep it fresh while this screen is open.
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.syncForm(refreshOnly: true) }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // Apple's picker keeps a small button inside; stretch it so a tap anywhere on "Start mirroring" reaches it.
        picker.subviews.compactMap { $0 as? UIButton }.first?.frame = picker.bounds
    }

    // MARK: - links

    /// Fills the form from a pairing link (the receiver's QR code or the web page's "open the app" button).
    func applyLink(_ text: String) {
        loadViewIfNeeded()
        guard let link = PairingLinks.parse(text) else {
            show("That link is not a MirrorLink pairing link.", problem: true)
            return
        }
        server = link.server
        defaults.set(link.server, forKey: "server")
        showServer()
        codeField.text = formatCode(link.code)
        syncForm()
        show("Ready. Tap Start mirroring.")
    }

    // MARK: - actions

    @objc private func startTapped() {
        view.endEditing(true)
        syncForm()
        if let problem = currentConfig().problem {
            show(problem, problem: true)
        } else if groupSuite == nil {
            show("This copy of the app cannot share settings with its broadcast part.\n\n" + AppIdentity.describe(), problem: true)
        } else {
            show("Tap Start mirroring once more, then Start Broadcast.")
        }
    }

    /// The form as the broadcast extension needs it, or what is missing.
    private func currentConfig() -> (config: BroadcastConfig?, problem: String?) {
        let code = PairingLinks.normalizeCode(codeField.text ?? "")
        guard code.count == 6 else { return (nil, "Enter the 6-digit code shown on the receiving screen.") }
        guard let origin = PairingLinks.normalizeServer(server) else { return (nil, "The server address is not valid. Tap Change to fix it.") }
        let typedName = (nameField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let name = typedName.isEmpty ? UIDevice.current.name : typedName
        return (BroadcastConfig(server: origin, code: code, deviceName: name, quality: quality, requestedAt: Date().timeIntervalSince1970), nil)
    }

    /// Saves the form where the extension can read it, and lets the real Start button (Apple's picker, laid over
    /// ours) be pressed only when the form is complete.
    private func syncForm(refreshOnly: Bool = false) {
        guard isViewLoaded else { return }
        // While a broadcast is running its code is already used; do not put a fresh copy back for the next one.
        if refreshOnly && UIScreen.main.isCaptured { return }
        guard let config = currentConfig().config, let suite = groupSuite,
              SharedStore.save(config, suite: suite, resetStatus: !refreshOnly)
        else {
            picker.isUserInteractionEnabled = false
            return
        }
        defaults.set(config.deviceName, forKey: "deviceName")
        defaults.set(config.quality.rawValue, forKey: "quality")
        picker.isUserInteractionEnabled = true
    }

    @objc private func changeServerTapped() {
        let alert = UIAlertController(title: "Server", message: "Address of your MirrorLink server, for example https://mirror.example.com", preferredStyle: .alert)
        alert.addTextField { field in
            field.text = self.server
            field.keyboardType = .URL
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Save", style: .default) { [weak self, weak alert] _ in
            guard let self = self else { return }
            let typed = alert?.textFields?.first?.text ?? ""
            if let origin = PairingLinks.normalizeServer(typed) {
                self.server = origin
                self.defaults.set(origin, forKey: "server")
                self.showServer()
                self.syncForm()
            } else {
                self.show("That is not a valid server address.", problem: true)
            }
        })
        present(alert, animated: true)
    }

    @objc private func qualityChanged() {
        quality = Quality.allCases[qualityControl.selectedSegmentIndex]
        defaults.set(quality.rawValue, forKey: "quality")
        syncForm()
    }

    @objc private func codeEdited() {
        let digits = String(PairingLinks.normalizeCode(codeField.text ?? "").prefix(6))
        codeField.text = formatCode(digits)
        syncForm()
    }

    @objc private func nameEdited() { syncForm() }

    @objc private func captureChanged() { reflectBroadcast() }

    @objc private func dismissKeyboard() { view.endEditing(true) }

    // MARK: - status

    private func reflectBroadcast() {
        guard isViewLoaded else { return }
        let status = groupSuite.flatMap { SharedStore.readStatus(suite: $0) }
        let recent = status.map { Date().timeIntervalSince1970 - $0.updatedAt < 6 * 3600 } ?? false
        if let status = status, recent {
            switch status.phase {
            case .connecting:
                show(status.message ?? "Connecting…")
            case .waitingApproval:
                show("Waiting for the receiving screen to approve. Look at it and tap Allow.")
            case .live:
                if UIScreen.main.isCaptured {
                    show("Mirroring. Your screen is visible on the receiver. To stop, open Control Center and tap the red record button, or tap Start mirroring and then Stop Broadcast.")
                } else {
                    show("Ready.")
                }
            case .ended:
                show(status.message ?? "Stopped sharing.", problem: status.isProblem)
            }
        } else if UIScreen.main.isCaptured {
            show("Your screen is being recorded or broadcast.")
        }
    }

    private func showServer() {
        serverLabel.text = "Server: " + (URL(string: server)?.host ?? server)
    }

    private func show(_ text: String, problem: Bool = false) {
        statusLabel.text = text
        statusLabel.textColor = problem ? .systemRed : .secondaryLabel
    }

    private func formatCode(_ digits: String) -> String {
        digits.count > 3 ? "\(digits.prefix(3)) \(digits.dropFirst(3))" : digits
    }

    // MARK: - layout

    private func buildUI() {
        let title = UILabel()
        title.text = "Share your screen"
        title.font = .systemFont(ofSize: 30, weight: .bold)
        title.adjustsFontForContentSizeCategory = true
        title.accessibilityTraits = .header

        let subtitle = UILabel()
        subtitle.text = "Enter the code shown on the receiving screen, then tap Start."
        subtitle.font = .preferredFont(forTextStyle: .body)
        subtitle.textColor = .secondaryLabel
        subtitle.numberOfLines = 0

        serverLabel.font = .preferredFont(forTextStyle: .footnote)
        serverLabel.textColor = .secondaryLabel
        serverLabel.numberOfLines = 0
        changeButton.setTitle("Change", for: .normal)
        changeButton.addTarget(self, action: #selector(changeServerTapped), for: .touchUpInside)
        changeButton.setContentHuggingPriority(.required, for: .horizontal)
        let serverRow = UIStackView(arrangedSubviews: [serverLabel, changeButton])
        serverRow.axis = .horizontal
        serverRow.spacing = 12
        serverRow.alignment = .center

        codeField.placeholder = "123 456"
        codeField.font = .monospacedDigitSystemFont(ofSize: 34, weight: .semibold)
        codeField.textAlignment = .center
        codeField.keyboardType = .numberPad
        codeField.textContentType = .oneTimeCode
        codeField.borderStyle = .roundedRect
        codeField.delegate = self
        codeField.addTarget(self, action: #selector(codeEdited), for: .editingChanged)
        codeField.inputAccessoryView = doneToolbar()
        codeField.accessibilityLabel = "Pairing code"

        nameField.placeholder = UIDevice.current.name
        nameField.text = defaults.string(forKey: "deviceName")
        nameField.borderStyle = .roundedRect
        nameField.autocorrectionType = .no
        nameField.returnKeyType = .done
        nameField.delegate = self
        nameField.addTarget(self, action: #selector(nameEdited), for: .editingChanged)
        nameField.accessibilityLabel = "This device's name"

        qualityControl.selectedSegmentIndex = Quality.allCases.firstIndex(of: quality) ?? 0
        qualityControl.addTarget(self, action: #selector(qualityChanged), for: .valueChanged)

        var configuration = UIButton.Configuration.filled()
        configuration.title = "Start mirroring"
        configuration.cornerStyle = .large
        configuration.buttonSize = .large
        startButton.configuration = configuration
        startButton.addTarget(self, action: #selector(startTapped), for: .touchUpInside)

        statusLabel.font = .preferredFont(forTextStyle: .callout)
        statusLabel.textColor = .secondaryLabel
        statusLabel.numberOfLines = 0

        picker.preferredExtension = AppIdentity.broadcastExtensionID()
        picker.showsMicrophoneButton = false
        picker.alpha = 0.02
        picker.isAccessibilityElement = false
        picker.isUserInteractionEnabled = false // switched on by syncForm() once the form is complete
        picker.translatesAutoresizingMaskIntoConstraints = false
        startButton.addSubview(picker)

        diagnosticsLabel.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        diagnosticsLabel.textColor = .tertiaryLabel
        diagnosticsLabel.numberOfLines = 0
        diagnosticsLabel.text = AppIdentity.describe()

        stack.axis = .vertical
        stack.spacing = 14
        stack.isLayoutMarginsRelativeArrangement = true
        stack.layoutMargins = UIEdgeInsets(top: 24, left: 20, bottom: 24, right: 20)
        for item in [title, subtitle, serverRow, field("Pairing code", codeField), field("This device's name", nameField), field("Quality", qualityControl), startButton, statusLabel, diagnosticsLabel] as [UIView] {
            stack.addArrangedSubview(item)
        }

        scroll.addSubview(stack)
        view.addSubview(scroll)
        scroll.translatesAutoresizingMaskIntoConstraints = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        let widest = stack.widthAnchor.constraint(lessThanOrEqualToConstant: 560)
        let full = stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor)
        full.priority = .defaultHigh
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            stack.centerXAnchor.constraint(equalTo: scroll.frameLayoutGuide.centerXAnchor),
            widest,
            full,
            codeField.heightAnchor.constraint(equalToConstant: 60),
            nameField.heightAnchor.constraint(equalToConstant: 44),
            startButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 54),
            picker.topAnchor.constraint(equalTo: startButton.topAnchor),
            picker.bottomAnchor.constraint(equalTo: startButton.bottomAnchor),
            picker.leadingAnchor.constraint(equalTo: startButton.leadingAnchor),
            picker.trailingAnchor.constraint(equalTo: startButton.trailingAnchor),
        ])

        let tap = UITapGestureRecognizer(target: self, action: #selector(dismissKeyboard))
        tap.cancelsTouchesInView = false
        view.addGestureRecognizer(tap)
    }

    private func field(_ title: String, _ control: UIView) -> UIView {
        let label = UILabel()
        label.text = title
        label.font = .preferredFont(forTextStyle: .subheadline)
        label.textColor = .label
        let box = UIStackView(arrangedSubviews: [label, control])
        box.axis = .vertical
        box.spacing = 6
        return box
    }

    private func doneToolbar() -> UIToolbar {
        let bar = UIToolbar(frame: CGRect(x: 0, y: 0, width: 320, height: 44))
        bar.items = [
            UIBarButtonItem(barButtonSystemItem: .flexibleSpace, target: nil, action: nil),
            UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(dismissKeyboard)),
        ]
        return bar
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return true
    }
}
