import { Request, Response } from 'express';
import { SubscriptionPlan } from '../../models/SubscriptionPlan';

export const getPlans = async (req: Request, res: Response) => {
  try {
    const plans = await SubscriptionPlan.find();
    res.json({ success: true, plans });
  } catch (error) {
    console.error('[Admin] getPlans error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const createPlan = async (req: Request, res: Response) => {
  try {
    const plan = new SubscriptionPlan(req.body);
    await plan.save();
    res.json({ success: true, plan });
  } catch (error) {
    console.error('[Admin] createPlan error:', error);
    res.status(500).json({ success: false, message: 'Server error', error: (error as Error).message });
  }
};

export const updatePlan = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const plan = await SubscriptionPlan.findByIdAndUpdate(id, req.body, { new: true });
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
    res.json({ success: true, plan });
  } catch (error) {
    console.error('[Admin] updatePlan error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const deletePlan = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const plan = await SubscriptionPlan.findByIdAndDelete(id);
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
    res.json({ success: true, message: 'Plan deleted' });
  } catch (error) {
    console.error('[Admin] deletePlan error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
