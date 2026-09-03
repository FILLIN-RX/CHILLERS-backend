import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { userRepository } from './user.repository';
import { IUser } from '../../models/User';
import { SubscriptionPlan } from '../../models/SubscriptionPlan';

const JWT_SECRET = process.env.JWT_SECRET || 'chillers-super-secret-key-change-me';

interface AuthResult {
  token: string;
  user: {
    id: string;
    email: string;
    username?: string;
    role: string;
    avatarUrl?: string;
    favorites: any[];
    watchHistory?: any[];
    continueWatching?: any[];
    preferences?: any;
    subscription?: {
      plan: string;
      status: string;
      expiresAt?: Date;
      features?: any;
    };
    activeSessions?: any[];
  };
}

export class AuthService {
  private formatUserPayload(user: IUser, planFeatures?: any) {
    return {
      id: String(user._id),
      email: user.email,
      username: user.username,
      role: user.role,
      avatarUrl: user.avatarUrl,
      favorites: user.favorites || [],
      watchHistory: user.watchHistory || [],
      continueWatching: user.continueWatching || [],
      preferences: user.preferences || {},
      subscription: {
        ...user.subscription,
        features: planFeatures || null,
      },
      activeSessions: user.activeSessions || [],
    };
  }

  private generateToken(user: IUser, deviceId?: string): string {
    return jwt.sign({ id: user._id, role: user.role, deviceId }, JWT_SECRET, {
      expiresIn: '7d',
    });
  }

  async register(email: string, password: string, username?: string, deviceId?: string, deviceName?: string): Promise<AuthResult> {
    const existingUser = await userRepository.findByEmail(email.toLowerCase());
    if (existingUser) {
      throw new Error('Un utilisateur existe déjà avec cet email');
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const user = await userRepository.create({
      email: email.toLowerCase(),
      passwordHash,
      username,
      subscription: { plan: 'free', status: 'active' },
      activeSessions: deviceId ? [{ deviceId, lastLogin: new Date(), deviceName }] : [],
    });

    const token = this.generateToken(user, deviceId);
    
    // Fetch default free plan features
    const freePlan = await SubscriptionPlan.findOne({ code: 'free' });
    return { token, user: this.formatUserPayload(user, freePlan?.features) };
  }

  async login(email: string, password: string, deviceId?: string, deviceName?: string): Promise<AuthResult> {
    const user = await userRepository.findByEmail(email.toLowerCase());
    if (!user) {
      throw new Error('Identifiants invalides');
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      throw new Error('Identifiants invalides');
    }

    const planCode = user.subscription?.plan || 'free';
    const planDoc = await SubscriptionPlan.findOne({ code: planCode });
    const limit = planDoc?.features?.maxDevices || 1;

    if (deviceId) {
      let sessions = user.activeSessions || [];
      
      const existingSessionIndex = sessions.findIndex(s => s.deviceId === deviceId);
      if (existingSessionIndex !== -1) {
        sessions[existingSessionIndex].lastLogin = new Date();
        if (deviceName) sessions[existingSessionIndex].deviceName = deviceName;
      } else {
        if (sessions.length >= limit) {
          throw new Error('LIMITE_CONNEXIONS_ATTEINTE');
        }
        sessions.push({ deviceId, lastLogin: new Date(), deviceName });
      }
      user.activeSessions = sessions;
      await user.save();
    }

    const token = this.generateToken(user, deviceId);
    return { token, user: this.formatUserPayload(user, planDoc?.features) };
  }

  async getProfile(userId: string): Promise<any> {
    const user = await userRepository.findById(userId);
    if (!user) {
      throw new Error('Utilisateur non trouvé');
    }
    const planDoc = await SubscriptionPlan.findOne({ code: user.subscription?.plan || 'free' });
    return this.formatUserPayload(user, planDoc?.features);
  }
}

export const authService = new AuthService();
