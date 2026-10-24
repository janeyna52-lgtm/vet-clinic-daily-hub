import { useEffect, useState } from "react";
import { api } from "../../api.js";
export default function Prices() {
  const [catalog, setCatalog] = useState(null), [error, setError] = useState(""), [attempt, retry] = useState(0), [search, setSearch] = useState("");
  useEffect(() => { let active = true; setError(""); api.get("/api/services/prices").then(r => { if (active) setCatalog(r.catalog); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [attempt]);
  return <section className="card"><h3>Clinic prices</h3><p>Official unit prices in Philippine pesos. Your bill reflects the services performed and products dispensed. Medicines require veterinary advice.</p>
    <label htmlFor="price-search">Find a vaccine, service or product</label><input id="price-search" type="search" value={search} onChange={e => setSearch(e.target.value)} />
    {error ? <p role="alert">{error} <button className="btn" onClick={() => retry(x => x + 1)}>Retry</button></p> : !catalog ? <p role="status">Loading prices…</p> : <div className="tw"><table><thead><tr><th>Service / product</th><th>Category</th><th>Unit price</th></tr></thead><tbody>{catalog.filter(p => `${p.name} ${p.category}`.toLowerCase().includes(search.toLowerCase())).map(p => <tr key={p.id}><td>{p.name}</td><td>{p.category}</td><td>₱{p.price.toLocaleString("en-PH", {minimumFractionDigits: 2})}</td></tr>)}</tbody></table></div>}
  </section>;
}
