import mongoose, { Schema, Document } from 'mongoose';

export interface IEpisode {
    episode: string;        // ex. "S02E01" — label consommé par le provider
    season: number;
    episodeNumber: number;
    fileCode?: string;     // Doodstream fileCode
    lien: string;          // URL mp4 direct (fallback si Doodstream indispo)
    fldId?: string;        // Doodstream folder ID après organize
    tmdbId?: number;       // optionnel, au niveau épisode
    totalSlots?: string;
    usedSlots?: string;
    uploadedAt?: Date;
    uqloadCode?: string;
    uqloadLink?: string;
    streamtapeCode?: string;
    streamtapeLink?: string;
    langueAudio?: string;
    source?: string;
    quality?: string;
    isPremium?: boolean;
    sources?: Array<{
        source: string;
        url: string;
        quality?: string;
        isPremium?: boolean;
        addedAt?: Date;
    }>;
}

export interface ISerie extends Document {
    titre: string;
    pageUrl: string;
    episodes: IEpisode[];
    tmdbId?: number;
    year?: number;
    createdAt: Date;
    updatedAt: Date;
    posterUrl?: string;
    posterSource?: string;
    speech?: string;
    disponible?: boolean;
    disponibleCheckedAt?: Date;
    langueAudio?: string;
}

const EpisodeSchema: Schema = new Schema({
    episode: { type: String, required: true },
    season: { type: Number, required: true },
    episodeNumber: { type: Number, required: true },
    fileCode: { type: String, index: true, sparse: true },
    lien: { type: String, required: true },
    fldId: { type: String },
    tmdbId: { type: Number },
    totalSlots: { type: String },
    usedSlots: { type: String },
    uploadedAt: { type: Date },
    uqloadCode: { type: String },
    uqloadLink: { type: String },
    streamtapeCode: { type: String },
    streamtapeLink: { type: String },
    langueAudio: { type: String },
    source: { type: String },
    quality: { type: String },
    isPremium: { type: Boolean, default: false },
    sources: {
        type: [
            {
                source: { type: String, required: true },
                url: { type: String, required: true },
                quality: { type: String },
                isPremium: { type: Boolean, default: false },
                addedAt: { type: Date, default: Date.now },
            },
        ],
        default: [],
    },
}, { _id: false });

const SerieSchema: Schema = new Schema({
    titre: { type: String, required: true, unique: true },
    pageUrl: { type: String, required: true },
    episodes: [EpisodeSchema],
    tmdbId: { type: Number, index: true },
    year: { type: Number },
    posterUrl: { type: String },
    posterSource: { type: String, enum: ['tmdb', 'web', 'ai', 'none'], default: undefined },
    speech: { type: String },
    disponible: { type: Boolean },
    disponibleCheckedAt: { type: Date },
    langueAudio: { type: String, index: true },
}, { timestamps: true });

// Index composé pour accélérer le lookup du provider (titre + S/E)
SerieSchema.index({ titre: 1, 'episodes.season': 1, 'episodes.episodeNumber': 1 });

export default mongoose.model<ISerie>('Serie', SerieSchema);
