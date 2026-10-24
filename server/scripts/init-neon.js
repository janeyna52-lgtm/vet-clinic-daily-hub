import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { query, pool } from "../db.js";
import { hashPassword } from "../security.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log("==========================================");
  console.log(" PawCare Neon DB Initialization & Seeding ");
  console.log("==========================================");

  if (!process.env.DATABASE_URL) {
    console.error("\n❌ ERROR: DATABASE_URL is not set in .env!");
    console.error("Please add your Neon PostgreSQL connection string to your .env file:");
    console.error('DATABASE_URL="postgresql://neondb_owner:password@ep-xyz.region.aws.neon.tech/neondb?sslmode=require"\n');
    process.exit(1);
  }

  try {
    console.log("Connecting to Neon DB...");
    const test = await query("SELECT current_database(), version()");
    console.log(`Connected to database "${test.rows[0].current_database}"`);

    // 1. Run Schema DDL
    const schemaPath = path.join(__dirname, "../database/schema.sql");
    const schemaSql = fs.readFileSync(schemaPath, "utf-8");
    console.log("Executing schema DDL...");
    await query(schemaSql);
    await query(fs.readFileSync(path.join(__dirname, "../database/scheduling.sql"), "utf-8"));
    console.log("Tables and indexes successfully verified.");

    await query(fs.readFileSync(path.join(__dirname, "../database/checkout-inbox.sql"), "utf-8"));

    await query(fs.readFileSync(path.join(__dirname, "../database/pet-registration.sql"), "utf-8"));

    await query(fs.readFileSync(path.join(__dirname, "../database/staff-access.sql"), "utf-8"));

    await query(fs.readFileSync(path.join(__dirname, "../database/care-workflow.sql"), "utf8"));

    // 2. Default Seed Passwords (satisfies 12-128 chars, uppercase, lowercase, number, symbol)
    const adminPassHash = await hashPassword("Admin1234567!");
    const vetPassHash = await hashPassword("Vet123456789!");
    const assistPassHash = await hashPassword("Assist123456!");
    const ownerPassHash = await hashPassword("Owner1234567!");

    console.log("Seeding RBAC Users & Staff...");

    // Seed Admin
    await query(`
      INSERT INTO users (id, first_name, last_name, birthday, password_hash, email, role, mobile_number, email_verified_at, mobile_verified)
      VALUES ('u_admin_1', 'Admin', 'Officer', '1985-05-15', $1, 'admin@pawcare.com', 'admin', '+63 917 123 4567', NOW(), true)
      ON CONFLICT (email) DO NOTHING
    `, [adminPassHash]);

    // Seed Vets
    await query(`
      INSERT INTO users (id, first_name, last_name, birthday, password_hash, email, role, vet_id, mobile_number, email_verified_at, mobile_verified)
      VALUES 
        ('u_vet_1', 'Ana', 'Cruz', '1990-03-20', $1, 'vet@pawcare.com', 'vet', 'u_vet_1', '+63 918 234 5678', NOW(), true),
        ('u_vet_2', 'Ben', 'Lim', '1988-11-12', $1, 'vet2@pawcare.com', 'vet', 'u_vet_2', '+63 919 345 6789', NOW(), true)
      ON CONFLICT (email) DO NOTHING
    `, [vetPassHash]);

    // Seed Assistant
    await query(`
      INSERT INTO users (id, first_name, last_name, birthday, password_hash, email, role, mobile_number, email_verified_at, mobile_verified)
      VALUES ('u_asst_1', 'Liza', 'Ramos', '1995-08-25', $1, 'assistant@pawcare.com', 'assistant', '+63 920 456 7890', NOW(), true)
      ON CONFLICT (email) DO NOTHING
    `, [assistPassHash]);

    // Seed Pet Owners
    await query(`
      INSERT INTO users (id, first_name, last_name, birthday, password_hash, email, role, owner_id, mobile_number, email_verified_at, mobile_verified)
      VALUES 
        ('u_owner_1', 'Maria', 'Santos', '1992-04-10', $1, 'maria@example.com', 'owner', 'o_1', '+63 917 888 1111', NOW(), true),
        ('u_owner_2', 'Jose', 'Dalisay', '1989-09-18', $1, 'jose@example.com', 'owner', 'o_2', '+63 917 888 2222', NOW(), true)
      ON CONFLICT (email) DO NOTHING
    `, [ownerPassHash]);

    // 3. Seed Client Masterlist (Owners)
    await query(`
      INSERT INTO owners (id, user_id, name, email, phone, address)
      VALUES
        ('o_1', 'u_owner_1', 'Maria Santos', 'maria@example.com', '+63 917 888 1111', '12 Mabini St., Brgy. San Antonio, Pasig City'),
        ('o_2', 'u_owner_2', 'Jose Dalisay', 'jose@example.com', '+63 917 888 2222', '45 Katipunan Ave., Loyola Heights, Quezon City'),
        ('o_3', NULL, 'Carla Gomez', 'carla.g@example.com', '+63 922 333 4444', '88 Rizal Ave., San Carlos, Makati City')
      ON CONFLICT (id) DO NOTHING
    `);

    // 4. Seed Patient Masterlist (Pets)
    await query(`
      INSERT INTO pets (id, owner_id, name, species, breed, sex, birth, weight, color, neutered, allergies, vaccination_card_id, notes)
      VALUES
        ('p_1', 'o_1', 'Bantay', 'Dog', 'Golden Retriever', 'Male', '2021-03-15', 24.50, 'Golden Blonde', 'Yes', '{"Chicken"}', 'VACC-2026-1001', 'Friendly, calm during physical exams.'),
        ('p_2', 'o_1', 'Mingming', 'Cat', 'Domestic Shorthair', 'Female', '2022-07-20', 4.20, 'Calico', 'Yes', '{}', 'VACC-2026-1002', 'Prefers gentle handling; dislikes loud noises.'),
        ('p_3', 'o_2', 'Choco', 'Dog', 'Shih Tzu', 'Male', '2023-01-08', 6.10, 'Brown & White', 'No', '{}', 'VACC-2026-1003', 'Active and playful.')
      ON CONFLICT (id) DO NOTHING
    `);

    // 5. Seed Pet Weights History
    await query(`
      INSERT INTO pet_weights (pet_id, date, kg, recorded_by)
      VALUES
        ('p_1', '2023-03-15', 22.0, 'Front Desk'),
        ('p_1', '2023-09-10', 23.8, 'Front Desk'),
        ('p_1', '2024-03-15', 24.5, 'Front Desk'),
        ('p_2', '2023-07-20', 3.8, 'Front Desk'),
        ('p_2', '2024-01-15', 4.2, 'Front Desk'),
        ('p_3', '2023-07-01', 5.5, 'Front Desk'),
        ('p_3', '2024-01-10', 6.1, 'Front Desk')
      ON CONFLICT DO NOTHING
    `);

    // 6. Seed Pending Online Pet Request (Luna)
    await query(`
      INSERT INTO pet_requests (id, owner_id, name, species, breed, sex, birth, weight, color, neutered, notes, status, requested_at)
      VALUES
        ('req_luna', 'o_1', 'Luna', 'Cat', 'Persian', 'Female', '2023-10-12', 3.50, 'White', 'No', 'Indoor cat, very sweet temperament. Awaiting digital vaccine card activation.', 'Pending', CURRENT_DATE)
      ON CONFLICT (id) DO NOTHING
    `);

    // 7. Seed Appointments
    const today = new Date().toISOString().slice(0, 10);
    await query(`
      INSERT INTO appointments (id, pet_id, vet_id, date, time, reason, status, billing_status, amount, intake_vitals)
      VALUES
        ('a_1', 'p_1', 'u_vet_1', $1, '09:00 AM', 'Annual Booster & Routine Checkup', 'Checked-in', 'Unbilled', 850.00, '{"weight": 24.5, "weightStatus": "healthy", "temp": 38.4, "tempStatus": "normal", "heartRate": 95, "checkedInBy": "Liza Ramos"}'),
        ('a_2', 'p_2', 'u_vet_2', $1, '10:30 AM', 'Skin Scratching / Allergy Consultation', 'Confirmed', 'Unbilled', 600.00, NULL),
        ('a_3', 'p_3', 'u_vet_1', $1, '02:00 PM', 'Rabies Booster Shot', 'Scheduled', 'Unbilled', 500.00, NULL)
      ON CONFLICT (id) DO NOTHING
    `, [today]);

    // 8. Seed Vaccinations
    await query(`
      INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, notes, vet_id, recorded_by)
      VALUES
        ('v_1', 'p_1', 'VACC-2026-1001', 'Rabies (1-Year)', 'Defensor 3', 'DEF-9021', '2023-03-20', '2024-03-20', 1, 1, true, false, 'Core Rabies', 'No adverse reaction', 'u_vet_1', 'Dr. Ana Cruz'),
        ('v_2', 'p_1', 'VACC-2026-1001', 'DHPP (5-in-1)', 'Nobivac Puppy-DP', 'NOB-4412', '2023-04-10', '2024-04-10', 3, 3, true, false, 'Core Canine Protocol', 'Completed primary series', 'u_vet_1', 'Dr. Ana Cruz'),
        ('v_3', 'p_1', 'VACC-2026-1001', 'Bordetella (Kennel Cough)', 'Bronchicine CAe', 'BRN-1088', '2024-04-15', '2025-04-15', 1, 1, false, false, 'Elective Protocol', 'Scheduled for next month', '', 'Liza Ramos'),
        ('v_4', 'p_2', 'VACC-2026-1002', 'FVRCP (4-in-1)', 'Fel-O-Vax IV', 'FEL-5501', '2023-08-01', '2024-08-01', 2, 2, true, false, 'Core Feline Protocol', 'Tolerated well', 'u_vet_2', 'Dr. Ben Lim'),
        ('v_5', 'p_3', 'VACC-2026-1003', 'Rabies (1-Year)', 'Defensor 3', 'DEF-9033', '2023-02-14', '2024-02-14', 1, 1, true, false, 'Core Rabies', 'Due for booster today', 'u_vet_1', 'Dr. Ana Cruz')
      ON CONFLICT (id) DO NOTHING
    `);

    // 9. Seed Consultations (SOAP Notes)
    await query(`
      INSERT INTO consultations (id, pet_id, vet_id, appt_id, date, symptoms, objective, diagnosis, treatment, prescription)
      VALUES
        ('c_1', 'p_1', 'u_vet_1', 'a_1', '2023-09-10', 'Mild ear shaking and redness in left ear pinna.', 'Erythema and moderate ceruminous discharge in left ear canal. Tympanic membrane intact. T: 38.6C, HR: 100 bpm.', 'Otitis Externa (Unilateral)', 'Ear cleaning with Otic flush; applied Otomax suspension.', 'Otomax ear drops: 4 drops in left ear twice daily for 7 days.')
      ON CONFLICT (id) DO NOTHING
    `);

    // 10. Seed Audit Logs
    await query(`
      INSERT INTO audit_logs (user_name, user_role, action)
      VALUES
        ('System Initializer', 'system', 'Database schema created and initial clinic records seeded'),
        ('Admin Officer', 'admin', 'Configured clinic operational settings and staff profiles'),
        ('Liza Ramos', 'assistant', 'Checked in patient Bantay for morning appointment')
    `);

    console.log("\n==========================================");
    console.log(" ✅ Neon DB Initialization Complete!");
    console.log("==========================================");
    console.log("Demo Accounts Created:");
    console.log(" • Clinic Admin:   admin@pawcare.com     / Admin1234567!");
    console.log(" • Veterinarian:   vet@pawcare.com       / Vet123456789!");
    console.log(" • Vet Assistant:  assistant@pawcare.com / Assist123456!");
    console.log(" • Pet Owner:      maria@example.com     / Owner1234567!");
    console.log("==========================================\n");

  } catch (err) {
    console.error("Initialization failed:", err);
  } finally {
    await pool.end();
  }
}

main();

