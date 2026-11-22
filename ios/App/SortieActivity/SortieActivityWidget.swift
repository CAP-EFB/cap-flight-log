import ActivityKit
import SwiftUI
import WidgetKit

/// The sortie on the Lock Screen (and in the Dynamic Island on an iPhone):
/// phase, time since wheels up, next OPS check and the current CAP grid.
/// Started, updated and ended by MissionLogPlugin in the app.
@main
struct SortieActivityBundle: WidgetBundle {
    var body: some Widget {
        SortieActivityWidget()
    }
}

// CAP Ultramarine Blue and Air Force Yellow
private let navy = Color(red: 0 / 255, green: 20 / 255, blue: 137 / 255)
private let amber = Color(red: 1, green: 205 / 255, blue: 0)

struct SortieActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SortieActivityAttributes.self) { context in
            SortieLockScreenView(context: context)
                .activityBackgroundTint(navy)
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label(context.state.phase, systemImage: "airplane")
                        .font(.caption.weight(.semibold))
                }
                DynamicIslandExpandedRegion(.trailing) {
                    AirborneTimer(since: context.state.airborneSince)
                        .font(.caption.monospacedDigit())
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack {
                        NextOpsView(due: context.state.nextOpsDue)
                        Spacer()
                        Text(context.state.grid).font(.caption.monospaced())
                    }
                }
            } compactLeading: {
                Image(systemName: "airplane")
            } compactTrailing: {
                AirborneTimer(since: context.state.airborneSince)
                    .font(.caption2.monospacedDigit())
                    .frame(maxWidth: 48)
            } minimal: {
                Image(systemName: "airplane")
            }
        }
    }
}

struct SortieLockScreenView: View {
    let context: ActivityViewContext<SortieActivityAttributes>

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "airplane")
                Text([context.attributes.mission, context.attributes.sortie, context.attributes.callsign]
                    .filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Spacer()
                Text(context.state.phase)
                    .font(.caption.weight(.bold))
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Capsule().fill(.white.opacity(0.15)))
            }
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("AIRBORNE").font(.caption2.weight(.bold)).foregroundStyle(.white.opacity(0.6))
                    AirborneTimer(since: context.state.airborneSince)
                        .font(.title2.weight(.semibold).monospacedDigit())
                }
                Spacer()
                VStack(alignment: .leading, spacing: 2) {
                    Text("NEXT OPS CHECK").font(.caption2.weight(.bold)).foregroundStyle(.white.opacity(0.6))
                    NextOpsView(due: context.state.nextOpsDue).font(.title3.weight(.semibold))
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text("GRID").font(.caption2.weight(.bold)).foregroundStyle(.white.opacity(0.6))
                    Text(context.state.grid.isEmpty ? "—" : context.state.grid)
                        .font(.title3.weight(.semibold).monospaced())
                }
            }
        }
        .foregroundStyle(.white)
        .padding(16)
    }
}

/// Counts up from wheels up; a dash before take-off.
struct AirborneTimer: View {
    let since: Date?
    var body: some View {
        if let since {
            Text(timerInterval: since...Date.distantFuture, countsDown: false)
        } else {
            Text("—")
        }
    }
}

/// Counts down to the next OPS check, in amber once it is due.
struct NextOpsView: View {
    let due: Date?
    var body: some View {
        if let due {
            if due > Date() {
                Text(timerInterval: Date()...due, countsDown: true)
                    .monospacedDigit()
            } else {
                Text("Due now").foregroundStyle(amber)
            }
        } else {
            Text("—")
        }
    }
}
