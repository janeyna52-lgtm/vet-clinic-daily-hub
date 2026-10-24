import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import { sha256 } from '../security.js';

let db, calls, failSql, rollbacks;
const roles = ['owner', 'assistant', 'vet', 'admin'];
const users = Object.fromEntries(roles.map(role => [sha256(`session-${role}`), { id: `u_${role}`, role, first_name: 'Synthetic', last_name: role, owner_id: 'o1', vet_id: role === 'vet' ? 'v1' : null, mobile_verified: true, email_verified_at: '2026-10-24' }]));
const fakeQuery = async (sql, params = []) => {
  sql = sql.replace(/\s+/g, ' ').trim();
  calls.push({ sql, params });
  if (failSql && failSql.test(sql)) throw Error('synthetic database failure');
  const rows = value => ({ rows: structuredClone(value), rowCount: value.length });
  if (sql.includes('FROM sessions s')) return rows(users[params[0]] ? [users[params[0]]] : []);
  if (sql.startsWith('SELECT to_regclass')) return rows([]);
  if (sql.startsWith('-- Preserve owner-submitted') || sql.startsWith('-- Durable reception') || sql.startsWith('-- Idempotent migration') || sql.startsWith('SELECT pg_advisory_xact_lock')) return rows([]);
  if (sql.startsWith('ALTER TABLE')) return rows([]);
  if (sql.startsWith('SELECT')) {
    if (sql.startsWith('SELECT id FROM owners WHERE id = $1')) return rows(db.owners.filter(o=>o.id===params[0]));
    if (sql.startsWith('SELECT name FROM pets WHERE owner_id')) return rows(db.pets.filter(p=>p.owner_id===params[0]));
    if (sql.startsWith('SELECT name,status FROM pet_requests')) return rows(db.requests.filter(r=>r.owner_id===params[0] && r.status!=='Approved' && r.id!==params[1]));
    if (sql.startsWith("SELECT id, vet_id FROM users")) return rows(['v1', 'u_vet'].includes(params[0]) ? [{ id: 'u_vet', vet_id: 'v1' }] : []);
    if (sql.includes("FROM users WHERE role = 'vet'")) return rows([{ id: 'u_vet', vet_id: 'v1', first_name: 'Synthetic', last_name: 'Vet' }]);
    if (sql.includes('FROM owners o')) {
      if (params.length) assert.match(sql, /WHERE o\./);
      return rows(params.length ? db.owners.filter(o => params[0] === o.id || Array.isArray(params[0]) && db.appts.some(a => params[0].includes(a.vet_id) && db.pets.some(p => p.id === a.pet_id && p.owner_id === o.id))) : db.owners);
    }
    if (sql.includes('FROM pets WHERE id = $1')) return rows(db.pets.filter(p => p.id === params[0] && (!sql.includes('AND owner_id') || p.owner_id === params[1])));
    if (sql.includes('FROM pet_requests WHERE id = $1')) return rows(db.requests.filter(r => r.id === params[0] || sql.includes('OR pet_id') && r.pet_id === params[0]));
    if (sql.includes('FROM appointments WHERE id = $1')) return rows(db.appts.filter(a => a.id === params[0]));
    if (sql.includes('FROM appointments WHERE date = $1')) return rows(db.appts.filter(a => a.date === params[0] && (a.vet_id === params[1] || a.pet_id === params[2])));
    if (sql.includes('FROM appointments WHERE pet_id = $1')) return rows(db.appts.filter(a => a.pet_id === params[0] && params[1].includes(a.vet_id) && ['Checked-in', 'In consultation'].includes(a.status)));
    if (sql.includes('FROM checkout_tasks WHERE appointment_id')) return rows(db.tasks.filter(t=>t.appointment_id===params[0]));
    if (sql.includes('FROM consultations WHERE appt_id')) return rows(db.consults.filter(c => c.appt_id === params[0]));
    if (sql.includes('FROM vaccinations WHERE id')) return rows(db.vaccs.filter(v => v.id === params[0]));
    const scopedPet = id => !params.length || db.pets.some(p => p.id === id && (Array.isArray(params[0]) ? db.appts.some(a => a.pet_id === p.id && params[0].includes(a.vet_id)) : p.owner_id === params[0]));
    if (sql.startsWith('SELECT * FROM pets')) return rows(db.pets.filter(p => scopedPet(p.id)));
    if (sql.startsWith('SELECT * FROM pet_weights')) return rows([]);
    if (sql.startsWith('SELECT * FROM appointments')) return rows(db.appts.filter(a => Array.isArray(params[0]) ? params[0].includes(a.vet_id) : scopedPet(a.pet_id)));
    if (sql.startsWith('SELECT * FROM vaccinations')) return rows(db.vaccs.filter(v => scopedPet(v.pet_id)));
    if (sql.startsWith('SELECT * FROM consultations')) return rows(db.consults.filter(c => scopedPet(c.pet_id)));
    if (sql.startsWith('SELECT * FROM pet_requests')) return rows(db.requests.filter(r => !params.length || r.owner_id === params[0]));
    if (sql.startsWith('SELECT * FROM audit_logs')) return rows(db.logs);
  }
  if (sql.startsWith('INSERT INTO checkout_tasks')) { if (!db.tasks.some(t=>t.appointment_id===params[0])) db.tasks.push({appointment_id:params[0],status:'pending'}); return rows([]); }
  if (sql.startsWith('UPDATE checkout_tasks')) { const t=db.tasks.find(t=>t.appointment_id===params[0]);t.status='completed';t.completed_by=params[1];return rows([t]); }
  if (sql.startsWith('INSERT INTO audit_logs')) { const row = { user_name: params[0], user_role: params[1], action: params[2] }; db.logs.push(row); return rows([row]); }
  if (sql.startsWith('INSERT INTO appointments')) { const row = { id: params[0], pet_id: params[1], vet_id: params[2], date: params[3], time: params[4], reason: params[5], status: 'Scheduled', amount: params[6] }; db.appts.push(row); return rows([row]); }
  if (sql.startsWith('INSERT INTO consultations')) { const row = Object.fromEntries(['id', 'pet_id', 'vet_id', 'appt_id', 'date', 'symptoms', 'objective', 'diagnosis', 'treatment', 'prescription'].map((k, i) => [k, params[i]])); db.consults.push(row); return rows([row]); }
  if (sql.startsWith('UPDATE consultations SET care_status')) { const row = db.consults.find(c => c.id === params[3]); Object.assign(row, {care_status:params[0], follow_up_date:params[1], follow_up_reason:params[2]}); return rows([row]); }
  if (sql.startsWith('INSERT INTO vaccinations')) { const row = { id: params[0], pet_id: params[1], card_id: params[2], vaccine: params[3], brand: params[4], batch: params[5], done: true, vet_id: params[9], recorded_by: params[10] }; db.vaccs.push(row); return rows([row]); }
  if (sql.startsWith('INSERT INTO pet_requests')) { const row = { id: params[12], owner_id: params[13], name: params[0], status: 'Pending',revision:0 }; db.requests.push(row); return rows([row]); }
  if (sql.startsWith('UPDATE appointments')) {
    if (sql.includes("status = 'Completed'")) { const row = db.appts.find(a => a.id === params[0]); row.status = 'Completed'; row.billing_status = 'Unbilled'; return rows([row]); }
    if (sql.includes('paid_at')) { const row = db.appts.find(a => a.id === params[4]); Object.assign(row, { amount: params[0], payment_method: params[1], invoice_items: JSON.parse(params[2]), payment_details: JSON.parse(params[3]), billing_status: 'Paid' }); return rows([row]); }
    const row = db.appts.find(a => a.id === params.at(-1));
    row.status = params[0];
    if (sql.includes('intake_vitals')) row.intake_vitals = JSON.parse(params[1]);
    return rows([row]);
  }
  if (sql.startsWith('UPDATE pets') || sql.startsWith('INSERT INTO pet_weights') || sql.startsWith('DELETE FROM vaccinations')) return rows([]);
  throw Error(`Unexpected query: ${sql}`);
};
mock.module('../db.js', { exports: { query: fakeQuery, withTransaction: async cb => { const snapshot = structuredClone(db); try { return await cb({ query: fakeQuery }); } catch (error) { db = snapshot; rollbacks++; throw error; } } } });
mock.module('../services.js', { exports: { serverOutbox: [], sendMail: async () => { throw Error('Unexpected email'); }, sendSms: async () => { throw Error('Unexpected SMS'); } } });
const { clinicRouter } = await import('../routes/clinic.js');
const { clinicClock, shiftDate } = await import('../scheduling.js');
const { holidayName } = await import('../../src/booking.js');
const futureDate = () => { let d = shiftDate(clinicClock().date,1); while (holidayName(d)) d=shiftDate(d,1); return d; };
const app = express(); app.use(express.json()); app.use(cookieParser()); app.use('/api', clinicRouter);
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
after(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => {
  calls = []; failSql = null; rollbacks = 0;
  db = { owners: [{ id: 'o1', name: 'Own owner' }, { id: 'o2', name: 'Other owner' }], pets: [{ id: 'p1', owner_id: 'o1', name: 'Own pet', weight: 5, vaccination_card_id: 'VACC-SYNTHETIC' }, { id: 'p2', owner_id: 'o2', name: 'Other pet', weight: 7 }], appts: [{ id: 'a1', pet_id: 'p1', vet_id: 'v1', date: '2026-10-24', time: '09:00', status: 'Scheduled', amount: 600, billing_status: 'Unbilled' }, { id: 'a2', pet_id: 'p2', vet_id: 'v2', date: '2026-10-24', time: '10:00', status: 'Scheduled' }], requests: [{ id: 'r1', owner_id: 'o1', name:'Request One', status: 'Pending',revision:0 }, { id: 'r2', owner_id: 'o2', name:'Request Two',status: 'Pending',revision:0 }], consults: [], vaccs: [], logs: [], tasks: [] };
});
const request = async (role, method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(role ? { Authorization: `Bearer session-${role}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, data: await res.json() };
};
const endpoints = [['GET','/admin/staff'],['GET','/admin/audit'],['POST','/admin/staff/u_vet/access'],['POST','/admin/invitations/inv1/revoke'],['GET', '/checkout-inbox'], ['POST', '/checkout-inbox/a1/claim'], ['POST', '/checkout-inbox/a1/renew'], ['POST', '/checkout-inbox/a1/release'], ['GET', '/appointments/availability'], ['GET', '/reminders/status'], ['GET', '/state'], ['GET', '/logs'], ['GET', '/services/prices'], ['POST', '/owners'], ['POST', '/pets'], ['POST', '/owner/contact'], ['POST', '/owner/pets'], ['POST', '/pets/p1/weights'], ['POST', '/pets/p1/photo'], ['POST', '/owner/pets/p1/photo'], ['POST', '/pet-requests'], ['PUT', '/pet-requests/r1'], ['DELETE', '/pet-requests/r1'], ['POST', '/pet-requests/r1/approve'], ['POST', '/pet-requests/r1/decline'], ['POST', '/appointments'], ['PUT', '/appointments/a1'], ['PATCH', '/appointments/a1/status'], ['DELETE', '/appointments/a1'], ['POST', '/appointments/a1/billing'], ['POST', '/walk-in'], ['POST', '/vaccinations'], ['DELETE', '/vaccinations/v1'], ['POST', '/consultations'], ['POST', '/logs'], ['POST', '/reminders/send'], ['POST', '/reminders/log-call']];
test('all clinic endpoints reject anonymous access before any database query', async () => {
  for (const [method, path] of endpoints) assert.equal((await request(null, method, path, method === 'GET' ? undefined : {})).status, 401, path);
  assert.equal(calls.length, 0);
});
test('expired and unverified sessions cannot load clinic data', async () => {
  assert.equal((await request('expired', 'GET', '/state')).status, 401);
  const user = users[sha256('session-owner')]; user.mobile_verified = false;
  try { assert.equal((await request('owner', 'GET', '/state')).status, 403); } finally { user.mobile_verified = true; }
});
for (const role of roles) test(`${role} state uses the proper record scope and audit visibility`, async () => {
  const { status, data } = await request(role, 'GET', '/state'); assert.equal(status, 200);
  const scoped = ['owner', 'vet'].includes(role);
  assert.deepEqual(data.data.pets.map(p => p.id), scoped ? ['p1'] : ['p1', 'p2']);
  assert.deepEqual(data.data.appts.map(a => a.id), scoped ? ['a1'] : ['a1', 'a2']);
  const apptQuery = calls.find(c => c.sql.startsWith('SELECT * FROM appointments'));
  if (scoped) { assert.match(apptQuery.sql, /WHERE/); assert.ok(apptQuery.params.length); }
  assert.equal(calls.some(c => c.sql.startsWith('SELECT * FROM audit_logs')), role === 'admin');
  assert.deepEqual(data.data.log, []);
});
for (const role of roles) test(`${role} cannot spoof actorRole to gain another role's privileges`, async () => {
  const forbidden = role === 'admin' ? endpoints.filter(([m,path]) => m !== 'GET' && !path.startsWith('/admin/')) : role === 'owner' ? [['POST', '/consultations'], ['POST', '/appointments/a1/billing'], ['POST', '/walk-in'], ['POST', '/logs'], ['POST', '/pet-requests/r1/approve']] : role === 'assistant' ? [['POST', '/consultations'], ['POST', '/vaccinations'], ['GET', '/logs'], ['POST', '/logs']] : [['POST', '/appointments'], ['PUT', '/appointments/a1'], ['POST', '/appointments/a1/billing'], ['POST', '/walk-in'], ['POST', '/pet-requests/r1/approve'], ['GET', '/logs']];
  for (const [method, path] of forbidden) {
    const result = await request(role, method, path, method === 'GET' ? undefined : { actorRole: 'admin', actorName: 'Forged', petId: 'p1', status: 'Completed' });
    assert.ok([403, 410].includes(result.status), `${method} ${path}: ${result.status}`);
  }
  assert.equal(calls.some(c => /^(INSERT|UPDATE|DELETE) /.test(c.sql)), false);
});
test('owner cannot read or mutate another owner through IDs, pet photos or requests', async () => {
  for (const [method, path, body] of [['POST', '/appointments', { petId: 'p2' }], ['PUT', '/appointments/a2', {}], ['PATCH', '/appointments/a2/status', { status: 'Cancelled' }], ['POST', '/pets/p2/photo', { photo: '' }], ['DELETE', '/pet-requests/r2', {}]]) assert.equal((await request('owner', method, path, body)).status, 404, path);
  assert.equal(calls.some(c => /^(INSERT|UPDATE|DELETE) /.test(c.sql)), false);
});
test('owner registration request uses session identity, ignoring supplied owner and actor IDs', async () => {
  const result = await request('owner', 'POST', '/pet-requests', { ownerId: 'o2', actorName: 'Forged', actorRole: 'admin', name: 'New pet', species: 'Cat', birth: '2025-01-01',sex:'Female',weight:4,neutered:'Not sure' });
  assert.equal(result.status, 200); assert.equal(result.data.request.owner_id, 'o1');
  assert.equal(db.logs.at(-1).user_name, 'Synthetic owner'); assert.equal(db.logs.at(-1).user_role, 'owner');
});
test('owner booking cannot set invoice pricing or overwrite existing ID through upsert', async () => {
  const result = await request('owner', 'POST', '/appointments', { id: 'new', petId: 'p1', vetId: 'v1', date: futureDate(), time: '10:00', reason: 'Visit', amount: -99 });
  assert.equal(result.status, 200); assert.equal(result.data.appointment.amount, 600);
  assert.doesNotMatch(calls.find(c => c.sql.startsWith('INSERT INTO appointments')).sql, /ON CONFLICT/);
});
test('owner can cancel own upcoming visit but cannot inject vitals, billing or completion', async () => {
  assert.equal((await request('owner', 'PATCH', '/appointments/a1/status', { status: 'Completed' })).status, 409);
  assert.equal((await request('owner', 'PATCH', '/appointments/a1/status', { status: 'Cancelled', intakeVitals: {} })).status, 409);
  assert.equal((await request('owner', 'PATCH', '/appointments/a1/status', { status: 'Cancelled', billingStatus: 'Paid' })).status, 409);
  assert.equal((await request('owner', 'PATCH', '/appointments/a1/status', { status: 'Cancelled', cancelReason: 'Schedule conflict' })).status, 200);
  assert.equal(db.appts[0].status, 'Cancelled');
});
test('assistant check-in persists reason and measured vitals without the previous ReferenceError', async () => {
  const result = await request('assistant', 'PATCH', '/appointments/a1/status', { status: 'Checked-in', reason: 'Exam', intakeVitals: { weight: 5.1, temp: 38.6 }, actorName: 'Forged', actorRole: 'vet' });
  assert.equal(result.status, 200); assert.equal(db.appts[0].status, 'Checked-in'); assert.equal(db.appts[0].intake_vitals.weight, 5.1);
  const update = calls.find(c => c.sql.startsWith('UPDATE appointments')); assert.match(update.sql, /reason =/); assert.ok(update.params.includes('Exam'));
  assert.equal(db.logs.at(-1).user_role, 'assistant'); assert.equal(db.logs.at(-1).user_name, 'Synthetic assistant');
});
test('check-in rejects missing/nonfinite/out-of-range vitals and invalid state transitions', async () => {
  for (const intakeVitals of [undefined, {}, { weight: 0, temp: 38 }, { weight: 5, temp: 100 }, { weight: '5', temp: 38 }]) assert.equal((await request('assistant', 'PATCH', '/appointments/a1/status', { status: 'Checked-in', intakeVitals })).status, 409);
  db.appts[0].status = 'Completed';
  assert.equal((await request('assistant', 'PATCH', '/appointments/a1/status', { status: 'Checked-in', intakeVitals: { weight: 5, temp: 38.5 } })).status, 409);
  assert.equal(calls.some(c => c.sql.startsWith('UPDATE appointments')), false);
});
test('failed check-in rolls back and returns failure', async () => {
  failSql = /^UPDATE appointments/;
  assert.equal((await request('assistant', 'PATCH', '/appointments/a1/status', { status: 'Checked-in', intakeVitals: { weight: 5, temp: 38.5 } })).status, 500);
  assert.equal(db.appts[0].status, 'Scheduled'); assert.equal(rollbacks, 1);
});
test('only assigned doctor starts consultation; no direct completion bypass', async () => {
  db.appts[0].status = 'Checked-in'; db.appts[1].status = 'Checked-in';
  assert.equal((await request('vet', 'PATCH', '/appointments/a2/status', { status: 'In consultation' })).status, 403);
  assert.equal((await request('assistant', 'PATCH', '/appointments/a1/status', { status: 'In consultation' })).status, 409);
  assert.equal((await request('vet', 'PATCH', '/appointments/a1/status', { status: 'In consultation' })).status, 200);
  assert.equal((await request('vet', 'PATCH', '/appointments/a1/status', { status: 'Completed' })).status, 409);
});
const soap = () => ({ id: 'c1', petId: 'p1', apptId: 'a1', vetId: 'spoofed', date: '2026-10-24', symptoms: 'Complaint', objective: 'Exam', diagnosis: 'Assessment', treatment: 'Plan', prescription: '', vaccination: { id: 'v-new', vaccine: 'Anti-rabies', brand: 'Synthetic brand', batch: 'SYNTHETIC', nextDue: '2027-10-24' } });
test('SOAP requires clinical fields and an assigned encounter', async () => {
  db.appts[0].status = 'In consultation';
  assert.equal((await request('vet', 'POST', '/consultations', { ...soap(), diagnosis: '' })).status, 400);
  assert.equal((await request('vet', 'POST', '/consultations', { ...soap(), petId: 'p2', apptId: 'a2' })).status, 403);
  assert.equal((await request('vet', 'POST', '/consultations', { ...soap(), vaccination: { ...soap().vaccination, batch: '' } })).status, 400);
  assert.equal(db.consults.length, 0);
});
test('finalization commits notes, vaccine, doctor identity and Completed together', async () => {
  db.appts[0].status = 'In consultation';
  const result = await request('vet', 'POST', '/consultations', soap());
  assert.equal(result.status, 200); assert.equal(db.consults[0].vet_id, 'v1'); assert.equal(db.vaccs[0].vet_id, 'v1'); assert.equal(db.vaccs[0].card_id, 'VACC-SYNTHETIC'); assert.equal(db.appts[0].status, 'Completed'); assert.equal(db.logs.at(-1).user_role, 'vet');
});
for (const failure of [/INSERT INTO vaccinations/, /SET status = 'Completed'/, /INSERT INTO audit_logs/]) test(`finalization rolls back every clinical write on ${failure}`, async () => {
  db.appts[0].status = 'In consultation'; failSql = failure;
  assert.equal((await request('vet', 'POST', '/consultations', soap())).status, 500);
  assert.equal(db.consults.length, 0); assert.equal(db.vaccs.length, 0); assert.equal(db.appts[0].status, 'In consultation'); assert.equal(rollbacks, 1);
});
const bill = () => ({ amount: 450, discount: 50, billingStatus: 'Paid', paymentMethod: 'Cash', cashTendered: 500, invoiceItems: [{ catalogId: 'srv_consult', name: 'Routine General Consultation & Exam', price: 500, qty: 1 }] });
test('billing rejects invalid amount, quantity, discount, channel, cash and reference', async () => {
  for (const body of [{ ...bill(), amount: -1 }, { ...bill(), discount: -50 }, { ...bill(), paymentMethod: 'Invalid' }, { ...bill(), cashTendered: 100 }, { ...bill(), paymentMethod: 'Maya' }, { ...bill(), invoiceItems: [{ name: 'Bad', price: 600, qty: 0.5 }] }]) assert.equal((await request('assistant', 'POST', '/appointments/a1/billing', body)).status, 400);
  assert.equal(calls.some(c => c.sql.startsWith('UPDATE appointments')), false);
});
test('billing requires a completed clinical record and rejects repeat payment', async () => {
  assert.equal((await request('assistant', 'POST', '/appointments/a1/billing', bill())).status, 409);
  db.appts[0].status = 'Completed';
  assert.equal((await request('assistant', 'POST', '/appointments/a1/billing', bill())).status, 409);
  db.consults.push({ id: 'c1', appt_id: 'a1' });
  const result = await request('assistant', 'POST', '/appointments/a1/billing', bill());
  assert.equal(result.status, 200); assert.equal(result.data.appointment.discount, 50); assert.equal(result.data.appointment.changeAmount, 50); assert.equal(db.appts[0].billing_status, 'Paid');
  assert.equal((await request('assistant', 'POST', '/appointments/a1/billing', bill())).status, 409);
});
test('database access failure fails closed instead of authorizing a mutation', async () => {
  failSql = /SELECT id, owner_id FROM pets/;
  assert.equal((await request('owner', 'POST', '/appointments', { petId: 'p1' })).status, 500);
  assert.equal(calls.some(c => c.sql.startsWith('INSERT')), false);
});

test('assistant may remeasure vitals while waiting, without reopening a completed visit', async () => {
  db.appts[0].status = 'Checked-in';
  assert.equal((await request('assistant', 'PATCH', '/appointments/a1/status', { status: 'Checked-in', intakeVitals: { weight: 5.3, temp: 38.5 } })).status, 200);
  assert.equal(db.appts[0].intake_vitals.weight, 5.3);
  db.appts[0].status = 'In consultation';
  assert.equal((await request('assistant', 'PATCH', '/appointments/a1/status', { status: 'Checked-in', intakeVitals: { weight: 5.3, temp: 38.5 } })).status, 409);
});

test('booking and walk-in reject nonexistent doctors instead of creating invisible queues', async () => {
  assert.equal((await request('owner', 'POST', '/appointments', { petId: 'p1', vetId: 'not-a-doctor' })).status, 400);
  assert.equal((await request('assistant', 'POST', '/walk-in', { addToQueue: true, vetId: 'not-a-doctor' })).status, 400);
  assert.equal(calls.some(c => c.sql.startsWith('INSERT')), false);
});

test('checkout rolls back payment if its durable audit write fails', async () => {
  db.appts[0].status = 'Completed'; db.consults.push({ id: 'c1', appt_id: 'a1' });
  failSql = /INSERT INTO audit_logs/;
  assert.equal((await request('assistant', 'POST', '/appointments/a1/billing', bill())).status, 500);
  assert.equal(db.appts[0].billing_status, 'Unbilled'); assert.equal(rollbacks, 1);
});

test('availability reveals only open slot strings and accounts for another owner reservation', async () => {
  const date=futureDate();
  db.appts.push({id:'other-reservation',pet_id:'p2',vet_id:'v1',date,time:'10:00',duration_minutes:120,status:'Scheduled'});
  const r=await request('owner','GET',`/appointments/availability?vetId=v1&date=${date}&service=checkup`);
  assert.equal(r.status,200); assert.deepEqual(Object.keys(r.data),['slots']);
  assert.ok(r.data.slots.every(s=>/^\d{2}:\d{2}$/.test(s))); assert.ok(!r.data.slots.includes('11:30')); assert.ok(r.data.slots.includes('12:00'));
});
test('availability excludes only the caller own appointment',async()=>{
  assert.equal((await request('owner','GET',`/appointments/availability?vetId=v1&date=${futureDate()}&service=checkup&excludeId=a2`)).status,404);
});
test('server rejects invalid booking dates, slot grids and conflicting durations',async()=>{
  for (const patch of [{date:'2026-02-30'},{date:'2099-01-01'},{time:'10:15'},{time:'16:30'},{service:'invalid'}]) {
    const r=await request('owner','POST','/appointments',{petId:'p1',vetId:'v1',date:futureDate(),time:'10:00',reason:'Annual checkup',...patch});
    assert.equal(r.status,400,JSON.stringify(patch));
  }
  db.appts.push({id:'other',pet_id:'p2',vet_id:'v1',date:futureDate(),time:'09:30',duration_minutes:120,status:'Scheduled'});
  assert.equal((await request('owner','POST','/appointments',{petId:'p1',vetId:'v1',date:futureDate(),time:'10:30',reason:'Checkup'})).status,409);
});
test('owners cannot bypass reservation validation by calling a booking a walk-in',async()=>{
  assert.equal((await request('owner','POST','/appointments',{petId:'p1',vetId:'v1',bookingKind:'walk-in',date:'2000-01-01',time:'10:15',reason:'Checkup'})).status,400);
});
test('only reception and administrators can inspect automatic reminder status',async()=>{
  for (const role of ['owner','vet']) assert.equal((await request(role,'GET','/reminders/status')).status,403);
  for (const role of ['vet','admin']) assert.equal((await request(role,'GET',`/appointments/availability?vetId=v1&date=${futureDate()}&service=checkup`)).status,403);
});


test('checkout inbox and claims are reception-only, including spoofed role fields',async()=>{
 for(const role of ['owner','vet','admin']) {
  assert.equal((await request(role,'GET','/checkout-inbox')).status,403);
  for(const action of ['claim','renew','release'])assert.equal((await request(role,'POST',`/checkout-inbox/a1/${action}`,{actorRole:'assistant'})).status,403);
 }
});
