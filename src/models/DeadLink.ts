import mongoose, { Schema, Document } from 'mongoose';

export interface IDeadLink extends Document {
  titre: string;
  episode: string;
  lien: string;
  type: 'movie' | 'series';
  lastChecked: Date;
}

const DeadLinkSchema: Schema = new Schema({
  titre: { type: String, required: true },
  episode: { type: String, required: true },
  lien: { type: String, required: true, unique: true },
  type: { type: String, enum: ['movie', 'series'], required: true },
  lastChecked: { type: Date, default: Date.now },
});

export default mongoose.model<IDeadLink>('DeadLink', DeadLinkSchema);
