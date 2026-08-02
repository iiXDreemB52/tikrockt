'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');

const PORT = process.env.PORT || 3000;
const SIGN_API_KEY = process.env.SIGN_API_KEY || undefined;

/* ══════════════════════════════════════════════════════════════
   ★★★  إعداداتك — عدّل هنا فقط  ★★★

   ضع حسابك (أو حساباتك) بين علامتَي التنصيص، وكل حساب في سطر.
   الحساب الأول هو المربوط تلقائيًا عند فتح الموقع،
   والباقي يظهرون كأزرار سريعة في لوحة التحكم تضغط عليها للتبديل.

   بدون علامة @ — فقط اسم المستخدم.
   ══════════════════════════════════════════════════════════════ */

const ACCOUNTS = [
  'xxdreemB52',
  // 'حساب_ثاني',
  // 'حساب_ثالث',
];

// كلمة الدخول الافتراضية (تقدر تغيّرها من اللوحة أيضًا)
const DEFAULT_KEYWORD = 'دخول';

/* ══════════════ نهاية الإعدادات ══════════════ */

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

/* ---------------------------------------------------------------
   الحالة المركزية — كل النوافذ المفتوحة تشترك في نفس البيانات
--------------------------------------------------------------- */

const state = {
  status: 'disconnected',      // disconnected | connecting | connected | error
  username: ACCOUNTS[0] || '',  // الحساب المربوط تلقائيًا
  statusDetail: 'غير متصل',
  keyword: DEFAULT_KEYWORD,
  matchMode: 'exact',          // exact | contains
  excludeWinners: true,
  participants: new Map(),     // userId -> participant
  winner: null,
  winnerMessages: [],
  history: [],
  excluded: new Set(),         // معرفات من فازوا سابقًا
};

let connection = null;

/* ---------------------------------------------------------------
   تطبيع النص العربي حتى تُقبل كل صيغ الكلمة المفتاحية
   "دخول" = "دُخول" = "دخــول" = " دخول! "
--------------------------------------------------------------- */

