/**
 * @file StatusBadge.tsx
 * @description Defines reusable React components for displaying the status of agents and sessions in a visually distinct way using badges. The AgentStatusBadge component shows the current status of an agent with an optional pulsing effect for active states, while the SessionStatusBadge component indicates the status of a session. Both components utilize predefined configurations for consistent styling across the application.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { useTranslation } from "react-i18next";
import { STATUS_CONFIG, SESSION_STATUS_CONFIG } from "../lib/types";
import type { EffectiveAgentStatus, EffectiveSessionStatus } from "../lib/types";

// fleet-monitor: split the single "waiting" badge into two urgencies via the
// awaiting_reason. "action" (blocked, needs you now) → red + pulse + a distinct
// "Needs You" label; "idle" (turn-end wait) → muted gray, quiet. A null reason
// (legacy rows) falls through to idle styling so we never over-alert.
type AwaitReason = "action" | "idle" | null | undefined;
function waitingStyle(reason: AwaitReason) {
  if (reason === "action") {
    return {
      bg: "bg-red-500/15",
      color: "text-red-400",
      dot: "bg-red-400",
      pulse: true,
      labelKey: "common:status.needsAction",
    };
  }
  return {
    bg: "bg-gray-500/10",
    color: "text-gray-400",
    dot: "bg-gray-400",
    pulse: false,
    labelKey: "common:status.waiting",
  };
}

interface AgentStatusBadgeProps {
  status: EffectiveAgentStatus;
  reason?: AwaitReason;
  pulse?: boolean;
}

export function AgentStatusBadge({ status, reason, pulse }: AgentStatusBadgeProps) {
  const { t } = useTranslation();
  const base = STATUS_CONFIG[status];
  const w = status === "waiting" ? waitingStyle(reason) : null;
  const bg = w ? w.bg : base.bg;
  const color = w ? w.color : base.color;
  const dot = w ? w.dot : base.dot;
  const labelKey = w ? w.labelKey : base.labelKey;
  const shouldPulse = pulse ?? (status === "working" || (w ? w.pulse : false));

  return (
    <span className={`badge ${bg} ${color}`}>
      <span
        className={`w-1.5 h-1.5 rounded-full ${dot} ${shouldPulse ? "animate-pulse-dot" : ""}`}
      />
      {t(labelKey)}
    </span>
  );
}

interface SessionStatusBadgeProps {
  status: EffectiveSessionStatus;
  reason?: AwaitReason;
  pulse?: boolean;
}

export function SessionStatusBadge({ status, reason, pulse }: SessionStatusBadgeProps) {
  const { t } = useTranslation();
  const base = SESSION_STATUS_CONFIG[status];
  const w = status === "waiting" ? waitingStyle(reason) : null;
  const bg = w ? w.bg : base.bg;
  const color = w ? w.color : base.color;
  const dot = w ? w.dot : base.dot;
  const labelKey = w ? w.labelKey : base.labelKey;
  const shouldPulse = pulse ?? (w ? w.pulse : false);
  return (
    <span className={`badge ${bg} ${color}`}>
      {shouldPulse && (
        <span className={`w-1.5 h-1.5 rounded-full ${dot} animate-pulse-dot`} aria-hidden="true" />
      )}
      {t(labelKey)}
    </span>
  );
}
