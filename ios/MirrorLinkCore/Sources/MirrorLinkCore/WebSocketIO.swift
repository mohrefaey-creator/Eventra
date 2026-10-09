import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Sends and receives text frames on a `URLSessionWebSocketTask` the same way on every platform.
/// Apple's Foundation has completion-handler methods; the Linux one (used only to run the tests on a
/// server) has the async ones. Frames go out in the order `send` was called either way.
final class WebSocketIO {
    let task: URLSessionWebSocketTask

    #if os(Linux)
    private let lock = NSLock()
    private var tail: Task<Void, Never>?
    #endif

    init(task: URLSessionWebSocketTask) {
        self.task = task
    }

    func send(_ text: String) {
        #if os(Linux)
        lock.lock()
        let previous = tail
        let task = self.task
        tail = Task {
            await previous?.value
            try? await task.send(.string(text))
        }
        lock.unlock()
        #else
        task.send(.string(text)) { _ in }
        #endif
    }

    func receive(_ handler: @escaping (Result<URLSessionWebSocketTask.Message, Error>) -> Void) {
        #if os(Linux)
        let task = self.task
        Task {
            do {
                handler(.success(try await task.receive()))
            } catch {
                handler(.failure(error))
            }
        }
        #else
        task.receive(completionHandler: handler)
        #endif
    }
}
