/**
 * @file useNotifications.ts
 * @description Defines a custom React hook for managing browser notifications in the agent dashboard application. The hook subscribes to the event bus to listen for specific events such as new sessions, session errors, session completions, and subagent spawns. Based on user preferences stored in localStorage, it triggers browser notifications to keep users informed of important updates without needing to actively monitor the dashboard. The hook should be called once at the root level of the application to ensure notifications are handled globally.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { useEffect } from "react";
import i18n from "../i18n";
import { eventBus } from "../lib/eventBus";
import { dashboardToken } from "../lib/api";
import { subscribeToPush, showLocalNotification } from "../lib/push";
import type { WSMessage, Session, Agent, DashboardEvent } from "../lib/types";

const NOTIF_KEY = "agent-monitor-notifications";

/** User's browser-notification preferences, persisted to `localStorage` under
 *  {@link NOTIF_KEY} (written by the Settings page's notifications panel). */
interface NotifPrefs {
  /** Master switch; when false, no notification types fire regardless of the
   *  per-event flags below. */
  enabled: boolean;
  onNewSession: boolean;
  onSessionError: boolean;
  onSessionComplete: boolean;
  onSubagentSpawn: boolean;
  /** Fire on Claude Code `Notification` hook events — "Claude needs your
   *  permission" and "Claude is waiting for your input". Opt-in (default false):
   *  these are frequent, so nothing fires unless the user turns this on. */
  onNeedsAction: boolean;
}

/** Reads {@link NotifPrefs} from `localStorage`, merging over safe defaults so
 *  a partial/older saved object (or none at all) still yields a valid result.
 *  `enabled` defaults to false (opt-in) even in the "no saved value" branch,
 *  while individual event toggles default to a sensible starting mix. */
const DEFAULT_PREFS: NotifPrefs = {
  enabled: false,
  onNewSession: true,
  onSessionError: true,
  onSessionComplete: false,
  onSubagentSpawn: false,
  onNeedsAction: false,
};

function loadPrefs(): NotifPrefs {
  try {
    const raw = localStorage.getItem(NOTIF_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/**
 * Shows a browser notification, preferring a server-relayed push (so it can
 * arrive even if this tab isn't the active one) but falling back to a LOCAL
 * notification whenever the relay didn't actually deliver — the server was
 * unreachable, OR it responded but pushed to zero subscriptions (e.g. a central
 * server that can't reach Google's FCM, as on a mainland-China VPS). Without
 * this response check the fallback never fired, since a 200 with `pushed:0`
 * isn't a thrown error. No-ops when the user hasn't granted permission.
 * @param title Notification title.
 * @param body Notification body text.
 */
async function notify(title: string, body: string) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  let delivered = false;
  try {
    const token = dashboardToken();
    const res = await fetch("/api/push/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // /api/push/send is behind the tokenGuard; without the token the
        // server-relayed push 401s (e.g. on the tailnet/fleet deployment).
        ...(token ? { "x-dashboard-token": token } : {}),
      },
      body: JSON.stringify({ title, body }),
    });
    const data = (await res.json().catch(() => null)) as { pushed?: number } | null;
    delivered = !!(res.ok && data && (data.pushed ?? 0) > 0);
  } catch {
    delivered = false;
  }
  // Fall back to a local notification if nothing was actually pushed. (When the
  // server DID deliver, we skip this so a normal deployment doesn't double-fire.)
  if (!delivered) await showLocalNotification(title, body);
}

/**
 * Wires the dashboard's {@link eventBus} up to browser notifications, per the
 * user's saved {@link NotifPrefs}. Mount once at the app root (it has no
 * return value and no props) - it re-reads preferences from `localStorage` on
 * every incoming message, so toggling a Settings checkbox takes effect
 * immediately without remounting. Also opportunistically (re-)subscribes to
 * Web Push on mount when notifications are enabled and permission has
 * already been granted, so push delivery survives a page reload.
 */
export function useNotifications() {
  useEffect(() => {
    const prefs = loadPrefs();
    if (prefs.enabled && "Notification" in window && Notification.permission === "granted") {
      subscribeToPush().catch(() => {});
    }

    return eventBus.subscribe((msg: WSMessage) => {
      const prefs = loadPrefs();
      if (!prefs.enabled) return;

      switch (msg.type) {
        case "session_created": {
          if (!prefs.onNewSession) return;
          const s = msg.data as Session;
          notify(
            i18n.t("errors:notifications.newSession"),
            s.name || `${i18n.t("errors:notifications.sessionDefault")}${s.id.slice(0, 8)}`
          );
          break;
        }
        case "session_updated": {
          const s = msg.data as Session;
          if (s.status === "error" && prefs.onSessionError) {
            notify(
              i18n.t("errors:notifications.sessionError"),
              s.name || `${i18n.t("errors:notifications.sessionDefault")}${s.id.slice(0, 8)}`
            );
          }
          break;
        }
        case "agent_created": {
          if (!prefs.onSubagentSpawn) return;
          const a = msg.data as Agent;
          if (a.type === "subagent") {
            notify(i18n.t("errors:notifications.subagentSpawned"), a.name);
          }
          break;
        }
        case "new_event": {
          const ev = msg.data as DashboardEvent;
          if (ev.event_type === "Stop" && prefs.onSessionComplete) {
            notify(
              i18n.t("errors:notifications.finishedResponding"),
              ev.summary || i18n.t("errors:notifications.readyForInput")
            );
          } else if (ev.event_type === "SessionEnd" && prefs.onSessionComplete) {
            notify(
              i18n.t("errors:notifications.sessionCompleted"),
              ev.summary || i18n.t("errors:notifications.sessionClosed")
            );
          } else if (
            ev.event_type === "Notification" &&
            ev.awaiting_reason === "action" &&
            prefs.onNeedsAction
          ) {
            // Only the true needs-action case (等待中: permission / needs-input).
            // Idle "waiting for input" notices (awaiting_reason "idle") and
            // non-waiting notifications (null) are intentionally NOT notified.
            notify(
              i18n.t("errors:notifications.defaultTitle"),
              ev.summary || i18n.t("errors:notifications.defaultBody")
            );
          }
          break;
        }
      }
    });
  }, []);
}
