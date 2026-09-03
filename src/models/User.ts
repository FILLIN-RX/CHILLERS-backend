import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IUser extends Document {
  username?: string;
  email: string;
  passwordHash: string;
  avatarUrl?: string;
  role: 'user' | 'admin';
  favorites: { mediaType: 'movie' | 'series' | 'anime' | 'tv'; tmdbId: string; title: string; posterPath?: string }[];
  continueWatching: { tmdbId: string; mediaType: 'movie' | 'series' | 'anime' | 'tv'; season?: number; episode?: number; progress: number; duration: number; updatedAt: Date; title: string; posterPath?: string; backdropPath?: string }[];
  watchHistory: { tmdbId: string; mediaType: 'movie' | 'series' | 'anime' | 'tv'; season?: number; episode?: number; title: string; watchedAt: Date; posterPath?: string }[];
  preferences: {
    defaultQuality?: string;
    defaultSubtitle?: string;
  };
  subscription: {
    plan: 'free' | 'standard' | 'premium';
    status: 'active' | 'inactive' | 'cancelled';
    expiresAt?: Date;
  };
  activeSessions: {
    deviceId: string;
    lastLogin: Date;
    deviceName?: string;
  }[];
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema: Schema = new Schema(
  {
    username: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    avatarUrl: {
      type: String,
    },
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
    },
    favorites: [
      {
        mediaType: { type: String, enum: ['movie', 'series', 'anime', 'tv'], required: true },
        tmdbId: { type: String, required: true },
        title: { type: String, required: true },
        posterPath: { type: String },
      },
    ],
    continueWatching: [
      {
        tmdbId: { type: String, required: true },
        mediaType: { type: String, enum: ['movie', 'series', 'anime', 'tv'], required: true },
        season: { type: Number },
        episode: { type: Number },
        progress: { type: Number, required: true },
        duration: { type: Number, required: true },
        updatedAt: { type: Date, default: Date.now },
        title: { type: String, required: true },
        posterPath: { type: String },
        backdropPath: { type: String },
      },
    ],
    watchHistory: [
      {
        tmdbId: { type: String, required: true },
        mediaType: { type: String, enum: ['movie', 'series', 'anime', 'tv'], required: true },
        season: { type: Number },
        episode: { type: Number },
        title: { type: String, required: true },
        watchedAt: { type: Date, default: Date.now },
        posterPath: { type: String },
      },
    ],
    preferences: {
      defaultQuality: { type: String },
      defaultSubtitle: { type: String },
    },
    subscription: {
      plan: { type: String, enum: ['free', 'standard', 'premium'], default: 'free' },
      status: { type: String, enum: ['active', 'inactive', 'cancelled'], default: 'active' },
      expiresAt: { type: Date },
    },
    activeSessions: [
      {
        deviceId: { type: String, required: true },
        lastLogin: { type: Date, default: Date.now },
        deviceName: { type: String },
      },
    ],
  },
  {
    timestamps: true,
  }
);

export const User: Model<IUser> = mongoose.models.User || mongoose.model<IUser>('User', UserSchema);
