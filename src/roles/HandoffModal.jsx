import { useState } from "react";
import { api } from "../api.js";
import { applyClinicState } from "../clinicState.js";
export default function HandoffModal({ appt, db, me, setDb, onClose }) {
  const [vetId, setVet] = useState(""), [note, setNote] = useState(""), [error, setError] = useState(""), [saving, setSaving] = useState(false);
  async function submit(e) {
    e.preventDefault(); if (saving) return; setSaving(true); setError("");
    try { await api.post(`/api/appointments/${appt.id}/handoff`, {vetId, note}); }
    catch (e) { setError(e.message); setSaving(false); return; }
    // A successful transfer is final even when the subsequent state refresh fails.
    setDb(p => ({...p, appts: p.appts.filter(a => a.id !== appt.id)}));
    try { const state = await api.get('/api/state'); setDb(p => applyClinicState(p, state)); } catch {}
    onClose();
  }
  return <div className="scrim"><form className="modal" onSubmit={submit}><h3>Hand over patient care</h3><p>The receiving veterinarian gets the visit, intake and patient history. Include current findings, care already given and next steps.</p>
  <label>Receiving veterinarian<select required value={vetId} onChange={e => setVet(e.target.value)}><option value="">Choose veterinarian</option>{db.vets.filter(v => ![me.id, me.vetId].includes(v.id)).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
  <label>Handoff instructions<textarea required maxLength={3000} value={note} onChange={e => setNote(e.target.value)} /></label>
  <p>The visit returns to the receiving vet’s waiting queue. Save any relevant draft findings in these instructions before transferring.</p>
  {error && <p role="alert">{error}</p>}<div className="row end"><button type="button" className="btn ghost" disabled={saving} onClick={onClose}>Close</button><button className="btn" disabled={saving}>{saving ? 'Saving…' : 'Transfer care'}</button></div></form></div>;
}
