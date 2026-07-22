import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

// Load env from the project root
dotenv.config({ path: path.join(__dirname, '../../.env') });

let isConnected = false;

export const connectDB = async () => {
  if (isConnected) return;
  
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error("MONGO_URI not defined in .env");
  }

  try {
    const conn = await mongoose.connect(uri);
    isConnected = true;
    console.log(`[MongoDB] Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`[MongoDB] Connection error:`, error);
    throw error;
  }
};
