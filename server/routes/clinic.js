import { ensureCareSchema, validateCarePlan } from "../careWorkflow.js";
import { priceCatalog, canonicalInvoice } from "../priceCatalog.js";
import { adminRouter } from "./admin.js";
import { ensurePetRegistrationSchema, validatePetRegistration, validatePetPhoto, lockRegistrationOwner, checkRegistrationCapacity, checkRequestRevision, registrationAudit, registrationError } from '../petRegistration.js';
import { checkoutRouter } from "./checkout.js";
import { ensureCheckoutInboxSchema, createCheckoutTask, authorizeCheckoutPayment, finishCheckoutTask } from "../checkout.js";
import { validateBoosterDate } from "../reminders.js";
import { ensureSchedulingSchema } from "../database/schedulingSchema.js";
import { availableSlots, assertAvailable, lockSchedule, clinicClock, inferBookingService, bookingError, minutes, validDate } from "../scheduling.js";
import { ensureCheckoutSchema } from "../database/clinicSchema.js";
import express from "express";
import { query, withTransaction } from "../db.js";
import { sha256 } from "../security.js";
import { sendMail, sendSms } from "../services.js";
import { getAppUrl, requireAuth } from "./auth.js";
import { clinicAccess, assignedTo, validateStatusChange } from "../clinicAccess.js";

export const clinicRouter = express.Router();
clinicRouter.use(requireAuth, clinicAccess);
clinicRouter.use("/checkout-inbox", checkoutRouter);
clinicRouter.use("/admin", adminRouter);

/* Helper: log an action to audit_logs */
async function recordAudit(userName, userRole, action) {
  try {
    await query(
      "INSERT INTO audit_logs (user_name, user_role, action) VALUES ($1, $2, $3)",
      [userName || "System", userRole || "system", action]
    );
  } catch (err) {
    console.error("Audit log error:", err.message);
  }
}

function toDateStr(val) {
  if (!val) return "";
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, "0");
    const d = String(val.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, "0");
    const d = String(parsed.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return s;
}

/* 1. BOOTSTRAP / FULL STATE SYNC */
clinicRouter.get("/state", async (req, res) => {
  try {
    await ensurePetRegistrationSchema();
    await ensureCareSchema();
    const owner = req.user.role === "owner";
    const vet = req.user.role === "vet";
    const scopeParams = owner ? [req.user.ownerId] : vet ? [[req.user.vetId, req.user.id].filter(Boolean)] : [];
    const petScope = owner ? "SELECT id FROM pets WHERE owner_id = $1" : "SELECT pet_id FROM appointments WHERE vet_id = ANY($1::varchar[])";
    const scoped = owner || vet;
    const wherePet = scoped ? ` WHERE pet_id IN (${petScope})` : "";
    const [
      ownersRes,
      petsRes,
      weightsRes,
      apptsRes,
      vaccsRes,
      consultsRes,
      requestsRes,
      logsRes,
      vetsRes
    ] = await Promise.all([
      query(`
        SELECT o.*, u.birthday, u.first_name, u.last_name, u.middle_initial, u.role as user_role,
               a.house_street, a.country, a.state, a.city, a.zip_code
        FROM owners o
        LEFT JOIN users u ON u.id = o.user_id
        LEFT JOIN addresses a ON a.user_id = o.user_id
        ${owner ? "WHERE o.id = $1" : vet ? `WHERE o.id IN (SELECT owner_id FROM pets WHERE id IN (${petScope}))` : ""}
        ORDER BY o.name ASC
      `, scopeParams),
      query(`SELECT * FROM pets${scoped ? ` WHERE id IN (${petScope})` : ""} ORDER BY name ASC`, scopeParams),
      query(`SELECT * FROM pet_weights${wherePet} ORDER BY date ASC`, scopeParams),
      query(`SELECT * FROM appointments${owner ? ` WHERE pet_id IN (${petScope})` : vet ? " WHERE vet_id = ANY($1::varchar[])" : ""} ORDER BY date ASC, time ASC`, scopeParams),
      query(`SELECT * FROM vaccinations${wherePet} ORDER BY date ASC, id ASC`, scopeParams),
      query(`SELECT * FROM consultations${wherePet} ORDER BY date DESC`, scopeParams),
      vet ? Promise.resolve({ rows: [] }) : query(`SELECT * FROM pet_requests${owner ? " WHERE owner_id = $1" : ""} ORDER BY created_at DESC`, owner ? scopeParams : []),
      req.user.role === "admin" ? query("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100") : Promise.resolve({ rows: [] }),
      query("SELECT id, vet_id, first_name, last_name, role FROM users WHERE role = 'vet' AND COALESCE(to_jsonb(users)->>'is_active', 'true') <> 'false' ORDER BY first_name ASC")
    ]);

    // Attach weights to pets
    const weightsByPet = {};
    for (const w of weightsRes.rows) {
      if (!weightsByPet[w.pet_id]) weightsByPet[w.pet_id] = [];
      weightsByPet[w.pet_id].push({
        date: toDateStr(w.date),
        kg: parseFloat(w.kg),
        by: w.recorded_by || "Clinic Front Desk"
      });
    }

    const pets = petsRes.rows.map(p => ({
      id: p.id,
      ownerId: p.owner_id,
      name: p.name,
      species: p.species,
      speciesOther: p.species_other || "",
      breed: p.breed,
      sex: p.sex,
      birth: toDateStr(p.birth),
      weight: parseFloat(p.weight),
      color: p.color || "",
      neutered: p.neutered || "Not sure",
      allergies: p.allergies || [],
      vaccinationCardId: p.vaccination_card_id || "",
      notes: p.notes || "",
      photo: p.photo || "",
      dentalOcclusion: p.dental_occlusion || "",
      weights: weightsByPet[p.id] || [{ date: toDateStr(p.birth), kg: parseFloat(p.weight), by: "Initial Registration" }]
    }));

    const owners = ownersRes.rows.map(o => ({
      id: o.id,
      userId: o.user_id,
      name: o.name,
      firstName: o.first_name || "",
      lastName: o.last_name || "",
      middleInitial: o.middle_initial || "",
      birthday: toDateStr(o.birthday),
      email: o.email,
      phone: o.phone,
      houseStreet: o.house_street || "",
      country: o.country || "",
      state: o.state || "",
      city: o.city || "",
      zipCode: o.zip_code || "",
      address: o.address || (o.house_street ? `${o.house_street}, ${o.city}, ${o.state} ${o.zip_code}, ${o.country}` : "")
    }));

    const appts = apptsRes.rows.map(a => ({
      id: a.id,
      petId: a.pet_id,
      vetId: a.vet_id,
      date: toDateStr(a.date),
      time: Number.isFinite(minutes(a.time)) ? `${String(Math.floor(minutes(a.time) / 60)).padStart(2, "0")}:${String(minutes(a.time) % 60).padStart(2, "0")}` : a.time,
      service: a.service, durationMinutes: a.duration_minutes || 30, bookingKind: a.booking_kind || "reservation", notes: a.notes || "",
      reason: a.reason,
      status: a.status,
      billingStatus: a.billing_status,
      amount: parseFloat(a.amount),
      billingStatus: a.billing_status,
      paymentMethod: a.payment_method || "",
      paymentReference: a.payment_details?.reference || "",
      discount: a.payment_details?.discount || 0,
      cashTendered: a.payment_details?.cashTendered ?? null,
      changeAmount: a.payment_details?.changeAmount || 0,
      paidAt: a.paid_at || null,
      invoiceItems: a.invoice_items || [],
      intakeVitals: a.intake_vitals || null,
      handoffs: owner ? [] : (a.handoffs || []),
      cancelReason: a.cancel_reason || ""
    }));

    const rawVaccs = vaccsRes.rows.map(v => ({
      id: v.id,
      petId: v.pet_id,
      cardId: v.card_id,
      vaccine: v.vaccine,
      brand: v.brand || "",
      batch: v.batch || "",
      date: toDateStr(v.date),
      createdAt: v.created_at,
      nextDue: v.next_due ? toDateStr(v.next_due) : null,
      doseNo: v.dose_no,
      doseOf: v.dose_of,
      done: Boolean(v.done),
      automated: Boolean(v.automated),
      protocolType: v.protocol_type || "",
      notes: v.notes || "",
      vetId: v.vet_id || "",
      recordedBy: v.recorded_by || ""
    }));

    const vaccs = rawVaccs.filter((v, idx, arr) => {
      if (!v.done) {
        const hasDoneMatch = arr.some(other =>
          other.petId === v.petId &&
          other.done &&
          (
            (other.vaccine?.toLowerCase().includes("rabies") && v.vaccine?.toLowerCase().includes("rabies")) ||
            (other.vaccine?.toLowerCase().includes("dhpp") && v.vaccine?.toLowerCase().includes("dhpp")) ||
            (other.vaccine?.toLowerCase().includes("5-in-1") && v.vaccine?.toLowerCase().includes("5-in-1")) ||
            (other.vaccine?.toLowerCase().includes("deworm") && v.vaccine?.toLowerCase().includes("deworm")) ||
            other.vaccine?.toLowerCase() === v.vaccine?.toLowerCase()
          )
        );
        if (hasDoneMatch) return false;
      }
      return true;
    });

    const consults = consultsRes.rows.map(c => ({
      id: c.id,
      petId: c.pet_id,
      vetId: c.vet_id,
      apptId: c.appt_id || "",
      date: toDateStr(c.date),
      symptoms: c.symptoms,
      objective: c.objective,
      diagnosis: c.diagnosis,
      treatment: c.treatment,
      careStatus: c.care_status || "Routine care",
      followUpDate: c.follow_up_date ? toDateStr(c.follow_up_date) : null,
      followUpReason: c.follow_up_reason || "",
      prescription: c.prescription || ""
    }));

    const petRequests = requestsRes.rows.map(r => ({
      id: r.id,
      ownerId: r.owner_id,
      name: r.name,
      species: r.species,
      speciesOther: r.species_other || "",
      breed: r.breed || "",
      sex: r.sex,
      birth: toDateStr(r.birth),
      weight: parseFloat(r.weight),
      color: r.color || "",
      neutered: r.neutered || "",
      notes: r.notes || "",
      photo: r.photo || "",
      dentalOcclusion: r.dental_occlusion || "",
      revision: r.revision ?? 0,
      status: r.status,
      declineReason: r.decline_reason || "",
      petId: r.pet_id || "",
      cardId: r.card_id || "",
      requestedAt: toDateStr(r.requested_at),
      approvedAt: r.approved_at ? toDateStr(r.approved_at) : null,
      approvedBy: r.approved_by || ""
    }));

    const log = logsRes.rows.map(l => {
      const formattedDate = l.created_at ? new Date(l.created_at).toLocaleString("en-PH") : "";
      return {
        id: l.id,
        ts: formattedDate,
        at: formattedDate,
        by: l.user_name || "System",
        role: l.user_role || "staff",
        user: { name: l.user_name || "System", role: l.user_role || "staff" },
        action: l.action,
        msg: l.action
      };
    });

    res.json({
      success: true,
      data: {
        vets: vetsRes.rows.map(v => ({
          id: v.vet_id || v.id,
          name: `Dr. ${[v.first_name, v.last_name].filter(Boolean).join(" ")}`
        })),
        owners,
        pets,
        appts,
        vaccs,
        consults,
        petRequests,
        log
      }
    });
  } catch (err) {
    console.error("Clinic state fetch error:", err);
    res.status(500).json({ error: "Failed to load clinic state: " + err.message });
  }
});

