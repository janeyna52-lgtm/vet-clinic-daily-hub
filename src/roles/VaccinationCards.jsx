import { useState } from "react";
import PetCardModal from "./PetCardModal.jsx";
export default function VaccinationCards(props) {
  const [selected, select] = useState(null), [search, setSearch] = useState("");
  return <section className="card"><h3>Patient vaccination cards</h3><p>Review immunization history and booster dates. Record and certify administered doses when finalizing the patient’s SOAP consultation.</p><label>Find patient<input type="search" value={search} onChange={e => setSearch(e.target.value)} /></label><div className="sf-grid">{props.db.pets.filter(p => p.name.toLowerCase().includes(search.toLowerCase())).map(p => <button className="btn ghost" key={p.id} onClick={() => select(p.id)}>{p.name} · {p.vaccinationCardId || "Card pending"}</button>)}</div>{!props.db.pets.length && <p>No assigned patients yet.</p>}{selected && <PetCardModal {...props} petId={selected} onClose={() => select(null)} />}</section>;
}
