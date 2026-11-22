import UIKit
import Capacitor
#if canImport(ActivityKit)
import ActivityKit
#endif

/// Mission Log's own native calls, reached from app.js as `MissionLog`:
/// keeping the screen awake, and the sortie's Live Activity on the Lock Screen
/// and in the Dynamic Island.
@objc(MissionLogPlugin)
public class MissionLogPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MissionLogPlugin"
    public let jsName = "MissionLog"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setKeepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateSortieActivity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endSortieActivity", returnType: CAPPluginReturnPromise)
    ]

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

/// The app's web view controller, with Mission Log's own plugin registered.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(MissionLogPlugin())
    }
}
