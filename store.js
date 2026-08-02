'use strict';

/* ══════════════════════════════════════════════════════════════
   طبقة التخزين

   • إذا كان DATABASE_URL موجودًا (Neon) → يحفظ في Postgres.
   • إذا ما كان موجودًا → يحفظ في ملفات داخل data/ (للتشغيل المحلي).

   السبب: نظام ملفات Render مؤقّت، أي شي تكتبه على القرص
   يضيع مع كل إعادة تشغيل أو نشر جديد.
   ══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const WINNERS_FILE = path.join(DATA_DIR, 'winners.json');

const DATABASE_URL = process.env.DATABASE_URL || '';

let pool = null;

/* ─────────── وضع الملفات ─────────── */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

/* ─────────── التهيئة ─────────── */

async function init() {
  if (!DATABASE_URL) {
    console.log('💾 التخزين: ملفات محلية (data/) — بدون قاعدة بيانات');
    return 'file';
  }

  try {
    const { Pool } = require('pg');

    // نشيل sslmode/channel_binding من الرابط لأننا نضبط SSL يدويًا تحت
    let connectionString = DATABASE_URL;
    try {
      const url = new URL(DATABASE_URL);
      url.searchParams.delete('sslmode');
      url.searchParams.delete('channel_binding');
      connectionString = url.toString();
    } catch (_) { /* رابط غير قياسي — نستخدمه كما هو */ }

    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 20000,
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_config (
        id         INT PRIMARY KEY,
        data       JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS winners (
        id      BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        handle  TEXT,
        name    TEXT,
        avatar  TEXT,
        won_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    console.log('💾 التخزين: Postgres (Neon) — متصل');
    return 'pg';
  } catch (err) {
    console.error('⚠️ فشل الاتصال بقاعدة البيانات، سأستخدم الملفات:', err.message);
    pool = null;
    return 'file';
  }
}

/* ─────────── الإعدادات ─────────── */

async function loadConfig() {
  if (pool) {
    try {
      const { rows } = await pool.query('SELECT data FROM app_config WHERE id = 1');
      return rows[0]?.data || null;
    } catch (err) {
      console.error('⚠️ تعذّرت قراءة الإعدادات:', err.message);
      return null;
    }
  }
  return readJson(CONFIG_FILE, null);
}

async function saveConfig(config) {
  if (pool) {
    await pool.query(
      `INSERT INTO app_config (id, data, updated_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()`,
      [JSON.stringify(config)]
    );
    return;
  }
  writeJson(CONFIG_FILE, config);
}

/* ─────────── الفائزون ─────────── */

async function saveWinner(winner) {
  if (pool) {
    await pool.query(
      'INSERT INTO winners (user_id, handle, name, avatar) VALUES ($1, $2, $3, $4)',
      [winner.id, winner.handle || '', winner.name || '', winner.avatar || '']
    );
    return;
  }
  const list = readJson(WINNERS_FILE, []);
  list.unshift({ ...winner, wonAt: Date.now() });
  writeJson(WINNERS_FILE, list.slice(0, 200));
}

async function loadWinners(limit = 50) {
  if (pool) {
    try {
      const { rows } = await pool.query(
        'SELECT user_id, handle, name, avatar, won_at FROM winners ORDER BY won_at DESC LIMIT $1',
        [limit]
      );
      return rows.map((r) => ({
        id: r.user_id,
        handle: r.handle,
        name: r.name,
        avatar: r.avatar,
        wonAt: new Date(r.won_at).getTime(),
      }));
    } catch (err) {
      console.error('⚠️ تعذّرت قراءة سجل الفائزين:', err.message);
      return [];
    }
  }
  return readJson(WINNERS_FILE, []).slice(0, limit);
}

async function clearWinners() {
  if (pool) {
    await pool.query('DELETE FROM winners');
    return;
  }
  writeJson(WINNERS_FILE, []);
}

module.exports = { init, loadConfig, saveConfig, saveWinner, loadWinners, clearWinners };
