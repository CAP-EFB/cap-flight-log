import UIKit
import Capacitor
import CoreLocation
#if canImport(ActivityKit)
import ActivityKit
#endif

/// Mission Log's own native calls, reached from app.js as `MissionLog`:
/// keeping the screen awake, the flight recorder, and the sortie's Live
/// Activity on the Lock Screen and in the Dynamic Island.
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
        CAPPluginMethod(name: "trackStatus", returnType: CAPPluginReturnPromise)
    ]

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

/// The app's web view controller, with Mission Log's own plugin registered.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(MissionLogPlugin())
    }
}