/* 1.5 OWNER CONTACT & PROFILE UPDATE */
clinicRouter.post("/owner/contact", async (req, res) => {
  try {
    const { email, phone, address, houseStreet, city, state, country, zipCode } = req.body;
    const sid = req.cookies?.sid || (req.headers.authorization && req.headers.authorization.replace("Bearer ", ""));
    let userId = null;
    let ownerId = null;

    if (sid) {
      const s = await query("SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > NOW()", [sha256(sid)]);
      if (s.rows.length) userId = s.rows[0].user_id;
    }
    if (userId) {
      const o = await query("SELECT id FROM owners WHERE user_id = $1", [userId]);
      if (o.rows.length) ownerId = o.rows[0].id;
    }
    if (!ownerId && email) {
      const o = await query("SELECT id, user_id FROM owners WHERE LOWER(email) = LOWER($1)", [email]);
      if (o.rows.length) {
        ownerId = o.rows[0].id;
        userId = o.rows[0].user_id;
      }
    }
    if (!ownerId) {
      return res.status(404).json({ error: "Owner record not found." });
    }

    if (email) {
      await query("UPDATE owners SET email = $1 WHERE id = $2", [email, ownerId]);
      if (userId) await query("UPDATE users SET email = $1 WHERE id = $2", [email, userId]);
    }
    if (phone) {
      await query("UPDATE owners SET phone = $1 WHERE id = $2", [phone, ownerId]);
      if (userId) await query("UPDATE users SET mobile_number = $1 WHERE id = $2", [phone, userId]);
    }
    if (address) {
      await query("UPDATE owners SET address = $1 WHERE id = $2", [address, ownerId]);
    }
    if (userId && (houseStreet || city || state || country || zipCode)) {
      await query(
        `UPDATE addresses
         SET house_street = COALESCE($1, house_street),
             city = COALESCE($2, city),
             state = COALESCE($3, state),
             country = COALESCE($4, country),
             zip_code = COALESCE($5, zip_code)
         WHERE user_id = $6`,
        [houseStreet || null, city || null, state || null, country || null, zipCode || null, userId]
      );
    }

    const updated = await query(`
      SELECT o.*, u.birthday, u.first_name, u.last_name, u.middle_initial,
             a.house_street, a.country, a.state, a.city, a.zip_code
      FROM owners o
      LEFT JOIN users u ON u.id = o.user_id
      LEFT JOIN addresses a ON a.user_id = o.user_id
      WHERE o.id = $1
    `, [ownerId]);

    const row = updated.rows[0];
    res.json({
      status: "ok",
      owner: {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        firstName: row.first_name || "",
        lastName: row.last_name || "",
        middleInitial: row.middle_initial || "",
        birthday: toDateStr(row.birthday),
        email: row.email,
        phone: row.phone,
        houseStreet: row.house_street || "",
        country: row.country || "",
        state: row.state || "",
        city: row.city || "",
        zipCode: row.zip_code || "",
        address: row.address || ""
      }
    });
  } catch (err) {
    console.error("Update contact error:", err);
    res.status(500).json({ error: "Failed to update contact details." });
  }
});

/* 2. OWNERS CRUD */
clinicRouter.post("/owners", async (req, res) => {
  const { id, name, email, phone, address, actorName, actorRole } = req.body;

  // RBAC check: Assistants cannot edit existing client accounts
  if (id && actorRole === "assistant") {
    return res.status(403).json({ error: "Vet Assistants cannot edit registered pet owner accounts." });
  }

  const ownerId = id || ("o_" + Math.random().toString(36).slice(2, 8));

  try {
    const result = await query(
      `INSERT INTO owners (id, name, email, phone, address)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         email = EXCLUDED.email,
         phone = EXCLUDED.phone,
         address = EXCLUDED.address
       RETURNING *`,
      [ownerId, name, email, phone, address]
    );

    await recordAudit(actorName, actorRole, `Registered / updated pet owner: ${name}`);
    res.json({ success: true, owner: result.rows[0] });
  } catch (err) {
    res.status(err.status || (err.code === "23505" ? 409 : 500)).json({ error: err.status ? err.message : err.code === "23505" ? "This record already exists. Refresh before trying again." : "Unable to save clinic data. Please try again." });
  }
});

/* 3. PETS CRUD & WEIGHT LOGGING */
clinicRouter.post("/owner/pets", async (req, res) => {
  const {
    ownerId, name, species, speciesOther, breed, sex,
    birth, weight, color, neutered, dentalOcclusion, notes, photo
  } = req.body;

  let effectiveOwnerId = ownerId;
  const token = req.cookies?.pawcare_session || (req.headers.authorization || "").replace("Bearer ", "");
  if (!effectiveOwnerId && token) {
    try {
      const sRes = await query(
        `SELECT u.owner_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
        [token]
      );
      if (sRes.rows.length && sRes.rows[0].owner_id) {
        effectiveOwnerId = sRes.rows[0].owner_id;
      }
    } catch (_) {}
  }

  if (!effectiveOwnerId) {
    try {
      const oRes = await query(`SELECT id FROM owners ORDER BY created_at DESC LIMIT 1`);
      if (oRes.rows.length) effectiveOwnerId = oRes.rows[0].id;
    } catch (_) {}
  }

  const petId = "p_" + Math.random().toString(36).slice(2, 8);
  const cardId = "VACC-" + new Date().getFullYear() + "-" + Math.floor(1000 + Math.random() * 9000);
  const today = new Date().toISOString().slice(0, 10);
  const addDays = (dStr, days) => {
    const d = new Date(dStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };

  const sp = (species || "Canine").toLowerCase();
  const isDog = sp.includes("dog") || sp.includes("canine");
  const isCat = sp.includes("cat") || sp.includes("feline");
  const isRabbit = sp.includes("rabbit") || sp.includes("lagomorph");
  const isRodent = sp.includes("rodent") || sp.includes("hamster") || sp.includes("guinea");
  const isAvian = sp.includes("bird") || sp.includes("avian");

  try {
    const { pet, vaccs } = await withTransaction(async (client) => {
      // 1. Insert Pet into PostgreSQL Masterlist
      const insPet = await client.query(
        `INSERT INTO pets (id, owner_id, name, species, species_other, breed, sex, birth, weight, color, neutered, vaccination_card_id, notes, photo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [
          petId,
          effectiveOwnerId,
          name,
          species || "Canine (Dog)",
          speciesOther || "",
          breed || "Mixed Breed",
          sex || "Male",
          birth || today,
          parseFloat(weight) || 5.0,
          color || "",
          neutered || "Not sure",
          cardId,
          notes || "",
          photo || ""
        ]
      );

      // 2. Insert Initial Weight
      await client.query(
        `INSERT INTO pet_weights (pet_id, date, kg, recorded_by) VALUES ($1, $2, $3, $4)`,
        [petId, birth || today, parseFloat(weight) || 5.0, "owner"]
      );

      // Calculate pet life stage (Puppy/Kitten vs Adult vs Senior)
      let isAdult = false;
      let isSenior = false;
      if (birth) {
        const b = new Date(birth + "T00:00:00");
        const now = new Date(today + "T00:00:00");
        const diffDays = Math.floor((now - b) / (1000 * 60 * 60 * 24));
        if (diffDays >= 365) isAdult = true;
        if (diffDays >= 365 * 7) isSenior = true;
      }

      // 3. Seed Core Vaccination Protocols based on VCMS v2.0 & Life Stage
      const seeded = [];
      if (isDog) {
        if (isAdult) {
          // Lifelong Adult Canine Maintenance Schedule (1 Year and Beyond)
          // 1. Annual DHPP Booster (Core)
          const v1 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "DHPP (5-in-1 Adult Core Booster)",
            brand: "Nobivac DHPP",
            batch: "AUTO-DHPP-ADULT",
            date: today,
            next_due: addDays(today, 365),
            dose_no: 1,
            dose_of: 1,
            done: false,
            automated: true,
            protocol_type: "Adult Core Immunization (Annual)",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v1)
          );
          seeded.push(v1);

          // 2. Annual Anti-Rabies Core Booster (Mandatory RA 9482)
          const v2 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "Anti-Rabies Booster (RA 9482 Compliance)",
            brand: "Defensor 3",
            batch: "AUTO-RAB-ADULT",
            date: today,
            next_due: addDays(today, 365),
            dose_no: 1,
            dose_of: 1,
            done: false,
            automated: true,
            protocol_type: "Core Rabies Protocol (Annual Mandatory)",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v2)
          );
          seeded.push(v2);

          // 3. Adult Deworming (Quarterly / Every 3 Months / 90 Days)
          const v3 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "Adult Deworming (Quarterly Routine)",
            brand: "Canex Multi-Spectrum",
            batch: "AUTO-DEW-ADULT",
            date: today,
            next_due: addDays(today, 90),
            dose_no: 1,
            dose_of: 4,
            done: false,
            automated: true,
            protocol_type: "Adult Parasiticide Protocol (Quarterly)",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v3)
          );
          seeded.push(v3);

          // 4. Monthly Flea, Tick & Heartworm Prevention (Every 30 Days)
          const v4 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "Monthly Flea, Tick & Heartworm Chewable",
            brand: "NexGard Spectra / Simparica Trio",
            batch: "AUTO-ECTO-M",
            date: today,
            next_due: addDays(today, 30),
            dose_no: 1,
            dose_of: 12,
            done: false,
            automated: true,
            protocol_type: "Monthly Prophylaxis Protocol",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v4)
          );
          seeded.push(v4);
        } else {
          // Puppy series (< 12 months)
          // DHPP 5-in-1
          const v1 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "DHPP (5-in-1 Core)",
            brand: "Nobivac DHPP",
            batch: "AUTO-DHPP-01",
            date: today,
            next_due: addDays(today, 21),
            dose_no: 1,
            dose_of: 3,
            done: false,
            automated: true,
            protocol_type: "Core Canine Protocol",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v1)
          );
          seeded.push(v1);

          // Anti-Rabies (Mandatory Core RA 9482)
          const v2 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "Anti-Rabies (1-Year Core)",
            brand: "Defensor 3",
            batch: "AUTO-RAB-01",
            date: today,
            next_due: addDays(today, 30),
            dose_no: 1,
            dose_of: 1,
            done: false,
            automated: true,
            protocol_type: "Core Rabies Protocol",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v2)
          );
          seeded.push(v2);

          // Broad-Spectrum Deworming
          const v3 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "Broad-Spectrum Deworming",
            brand: "Canex Multi-Spectrum",
            batch: "AUTO-DEW-01",
            date: today,
            next_due: addDays(today, 14),
            dose_no: 1,
            dose_of: 4,
            done: false,
            automated: true,
            protocol_type: "Parasiticide Protocol",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v3)
          );
          seeded.push(v3);
        }
      } else if (isCat) {
        if (isAdult) {
          // Adult Feline Maintenance
          const v1 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "FVRCP (4-in-1 Adult Core Booster)",
            brand: "Fel-O-Vax 4",
            batch: "AUTO-FVR-ADULT",
            date: today,
            next_due: addDays(today, 365),
            dose_no: 1,
            dose_of: 1,
            done: false,
            automated: true,
            protocol_type: "Adult Core Feline Protocol",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v1)
          );
          seeded.push(v1);

          const v2 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "Anti-Rabies Booster (Feline Formulation)",
            brand: "Defensor 3",
            batch: "AUTO-RABF-ADULT",
            date: today,
            next_due: addDays(today, 365),
            dose_no: 1,
            dose_of: 1,
            done: false,
            automated: true,
            protocol_type: "Core Rabies Protocol (Annual)",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v2)
          );
          seeded.push(v2);

          const v3 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "Adult Feline Deworming (Quarterly)",
            brand: "Profender / Milbemax",
            batch: "AUTO-DEWF-ADULT",
            date: today,
            next_due: addDays(today, 90),
            dose_no: 1,
            dose_of: 4,
            done: false,
            automated: true,
            protocol_type: "Feline Parasiticide Protocol (Quarterly)",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v3)
          );
          seeded.push(v3);
        } else {
          // Kitten series
          const v1 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "FVRCP (4-in-1 Core)",
            brand: "Fel-O-Vax 4",
            batch: "AUTO-FVR-01",
            date: today,
            next_due: addDays(today, 28),
            dose_no: 1,
            dose_of: 3,
            done: false,
            automated: true,
            protocol_type: "Core Feline Protocol",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v1)
          );
          seeded.push(v1);

          const v2 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "Anti-Rabies (Feline Formulation)",
            brand: "Defensor 3",
            batch: "AUTO-RABF-01",
            date: today,
            next_due: addDays(today, 30),
            dose_no: 1,
            dose_of: 1,
            done: false,
            automated: true,
            protocol_type: "Core Rabies Protocol",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v2)
          );
          seeded.push(v2);
        }
      } else if (isRabbit) {
        const v1 = {
          id: "v_" + Math.random().toString(36).slice(2, 8),
          pet_id: petId,
          card_id: cardId,
          vaccine: "RHDV1 / RHDV2 Core Vaccine",
          brand: "Filavac VHD",
          batch: "AUTO-RHD-01",
          date: today,
          next_due: addDays(today, 30),
          dose_no: 1,
          dose_of: 1,
          done: false,
          automated: true,
          protocol_type: "Core Lagomorph Protocol",
          recorded_by: "System Automation"
        };
        await client.query(
          `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          Object.values(v1)
        );
        seeded.push(v1);
      } else if (isRodent) {
        const v1 = {
          id: "v_" + Math.random().toString(36).slice(2, 8),
          pet_id: petId,
          card_id: cardId,
          vaccine: "Dental & Occlusion Clinical Exam",
          brand: "VCMS Protocol",
          batch: "AUTO-DEN-01",
          date: today,
          next_due: addDays(today, 180),
          dose_no: 1,
          dose_of: 2,
          done: false,
          automated: true,
          protocol_type: "Rodent Dental Protocol",
          recorded_by: "System Automation"
        };
        await client.query(
          `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          Object.values(v1)
        );
        seeded.push(v1);
      } else if (isAvian) {
        const v1 = {
          id: "v_" + Math.random().toString(36).slice(2, 8),
          pet_id: petId,
          card_id: cardId,
          vaccine: "Diagnostic Fecal Float Screening",
          brand: "Microscopic Screen",
          batch: "AUTO-FLT-01",
          date: today,
          next_due: addDays(today, 180),
          dose_no: 1,
          dose_of: 1,
          done: false,
          automated: true,
          protocol_type: "Avian Diagnostic Protocol",
          recorded_by: "System Automation"
        };
        await client.query(
          `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          Object.values(v1)
        );
        seeded.push(v1);
      }

      // 4. Record in pet_requests with Approved status for audit and front desk visibility
      const reqId = "req_" + Math.random().toString(36).slice(2, 8);
      await client.query(
        `INSERT INTO pet_requests (id, owner_id, name, species, species_other, breed, sex, birth, weight, color, neutered, notes, status, approved_at, approved_by, pet_id, card_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'Approved', CURRENT_DATE, 'Owner Instant Online Registration', $13, $14)`,
        [reqId, effectiveOwnerId, name, species, speciesOther || "", breed || "", sex, birth || today, parseFloat(weight) || 5.0, color || "", neutered || "", notes || "", petId, cardId]
      );

      // 5. Pre-schedule initial preventive appointment
      const earliestDue = seeded.filter(v => v.next_due).sort((a, b) => a.next_due.localeCompare(b.next_due))[0];
      let preAppt = null;
      if (earliestDue) {
        const apptId = "a_pre_" + Math.random().toString(36).slice(2, 8);
        const insAppt = await client.query(
          `INSERT INTO appointments (id, pet_id, vet_id, date, time, reason, status, billing_status, amount)
           VALUES ($1, $2, $3, $4, $5, $6, 'Scheduled', 'Pending', 0) RETURNING *`,
          [apptId, petId, "vet_cruz", earliestDue.next_due, "10:00", `${earliestDue.vaccine} (Pre-scheduled)`]
        );
        preAppt = insAppt.rows[0];
      }

      return { pet: insPet.rows[0], vaccs: seeded, appointment: preAppt };
    });

    await recordAudit("Owner", "owner", `Registered new patient ${name} (${species}) with digital card ${cardId}`);

    res.json({
      success: true,
      pet: {
        id: pet.id,
        ownerId: pet.owner_id,
        name: pet.name,
        species: pet.species,
        speciesOther: pet.species_other || "",
        breed: pet.breed,
        sex: pet.sex,
        birth: pet.birth ? new Date(pet.birth).toISOString().slice(0, 10) : "",
        weight: parseFloat(pet.weight),
        color: pet.color || "",
        neutered: pet.neutered || "Not sure",
        allergies: pet.allergies || [],
        vaccinationCardId: cardId,
        notes: pet.notes || "",
        photo: pet.photo || "",
        dentalOcclusion: dentalOcclusion || "",
        weights: [{ date: toDateStr(pet.birth) || today, kg: parseFloat(pet.weight) }]
      },
      cardId,
      vaccs: vaccs.map(v => ({
        id: v.id,
        petId: v.pet_id,
        cardId: v.card_id,
        vaccine: v.vaccine,
        brand: v.brand,
        batch: v.batch,
        date: v.date,
        nextDue: v.next_due,
        doseNo: v.dose_no,
        doseOf: v.dose_of,
        done: v.done,
        automated: v.automated,
        protocolType: v.protocol_type,
        notes: "",
        recordedBy: v.recorded_by
      }))
    });
  } catch (err) {
    console.error("Owner pet registration error:", err);
    res.status(err.status || (err.code === "23505" ? 409 : 500)).json({ error: err.status ? err.message : err.code === "23505" ? "This record already exists. Refresh before trying again." : "Unable to save clinic data. Please try again." });
  }
});

clinicRouter.post("/pets", async (req, res) => {
  const {
    id, ownerId, name, species, speciesOther, breed, sex,
    birth, weight, color, neutered, allergies, notes, photo,
    actorName, actorRole
  } = req.body;
  const petId = id || ("p_" + Math.random().toString(36).slice(2, 8));
  const cardId = "VACC-" + new Date().getFullYear() + "-" + Math.floor(1000 + Math.random() * 9000);

  try {
    const result = await withTransaction(async (client) => {
      const insPet = await client.query(
        `INSERT INTO pets (id, owner_id, name, species, species_other, breed, sex, birth, weight, color, neutered, allergies, vaccination_card_id, notes, photo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING *`,
        [petId, ownerId, name, species || "Dog", speciesOther || "", breed || "Mixed Breed", sex || "Male", birth, weight || 5.0, color || "", neutered || "Not sure", allergies || [], cardId, notes || "", photo || ""]
      );

      // Record baseline weight
      await client.query(
        `INSERT INTO pet_weights (pet_id, date, kg) VALUES ($1, $2, $3)`,
        [petId, birth || new Date().toISOString().slice(0, 10), weight || 5.0]
      );

      return insPet.rows[0];
    });

    await recordAudit(actorName, actorRole, `Registered patient ${name} (${species}) with card ${cardId}`);
    res.json({ success: true, pet: result });
  } catch (err) {
    res.status(err.status || (err.code === "23505" ? 409 : 500)).json({ error: err.status ? err.message : err.code === "23505" ? "This record already exists. Refresh before trying again." : "Unable to save clinic data. Please try again." });
  }
});

clinicRouter.post("/pets/:id/weights", async (req, res) => {
  const petId = req.params.id;
  const { date, kg, recordedBy } = req.body;
  try {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO pet_weights (pet_id, date, kg, recorded_by) VALUES ($1, $2, $3, $4)`,
        [petId, date || new Date().toISOString().slice(0, 10), kg, recordedBy || "clinic"]
      );
      await client.query(`UPDATE pets SET weight = $1 WHERE id = $2`, [kg, petId]);
    });
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || (err.code === "23505" ? 409 : 500)).json({ error: err.status ? err.message : err.code === "23505" ? "This record already exists. Refresh before trying again." : "Unable to save clinic data. Please try again." });
  }
});

