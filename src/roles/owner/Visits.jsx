import { useState } from "react";
import { VETS, scope, petName, TODAY } from "../../lib.jsx";
import { useLive, Icon, Modal } from "./ui.jsx";

const fmtDate = d => d ? new Date(d + "T00:00:00").toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" }) : "—";
const vetName = id => (VETS.find(v => v[0] === id) || [])[1] || "—";
const isTouch = () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(pointer: coarse)").matches;

/* Visit History. Double-click a row (Enter on it, or tap on a phone) to open its details in a pop-up card. */
export function OwnerVisits({ db, me }) {
  const [pet, setPet] = useState(""), [q, setQ] = useState(""), [open, setOpen] = useState(null);
  const pets = scope(db, me, "pets");
  const f = useLive({ from: "", to: "" }, v => { const e = {}; if (v.from && v.to && v.from > v.to) e.to = "“To” must be on or after “From”"; return e; });
  const all = scope(db, me, "records").slice().sort((a, b) => b.date.localeCompare(a.date));
  let list = all;
  if (pet) list = list.filter(r => r.petId === pet);
  if (!f.errs.to) list = list.filter(r => (!f.v.from || r.date >= f.v.from) && (!f.v.to || r.date <= f.v.to));
  if (q.trim()) list = list.filter(r => [petName(db, r.petId), vetName(r.vetId), r.diagnosis, r.treatment, r.prescription].join(" ").toLowerCase().includes(q.trim().toLowerCase()));
  const filtered = !!(pet || q.trim() || f.v.from || f.v.to);
  const clear = () => { setPet(""); setQ(""); f.quiet({ from: "", to: "" }); };
  const rowKey = (e, r) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(r); } };
  const cell = { flex: "1 1 150px", minWidth: 0, width: "auto" };
  const wrap = { overflowWrap: "anywhere", whiteSpace: "pre-wrap" };
  return (<div className="vh">
    <div className="vh-filters" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
      <div className="vh-f vh-search" style={{ ...cell, flex: "2 1 260px" }}>
        <label htmlFor="vh-q">Search visits</label>
        <div className="vh-sbox"><Icon n="search" size={16} /><input id="vh-q" className="vh-in" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search pet, vet or diagnosis" /></div>
      </div>
      <div className="vh-f" style={cell}><label htmlFor="vh-pet">Pet</label><select id="vh-pet" className="vh-in" value={pet} onChange={e => setPet(e.target.value)}><option value="">All my pets</option>{pets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
      <div className="vh-f" style={cell}><label htmlFor="vfrom">From date</label><input id="vfrom" className="vh-in" type="date" max={TODAY} value={f.v.from} onChange={e => f.set("from", e.target.value)} /></div>
      <div className="vh-f" style={cell}><label htmlFor="vto">To date</label><input id="vto" className="vh-in" type="date" max={TODAY} value={f.v.to} onChange={e => f.set("to", e.target.value)} aria-invalid={!!f.errs.to} />{f.errs.to && <span className="err">{f.errs.to}</span>}</div>
      {filtered && <button className="btn ghost vh-btn" onClick={clear}>Clear filters</button>}
    </div>
    <p className="vh-count" aria-live="polite"><b>{list.length}</b> visit record{list.length === 1 ? "" : "s"}{filtered ? ` of ${all.length}` : ""}</p>
    {list.length ? <>
      <p className="ow-hint vh-tip">Double-click a visit to see its treatment and prescription. On a phone, tap it.</p>
      <div className="tw"><table className="vh-tbl"><thead><tr><th>Date</th><th>Pet</th><th>Veterinarian</th><th>Diagnosis</th><th className="vh-ch" aria-label="Open" /></tr></thead><tbody>{list.map(r =>
        <tr key={r.id} className="vh-r" tabIndex={0} title="Double-click to see details"
          onDoubleClick={() => setOpen(r)} onClick={() => { if (isTouch()) setOpen(r); }}
          onMouseDown={e => { if (e.detail > 1) e.preventDefault(); }}
          onKeyDown={e => rowKey(e, r)}>
          <td data-label="Date">{fmtDate(r.date)}</td><td data-label="Pet">{petName(db, r.petId)}</td><td data-label="Veterinarian">{vetName(r.vetId)}</td><td data-label="Diagnosis">{r.diagnosis}</td>
          <td className="vh-ch" aria-hidden="true"><Icon n="chevron" size={18} /></td>
        </tr>)}</tbody></table></div>
    </> : <div className="empty"><div><Icon n="file" size={34} /></div>{all.length ? "No visits match these filters." : "No visit records yet. They appear here after your pet is seen by the vet."}</div>}

    {open && <Modal title={`${petName(db, open.petId)} · ${fmtDate(open.date)}`} onClose={() => setOpen(null)}>
      <div style={{ maxHeight: "70vh", overflowY: "auto", paddingRight: 2 }}>
        <dl style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12, margin: 0 }}>
          {[["Care status", open.careStatus || "Routine care"], ...(open.followUpDate ? [["Follow-up target", open.followUpDate], ["Follow-up instructions", open.followUpReason]] : []), ["Veterinarian", vetName(open.vetId)], ["Diagnosis", open.diagnosis], ["Treatment", open.treatment || "—"], ["Prescription", open.prescription || "None prescribed"], open.notes ? ["Notes", open.notes] : null].filter(Boolean).map(([k, x]) =>
            <div key={k}><dt style={{ fontSize: 12.5, fontWeight: 700, color: "var(--mu)" }}>{k}</dt><dd style={{ margin: "2px 0 0", ...wrap }}>{x}</dd></div>)}
        </dl>
      </div>
      <div className="row end" style={{ marginTop: 14 }}><button className="btn" onClick={() => setOpen(null)}>Close</button></div>
    </Modal>}
  </div>);
}