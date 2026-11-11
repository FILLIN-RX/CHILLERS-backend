import mongoose, { Schema } from 'mongoose';

const PushSubscriptionSchema = new Schema({
  endpoint: { type: String, required: true, unique: true },
  keys: { p256dh: { type: String, required: true }, auth: { type: String, required: true } },
  userId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  preferences: {
    announcements: { type: Boolean, default: true },
    favorites: { type: Boolean, default: true },
    matches: { type: Boolean, default: true },
    subscriptions: { type: Boolean, default: true },
    reminders: { type: Boolean, default: true },
  },
  followedTeams: { type: [String], default: [] },
  lastSeenAt: { type: Date, default: Date.now },
}, { timestamps: true });

export const PushSubscription = mongoose.models.PushSubscription || mongoose.model('PushSubscription', PushSubscriptionSchema);

const PushCampaignSchema = new Schema({
  theme: { type: String, required: true, maxlength: 180 },
  audience: { type: String, enum: ['all', 'free'], required: true },
  title: { type: String, required: true, maxlength: 80 },
  message: { type: String, required: true, maxlength: 240 },
  url: { type: String, required: true, maxlength: 300 },
  image: { type: String, maxlength: 500, default: '' }, // URL affiche film/série
  scheduledAt: { type: Date, required: true },
  status: { type: String, enum: ['scheduled', 'sending', 'sent', 'cancelled', 'failed'], default: 'scheduled', index: true },
  grantPremiumDays: { type: Number, default: 0, min: 0, max: 90 },
  createdBy: { type: String, required: true },
  sentAt: Date,
  deliveryCount: { type: Number, default: 0 },
  error: String,
}, { timestamps: true });

export const PushCampaign = mongoose.models.PushCampaign || mongoose.model('PushCampaign', PushCampaignSchema);

const NotificationMarkerSchema = new Schema({
  key: { type: String, unique: true, required: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
}, { versionKey: false });
NotificationMarkerSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const NotificationMarker = mongoose.models.NotificationMarker || mongoose.model('NotificationMarker', NotificationMarkerSchema);
