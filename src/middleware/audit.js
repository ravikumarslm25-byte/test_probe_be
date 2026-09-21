import { Audit } from '../models/exam.js';

/* Records a privileged action. Never throws into the request path —
   an audit failure must not fail the operation it is recording. */
export async function audit(req, { action, entity, entityId, before, after }) {
  try {
    await Audit.create({
      institutionId: req.actor.institutionId,
      actorId: req.actor.id,
      actorKind: req.actor.kind,
      actorName: req.actor.name,
      action, entity, entityId, before, after,
      ip: req.ip,
    });
  } catch (e) {
    console.error('[audit] failed to record', action, e.message);
  }
}