function normalizeArabic(input) {
  return String(input || '')
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')   // تشكيل + تطويل
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627') // آ أ إ -> ا
    .replace(/\u0629/g, '\u0647')                   // ة -> ه
    .replace(/\u0649/g, '\u064A')                   // ى -> ي
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')              // إزالة الرموز والإيموجي
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isJoinMessage(content) {
  const text = normalizeArabic(content);
  const key = normalizeArabic(state.keyword);
  if (!key) return false;
  if (state.matchMode === 'contains') {
    return text.split(' ').includes(key) || text.includes(key);
  }
  return text === key;
}

/* ---------------------------------------------------------------
   لقطة الحالة المرسلة للعميل
--------------------------------------------------------------- */

function snapshot() {
  return {
    status: state.status,
    statusDetail: state.statusDetail,
    username: state.username,
    accounts: ACCOUNTS,
    keyword: state.keyword,
    matchMode: state.matchMode,
    excludeWinners: state.excludeWinners,
    participants: [...state.participants.values()],
    winner: state.winner,
    winnerMessages: state.winnerMessages,
    history: state.history,
  };
}

function pushStatus() {
  io.emit('status', {
    status: state.status,
    statusDetail: state.statusDetail,
    username: state.username,
  });
}

function log(level, message) {
  io.emit('log', { level, message, at: Date.now() });
  const tag = { info: '·', ok: '✓', warn: '!', error: '×' }[level] || '·';
  console.log(`${tag} ${message}`);
}

/* ---------------------------------------------------------------
   استخراج بيانات المستخدم من حدث الشات
--------------------------------------------------------------- */

function readUser(user) {
  if (!user) return null;
  const id = String(user.id || user.displayId || '');
  if (!id) return null;
  const avatar =
    user.avatarThumb?.urlList?.[0] ||
    user.avatarMedium?.urlList?.[0] ||
    user.avatarLarge?.urlList?.[0] ||
    '';
  return {
    id,
    handle: user.displayId || '',
    name: user.nickname || user.displayId || 'مشارك',
    avatar,
  };
}

/* ---------------------------------------------------------------
   الاتصال بالبث
--------------------------------------------------------------- */

async function startConnection(rawUsername) {
  if (state.status === 'connecting' || state.status === 'connected') {
    log('warn', 'الاتصال شغّال بالفعل. أوقفه أولًا قبل تشغيل بث آخر.');
    return;
  }

  const username = String(rawUsername || '').trim().replace(/^@/, '');
  if (!username) {
    log('error', 'اكتب اسم مستخدم تيك توك أولًا.');
    return;
  }

  state.username = username;
  state.status = 'connecting';
  state.statusDetail = 'جارٍ الاتصال…';
  pushStatus();

  connection = new TikTokLiveConnection(username, {
    signApiKey: SIGN_API_KEY=mgm2ce1hbycfo8qn,
    processInitialData: false,      // تجاهل الرسائل القديمة المخزّنة
    fetchRoomInfoOnConnect: true,
    enableExtendedGiftInfo: false,
  });

  connection.on(WebcastEvent.CHAT, onChat);

  connection.on(WebcastEvent.STREAM_END, () => {
    state.statusDetail = 'انتهى البث';
    log('warn', 'انتهى البث المباشر.');
    teardown('disconnected');
  });

  connection.on(ControlEvent.DISCONNECTED, () => {
    if (state.status === 'disconnected') return;
    state.statusDetail = 'انقطع الاتصال';
    log('warn', 'انقطع الاتصال بالبث.');
    teardown('disconnected');
  });

  connection.on(ControlEvent.ERROR, (err) => {
    log('error', `خطأ في الاتصال: ${err?.message || err}`);
  });

  try {
    await connection.connect();
    state.status = 'connected';
    state.statusDetail = `متصل بـ @${username}`;
    pushStatus();
    log('ok', `تم الاتصال ببث @${username}. الكلمة المفتاحية: «${state.keyword}»`);
  } catch (err) {
    state.status = 'error';
    state.statusDetail = 'فشل الاتصال';
    pushStatus();
    log('error', describeConnectError(err, username));
    connection = null;
  }
}

function describeConnectError(err, username) {
  const msg = String(err?.message || err || '');
  if (/not.*live|offline|LIVE has ended|user_not_found/i.test(msg)) {
    return `تعذّر الاتصال: يبدو أن @${username} ليس على الهواء الآن، أو الاسم غير صحيح.`;
  }
  if (/sign|rate.?limit|429|euler/i.test(msg)) {
    return 'تعذّر الاتصال: تجاوزت حد خدمة التوقيع المجانية. انتظر دقيقة وأعد المحاولة، أو أضف SIGN_API_KEY في ملف .env';
  }
  return `تعذّر الاتصال: ${msg}`;
}

/* ---------------------------------------------------------------
   التحقق من الحساب قبل الاتصال — يوضّح سبب فشل الربط بدقة
--------------------------------------------------------------- */

async function checkAccount(rawUsername) {
  const username = String(rawUsername || '').trim().replace(/^@/, '');
  if (!username) {
    log('error', 'اكتب اسم المستخدم أولًا.');
    return;
  }

  log('info', `جارٍ التحقق من @${username} …`);
  try {
    const probe = new TikTokLiveConnection(username, { signApiKey: SIGN_API_KEY });
    const live = await probe.fetchIsLive();
    if (live) {
      log('ok', `@${username} على الهواء الآن. اضغط «تشغيل الاتصال».`);
    } else {
      log('warn', `الاسم @${username} صحيح، لكن الحساب ليس على الهواء حاليًا.`);
    }
  } catch (err) {
    const msg = String(err?.message || err || '');
    if (/sign|rate.?limit|429|euler/i.test(msg)) {
      log('error', 'تعذّر التحقق: تجاوزت حد خدمة التوقيع المجانية. انتظر دقيقة وأعد المحاولة.');
    } else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(msg)) {
      log('error', 'تعذّر التحقق: لا يوجد اتصال بالإنترنت من الخادم.');
    } else {
      log('warn', `تعذّر قراءة حالة @${username}. الأسباب المحتملة: الاسم مكتوب خطأ، أو الحساب ليس على الهواء، أو تيك توك يحجب الاتصال من هذا الجهاز.`);
    }
  }
}

function teardown(nextStatus) {
  try {
    connection?.disconnect();
  } catch (_) { /* تجاهل */ }
  connection = null;
  state.status = nextStatus;
  pushStatus();
}

function stopConnection() {
  if (!connection) {
    log('info', 'لا يوجد اتصال قائم.');
    state.status = 'disconnected';
    state.statusDetail = 'غير متصل';
    pushStatus();
    return;
  }
  state.statusDetail = 'غير متصل';
  teardown('disconnected');
  log('info', 'تم إيقاف الاتصال.');
}

/* ---------------------------------------------------------------
   معالجة كل رسالة شات
--------------------------------------------------------------- */

function onChat(event) {
  const user = readUser(event?.user);
  if (!user) return;
  const content = event?.content || '';

  // رسائل الفائز الحالي تُبثّ إلى شاشة المتابعة
  if (state.winner && state.winner.id === user.id) {
    const message = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text: content, at: Date.now() };
    state.winnerMessages.push(message);
    if (state.winnerMessages.length > 300) state.winnerMessages.shift();
    io.emit('winner:message', message);
  }

  if (!isJoinMessage(content)) return;
  if (state.participants.has(user.id)) return;                   // منع التكرار
  if (state.excludeWinners && state.excluded.has(user.id)) return; // فاز سابقًا

  const participant = {
    ...user,
    order: state.participants.size + 1,
    joinedAt: Date.now(),
  };
  state.participants.set(user.id, participant);
  io.emit('participant:add', participant);
}