clinicRouter.post(['/owner/pets/:id/photo','/pets/:id/photo'],async (req,res) => {
  try {
    const photo = validatePetPhoto(req.body.photo);
    await ensurePetRegistrationSchema();
    const row = await withTransaction(async client => {
      const pet = (await client.query('SELECT id,owner_id FROM pets WHERE id = $1',[req.params.id])).rows[0];
      const request = pet ? null : (await client.query('SELECT * FROM pet_requests WHERE id = $1 OR pet_id = $1',[req.params.id])).rows[0];
      const ownerId = pet?.owner_id || request?.owner_id;
      if (!ownerId || req.user.role === 'owner' && ownerId !== req.user.ownerId) throw registrationError('Pet not found.',404);
      await lockRegistrationOwner(client,ownerId);
      // Approval may have completed since the initial read. Re-read under its lock.
      const current = request ? (await client.query('SELECT * FROM pet_requests WHERE id = $1 FOR UPDATE',[request.id])).rows[0] : null;
      if (request && !current) throw registrationError('Pet request not found.',404);
      const petId = pet?.id || (current?.status === 'Approved' ? current.pet_id : null);
      const saved = petId
        ? await client.query('UPDATE pets SET photo = $1 WHERE id = $2 RETURNING *',[photo,petId])
        : await client.query('UPDATE pet_requests SET photo=$1,revision=revision+1 WHERE id=$2 RETURNING *',[photo,current.id]);
      if (!saved.rows.length) throw registrationError('Pet not found.',404);
      await registrationAudit(client,req.user,`Updated pet photo ${petId || current.id}`);
      return saved.rows[0];
    });
    res.json({success:true,pet:{id:row.id,ownerId:row.owner_id,name:row.name,species:row.species,speciesOther:row.species_other || '',breed:row.breed,sex:row.sex,birth:toDateStr(row.birth),weight:Number(row.weight),color:row.color || '',neutered:row.neutered,allergies:row.allergies || [],vaccinationCardId:row.vaccination_card_id || '',notes:row.notes || '',photo:row.photo,dentalOcclusion:row.dental_occlusion || '',revision:row.revision}});
  } catch(error) {res.status(error.status || 500).json({error:error.status ? error.message : 'Unable to save the pet picture. Please retry.'});}
});

