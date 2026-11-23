import UIKit
import Capacitor
import CoreLocation
import PencilKit
#if canImport(ActivityKit)
import ActivityKit
#endif

/// Mission Log's own native calls, reached from app.js as `MissionLog`:
/// keeping the screen awake, the flight recorder, the sortie's Live
/// Activity on the Lock Screen and in the Dynamic Island, and the PencilKit
/// sketch pad.
@objc(MissionLogPlugin)
public class MissionLogPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MissionLogPlugin"
    public let jsName = "MissionLog"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setKeepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateSortieActivity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endSortieActivity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startTrack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopTrack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readTrack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "trackStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sketchShow", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sketchFrame", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sketchVisible", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sketchBackground", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sketchHide", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sketchUndo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sketchRedo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sketchClear", returnType: CAPPluginReturnPromise)
    ]

    // MARK: sketch pad (PencilKit)

    private func rect(_ call: CAPPluginCall) -> CGRect {
        CGRect(x: call.getDouble("x") ?? 0, y: call.getDouble("y") ?? 0,
               width: call.getDouble("width") ?? 0, height: call.getDouble("height") ?? 0)
    }

    /// Puts the PencilKit canvas over the page's place in the web view, with
    /// the page's background under the strokes and Apple's tool palette.
    /// The same page again only moves it; another page loads that drawing.
    @objc func sketchShow(_ call: CAPPluginCall) {
        let frame = rect(call)
        let pageId = call.getString("pageId") ?? ""
        let drawing = call.getString("drawing") ?? ""
        let background = call.getString("background") ?? ""
        let size = CGSize(width: call.getDouble("pageWidth") ?? 1000, height: call.getDouble("pageHeight") ?? 1250)
        // a map page: the canvas is the map's region, panned and zoomed like the map
        var map: SketchPad.MapView? = nil
        if call.getString("mode") == "map" {
            map = SketchPad.MapView(
                scale: CGFloat(call.getDouble("scale") ?? 1),
                offset: CGPoint(x: call.getDouble("offsetX") ?? 0, y: call.getDouble("offsetY") ?? 0),
                minScale: CGFloat(call.getDouble("minScale") ?? 0.05),
                maxScale: CGFloat(call.getDouble("maxScale") ?? 8))
        }
        DispatchQueue.main.async {
            guard let host = self.bridge?.webView else { call.reject("no web view"); return }
            SketchPad.shared.plugin = self
            SketchPad.shared.show(in: host, frame: frame, pageId: pageId, size: size, drawing: drawing, background: background, map: map)
            call.resolve()
        }
    }

    @objc func sketchFrame(_ call: CAPPluginCall) {
        let frame = rect(call)
        DispatchQueue.main.async { SketchPad.shared.setFrame(frame); call.resolve() }
    }

    /// Hides the canvas for a moment (a sheet over it) without leaving the page.
    @objc func sketchVisible(_ call: CAPPluginCall) {
        let visible = call.getBool("visible") ?? true
        DispatchQueue.main.async { SketchPad.shared.setVisible(visible); call.resolve() }
    }

    @objc func sketchBackground(_ call: CAPPluginCall) {
        let background = call.getString("background") ?? ""
        DispatchQueue.main.async { SketchPad.shared.setBackground(background); call.resolve() }
    }

    /// Leaving the sketch pad: the last strokes are sent, then the canvas goes.
    @objc func sketchHide(_ call: CAPPluginCall) {
        DispatchQueue.main.async { SketchPad.shared.hide(); call.resolve() }
    }

    @objc func sketchUndo(_ call: CAPPluginCall) {
        DispatchQueue.main.async { SketchPad.shared.undo(); call.resolve() }
    }

    @objc func sketchRedo(_ call: CAPPluginCall) {
        DispatchQueue.main.async { SketchPad.shared.redo(); call.resolve() }
    }

    @objc func sketchClear(_ call: CAPPluginCall) {
        DispatchQueue.main.async { SketchPad.shared.clear(); call.resolve() }
    }

    /// A page's strokes changed: its PencilKit drawing (to edit again) and its
    /// ink as a transparent PNG the page's size (for the PDF and printout).
    func sketchChanged(pageId: String, drawing: String, ink: String, viewport: [String: Any]? = nil) {
        var data: [String: Any] = ["pageId": pageId, "drawing": drawing, "ink": ink]
        if let viewport = viewport { data["viewport"] = viewport; data["mode"] = "map" }
        notifyListeners("sketchChanged", data: data)
    }

    /// A map page moved: where the canvas is now, for the map under it to follow.
    func sketchViewport(_ viewport: [String: Any]) {
        notifyListeners("sketchViewport", data: viewport)
    }

    // MARK: flight recorder

    /// Starts recording the flight track for one sortie; keeps going in the
    /// background (with the blue location indicator) until stopTrack.
    @objc func startTrack(_ call: CAPPluginCall) {
        guard let sortieId = call.getString("sortieId"), !sortieId.isEmpty else {
            call.reject("sortieId is required")
            return
        }
        DispatchQueue.main.async {
            TrackRecorder.shared.start(sortieId: sortieId)
            call.resolve(["recording": true, "sortieId": sortieId])
        }
    }

    @objc func stopTrack(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            TrackRecorder.shared.stop()
            call.resolve()
        }
    }

    /// The recorded points for a sortie: [time ms, lat, lon, altitude m, accuracy m, speed m/s, course °].
    @objc func readTrack(_ call: CAPPluginCall) {
        let sortieId = call.getString("sortieId") ?? ""
        // the recorder owns a CLLocationManager, which belongs on the main thread
        DispatchQueue.main.async {
            call.resolve(["points": TrackRecorder.shared.read(sortieId: sortieId)])
        }
    }

    @objc func trackStatus(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["sortieId": TrackRecorder.shared.activeSortieId ?? ""])
        }
    }

    /// Stops the iPad dimming and locking while Mission Log is on screen.
    @objc func setKeepAwake(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = enabled
            call.resolve()
        }
    }

    /// Starts the sortie's Live Activity, or updates it if one is running.
    /// Times arrive from JavaScript as milliseconds since 1970 (0 = none).
    @objc func updateSortieActivity(_ call: CAPPluginCall) {
        #if canImport(ActivityKit)
        if #available(iOS 16.2, *) {
            guard ActivityAuthorizationInfo().areActivitiesEnabled else {
                call.resolve(["running": false, "reason": "Live Activities are turned off for Mission Log"])
                return
            }
            let date: (String) -> Date? = { key in
                guard let ms = call.getDouble(key), ms > 0 else { return nil }
                return Date(timeIntervalSince1970: ms / 1000)
            }
            let state = SortieActivityAttributes.ContentState(
                phase: call.getString("phase") ?? "",
                airborneSince: date("airborneSince"),
                nextOpsDue: date("nextOpsDue"),
                grid: call.getString("grid") ?? ""
            )
            let content = ActivityContent(state: state, staleDate: nil)
            Task {
                if let running = Activity<SortieActivityAttributes>.activities.first {
                    await running.update(content)
                    call.resolve(["running": true])
                    return
                }
                do {
                    let attributes = SortieActivityAttributes(
                        mission: call.getString("mission") ?? "",
                        sortie: call.getString("sortie") ?? "",
                        callsign: call.getString("callsign") ?? ""
                    )
                    _ = try Activity.request(attributes: attributes, content: content)
                    call.resolve(["running": true])
                } catch {
                    call.resolve(["running": false, "reason": error.localizedDescription])
                }
            }
            return
        }
        #endif
        call.resolve(["running": false, "reason": "Needs iPadOS 16.2 or later"])
    }

    /// Ends the Live Activity at Shut Down, or when the sortie is left.
    @objc func endSortieActivity(_ call: CAPPluginCall) {
        #if canImport(ActivityKit)
        if #available(iOS 16.2, *) {
            Task {
                for activity in Activity<SortieActivityAttributes>.activities {
                    await activity.end(nil, dismissalPolicy: .immediate)
                }
                call.resolve()
            }
            return
        }
        #endif
        call.resolve()
    }
}

