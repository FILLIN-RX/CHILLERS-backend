import webpush from 'web-push';
import { PushSubscription, NotificationMarker } from './notification.models';
import { User } from '../../models/User';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:support@chillers.site';
const DAYS = 24 * 60 * 60 * 1000;

let configured = false;
function configurePush() {
  if (configured) return true;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  console.info('[WebPush] VAPID configuré; les envois sont activés.');
  return true;
}

export function getVapidPublicKey() {
  return VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY ? VAPID_PUBLIC_KEY : null;
}

export type NotificationCategory = 'announcements' | 'favorites' | 'matches' | 'subscriptions' | 'reminders';
export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  category?: NotificationCategory;
  /** URL de l'affiche du film/série — affichée dans la notification push */
  image?: string;
  /** Icône spécifique à ce push (différente de l'icône app par défaut) */
  icon?: string;
}

async function deliver(subscription: any, payload: PushPayload) {
  if (!configurePush()) {
    console.warn('[WebPush] Envoi ignoré: configuration VAPID absente.');
    return false;
  }
  try {
    await webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, JSON.stringify(payload), { TTL: 60 * 60 });
    console.info('[WebPush] Push accepté par le service push.', { category: payload.category || 'unknown', statusCode: 201 });
    return true;
  } catch (error: any) {
    const statusCode = Number(error?.statusCode) || 0;
    console.warn('[WebPush] Push rejeté par le service push.', {
      category: payload.category || 'unknown',
      statusCode,
      code: typeof error?.code === 'string' ? error.code : 'send_failed',
    });
    if (error?.statusCode === 404 || error?.statusCode === 410) {
      await PushSubscription.deleteOne({ _id: subscription._id });
      console.info('[WebPush] Abonnement expiré supprimé.');
    }
    return false;
  }
}

export async function sendToSubscription(sub: any, payload: PushPayload) {
  return deliver(sub, payload);
}

export async function sendToUser(userId: string, payload: PushPayload, category: NotificationCategory) {
  if (!configurePush()) return 0;
  const subscriptions = await PushSubscription.find({ userId, [`preferences.${category}`]: true }).lean();
  const result = await Promise.all(subscriptions.map((sub) => deliver(sub, { ...payload, category })));
  const accepted = result.filter(Boolean).length;
  console.info('[WebPush] Envoi utilisateur terminé.', { category, subscriptions: subscriptions.length, accepted });
  return accepted;
}

export async function sendToAll(payload: PushPayload, audience: 'all' | 'free' = 'all') {
  if (!configurePush()) return 0;
  let subscriptions = await PushSubscription.find({ 'preferences.announcements': true }).lean();
  if (audience === 'free') {
    const freeUsers = await User.find({ $or: [
      { 'subscription.plan': 'free' },
      { 'subscription.status': { $ne: 'active' } },
      { 'subscription.expiresAt': { $lte: new Date() } },
    ] }).select('_id').lean();
    const ids = new Set(freeUsers.map((user) => String(user._id)));
    subscriptions = subscriptions.filter((sub: any) => sub.userId && ids.has(String(sub.userId)));
  }
  const result = await Promise.all(subscriptions.map((sub: any) => deliver(sub, { ...payload, category: 'announcements' })));
  const accepted = result.filter(Boolean).length;
  console.info('[WebPush] Campagne diffusée.', { audience, subscriptions: subscriptions.length, accepted });
  return accepted;
}

export async function markOnce(key: string, ttlMs = 400 * DAYS) {
  try {
    await NotificationMarker.create({ key, expiresAt: new Date(Date.now() + ttlMs) });
    return true;
  } catch (error: any) {
    if (error?.code === 11000) return false;
    throw error;
  }
}
