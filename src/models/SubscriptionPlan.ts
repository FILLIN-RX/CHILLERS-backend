import mongoose, { Document, Model, Schema } from 'mongoose';

export interface ISubscriptionPlan extends Document {
  code: string;
  name: string;
  price: number;
  durationMonths: number;
  features: {
    maxDevices: number;
    maxResolution: string; // e.g. '720p', '1080p', '4K'
    hasContinueWatching: boolean;
    hasWatchHistory: boolean;
    hasDownloads: boolean;
  };
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const SubscriptionPlanSchema: Schema = new Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    price: {
      type: Number,
      required: true,
      default: 0,
    },
    durationMonths: {
      type: Number,
      required: true,
      default: 1,
    },
    features: {
      maxDevices: { type: Number, required: true, default: 1 },
      maxResolution: { type: String, required: true, default: '720p' },
      hasContinueWatching: { type: Boolean, required: true, default: false },
      hasWatchHistory: { type: Boolean, required: true, default: false },
      hasDownloads: { type: Boolean, required: true, default: false },
    },
    isActive: {
      type: Boolean,
      default: true,
    }
  },
  {
    timestamps: true,
  }
);

export const SubscriptionPlan: Model<ISubscriptionPlan> = mongoose.models.SubscriptionPlan || mongoose.model<ISubscriptionPlan>('SubscriptionPlan', SubscriptionPlanSchema);
