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
}

export interface ISerie extends Document {
    titre: string;
    pageUrl: string;
    episodes: IEpisode[];
    tmdbId?: number;
    createdAt: Date;
    updatedAt: Date;
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
}, { _id: false });

const SerieSchema: Schema = new Schema({
    titre: { type: String, required: true, unique: true },
    pageUrl: { type: String, required: true },
    episodes: [EpisodeSchema],
    tmdbId: { type: Number, index: true }
}, { timestamps: true });

// Index composé pour accélérer le lookup du provider (titre + S/E)
SerieSchema.index({ titre: 1, 'episodes.season': 1, 'episodes.episodeNumber': 1 });

export default mongoose.model<ISerie>('Serie', SerieSchema);