/// Records the aircraft's track to a file per sortie, one JSON array per line,
/// so nothing is lost if the app is closed mid-flight. A point is kept every
/// 5 seconds at most, and only when the fix is better than 200 m.
final class TrackRecorder: NSObject, CLLocationManagerDelegate {
    static let shared = TrackRecorder()
    private let manager = CLLocationManager()
    private var lastKept: Date?
    private let activeKey = "missionlog.track.activeSortieId"

    var activeSortieId: String? {
        get { UserDefaults.standard.string(forKey: activeKey) }
        set { UserDefaults.standard.set(newValue, forKey: activeKey) }
    }

    private override init() {
        super.init()
        manager.delegate = self
        manager.activityType = .airborne
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = 50
        manager.pausesLocationUpdatesAutomatically = false
    }

    func start(sortieId: String) {
        activeSortieId = sortieId
        lastKept = nil
        if manager.authorizationStatus == .notDetermined {
            manager.requestWhenInUseAuthorization()
        }
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
        manager.startUpdatingLocation()
    }

    func stop() {
        manager.stopUpdatingLocation()
        manager.allowsBackgroundLocationUpdates = false
        activeSortieId = nil
    }

    private func fileURL(_ sortieId: String) -> URL? {
        let safe = sortieId.filter { $0.isLetter || $0.isNumber || $0 == "-" }
        guard !safe.isEmpty,
              let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        let dir = base.appendingPathComponent("tracks", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("track-\(safe).jsonl")
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let sortieId = activeSortieId, let url = fileURL(sortieId) else { return }
        var lines = ""
        for loc in locations where loc.horizontalAccuracy >= 0 && loc.horizontalAccuracy <= 200 {
            if let last = lastKept, loc.timestamp.timeIntervalSince(last) < 5 { continue }
            lastKept = loc.timestamp
            let point: [Double] = [
                (loc.timestamp.timeIntervalSince1970 * 1000).rounded(),
                loc.coordinate.latitude, loc.coordinate.longitude,
                loc.verticalAccuracy >= 0 ? loc.altitude : -9999,
                loc.horizontalAccuracy,
                loc.speed >= 0 ? loc.speed : -1,
                loc.course >= 0 ? loc.course : -1
            ]
            if let data = try? JSONSerialization.data(withJSONObject: point),
               let text = String(data: data, encoding: .utf8) {
                lines += text + "\n"
            }
        }
        guard !lines.isEmpty, let data = lines.data(using: .utf8) else { return }
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: url)
        }
    }

    func read(sortieId: String) -> [[Double]] {
        guard let url = fileURL(sortieId), let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return text.split(separator: "\n").compactMap { line in
            (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [Double]
        }
    }
}

