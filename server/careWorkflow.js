import { readFileSync } from 'node:fs';
import { query } from './db.js';
import { validDate } from './scheduling.js';
let ready;
export function ensureCareSchema() {
  if (!ready) ready = query(readFileSync(new URL('./database/care-workflow.sql', import.meta.url), 'utf8')).catch(e => { ready = undefined; throw e; });
  return ready;
}
export function validateCarePlan(body, date) {
  const status = body.careStatus || 'Routine care';
  if (!['Routine care', 'Follow-up required', 'Recheck required'].includes(status)) return 'Choose a valid care status.';
  if (status !== 'Routine care' && (!validDate(body.followUpDate) || body.followUpDate < date || typeof body.followUpReason !== 'string' || !body.followUpReason.trim() || body.followUpReason.length > 2000)) return 'A follow-up requires a valid target date and instructions (up to 2000 characters).';
  return null;
}
