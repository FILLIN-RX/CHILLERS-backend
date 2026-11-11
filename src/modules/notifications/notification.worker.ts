import { User } from '../../models/User';
import Movie from '../../models/Movie';
import Serie from '../../models/Serie';
import { getSportsMatches } from '../sports/sports.service';
import { PushCampaign, PushSubscription } from './notification.models';
import { markOnce, sendToAll, sendToSubscription, sendToUser } from './push.service';
import { startScoreAlerts } from './score-alerts';
import { applyPromoToFreeUsers } from './notifications.controller';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
let running = false;

async function processCampaigns() {
  const due = await PushCampaign.findOneAndUpdate(
    { status: 'scheduled', scheduledAt: { $lte: new Date() } },
    { $set: { status: 'sending' } },
    { sort: { scheduledAt: 1 }, returnDocument: 'after' },
  );
  if (!due) return;
  console.info('[WebPush] Campagne programmée lancée.', { campaignId: String(due._id), audience: due.audience });
  try {
    const deliveryCount = await sendToAll({ title: due.title, body: due.message, url: due.url, image: due.image || undefined, tag: `campaign-${due._id}` }, due.audience);
    if (due.grantPremiumDays > 0 && due.audience === 'free') await applyPromoToFreeUsers(due.grantPremiumDays);
    await PushCampaign.updateOne({ _id: due._id }, { $set: { status: 'sent', sentAt: new Date(), deliveryCount } });
    console.info('[WebPush] Campagne terminée.', { campaignId: String(due._id), accepted: deliveryCount });
  } catch (error: any) {
    await PushCampaign.updateOne({ _id: due._id }, { $set: { status: 'failed', error: String(error?.message || 'Échec de campagne').slice(0, 300) } });
    console.error('[WebPush] Campagne échouée.', { campaignId: String(due._id), code: error?.code || 'campaign_send_failed' });
  }
}

async function processSubscriptionNotices() {
  const now = new Date();
  const reminderFrom = new Date(now.getTime() + 3 * DAY);
  const reminderTo = new Date(reminderFrom.getTime() + 2 * MINUTE);
  const expiring = await User.find({ 'subscription.status': 'active', 'subscription.plan': { $ne: 'free' }, 'subscription.expiresAt': { $gte: reminderFrom, $lt: reminderTo } }).select('_id subscription.plan subscription.expiresAt').lean();
  for (const user of expiring) {
    if (!await markOnce(`subscription-3d:${user._id}:${new Date(user.subscription.expiresAt!).toISOString()}`)) continue;
    await sendToUser(String(user._id), { title: 'Votre abonnement arrive à échéance', body: 'Plus que 3 jours pour profiter de votre formule CHILLERS.', url: '/profile?tab=subscription' }, 'subscriptions');
  }

  const expiredSince = new Date(now.getTime() - 2 * MINUTE);
  const expired = await User.find({ 'subscription.status': 'active', 'subscription.plan': { $ne: 'free' }, 'subscription.expiresAt': { $gte: expiredSince, $lte: now } }).select('_id subscription.plan subscription.expiresAt').lean();
  for (const user of expired) {
    if (!await markOnce(`subscription-expired:${user._id}:${new Date(user.subscription.expiresAt!).toISOString()}`)) continue;
    await sendToUser(String(user._id), { title: 'Votre abonnement a expiré', body: 'Renouvelez votre formule pour retrouver tous vos avantages.', url: '/subscription' }, 'subscriptions');
  }
}

