const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { DateTime } = require('luxon');
const { pool, init } = require('./db');
const { sign, authRequired, adminRequired } = require('./auth');
const { fetchAll } = require('./prices');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '256kb' }));

const TZ = 'Asia/Jerusalem';

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now(), tz: TZ }));

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'missing credentials' });
    }
    const r = await pool.query(
      'SELECT username, password_hash, role FROM users WHERE username = $1',
      [username.toLowerCase().trim()]
    );
    const u = r.rows[0];
    if (!u) return res.status(401).json({ error: 'invalid credentials' });
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });
    const token = sign(u);
    res.json({
      token,
      user: { username: u.username, role: u.role },
    });
  } catch (e) {
    console.error('login error', e);
    res.status(500).json({ error: 'server error' });
  }
});

app.get('/me', authRequired, (req, res) => {
  res.json({ username: req.user.sub, role: req.user.role });
});

app.get('/prices', async (req, res) => {
  try {
    const data = await fetchAll();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/holdings', authRequired, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT asset, amount::text AS amount, updated_at FROM holdings ORDER BY asset'
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.put('/holdings', adminRequired, async (req, res) => {
  try {
    const { asset, amount } = req.body || {};
    if (!asset || amount == null) {
      return res.status(400).json({ error: 'asset and amount required' });
    }
    const a = String(asset).toUpperCase().trim();
    const amt = Number(amount);
    if (!isFinite(amt) || amt < 0) {
      return res.status(400).json({ error: 'invalid amount' });
    }
    await pool.query(
      `INSERT INTO holdings (asset, amount, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (asset) DO UPDATE SET amount = EXCLUDED.amount, updated_at = NOW()`,
      [a, amt]
    );
    const r = await pool.query(
      'SELECT asset, amount::text AS amount, updated_at FROM holdings ORDER BY asset'
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/liquidations', authRequired, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, asset, amount::text AS amount, usd_value::text AS usd_value, note, created_at
       FROM liquidations ORDER BY created_at DESC LIMIT 500`
    );

    // "Today" = current calendar day in Israel time
    const startIsrael = DateTime.now().setZone(TZ).startOf('day');
    const endIsrael = startIsrael.plus({ days: 1 });
    const startMs = startIsrael.toMillis();
    const endMs = endIsrael.toMillis();

    let dailyUsd = 0;
    let allTimeUsd = 0;
    let dailyCount = 0;
    for (const row of r.rows) {
      const v = parseFloat(row.usd_value);
      allTimeUsd += v;
      const t = new Date(row.created_at).getTime();
      if (t >= startMs && t < endMs) {
        dailyUsd += v;
        dailyCount += 1;
      }
    }
    res.json({
      items: r.rows,
      totals: {
        daily_usd: dailyUsd,
        all_time_usd: allTimeUsd,
        count: r.rows.length,
        daily_count: dailyCount,
        tz: TZ,
        day_start_utc: startIsrael.toUTC().toISO(),
        day_end_utc: endIsrael.toUTC().toISO(),
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/liquidations', adminRequired, async (req, res) => {
  const client = await pool.connect();
  try {
    const { asset, amount, usd_value, note, created_at } = req.body || {};
    if (!asset || amount == null || usd_value == null) {
      return res.status(400).json({ error: 'asset, amount, usd_value required' });
    }
    const a = String(asset).toUpperCase().trim();
    const amt = Number(amount);
    const usd = Number(usd_value);
    if (!isFinite(amt) || amt <= 0 || !isFinite(usd) || usd < 0) {
      return res.status(400).json({ error: 'invalid amount or usd_value' });
    }
    const ts = created_at ? new Date(created_at) : new Date();
    if (isNaN(ts.getTime())) return res.status(400).json({ error: 'invalid date' });

    await client.query('BEGIN');

    const ins = await client.query(
      `INSERT INTO liquidations (asset, amount, usd_value, note, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, asset, amount::text AS amount, usd_value::text AS usd_value, note, created_at`,
      [a, amt, usd, note || null, ts]
    );

    // Reduce holdings atomically
    await client.query(
      `INSERT INTO holdings (asset, amount, updated_at) VALUES ($1, 0, NOW())
       ON CONFLICT (asset) DO NOTHING`,
      [a]
    );
    const upd = await client.query(
      `UPDATE holdings SET amount = amount - $1, updated_at = NOW()
        WHERE asset = $2
        RETURNING asset, amount::text AS amount`,
      [amt, a]
    );

    await client.query('COMMIT');
    res.json({
      ...ins.rows[0],
      holdings_after: upd.rows[0] || null,
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('post liquidations', e);
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    client.release();
  }
});

app.delete('/liquidations/:id', adminRequired, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'invalid id' });

    await client.query('BEGIN');
    const fetched = await client.query(
      `SELECT id, asset, amount FROM liquidations WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (fetched.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not found' });
    }
    const liq = fetched.rows[0];
    await client.query('DELETE FROM liquidations WHERE id = $1', [id]);
    const upd = await client.query(
      `UPDATE holdings SET amount = amount + $1, updated_at = NOW()
        WHERE asset = $2
        RETURNING asset, amount::text AS amount`,
      [Number(liq.amount), liq.asset]
    );
    await client.query('COMMIT');
    res.json({
      ok: true,
      restored: { asset: liq.asset, amount: String(liq.amount) },
      holdings_after: upd.rows[0] || null,
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('delete liquidations', e);
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await init();
    console.log('DB initialized');
  } catch (e) {
    console.error('DB init failed:', e.message);
  }
  app.listen(PORT, () => console.log(`Stormfound API on :${PORT} (tz=${TZ})`));
})();