/* 4. ONLINE PET REGISTRATION REQUESTS & APPROVAL AUTOMATION */
// Creating and correcting requests use the same validation and owner lock.
async function savePetRequest(req, res) {
  try {
    const data = validatePetRegistration(req.body);
    await ensurePetRegistrationSchema();
    const result = await withTransaction(async client => {
      await lockRegistrationOwner(client,req.user.ownerId);
      if (req.params.id) {
        const current = (await client.query('SELECT * FROM pet_requests WHERE id = $1 FOR UPDATE',[req.params.id])).rows[0];
        if (!current || current.owner_id !== req.user.ownerId) throw registrationError('Pet request not found.',404);
        if (!['Pending','Declined'].includes(current.status)) throw registrationError('This request has already been approved. Contact the clinic to correct the patient record.',409);
        checkRequestRevision(current,req.body.revision);
      }
      await checkRegistrationCapacity(client,req.user.ownerId,data.name,req.params.id || null);
      const values = [data.name,data.species,data.speciesOther,data.breed,data.sex,data.birth,data.weight,data.color,data.neutered,data.notes,data.photo,data.dentalOcclusion];
      const saved = req.params.id
        ? await client.query(`UPDATE pet_requests SET name=$1,species=$2,species_other=$3,breed=$4,sex=$5,birth=$6,weight=$7,color=$8,neutered=$9,notes=$10,photo=$11,dental_occlusion=$12,
            status='Pending',decline_reason=NULL,approved_at=NULL,approved_by=NULL,revision=revision+1,requested_at=CURRENT_DATE WHERE id=$13 RETURNING *`,[...values,req.params.id])
        : await client.query(`INSERT INTO pet_requests (name,species,species_other,breed,sex,birth,weight,color,neutered,notes,photo,dental_occlusion,id,owner_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[...values,'req_'+crypto.randomUUID(),req.user.ownerId]);
      await registrationAudit(client,req.user,`${req.params.id ? 'Corrected and resubmitted' : 'Submitted'} pet request ${saved.rows[0].id} for ${data.name}`);
      return saved.rows[0];
    });
    res.json({success:true,request:result});
  } catch (error) { res.status(error.status || 500).json({error:error.status ? error.message : 'Unable to save the pet request. Your entries are preserved; please retry.'}); }
}
clinicRouter.post('/pet-requests',savePetRequest);
clinicRouter.put('/pet-requests/:id',savePetRequest);

clinicRouter.delete('/pet-requests/:id',async (req,res) => {
  try {
    await withTransaction(async client => {
      await lockRegistrationOwner(client,req.user.ownerId);
      const row = (await client.query('SELECT * FROM pet_requests WHERE id = $1 FOR UPDATE',[req.params.id])).rows[0];
      if (!row || row.owner_id !== req.user.ownerId) throw registrationError('Pet request not found.',404);
      if (row.status === 'Approved') throw registrationError('This request has already been approved. Refresh to view the patient.',409);
      await client.query('DELETE FROM pet_requests WHERE id = $1',[row.id]);
      await registrationAudit(client,req.user,`Withdrew pet request ${row.id} for ${row.name}`);
    });
    res.json({success:true});
  } catch(error) {res.status(error.status || 500).json({error:error.status ? error.message : 'Unable to remove the pet request. Please retry.'});}
});

clinicRouter.post("/pet-requests/:id/approve", async (req, res) => {
  const reqId = req.params.id;
  const { actorName, actorRole } = req.body;
  const today = new Date().toISOString().slice(0, 10);
  const cardId = "VACC-" + new Date().getFullYear() + "-" + Math.floor(1000 + Math.random() * 9000);
  const newPetId = "p_" + crypto.randomUUID();

  try {
    await ensurePetRegistrationSchema();
    const result = await withTransaction(async (client) => {
      const ownerId = (await client.query("SELECT owner_id FROM pet_requests WHERE id = $1",[reqId])).rows[0]?.owner_id;
      await lockRegistrationOwner(client,ownerId);
      const qReq = await client.query("SELECT * FROM pet_requests WHERE id = $1 FOR UPDATE", [reqId]);
      if (!qReq.rows.length) throw registrationError("Pet request not found.",404);
      const r = qReq.rows[0];
      if (r.status !== "Pending") throw Object.assign(new Error("This request has already been processed."), { status: 409 });
      checkRequestRevision(r,req.body.revision);
      validatePetRegistration({ ...r, weight:Number(r.weight), speciesOther:r.species_other, dentalOcclusion:r.dental_occlusion });

      // 1. Insert into pets table
      await client.query(
        `INSERT INTO pets (id, owner_id, name, species, species_other, breed, sex, birth, weight, color, neutered, vaccination_card_id, notes, photo, dental_occlusion)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [newPetId, r.owner_id, r.name, r.species, r.species_other || "", r.breed || "Mixed Breed", r.sex, r.birth, r.weight, r.color || "", r.neutered || "Not sure", cardId, r.notes || "", r.photo || "", r.dental_occlusion || ""]
      );

      // 2. Insert weight baseline
      await client.query(
        `INSERT INTO pet_weights (pet_id, date, kg, recorded_by) VALUES ($1, $2, $3, $4)`,
        [newPetId, today, r.weight, "registration"]
      );

      // 3. Automated Digital Card Vaccine Protocol Seeds (Core schedules per VCMS v2.0 & Life Stage)
      const sp = (r.species || "").toLowerCase();
      const isDog = sp.includes("dog") || sp.includes("canine");
      const isCat = sp.includes("cat") || sp.includes("feline");
      const isRabbit = sp.includes("rabbit") || sp.includes("lagomorph");
      const isRodent = sp.includes("rodent") || sp.includes("hamster") || sp.includes("guinea");
      const isAvian = sp.includes("bird") || sp.includes("avian");
      const addDays = (dStr, days) => {
        const d = new Date(dStr);
        d.setDate(d.getDate() + days);
        return d.toISOString().slice(0, 10);
      };

      let isAdult = false;
      if (r.birth) {
        const b = new Date(r.birth);
        const now = new Date(today);
        const diffDays = Math.floor((now - b) / (1000 * 60 * 60 * 24));
        if (diffDays >= 365) isAdult = true;
      }

      const seeded = [];
      if (isDog) {
        if (isAdult) {
          // Lifelong Adult Canine Maintenance Schedule (1 Year and Beyond)
          const v1 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: newPetId,
            card_id: cardId,
            vaccine: "DHPP (5-in-1 Adult Core Booster)",
            brand: "Nobivac DHPP",
            batch: "AUTO-DHPP-ADULT",
            date: today,
            next_due: addDays(today, 365),
            dose_no: 1,
            dose_of: 1,
            done: false,
            automated: true,
            protocol_type: "Adult Core Immunization (Annual)",
            recorded_by: actorName || "Vet Assistant"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v1)
          );
          seeded.push(v1);

          const v2 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: newPetId,
            card_id: cardId,
            vaccine: "Anti-Rabies Booster (RA 9482 Compliance)",
            brand: "Defensor 3",
            batch: "AUTO-RAB-ADULT",
            date: today,
            next_due: addDays(today, 365),
            dose_no: 1,
            dose_of: 1,
            done: false,
            automated: true,
            protocol_type: "Core Rabies Protocol (Annual Mandatory)",
            recorded_by: actorName || "Vet Assistant"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v2)
          );
          seeded.push(v2);

          const v3 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: newPetId,
            card_id: cardId,
            vaccine: "Adult Deworming (Quarterly Routine)",
            brand: "Canex Multi-Spectrum",
            batch: "AUTO-DEW-ADULT",
            date: today,
            next_due: addDays(today, 90),
            dose_no: 1,
            dose_of: 4,
            done: false,
            automated: true,
            protocol_type: "Adult Parasiticide Protocol (Quarterly)",
            recorded_by: actorName || "Vet Assistant"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v3)
          );
          seeded.push(v3);

          const v4 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: newPetId,
            card_id: cardId,
            vaccine: "Monthly Flea, Tick & Heartworm Chewable",
            brand: "NexGard Spectra / Simparica Trio",
            batch: "AUTO-ECTO-M",
            date: today,
            next_due: addDays(today, 30),
            dose_no: 1,
            dose_of: 12,
            done: false,
            automated: true,
            protocol_type: "Monthly Prophylaxis Protocol",
            recorded_by: actorName || "Vet Assistant"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v4)
          );
          seeded.push(v4);
        } else {
          // Puppy series (< 12 months)
          const v1 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: newPetId,
            card_id: cardId,
            vaccine: "DHPP (5-in-1 Core)",
            brand: "Nobivac DHPP",
            batch: "AUTO-DHPP-01",
            date: today,
            next_due: addDays(today, 21),
            dose_no: 1,
            dose_of: 3,
            done: false,
            automated: true,
            protocol_type: "Core Canine Protocol",
            recorded_by: actorName || "Vet Assistant"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v1)
          );
          seeded.push(v1);

          const v2 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: newPetId,
            card_id: cardId,
            vaccine: "Anti-Rabies (1-Year Core)",
            brand: "Defensor 3",
            batch: "AUTO-RAB-01",
            date: today,
            next_due: addDays(today, 30),
            dose_no: 1,
            dose_of: 1,
            done: false,
            automated: true,
            protocol_type: "Core Rabies Protocol",
            recorded_by: actorName || "Vet Assistant"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v2)
          );
          seeded.push(v2);

          const v3 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: newPetId,
            card_id: cardId,
            vaccine: "Broad-Spectrum Deworming",
            brand: "Canex Multi-Spectrum",
            batch: "AUTO-DEW-01",
            date: today,
            next_due: addDays(today, 14),
            dose_no: 1,
            dose_of: 4,
            done: false,
            automated: true,
            protocol_type: "Parasiticide Protocol",
            recorded_by: actorName || "Vet Assistant"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v3)
          );
          seeded.push(v3);
        }
      } else if (isCat) {
        if (isAdult) {
          const v1 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: newPetId,
            card_id: cardId,
            vaccine: "FVRCP (4-in-1 Adult Core Booster)",
            brand: "Fel-O-Vax 4",
            batch: "AUTO-FVR-ADULT",
            date: today,
            next_due: addDays(today, 365),
            dose_no: 1,
            dose_of: 1,
            done: false,
            automated: true,
            protocol_type: "Adult Core Feline Protocol",
            recorded_by: actorName || "Vet Assistant"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v1)
          );
          seeded.push(v1);

          const v2 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: newPetId,
            card_id: cardId,
            vaccine: "Anti-Rabies Booster (Feline Formulation)",
            brand: "Defensor 3",
            batch: "AUTO-RABF-ADULT",
            date: today,
            next_due: addDays(today, 365),
            dose_no: 1,
            dose_of: 1,
            done: false,
            automated: true,
            protocol_type: "Core Rabies Protocol (Annual)",
            recorded_by: actorName || "Vet Assistant"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v2)
          );
          seeded.push(v2);

          const v3 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: newPetId,
            card_id: cardId,
            vaccine: "Adult Feline Deworming (Quarterly)",
            brand: "Profender / Milbemax",
            batch: "AUTO-DEWF-ADULT",
            date: today,
            next_due: addDays(today, 90),
            dose_no: 1,
            dose_of: 4,
            done: false,
            automated: true,
            protocol_type: "Feline Parasiticide Protocol (Quarterly)",
            recorded_by: actorName || "Vet Assistant"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v3)
          );
          seeded.push(v3);
        } else {
          const v1 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: newPetId,
            card_id: cardId,
            vaccine: "FVRCP (4-in-1 Core)",
            brand: "Fel-O-Vax 4",
            batch: "AUTO-FVR-01",
            date: today,
            next_due: addDays(today, 28),
            dose_no: 1,
            dose_of: 3,
            done: false,
            automated: true,
            protocol_type: "Core Feline Protocol",
            recorded_by: actorName || "Vet Assistant"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v1)
          );
          seeded.push(v1);

          const v2 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: newPetId,
            card_id: cardId,
            vaccine: "Anti-Rabies (Feline Formulation)",
            brand: "Defensor 3",
            batch: "AUTO-RABF-01",
            date: today,
            next_due: addDays(today, 30),
            dose_no: 1,
            dose_of: 1,
            done: false,
            automated: true,
            protocol_type: "Core Rabies Protocol",
            recorded_by: actorName || "Vet Assistant"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v2)
          );
          seeded.push(v2);
        }
      } else if (isRabbit) {
        const v1 = {
          id: "v_" + Math.random().toString(36).slice(2, 8),
          pet_id: newPetId,
          card_id: cardId,
          vaccine: "RHDV1 / RHDV2 Core Vaccine",
          brand: "Filavac VHD",
          batch: "AUTO-RHD-01",
          date: today,
          next_due: addDays(today, 30),
          dose_no: 1,
          dose_of: 1,
          done: false,
          automated: true,
          protocol_type: "Core Lagomorph Protocol",
          recorded_by: actorName || "Vet Assistant"
        };
        await client.query(
          `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          Object.values(v1)
        );
        seeded.push(v1);
      } else if (isRodent) {
        const v1 = {
          id: "v_" + Math.random().toString(36).slice(2, 8),
          pet_id: newPetId,
          card_id: cardId,
          vaccine: "Dental & Occlusion Clinical Exam",
          brand: "VCMS Protocol",
          batch: "AUTO-DEN-01",
          date: today,
          next_due: addDays(today, 180),
          dose_no: 1,
          dose_of: 2,
          done: false,
          automated: true,
          protocol_type: "Rodent Dental Protocol",
          recorded_by: actorName || "Vet Assistant"
        };
        await client.query(
          `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          Object.values(v1)
        );
        seeded.push(v1);
      } else if (isAvian) {
        const v1 = {
          id: "v_" + Math.random().toString(36).slice(2, 8),
          pet_id: newPetId,
          card_id: cardId,
          vaccine: "Diagnostic Fecal Float Screening",
          brand: "Microscopic Screen",
          batch: "AUTO-FLT-01",
          date: today,
          next_due: addDays(today, 180),
          dose_no: 1,
          dose_of: 1,
          done: false,
          automated: true,
          protocol_type: "Avian Diagnostic Protocol",
          recorded_by: actorName || "Vet Assistant"
        };
        await client.query(
          `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          Object.values(v1)
        );
        seeded.push(v1);
      }

      // 4. Update pet_request record
      const upd = await client.query(
        `UPDATE pet_requests
         SET status = 'Approved', approved_at = CURRENT_DATE, approved_by = $1, pet_id = $2, card_id = $3, revision = revision + 1
         WHERE id = $4
         RETURNING *`,
        [actorName || "Vet Assistant", newPetId, cardId, reqId]
      );

      // Registration approval does not reserve clinical time or choose a doctor.
      const preAppt = null;

      await registrationAudit(client,req.user,`Approved pet request ${reqId} for ${r.name} (Assigned Card ${cardId})`);
      const qPet = await client.query("SELECT * FROM pets WHERE id = $1", [newPetId]);
      return { petId: newPetId, cardId, request: upd.rows[0], pet: qPet.rows[0], vaccs: seeded, appointment: preAppt };
    });

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.status || (err.code === "23505" ? 409 : 500)).json({ error: err.status ? err.message : err.code === "23505" ? "This record already exists. Refresh before trying again." : "Unable to save clinic data. Please try again." });
  }
});

clinicRouter.post('/pet-requests/:id/decline',async (req,res) => {
  try {
    const reason = req.body.reason;
    if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500) throw registrationError('Explain what the owner needs to correct (up to 500 characters).');
    await ensurePetRegistrationSchema();
    const result = await withTransaction(async client => {
      const ownerId = (await client.query('SELECT owner_id FROM pet_requests WHERE id = $1',[req.params.id])).rows[0]?.owner_id;
      await lockRegistrationOwner(client,ownerId);
      const row = (await client.query('SELECT * FROM pet_requests WHERE id = $1 FOR UPDATE',[req.params.id])).rows[0];
      if (!row) throw registrationError('Pet request not found.',404);
      if (row.status !== 'Pending') throw registrationError('This request has already been processed.',409);
      checkRequestRevision(row,req.body.revision);
      const saved = await client.query("UPDATE pet_requests SET status='Declined',decline_reason=$1,revision=revision+1 WHERE id=$2 RETURNING *",[reason.trim(),row.id]);
      await registrationAudit(client,req.user,`Declined pet request ${row.id}: ${reason.trim()}`);
      return saved.rows[0];
    });
    res.json({success:true,request:result});
  } catch(error) {res.status(error.status || 500).json({error:error.status ? error.message : 'Unable to save the review. Please retry.'});}
});

/* 5. APPOINTMENTS & CHECK-IN INTAKE FLOW */
// Owners receive open times only, never other clients or internal timetables.
clinicRouter.get("/appointments/availability", async (req, res) => {
  try {
    await ensureSchedulingSchema();
    const { vetId, date, service, excludeId } = req.query;
    if (!validDate(date)) throw bookingError("Choose a valid appointment date.");
    const doctor = (await query("SELECT id, vet_id FROM users WHERE role = 'vet' AND COALESCE(to_jsonb(users)->>'is_active', 'true') <> 'false' AND (vet_id = $1 OR id = $1)", [vetId])).rows[0];
    if (!doctor) throw bookingError("Choose a current veterinarian.");
    let excluded;
    if (excludeId) {
      excluded = (await query("SELECT * FROM appointments WHERE id = $1", [excludeId])).rows[0];
      if (!excluded || (req.user.role === "owner" && !(await query("SELECT id FROM pets WHERE id = $1 AND owner_id = $2", [excluded.pet_id, req.user.ownerId])).rows.length)) throw bookingError("Appointment not found.", 404);
    }
    const rows = (await query("SELECT * FROM appointments WHERE date = $1 AND vet_id = $2", [date, doctor.vet_id || doctor.id])).rows;
    res.json({ slots: availableSlots(rows, { date, service, excludeId: excluded?.id }) });
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : "Unable to load availability. Choose a valid date and retry." }); }
});

async function saveBooking(req, res, editing = false) {
  try {
    await ensureSchedulingSchema();
    const row = await withTransaction(async client => {
      await lockSchedule(client);
      const previous = editing ? (await client.query("SELECT * FROM appointments WHERE id = $1 FOR UPDATE", [req.params.id])).rows[0] : null;
      if (editing && !previous) throw bookingError("Appointment not found.", 404);
      if (previous && !["Scheduled", "Confirmed"].includes(previous.status)) throw bookingError("Only upcoming appointments can be edited.", 409);
      const b = req.body;
      const v = { petId: b.petId ?? previous?.pet_id, vetId: b.vetId ?? previous?.vet_id, date: b.date ?? previous?.date, time: b.time ?? previous?.time, reason: b.reason ?? previous?.reason, notes: b.notes ?? previous?.notes ?? "" };
      v.service = b.service ?? previous?.service ?? inferBookingService(v.reason);
      if (typeof v.reason !== "string" || v.reason.trim().length < 3 || v.reason.length > 300 || typeof v.notes !== "string" || v.notes.length > 200) throw bookingError("Add a visit reason (3–300 characters) and keep notes under 200 characters.");
      // Recheck ownership inside the transaction, after any simultaneous change.
      if (req.user.role === "owner") {
        for (const id of new Set([v.petId, previous?.pet_id].filter(Boolean))) {
          if (!(await client.query("SELECT id FROM pets WHERE id = $1 AND owner_id = $2", [id, req.user.ownerId])).rows.length) throw bookingError("Pet not found.", 404);
        }
      }
      const walkIn = !editing && b.bookingKind === "walk-in" && req.user.role === "assistant";
      let duration;
      if (walkIn) {
        const clock = clinicClock(); v.date = clock.date; v.time = clock.time;
        const existing = (await client.query("SELECT * FROM appointments WHERE date = $1 AND (vet_id = $2 OR pet_id = $3)", [v.date, v.vetId, v.petId])).rows;
        if (existing.some(a => a.pet_id === v.petId && !["Cancelled", "No-show", "Completed"].includes(a.status))) throw bookingError("This pet already has an active visit today. Check in that visit.", 409);
        duration = 30;
      } else {
        duration = await assertAvailable(client, v, previous?.id);
      }
      const changedSlot = previous && (v.petId !== previous.pet_id || v.vetId !== previous.vet_id || v.date !== previous.date || v.time !== previous.time || v.service !== previous.service);
      const values = [editing ? previous.id : b.id || `a_${crypto.randomUUID()}`, v.petId, v.vetId, v.date, v.time, v.reason.trim(), req.user.role === "owner" ? previous?.amount ?? 600 : Number(b.amount) || previous?.amount || 600, v.service, duration, walkIn ? "walk-in" : "reservation", v.notes];
      const sql = editing ? `UPDATE appointments SET pet_id=$2,vet_id=$3,date=$4,time=$5,reason=$6,amount=$7,status=$12,service=$8,duration_minutes=$9,booking_kind=$10,notes=$11 WHERE id=$1 RETURNING *` : `INSERT INTO appointments (id,pet_id,vet_id,date,time,reason,amount,service,duration_minutes,booking_kind,notes,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Scheduled') RETURNING *`;
      if (editing) values.push(changedSlot ? "Scheduled" : previous.status);
      // UPDATE uses the same parameter positions as INSERT.
      const saved = await client.query(sql, values);
      await client.query("INSERT INTO audit_logs (user_name,user_role,action) VALUES ($1,$2,$3)", [req.user.name,req.user.role,`${editing ? "Updated" : "Booked"} appointment ${values[0]} on ${v.date} ${v.time}`]);
      return saved.rows[0];
    });
    res.json({ success: true, appointment: { id: row.id, petId: row.pet_id, vetId: row.vet_id, date: toDateStr(row.date), time: row.time, reason: row.reason, notes: row.notes, service: row.service, durationMinutes: row.duration_minutes, bookingKind: row.booking_kind, status: row.status, billingStatus: row.billing_status, amount: Number(row.amount) } });
  } catch (error) {
    res.status(error.status || (error.code === "23505" ? 409 : 500)).json({ error: error.status ? error.message : error.code === "23505" ? "This booking already exists. Refresh before retrying." : "Unable to save the booking. Please retry." });
  }
}
clinicRouter.post("/appointments", (req, res) => saveBooking(req, res));
clinicRouter.put("/appointments/:id", (req, res) => saveBooking(req, res, true));