/* ---------------------------------------------------------------
   السحب
--------------------------------------------------------------- */

function pickWinner() {
  const pool = [...state.participants.values()].filter(
    (p) => !(state.excludeWinners && state.excluded.has(p.id))
  );

  if (pool.length === 0) {
    log('warn', 'لا يوجد مشاركون مؤهلون للسحب.');
    io.emit('draw:empty');
    return;
  }

  const winner = pool[randomIndex(pool.length)];
  state.winner = winner;
  state.winnerMessages = [];

  const entry = { ...winner, wonAt: Date.now() };
  state.history.unshift(entry);
  if (state.history.length > 50) state.history.pop();

  if (state.excludeWinners) {
    state.excluded.add(winner.id);
    state.participants.delete(winner.id);
  }

  io.emit('winner', { winner, history: state.history, participants: [...state.participants.values()] });
  log('ok', `الفائز: ${winner.name}${winner.handle ? ` (@${winner.handle})` : ''}`);
}

// اختيار عشوائي غير منحاز باستخدام مولّد التشفير
function randomIndex(length) {
  const { randomInt } = require('crypto');
  return randomInt(0, length);
}

function backToList() {
  state.winner = null;
  state.winnerMessages = [];
  io.emit('winner:clear');
}

function clearParticipants() {
  state.participants.clear();
  io.emit('participants:clear');
  log('info', 'تم مسح قائمة المشاركين.');
}

/* ---------------------------------------------------------------
   تصدير CSV
--------------------------------------------------------------- */

app.get('/api/participants.csv', (req, res) => {
  const rows = [['#', 'الاسم', 'المعرف', 'وقت التسجيل']];
  for (const p of state.participants.values()) {
    const t = new Date(p.joinedAt);
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
    rows.push([p.order, p.name, p.handle ? `@${p.handle}` : '', stamp]);
  }
  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="participants.csv"');
  res.send('\uFEFF' + csv); // BOM حتى تظهر العربية صحيحة في Excel
});

/* ---------------------------------------------------------------
   قناة الوقت الفعلي
--------------------------------------------------------------- */

io.on('connection', (socket) => {
  socket.emit('state', snapshot());

  socket.on('start', (payload) => startConnection(payload?.username));
  socket.on('check', (payload) => checkAccount(payload?.username));
  socket.on('stop', () => stopConnection());
  socket.on('clear', () => clearParticipants());
  socket.on('draw', () => pickWinner());
  socket.on('back', () => backToList());

  socket.on('settings', (payload = {}) => {
    if (typeof payload.keyword === 'string' && payload.keyword.trim()) {
      state.keyword = payload.keyword.trim().slice(0, 40);
      log('info', `تم تغيير كلمة الدخول إلى «${state.keyword}»`);
    }
    if (payload.matchMode === 'exact' || payload.matchMode === 'contains') {
      state.matchMode = payload.matchMode;
    }
    if (typeof payload.excludeWinners === 'boolean') {
      state.excludeWinners = payload.excludeWinners;
    }
    io.emit('settings', {
      keyword: state.keyword,
      matchMode: state.matchMode,
      excludeWinners: state.excludeWinners,
    });
  });

  socket.on('history:clear', () => {
    state.history = [];
    state.excluded.clear();
    io.emit('history:clear');
    log('info', 'تم مسح سجل الفائزين وإعادة تأهيل الجميع.');
  });

  // وضع التجربة: يولّد مشاركين وهميين لاختبار الواجهة بدون بث حقيقي
  socket.on('demo', (payload = {}) => {
    const count = Math.min(Math.max(parseInt(payload.count, 10) || 12, 1), 60);
    const names = ['أحمد', 'سارة', 'خالد', 'نورة', 'يوسف', 'ليان', 'عبدالله', 'جنى', 'محمد', 'رهف', 'سلطان', 'دانة', 'فهد', 'مريم', 'تركي', 'شهد'];
    for (let i = 0; i < count; i += 1) {
      const id = `demo-${Date.now()}-${i}`;
      const participant = {
        id,
        handle: `user${Math.floor(Math.random() * 9000) + 1000}`,
        name: `${names[i % names.length]} ${Math.floor(Math.random() * 99)}`,
        avatar: '',
        order: state.participants.size + 1,
        joinedAt: Date.now(),
      };
      state.participants.set(id, participant);
      io.emit('participant:add', participant);
    }
    log('info', `تمت إضافة ${count} مشاركًا تجريبيًا.`);
  });
});

server.listen(PORT, () => {
  console.log(`\n  سحب تيك توك يعمل على  →  http://localhost:${PORT}\n`);
});
