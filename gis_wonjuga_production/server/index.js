require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 8080);
const JWT_SECRET = process.env.JWT_SECRET || '';
// AUTO-FIX FOR RENDER - Don't crash
if (!process.env.DATABASE_URL) console.log("NO DATABASE_URL SET!");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  ssl: process.env.PGSSL === 'true'? { rejectUnauthorized: false } : undefined
});

// CREATE TABLES ONLINE AUTOMATICALLY
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL
      );
    `);
    const hash = await bcrypt.hash('NaNa@Yaa/93', 10);
    await pool.query(
      `INSERT INTO users (username, password, role) VALUES ('mainadmin', $1, 'admin') ON CONFLICT (username) DO NOTHING`, [hash]
    );
    console.log("✅ ONLINE DB READY");
  } catch(e){ console.log("DB init error", e.message) }

const q = (text, params = []) => pool.query(text, params);

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN.split(',').map(x => x.trim()), credentials: true }));
}
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false }));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
const publicLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 80, standardHeaders: true, legacyHeaders: false });

function sign(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, username: user.username, member_id: user.member_id || null },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Invalid or expired session' }); }
}
function allow(...roles) {
  return (req, res, next) => roles.includes(req.user.role)
    ? next()
    : res.status(403).json({ error: 'Insufficient permission' });
}
async function audit(actor, action, entityType, entityId, metadata = {}) {
  try {
    await q(
      'INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5)',
      [actor || null, action, entityType || null, entityId || null, metadata]
    );
  } catch (e) { console.error('audit:', e.message); }
}
function internalRef(prefix = 'WJ') {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}
function money(n) { return Number(Number(n).toFixed(2)); }
function cleanPhone(value) { return String(value || '').trim().replace(/[\s-]/g, ''); }
function validMoney(value) { return Number.isFinite(Number(value)) && Number(value) > 0; }
function monthStart(value) {
  const s = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-01$/.test(s) ? s : null;
}

async function getSetting(key, fallback) {
  const r = await q('SELECT value_json FROM settings WHERE key=$1', [key]);
  return r.rowCount ? r.rows[0].value_json : fallback;
}
async function monthlyAmount() {
  const s = await getSetting('monthly_contribution', { amount: Number(process.env.MONTHLY_CONTRIBUTION_GHS || 100) });
  return money(s.amount);
}
async function activationFee() {
  const s = await getSetting('activation_fee', { amount: Number(process.env.ACTIVATION_FEE_GHS || 0) });
  return money(s.amount);
}
async function bankDetails() {
  return getSetting('bank_details', { bank_name: '', account_name: '', account_number: '', branch: '', instructions: '' });
}
async function ensurePeriod(period = null) {
  const target = monthStart(period) || new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString().slice(0, 10);
  const amount = await monthlyAmount();
  const dueDate = new Date(`${target.slice(0, 7)}-10T00:00:00Z`).toISOString().slice(0, 10);
  await q(
    'INSERT INTO contribution_periods(period_month,amount,due_date) VALUES($1,$2,$3) ON CONFLICT(period_month) DO UPDATE SET amount=EXCLUDED.amount,due_date=EXCLUDED.due_date',
    [target, amount, dueDate]
  );
  const r = await q('SELECT * FROM contribution_periods WHERE period_month=$1', [target]);
  return r.rowCount ? r.rows[0] : null;
}
async function finalizePayment(payment, providerEvent, status = 'SUCCESS') {
  const p = payment.id ? payment : (await q('SELECT * FROM payments WHERE id=$1', [payment])).rows[0];
  if (!p) return null;
  const finalStatus = status === 'SUCCESS' ? 'SUCCESS' : 'FAILED';
  const updated = await q(
    `UPDATE payments SET status=$1,raw_provider_event=$2,provider_reference=COALESCE($3,provider_reference),
     paid_at=CASE WHEN $1='SUCCESS' THEN COALESCE(paid_at,now()) ELSE paid_at END,updated_at=now()
     WHERE id=$4 RETURNING *`,
    [finalStatus, providerEvent || null, providerEvent?.data?.reference || null, p.id]
  );
  if (finalStatus === 'SUCCESS' && p.type === 'ACTIVATION') {
    await q('UPDATE members SET activation_paid=true,updated_at=now() WHERE id=$1', [p.member_id]);
  }
  return updated.rows[0];
}

// Paystack webhook: raw bytes are required for HMAC verification.
app.post('/api/payments/paystack/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const secret = process.env.PAYSTACK_SECRET_KEY || '';
    const signature = req.headers['x-paystack-signature'];
    if (!secret || !signature) return res.status(401).send('invalid signature');
    const expected = crypto.createHmac('sha512', secret).update(req.body).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(signature), 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).send('invalid signature');

    const event = JSON.parse(req.body.toString('utf8'));
    const data = event.data || {};
    const reference = data.reference;
    if (reference && ['charge.success', 'charge.failed'].includes(event.event)) {
      const payment = await q('SELECT * FROM payments WHERE provider_reference=$1 OR internal_reference=$1 LIMIT 1', [reference]);
      if (payment.rowCount) {
        const status = event.event === 'charge.success' ? 'SUCCESS' : 'FAILED';
        const updated = await finalizePayment(payment.rows[0], event, status);
        await audit(null, 'PAYMENT_WEBHOOK', 'payment', updated.id, { event: event.event, reference });
      }
    }
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('webhook:', e.message);
    return res.status(400).json({ error: 'Invalid webhook' });
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

app.get('/api/health', async (req, res) => {
  try { await q('SELECT 1'); res.json({ ok: true, service: 'GIS Wonjuga Sector Command Warfare Portal', time: new Date().toISOString() }); }
  catch { res.status(503).json({ ok: false, error: 'Database unavailable' }); }
});

app.get('/api/public/config', publicLimiter, async (req, res) => {
  res.json({
    institution: await getSetting('institution', { name: 'GHANA IMMIGRATION SERVICE WONJUGA SECTOR COMMAND WARFARE', motto: 'Friendship with Vigilance' }),
    monthly_contribution: await monthlyAmount(),
    activation_fee: await activationFee(),
    bank_details: await bankDetails()
  });
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
    const r = await q('SELECT * FROM users WHERE username=$1 AND enabled=true', [username]);
    if (!r.rowCount || !(await bcrypt.compare(password, r.rows[0].password_hash))) return res.status(401).json({ error: 'Invalid credentials' });
    const u = r.rows[0];
    await q('UPDATE users SET last_login_at=now() WHERE id=$1', [u.id]);
    await audit(u.id, 'LOGIN', 'user', u.id, {});
    res.json({ token: sign(u), user: { id: u.id, username: u.username, display_name: u.display_name, role: u.role, member_id: u.member_id } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Login failed' }); }
});

app.post('/api/auth/member-activate', loginLimiter, async (req, res) => {
  try {
    const service_number = String(req.body?.service_number || '').trim();
    const phone = cleanPhone(req.body?.phone);
    const password = String(req.body?.password || '');
    if (!service_number || !phone || password.length < 8) return res.status(400).json({ error: 'Service Number, phone and an 8+ character password are required' });
    const r = await q("SELECT * FROM members WHERE service_number=$1 AND status='PENDING_ACTIVATION' AND activation_paid=true", [service_number]);
    if (!r.rowCount) return res.status(404).json({ error: 'Member not found, not approved, or activation payment not verified' });
    const m = r.rows[0];
    if (cleanPhone(m.phone) !== phone) return res.status(401).json({ error: 'Phone number does not match the approved member record' });
    if (await q('SELECT id FROM users WHERE member_id=$1', [m.id]).then(x => x.rowCount)) return res.status(409).json({ error: 'Member account already activated' });
    const hash = await bcrypt.hash(password, 12);
    const u = await q('INSERT INTO users(member_id,username,display_name,password_hash,role) VALUES($1,$2,$3,$4,\'MEMBER\') RETURNING *', [m.id, m.service_number, m.full_name, hash]);
    await q("UPDATE members SET status='ACTIVE',activated_at=now(),updated_at=now() WHERE id=$1", [m.id]);
    await audit(u.rows[0].id, 'MEMBER_ACTIVATED', 'member', m.id, {});
    res.status(201).json({ token: sign({ ...u.rows[0], member_id: m.id }), user: { id: u.rows[0].id, username: m.service_number, display_name: m.full_name, role: 'MEMBER', member_id: m.id } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Activation failed' }); }
});

app.get('/api/me', auth, async (req, res) => {
  const r = await q('SELECT id,username,display_name,role,member_id,enabled,last_login_at FROM users WHERE id=$1', [req.user.sub]);
  if (!r.rowCount) return res.status(401).json({ error: 'User no longer exists' });
  res.json(r.rows[0]);
});

app.patch('/api/me/password', auth, async (req, res) => {
  const current = String(req.body?.current_password || '');
  const next = String(req.body?.new_password || '');
  if (next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const r = await q('SELECT password_hash FROM users WHERE id=$1 AND enabled=true', [req.user.sub]);
  if (!r.rowCount || !(await bcrypt.compare(current, r.rows[0].password_hash))) return res.status(401).json({ error: 'Current password is incorrect' });
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(next, 12), req.user.sub]);
  await audit(req.user.sub, 'CHANGE_PASSWORD', 'user', req.user.sub, {});
  res.json({ ok: true });
});

// Public activation: payment first. Main Admin/Member Manager assigns Service Number after payment verification.
app.post('/api/public/activation/initiate', publicLimiter, async (req, res) => {
  try {
    const full_name = String(req.body?.full_name || '').trim();
    const phone = cleanPhone(req.body?.phone);
    const email = String(req.body?.email || '').trim() || null;
    const rank = String(req.body?.rank || '').trim() || null;
    const station = String(req.body?.station || '').trim() || null;
    const channel = String(req.body?.channel || 'MTN_MOMO');
    if (!full_name || !phone) return res.status(400).json({ error: 'Full name and phone are required' });
    if (!['MTN_MOMO', 'TELECEL', 'AIRTELTIGO', 'BANK'].includes(channel)) return res.status(400).json({ error: 'Unsupported activation payment channel' });
    const fee = await activationFee();
    if (fee <= 0) return res.status(409).json({ error: 'Activation fee is not configured. Ask the Main Administrator to set it.' });

    const existing = await q("SELECT m.*,p.internal_reference,p.status AS payment_status FROM members m JOIN payments p ON p.member_id=m.id AND p.type='ACTIVATION' WHERE m.phone=$1 AND m.status='PENDING_ACTIVATION' ORDER BY m.created_at DESC LIMIT 1", [phone]);
    if (existing.rowCount) return res.status(409).json({ error: `An activation request already exists for this phone. Reference: ${existing.rows[0].internal_reference}` });

    const m = await q('INSERT INTO members(full_name,phone,email,rank,station,status) VALUES($1,$2,$3,$4,$5,\'PENDING_ACTIVATION\') RETURNING *', [full_name, phone, email, rank, station]);
    const p = await q('INSERT INTO payments(member_id,type,channel,amount,internal_reference) VALUES($1,\'ACTIVATION\',$2,$3,$4) RETURNING *', [m.rows[0].id, channel, fee, internalRef('ACT')]);

    if (channel === 'BANK') {
      return res.status(201).json({
        member_id: m.rows[0].id, payment_id: p.rows[0].id, internal_reference: p.rows[0].internal_reference,
        amount: fee, channel, status: 'PENDING', bank_details: await bankDetails(),
        message: 'Complete the bank transfer using the reference shown. Finance will reconcile the payment before your Service Number is assigned.'
      });
    }

    const key = process.env.PAYSTACK_SECRET_KEY || '';
    if (!key || key.includes('replace_me')) {
      return res.status(201).json({ member_id: m.rows[0].id, payment_id: p.rows[0].id, internal_reference: p.rows[0].internal_reference, amount: fee, channel, status: 'PENDING_CONFIGURATION', message: 'Payment intent created. Configure the Paystack server secret before live charging.' });
    }
    const provider = channel === 'MTN_MOMO' ? 'mtn' : channel === 'TELECEL' ? 'vod' : 'atl';
    const customerEmail = email || `${phone.replace(/\D/g, '')}@wonjuga.local`;
    const resp = await fetch('https://api.paystack.co/charge', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: customerEmail, amount: Math.round(fee * 100), currency: process.env.PAYSTACK_CURRENCY || 'GHS', mobile_money: { phone, provider } })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.status) {
      await q("UPDATE payments SET status='FAILED',raw_provider_event=$1,updated_at=now() WHERE id=$2", [data, p.rows[0].id]);
      return res.status(502).json({ error: 'Payment provider rejected the activation request' });
    }
    await q('UPDATE payments SET provider_reference=$1,raw_provider_event=$2,updated_at=now() WHERE id=$3', [data.data?.reference || null, data, p.rows[0].id]);
    res.status(201).json({ member_id: m.rows[0].id, payment_id: p.rows[0].id, internal_reference: p.rows[0].internal_reference, provider_reference: data.data?.reference, amount: fee, channel, status: data.data?.status, display_text: data.data?.display_text || null });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not create activation request' }); }
});

app.get('/api/public/activation/status', publicLimiter, async (req, res) => {
  const reference = String(req.query.reference || '').trim();
  const phone = cleanPhone(req.query.phone);
  if (!reference || !phone) return res.status(400).json({ error: 'Reference and phone are required' });
  const r = await q(`SELECT m.full_name,m.service_number,m.status,m.activation_paid,p.internal_reference,p.status AS payment_status,p.amount,p.channel,p.created_at
                     FROM payments p JOIN members m ON m.id=p.member_id WHERE p.internal_reference=$1 AND m.phone=$2 LIMIT 1`, [reference, phone]);
  if (!r.rowCount) return res.status(404).json({ error: 'Activation request not found' });
  res.json(r.rows[0]);
});

// Administration
const adminRoles = ['MAIN_ADMIN', 'FINANCE_OFFICER', 'WELFARE_OFFICER', 'MEMBER_MANAGER', 'REPORT_VIEWER'];
app.get('/api/admin/dashboard', auth, allow(...adminRoles), async (req, res) => {
  const period = await ensurePeriod();
  const [members, paid, amount, activation, claims] = await Promise.all([
    q("SELECT count(*)::int AS n FROM members WHERE status='ACTIVE'"),
    q("SELECT count(DISTINCT member_id)::int AS n FROM payments WHERE contribution_period_id=$1 AND type='MONTHLY_WELFARE' AND status IN ('SUCCESS','RECONCILED')", [period.id]),
    q("SELECT COALESCE(sum(amount),0)::numeric AS n FROM payments WHERE contribution_period_id=$1 AND type='MONTHLY_WELFARE' AND status IN ('SUCCESS','RECONCILED')", [period.id]),
    q("SELECT count(*)::int AS n FROM members WHERE activation_paid=true AND service_number IS NULL"),
    q("SELECT count(*)::int AS n FROM welfare_claims WHERE status='PENDING'")
  ]);
  res.json({ period, active_members: members.rows[0].n, paid_members: paid.rows[0].n, collected: money(amount.rows[0].n), pending_activation_service_numbers: activation.rows[0].n, pending_claims: claims.rows[0].n, monthly_due: money(members.rows[0].n * period.amount) });
});

app.get('/api/admin/members', auth, allow(...adminRoles), async (req, res) => {
  const search = String(req.query.search || '').trim();
  const r = await q(`SELECT m.*,u.username AS portal_username
                     FROM members m LEFT JOIN users u ON u.member_id=m.id
                     WHERE ($1='' OR m.service_number ILIKE '%'||$1||'%' OR m.full_name ILIKE '%'||$1||'%' OR m.rank ILIKE '%'||$1||'%' OR m.phone ILIKE '%'||$1||'%')
                     ORDER BY m.created_at DESC LIMIT 500`, [search]);
  res.json(r.rows);
});
app.post('/api/admin/members', auth, allow('MAIN_ADMIN', 'MEMBER_MANAGER'), async (req, res) => {
  try {
    const d = req.body || {};
    if (!String(d.full_name || '').trim()) return res.status(400).json({ error: 'Full name required' });
    const r = await q('INSERT INTO members(full_name,service_number,phone,email,rank,station,status) VALUES($1,$2,$3,$4,$5,$6,\'PENDING_ACTIVATION\') RETURNING *', [String(d.full_name).trim(), d.service_number || null, cleanPhone(d.phone), d.email || null, d.rank || null, d.station || null]);
    await audit(req.user.sub, 'CREATE_MEMBER', 'member', r.rows[0].id, { service_number: r.rows[0].service_number });
    res.status(201).json(r.rows[0]);
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Service Number already exists' }); res.status(500).json({ error: 'Could not create member' }); }
});
app.patch('/api/admin/members/:id', auth, allow('MAIN_ADMIN', 'MEMBER_MANAGER'), async (req, res) => {
  try {
    const allowed = ['full_name', 'phone', 'email', 'rank', 'station', 'status', 'momo_number'];
    const keys = Object.keys(req.body || {}).filter(k => allowed.includes(k));
    if (!keys.length) return res.status(400).json({ error: 'No editable fields supplied' });
    const vals = keys.map(k => k === 'phone' || k === 'momo_number' ? cleanPhone(req.body[k]) : req.body[k]);
    const sets = keys.map((k, i) => `${k}=$${i + 1}`).join(', ');
    vals.push(req.params.id);
    const r = await q(`UPDATE members SET ${sets},updated_at=now() WHERE id=$${vals.length} RETURNING *`, vals);
    if (!r.rowCount) return res.status(404).json({ error: 'Member not found' });
    await audit(req.user.sub, 'UPDATE_MEMBER', 'member', r.rows[0].id, { fields: keys });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: 'Update failed' }); }
});
app.post('/api/admin/members/:id/assign-service-number', auth, allow('MAIN_ADMIN', 'MEMBER_MANAGER'), async (req, res) => {
  try {
    const service_number = String(req.body?.service_number || '').trim();
    if (!service_number) return res.status(400).json({ error: 'Service Number required' });
    const r = await q('UPDATE members SET service_number=$1,updated_at=now() WHERE id=$2 AND activation_paid=true RETURNING *', [service_number, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Member not found or activation payment is not verified' });
    await audit(req.user.sub, 'ASSIGN_SERVICE_NUMBER', 'member', r.rows[0].id, { service_number });
    res.json(r.rows[0]);
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Service Number already assigned' }); res.status(500).json({ error: 'Could not assign Service Number' }); }
});

app.get('/api/admin/payments', auth, allow(...adminRoles), async (req, res) => {
  const r = await q(`SELECT p.*,m.service_number,m.full_name,cp.period_month
                     FROM payments p LEFT JOIN members m ON m.id=p.member_id LEFT JOIN contribution_periods cp ON cp.id=p.contribution_period_id
                     ORDER BY p.created_at DESC LIMIT 1000`);
  res.json(r.rows);
});
app.post('/api/admin/payments/bank', auth, allow('MAIN_ADMIN', 'FINANCE_OFFICER'), async (req, res) => {
  try {
    const d = req.body || {};
    const amount = Number(d.amount);
    const type = d.type || 'MONTHLY_WELFARE';
    if (!d.member_id || !validMoney(amount) || !d.provider_reference) return res.status(400).json({ error: 'Member, valid amount and bank reference are required' });
    let periodId = null;
    if (type === 'MONTHLY_WELFARE') {
      const period = await ensurePeriod(monthStart(d.period_month));
      if (!period) return res.status(400).json({ error: 'Contribution period not found' });
      if (money(amount) !== money(period.amount)) return res.status(400).json({ error: `Monthly contribution must be ${money(period.amount)} GHS for this period` });
      periodId = period.id;
      const exists = await q("SELECT id FROM payments WHERE member_id=$1 AND contribution_period_id=$2 AND type='MONTHLY_WELFARE' AND status IN ('SUCCESS','RECONCILED')", [d.member_id, periodId]);
      if (exists.rowCount) return res.status(409).json({ error: 'This member is already paid for the selected month' });
    }
    if (type === 'ACTIVATION' && money(amount) !== await activationFee()) return res.status(400).json({ error: 'Amount does not match the configured activation fee' });
    const r = await q(`INSERT INTO payments(member_id,contribution_period_id,type,channel,amount,provider_reference,internal_reference,status,paid_at)
                       VALUES($1,$2,$3,'BANK',$4,$5,$6,'RECONCILED',now()) RETURNING *`, [d.member_id, periodId, type, amount, d.provider_reference, internalRef('BANK')]);
    if (type === 'ACTIVATION') await q('UPDATE members SET activation_paid=true,updated_at=now() WHERE id=$1', [d.member_id]);
    await audit(req.user.sub, 'RECORD_BANK_PAYMENT', 'payment', r.rows[0].id, { provider_reference: d.provider_reference });
    res.status(201).json(r.rows[0]);
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Bank reference already recorded or payment already exists' }); res.status(500).json({ error: 'Could not record bank payment' }); }
});

async function createPaystackCharge(member, payment, phone) {
  const key = process.env.PAYSTACK_SECRET_KEY || '';
  if (!key || key.includes('replace_me')) return { configured: false };
  const provider = payment.channel === 'MTN_MOMO' ? 'mtn' : payment.channel === 'TELECEL' ? 'vod' : 'atl';
  const email = member.email || `${member.service_number.toLowerCase().replace(/[^a-z0-9]/g, '')}@wonjuga.local`;
  const resp = await fetch('https://api.paystack.co/charge', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, amount: Math.round(Number(payment.amount) * 100), currency: process.env.PAYSTACK_CURRENCY || 'GHS', mobile_money: { phone: cleanPhone(phone || member.momo_number || member.phone), provider } })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.status) throw Object.assign(new Error('Payment provider rejected the request'), { providerData: data });
  await q('UPDATE payments SET provider_reference=$1,raw_provider_event=$2,updated_at=now() WHERE id=$3', [data.data?.reference || null, data, payment.id]);
  return { configured: true, data };
}

app.post('/api/payments/initialize', auth, allow('MEMBER'), async (req, res) => {
  try {
    const type = req.body?.type || 'MONTHLY_WELFARE';
    const channel = String(req.body?.channel || '');
    if (!['MTN_MOMO', 'TELECEL', 'AIRTELTIGO'].includes(channel)) return res.status(400).json({ error: 'Select MTN MoMo, Telecel or AirtelTigo' });
    const mr = await q('SELECT m.* FROM members m WHERE m.id=$1', [req.user.member_id]);
    if (!mr.rowCount) return res.status(404).json({ error: 'Member profile not found' });
    const member = mr.rows[0];
    let amount, periodId = null;
    if (type === 'MONTHLY_WELFARE') {
      const period = await ensurePeriod(); amount = money(period.amount); periodId = period.id;
      const paid = await q("SELECT id FROM payments WHERE member_id=$1 AND contribution_period_id=$2 AND type='MONTHLY_WELFARE' AND status IN ('SUCCESS','RECONCILED')", [member.id, periodId]);
      if (paid.rowCount) return res.status(409).json({ error: 'Current month contribution is already paid' });
    } else return res.status(400).json({ error: 'Only monthly welfare payments are available from the member portal' });

    const internal = internalRef('WEL');
    const p = await q('INSERT INTO payments(member_id,contribution_period_id,type,channel,amount,internal_reference) VALUES($1,$2,\'MONTHLY_WELFARE\',$3,$4,$5) RETURNING *', [member.id, periodId, channel, amount, internal]);
    try {
      const charge = await createPaystackCharge(member, p.rows[0], req.body?.phone);
      if (!charge.configured) return res.json({ payment_id: p.rows[0].id, internal_reference: internal, status: 'PENDING_CONFIGURATION', amount, channel, message: 'Payment intent created. Paystack is not configured on this server yet.' });
      return res.json({ payment_id: p.rows[0].id, internal_reference: internal, provider_reference: charge.data.data?.reference, status: charge.data.data?.status, display_text: charge.data.data?.display_text || null, amount, channel });
    } catch (e) {
      await q("UPDATE payments SET status='FAILED',raw_provider_event=$1,updated_at=now() WHERE id=$2", [e.providerData || { error: e.message }, p.rows[0].id]);
      return res.status(502).json({ error: e.message });
    }
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not initialize payment' }); }
});

app.post('/api/payments/:id/verify', auth, allow('MEMBER'), async (req, res) => {
  try {
    const p = await q('SELECT * FROM payments WHERE id=$1 AND member_id=$2', [req.params.id, req.user.member_id]);
    if (!p.rowCount) return res.status(404).json({ error: 'Payment not found' });
    if (!p.rows[0].provider_reference) return res.status(400).json({ error: 'Payment provider reference is not available yet' });
    const key = process.env.PAYSTACK_SECRET_KEY || '';
    if (!key || key.includes('replace_me')) return res.status(409).json({ error: 'Payment provider is not configured' });
    const resp = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(p.rows[0].provider_reference)}`, { headers: { Authorization: `Bearer ${key}` } });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.status) return res.status(502).json({ error: 'Could not verify payment' });
    const status = data.data?.status === 'success' ? 'SUCCESS' : data.data?.status === 'failed' ? 'FAILED' : 'PENDING';
    if (status === 'SUCCESS') await finalizePayment(p.rows[0], data, 'SUCCESS');
    else if (status === 'FAILED') await finalizePayment(p.rows[0], data, 'FAILED');
    else await q('UPDATE payments SET raw_provider_event=$1,updated_at=now() WHERE id=$2', [data, p.rows[0].id]);
    res.json({ status, payment: (await q('SELECT * FROM payments WHERE id=$1', [p.rows[0].id])).rows[0] });
  } catch (e) { res.status(500).json({ error: 'Payment verification failed' }); }
});

