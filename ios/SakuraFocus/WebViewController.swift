import UIKit
import WebKit

/// Serves the bundled web build under the `sakura://app/` origin so the app
/// works fully offline: absolute paths (`/assets/...`), ES modules, and
/// localStorage all behave exactly like the hosted site.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL

    init(root: URL) {
        self.root = root
    }

    func webView(_: WKWebView, start task: WKURLSchemeTask) {
        guard let requestURL = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }

        var path = requestURL.path
        if path.isEmpty || path == "/" { path = "/index.html" }

        let fileURL = root.appendingPathComponent(String(path.dropFirst()))
        guard let data = try? Data(contentsOf: fileURL) else {
            // SPA fallback: unknown paths serve the app shell.
            if let indexData = try? Data(
                contentsOf: root.appendingPathComponent("index.html")
            ) {
                task.didReceive(Self.response(url: requestURL, pathExtension: "html", length: indexData.count))
                task.didReceive(indexData)
            } else {
                task.didFailWithError(URLError(.fileDoesNotExist))
                return
            }
            task.didFinish()
            return
        }

        task.didReceive(
            Self.response(url: requestURL, pathExtension: fileURL.pathExtension, length: data.count)
        )
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_: WKWebView, stop _: WKURLSchemeTask) {}

    private static func response(url: URL, pathExtension: String, length: Int) -> HTTPURLResponse {
        HTTPURLResponse(
            url: url,
            mimeType: mimeType(for: pathExtension),
            expectedContentLength: length,
            textEncodingName: nil
        )!
    }

    private static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html"
        case "js", "mjs": return "text/javascript"
        case "css": return "text/css"
        case "json", "webmanifest", "map": return "application/json"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "svg": return "image/svg+xml"
        case "ico": return "image/x-icon"
        case "webp": return "image/webp"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "mp3": return "audio/mpeg"
        case "wav": return "audio/wav"
        case "ogg": return "audio/ogg"
        default: return "application/octet-stream"
        }
    }
}

final class WebViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()

        guard let webRoot = Bundle.main.url(forResource: "Web", withExtension: nil) else {
            fatalError("Web bundle missing — run ios/build-ipa.sh to generate it")
        }

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleSchemeHandler(root: webRoot), forURLScheme: "sakura")
        config.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.scrollView.bounces = false
        webView.isOpaque = false
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        view.addSubview(webView)

        // Match the app's cream background so the launch frame doesn't flash black.
        view.backgroundColor = UIColor(red: 1.0, green: 0.973, blue: 0.957, alpha: 1.0)

        webView.load(URLRequest(url: URL(string: "sakura://app/index.html")!))
    }

    override var prefersStatusBarHidden: Bool { false }
    override var preferredStatusBarStyle: UIStatusBarStyle { .darkContent }
}
