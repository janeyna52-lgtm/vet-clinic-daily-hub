import { useState, useRef } from "react";
import { PawPrint, Printer, RotateCw, Calendar, CheckCircle2, Clock, CreditCard, Receipt, ArrowRight, X } from "lucide-react";
import { Badge, VETS, TODAY, ICON, I, moveAppt, uid } from "../lib.jsx";
import { Avatar, Icon, toSquare } from "./owner/ui.jsx";
import { formatSpeciesLabel, computeAgeDetails } from "../preventiveSchedule.js";
import { auth, OFFLINE_MSG } from "../authApi.js";
import { isVet } from "./clinicValidation.js";

const CLINIC = {
  name: "PawCare Veterinary Clinic",
  subtitle: "Animal Health Passport & Official Immunization Record",
  address: "128 Rizal Avenue, Caloocan City, Metro Manila",
  phone: "+63 (02) 8352-8899 / 0917-888-PAWS",
  email: "care@pawcareclinic.ph",
  license: "BAI Reg. No. 2024-0891 • PVMA Accredited"
};

function parseDateSafe(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(s.slice(0, 10) + "T00:00:00");
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function stateOf(v) {
  if (v.done) return "Completed";
  if (!v.nextDue) return "On track";
  const now = new Date(TODAY + "T00:00:00");
  const target = parseDateSafe(v.nextDue);
  if (!target) return "On track";
  const diffDays = Math.ceil((target - now) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return "Overdue";
  if (diffDays <= 14) return "Due soon";
  return "On track";
}

export default function PetCardModal({ petId, appt, db, setDb, me, onClose, onBook, onCheckIn, onBill }) {
  const [actionError, setActionError] = useState("");
  const p = (db.pets || []).find(x => x.id === petId) || (db.pets || [])[0] || {};
  const o = (db.owners || []).find(x => x.id === p.ownerId) || {};
  const [isFlipped, setIsFlipped] = useState(false);
  const fileInputRef = useRef(null);

  if (!p.id) return null;

  const activeAppt = appt || (db.appts || []).find(a => a.petId === p.id && a.date === TODAY && a.status !== "Cancelled");
  const ageDetails = p.birth ? computeAgeDetails(p.birth) : null;
  const vaccs = (db.vacc || db.vaccs || [])
    .filter(v => v.petId === p.id)
    .filter((v, idx, arr) => {
      // If uncompleted placeholder exists but a completed shot of the same type is already present, filter out placeholder
      if (!v.done) {
        const hasCompleted = arr.some(other =>
          other.id !== v.id &&
          other.done &&
          (
            (other.vaccine?.toLowerCase().includes("rabies") && v.vaccine?.toLowerCase().includes("rabies")) ||
            (other.vaccine?.toLowerCase().includes("dhpp") && v.vaccine?.toLowerCase().includes("dhpp")) ||
            (other.vaccine?.toLowerCase().includes("5-in-1") && v.vaccine?.toLowerCase().includes("5-in-1")) ||
            (other.vaccine?.toLowerCase().includes("deworm") && v.vaccine?.toLowerCase().includes("deworm")) ||
            other.vaccine?.toLowerCase() === v.vaccine?.toLowerCase()
          )
        );
        if (hasCompleted) return false;
      }
      return true;
    })
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const count = s => vaccs.filter(v => stateOf(v) === s).length;
  const cardIdFormatted = p.vaccinationCardId || "Awaiting clinic-issued card";

  const savePhoto = async photo => {
    try {
      const r = await auth.petPhoto(p.id, photo);
      const updatedPet = r?.pet || { ...p, photo };
      setDb(d => ({
        ...d,
        pets: (d.pets || []).map(x => x.id === p.id ? { ...x, ...updatedPet, photo } : x)
      }));
    } catch (err) {
      console.warn("Photo save error:", err);
    }
  };

  const handlePhotoFileChange = async e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const squareBase64 = await toSquare(file);
      await savePhoto(squareBase64);
    } catch (_) {}
  };

  return (
    <div className="scrim" onMouseDown={e => e.target === e.currentTarget && onClose()} style={{ zIndex: 1000, display: "grid", placeItems: "center", padding: "16px" }}>
      <div className="modal" style={{ width: "min(880px, 100%)", maxHeight: "92vh", overflowY: "auto", padding: "20px 24px" }}>
        
        {actionError && <p className="err" role="alert">{actionError}</p>}
        {/* Top Control Bar */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px", marginBottom: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <PawPrint size={22} color="var(--navy)" />
            <h3 style={{ margin: 0, color: "var(--navy)", fontSize: "1.25rem" }}>
              {p.name}&rsquo;s Health Passport &amp; Digital Vaccination Card
            </h3>
            <span style={{ background: "#dcfce7", color: "#166534", fontSize: "11px", fontWeight: 700, padding: "2px 8px", borderRadius: "99px" }}>
              Official BAI Record
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              type="button"
              className="btn sm gold"
              onClick={() => setIsFlipped(!isFlipped)}
              style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: "6px" }}
            >
              <RotateCw size={14} />
              <span>{isFlipped ? "Flip to Page 1 (Bio)" : "Flip to Page 2 (Immunization Log)"}</span>
            </button>
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => window.print()}
              title="Print official document"
              style={{ display: "flex", alignItems: "center", gap: "6px" }}
            >
              <Printer size={14} />
              <span>Print Card</span>
            </button>
            <button
              type="button"
              className="btn sm ghost"
              onClick={onClose}
              aria-label="Close" style={{ padding: "6px 10px" }}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Appointment & Clinical Visit Actions Bar (shows when opened for an appointment) */}
        {activeAppt && (
          <div style={{
            background: "linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)",
            border: "1.5px solid #cbd5e1",
            borderRadius: "14px",
            padding: "12px 18px",
            marginBottom: "16px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "12px"
          }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <span style={{ fontSize: "13.5px", fontWeight: 700, color: "var(--navy)", display: "flex", alignItems: "center", gap: "4px" }}>
                  <Calendar size={15} /> Visit: {activeAppt.date} at {activeAppt.time}
                </span>
                <Badge v={activeAppt.status} />
                {activeAppt.billingStatus === "Paid" ? (
                  <span style={{ background: "#dcfce7", color: "#166534", fontSize: "11.5px", fontWeight: 700, padding: "2px 8px", borderRadius: "6px" }}>
                    Paid (₱{activeAppt.amount})
                  </span>
                ) : activeAppt.status === "Completed" ? (
                  <span style={{ background: "#fef3c7", color: "#92400e", fontSize: "11.5px", fontWeight: 700, padding: "2px 8px", borderRadius: "6px" }}>
                    Ready for Checkout (₱{activeAppt.amount || 600})
                  </span>
                ) : null}
              </div>
              <div style={{ fontSize: "12.5px", color: "#475569", marginTop: "3px" }}>
                <b>Reason:</b> {activeAppt.reason || "General Consultation"} &bull; <b>Veterinarian:</b> {(VETS.find(v => v[0] === activeAppt.vetId) || [])[1] || "Dr. Cruz"}
              </div>
            </div>

            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
              {/* If booked for TODAY */}
              {activeAppt.date === TODAY && (
                <>
                  {activeAppt.status === "Scheduled" && me?.role === "assistant" && (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => {
                        moveAppt(setDb, activeAppt.id, "Confirmed", me, setActionError);
                      }}
                      style={{ fontWeight: 600 }}
                    >
                      Confirm Appointment
                    </button>
                  )}

                  {["Scheduled", "Confirmed"].includes(activeAppt.status) && me?.role === "assistant" && (
                    <button
                      type="button"
                      className="btn sm gold"
                      onClick={() => {
                        onClose();
                        onCheckIn && onCheckIn(activeAppt);
                      }}
                      style={{ fontWeight: 700 }}
                      title="Record patient intake vitals and triage"
                    >
                      Check in &amp; Record Vitals
                    </button>
                  )}

                  {activeAppt.status === "Checked-in" && me?.role === "assistant" && (
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={() => {
                        onClose();
                        onCheckIn && onCheckIn(activeAppt);
                      }}
                      title="Adjust recorded intake vitals"
                    >
                      Edit Vitals
                    </button>
                  )}
                </>
              )}

              {/* If booked for a FUTURE date */}
              {activeAppt.date !== TODAY && (
                <>
                  {activeAppt.status === "Scheduled" && me?.role === "assistant" && (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => {
                        moveAppt(setDb, activeAppt.id, "Confirmed", me, setActionError);
                      }}
                      style={{ fontWeight: 600 }}
                    >
                      Confirm Booking ({activeAppt.date})
                    </button>
                  )}

                  {["Scheduled", "Confirmed"].includes(activeAppt.status) && me?.role === "assistant" && (
                    <button
                      type="button"
                      className="btn sm gold"
                      onClick={() => {
                        onClose();
                        onCheckIn && onCheckIn(activeAppt);
                      }}
                      style={{ fontWeight: 700 }}
                      title="Client showed up early today! Move visit to today and check in"
                    >
                      Arrived Early Today? Check in Now
                    </button>
                  )}
                </>
              )}

              {/* Bill / Pay: strictly ONLY when appointment is Completed, or if Paid show Receipt */}
              {activeAppt.status === "Completed" && (me?.role === "assistant" || activeAppt.billingStatus === "Paid") && (
                <button
                  type="button"
                  className={`btn sm ${activeAppt.billingStatus === "Paid" ? "ghost" : "gold"}`}
                  onClick={() => {
                    onClose();
                    onBill && onBill(activeAppt);
                  }}
                  style={{ fontWeight: 700, display: "inline-flex", alignItems: "center", gap: "6px" }}
                  title="Search clinic prices, invoice items, and record payment"
                >
                  <Receipt size={15} />
                  <span>{activeAppt.billingStatus === "Paid" ? "View Paid Receipt" : "Settle Bill / Checkout"}</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* If no appointment exists for this pet */}
        {!activeAppt && me?.role === "assistant" && (
          <div style={{
            background: "#f8fafc",
            border: "1px dashed #cbd5e1",
            borderRadius: "14px",
            padding: "10px 16px",
            marginBottom: "16px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "10px"
          }}>
            <span style={{ fontSize: "12.5px", color: "#64748b" }}>
              Patient has no active appointment on record today.
            </span>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => {
                  onClose();
                  onBook && onBook();
                }}
              >
                + Schedule Future Visit
              </button>
              <button
                type="button"
                className="btn sm gold"
                onClick={() => {
                  const newAppt = {
                    id: "a_" + uid(),
                    petId: p.id,
                    vetId: "v1",
                    date: TODAY,
                    time: new Date().toLocaleTimeString("en-PH", { hour12: false, hour: "2-digit", minute: "2-digit" }),
                    reason: "Walk-in Consultation & Routine Exam",
                    status: "Scheduled",
                    billingStatus: "Unbilled",
                    amount: 600
                  };
                  setDb(prev => ({
                    ...prev,
                    appts: [newAppt, ...(prev.appts || [])]
                  }));
                  onClose();
                  onCheckIn && onCheckIn(newAppt);
                }}
                style={{ fontWeight: 700 }}
              >
                Check in as Today&rsquo;s Walk-in
              </button>
            </div>
          </div>
        )}

        {/* 3D Flip Card Container */}
        <div style={{ perspective: "1500px", minHeight: "440px" }}>
          <div style={{
            position: "relative",
            width: "100%",
            transition: "transform 0.6s cubic-bezier(0.4, 0.2, 0.2, 1)",
            transformStyle: "preserve-3d",
            transform: isFlipped ? "rotateY(180deg)" : "rotateY(0deg)",
            borderRadius: "18px",
            boxShadow: "0 10px 30px rgba(15, 23, 42, 0.12)",
            background: "#fff",
            border: "1px solid #cbd5e1"
          }}>

            {/* ---------- FRONT PAGE (PAGE 1: BIO & PASSPORT) ---------- */}
            <div style={{
              backfaceVisibility: "hidden",
              WebkitBackfaceVisibility: "hidden",
              display: isFlipped ? "none" : "block",
              borderRadius: "18px",
              overflow: "hidden"
            }}>
              {/* Header Banner */}
              <div style={{ background: "linear-gradient(135deg, #1e3a8a 0%, #1e40af 100%)", color: "#fff", padding: "14px 22px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <span style={{ fontSize: "10px", fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase", color: "#93c5fd" }}>
                      Republic of the Philippines &bull; Department of Agriculture (BAI)
                    </span>
                    <h3 style={{ margin: "2px 0 0", color: "#fff", fontSize: "1.2rem", fontWeight: 800 }}>
                      {CLINIC.name}
                    </h3>
                    <div style={{ fontSize: "11px", color: "#cbd5e1" }}>
                      {CLINIC.subtitle}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <span style={{ fontSize: "10px", color: "#93c5fd", textTransform: "uppercase" }}>Registration Number</span>
                    <div style={{ fontWeight: 800, color: "#fef08a", fontSize: "13px", letterSpacing: "0.5px" }}>
                      {cardIdFormatted}
                    </div>
                  </div>
                </div>
              </div>

              {/* Bio Layout */}
              <div style={{ padding: "20px 24px", display: "grid", gridTemplateColumns: "110px 1fr", gap: "22px", alignItems: "start" }}>
                {/* Photo with Click-to-upload */}
                <div style={{ textAlign: "center" }}>
                  <div
                    style={{
                      position: "relative",
                      width: 104,
                      height: 104,
                      margin: "0 auto",
                      borderRadius: "16px",
                      overflow: "hidden",
                      border: "3px solid #3b82f6",
                      boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
                      cursor: "pointer"
                    }}
                    onClick={() => fileInputRef.current?.click()}
                    title="Click to upload or update pet picture"
                  >
                    <Avatar src={p.photo} fallback={<Icon n="paw" size={48} />} size={104} />
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={handlePhotoFileChange}
                      hidden
                    />
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                      style={{ position: "absolute", bottom: 4, right: 4, background: "#1e3a8a", color: "#fff", border: "none", borderRadius: "50%", width: 26, height: 26, display: "grid", placeItems: "center", cursor: "pointer" }}
                      title="Update photo"
                    >
                      <Icon n="camera" size={13} />
                    </button>
                    {p.photo && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); savePhoto(""); }}
                        style={{ position: "absolute", top: 4, right: 4, background: "rgba(220, 38, 38, 0.9)", color: "#fff", border: "none", borderRadius: "50%", width: 20, height: 20, display: "grid", placeItems: "center", cursor: "pointer", fontSize: "11px", fontWeight: "bold" }}
                        title="Remove photo" aria-label="Remove photo"
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  <div style={{ marginTop: 6, fontSize: "10.5px", color: "#059669", fontWeight: 800, textTransform: "uppercase" }}>
                    Patient Verified
                  </div>
                </div>

                {/* Patient Master Info */}
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "8px" }}>
                    <h2 style={{ margin: 0, fontSize: "1.6rem", color: "var(--navy)", fontWeight: 800 }}>{p.name}</h2>
                    <span style={{ background: "#dbeafe", color: "#1e40af", padding: "2px 8px", borderRadius: "6px", fontSize: "12px", fontWeight: 700 }}>
                      {formatSpeciesLabel(p.species)}
                    </span>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "8px 16px", fontSize: "13px" }}>
                    <div><span style={{ color: "#64748b", fontSize: "11.5px", display: "block" }}>Breed:</span> <b>{p.breed || "Mixed Breed"}</b></div>
                    <div><span style={{ color: "#64748b", fontSize: "11.5px", display: "block" }}>Sex:</span> <b>{p.sex || "Male"}</b></div>
                    <div><span style={{ color: "#64748b", fontSize: "11.5px", display: "block" }}>Birth Date:</span> <b>{p.birth || "—"}</b></div>
                    <div><span style={{ color: "#64748b", fontSize: "11.5px", display: "block" }}>Weight:</span> <b>{p.weight || "—"} kg</b></div>
                    <div><span style={{ color: "#64748b", fontSize: "11.5px", display: "block" }}>Coat / Markings:</span> <b>{p.color || "Standard"}</b></div>
                    <div><span style={{ color: "#64748b", fontSize: "11.5px", display: "block" }}>Spayed / Neutered:</span> <b>{p.neutered || "No"}</b></div>
                  </div>

                  <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px dashed #cbd5e1", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "8px", fontSize: "12.5px" }}>
                    <div><span style={{ color: "#64748b", display: "block" }}>Registered Owner:</span> <b>{o.name || "Walk-in Owner"}</b></div>
                    <div><span style={{ color: "#64748b", display: "block" }}>Contact:</span> <b>{o.phone || o.email || "No contact"}</b></div>
                    <div><span style={{ color: "#64748b", display: "block" }}>Address:</span> <span style={{ color: "#334155" }}>{o.address || "Metro Manila, PH"}</span></div>
                  </div>
                </div>
              </div>

              {/* Status Metrics Footer */}
              <div style={{ background: "#f8fafc", padding: "12px 24px", borderTop: "1px solid #e2e8f0", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
                <div style={{ display: "flex", gap: "18px", fontSize: "12px" }}>
                  <div><span style={{ color: "#64748b" }}>TOTAL PROTOCOLS:</span> <b style={{ color: "var(--navy)" }}>{vaccs.length}</b></div>
                  <div><span style={{ color: "#64748b" }}>ON TRACK:</span> <b style={{ color: "#059669" }}>{count("On track")}</b></div>
                  <div><span style={{ color: "#64748b" }}>DUE SOON:</span> <b style={{ color: "#d97706" }}>{count("Due soon")}</b></div>
                  <div><span style={{ color: "#64748b" }}>OVERDUE:</span> <b style={{ color: "#dc2626" }}>{count("Overdue")}</b></div>
                </div>

                <button
                  type="button"
                  className="btn sm"
                  onClick={() => setIsFlipped(true)}
                  style={{ display: "flex", alignItems: "center", gap: "6px", fontWeight: 700 }}
                >
                  <span>Turn to Page 2 (Immunization Log)</span>
                  <ArrowRight size={15} />
                </button>
              </div>
            </div>

            {/* ---------- BACK PAGE (PAGE 2: IMMUNIZATION LOG) ---------- */}
            <div style={{
              backfaceVisibility: "hidden",
              WebkitBackfaceVisibility: "hidden",
              display: isFlipped ? "block" : "none",
              transform: "rotateY(180deg)",
              borderRadius: "18px",
              overflow: "hidden"
            }}>
              <div style={{ background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)", color: "#fff", padding: "14px 22px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <h3 style={{ margin: 0, color: "#fff", fontSize: "1.2rem", fontWeight: 800 }}>
                    {p.name}&rsquo;s Immunization &amp; Preventive Log
                  </h3>
                  <div style={{ fontSize: "11px", color: "#94a3b8" }}>
                    Philippine Anti-Rabies Act (RA 9482) Compliant Clinical Record
                  </div>
                </div>
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => setIsFlipped(false)}
                  style={{ background: "#334155", color: "#fff", border: "none" }}
                >
                  ⬅ Back to Page 1
                </button>
              </div>

              {/* Table of Vaccinations */}
              <div style={{ padding: "16px 20px", maxHeight: "360px", overflowY: "auto" }}>
                {vaccs.length ? (
                  <table style={{ width: "100%", fontSize: "12.5px", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ textAlign: "left", color: "#64748b", borderBottom: "2px solid #e2e8f0" }}>
                        <th style={{ padding: "8px 6px" }}>Vaccine / Prevention</th>
                        <th style={{ padding: "8px 6px" }}>Protocol Type</th>
                        <th style={{ padding: "8px 6px" }}>Date Administered</th>
                        <th style={{ padding: "8px 6px" }}>Next Due</th>
                        <th style={{ padding: "8px 6px" }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vaccs.map(v => {
                        const st = stateOf(v);
                        return (
                          <tr key={v.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                            <td style={{ padding: "8px 6px", fontWeight: 700, color: "var(--navy)" }}>
                              {v.vaccine}
                              {v.brand && <small style={{ display: "block", color: "#64748b", fontWeight: 500 }}>{v.brand} {v.batch ? `(${v.batch})` : ""}</small>}
                            </td>
                            <td style={{ padding: "8px 6px", color: "#475569" }}>{v.protocolType || "Routine Preventive"}</td>
                            <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>{v.date || "—"}</td>
                            <td style={{ padding: "8px 6px", whiteSpace: "nowrap", fontWeight: 600 }}>{v.nextDue || "Annual"}</td>
                            <td style={{ padding: "8px 6px" }}>
                              {v.recorded_by?.includes("External") || v.recordedBy?.includes("External") || v.brand?.includes("External") ? (
                                <span style={{
                                  padding: "2px 8px",
                                  borderRadius: "6px",
                                  fontSize: "11px",
                                  fontWeight: 700,
                                  background: "#fef3c7",
                                  color: "#92400e",
                                  border: "1px solid #fde68a"
                                }} title="External clinic record; used as baseline guide for scheduling">
                                  External Guide
                                </span>
                              ) : (
                                <span style={{
                                  padding: "2px 8px",
                                  borderRadius: "6px",
                                  fontSize: "11px",
                                  fontWeight: 700,
                                  background: st === "Completed" ? "#ecfdf5" : st === "Overdue" ? "#fef2f2" : st === "Due soon" ? "#fffbeb" : "#eff6ff",
                                  color: st === "Completed" ? "#047857" : st === "Overdue" ? "#b91c1c" : st === "Due soon" ? "#b45309" : "#1d4ed8"
                                }}>
                                  {st === "Completed" ? "Certified" : st}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <p style={{ textAlign: "center", color: "#64748b", padding: "20px 0" }}>No vaccination records yet.</p>
                )}
              </div>
            </div>

          </div>
        </div>

        {/* Action row */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "16px" }}>
          {onBook && !isVet(me?.role) && (
            <button className="btn gold sm" onClick={() => { onClose(); onBook(p.id); }}>
              + Book Visit for {p.name}
            </button>
          )}
          <button className="btn ghost sm" onClick={onClose}>
            Close
          </button>
        </div>

      </div>
    </div>
  );
}

