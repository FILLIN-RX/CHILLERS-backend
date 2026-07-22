import mongoose, { Schema, Document } from 'mongoose';

export interface IMovie extends Document {
  titre: string;
  pageUrl: string;
  lien: string;
  lienOriginal?: string;
  tmdbId?: number;
  createdAt: Date;
  uqloadCode?: string;
  uqloadLink?: string;
  uqloadQualities?: Array<{ name: string; url: string; size: string }>;
  uqloadHls?: string;
  fileCode?: string;
  uploadedAt?: Date;
}

const MovieSchema: Schema = new Schema({
  titre: { type: String, required: true, unique: true },
  pageUrl: { type: String, required: true },
  lien: { type: String, required: true },
  lienOriginal: { type: String },
  tmdbId: { type: Number },
  createdAt: { type: Date, default: Date.now },
  uqloadCode: { type: String, index: true, sparse: true },
  uqloadLink: { type: String },
  uqloadQualities: { type: [{ name: String, url: String, size: String }] },
  uqloadHls: { type: String },
  fileCode: { type: String },
  uploadedAt: { type: Date },
});

export default mongoose.model<IMovie>('Movie', MovieSchema);
