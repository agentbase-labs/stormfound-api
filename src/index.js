const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { pool, init } = require('./db');
const { sign, authRequired, adminRequired } = require('./auth');
const { fetchAll } = require('./prices');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '256kb' }));

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

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

    // Aggregations
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    let dailyUsd = 0;
    let allTimeUsd = 0;
    for (const row of r.rows) {
      const v = parseFloat(row.usd_value);
      allTimeUsd += v;
      if (new Date(row.created_at) >= today) dailyUsd += v;
    }
    res.json({
      items: r.rows,
      totals: {
        daily_usd: dailyUsd,
        all_time_usd: allTimeUsd,
        count: r.rows.length,
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/liquidations', adminRequired, async (req, res) => {
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

    const r = await pool.query(
      `INSERT INTO liquidations (asset, amount, usd_value, note, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, asset, amount::text AS amount, usd_value::text AS usd_value, note, created_at`,
      [a, amt, usd, note || null, ts]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.delete('/liquidations/:id', adminRequired, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    await pool.query('DELETE FROM liquidations WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
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
  app.listen(PORT, () => console.log('Stormfound API on :' + PORT));
})();
