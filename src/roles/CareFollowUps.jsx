import { TODAY, petName } from "../lib.jsx";
import { setPrefill } from "./owner/ui.jsx";
export default function CareFollowUps({db, go, owner = false}) {
  const latest = new Map();
  [...db.records].sort((a,b) => b.date.localeCompare(a.date)).forEach(r => { if (!latest.has(r.petId)) latest.set(r.petId, r); });
  const records = [...latest.values()].filter(r => r.followUpDate && r.careStatus !== 'Routine care');
  if (!records.length) return null;
  return <section className="card"><h3>Follow-up care</h3>{records.map(r => { const booked = db.appts.find(a => a.petId === r.petId && a.date >= r.date && a.id !== r.apptId && ['Scheduled','Confirmed','Checked-in','In consultation'].includes(a.status) && a.date >= TODAY); return <div key={r.id} style={{padding: 12}}><b>{petName(db, r.petId)} · {r.careStatus}</b><p>Target: {r.followUpDate}{!booked && r.followUpDate < TODAY ? ' · Overdue' : ''}</p><p>{r.followUpReason}</p>{booked ? <p>Upcoming visit {booked.date} · {booked.status}. Confirm that it covers this follow-up.</p> : <><p>Appointment not booked yet.</p><button className="btn sm" onClick={() => { if (owner) setPrefill({petId:r.petId, reason:'Consultation', date:r.followUpDate >= TODAY ? r.followUpDate : ''}); go(owner ? 'appts' : 'cal'); }}>Book follow-up</button></>}</div>; })}</section>;
}
