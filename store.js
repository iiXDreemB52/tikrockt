'use strict';

/* ══════════════════════════════════════════════════════════════
   طبقة التخزين — مقسّمة على غرف (rooms)

   كل مستخدم للموقع له غرفة مستقلة: إعداداته ومشاركوه وفائزوه
   منفصلون تمامًا عن غيره.

   • DATABASE_URL موجود (Neon)  → Postgres، وهذا المطلوب عند النشر.
   • غير موجود                  → ملفات داخل data/ للتجربة المحلية.
   ══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const ROOMS_DIR = path.join(DATA_DIR, 'rooms');
const DATABASE_URL = process.env.DATABASE_URL || '';

let pool = null;

/* ─────────── وضع الملفات ─────────── */

function roomFile(roomId, suffix) {
  return path.join(ROOMS_DIR, `${roomId}.${suffix}.json`);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

/* ─────────── التهيئة ─────────── */

async function init() {
  if (!DATABASE_URL) {
    console.log('التخزين: ملفات محلية (data/rooms) — بدون قاعدة بيانات');
    console.log('         عند النشر ضع DATABASE_URL وإلا ضاعت البيانات مع كل إعادة تشغيل.');
    return 'file';
  }

  try {
    const { Pool } = require('pg');

    // نزيل sslmode/channel_binding من الرابط لأننا نضبط SSL يدويًا
    let connectionString = DATABASE_URL;
    try {
      const url = new URL(DATABASE_URL);
      url.searchParams.delete('sslmode');
      url.searchParams.delete('channel_binding');
      connectionString = url.toString();
    } catch (_) { /* رابط غير قياسي */ }

    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 20000,
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id         TEXT PRIMARY KEY,
        config     JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS winners (
        id      BIGSERIAL PRIMARY KEY,
        room_id TEXT,
        user_id TEXT NOT NULL,
        handle  TEXT,
        name    TEXT,
        avatar  TEXT,
        won_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    // ترقية من النسخة القديمة (جدول فائزين بدون غرف)
    await pool.query('ALTER TABLE winners ADD COLUMN IF NOT EXISTS room_id TEXT');
    await pool.query("UPDATE winners SET room_id = 'default' WHERE room_id IS NULL");
    await pool.query('CREATE INDEX IF NOT EXISTS winners_room_idx ON winners (room_id, won_at DESC)');

    await migrateLegacyConfig();

    console.log('التخزين: Postgres (Neon) — متصل');
    return 'pg';
  } catch (err) {
    console.error('فشل الاتصال بقاعدة البيانات، سأستخدم الملفات:', err.message);
    pool = null;
    return 'file';
  }
}

// نقل إعدادات النسخة القديمة (app_config) إلى غرفة اسمها default
async function migrateLegacyConfig() {
  try {
    const { rows } = await pool.query("SELECT to_regclass('public.app_config') IS NOT NULL AS exists");
    if (!rows[0] || !rows[0].exists) return;

    const legacy = await pool.query('SELECT data FROM app_config WHERE id = 1');
    if (!legacy.rows[0]) return;

    const already = await pool.query('SELECT 1 FROM rooms WHERE id = $1', ['default']);
    if (already.rows[0]) return;

    await pool.query(
      'INSERT INTO rooms (id, config) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      ['default', JSON.stringify(legacy.rows[0].data)]
    );
    console.log('تمت ترقية إعدادات النسخة القديمة إلى الغرفة default');
  } catch (err) {
    console.error('تعذّرت ترقية البيانات القديمة:', err.message);
  }
}

/* ─────────── الإعدادات لكل غرفة ─────────── */

async function loadConfig(roomId) {
  if (pool) {
    try {
      const { rows } = await pool.query('SELECT config FROM rooms WHERE id = $1', [roomId]);
      return rows[0] ? rows[0].config : null;
    } catch (err) {
      console.error('تعذّرت قراءة إعدادات الغرفة:', err.message);
      return null;
    }
  }
  return readJson(roomFile(roomId, 'config'), null);
}

async function saveConfig(roomId, config) {
  if (pool) {
    await pool.query(
      `INSERT INTO rooms (id, config, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (id) DO UPDATE SET config = $2, updated_at = now()`,
      [roomId, JSON.stringify(config)]
    );
    return;
  }
  writeJson(roomFile(roomId, 'config'), config);
}

/* ─────────── الفائزون لكل غرفة ─────────── */

async function saveWinner(roomId, winner) {
  if (pool) {
    await pool.query(
      'INSERT INTO winners (room_id, user_id, handle, name, avatar) VALUES ($1, $2, $3, $4, $5)',
      [roomId, winner.id, winner.handle || '', winner.name || '', winner.avatar || '']
    );
    return;
  }
  const file = roomFile(roomId, 'winners');
  const list = readJson(file, []);
  list.unshift({ ...winner, wonAt: Date.now() });
  writeJson(file, list.slice(0, 200));
}

async function loadWinners(roomId, limit = 50) {
  if (pool) {
    try {
      const { rows } = await pool.query(
        `SELECT user_id, handle, name, avatar, won_at FROM winners
         WHERE room_id = $1 ORDER BY won_at DESC LIMIT $2`,
        [roomId, limit]
      );
      return rows.map((r) => ({
        id: r.user_id,
        handle: r.handle,
        name: r.name,
        avatar: r.avatar,
        wonAt: new Date(r.won_at).getTime(),
      }));
    } catch (err) {
      console.error('تعذّرت قراءة سجل الفائزين:', err.message);
      return [];
    }
  }
  return readJson(roomFile(roomId, 'winners'), []).slice(0, limit);
}

async function clearWinners(roomId) {
  if (pool) {
    await pool.query('DELETE FROM winners WHERE room_id = $1', [roomId]);
    return;
  }
  writeJson(roomFile(roomId, 'winners'), []);
}

async function health() {
  if (!pool) return { driver: 'file' };
  try {
    const { rows } = await pool.query('SELECT count(*)::int AS rooms FROM rooms');
    return { driver: 'postgres', rooms: rows[0].rooms };
  } catch (err) {
    return { driver: 'postgres', error: err.message };
  }
}

module.exports = { init, loadConfig, saveConfig, saveWinner, loadWinners, clearWinners, health };
