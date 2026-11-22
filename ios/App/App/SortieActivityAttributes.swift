import Foundation
#if canImport(ActivityKit)
import ActivityKit

/// What the Lock Screen and Dynamic Island show about the sortie in progress.
/// This file belongs to both the app and the SortieActivity widget extension:
/// the app starts and updates the activity, the extension draws it.
@available(iOS 16.1, *)
public struct SortieActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// "Engine running", "Airborne", "In search area", "Returning"
        public var phase: String
        /// Wheels up, for the airborne timer; nil before take-off.
        public var airborneSince: Date?
        /// When the next OPS check is due; nil when none is scheduled.
        public var nextOpsDue: Date?
        /// Current CAP grid, e.g. "NYC 216 D", or "" with no GPS fix.
        public var grid: String

        public init(phase: String, airborneSince: Date?, nextOpsDue: Date?, grid: String) {
            self.phase = phase
            self.airborneSince = airborneSince
            self.nextOpsDue = nextOpsDue
            self.grid = grid
        }
    }

    public var mission: String
    public var sortie: String
    public var callsign: String

    public init(mission: String, sortie: String, callsign: String) {
        self.mission = mission
        self.sortie = sortie
        self.callsign = callsign
    }
}
#endif