clinicRouter.patch("/appointments/:id/status", async (req, res) => {
  const apptId = req.params.id;
  const { status, intakeVitals, cancelReason, billingStatus, date, time, reason, actorName, actorRole } = req.body;

  try {
    if (date !== undefined || time !== undefined) await ensureSchedulingSchema();
    const result = await withTransaction(async (client) => {
      const current = (await client.query("SELECT * FROM appointments WHERE id = $1 FOR UPDATE", [apptId])).rows[0];
      if (!current) throw Object.assign(new Error("Appointment not found."), { status: 404 });
      if (req.user.role === "owner" && !(await client.query("SELECT id FROM pets WHERE id = $1 AND owner_id = $2", [current.pet_id, req.user.ownerId])).rows.length) throw Object.assign(new Error("Appointment not found."), { status: 404 });
      const invalid = validateStatusChange(current, req.body, req.user);
      if (invalid) throw Object.assign(new Error(invalid), { status: 409 });
      let q = "UPDATE appointments SET status = $1";
      const params = [status];
      let pIdx = 2;

      if (date !== undefined || time !== undefined) {
        if (status !== "Checked-in") throw bookingError("Use rescheduling to change a reserved slot.");
        const clock = clinicClock();
        if ((date !== undefined && date !== clock.date) || (time !== undefined && time !== clock.time)) throw bookingError("Arrivals must use the current clinic date and time.");
      }
      if (date !== undefined || time !== undefined) q += ", booking_kind = 'walk-in'";
      if (date !== undefined) {
        q += `, date = $${pIdx++}`;
        params.push(date);
      }
      if (time !== undefined) {
        q += `, time = $${pIdx++}`;
        params.push(time);
      }
      if (intakeVitals !== undefined) {
        q += `, intake_vitals = $${pIdx++}`;
        params.push(JSON.stringify(intakeVitals));
      }
      if (cancelReason !== undefined) {
        q += `, cancel_reason = $${pIdx++}`;
        params.push(cancelReason);
      }
      if (billingStatus !== undefined) {
        q += `, billing_status = $${pIdx++}`;
        params.push(billingStatus);
      }
      if (reason !== undefined) {
        q += `, reason = $${pIdx++}`;
        params.push(reason);
      }

      q += ` WHERE id = $${pIdx} RETURNING *`;
      params.push(apptId);

      const upd = await client.query(q, params);
      if (!upd.rows.length) throw new Error("Appointment not found");

      // If Checked-in and has weight in intake vitals, update pet weight log
      if (status === "Checked-in" && intakeVitals?.weight) {
        const appt = upd.rows[0];
        const numWeight = parseFloat(intakeVitals.weight);
        if (!isNaN(numWeight)) {
          await client.query("UPDATE pets SET weight = $1 WHERE id = $2", [numWeight, appt.pet_id]);
          await client.query(
            "INSERT INTO pet_weights (pet_id, date, kg, recorded_by) VALUES ($1, $2, $3, $4)",
            [appt.pet_id, appt.date, numWeight, actorName || "Front Desk"]
          );
        }
      }

      return upd.rows[0];
    });

    await recordAudit(actorName, actorRole, `Updated appointment ${apptId} status to "${status}"`);
    res.json({ success: true, appointment: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : "Unable to save visit status. Please try again." });
  }
});

