/**
 * Create an admin user in the database.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/create-admin.js <email> <password>
 *
 * Or with Railway:
 *   railway run node scripts/create-admin.js admin@canadaaccountants.app MySecurePassword123
 */

const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];

  if (!email || !password) {
    console.error('Usage: node scripts/create-admin.js <email> <password>');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  try {
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, user_type, email_verified, is_active, profile_completed)
       VALUES ($1, $2, 'admin', TRUE, TRUE, TRUE)
       ON CONFLICT (email) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         user_type = 'admin',
         is_active = TRUE
       RETURNING id, email, user_type`,
      [email, passwordHash]
    );

    const user = result.rows[0];
    console.log(`Admin user created/updated: ${user.email} (id: ${user.id})`);
  } catch (err) {
    console.error('Failed to create admin user:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
