export const SERVICE_PRICES = [
  { id: "srv_consult", category: "Consultation & Exam", name: "Routine General Consultation & Exam", price: 500, desc: "Standard physical evaluation of vitals & condition" },
  { id: "srv_senior", category: "Consultation & Exam", name: "Senior Comprehensive Wellness Exam", price: 750, desc: "In-depth geriatric health review (7+ yrs)" },
  { id: "srv_rabies", category: "Vaccination & Preventive", name: "Anti-Rabies Vaccine (Annual Booster)", price: 350, desc: "RA 9482 certified anti-rabies shot & official certificate" },
  { id: "srv_dhpp", category: "Vaccination & Preventive", name: "DHPP 5-in-1 Core Canine Vaccine", price: 650, desc: "Core Distemper, Adenovirus, Parvovirus, Parainfluenza" },
  { id: "srv_fvrcp", category: "Vaccination & Preventive", name: "FVRCP 4-in-1 Core Feline Vaccine", price: 700, desc: "Core Rhinotracheitis, Calicivirus, Panleukopenia" },
  { id: "srv_deworm", category: "Vaccination & Preventive", name: "Broad-Spectrum Deworming Dose", price: 250, desc: "Canex/Drontal oral tablet/suspension for round/hook/tapeworms" },
  { id: "srv_heartworm", category: "Diagnostic & Lab", name: "Heartworm Rapid Antigen Test (Snap)", price: 850, desc: "Dirofilaria immitis blood test before preventive dispense" },
  { id: "srv_nexgard", category: "Pharmacy & Parasiticide", name: "NexGard Spectra Chewable Tablet", price: 550, desc: "Monthly flea, tick, heartworm and intestinal worm chewable" },
  { id: "srv_simparica", category: "Pharmacy & Parasiticide", name: "Simparica Trio Chewable Tablet", price: 600, desc: "Monthly flea, tick, heartworm broad-spectrum chewable" },
  { id: "srv_cbc", category: "Diagnostic & Lab", name: "Complete Blood Count (CBC)", price: 750, desc: "WBC, RBC, Hemoglobin, Platelet count analysis" },
  { id: "srv_chem", category: "Diagnostic & Lab", name: "Comprehensive Blood Chemistry Panel", price: 1400, desc: "Kidney, liver enzymes, glucose screening" },
  { id: "srv_dental", category: "Dental & Surgery", name: "Ultrasonic Dental Scaling & Polish", price: 1800, desc: "Periodontal calculus removal & enamel polish" },
  { id: "srv_ear", category: "Procedures & Care", name: "Deep Ear Cleaning & Cytology", price: 400, desc: "Canal flush and microscopic ear swab exam" },
  { id: "srv_wound", category: "Procedures & Care", name: "Wound Treatment & Antiseptic Bandaging", price: 450, desc: "Antiseptic lavage and protective dressing" },
  { id: "srv_groom", category: "Procedures & Care", name: "Sanitary Grooming & Nail Trim", price: 250, desc: "Nail clip, paw pad trim, anal gland expression" }
];

// Deployment-owned prices; never accept product prices from a checkout request.
const productTypes = ['Pet shampoo', 'Pet vitamins', 'Pet medicine', 'Pet accessories'];
export function priceCatalog() {
  const products = JSON.parse(process.env.CLINIC_PRODUCTS_JSON || '[]');
  if (!Array.isArray(products) || products.some(p => !p || typeof p.id !== 'string' || !/^product_[a-z0-9_]+$/.test(p.id) || typeof p.name !== 'string' || !p.name.trim() || !productTypes.includes(p.category) || (typeof p.price !== "number" || !Number.isFinite(p.price) || Math.abs(p.price * 100 - Math.round(p.price * 100)) > 0.000001) || p.price <= 0 || p.price > 10000000) || new Set(products.map(p => p.id)).size !== products.length) throw new Error('Invalid clinic product catalog configuration');
  return [...SERVICE_PRICES, ...products.map(({id, name, category, price}) => ({id, name, category, price}))];
}
export function canonicalInvoice(items, catalog = priceCatalog()) {
  if (!Array.isArray(items) || !items.length || items.length > 100) return null;
  const result = [];
  for (const item of items) {
    const official = catalog.find(p => p.id === item?.catalogId);
    if (!official || item.price !== official.price || item.name !== official.name || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 1000) return null;
    result.push({catalogId: official.id, name: official.name, category: official.category, price: official.price, qty: item.qty});
  }
  return result;
}