app.get('/api/member/dashboard', auth, allow('MEMBER'), async (req, res) => {
  const m = (await q('SELECT * FROM members WHERE id=$1', [req.user.member_id])).rows[0];
  if (!m) return res.status(404).json({ error: 'Member profile not found' });
  const period = await ensurePeriod();
  const payments = await q('SELECT * FROM payments WHERE member_id=$1 ORDER BY created_at DESC LIMIT 100', [m.id]);
  const current = payments.rows.find(p => p.contribution_period_id === period.id && ['SUCCESS', 'RECONCILED'].includes(p.status));
  const announcements = await q('SELECT id,title,body,created_at FROM announcements WHERE published=true ORDER BY created_at DESC LIMIT 10');
  res.json({ member: m, period, current_payment: current || null, payments: payments.rows, announcements: announcements.rows, bank_details: await bankDetails() });
});
app.get('/api/member/profile', auth, allow('MEMBER'), async (req, res) => {
  const r = await q('SELECT full_name,service_number,rank,unit,station,phone,momo_number,email,status,activated_at FROM members WHERE id=$1', [req.user.member_id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Member not found' }); res.json(r.rows[0]);
});

app.get('/api/member/welfare/claims', auth, allow('MEMBER'), async (req, res) => {
  const r = await q('SELECT * FROM welfare_claims WHERE member_id=$1 ORDER BY created_at DESC', [req.user.member_id]); res.json(r.rows);
});
app.post('/api/member/welfare/claims', auth, allow('MEMBER'), async (req, res) => {
  const category = String(req.body?.category || '').trim(); const amount = Number(req.body?.amount_requested); const description = String(req.body?.description || '').trim() || null;
  if (!category || !validMoney(amount)) return res.status(400).json({ error: 'Category and a valid requested amount are required' });
  const r = await q('INSERT INTO welfare_claims(member_id,category,amount_requested,description) VALUES($1,$2,$3,$4) RETURNING *', [req.user.member_id, category, amount, description]);
  await audit(req.user.sub, 'CREATE_WELFARE_CLAIM', 'welfare_claim', r.rows[0].id, {}); res.status(201).json(r.rows[0]);
});

app.get('/api/admin/welfare/claims', auth, allow('MAIN_ADMIN', 'WELFARE_OFFICER', 'REPORT_VIEWER'), async (req, res) => {
  const r = await q('SELECT c.*,m.service_number,m.full_name FROM welfare_claims c JOIN members m ON m.id=c.member_id ORDER BY c.created_at DESC LIMIT 500'); res.json(r.rows);
});
app.patch('/api/admin/welfare/claims/:id', auth, allow('MAIN_ADMIN', 'WELFARE_OFFICER'), async (req, res) => {
  const status = String(req.body?.status || ''); if (!['PENDING', 'APPROVED', 'REJECTED', 'PAID'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const r = await q('UPDATE welfare_claims SET status=$1,reviewed_by=$2,reviewed_at=now() WHERE id=$3 RETURNING *', [status, req.user.sub, req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Claim not found' }); await audit(req.user.sub, 'UPDATE_WELFARE_CLAIM', 'welfare_claim', r.rows[0].id, { status }); res.json(r.rows[0]);
});

app.get('/api/admin/officers', auth, allow('MAIN_ADMIN'), async (req, res) => {
  const r = await q("SELECT id,username,display_name,role,enabled,last_login_at,created_at FROM users WHERE role<>'MEMBER' ORDER BY created_at DESC"); res.json(r.rows);
});
app.post('/api/admin/officers', auth, allow('MAIN_ADMIN'), async (req, res) => {
  try {
    const d = req.body || {};
    if (!d.username || !d.display_name || !d.password || String(d.password).length < 8 || !['FINANCE_OFFICER','WELFARE_OFFICER','MEMBER_MANAGER','REPORT_VIEWER'].includes(d.role)) return res.status(400).json({ error: 'Username, name, valid role and 8+ character password are required' });
    const hash = await bcrypt.hash(d.password, 12);
    const r = await q('INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,username,display_name,role,enabled,created_at', [String(d.username).trim(), String(d.display_name).trim(), hash, d.role]);
    await audit(req.user.sub, 'CREATE_OFFICER', 'user', r.rows[0].id, { role: d.role }); res.status(201).json(r.rows[0]);
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Username already exists' }); res.status(500).json({ error: 'Could not create officer' }); }
});
app.patch('/api/admin/officers/:id', auth, allow('MAIN_ADMIN'), async (req, res) => {
  const d = req.body || {};
  if (d.role && !['FINANCE_OFFICER','WELFARE_OFFICER','MEMBER_MANAGER','REPORT_VIEWER'].includes(d.role)) return res.status(400).json({ error: 'Invalid officer role' });
  const r = await q("UPDATE users SET enabled=COALESCE($1,enabled),role=COALESCE($2,role),display_name=COALESCE($3,display_name) WHERE id=$4 AND role<>'MAIN_ADMIN' RETURNING id,username,display_name,role,enabled", [d.enabled == null ? null : !!d.enabled, d.role || null, d.display_name || null, req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Officer not found or protected' }); await audit(req.user.sub, 'UPDATE_OFFICER', 'user', r.rows[0].id, { role: d.role, enabled: d.enabled }); res.json(r.rows[0]);
});

app.get('/api/admin/announcements', auth, allow('MAIN_ADMIN', 'MEMBER_MANAGER', 'REPORT_VIEWER', 'WELFARE_OFFICER'), async (req, res) => {
  const r = await q('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 100'); res.json(r.rows);
});
app.post('/api/admin/announcements', auth, allow('MAIN_ADMIN', 'MEMBER_MANAGER', 'WELFARE_OFFICER'), async (req, res) => {
  const title = String(req.body?.title || '').trim(); const body = String(req.body?.body || '').trim();
  if (!title || !body) return res.status(400).json({ error: 'Title and body required' });
  const r = await q('INSERT INTO announcements(title,body,published,created_by) VALUES($1,$2,$3,$4) RETURNING *', [title, body, req.body?.published !== false, req.user.sub]); await audit(req.user.sub, 'CREATE_ANNOUNCEMENT', 'announcement', r.rows[0].id, {}); res.status(201).json(r.rows[0]);
});
app.patch('/api/admin/announcements/:id', auth, allow('MAIN_ADMIN', 'MEMBER_MANAGER', 'WELFARE_OFFICER'), async (req, res) => {
  const r = await q('UPDATE announcements SET published=COALESCE($1,published) WHERE id=$2 RETURNING *', [req.body?.published == null ? null : !!req.body.published, req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'Announcement not found' }); res.json(r.rows[0]);
});

app.get('/api/admin/settings', auth, allow('MAIN_ADMIN'), async (req, res) => { const r = await q('SELECT key,value_json,updated_at FROM settings ORDER BY key'); res.json(r.rows); });
app.patch('/api/admin/settings', auth, allow('MAIN_ADMIN'), async (req, res) => {
  const d = req.body || {};
  if (d.monthly_contribution != null && (!Number.isFinite(Number(d.monthly_contribution)) || Number(d.monthly_contribution) < 0)) return res.status(400).json({ error: 'Invalid monthly contribution' });
  if (d.activation_fee != null && (!Number.isFinite(Number(d.activation_fee)) || Number(d.activation_fee) < 0)) return res.status(400).json({ error: 'Invalid activation fee' });
  if (d.monthly_contribution != null) await q('UPDATE settings SET value_json=$1,updated_by=$2,updated_at=now() WHERE key=\'monthly_contribution\'', [{ amount: money(d.monthly_contribution), currency: 'GHS' }, req.user.sub]);
  if (d.activation_fee != null) await q('UPDATE settings SET value_json=$1,updated_by=$2,updated_at=now() WHERE key=\'activation_fee\'', [{ amount: money(d.activation_fee), currency: 'GHS', configured: Number(d.activation_fee) > 0 }, req.user.sub]);
  if (d.bank_details) await q('UPDATE settings SET value_json=$1,updated_by=$2,updated_at=now() WHERE key=\'bank_details\'', [d.bank_details, req.user.sub]);
  await audit(req.user.sub, 'UPDATE_SETTINGS', 'settings', null, { monthly_contribution: d.monthly_contribution, activation_fee: d.activation_fee, bank_details_changed: !!d.bank_details }); res.json({ ok: true });
});

app.get('/api/admin/reports/monthly', auth, allow('MAIN_ADMIN', 'FINANCE_OFFICER', 'REPORT_VIEWER'), async (req, res) => {
  const month = monthStart(req.query.month) || new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString().slice(0, 10);
  const period = await ensurePeriod(month); if (!period) return res.status(404).json({ error: 'Contribution period not found' });
  const r = await q(`SELECT m.service_number,m.full_name,m.rank,m.unit,cp.period_month,cp.amount,
                     COALESCE(p.status,'NOT_PAID') AS payment_status,p.amount AS paid_amount,p.channel,p.provider_reference,p.internal_reference,p.paid_at
                     FROM members m CROSS JOIN contribution_periods cp
                     LEFT JOIN payments p ON p.member_id=m.id AND p.contribution_period_id=cp.id AND p.type='MONTHLY_WELFARE' AND p.status IN ('SUCCESS','RECONCILED')
                     WHERE cp.period_month=$1 AND m.status IN ('ACTIVE','SUSPENDED') ORDER BY m.service_number`, [month]);
  res.json(r.rows);
});
app.get('/api/admin/audit-logs', auth, allow('MAIN_ADMIN'), async (req, res) => { const r = await q(`SELECT a.*,u.username,u.display_name FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id ORDER BY a.created_at DESC LIMIT 500`); res.json(r.rows); });

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Unexpected server error' }); });

const server = app.listen(PORT, () => console.log(`GIS Wonjuga Sector Command Warfare Portal listening on http://localhost:${PORT}`));
async function shutdown(signal) { console.log(`${signal}: shutting down`); server.close(async () => { await pool.end(); process.exit(0); }); }
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
