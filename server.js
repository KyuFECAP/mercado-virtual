/**
 * Mercado Virtual — Backend
 * Banco: sqlite3 (compatível com Railway, Render, etc.)
 */

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const cors    = require('cors');
const path    = require('path');
const crypto  = require('crypto');

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'mercado-secret-dev-troque-em-producao';
const SALT   = 10;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Banco de dados ───────────────────────────────────────────────────────────
const db = new sqlite3.Database(path.join(__dirname, 'mercado.db'), err => {
  if (err) { console.error('Erro ao abrir banco:', err); process.exit(1); }
});

// Promisify helpers
const run  = (sql, p=[]) => new Promise((res,rej) => db.run(sql,p, function(e){ e?rej(e):res(this); }));
const get  = (sql, p=[]) => new Promise((res,rej) => db.get(sql,p, (e,r)=>e?rej(e):res(r)));
const all  = (sql, p=[]) => new Promise((res,rej) => db.all(sql,p, (e,r)=>e?rej(e):res(r)));

async function initDB() {
  await run('PRAGMA journal_mode=WAL');
  await run(`CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'customer',
    created_at    TEXT DEFAULT (datetime('now'))
  )`);
  await run(`CREATE TABLE IF NOT EXISTS layouts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    data        TEXT NOT NULL,
    is_active   INTEGER NOT NULL DEFAULT 0,
    created_by  INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  )`);
  await run(`CREATE TABLE IF NOT EXISTS layout_history (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    layout_id INTEGER NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
    data      TEXT NOT NULL,
    saved_by  INTEGER REFERENCES users(id),
    saved_at  TEXT DEFAULT (datetime('now'))
  )`);
  await run(`CREATE TABLE IF NOT EXISTS shopping_lists (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL DEFAULT 'Minha lista',
    items      TEXT NOT NULL DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  await run(`CREATE TABLE IF NOT EXISTS hardware_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token      TEXT UNIQUE NOT NULL,
    label      TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  await run(`CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL COLLATE NOCASE UNIQUE,
    price       REAL NOT NULL DEFAULT 0,
    active      INTEGER NOT NULL DEFAULT 1,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  )`);

  await run(`CREATE TABLE IF NOT EXISTS shelf_weights (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    shelf_id    TEXT NOT NULL,
    slot        INTEGER NOT NULL,
    peso_g      REAL NOT NULL,
    pct         INTEGER NOT NULL,
    product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
    assigned_shelf TEXT,
    recorded_at TEXT DEFAULT (datetime('now'))
  )`);

  // Migração de instalações antigas: adiciona product_id sem apagar leituras existentes.
  const shelfCols = await all('PRAGMA table_info(shelf_weights)');
  if (!shelfCols.some(c => c.name === 'product_id')) {
    await run('ALTER TABLE shelf_weights ADD COLUMN product_id INTEGER');
  }
  if (!shelfCols.some(c => c.name === 'assigned_shelf')) {
    await run('ALTER TABLE shelf_weights ADD COLUMN assigned_shelf TEXT');
  }

  // Seed: gerente padrão
  const count = await get("SELECT COUNT(*) as c FROM users WHERE role='manager'");
  if (count.c === 0) {
    const hash = bcrypt.hashSync('1234', SALT);
    await run("INSERT INTO users (username,password_hash,role) VALUES (?,?,'manager')",
              ['gerente', hash]);
    console.log('  Gerente padrão criado: usuário=gerente / senha=1234');
  }
}

// ─── Middlewares de autenticação ──────────────────────────────────────────────
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token ausente' });
  try { req.user = jwt.verify(h.slice(7), SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido ou expirado' }); }
}

function managerOnly(req, res, next) {
  auth(req, res, () => {
    if (req.user.role !== 'manager')
      return res.status(403).json({ error: 'Acesso restrito a gerentes' });
    next();
  });
}

async function hwAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token ausente' });
  const token = h.slice(7);
  // Tenta JWT primeiro
  try { req.user = jwt.verify(token, SECRET); return next(); } catch {}
  // Tenta hardware token
  try {
    const row = await get('SELECT * FROM hardware_tokens WHERE token=?', [token]);
    if (!row) return res.status(401).json({ error: 'Token de hardware inválido' });
    req.user = { id: row.created_by, role: 'hardware' };
    next();
  } catch { res.status(401).json({ error: 'Erro de autenticação' }); }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) return res.status(400).json({ error: 'Informe usuário e senha' });
  if (password.length < 4) return res.status(400).json({ error: 'Senha muito curta (mín. 4)' });
  try {
    await run("INSERT INTO users (username,password_hash,role) VALUES (?,?,'customer')",
              [username.trim(), bcrypt.hashSync(password, SALT)]);
    res.json({ ok: true });
  } catch { res.status(409).json({ error: 'Usuário já existe' }); }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) return res.status(400).json({ error: 'Informe usuário e senha' });
  const user = await get('SELECT * FROM users WHERE username=?', [username.trim()]);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, SECRET, { expiresIn: '8h' });
  res.json({ token, role: user.role, username: user.username });
});