clinicRouter.delete("/appointments/:id", async (req, res) => {
  try {
    await query("DELETE FROM appointments WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || (err.code === "23505" ? 409 : 500)).json({ error: err.status ? err.message : err.code === "23505" ? "This record already exists. Refresh before trying again." : "Unable to save clinic data. Please try again." });
  }
});

/* 5.1 CLINIC BILLING & PRICE CATALOG */


clinicRouter.get("/services/prices", (req, res) => {
  res.json({ success: true, catalog: priceCatalog() });
});

clinicRouter.post("/appointments/:id/billing", async (req, res) => {
  const apptId = req.params.id;
  const { amount, billingStatus, paymentMethod, actorName, actorRole } = req.body;
  const invoiceItems = canonicalInvoice(req.body.invoiceItems);

  const discount = req.body.discount === undefined ? 0 : Number(req.body.discount);
  const validItems = Array.isArray(invoiceItems) && invoiceItems.length > 0 && invoiceItems.length <= 100 && invoiceItems.every(item => item && typeof item.name === "string" && item.name.trim() && typeof item.price === "number" && Number.isFinite(item.price) && item.price >= 0 && item.price <= 10000000 && Number.isInteger(item.qty) && item.qty > 0 && item.qty <= 1000);
  const subtotal = validItems ? invoiceItems.reduce((sum, item) => sum + Math.round(item.price * 100) * item.qty, 0) : NaN;
  const total = (subtotal - Math.round(discount * 100)) / 100;
  if (!validItems || !Number.isFinite(discount) || discount < 0 || !Number.isFinite(total) || total <= 0 || total > 10000000 || typeof amount !== "number" || !Number.isFinite(amount) || Math.round(amount * 100) !== Math.round(total * 100) || !["Cash", "GCash", "Maya", "Credit / Debit Card"].includes(paymentMethod) || (billingStatus && billingStatus !== "Paid")) {
    return res.status(400).json({ error: "Check invoice quantities, prices, discount, total and payment method." });
  }
  if (paymentMethod === "Cash" ? (typeof req.body.cashTendered !== "number" || !Number.isFinite(req.body.cashTendered) || req.body.cashTendered < total) : (typeof req.body.paymentReference !== "string" || req.body.paymentReference.trim().length < 4 || req.body.paymentReference.length > 100)) return res.status(400).json({ error: "Enter sufficient cash received or the confirmed payment reference." });
  try {
    await ensureCheckoutSchema();
    await ensureCheckoutInboxSchema();
    const paymentDetails = { discount, reference: req.body.paymentReference || "", cashTendered: paymentMethod === "Cash" ? req.body.cashTendered : total, changeAmount: paymentMethod === "Cash" ? Math.round((req.body.cashTendered - total) * 100) / 100 : 0 };
    const result = await withTransaction(async client => {
      const current = (await client.query("SELECT * FROM appointments WHERE id = $1 FOR UPDATE", [apptId])).rows[0];
      if (!current) throw Object.assign(new Error("Appointment not found."), { status: 404 });
      if (current.status !== "Completed" || current.billing_status === "Paid") throw Object.assign(new Error("Only a completed, unpaid consultation can be checked out."), { status: 409 });
      if (!(await client.query("SELECT id FROM consultations WHERE appt_id = $1", [apptId])).rows.length) throw Object.assign(new Error("A finalized consultation is required before payment."), { status: 409 });
      await authorizeCheckoutPayment(client, apptId, req.user, req.body.claimToken);
      const updated = await client.query(
        `UPDATE appointments SET amount = $1, billing_status = 'Paid', payment_method = $2, invoice_items = $3, payment_details = $4, paid_at = NOW() WHERE id = $5 RETURNING *`,
        [total, paymentMethod, JSON.stringify(invoiceItems), JSON.stringify(paymentDetails), apptId]
      );
      await client.query("INSERT INTO audit_logs (user_name, user_role, action) VALUES ($1,$2,$3)", [req.user.name, req.user.role, `Processed payment ₱${total} (${paymentMethod}) for visit ${apptId}`]);
      await finishCheckoutTask(client, apptId, req.user.id);
      return updated;
    });

    const row = result.rows[0];

    res.json({
      success: true,
      appointment: {
        id: row.id,
        petId: row.pet_id,
        vetId: row.vet_id,
        date: toDateStr(row.date),
        time: row.time,
        reason: row.reason,
        status: row.status,
        billingStatus: row.billing_status,
        amount: parseFloat(row.amount),
        paymentMethod: row.payment_method,
        paymentReference: paymentDetails.reference,
        discount,
        cashTendered: paymentDetails.cashTendered,
        changeAmount: paymentDetails.changeAmount,
        paidAt: row.paid_at,
        invoiceItems: row.invoice_items
      }
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : "Unable to save payment. Refresh the visit before retrying." });
  }
});

/* 5.2 WALK-IN REGISTRATION (OWNER + PET + DIGITAL CARD + QUEUE) */
clinicRouter.post("/walk-in", async (req, res) => {
  const {
    ownerName, phone, email, address,
    petName, species, speciesOther, breed, sex, birth, weight, color, neutered, dentalOcclusion, notes,
    addToQueue, reason, actorName, actorRole,
    serviceCategory, specificVaccine,
    priorVaccines, externalClinicNotes
  } = req.body;

  const ownerId = "o_" + Math.random().toString(36).slice(2, 8);
  const petId = "p_" + Math.random().toString(36).slice(2, 8);
  const cardId = "VACC-" + new Date().getFullYear() + "-" + Math.floor(1000 + Math.random() * 9000);
  const today = clinicClock().date;

  try {
    await ensureSchedulingSchema();
    const result = await withTransaction(async (client) => {
      // 1. Insert Owner (or match existing by explicit ownerId, or by phone/email)
      let effectiveOwner = null;
      if (req.body.ownerId) {
        const existById = await client.query(
          `SELECT * FROM owners WHERE id = $1 LIMIT 1`,
          [req.body.ownerId]
        );
        if (existById.rows.length) {
          effectiveOwner = existById.rows[0];
        }
      }

      if (!effectiveOwner && (email || phone)) {
        const existQ = await client.query(
          `SELECT * FROM owners WHERE (email = $1 AND $1 <> '') OR (phone = $2 AND $2 <> '') LIMIT 1`,
          [email || "", phone || ""]
        );
        if (existQ.rows.length) {
          effectiveOwner = existQ.rows[0];
        }
      }

      if (!effectiveOwner) {
        const insOwner = await client.query(
          `INSERT INTO owners (id, name, email, phone, address)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [ownerId, ownerName, email || `walkin_${Date.now()}@pawcare.ph`, phone || "09170000000", address || "Metro Manila, PH"]
        );
        effectiveOwner = insOwner.rows[0];
      }

      // 2. Insert Pet
      const insPet = await client.query(
        `INSERT INTO pets (id, owner_id, name, species, species_other, breed, sex, birth, weight, color, neutered, vaccination_card_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          petId,
          effectiveOwner.id,
          petName,
          species || "Canine",
          speciesOther || "",
          breed || "Mixed Breed",
          sex || "Male",
          birth || today,
          parseFloat(weight) || 5.0,
          color || "",
          neutered || "Not sure",
          cardId,
          notes || ""
        ]
      );
      const pet = insPet.rows[0];

      // 3. Weight log
      await client.query(
        `INSERT INTO pet_weights (pet_id, date, kg, recorded_by) VALUES ($1, $2, $3, $4)`,
        [petId, today, parseFloat(weight) || 5.0, actorName || "Front Desk Walk-in"]
      );

      // 4. Seed Vaccines: Record Prior External History Guide + Pre-Schedule Next Protocol
      const sp = (species || "").toLowerCase();
      const isDog = sp.includes("dog") || sp.includes("canine");
      const isCat = sp.includes("cat") || sp.includes("feline");
      const addDays = (dStr, days) => {
        const d = new Date(dStr);
        d.setDate(d.getDate() + days);
        return d.toISOString().slice(0, 10);
      };

      const seeded = [];
      const priorList = Array.isArray(priorVaccines) ? priorVaccines : [];

      // A) Save Prior External Vaccines as Official Guide (done: true, recorded_by: Previous Vet)
      const hasPriorDHPP1 = priorList.some(x => /dhpp.*1|dose.*1|puppy.*1/i.test(String(x)));
      const hasPriorDHPP2 = priorList.some(x => /dhpp.*2|dose.*2|puppy.*2/i.test(String(x)));
      const hasPriorDHPP3 = priorList.some(x => /dhpp.*3|dose.*3|puppy.*3/i.test(String(x)));
      const hasPriorDHPPRoutine = priorList.some(x => /annual.*5-in-1|completed puppy|adult 5-in-1/i.test(String(x)));
      const hasPriorRabies = priorList.some(x => /rabies/i.test(String(x)));
      const hasPriorDeworm = priorList.some(x => /deworm/i.test(String(x)));
      const hasPriorFVRCP1 = priorList.some(x => /fvrcp.*1|feline.*1/i.test(String(x)));
      const hasPriorFVRCP2 = priorList.some(x => /fvrcp.*2|feline.*2/i.test(String(x)));

      for (const pItem of priorList) {
        const pLabel = typeof pItem === "string" ? pItem : pItem.name || "External Vaccine";
        const extV = {
          id: "v_ext_" + Math.random().toString(36).slice(2, 8),
          pet_id: petId,
          card_id: cardId,
          vaccine: pLabel,
          brand: "External Clinic Record",
          batch: "EXTERNAL-HIST",
          date: today,
          next_due: null,
          dose_no: 1,
          dose_of: 1,
          done: true,
          automated: false,
          protocol_type: "External History (Guide)",
          recorded_by: "Previous Vet (External Guide)"
        };
        await client.query(
          `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [...Object.values(extV), externalClinicNotes ? `Previous clinic note: ${externalClinicNotes}` : "Administered at external clinic; recorded as reference guide for schedule calibration."]
        );
        seeded.push(extV);
      }

      // B) Pre-Schedule Next Upcoming Protocol Based on What Was Given
      if (isDog) {
        // DHPP Logic
        let nextDHPP = "DHPP (5-in-1 Core Vaccine)";
        let dhppDoseNo = 1;
        let dhppDoseOf = 3;
        let dhppDueDays = 21;

        if (hasPriorDHPP1 && hasPriorDHPP2) {
          nextDHPP = "DHPP (5-in-1 Core Vaccine - Dose 3)";
          dhppDoseNo = 3;
          dhppDoseOf = 3;
          dhppDueDays = 21;
        } else if (hasPriorDHPP1) {
          nextDHPP = "DHPP (5-in-1 Core Vaccine - Dose 2)";
          dhppDoseNo = 2;
          dhppDoseOf = 3;
          dhppDueDays = 21;
        } else if (hasPriorDHPP3 || hasPriorDHPPRoutine) {
          nextDHPP = "DHPP (5-in-1 Adult Core Booster)";
          dhppDoseNo = 1;
          dhppDoseOf = 1;
          dhppDueDays = 365;
        }

        const isDHPPToday = serviceCategory === "vaccination" && (specificVaccine || "").toLowerCase().includes("5-in-1");
        const v1 = {
          id: "v_" + Math.random().toString(36).slice(2, 8),
          pet_id: petId,
          card_id: cardId,
          vaccine: isDHPPToday ? (specificVaccine || nextDHPP) : nextDHPP,
          brand: "Nobivac DHPP",
          batch: "WALK-DHPP",
          date: today,
          next_due: isDHPPToday ? addDays(today, dhppDoseNo === 3 ? 365 : 21) : addDays(today, dhppDueDays),
          dose_no: dhppDoseNo,
          dose_of: dhppDoseOf,
          done: false,
          automated: true,
          protocol_type: dhppDoseOf === 1 ? "Adult Core Immunization" : "Core Puppy Protocol",
          recorded_by: actorName || "Front Desk"
        };
        await client.query(
          `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          Object.values(v1)
        );
        seeded.push(v1);

        // Rabies Logic
        const isRabiesToday = serviceCategory === "vaccination" && (specificVaccine || "").toLowerCase().includes("rabies");
        const v2 = {
          id: "v_" + Math.random().toString(36).slice(2, 8),
          pet_id: petId,
          card_id: cardId,
          vaccine: isRabiesToday ? (specificVaccine || "Anti-Rabies (RA 9482 Compliance)") : (hasPriorRabies ? "Annual Anti-Rabies Core Booster" : "Anti-Rabies (RA 9482 Compliance)"),
          brand: "Defensor 3",
          batch: "WALK-RAB",
          date: today,
          next_due: (hasPriorRabies || isRabiesToday) ? addDays(today, 365) : addDays(today, 30),
          dose_no: 1,
          dose_of: 1,
          done: false,
          automated: true,
          protocol_type: "Legal Rabies Mandate",
          recorded_by: actorName || "Front Desk"
        };
        await client.query(
          `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          Object.values(v2)
        );
        seeded.push(v2);

        // Parasiticide & Deworming Pre-scheduling
        const isDewormToday = serviceCategory === "deworming" || (serviceCategory === "vaccination" && (specificVaccine || "").toLowerCase().includes("deworm"));
        const v3 = {
          id: "v_" + Math.random().toString(36).slice(2, 8),
          pet_id: petId,
          card_id: cardId,
          vaccine: "Broad-Spectrum Deworming",
          brand: "Canex Multi-Spectrum",
          batch: "WALK-DEW",
          date: today,
          next_due: isDewormToday ? addDays(today, 90) : (hasPriorDeworm ? addDays(today, 90) : addDays(today, 14)),
          dose_no: 1,
          dose_of: 4,
          done: false,
          automated: true,
          protocol_type: "Parasiticide Protocol",
          recorded_by: actorName || "Front Desk"
        };
        await client.query(
          `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          Object.values(v3)
        );
        seeded.push(v3);
      } else if (isCat) {
        // Feline FVRCP & Rabies
        let fvrcpName = "FVRCP (4-in-1 Feline Core)";
        let fvrcpDoseNo = 1;
        let fvrcpDoseOf = 2;
        let fvrcpDueDays = 21;

        if (hasPriorFVRCP1) {
          fvrcpName = "FVRCP (4-in-1 Feline Core - Dose 2)";
          fvrcpDoseNo = 2;
          fvrcpDueDays = 21;
        } else if (hasPriorFVRCP2) {
          fvrcpName = "FVRCP Annual Booster";
          fvrcpDoseNo = 1;
          fvrcpDoseOf = 1;
          fvrcpDueDays = 365;
        }

        const isFVRCPToday = serviceCategory === "vaccination" && (specificVaccine || "").toLowerCase().includes("fvrcp");
        const cv1 = {
          id: "v_" + Math.random().toString(36).slice(2, 8),
          pet_id: petId,
          card_id: cardId,
          vaccine: isFVRCPToday ? (specificVaccine || fvrcpName) : fvrcpName,
          brand: "Nobivac Feline 1-HCP",
          batch: "WALK-FVRCP",
          date: today,
          next_due: isFVRCPToday ? addDays(today, 365) : addDays(today, fvrcpDueDays),
          dose_no: fvrcpDoseNo,
          dose_of: fvrcpDoseOf,
          done: false,
          automated: true,
          protocol_type: "Core Feline Immunization",
          recorded_by: actorName || "Front Desk"
        };
        await client.query(
          `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          Object.values(cv1)
        );
        seeded.push(cv1);

        const isRabiesCatToday = serviceCategory === "vaccination" && (specificVaccine || "").toLowerCase().includes("rabies");
        const cv2 = {
          id: "v_" + Math.random().toString(36).slice(2, 8),
          pet_id: petId,
          card_id: cardId,
          vaccine: "Anti-Rabies (1-Year Feline Core)",
          brand: "Defensor 3",
          batch: "WALK-RAB-CAT",
          date: today,
          next_due: (hasPriorRabies || isRabiesCatToday) ? addDays(today, 365) : addDays(today, 30),
          dose_no: 1,
          dose_of: 1,
          done: false,
          automated: true,
          protocol_type: "Core Rabies Protocol",
          recorded_by: actorName || "Front Desk"
        };
        await client.query(
          `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          Object.values(cv2)
        );
        seeded.push(cv2);
      }

      // 5. If addToQueue: create Checked-in appointment with exact visit reason
      let appt = null;
      if (addToQueue) {
        const apptId = "a_walk_" + Math.random().toString(36).slice(2, 8);
        const timeNow = clinicClock().time;
        
        let visitReason = (reason || "").trim();
        if (!visitReason) {
          if (serviceCategory === "vaccination") {
            visitReason = `Vaccination: ${specificVaccine || "Core Vaccine Booster"}`;
          } else if (serviceCategory === "deworming") {
            visitReason = "Routine Deworming (Parasiticide)";
          } else if (serviceCategory === "flea_tick") {
            visitReason = "Flea & Tick Prevention (Chewable / Spot-on)";
          } else if (serviceCategory === "grooming") {
            visitReason = "Grooming & Sanitary Care";
          } else if (serviceCategory === "emergency") {
            visitReason = "Urgent / Emergency Clinical Triage";
          } else {
            visitReason = "Walk-in Consultation & Routine Exam";
          }
        }

        const triageLvl = serviceCategory === "emergency" ? "Emergency" : "Routine";

        const insAppt = await client.query(
          `INSERT INTO appointments (id, pet_id, vet_id, date, time, reason, status, billing_status, amount, intake_vitals, booking_kind)
           VALUES ($1, $2, $3, $4, $5, $6, 'Scheduled', 'Unbilled', 600, $7, 'walk-in')
           RETURNING *`,
          [
            apptId,
            petId,
            req.body.vetId,
            today,
            timeNow,
            visitReason,
            null
          ]
        );
        const aRow = insAppt.rows[0];
        appt = {
          id: aRow.id,
          petId: aRow.pet_id,
          vetId: aRow.vet_id,
          date: toDateStr(aRow.date),
          time: aRow.time,
          reason: aRow.reason,
          status: aRow.status,
          billingStatus: aRow.billing_status,
          amount: parseFloat(aRow.amount),
          intakeVitals: aRow.intake_vitals
        };
      }

      return {
        owner: effectiveOwner,
        pet: {
          id: pet.id,
          ownerId: pet.owner_id,
          name: pet.name,
          species: pet.species,
          speciesOther: pet.species_other || "",
          breed: pet.breed,
          sex: pet.sex,
          birth: toDateStr(pet.birth),
          weight: parseFloat(pet.weight),
          color: pet.color || "",
          neutered: pet.neutered || "Not sure",
          allergies: pet.allergies || [],
          vaccinationCardId: cardId,
          notes: pet.notes || "",
          photo: ""
        },
        vaccs: seeded,
        appointment: appt
      };
    });

    await recordAudit(actorName || "Front Desk", actorRole || "assistant", `Registered walk-in owner ${result.owner.name} & pet ${result.pet.name} (Issued Card #${cardId})`);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Walk-in registration error:", err.message);
    res.status(err.status || (err.code === "23505" ? 409 : 500)).json({ error: err.status ? err.message : err.code === "23505" ? "This record already exists. Refresh before trying again." : "Unable to save clinic data. Please try again." });
  }
});

/* 6. VACCINATIONS & FRONT DESK / ASSISTANT LOGGING */
clinicRouter.post("/vaccinations", async (req, res) => {
  const {
    id, petId, cardId, vaccine, brand, batch, date,
    nextDue, doseNo, doseOf, done, automated, protocolType,
    notes, vetId, recordedBy, actorName, actorRole
  } = req.body;
  const vaccId = id || ("v_" + Math.random().toString(36).slice(2, 8));
  const isDone = done !== undefined ? Boolean(done) : true;

  try {
    validateBoosterDate(date, nextDue);
    if (isDone) {
      // Reconcile with any existing unadministered placeholder for this pet
      const existingPlaceholder = await query(
        `SELECT id FROM vaccinations 
         WHERE pet_id = $1 AND done = false 
           AND (
             LOWER(vaccine) = LOWER($2)
             OR (LOWER($2) LIKE '%rabies%' AND LOWER(vaccine) LIKE '%rabies%')
             OR (LOWER($2) LIKE '%dhpp%' AND LOWER(vaccine) LIKE '%dhpp%')
             OR (LOWER($2) LIKE '%5-in-1%' AND LOWER(vaccine) LIKE '%5-in-1%')
             OR (LOWER($2) LIKE '%deworm%' AND LOWER(vaccine) LIKE '%deworm%')
             OR (LOWER($2) LIKE '%fvrcp%' AND LOWER(vaccine) LIKE '%fvrcp%')
           )
         ORDER BY date DESC LIMIT 1`,
        [petId, vaccine]
      );

      if (existingPlaceholder.rows.length) {
        const placeholderId = existingPlaceholder.rows[0].id;
        const upd = await query(
          `UPDATE vaccinations SET
             vaccine = $1, brand = $2, batch = $3, date = $4, next_due = $5,
             dose_no = $6, dose_of = $7, done = true, automated = false,
             notes = $8, vet_id = $9, recorded_by = $10
           WHERE id = $11
           RETURNING *`,
          [vaccine, brand || "", batch || "", date, nextDue || null, doseNo || 1, doseOf || 1, notes || "", vetId || "", recordedBy || actorName || "Veterinarian", placeholderId]
        );
        // Clean up any other remaining unadministered duplicates of this vaccine for this pet
        await query(
          `DELETE FROM vaccinations WHERE pet_id = $1 AND done = false AND id <> $2
           AND (
             (LOWER($3) LIKE '%rabies%' AND LOWER(vaccine) LIKE '%rabies%')
             OR (LOWER($3) LIKE '%dhpp%' AND LOWER(vaccine) LIKE '%dhpp%')
             OR (LOWER($3) LIKE '%5-in-1%' AND LOWER(vaccine) LIKE '%5-in-1%')
           )`,
          [petId, placeholderId, vaccine]
        );
        await recordAudit(actorName, actorRole, `Updated & certified vaccination ${vaccine} for pet ${petId}`);
        return res.json({ success: true, vaccination: upd.rows[0] });
      }
    }

    const result = await query(
      `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, notes, vet_id, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [vaccId, petId, cardId || "VACC-DEFAULT", vaccine, brand || "", batch || "", date, nextDue || null, doseNo || 1, doseOf || 1, isDone, Boolean(automated), protocolType || "", notes || "", vetId || "", recordedBy || actorName || "Front Desk Assistant"]
    );

    if (isDone) {
      await query(
        `DELETE FROM vaccinations WHERE pet_id = $1 AND done = false AND id <> $2
         AND (
           (LOWER($3) LIKE '%rabies%' AND LOWER(vaccine) LIKE '%rabies%')
           OR (LOWER($3) LIKE '%dhpp%' AND LOWER(vaccine) LIKE '%dhpp%')
           OR (LOWER($3) LIKE '%5-in-1%' AND LOWER(vaccine) LIKE '%5-in-1%')
         )`,
        [petId, result.rows[0].id, vaccine]
      );
    }

    await recordAudit(actorName, actorRole, `Logged vaccination ${vaccine} (${batch || "No lot#"}) for pet ${petId}`);
    res.json({ success: true, vaccination: result.rows[0] });
  } catch (err) {
    res.status(err.status || (err.code === "23505" ? 409 : 500)).json({ error: err.status ? err.message : err.code === "23505" ? "This record already exists. Refresh before trying again." : "Unable to save clinic data. Please try again." });
  }
});

clinicRouter.delete("/vaccinations/:id", async (req, res) => {
  const { id } = req.params;
  const { actorName, actorRole } = req.body;
  try {
    await query("DELETE FROM vaccinations WHERE id = $1", [id]);
    await recordAudit(actorName, actorRole, `Deleted vaccination record ${id}`);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || (err.code === "23505" ? 409 : 500)).json({ error: err.status ? err.message : err.code === "23505" ? "This record already exists. Refresh before trying again." : "Unable to save clinic data. Please try again." });
  }
});

/* 7. CONSULTATIONS (SOAP MEDICAL NOTES) */
clinicRouter.post("/consultations", async (req, res) => {
  const { id, petId, apptId, date, symptoms, objective, diagnosis, treatment, prescription, vaccination, weight } = req.body;
  const careError = validateCarePlan(req.body, date);
  if (careError) return res.status(400).json({ error: careError });
  const vetId = req.user.vetId || req.user.id;
  const consultId = id || ("c_" + crypto.randomUUID());
  const required = [symptoms, objective, diagnosis, treatment];
  if (required.some(v => typeof v !== "string" || !v.trim() || v.length > 10000) || typeof prescription !== "string" || prescription.length > 3000 || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
    return res.status(400).json({ error: "Complete the SOAP fields and enter a valid consultation date." });
  }
  if (vaccination && [vaccination.vaccine, vaccination.brand, vaccination.batch].some(v => typeof v !== "string" || !v.trim())) return res.status(400).json({ error: "Vaccine, brand and lot/batch are required." });
  if (vaccination?.nextDue && (!/^\d{4}-\d{2}-\d{2}$/.test(vaccination.nextDue) || vaccination.nextDue <= date)) return res.status(400).json({ error: "The booster date must follow the vaccination date." });
  if (weight !== undefined && (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0 || weight > 120)) return res.status(400).json({ error: "Enter a valid weight." });
  try {
    await ensureCheckoutInboxSchema();
    await ensureCareSchema();
    if (vaccination) validateBoosterDate(date, vaccination.nextDue);
    const result = await withTransaction(async client => {
      const appt = (await client.query("SELECT * FROM appointments WHERE id = $1 FOR UPDATE", [apptId])).rows[0];
      if (!appt || appt.pet_id !== petId || !assignedTo(appt, req.user)) throw Object.assign(new Error("An assigned visit is required."), { status: 403 });
      if (appt.status !== "In consultation") throw Object.assign(new Error("Start the consultation before finalizing. This visit may already be complete."), { status: 409 });
      const inserted = await client.query(
        `INSERT INTO consultations (id, pet_id, vet_id, appt_id, date, symptoms, objective, diagnosis, treatment, prescription)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [consultId, petId, vetId, apptId, date, symptoms.trim(), objective.trim(), diagnosis.trim(), treatment.trim(), prescription.trim()]
      );
      await client.query("UPDATE consultations SET care_status=$1, follow_up_date=$2, follow_up_reason=$3 WHERE id=$4", [req.body.careStatus || "Routine care", req.body.careStatus && req.body.careStatus !== "Routine care" ? req.body.followUpDate : null, req.body.careStatus && req.body.careStatus !== "Routine care" ? req.body.followUpReason.trim() : "", consultId]);
      let savedVaccination = null;
      if (vaccination) {
        const pet = (await client.query("SELECT vaccination_card_id FROM pets WHERE id = $1", [petId])).rows[0];
        if (!pet?.vaccination_card_id) throw Object.assign(new Error("The patient needs a clinic-issued vaccination card."), { status: 409 });
        const saved = await client.query(
          `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, done, notes, vet_id, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,$11) RETURNING *`,
          [vaccination.id || "v_" + crypto.randomUUID(), petId, pet.vaccination_card_id, vaccination.vaccine.trim(), vaccination.brand.trim(), vaccination.batch.trim(), date, vaccination.nextDue || null, vaccination.notes || "", vetId, req.user.name]
        );
        savedVaccination = saved.rows[0];
        await client.query("DELETE FROM vaccinations WHERE pet_id = $1 AND done = false AND LOWER(vaccine) = LOWER($2)", [petId, vaccination.vaccine]);
      }
      if (weight !== undefined) {
        await client.query("UPDATE pets SET weight = $1 WHERE id = $2", [weight, petId]);
        await client.query("INSERT INTO pet_weights (pet_id, date, kg, recorded_by) VALUES ($1,$2,$3,$4)", [petId, date, weight, req.user.name]);
      }
      await client.query("UPDATE appointments SET status = 'Completed', billing_status = 'Unbilled' WHERE id = $1", [apptId]);
      await createCheckoutTask(client, apptId);
      await client.query("INSERT INTO audit_logs (user_name, user_role, action) VALUES ($1,$2,$3)", [req.user.name, req.user.role, `Finalized consultation ${consultId} for visit ${apptId}`]);
      return { consultation: inserted.rows[0], vaccination: savedVaccination };
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.status || (err.code === "23505" ? 409 : 500)).json({ error: err.status ? err.message : "Unable to finalize the consultation. Refresh the visit before retrying." });
  }
});

/* 8. AUDIT LOGS RETRIEVAL & MANUAL LOGGING */
clinicRouter.get("/logs", async (req, res) => {
  try {
    const result = await query("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200");
    res.json({ success: true, logs: result.rows });
  } catch (err) {
    res.status(err.status || (err.code === "23505" ? 409 : 500)).json({ error: err.status ? err.message : err.code === "23505" ? "This record already exists. Refresh before trying again." : "Unable to save clinic data. Please try again." });
  }
});

clinicRouter.post("/logs", async (req, res) => {
  const { userName, userRole, action } = req.body;
  try {
    await recordAudit(userName, userRole, action);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || (err.code === "23505" ? 409 : 500)).json({ error: err.status ? err.message : err.code === "23505" ? "This record already exists. Refresh before trying again." : "Unable to save clinic data. Please try again." });
  }
});

