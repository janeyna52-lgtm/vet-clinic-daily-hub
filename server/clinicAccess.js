import { query } from './db.js';

const fail = (res, status, error) => res.status(status).json({ error });
export const assignedTo = (appointment, user) => [user.vetId, user.id].filter(Boolean).includes(appointment.vet_id);

// Fail closed: adding an endpoint requires choosing its role and record boundary.
export async function clinicAccess(req, res, next) {
  const { role } = req.user;
  const path = req.path.replace(/\/$/, '') || '/';
  const key = `${req.method} ${path}`;
  if (req.body != null && (typeof req.body !== 'object' || Array.isArray(req.body))) return fail(res, 400, 'Invalid request body.');
  req.body ||= {};
  Object.assign(req.body, { actorName: req.user.name, actorRole: role, userName: req.user.name, userRole: role, recordedBy: req.user.name });
  const allow = (...roles) => roles.includes(role);
  const denied = () => fail(res, 403, 'Your role cannot perform this action.');
  const petAccess = async id => {
    const result = await query('SELECT id, owner_id FROM pets WHERE id = $1', [id]);
    const pet = result.rows[0];
    return pet && (role !== 'owner' || pet.owner_id === req.user.ownerId);
  };
  const selectDoctor = async id => {
    if (typeof id !== 'string' || !id) return null;
    const row = (await query("SELECT id, vet_id FROM users WHERE role = 'vet' AND COALESCE(to_jsonb(users)->>'is_active', 'true') <> 'false' AND (vet_id = $1 OR id = $1)", [id])).rows[0];
    return row ? row.vet_id || row.id : null;
  };
  const appointment = async id => (await query('SELECT * FROM appointments WHERE id = $1', [id])).rows[0];
  try {
    if ((req.method === 'GET' && ['/admin/staff','/admin/audit'].includes(path)) || (req.method === 'POST' && /^\/admin\/(?:staff\/[^/]+\/access|invitations\/[^/]+\/revoke)$/.test(path))) return allow('admin') ? next() : denied();
    if (path === '/checkout-inbox' && req.method === 'GET' || /^\/checkout-inbox\/[^/]+\/(claim|renew|release)$/.test(path) && req.method === 'POST') return allow('assistant') ? next() : denied();
    if (key === 'GET /reminders/status') return allow('assistant', 'admin') ? next() : denied();
    if (key === 'GET /appointments/availability') return allow('owner', 'assistant') ? next() : denied();
    if (key === 'GET /state' || key === 'GET /services/prices') return next();
    if (key === 'GET /logs') return allow('admin') ? next() : denied();
    // Account edits use the validated, session-scoped account router.
    if (key === 'POST /owner/contact') return fail(res, 410, 'Use account profile settings to update your contact details.');
    if (key === 'POST /owner/pets') return fail(res, 410, 'Submit a pet registration request for clinic review.');
    if (key === 'POST /pet-requests') {
      if (!allow('owner')) return denied();
      req.body.ownerId = req.user.ownerId;
      return next();
    }
    if (/^\/appointments\/[^/]+\/handoff$/.test(path) && req.method === 'POST') return allow('vet') ? next() : denied();
    let match;
    if ((match = path.match(/^\/pet-requests\/([^/]+)(?:\/(approve|decline))?$/))) {
      if (!((['DELETE','PUT'].includes(req.method) && !match[2] && allow('owner')) || (req.method === 'POST' && match[2] && allow('assistant')))) return denied();
      const row = (await query('SELECT * FROM pet_requests WHERE id = $1', [decodeURIComponent(match[1])])).rows[0];
      if (!row || (role === 'owner' && row.owner_id !== req.user.ownerId)) return fail(res, 404, 'Pet request not found.');
      if (row.status === 'Approved' || (match[2] && row.status !== 'Pending')) return fail(res, 409, 'This request has already been processed.');
      return next();
    }
    if (key === 'POST /walk-in') {
      if (!allow('assistant')) return denied();
      if (req.body.addToQueue) {
        req.body.vetId = await selectDoctor(req.body.vetId);
        if (!req.body.vetId) return fail(res, 400, 'Choose a current veterinarian for the arrival.');
      }
      return next();
    }
    if (key === 'POST /owners' || key === 'POST /pets') return allow('assistant') ? next() : denied();
    if ((match = path.match(/^\/(?:owner\/)?pets\/([^/]+)\/(photo|weights)$/)) && req.method === 'POST') {
      if (!allow(...(match[2] === 'weights' ? ['assistant'] : ['owner', 'assistant']))) return denied();
      const id = decodeURIComponent(match[1]);
      let permitted = await petAccess(id);
      if (!permitted && match[2] === 'photo') {
        const row = (await query('SELECT owner_id FROM pet_requests WHERE id = $1 OR pet_id = $1', [id])).rows[0];
        permitted = row && (role !== 'owner' || row.owner_id === req.user.ownerId);
      }
      return permitted ? next() : fail(res, 404, 'Pet not found.');
    }
    if (key === 'POST /appointments') {
      if (!allow('owner', 'assistant')) return denied();
      if (!await petAccess(req.body.petId)) return fail(res, 404, 'Pet not found.');
      req.body.vetId = await selectDoctor(req.body.vetId);
      if (!req.body.vetId) return fail(res, 400, 'Choose a current veterinarian.');
      // Owners choose a service, never a price.
      if (role === 'owner') delete req.body.amount;
      return next();
    }
    if ((match = path.match(/^\/appointments\/([^/]+)(?:\/(status|billing))?$/))) {
      const action = match[2];
      const roles = action === 'billing' && req.method === 'POST' ? ['assistant'] : action === 'status' && req.method === 'PATCH' ? ['owner', 'assistant', 'vet'] : !action && req.method === 'PUT' ? ['owner', 'assistant'] : [];
      if (!allow(...roles)) return denied();
      const row = await appointment(decodeURIComponent(match[1]));
      if (!row || (role === 'owner' && !await petAccess(row.pet_id))) return fail(res, 404, 'Appointment not found.');
      if (role === 'vet' && !assignedTo(row, req.user)) return denied();
      if (!action) {
        if (!['Scheduled', 'Confirmed'].includes(row.status)) return fail(res, 409, 'Only upcoming appointments can be edited.');
        if (req.body.petId && !await petAccess(req.body.petId)) return fail(res, 404, 'Pet not found.');
        if (req.body.status && !['Scheduled', 'Confirmed'].includes(req.body.status)) return fail(res, 403, 'Use the authorized visit workflow to change status.');
        if (req.body.vetId !== undefined) {
          req.body.vetId = await selectDoctor(req.body.vetId);
          if (!req.body.vetId) return fail(res, 400, 'Choose a current veterinarian.');
        }
        req.body.status = 'Scheduled';
      }
      return next();
    }
    if (key === 'POST /consultations' || key === 'POST /vaccinations') {
      if (!allow('vet')) return denied();
      req.body.vetId = req.user.vetId || req.user.id;
      const rows = await query("SELECT * FROM appointments WHERE pet_id = $1 AND vet_id = ANY($2::varchar[]) AND status IN ('Checked-in', 'In consultation')", [req.body.petId, [req.user.vetId, req.user.id].filter(Boolean)]);
      if (!rows.rows.some(a => key !== 'POST /consultations' || a.id === req.body.apptId)) return fail(res, 403, 'An assigned active visit is required.');
      return next();
    }
    if ((match = path.match(/^\/vaccinations\/([^/]+)$/)) && req.method === 'DELETE') {
      if (!allow('assistant')) return denied();
      const row = (await query('SELECT done FROM vaccinations WHERE id = $1', [decodeURIComponent(match[1])])).rows[0];
      if (!row) return fail(res, 404, 'Vaccination not found.');
      if (row.done) return fail(res, 403, 'Administered vaccination records cannot be deleted.');
      return next();
    }
    if (req.method === 'POST' && ['/reminders/send', '/reminders/log-call'].includes(path)) return allow('assistant') ? next() : denied();
    return denied();
  } catch (error) {
    console.error('Clinic authorization failed:', error.message);
    return fail(res, 500, 'Unable to check access. Please try again.');
  }
}

