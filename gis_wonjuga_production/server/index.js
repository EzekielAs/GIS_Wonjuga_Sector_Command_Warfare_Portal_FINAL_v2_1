import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { Pool, Client } from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('tiny'));

// ONE POOL ONLY - ONLINE DB
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  ssl: process.env.PGSSL === 'true'? { rejectUnauthorized: false } : undefined
});

const q = (text, params = []) => pool.query(text, params);

// INIT DB - RUNS ONCE AT STARTUP (ONLINE)
(async () => {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'true'? { rejectUnauthorized: false } : undefined
  });
  try {
    await client.connect();
    console.log('✅ CONNECTED TO ONLINE DB');
    await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        full_name TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS operational_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'active',
        created_by UUID,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS offline_queue (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        payload JSONB NOT NULL,
        synced BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    const hashed = await bcrypt.hash('NaNa@Yaa/93', 10);
    await client.query(`
      INSERT INTO users (username, password_hash, role, full_name)
      VALUES ('mainadmin', $1, 'mainadmin', 'Main Admin')
      ON CONFLICT (username) DO UPDATE SET password_hash = $1, role='mainadmin';
    `, [hashed]);
    console.log('✅ ONLINE DB READY - mainadmin / NaNa@Yaa/93');
  } catch (e) {
    console.error('INIT DB ERROR', e);
  } finally {
    try { await client.end(); } catch {}
  }
})();

app.disable('x-powered-by');

const JWT_SECRET = process.env.JWT_SECRET || 'gis-wonjuga-secret-key-2024';

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ')? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
}

// AUTH - ALWAYS ONLINE
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username ||!password) return res.status(400).json({ error: 'Missing credentials' });
    const r = await q(`SELECT * FROM users WHERE username=$1`, [username]);
    if (r.rows.length === 0) return res.status(401).json({ error: 'Invalid login' });
    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid login' });
    const token = signToken(user);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role, full_name: user.full_name } });
  } catch (e) {
    console.error('LOGIN ERROR', e);
    res.status(500).json({ error: 'Login failed', detail: e.message });
  }
});

app.get('/api/health', async (req, res) => {
  try { await q('SELECT 1'); res.json({ ok: true, db: 'online' }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/users/me', auth, async (req, res) => {
  const r = await q('SELECT id, username, role, full_name FROM users WHERE id=$1', [req.user.id]);
  res.json(r.rows[0]);
});

app.get('/api/events', auth, async (req, res) => {
  const r = await q('SELECT * FROM operational_events ORDER BY created_at DESC');
  res.json(r.rows);
});

app.post('/api/events', auth, async (req, res) => {
  const { title, description } = req.body;
  const r = await q(`INSERT INTO operational_events (title, description, created_by) VALUES ($1,$2,$3) RETURNING *`, [title, description, req.user.id]);
  res.json(r.rows[0]);
});

app.post('/api/offline/sync', auth, async (req, res) => {
  const { items } = req.body;
  if (!items) return res.json({ synced: 0 });
  let count = 0;
  for (const it of items) {
    await q(`INSERT INTO offline_queue (payload, synced) VALUES ($1, true)`, [it]);
    count++;
  }
  res.json({ synced: count });
});

// STATIC
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(publicDir, 'index.html'));
  });
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`GIS Wonjuga Portal running on ${PORT}`));