/* 9. REMINDERS & LOG CALL (SEND VIA EMAIL & SMS) */
async function handleSendReminder(req, res) {
  try {
    const {
      ownerId,
      petId,
      vaccine,
      dueDate,
      ownerName,
      ownerPhone,
      ownerEmail,
      petName,
      staffName,
      staffRole,
      callNotes,
      sendEmail = true,
      sendSmsMsg = true,
    } = req.body;

    let targetOwnerName = ownerName || "Pet Parent";
    let targetPhone = ownerPhone || "";
    let targetEmail = ownerEmail || "";
    let targetPetName = petName || "your pet";

    // 1. Database lookups if IDs provided
    if (ownerId) {
      try {
        const oRes = await query("SELECT * FROM owners WHERE id = $1", [ownerId]);
        if (oRes.rows?.length) {
          const o = oRes.rows[0];
          targetOwnerName = o.name || targetOwnerName;
          targetPhone = o.phone || o.mobile || targetPhone;
          targetEmail = o.email || targetEmail;
        } else {
          // Check users table in case owner is stored as a user
          const uRes = await query("SELECT * FROM users WHERE id = $1", [ownerId]);
          if (uRes.rows?.length) {
            const u = uRes.rows[0];
            targetOwnerName = u.name || targetOwnerName;
            targetPhone = u.phone || u.mobile || targetPhone;
            targetEmail = u.email || targetEmail;
          }
        }
      } catch (dbErr) {
        console.warn("Owner lookup warning in reminder:", dbErr.message);
      }
    }

    if (petId) {
      try {
        const pRes = await query("SELECT * FROM pets WHERE id = $1", [petId]);
        if (pRes.rows?.length) {
          targetPetName = pRes.rows[0].name || targetPetName;
        }
      } catch (dbErr) {
        console.warn("Pet lookup warning in reminder:", dbErr.message);
      }
    }

    const appUrl = getAppUrl(req);
    const vaccineName = vaccine || "Vaccine Booster";
    const dueStr = dueDate ? toDateStr(dueDate) : "soon";

    let emailSent = false;
    let smsSent = false;
    const errors = [];

    // 2. Dispatch SMS if requested and phone number available
    if (sendSmsMsg && targetPhone) {
      const smsText = `PawCare Clinic: Hi ${targetOwnerName}! This is a reminder that ${targetPetName}'s ${vaccineName} is due on ${dueStr}. Please contact us or book a visit online: ${appUrl} . Have a great day!`;
      try {
        const smsRes = await sendSms(targetPhone, smsText);
        if (smsRes?.ok) smsSent = true;
      } catch (err) {
        errors.push("SMS failed: " + err.message);
      }
    }

    // 3. Dispatch Email if requested and email address available
    if (sendEmail && targetEmail) {
      const emailSubject = `🐾 PawCare Vaccine Reminder: ${targetPetName}'s ${vaccineName} Due`;
      const emailText = `Hello ${targetOwnerName}!\n\nThis is a friendly reminder from PawCare Veterinary Clinic that ${targetPetName} is due for their ${vaccineName} on ${dueStr}.\n\nBook your visit online: ${appUrl}\nClinic Phone: (02) 8920-1234 / 0917-123-4567\n\nWarm regards,\nPawCare Veterinary Team`;

      const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"></head>
      <body style="margin:0;padding:0;background-color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:28px 14px;">
          <tr>
            <td align="center">
              <table width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #e2e8f0;box-shadow:0 10px 25px rgba(0,0,0,0.06);">
                <tr>
                  <td style="background:linear-gradient(135deg,#1e3a8a 0%,#2563eb 100%);padding:28px 24px;text-align:center;">
                    <div style="font-size:36px;margin-bottom:6px;">🐾 💉</div>
                    <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:800;">PawCare Veterinary Clinic</h1>
                    <p style="margin:4px 0 0;color:#dbeafe;font-size:13px;">Health & Preventive Care Reminder</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:32px 28px;">
                    <h2 style="margin:0 0 12px;color:#002B49;font-size:19px;">Hi ${targetOwnerName}!</h2>
                    <p style="margin:0 0 18px;color:#475569;font-size:15px;line-height:1.6;">
                      Our veterinary staff conducted a routine schedule check and noticed that <b>${targetPetName}</b> is due for their <b>${vaccineName}</b> on <b>${dueStr}</b>.
                    </p>
                    ${callNotes ? `<div style="background:#fffbeb;border-left:4px solid #f59e0b;padding:10px 14px;border-radius:6px;font-size:13px;color:#92400e;margin-bottom:20px;"><b>Staff Call Note:</b> ${callNotes}</div>` : ""}
                    <div style="text-align:center;margin:28px 0 24px;">
                      <a href="${appUrl}/#portals" target="_blank" style="display:inline-block;background:linear-gradient(135deg,#ffe28a,#ffd24d);color:#002B49;font-size:15px;font-weight:800;padding:14px 32px;border-radius:99px;text-decoration:none;box-shadow:0 6px 18px rgba(255,200,60,0.4);">
                        Book Booster Appointment →
                      </a>
                    </div>
                    <div style="background:#f8fafc;padding:14px 16px;border-radius:12px;border:1px solid #e2e8f0;font-size:13px;color:#64748b;line-height:1.5;">
                      📍 <b>Clinic Address:</b> 123 Samson Road, Caloocan City<br>
                      📞 <b>Direct Line:</b> (02) 8920-1234 • 0917-123-4567<br>
                      🕒 <b>Hours:</b> Monday to Sunday • 8:00 AM – 7:00 PM
                    </div>
                  </td>
                </tr>
                <tr>
                  <td style="background:#f8fafc;padding:16px 24px;text-align:center;border-top:1px solid #e2e8f0;font-size:11.5px;color:#94a3b8;">
                    PawCare Daily Hub • Helping keep your pets healthy and vaccinated.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
      `;

      try {
        const mailRes = await sendMail(targetEmail, emailSubject, emailText, emailHtml);
        if (mailRes?.ok) emailSent = true;
      } catch (err) {
        errors.push("Email failed: " + err.message);
      }
    }

    // 4. Record in audit_logs
    const channels = [emailSent ? `Email (${targetEmail})` : null, smsSent ? `SMS (${targetPhone})` : null].filter(Boolean).join(" & ") || "None (no contact on file)";
    const auditAction = `Logged reminder call for owner ${targetOwnerName} (${targetPetName} - ${vaccineName} due ${dueStr}). Dispatched reminders via: ${channels}.${callNotes ? ` Call Note: "${callNotes}"` : ""}`;
    await recordAudit(req.user.name, req.user.role, auditAction);

    res.json({
      success: true,
      emailSent,
      smsSent,
      targetOwnerName,
      targetPetName,
      targetEmail,
      targetPhone,
      message: `Call logged successfully! Reminders dispatched: ${channels}`,
      errors: errors.length ? errors : undefined,
    });
  } catch (err) {
    console.error("Failed to log call and send reminder:", err);
    res.status(500).json({ error: "Failed to process reminder call: " + err.message });
  }
}

clinicRouter.get("/reminders/status", async (req, res) => {
  try {
    await ensureSchedulingSchema();
    const summary = (await query("SELECT status, COUNT(*)::integer AS count FROM vaccination_reminders GROUP BY status")).rows;
    const attention = (await query(`SELECT r.id,r.channel,r.status,r.due_date,v.vaccine,p.name AS pet_name
      FROM vaccination_reminders r JOIN vaccinations v ON v.id=r.vaccination_id JOIN pets p ON p.id=v.pet_id
      WHERE r.status IN ('failed','uncertain') ORDER BY r.scheduled_at DESC LIMIT 100`)).rows;
    const health = (await query("SELECT * FROM reminder_worker_health WHERE id=1")).rows[0];
    const overdue = (await query("SELECT COUNT(*)::integer AS count FROM vaccination_reminders WHERE status='pending' AND next_attempt_at < NOW() - INTERVAL '1 day'")).rows[0]?.count || 0;
    res.json({ health: { lastRun: health?.last_completed_at || null, overdue, emailConfigured: Boolean(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL || process.env.SMTP_USER && process.env.SMTP_PASS), smsConfigured: Boolean((process.env.TEXTBEE_API_KEY || process.env.TEXTBEE_KEY) && process.env.TEXTBEE_DEVICE_ID) }, summary: Object.fromEntries(summary.map(r => [r.status,r.count])), attention: attention.map(r => ({ id:r.id,channel:r.channel,status:r.status,dueDate:toDateStr(r.due_date),vaccine:r.vaccine,petName:r.pet_name })) });
  } catch { res.status(500).json({ error:"Unable to load reminder status." }); }
});

clinicRouter.post("/reminders/log-call", handleSendReminder);
clinicRouter.post("/reminders/send", handleSendReminder);


// A handoff transfers responsibility and preserves the sending doctor's instructions.
clinicRouter.post('/appointments/:id/handoff', async (req, res) => {
  const { vetId, note } = req.body;
  if (typeof vetId !== 'string' || typeof note !== 'string' || !note.trim() || note.length > 3000) return res.status(400).json({error: 'Choose a veterinarian and enter handoff instructions (up to 3000 characters).'});
  try {
    await ensureCareSchema();
    await withTransaction(async client => {
      const row = (await client.query('SELECT * FROM appointments WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
      if (!row || !assignedTo(row, req.user)) throw Object.assign(new Error('This visit is no longer assigned to you.'), {status: 403});
      if (!['Checked-in', 'In consultation'].includes(row.status)) throw Object.assign(new Error('Only an active arrival can be handed over.'), {status: 409});
      const target = (await client.query("SELECT id,vet_id,first_name,last_name FROM users WHERE role='vet' AND (id=$1 OR vet_id=$1) AND COALESCE(to_jsonb(users)->>'is_active','true') <> 'false' FOR SHARE", [vetId])).rows[0];
      if (!target || [req.user.id, req.user.vetId].includes(target.id) || [req.user.id, req.user.vetId].filter(Boolean).includes(target.vet_id)) throw Object.assign(new Error('Choose another active veterinarian.'), {status: 400});
      const recipient = target.vet_id || target.id;
      const entry = {from: req.user.name, fromId: req.user.vetId || req.user.id, to: `${target.first_name} ${target.last_name}`, toId: recipient, note: note.trim(), at: new Date().toISOString()};
      await client.query("UPDATE appointments SET vet_id=$1, status='Checked-in', handoffs=handoffs || $2::jsonb WHERE id=$3", [recipient, JSON.stringify([entry]), row.id]);
      await client.query('INSERT INTO audit_logs (user_name,user_role,action) VALUES ($1,$2,$3)', [req.user.name, req.user.role, `Handed visit ${row.id} to ${recipient}`]);
    });
    res.json({success: true});
  } catch (e) { res.status(e.status || 500).json({error: e.status ? e.message : 'Unable to save handoff. Please retry.'}); }
});
