import HandoffModal from "./HandoffModal.jsx";
import VaccinationCards from "./VaccinationCards.jsx";
import { useState } from "react";
import { AlertTriangle, Thermometer, Scale, CalendarDays, Search, Play, FileText } from "lucide-react";
import { I, M, Stats, Hero, TODAY, plus, moveAppt, petName, ICON, Badge } from "../lib.jsx";
import SoapConsultationModal from "./SoapConsultationModal.jsx";
import ClinicCalendar from "./ClinicCalendar.jsx";
import ClientsAndPatientsPage from "./ClientsAndPatientsPage.jsx";
import ConsultationsPage from "./ConsultationsPage.jsx";

const doctorName = n => { const s = String(n || "").trim(); return /^dr\.?\s/i.test(s) ? s : `Dr. ${s}`; };
const tempTone = s => (s === "normal" ? "" : s === "high_fever" || s === "hypothermia" ? "er" : "wa");
const weightTone = s => (s === "ideal" ? "" : "wa");

function Dash({ db, setDb, me, go, say }) {
  const [handoff, setHandoff] = useState(null);
  const [activeSoap, setActiveSoap] = useState(null); // { appt, pet }
  const [scope, setScope] = useState("my");          // "all" = whole clinic, "my" = assigned to this doctor

  const isMyVet = a => {
    if (a.vetId === me.id || (me.vetId && a.vetId === me.vetId)) return true;
    return false;
  };

  const todayAppts = (db.appts || []).filter(a => (a.date === TODAY || ["Checked-in", "In consultation"].includes(a.status)) && a.status !== "Cancelled");
  const scoped = scope === "all" ? todayAppts : todayAppts.filter(isMyVet);
  // Workflow: the doctor only sees patients the front desk has already checked in (Scheduled / Confirmed stay at the front desk).
  const queue = scoped.filter(a => ["Checked-in", "In consultation", "Completed"].includes(a.status)).sort((a, b) => a.time.localeCompare(b.time));
  const notArrived = scoped.filter(a => ["Scheduled", "Confirmed"].includes(a.status)).length;
  const waiting = queue.filter(a => a.status === "Checked-in");
  const inConsult = queue.filter(a => a.status === "In consultation");
  const completed = queue.filter(a => a.status === "Completed");
  const due = (db.vacc || []).filter(v => v.nextDue && !v.done && v.nextDue <= plus(14));
  const allWaiting = todayAppts.filter(a => a.status === "Checked-in");
  const myWaiting = todayAppts.filter(a => isMyVet(a) && a.status === "Checked-in");

  const startConsult = async a => {
    const pet = db.pets.find(p => p.id === a.petId);
    if (!pet) return say("Patient record not found.");
    // Front desk normally records intake vitals first; warn the doctor, but never block care.
    if (!a.intakeVitals) say("No intake vitals on file for this patient. Record them in the SOAP notes.");
    if (!await moveAppt(setDb, a.id, "In consultation", me, say)) return;
    setActiveSoap({ appt: { ...a, status: "In consultation" }, pet });
  };

  const openEmr = petId => {
    const pet = db.pets.find(p => p.id === petId);
    if (!pet) return;
    setActiveSoap({ appt: queue.find(x => x.petId === petId) || null, pet });
  };

  return (
    <>
      <Hero
        title={`Clinical Desk: ${doctorName(me.name)}`}
        text={`${waiting.length} checked-in patient${waiting.length === 1 ? "" : "s"} waiting in your queue today.`}
        icons={["stethoscope", "dog"]}
      >
        <div className="sf-actions">
          {waiting.length > 0 && (
            <button className="btn gold" onClick={() => startConsult(waiting[0])}>
              <Play size={16} aria-hidden="true" />Start next consultation ({petName(db, waiting[0].petId)})
            </button>
          )}
          <button className="btn" onClick={() => go("cal")}><CalendarDays size={16} aria-hidden="true" />Schedule calendar</button>
          <button className="btn" onClick={() => go("pets")}><Search size={16} aria-hidden="true" />Search patient EMR</button>
        </div>
      </Hero>

      <Stats
        items={[
          ["stethoscope", queue.length, "Checked in today"],
          ["clock", waiting.length, "Waiting in queue"],
          ["file", inConsult.length, "In consultation"],
          ["check", completed.length, "Completed today"],
          ["syringe", due.length, "Vaccines due soon"],
        ]}
      />

      <section className="card" style={{ marginTop: 16 }}>
        <div className="sf-section-hd">
          <div>
            <h3>Active clinical queue</h3>
            <p>Patients checked in by the front desk appear here for examination and SOAP notes.{notArrived > 0 ? ` ${notArrived} more expected today, not yet checked in.` : ""}</p>
          </div>
          <div className="sf-toolbar">
            <div className="sf-seg" role="group" aria-label="Queue scope">
              <button type="button" aria-pressed={scope === "all"} onClick={() => setScope("all")}>All clinic ({allWaiting.length})</button>
              <button type="button" aria-pressed={scope === "my"} onClick={() => setScope("my")}>My patients ({myWaiting.length})</button>
            </div>
          </div>
        </div>

        {queue.length ? (
          <div className="sf-grid">
            {queue.map(a => {
              const p = db.pets.find(x => x.id === a.petId) || {};
              const o = db.owners.find(x => x.id === p.ownerId) || {};
              const iv = a.intakeVitals;
              const emergency = iv?.triageLevel === "Emergency";
              const rowCls = emergency ? "is-emergency" : a.status === "Checked-in" ? "is-wait" : a.status === "In consultation" ? "is-live" : "";
              return (
                <div key={a.id} className={`sf-row ${rowCls}`}>
                  <div className="sf-row-main">
                    <span className="sf-time">{a.date !== TODAY && <small>{a.date}<br /></small>}{a.time}</span>
                    <span className="sf-species"><I e={ICON[p.species] || "paw"} size={22} /></span>
                    <div className="sf-body">
                      <div className="sf-name">
                        <span>{p.name || "Patient"}</span>
                        <span className="meta">{p.breed || p.species}{o.name ? `, owner ${o.name}` : ""}</span>
                        {p.allergies?.length > 0 && <span className="sf-pill er">Allergic: {p.allergies.join(", ")}</span>}
                        {iv?.triageLevel && iv.triageLevel !== "Routine" && (
                          <span className={`sf-pill ${emergency ? "er" : "wa"}`}><AlertTriangle size={12} aria-hidden="true" />Triage: {iv.triageLevel}</span>
                        )}
                      </div>
                      <div className="sf-reason"><b>Chief complaint:</b> {a.reason}</div>
                      {(a.handoffs || []).map((h, i) => <p key={i} style={{whiteSpace: "pre-wrap"}}><b>Handoff: {h.from} → {h.to}</b> ({new Date(h.at).toLocaleString()})<br />{h.note}</p>)}
                      {iv ? (
                        <div className="sf-chips">
                          <span className={`sf-chip ${tempTone(iv.tempAnalysis?.status)}`}><Thermometer size={12} aria-hidden="true" />{iv.temp}&deg;C, {iv.tempAnalysis?.label || "Normal"}</span>
                          <span className={`sf-chip ${weightTone(iv.weightAnalysis?.status)}`}><Scale size={12} aria-hidden="true" />{iv.weight} kg, {iv.weightAnalysis?.label || "Normal"}{iv.weightAnalysis?.trend ? ` (${iv.weightAnalysis.trend})` : ""}</span>
                          {iv.triageNotes && <span className="sf-chip mu">&ldquo;{iv.triageNotes}&rdquo;</span>}
                        </div>
                      ) : (
                        <div className="sf-sub" style={{ marginTop: 4 }}>Awaiting front desk intake vitals</div>
                      )}
                    </div>
                  </div>

                  <div className="sf-row-act">
                    <Badge v={a.status} />
                    {["Checked-in", "In consultation"].includes(a.status) && <button className="btn sm" onClick={() => setHandoff(a)}>Hand over care</button>}
                    {a.status === "Checked-in" && <button className="btn sm gold" onClick={() => startConsult(a)}>Start consultation</button>}
                    {a.status === "In consultation" && <button className="btn sm gold" onClick={() => setActiveSoap({ appt: a, pet: p })}>Resume SOAP notes</button>}
                    {a.status === "Completed" && <button className="btn sm ghost" onClick={() => openEmr(p.id)}><FileText size={14} aria-hidden="true" />View EMR</button>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="empty sm">No checked-in patients yet. They appear here as soon as the front desk records their vitals.</div>
        )}
      </section>

      {handoff && <HandoffModal appt={handoff} db={db} me={me} setDb={setDb} onClose={() => setHandoff(null)} />}
      {activeSoap && (
        <SoapConsultationModal
          appt={activeSoap.appt}
          pet={activeSoap.pet}
          db={db}
          setDb={setDb}
          me={me}
          onClose={() => setActiveSoap(null)}
          onSaved={() => {
            say(`SOAP consultation saved for ${activeSoap.pet.name}. Visit completed and sent to billing.`);
            setActiveSoap(null);
          }}
        />
      )}
    </>
  );
}

export const vet = {
  portal: "Veterinarian Clinical Desk",
  Dash,
  menu: [
    { k: "home", l: "Clinical Queue", i: "stethoscope", dash: 1, sub: "Live patient queue, SOAP consultation notes and EMR records." },
    { k: "cal", l: "Doctor Schedule", i: "calendar", Page: ClinicCalendar, sub: "Clinic appointment calendar and timetable." },
    { k: "pets", l: "Patient EMR & Masterlist", i: "paw", Page: ClientsAndPatientsPage, sub: "Digital medical records, patient profiles, and official vaccination cards." },
    { k: "records", l: "SOAP Consultations", i: "file", Page: ConsultationsPage, sub: "Certified SOAP consultation notes, clinical diagnoses, and prescriptions." },
    { k: "vacc", l: "Vaccination Cards", i: "syringe", Page: VaccinationCards, sub: "Review patient cards. Certify administered doses through the consultation." },
    { k: "owners", hide: true, Page: ClientsAndPatientsPage },
    { k: "reports", l: "Clinical Reports", i: "chart", rep: 1, sub: "Filter and print clinic consultation summaries." },
  ],
};
