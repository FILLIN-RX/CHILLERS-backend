import type { Request, Response } from 'express';
import type { AuthRequest } from '../../middleware/auth.middleware';
import { optionalAuth, requireAuth } from '../../middleware/auth.middleware';
import { PushSubscription, PushCampaign } from './notification.models';
import { getVapidPublicKey, sendToAll, sendToSubscription } from './push.service';
import { generateAICompletion, parseAIJson } from '../ai/ai';
import { User } from '../../models/User';

const categories = ['announcements', 'favorites', 'matches', 'subscriptions', 'reminders'] as const;
const clean = (value: unknown, max: number) => typeof value === 'string' ? value.trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, max) : '';
const allowedUrl = (value: unknown) => {
  const url = clean(value, 300);
  return url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/api') ? url : '/';
};

export function config(_req: Request, res: Response) {
  res.json({ success: true, data: { enabled: Boolean(getVapidPublicKey()), publicKey: getVapidPublicKey() || null } });
}

export async function subscribe(req: AuthRequest, res: Response) {
  const input = req.body?.subscription;
  const endpoint = clean(input?.endpoint, 2048);
  const p256dh = clean(input?.keys?.p256dh, 256);
  const auth = clean(input?.keys?.auth, 256);
  if (!endpoint.startsWith('https://') || !p256dh || !auth) {
    res.status(400).json({ success: false, message: 'Abonnement navigateur invalide' });
    return;
  }
  try {
    const update: any = { keys: { p256dh, auth }, lastSeenAt: new Date() };
    if (req.user?.id) update.userId = req.user.id;
    await PushSubscription.findOneAndUpdate(
      { endpoint },
      { $set: update, $setOnInsert: { preferences: { announcements: true, favorites: true, matches: true, subscriptions: true, reminders: true } } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );
    console.info('[WebPush] Abonnement navigateur enregistré.', { linkedAccount: Boolean(req.user?.id) });
    res.json({ success: true, data: { linkedToAccount: Boolean(req.user?.id) } });
  } catch (error: any) {
    console.error('[WebPush] Échec d’enregistrement de l’abonnement.', { code: error?.code || 'database_error' });
    res.status(500).json({ success: false, message: 'Impossible d’enregistrer cet appareil' });
  }
}

export async function unsubscribe(req: Request, res: Response) {
  const endpoint = clean(req.body?.endpoint, 2048);
  if (!endpoint) { res.status(400).json({ success: false, message: 'Endpoint requis' }); return; }
  const result = await PushSubscription.deleteOne({ endpoint });
  console.info('[WebPush] Désabonnement navigateur traité.', { removed: result.deletedCount || 0 });
  res.json({ success: true });
}

export async function preferences(req: AuthRequest, res: Response) {
  const endpoint = clean(req.body?.endpoint, 2048);
  const update: Record<string, boolean> = {};
  for (const category of categories) {
    if (typeof req.body?.preferences?.[category] === 'boolean') update[`preferences.${category}`] = req.body.preferences[category];
  }
  const followedTeams = Array.isArray(req.body?.followedTeams)
    ? [...new Set(req.body.followedTeams.map((team: unknown) => clean(team, 60)).filter(Boolean))].slice(0, 30)
    : undefined;
  const query = req.user?.id ? { userId: req.user.id } : endpoint ? { endpoint } : null;
  if (!query) { res.status(400).json({ success: false, message: 'Appareil ou compte requis' }); return; }
  const set: Record<string, unknown> = { ...update };
  if (followedTeams) set.followedTeams = followedTeams;
  await PushSubscription.updateMany(query, { $set: set });
  const first: any = await PushSubscription.findOne(query).select('preferences followedTeams').lean();
  res.json({ success: true, data: first || null });
}

export async function currentPreferences(req: AuthRequest, res: Response) {
  const endpoint = clean(req.query.endpoint, 2048);
  const query = req.user?.id ? { userId: req.user.id } : endpoint ? { endpoint } : null;
  if (!query) { res.status(400).json({ success: false, message: 'Appareil ou compte requis' }); return; }
  const items: any[] = await PushSubscription.find(query).select('preferences followedTeams endpoint').lean();
  res.json({ success: true, data: items.map(({ endpoint: _endpoint, ...item }) => item) });
}

export async function createCampaign(req: Request, res: Response) {
  const theme = clean(req.body?.theme, 180);
  const audience = req.body?.audience === 'free' ? 'free' : req.body?.audience === 'all' ? 'all' : null;
  const sendNow = req.body?.sendNow === true;
  const scheduledAt = sendNow ? new Date() : new Date(req.body?.scheduledAt);
  const grantPremiumDays = Math.max(0, Math.min(90, Math.floor(Number(req.body?.grantPremiumDays) || 0)));
  const url = allowedUrl(req.body?.url);
  // image = URL affiche TMDB (https://image.tmdb.org/...) — validée pour sécurité
  const rawImage = typeof req.body?.image === 'string' ? req.body.image.trim() : '';
  const image = rawImage.startsWith('https://image.tmdb.org/') || rawImage.startsWith('https://img.') ? rawImage.slice(0, 500) : '';
  if (!theme || !audience || (!sendNow && (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() + 60_000))) {
    res.status(400).json({ success: false, message: sendNow ? 'Thème et public requis.' : 'Thème, public et date future (au moins 1 minute) requis.' });
    return;
  }
  if (sendNow && !getVapidPublicKey()) {
    res.status(503).json({ success: false, message: 'Les clés Web Push ne sont pas configurées sur ce backend.' });
    return;
  }
  try {
    const suppliedTitle = clean(req.body?.title, 55);
    const suppliedMessage = clean(req.body?.message, 160);
    const { title, message } = suppliedTitle && suppliedMessage
      ? { title: suppliedTitle, message: suppliedMessage }
      : await generateCampaignCopy(theme, audience, grantPremiumDays);
    if (!title || !message) throw new Error('Texte généré incomplet');
    let campaign = await PushCampaign.create({ theme, audience, title, message, url, image, scheduledAt, grantPremiumDays, status: sendNow ? 'sending' : 'scheduled', createdBy: (req as any).admin?.username || 'admin' });
    console.info('[WebPush] Campagne créée.', { campaignId: String(campaign._id), audience, sendNow, scheduledAt: scheduledAt.toISOString() });
    if (sendNow) {
      try {
        const deliveryCount = await sendToAll({ title, body: message, url, image: image || undefined, tag: `campaign-${campaign._id}` }, audience);
        if (grantPremiumDays > 0 && audience === 'free') await applyPromoToFreeUsers(grantPremiumDays);
        await PushCampaign.updateOne({ _id: campaign._id }, { $set: { status: 'sent', sentAt: new Date(), deliveryCount } });
        campaign = (await PushCampaign.findById(campaign._id)) || campaign;
        console.info('[WebPush] Envoi immédiat terminé.', { campaignId: String(campaign._id), accepted: deliveryCount });
        res.status(201).json({ success: true, data: campaign, message: `Envoi traité : ${deliveryCount} notification(s) acceptée(s) par les services push.` });
        return;
      } catch (error: any) {
        await PushCampaign.updateOne({ _id: campaign._id }, { $set: { status: 'failed', error: String(error?.message || 'Échec d’envoi').slice(0, 300) } });
        console.error('[WebPush] Échec de l’envoi immédiat.', { campaignId: String(campaign._id), code: error?.code || 'send_failed' });
        res.status(502).json({ success: false, message: 'La campagne a été rédigée, mais son envoi a échoué.' });
        return;
      }
    }
    res.status(201).json({ success: true, data: campaign, message: 'Campagne programmée.' });
  } catch (error: any) {
    console.error('[WebPush] Échec de création de campagne IA.', { code: error?.code || 'campaign_create_failed' });
    res.status(502).json({ success: false, message: error?.message || 'L’IA n’a pas pu rédiger la campagne.' });
  }
}

export async function generateCampaignDraft(req: Request, res: Response) {
  const theme = clean(req.body?.theme, 180);
  const audience = req.body?.audience === 'free' ? 'free' : req.body?.audience === 'all' ? 'all' : null;
  const grantPremiumDays = Math.max(0, Math.min(90, Math.floor(Number(req.body?.grantPremiumDays) || 0)));
  if (!theme || !audience) {
    res.status(400).json({ success: false, message: 'Sujet et public requis.' });
    return;
  }
  try {
    const draft = await generateCampaignCopy(theme, audience, grantPremiumDays);
    res.json({ success: true, data: draft });
  } catch (error: any) {
    console.error('[WebPush] Échec de génération du brouillon IA.', { code: error?.code || 'campaign_draft_failed' });
    res.status(502).json({ success: false, message: error?.message || 'L’IA n’a pas pu rédiger la campagne.' });
  }
}

async function generateCampaignCopy(theme: string, audience: 'all' | 'free', grantPremiumDays: number) {
  const ai = await generateAICompletion({
    systemPrompt: 'Tu es le community manager de CHILLERS. Rédige un message push clair, naturel, honnête et engageant, sans fausse urgence. Réponds uniquement en JSON valide avec title (max 55 caractères) et message (max 160 caractères).',
    prompt: `Objectif de campagne: ${theme}\nPublic: ${audience === 'free' ? 'comptes gratuits' : 'tous les abonnés aux notifications'}\n${grantPremiumDays ? `L’offre accorde réellement ${grantPremiumDays} jours d’accès Premium aux comptes gratuits ciblés. Mentionne cette durée sans inventer de conditions.` : 'Ne promets aucune réduction ou offre non spécifiée.'}`,
    maxTokens: 1200,
    temperature: 0.5,
    jsonMode: true,
  });
  const parsed = parseAIJson(ai.text);
  const title = clean(parsed.title, 55);
  const message = clean(parsed.message, 160);
  if (!title || !message) throw new Error('Texte généré incomplet');
  return { title, message, usedProvider: ai.usedProvider };
}

export async function listCampaigns(_req: Request, res: Response) {
  const campaigns = await PushCampaign.find().sort({ createdAt: -1 }).limit(100).lean();
  res.json({ success: true, data: campaigns });
}

export async function cancelCampaign(req: Request, res: Response) {
  const campaign = await PushCampaign.findOneAndUpdate(
    { _id: req.params.id, status: 'scheduled' },
    { $set: { status: 'cancelled' } },
    { returnDocument: 'after' },
  );
  if (!campaign) { res.status(409).json({ success: false, message: 'Campagne introuvable ou déjà démarrée.' }); return; }
  res.json({ success: true, data: campaign });
}

export async function sendTest(req: AuthRequest, res: Response) {
  const endpoint = clean(req.body?.endpoint, 2048);
  const query: any = req.user?.id ? { userId: req.user.id } : endpoint ? { endpoint } : null;
  if (!query) { res.status(400).json({ success: false, message: 'Appareil ou compte requis.' }); return; }
  const subscriptions = await PushSubscription.find(query).lean();
  const results = await Promise.all(subscriptions.map((sub: any) => sendToSubscription(sub, {
    title: 'Test CHILLERS', body: 'Les notifications web sont prêtes.', url: '/',
  })));
  const count = results.filter(Boolean).length;
  console.info('[WebPush] Test terminé.', { subscriptions: subscriptions.length, accepted: count });
  res.json({ success: true, data: { delivered: count } });
}

export async function applyPromoToFreeUsers(days: number) {
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  await User.updateMany({ $or: [
    { 'subscription.plan': 'free' },
    { 'subscription.status': { $ne: 'active' } },
    { 'subscription.expiresAt': { $lte: new Date() } },
  ] }, { $set: { promo: { code: `push-campaign-${Date.now()}`, isActive: true, expiresAt } } });
}

export { requireAuth, optionalAuth };
