import CareFollowUps from "./CareFollowUps.jsx";
import Prices from "./owner/Prices.jsx";
import { useState } from "react";
import { I, Hero, ICON, Badge, dueState, scope, TODAY, petName } from "../lib.jsx";
import OwnerAppts from "./owner/Appts.jsx";
import { OwnerVacc } from "./owner/VaccCard.jsx";
import { OwnerVisits } from "./owner/Visits.jsx";
import OwnerHeader from "./owner/Header.jsx";
import { PetFormModal, PetProfileModal, RequestList, myRequests, addBlock } from "./owner/Pets.jsx";
import { setPrefill, petAge, fmt12, Avatar, pick, Icon } from "./owner/ui.jsx";
import "./owner/owner.css";
import "./owner/owner-modern.css";   // keep AFTER owner.css so the refreshed look wins

const LIVE = ["Scheduled", "Confirmed", "Checked-in", "In consultation"];
function Dash({ db, setDb, me, go, say }) {
  const [modal, setModal] = useState(null);   // { form, editing } or { profile }
  const pets = scope(db, me, "pets"), A = scope(db, me, "appts"), V = scope(db, me, "vacc"), reqs = myRequests(db, me);
  const blocked = addBlock(db, me);
  const book = (petId, reason) => { setPrefill(petId ? { petId, reason } : null); go("appts"); };
  const over = V.filter(v => !v.done && v.nextDue && v.nextDue < TODAY);
  const upcoming = A.filter(a => LIVE.includes(a.status) && a.date >= TODAY).length;
  const dueVacc = V.filter(v => !v.done && v.nextDue && dueState(v.nextDue) !== "On track").length;
  const first = me.name.split(" ")[0];
  const steps = [
    ["plus", "Add your pet", "Name, species, birth date and weight.", () => setModal({ form: true })],
    ["clock", "The clinic reviews it", "The front desk checks the details."],
    ["calendar", "Book and track", "Visits, vaccine cards and history unlock."],
  ];

  return (<>
    <section className="ow-hero">
      <img className="ow-hero-pic" src="/images/hero-pets.jpg" alt="" aria-hidden="true" />
      <div className="ow-hero-head">
        <div>
          <h2>Hi {first}!</h2>
          <p>Here’s how your pets are doing.</p>
        </div>
        <div className="ow-hero-acts">
          {pets.length > 0 && <button className="btn gold" onClick={() => book()}><Icon n="calendar" size={16} /> Book a visit</button>}
          <button className={pets.length ? "btn glass" : "btn gold"} disabled={!!blocked} title={blocked} onClick={() => setModal({ form: true })}><Icon n="plus" size={16} /> Add my pet</button>
        </div>
      </div>
      {pets.length > 0 && (
        <ul className="ow-hero-stats" aria-label="Summary">
          <li><b>{pets.length}</b><span>{pets.length === 1 ? "Pet" : "Pets"}</span></li>
          <li><b>{upcoming}</b><span>Upcoming {upcoming === 1 ? "visit" : "visits"}</span></li>
          <li className={dueVacc ? "warn" : ""}><b>{dueVacc}</b><span>{dueVacc === 1 ? "Vaccine" : "Vaccines"} due</span></li>
        </ul>
      )}
      {!pets.length && !reqs.length && (
        <div className="ow-start">
          <p>Let’s set up your first pet. Your account is ready.</p>
          <ol className="ow-steps">
            {steps.map(([ic, t, d, fn], i) => {
              const act = fn ? { role: "button", tabIndex: 0, onClick: fn, onKeyDown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } } } : {};
              return (
                <li key={t} className={fn ? "clickable" : ""} {...act}>
                  <span className="ow-step-ico"><Icon n={ic} size={20} /></span>
                  <div><b>{i + 1}. {t}</b><small>{d}</small></div>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </section>

    {over.length > 0 && <div className="ow-banner"><Icon n="alert" size={20} /><span><b>Vaccine overdue:</b> {over.map(v => `${petName(db, v.petId)} (${v.vaccine})`).join(", ")}</span><button className="btn sm" onClick={() => go("vacc")}>View records</button></div>}
    <CareFollowUps db={db} go={go} owner />
    <RequestList db={db} setDb={setDb} me={me} say={say} onEdit={r => setModal({ form: true, editing: r })} />
    {pets.length ? <div className="petgrid">{pets.map(p => {
      const nv = V.filter(v => v.petId === p.id && v.nextDue && !v.done).sort((a, b) => a.nextDue.localeCompare(b.nextDue))[0];
      const na = A.filter(a => a.petId === p.id && LIVE.includes(a.status) && a.date >= TODAY).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0];
      const nvAppt = nv ? A.find(a => a.petId === p.id && LIVE.includes(a.status) && (a.date === nv.nextDue || (a.date >= TODAY && (a.reason || "").toLowerCase().includes(nv.vaccine.toLowerCase())))) : null;
      return <article className="petcard" key={p.id} role="button" tabIndex={0} aria-label={`${p.name}, open pet details`} onClick={() => setModal({ profile: p })} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setModal({ profile: p }); } }}>
        <div className="pc-top">
          <div className="big"><Avatar src={p.photo} fallback={<I e={ICON[p.species]} size={40} />} size={84} round={false} /></div>
          <div className="pc-id"><h3>{p.name}</h3><p>{p.breed || p.species}</p></div>
        </div>
        <div className="pc-tags">{p.sex && <span>{p.sex}</span>}{p.weight ? <span>{p.weight} kg</span> : null}{p.birth ? <span>{petAge(p.birth)}</span> : null}</div>
        <div className="kv"><span>Next vaccine</span>{nv ? <b>{nv.vaccine} <Badge v={nvAppt ? "Scheduled" : dueState(nv.nextDue)} /></b> : <b>—</b>}</div>
        <div className="kv"><span>Next visit</span><b>{na ? <>{na.date} {fmt12(na.time)} <Badge v={na.status} /></> : "None booked"}</b></div>
        <small className="pc-more">View details <Icon n="chevron" size={14} /></small></article>;
    })}</div> : null}
    {!pets.length && reqs.length > 0 && <div className="empty sm">Your pet will appear here once the clinic approves the request.</div>}
    {modal && modal.form && <PetFormModal db={db} setDb={setDb} me={me} say={say} editing={modal.editing} onClose={() => setModal(null)} />}
    {modal && modal.profile && <PetProfileModal pet={modal.profile} db={db} me={me} onClose={() => setModal(null)} onVacc={() => { pick.petId = modal.profile.id; go("vacc"); }} onBook={(pid, rsn) => book(pid || modal.profile.id, rsn)} />}
  </>);
}
const P = (k, l, i, sub, Page, s) => ({ k, l, i, sub, Page, s });
export const owner = { portal: "Pet Owner Portal", Dash, Header: OwnerHeader, menu: [
  { k: "home", l: "My Pets", s: "Pets", i: "paw", dash: 1, sub: "Your pets, their profiles, next vaccines and visits." },
  P("appts", "My Appointments", "calendar", "Book, change or cancel a visit. Switch between the list and the calendar.", OwnerAppts, "Visits"),
  P("prices", "Services & Prices", "file", "Official clinic service and product prices.", Prices, "Prices"),
  P("vacc", "Vaccination Cards", "syringe", "Pick a pet to see its vaccination card.", OwnerVacc, "Vaccines"),
  P("records", "Visit History", "file", "Diagnoses and treatments from past visits.", OwnerVisits, "History")] };