async function processContinueReminders() {
  const now = Date.now();
  const users = await User.find({ 'continueWatching.0': { $exists: true } }).select('_id continueWatching').limit(600).lean();
  for (const user of users as any[]) {
    const candidates = (user.continueWatching || []).filter((item: any) => {
      const updated = new Date(item.updatedAt).getTime();
      return updated <= now - DAY && updated >= now - 2 * DAY && item.tmdbId;
    }).sort((a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    const item = candidates[0];
    if (!item || !await markOnce(`daily-reminder:${user._id}:${new Date().toISOString().slice(0, 10)}`)) continue;
    const query = new URLSearchParams({ type: item.mediaType, lang: 'fr' });
    if (item.season) query.set('season', String(item.season));
    if (item.episode) query.set('episode', String(item.episode));
    await sendToUser(String(user._id), { title: 'Reprenez votre visionnage', body: `Continuez « ${item.title} » là où vous vous êtes arrêté.`, url: `/watch/${item.tmdbId}?${query}` }, 'reminders');
  }

  const favorites = await User.find({ 'favorites.0': { $exists: true } }).select('_id favorites watchHistory').limit(600).lean();
  for (const user of favorites as any[]) {
    const favorite = (user.favorites || []).find((item: any) => item.addedAt && new Date(item.addedAt).getTime() <= now - DAY && new Date(item.addedAt).getTime() >= now - 2 * DAY && !(user.watchHistory || []).some((history: any) => history.tmdbId === item.tmdbId));
    if (!favorite || !await markOnce(`daily-reminder:${user._id}:${new Date().toISOString().slice(0, 10)}`)) continue;
    const route = ['series', 'anime', 'tv'].includes(favorite.mediaType) ? `/tv/${favorite.tmdbId}` : `/media/${favorite.tmdbId}`;
    await sendToUser(String(user._id), { title: 'Un titre de vos favoris vous attend', body: `Regardez « ${favorite.title} » ou téléchargez-le pour plus tard.`, url: route }, 'reminders');
  }
}

async function processCatalogUpdates() {
  const since = new Date(Date.now() - 2 * MINUTE);
  const [movies, series] = await Promise.all([
    Movie.find({ createdAt: { $gte: since }, tmdbId: { $exists: true, $ne: null } }).select('titre tmdbId createdAt').limit(100).lean(),
    Serie.find({ updatedAt: { $gte: since }, tmdbId: { $exists: true, $ne: null }, 'episodes.0': { $exists: true } }).select('titre tmdbId updatedAt episodes').limit(100).lean(),
  ]);
  for (const item of movies as any[]) {
    if (!await markOnce(`new-movie:${item._id}`)) continue;
    const users = await User.find({ 'favorites.tmdbId': String(item.tmdbId) }).select('_id').lean();
    await Promise.all(users.map((user: any) => sendToUser(String(user._id), { title: 'Un de vos favoris est disponible', body: `« ${item.titre} » est maintenant disponible sur CHILLERS.`, url: `/media/${item.tmdbId}` }, 'favorites')));
  }
  for (const item of series as any[]) {
    const latest = [...(item.episodes || [])].sort((a: any, b: any) => (b.season - a.season) || (b.episodeNumber - a.episodeNumber))[0];
    if (!latest || !await markOnce(`new-episode:${item.tmdbId}:s${latest.season}e${latest.episodeNumber}`)) continue;
    const users = await User.find({ 'favorites.tmdbId': String(item.tmdbId) }).select('_id').lean();
    await Promise.all(users.map((user: any) => sendToUser(String(user._id), { title: 'Nouvel épisode disponible', body: `S${latest.season}E${latest.episodeNumber} de « ${item.titre} » est disponible.`, url: `/tv/${item.tmdbId}` }, 'favorites')));
  }
}

async function processMatchReminders() {
  let matches;
  try { matches = await getSportsMatches(); } catch { return; }
  const nowSec = Math.floor(Date.now() / 1000);
  const upcoming = matches.filter((match) => match.status === 'upcoming' && typeof match.startTs === 'number' && match.startTs - nowSec <= 15 * 60 && match.startTs - nowSec > 14 * 60);
  if (!upcoming.length) return;
  const subscribers = await PushSubscription.find({ userId: { $ne: null }, 'preferences.matches': true, followedTeams: { $exists: true, $ne: [] } }).lean();
  for (const match of upcoming) {
    for (const subscriber of subscribers as any[]) {
      const followed = (subscriber.followedTeams || []).some((team: string) => [match.home, match.away].some((name: string) => name.toLowerCase() === team.toLowerCase()));
      if (!followed || !await markOnce(`match-15m:${subscriber._id}:${match.id}`)) continue;
      const payload = { title: 'Le match commence bientôt', body: `${match.home} - ${match.away} dans 15 minutes.`, url: `/live/sp/${match.slug || match.sourceId}` };
      await sendToSubscription(subscriber, { ...payload, category: 'matches' });
    }
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await processCampaigns();
    await processSubscriptionNotices();
    await processContinueReminders();
    await processCatalogUpdates();
    await processMatchReminders();
  } catch (error: any) {
    console.warn('[WebPush] Worker tick failed:', error?.message || error);
  } finally { running = false; }
}

export function startNotificationWorker() {
  const enabled = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  if (!enabled) {
    console.warn('[WebPush] VAPID keys missing; notification worker disabled.');
    return;
  }
  void tick();
  setInterval(() => void tick(), MINUTE);
  startScoreAlerts();
  console.log('[WebPush] Notification worker started (60s interval).');
}
