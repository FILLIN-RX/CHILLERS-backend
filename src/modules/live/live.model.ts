// @ts-nocheck
import * as mongoose_1 from "mongoose";
exports.liveChannelSchema = new mongoose_1.Schema({
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    logo: { type: String, default: '' },
    categories: { type: [String], default: [] },
    country: { type: String, default: '' },
    language: { type: String, default: '' },
    type: { type: String, enum: ['hls', 'youtube', 'dailymotion'], default: 'hls' },
    streamUrl: { type: String, default: '' },
    ytVideoId: { type: String, default: '' },
    referer: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    enabled: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
    lastChecked: { type: Date },
    isOnline: { type: Boolean, default: false },
    source: { type: String, default: '' },
}, { timestamps: true });
