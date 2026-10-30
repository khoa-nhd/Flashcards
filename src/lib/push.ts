/**
 * Web push in the browser (docs/gamification-plan.md, phase 4): whether this
 * browser can take reminders, and subscribing it with the server's key.
 * iPhone and iPad take them only from the app added to the home screen.
 */

export type PushSupport = 'supported' | 'unsupported' | 'ios-needs-home-screen';

export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  if (ios && !standalone) return 'ios-needs-home-screen';
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window ? 'supported' : 'unsupported';
}

export const permission = (): NotificationPermission | 'unsupported' =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

/** The service worker, registered now if it is not yet (the app registers it only in production builds). */
async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing !== undefined) return existing;
  await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let at = 0; at < raw.length; at += 1) bytes[at] = raw.charCodeAt(at);
  return bytes;
}

export interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Asks for permission and subscribes this browser. `null` when the person said no. */
export async function subscribe(publicKey: string): Promise<BrowserSubscription | null> {
  const answer = await Notification.requestPermission();
  if (answer !== 'granted') return null;
  const worker = await registration();
  const subscription =
    (await worker.pushManager.getSubscription()) ??
    (await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  const json = subscription.toJSON();
  if (json.endpoint === undefined || json.keys?.p256dh === undefined || json.keys.auth === undefined) {
    throw new Error('The browser gave a subscription without its keys.');
  }
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } };
}

/** This browser's push address, if it is subscribed. */
export async function currentEndpoint(): Promise<string | null> {
  if (pushSupport() !== 'supported') return null;
  const worker = await navigator.serviceWorker.getRegistration('/');
  return (await worker?.pushManager.getSubscription())?.endpoint ?? null;
}

/** Unsubscribes this browser; returns the address it had. */
export async function unsubscribe(): Promise<string | null> {
  const worker = await navigator.serviceWorker.getRegistration('/');
  const subscription = await worker?.pushManager.getSubscription();
  if (subscription == null) return null;
  await subscription.unsubscribe();
  return subscription.endpoint;
}