export function validateStatusChange(row, body, user) {
  const transitions = {
    Scheduled: ['Confirmed', 'Checked-in', 'Cancelled', 'No-show'],
    Confirmed: ['Checked-in', 'Cancelled', 'No-show'],
    'Checked-in': ['In consultation'],
  };
  const allowed = { owner: ['Cancelled'], assistant: ['Confirmed', 'Checked-in', 'Cancelled', 'No-show'], vet: ['In consultation'] };
  if (!(allowed[user.role] || []).includes(body.status)) return 'Your role cannot set this visit status.';
  const remeasure = user.role === 'assistant' && row.status === 'Checked-in' && body.status === 'Checked-in';
  if (!remeasure && !(transitions[row.status] || []).includes(body.status)) return 'The visit has changed. Refresh and use its current next action.';
  if (user.role === 'vet' && !assignedTo(row, user)) return 'This visit is assigned to another veterinarian.';
  if (body.billingStatus !== undefined) return 'Billing changes require the checkout workflow.';
  if (user.role !== 'assistant' && ['intakeVitals', 'date', 'time', 'reason'].some(k => body[k] !== undefined)) return 'Only reception can record intake or change arrival details.';
  if (body.intakeVitals !== undefined && body.status !== 'Checked-in') return 'Vitals must be recorded during check-in.';
  if (body.status === 'Checked-in') {
    const v = body.intakeVitals;
    if (!v || typeof v.weight !== 'number' || !Number.isFinite(v.weight) || v.weight < 0.05 || v.weight > 120 || typeof v.temp !== 'number' || !Number.isFinite(v.temp) || v.temp < 33 || v.temp > 45) return 'Record a valid measured weight (0.05–120 kg) and temperature (33–45°C).';
  }
  return null;
}
