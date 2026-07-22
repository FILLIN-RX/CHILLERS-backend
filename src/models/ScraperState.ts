import mongoose, { Schema, Document } from 'mongoose';

export interface IScraperState extends Document {
  name: string;
  lastPage: number;
  updatedAt: Date;
}

const ScraperStateSchema: Schema = new Schema({
  name: { type: String, required: true, unique: true },
  lastPage: { type: Number, default: 1 },
  updatedAt: { type: Date, default: Date.now },
});

export default mongoose.model<IScraperState>('ScraperState', ScraperStateSchema);
