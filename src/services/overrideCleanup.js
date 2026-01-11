import { PlanOverride } from '../models/PlanOverride.js';
import { AuditLog } from '../models/AuditLog.js';

/**
 * Deactivate expired plan overrides
 */
export async function cleanupExpiredOverrides() {
  const expired = await PlanOverride.find({
    active: true,
    expiresAt: { $lte: new Date() }
  });

  for (const override of expired) {
    override.active = false;
    await override.save();

    await AuditLog.create({
      messId: override.messId,
      action: 'PLAN_OVERRIDE_EXPIRED',
      actorType: 'system',
      details: { overrideId: override._id, overrideType: override.overrideType }
    });
  }

  return expired.length;
}
