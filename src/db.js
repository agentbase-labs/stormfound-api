const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS holdings (
      asset TEXT PRIMARY KEY,
      amount NUMERIC NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS liquidations (
      id SERIAL PRIMARY KEY,
      asset TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      usd_value NUMERIC NOT NULL,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Seed users (idempotent)
  const trumpHash = process.env.TRUMP26_HASH;
  const satoshiHash = process.env.SATOSHI_HASH;
  if (trumpHash) {
    await pool.query(
      `INSERT INTO users (username, password_hash, role)
       VALUES ($1, $2, 'viewer')
       ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      ['trump26', trumpHash]
    );
  }
  if (satoshiHash) {
    await pool.query(
      `INSERT INTO users (username, password_hash, role)
       VALUES ($1, $2, 'admin')
       ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      ['satoshi', satoshiHash]
    );
  }

  // Seed holdings (only if missing)
  await pool.query(
    `INSERT INTO holdings (asset, amount) VALUES ('RAIN', 747500000000)
     ON CONFLICT (asset) DO NOTHING`
  );
  await pool.query(
    `INSERT INTO holdings (asset, amount) VALUES ('ENLV', 200000000)
     ON CONFLICT (asset) DO NOTHING`
  );
}

module.exports = { pool, init };