app.post('/api/auth/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Preencha os campos' });
  if (newPassword.length < 4) return res.status(400).json({ error: 'Nova senha muito curta' });
  const user = await get('SELECT * FROM users WHERE id=?', [req.user.id]);
  if (!bcrypt.compareSync(currentPassword, user.password_hash))
    return res.status(400).json({ error: 'Senha atual incorreta' });
  await run('UPDATE users SET password_hash=? WHERE id=?', [bcrypt.hashSync(newPassword, SALT), req.user.id]);
  res.json({ ok: true });
});

app.post('/api/auth/create-manager', managerOnly, async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) return res.status(400).json({ error: 'Informe usuário e senha' });
  try {
    await run("INSERT INTO users (username,password_hash,role) VALUES (?,?,'manager')",
              [username.trim(), bcrypt.hashSync(password, SALT)]);
    res.json({ ok: true });
  } catch { res.status(409).json({ error: 'Usuário já existe' }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  const user = await get('SELECT id,username,role,created_at FROM users WHERE id=?', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json(user);
});

// ─── Layouts ──────────────────────────────────────────────────────────────────

app.get('/api/layouts/active', async (req, res) => {
  const layout = await get(`
    SELECT l.*, u.username as created_by_name
    FROM layouts l LEFT JOIN users u ON u.id=l.created_by
    WHERE l.is_active=1 ORDER BY l.updated_at DESC LIMIT 1
  `);
  if (!layout) return res.json(null);
  res.json({ ...layout, data: JSON.parse(layout.data) });
});

app.get('/api/layouts', managerOnly, async (req, res) => {
  const rows = await all(
    'SELECT id,name,is_active,created_at,updated_at FROM layouts WHERE created_by=? ORDER BY updated_at DESC',
    [req.user.id]
  );
  res.json(rows);
});

app.get('/api/layouts/:id', managerOnly, async (req, res) => {
  const layout = await get('SELECT * FROM layouts WHERE id=? AND created_by=?', [req.params.id, req.user.id]);
  if (!layout) return res.status(404).json({ error: 'Layout não encontrado' });
  res.json({ ...layout, data: JSON.parse(layout.data) });
});

app.post('/api/layouts', managerOnly, async (req, res) => {
  const { name, data, publish } = req.body ?? {};
  if (!name || !data) return res.status(400).json({ error: 'Informe nome e dados' });
  if (publish) await run('UPDATE layouts SET is_active=0 WHERE created_by=?', [req.user.id]);
  const r = await run(
    'INSERT INTO layouts (name,data,is_active,created_by) VALUES (?,?,?,?)',
    [name, JSON.stringify(data), publish ? 1 : 0, req.user.id]
  );
  res.json({ id: r.lastID, ok: true });
});

app.put('/api/layouts/:id', managerOnly, async (req, res) => {
  const existing = await get('SELECT * FROM layouts WHERE id=? AND created_by=?', [req.params.id, req.user.id]);
  if (!existing) return res.status(404).json({ error: 'Layout não encontrado' });
  const { name, data, publish } = req.body ?? {};
  await run('INSERT INTO layout_history (layout_id,data,saved_by) VALUES (?,?,?)',
            [existing.id, existing.data, req.user.id]);
  if (publish) await run('UPDATE layouts SET is_active=0 WHERE created_by=?', [req.user.id]);
  await run(
    "UPDATE layouts SET name=?,data=?,is_active=?,updated_at=datetime('now') WHERE id=?",
    [name ?? existing.name, JSON.stringify(data),
     publish ? 1 : (publish === false ? 0 : existing.is_active), existing.id]
  );
  res.json({ ok: true });
});

app.post('/api/layouts/:id/publish', managerOnly, async (req, res) => {
  const layout = await get('SELECT id FROM layouts WHERE id=? AND created_by=?', [req.params.id, req.user.id]);
  if (!layout) return res.status(404).json({ error: 'Layout não encontrado' });
  await run('UPDATE layouts SET is_active=0 WHERE created_by=?', [req.user.id]);
  await run("UPDATE layouts SET is_active=1,updated_at=datetime('now') WHERE id=?", [layout.id]);
  res.json({ ok: true });
});

app.post('/api/layouts/:id/unpublish', managerOnly, async (req, res) => {
  await run("UPDATE layouts SET is_active=0,updated_at=datetime('now') WHERE id=? AND created_by=?",
            [req.params.id, req.user.id]);
  res.json({ ok: true });
});

app.delete('/api/layouts/:id', managerOnly, async (req, res) => {
  const layout = await get('SELECT * FROM layouts WHERE id=? AND created_by=?', [req.params.id, req.user.id]);
  if (!layout) return res.status(404).json({ error: 'Layout não encontrado' });
  if (layout.is_active) return res.status(400).json({ error: 'Despublique antes de excluir' });
  await run('DELETE FROM layouts WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// ─── Listas de compras ────────────────────────────────────────────────────────

app.get('/api/shopping-lists', auth, async (req, res) => {
  const rows = await all(
    'SELECT id,name,items,created_at,updated_at FROM shopping_lists WHERE user_id=? ORDER BY updated_at DESC',
    [req.user.id]
  );
  res.json(rows.map(r => ({ ...r, items: JSON.parse(r.items) })));
});

app.post('/api/shopping-lists', auth, async (req, res) => {
  const { name, items } = req.body ?? {};
  if (!name) return res.status(400).json({ error: 'Informe um nome' });
  const r = await run(
    'INSERT INTO shopping_lists (user_id,name,items) VALUES (?,?,?)',
    [req.user.id, name.trim(), JSON.stringify(items ?? [])]
  );
  res.json({ id: r.lastID, ok: true });
});

app.put('/api/shopping-lists/:id', auth, async (req, res) => {
  const existing = await get('SELECT * FROM shopping_lists WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  if (!existing) return res.status(404).json({ error: 'Lista não encontrada' });
  const { name, items } = req.body ?? {};
  await run(
    "UPDATE shopping_lists SET name=?,items=?,updated_at=datetime('now') WHERE id=?",
    [name ?? existing.name, JSON.stringify(items ?? JSON.parse(existing.items)), req.params.id]
  );
  res.json({ ok: true });
});

app.delete('/api/shopping-lists/:id', auth, async (req, res) => {
  const existing = await get('SELECT id FROM shopping_lists WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  if (!existing) return res.status(404).json({ error: 'Lista não encontrada' });
  await run('DELETE FROM shopping_lists WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// ─── Hardware tokens ──────────────────────────────────────────────────────────

app.post('/api/hardware/token', managerOnly, async (req, res) => {
  const token = crypto.randomBytes(24).toString('hex');
  const { label } = req.body ?? {};
  await run('INSERT INTO hardware_tokens (token,label,created_by) VALUES (?,?,?)',
            [token, label || 'Arduino', req.user.id]);
  res.json({ token });
});

app.get('/api/hardware/tokens', managerOnly, async (req, res) => {
  const rows = await all(
    "SELECT id,label,substr(token,1,8)||'...' as token_preview,created_at FROM hardware_tokens WHERE created_by=? ORDER BY created_at DESC",
    [req.user.id]
  );
  res.json(rows);
});

app.delete('/api/hardware/tokens/:id', managerOnly, async (req, res) => {
  await run('DELETE FROM hardware_tokens WHERE id=? AND created_by=?', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

// ─── Produtos (catálogo independente das prateleiras) ─────────────────────────

app.get('/api/products', async (req, res) => {
  const rows = await all(`
    SELECT id,name,price,active,created_at,updated_at
    FROM products
    WHERE active=1
    ORDER BY name COLLATE NOCASE
  `);
  res.json(rows);
});

app.get('/api/products/manage', managerOnly, async (req, res) => {
  const rows = await all(`
    SELECT p.id,p.name,p.price,p.active,p.created_at,p.updated_at,
           COUNT(sw.id) AS reading_count
    FROM products p
    LEFT JOIN shelf_weights sw ON sw.product_id=p.id
    GROUP BY p.id
    ORDER BY p.name COLLATE NOCASE
  `);
  res.json(rows);
});

app.post('/api/products', managerOnly, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const price = Number(req.body?.price);
  if (!name) return res.status(400).json({ error: 'Informe o nome do produto' });
  if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Preço inválido' });
  try {
    const r = await run(
      'INSERT INTO products (name,price,created_by) VALUES (?,?,?)',
      [name, price, req.user.id]
    );
    res.json({ id: r.lastID, ok: true });
  } catch {
    res.status(409).json({ error: 'Já existe um produto com esse nome' });
  }
});

app.put('/api/products/:id', managerOnly, async (req, res) => {
  const existing = await get('SELECT * FROM products WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Produto não encontrado' });
  const name = String(req.body?.name ?? existing.name).trim();
  const price = Number(req.body?.price ?? existing.price);
  const active = req.body?.active === undefined ? existing.active : (req.body.active ? 1 : 0);
  if (!name) return res.status(400).json({ error: 'Informe o nome do produto' });
  if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Preço inválido' });
  try {
    await run(`UPDATE products SET name=?,price=?,active=?,updated_at=datetime('now') WHERE id=?`,
      [name, price, active, req.params.id]);
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: 'Já existe um produto com esse nome' });
  }
});

app.delete('/api/products/:id', managerOnly, async (req, res) => {
  const existing = await get('SELECT id FROM products WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Produto não encontrado' });
  await run('DELETE FROM products WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// ─── Pesos das prateleiras (Arduino) ─────────────────────────────────────────

app.post('/api/shelves/weight', hwAuth, async (req, res) => {
  const arduino_id = String(req.body?.arduino_id ?? req.body?.shelf_id ?? '').trim();
  const slots = req.body?.slots;
  if (!arduino_id || !Array.isArray(slots))
    return res.status(400).json({ error: 'Formato inválido' });
  for (const s of slots) {
    await run('INSERT INTO shelf_weights (shelf_id,slot,peso_g,pct,product_id) VALUES (?,?,?,?,NULL)',
              [arduino_id, s.slot, s.peso ?? 0, s.pct ?? 0]);
  }
  res.json({ ok: true, recorded: slots.length });
});

app.get('/api/shelves/status', async (req, res) => {
  const rows = await all(`
    SELECT w1.id,
           w1.assigned_shelf AS shelf_id,
           w1.slot,
           w1.peso_g,
           w1.pct,
           w1.product_id,
           w1.assigned_shelf,
           p.name AS product_name,
           p.price AS product_price,
           w1.recorded_at
    FROM shelf_weights w1
    LEFT JOIN products p ON p.id=w1.product_id
    WHERE w1.assigned_shelf IS NOT NULL
      AND w1.assigned_shelf <> ''
      AND w1.recorded_at = (
        SELECT MAX(recorded_at)
        FROM shelf_weights w2
        WHERE w2.assigned_shelf=w1.assigned_shelf
          AND w2.slot=w1.slot
          AND w2.assigned_shelf IS NOT NULL
          AND w2.assigned_shelf <> ''
      )
    ORDER BY w1.assigned_shelf, w1.slot
  `);
  res.json(rows);
});

app.get('/api/shelves/readings', managerOnly, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const rows = await all(`
    SELECT sw.id, sw.shelf_id AS arduino_id, sw.shelf_id, sw.slot, sw.peso_g, sw.pct, sw.recorded_at,
           sw.assigned_shelf, sw.product_id, p.name AS product_name, p.price AS product_price
    FROM shelf_weights sw
    LEFT JOIN products p ON p.id=sw.product_id
    ORDER BY sw.recorded_at DESC, sw.id DESC
    LIMIT ?
  `, [limit]);
  res.json(rows);
});

app.put('/api/shelves/readings/:id/assign', managerOnly, async (req, res) => {
  const reading = await get('SELECT id FROM shelf_weights WHERE id=?', [req.params.id]);
  if (!reading) return res.status(404).json({ error: 'Leitura não encontrada' });

  const productId = req.body?.product_id == null || req.body?.product_id === ''
    ? null : Number(req.body.product_id);
  if (productId !== null) {
    const product = await get('SELECT id FROM products WHERE id=? AND active=1', [productId]);
    if (!product) return res.status(404).json({ error: 'Produto não encontrado ou inativo' });
  }

  const assignedShelf = req.body?.shelf_key == null || req.body?.shelf_key === ''
    ? null : String(req.body.shelf_key).trim();
  if (assignedShelf && !/^\d+,\d+$/.test(assignedShelf)) {
    return res.status(400).json({ error: 'Prateleira inválida' });
  }

  await run('UPDATE shelf_weights SET product_id=?, assigned_shelf=? WHERE id=?',
            [productId, assignedShelf, req.params.id]);
  res.json({ ok: true });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ─── SPA ──────────────────────────────────────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Inicialização ────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🛒  Mercado Virtual em http://localhost:${PORT}`);
    console.log(`    Gerente padrão: gerente / 1234\n`);
  });
}).catch(e => {
  console.error('Erro ao inicializar banco:', e);
  process.exit(1);
});