/// The sketch pad as PencilKit: a canvas the size of the page (1000 points
/// wide, as tall as the screen's shape made it; zoomed to fit its place on
/// screen and pinch-zoomable up to five times), the page's background in an image view under the strokes, and
/// Apple's tool picker. Whether a finger draws follows the iPad's own
/// "Only Draw with Apple Pencil" setting.
///
/// On a map page the canvas is the map's region instead (Web Mercator pixels
/// at one zoom), transparent, over the web map: its pan and zoom are the
/// map's, reported on every frame so the map follows, and the ink sent back
/// is the part on screen.
final class SketchPad: NSObject, PKCanvasViewDelegate {
    struct MapView {
        var scale: CGFloat
        var offset: CGPoint
        var minScale: CGFloat
        var maxScale: CGFloat
    }
    private var map: MapView?
    static let shared = SketchPad()
    weak var plugin: MissionLogPlugin?
    private var canvas: PKCanvasView?
    private let underlay = UIImageView()
    private var toolPicker: AnyObject?   // PKToolPicker, iPadOS 14+
    private var pageId = ""
    private var page = CGSize(width: 1000, height: 1250)
    private var pending: DispatchWorkItem?
    private var loading = false
    private var fitted = false   // zoomed to fit at least once since this page opened

    private func makeCanvas(in host: UIView) -> PKCanvasView {
        let view = PKCanvasView(frame: .zero)
        view.delegate = self
        view.backgroundColor = .clear
        view.isOpaque = false
        view.contentInsetAdjustmentBehavior = .never
        view.showsHorizontalScrollIndicator = false
        view.showsVerticalScrollIndicator = false
        view.bouncesZoom = true
        // paper and charts are light: ink keeps its true colours in dark mode
        view.overrideUserInterfaceStyle = .light
        view.layer.cornerRadius = 0
        view.clipsToBounds = true
        if #available(iOS 14.0, *) { view.drawingPolicy = .default }
        view.tool = PKInkingTool(.pen, color: UIColor(red: 0.09, green: 0.13, blue: 0.18, alpha: 1), width: 4)
        underlay.contentMode = .scaleToFill
        underlay.backgroundColor = .white
        view.insertSubview(underlay, at: 0)
        host.addSubview(view)
        if #available(iOS 14.0, *) {
            let picker = PKToolPicker()
            picker.addObserver(view)
            picker.setVisible(true, forFirstResponder: view)
            toolPicker = picker
        }
        canvas = view
        return view
    }

    func show(in host: UIView, frame: CGRect, pageId: String, size: CGSize, drawing: String, background: String, map: MapView? = nil) {
        let view = canvas ?? makeCanvas(in: host)
        if view.superview !== host { host.addSubview(view) }
        let opening = pageId != self.pageId || size != page
        if opening {
            flush()
            self.pageId = pageId
            page = size
            loading = true
            if let data = Data(base64Encoded: drawing), let loaded = try? PKDrawing(data: data) {
                view.drawing = loaded
            } else {
                view.drawing = PKDrawing()
            }
            view.undoManager?.removeAllActions()
            loading = false
            fitted = false
        }
        self.map = map
        underlay.isHidden = map != nil   // the web map shows through
        if map == nil { setBackground(background) }
        if let map = map, opening {
            view.frame = frame
            view.minimumZoomScale = map.minScale
            view.maximumZoomScale = map.maxScale
            view.zoomScale = map.scale
            layoutUnderlay()
            view.contentOffset = map.offset
            fitted = true
        } else {
            setFrame(frame)
        }
        setVisible(true)
        reportViewport()
    }

    func setFrame(_ frame: CGRect) {
        guard let view = canvas, frame.width > 0, frame.height > 0 else { return }
        if map != nil {
            // a map page keeps its place; only the window onto it changes
            view.frame = frame
            reportViewport()
            return
        }
        let fit = frame.width / page.width
        // keep how far in the crew had zoomed when the page moves or resizes
        let zoom = fitted ? view.zoomScale / max(view.minimumZoomScale, 0.0001) : 1
        view.frame = frame
        view.minimumZoomScale = fit
        view.maximumZoomScale = fit * 5
        view.zoomScale = min(fit * 5, max(fit, fit * zoom))
        fitted = true
        layoutUnderlay()
    }

    func setBackground(_ dataURL: String) {
        guard !dataURL.isEmpty else { return }
        let base64 = dataURL.components(separatedBy: ",").last ?? ""
        if let data = Data(base64Encoded: base64), let image = UIImage(data: data) {
            underlay.image = image
        }
    }

    func setVisible(_ visible: Bool) {
        guard let view = canvas else { return }
        view.isHidden = !visible
        if visible { view.becomeFirstResponder() } else { view.resignFirstResponder() }
        if #available(iOS 14.0, *), let picker = toolPicker as? PKToolPicker {
            picker.setVisible(visible, forFirstResponder: view)
        }
    }

    func hide() {
        flush()
        setVisible(false)
        canvas?.removeFromSuperview()
        pageId = ""
        map = nil
    }

    func undo() { canvas?.undoManager?.undo() }
    func redo() { canvas?.undoManager?.redo() }
    func clear() { canvas?.drawing = PKDrawing() }

    /// The page's size on screen at this zoom: the scroll area, and the background under the strokes.
    private func layoutUnderlay() {
        guard let view = canvas else { return }
        let size = CGSize(width: page.width * view.zoomScale, height: page.height * view.zoomScale)
        view.contentSize = size
        underlay.frame = CGRect(origin: .zero, size: size)
        view.sendSubviewToBack(underlay)
    }

    // the background follows the strokes as they zoom and scroll
    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        layoutUnderlay()
        reportViewport()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) { reportViewport() }

    // a map page's picture is the view on screen: send it once the map settles
    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { settled() }
    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) { if !decelerate { settled() } }
    func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) { settled() }

    private func settled() {
        guard map != nil else { return }
        schedule(after: 0.8)
    }

    private func viewport() -> [String: Any]? {
        guard let view = canvas, map != nil else { return nil }
        return ["pageId": pageId, "x": Double(view.contentOffset.x), "y": Double(view.contentOffset.y),
                "scale": Double(view.zoomScale), "width": Double(view.bounds.width), "height": Double(view.bounds.height)]
    }

    private func reportViewport() {
        if let v = viewport() { plugin?.sketchViewport(v) }
    }

    func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        guard !loading else { return }
        schedule(after: 0.6)
    }

    private func schedule(after seconds: Double) {
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.send() }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    private func flush() {
        guard let work = pending else { return }
        work.cancel()
        pending = nil
        send()
    }

    private func send() {
        pending = nil
        guard let view = canvas, !pageId.isEmpty else { return }
        let drawing = view.drawing
        var image = UIImage()
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        if map != nil {
            // the ink on screen, at screen size, with where the screen is
            let z = max(view.zoomScale, 0.0001)
            let visible = CGRect(x: view.contentOffset.x / z, y: view.contentOffset.y / z,
                                 width: view.bounds.width / z, height: view.bounds.height / z)
            UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
                image = UIGraphicsImageRenderer(size: view.bounds.size, format: format).image { _ in
                    drawing.image(from: visible, scale: z).draw(in: CGRect(origin: .zero, size: view.bounds.size))
                }
            }
            let ink = drawing.strokes.isEmpty ? "" : "data:image/png;base64," + (image.pngData()?.base64EncodedString() ?? "")
            plugin?.sketchChanged(pageId: pageId, drawing: drawing.strokes.isEmpty ? "" : drawing.dataRepresentation().base64EncodedString(),
                                  ink: ink, viewport: viewport())
            return
        }
        // rendered in light mode, so black ink stays black in the PDF
        UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
            image = UIGraphicsImageRenderer(size: page, format: format).image { _ in
                drawing.image(from: CGRect(origin: .zero, size: page), scale: 1).draw(in: CGRect(origin: .zero, size: page))
            }
        }
        let ink = drawing.strokes.isEmpty ? "" : "data:image/png;base64," + (image.pngData()?.base64EncodedString() ?? "")
        plugin?.sketchChanged(pageId: pageId, drawing: drawing.strokes.isEmpty ? "" : drawing.dataRepresentation().base64EncodedString(), ink: ink)
    }
}

/// The app's web view controller, with Mission Log's own plugin registered.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(MissionLogPlugin())
    }
}
