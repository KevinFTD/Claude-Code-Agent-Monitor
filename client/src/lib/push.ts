/**
 * @file push.ts
 * @description Provides functions for managing push notifications in the agent dashboard application. It includes utilities for subscribing and unsubscribing to push notifications using the Push API and Service Workers. The module handles the conversion of VAPID public keys, manages push subscriptions, and communicates with the backend API to register or unregister push endpoints. This allows the application to send real-time notifications to users about important events or updates.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { dashboardToken } from "./api";

/**
 * Headers for the `/api/push/*` calls. These endpoints sit behind the `/api`
 * tokenGuard, so — like every other API call (see api.ts `request`) — they must
 * carry the `x-dashboard-token` header when a DASHBOARD_TOKEN is configured
 * (e.g. the tailnet/fleet deployment). Without it the server 401s and push
 * subscription/relay silently fail. Merges any extra headers on top.
 */
function pushHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = dashboardToken();
  return {
    ...(token ? { "x-dashboard-token": token } : {}),
    ...(extra || {}),
  };
}

/**
 * Shows a notification LOCALLY in this browser — no external push service
 * involved. Prefers the service worker's `showNotification` (survives the tab
 * being backgrounded) and falls back to the `Notification` constructor. No-ops
 * unless permission is already granted.
 *
 * This is the reliable path when server-relayed Web Push can't be delivered —
 * e.g. a central server that cannot reach Google's FCM (`fcm.googleapis.com`),
 * as on a mainland-China VPS where FCM is blocked. Since a tab receiving live
 * events is open anyway, a local notification is both correct and immediate.
 * @param title Notification title.
 * @param body Notification body text.
 */
export async function showLocalNotification(title: string, body: string): Promise<void> {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification(title, { body, icon: "/favicon.ico", silent: false });
    } else {
      new Notification(title, { body, icon: "/favicon.ico" });
    }
  } catch {
    // Best effort — never throw from a notification.
  }
}

/**
 * Decodes a URL-safe base64 VAPID public key (as served by
 * GET /api/push/vapid-public-key) into the raw byte buffer the Push API's
 * `applicationServerKey` option requires.
 * @param base64String URL-safe base64 string (`-`/`_` instead of `+`/`/`,
 *   `=` padding optional - this re-pads before decoding).
 * @returns The decoded bytes as an `ArrayBuffer`.
 */
function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let index = 0; index < rawData.length; index++) {
    outputArray[index] = rawData.charCodeAt(index);
  }
  return outputArray.buffer;
}

/**
 * Subscribes the browser to Web Push notifications, if not already
 * subscribed. No-ops silently when the browser lacks Service Worker/Push API
 * support, or when a subscription already exists (idempotent - safe to call
 * on every app load / every time notifications are enabled in settings).
 * Fetches the server's VAPID public key, creates the push subscription via
 * the active service worker, then registers it with the backend so
 * `/api/push/send` can target this browser.
 */
export async function subscribeToPush(): Promise<void> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) return;

  const res = await fetch("/api/push/vapid-public-key", { headers: pushHeaders() });
  const { publicKey } = await res.json();

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: pushHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(subscription.toJSON()),
  });
}

/**
 * Unsubscribes the browser from Web Push notifications, if currently
 * subscribed, and tells the backend to forget the endpoint (so it stops
 * attempting deliveries to it). No-ops silently when there's no active
 * subscription or the browser lacks Service Worker support.
 */
export async function unsubscribeFromPush(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();

  await fetch("/api/push/subscribe", {
    method: "DELETE",
    headers: pushHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ endpoint }),
  });
}
