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

    // Check if user already exists
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);

    let user;
    if (existing.rows.length > 0) {
      const result = await pool.query(
        `UPDATE users SET password_hash = $1, user_type = 'admin', is_active = TRUE
         WHERE email = $2 RETURNING id, email, user_type`,
        [passwordHash, email]
      );
      user = result.rows[0];
      console.log(`Admin user updated: ${user.email} (id: ${user.id})`);
    } else {
      const result = await pool.query(
        `INSERT INTO users (email, password_hash, user_type, email_verified, is_active, profile_completed)
         VALUES ($1, $2, 'admin', TRUE, TRUE, TRUE)
         RETURNING id, email, user_type`,
        [email, passwordHash]
      );
      user = result.rows[0];
      console.log(`Admin user created: ${user.email} (id: ${user.id})`);
    }
  } catch (err) {
    console.error('Failed to create admin user:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
