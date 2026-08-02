'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const { randomInt } = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');
const store = require('./store');

const PORT = process.env.PORT || 3000;
const SIGN_API_KEY = process.env.SIGN_API_KEY || undefined;

/* ══════════════════════════════════════════════════════════════
   الإعدادات الافتراضية.
   ما عاد فيه حساب مكتوب داخل الكود — الحساب يتغيّر من الشريط
   العلوي في الموقع ويُحفظ في data/config.json.
   ══════════════════════════════════════════════════════════════ */

const DEFAULT_CONFIG = {
  username: '',              // حساب تيك توك المربوط (بدون @)
  keyword: 'بلعب',           // الكلمة اللي يكتبها المشاهد بالشات
  matchMode: 'contains',     // exact = الرسالة كلها الكلمة | contains = تكفي الكلمة داخل الرسالة
  excludeWinners: true,      // استبعاد من فاز سابقًا
  maxParticipants: 100,      // الحد الأقصى للمشاركين المسموح دخولهم
  countdownSeconds: 30,      // مدة العد التنازلي تحت زر «ابدأ»
  autoDraw: true,            // السحب تلقائيًا عند انتهاء العد
  joinDuringRoundOnly: false,// true = التسجيل يُقبل فقط أثناء العد التنازلي
  stopWhenFull: true,        // إنهاء العد فورًا عند اكتمال العدد
  sound: { enabled: true, volume: 0.6 },
};

const MAX_EVENTS = 400;

/* ---------------------------------------------------------------
   حفظ/قراءة الإعدادات من القرص
--------------------------------------------------------------- */

function sanitizeConfig(input = {}, base = DEFAULT_CONFIG) {
  const num = (value, fallback, min, max) => {
    const n = Number.parseInt(value, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(Math.max(n, min), max);
  };

  const soundInput = input.sound || {};
  return {
    username: String(input.username ?? base.username).trim().replace(/^@/, '').slice(0, 40),
    keyword: (String(input.keyword ?? base.keyword).trim() || base.keyword).slice(0, 40),
    matchMode: input.matchMode === 'exact' || input.matchMode === 'contains' ? input.matchMode : base.matchMode,
    excludeWinners: typeof input.excludeWinners === 'boolean' ? input.excludeWinners : base.excludeWinners,
    maxParticipants: num(input.maxParticipants, base.maxParticipants, 1, 5000),
    countdownSeconds: num(input.countdownSeconds, base.countdownSeconds, 0, 900),
    autoDraw: typeof input.autoDraw === 'boolean' ? input.autoDraw : base.autoDraw,
    joinDuringRoundOnly:
      typeof input.joinDuringRoundOnly === 'boolean' ? input.joinDuringRoundOnly : base.joinDuringRoundOnly,
    stopWhenFull: typeof input.stopWhenFull === 'boolean' ? input.stopWhenFull : base.stopWhenFull,
    sound: {
      enabled: typeof soundInput.enabled === 'boolean' ? soundInput.enabled : base.sound.enabled,
      volume: Math.min(Math.max(Number(soundInput.volume ?? base.sound.volume) || 0, 0), 1),
    },
  };
}

function saveConfig() {
  store.saveConfig(state.config).catch((err) => {
    console.error('تعذّر حفظ الإعدادات:', err.message);
  });
}

/* ---------------------------------------------------------------
   الحالة المركزية — كل الشاشات المفتوحة تشترك في نفس البيانات
--------------------------------------------------------------- */

const state = {
  config: { ...DEFAULT_CONFIG, sound: { ...DEFAULT_CONFIG.sound } },
  status: 'disconnected',       // disconnected | connecting | connected | error
  statusDetail: 'غير متصل',
  participants: new Map(),      // id -> participant
  winner: null,
  winnerMessages: [],
  history: [],
  excluded: new Set(),
  events: [],
  round: { active: false, total: 0, remaining: 0 },
};

let connection = null;
let autoReconnect = true;
let reconnectTimer = null;
let roundTimer = null;
let reconnectDelay = 5000;
const MAX_RECONNECT_DELAY = 60000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------------------------------------------------------
   سجل الأحداث — يُبثّ للموقع وللشاشة الخضراء
--------------------------------------------------------------- */

let lastNoise = { text: '', at: 0 };

function pushEvent(type, text, extra = {}) {
  // منع تكرار نفس رسالة الخطأ عشرات المرات في السجل
  if (type === 'error' || type === 'connection') {
    if (text === lastNoise.text && Date.now() - lastNoise.at < 8000) return null;
    lastNoise = { text, at: Date.now() };
  }

  const event = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,                 // join | winner | round | connection | system | error
    text,
    at: Date.now(),
    ...extra,
  };
  state.events.push(event);
  if (state.events.length > MAX_EVENTS) state.events.shift();
  io.emit('event', event);
  console.log(`[${type}] ${text}`);
  return event;
}

/* ---------------------------------------------------------------
   تطبيع النص العربي حتى تُقبل كل صيغ الكلمة المفتاحية
   "بلعب" = "بلعــب" = "بِلعب" = " بلعب!! "
--------------------------------------------------------------- */

function normalizeArabic(input) {
  return String(input || '')
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')      // تشكيل + تطويل
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627') // آ أ إ -> ا
    .replace(/\u0629/g, '\u0647')                     // ة -> ه
    .replace(/\u0649/g, '\u064A')                     // ى -> ي
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')                // إزالة الرموز والإيموجي
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isJoinMessage(content) {
  const text = normalizeArabic(content);
  const key = normalizeArabic(state.config.keyword);
  if (!key || !text) return false;
  if (state.config.matchMode === 'contains') {
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
    config: state.config,
    participants: [...state.participants.values()],
    winner: state.winner,
    winnerMessages: state.winnerMessages,
    history: state.history,
    events: state.events.slice(-120),
    round: state.round,
    joinOpen: isJoinOpen(),
  };
}

function pushStatus() {
  io.emit('status', {
    status: state.status,
    statusDetail: state.statusDetail,
    username: state.config.username,
  });
}

function pushSettings() {
  io.emit('settings', state.config);
}

/* ---------------------------------------------------------------
   استخراج بيانات المستخدم من حدث الشات
--------------------------------------------------------------- */

function readUser(user) {
  if (!user) return null;
  const id = String(user?.uniqueId || user?.displayId || user?.userId || user?.id || '');
  if (!id) return null;
  const avatar =
    user.avatarThumb?.urlList?.[0] ||
    user.avatarMedium?.urlList?.[0] ||
    user.avatarLarge?.urlList?.[0] ||
    '';
  return {
    id,
    handle: user.uniqueId || user.displayId || user.userId || '',
    name: user.nickname || user.uniqueId || user.displayId || 'مشارك',
    avatar,
  };
}

function getChatText(event) {
  const value =
    event?.comment ??
    event?.content ??
    event?.message ??
    event?.text ??
    event?.commentText ??
    event?.messageText ??
    event?.msg ??
    '';

  if (typeof value === 'string') return value;
  if (value && typeof value.text === 'string') return value.text;
  if (value && typeof value.content === 'string') return value.content;
  return '';
}

/* ---------------------------------------------------------------
   الاتصال بالبث
--------------------------------------------------------------- */

async function startConnection(rawUsername) {
  if (state.status === 'connecting' || state.status === 'connected') {
    pushEvent('system', 'الاتصال شغّال بالفعل.');
    return;
  }

  const username = String(rawUsername || state.config.username || '').trim().replace(/^@/, '');
  if (!username) {
    state.status = 'disconnected';
    state.statusDetail = 'أضف حساب تيك توك من الشريط العلوي';
    pushStatus();
    pushEvent('system', 'ما فيه حساب مربوط. اكتب اسم حسابك في أعلى الصفحة.');
    return;
  }

  autoReconnect = true;
  state.config.username = username;
  state.status = 'connecting';
  state.statusDetail = 'جارٍ الاتصال…';
  pushStatus();

  connection = new TikTokLiveConnection(username, {
    signApiKey: SIGN_API_KEY,
    processInitialData: false,      // تجاهل الرسائل القديمة المخزّنة
    fetchRoomInfoOnConnect: true,
    enableExtendedGiftInfo: false,
  });

  connection.on(WebcastEvent.CHAT, onChat);

  connection.on(WebcastEvent.STREAM_END, () => {
    state.statusDetail = 'انتهى البث';
    pushEvent('connection', 'انتهى البث المباشر.');
    teardown('disconnected');
    scheduleReconnect(username);
  });

  connection.on(ControlEvent.DISCONNECTED, () => {
    if (state.status === 'disconnected') return;
    state.statusDetail = 'انقطع الاتصال';
    pushEvent('connection', 'انقطع الاتصال بالبث.');
    teardown('disconnected');
    scheduleReconnect(username);
  });

  connection.on(ControlEvent.ERROR, (err) => {
    pushEvent('error', `خطأ في الاتصال: ${errorText(err)}`);
  });

  try {
    await connection.connect();
    state.status = 'connected';
    state.statusDetail = `متصل بـ @${username}`;
    pushStatus();
    pushEvent('connection', `تم الاتصال ببث @${username} · كلمة الدخول «${state.config.keyword}»`);
    reconnectDelay = 5000;
  } catch (err) {
    state.status = 'error';
    state.statusDetail = 'فشل الاتصال';
    pushStatus();
    pushEvent('error', describeConnectError(err, username));
    connection = null;
    scheduleReconnect(username);
  }
}

function scheduleReconnect(username) {
  if (!autoReconnect || !username) return;
  clearTimeout(reconnectTimer);
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  state.statusDetail = `إعادة المحاولة خلال ${Math.round(delay / 1000)} ثانية`;
  pushStatus();
  reconnectTimer = setTimeout(() => {
    if (state.status === 'disconnected' || state.status === 'error') {
      startConnection(username);
    }
  }, delay);
}

function errorText(err) {
  if (!err) return 'خطأ غير معروف';
  if (typeof err === 'string') return err;
  const raw = err.message || err.exception?.message || err.error?.message || err.reason;
  if (raw) return String(raw);
  try {
    return JSON.stringify(err).slice(0, 200);
  } catch (_) {
    return 'خطأ غير معروف';
  }
}

function describeConnectError(err, username) {
  const msg = errorText(err);
  if (/not.*live|offline|LIVE has ended|user_not_found|room.?id|Failed to retrieve/i.test(msg)) {
    return `تعذّر الاتصال: يبدو أن @${username} ليس على الهواء الآن، أو الاسم غير صحيح.`;
  }
  if (/sign|rate.?limit|429|euler/i.test(msg)) {
    return 'تعذّر الاتصال: تجاوزت حد خدمة التوقيع. انتظر دقيقة، أو تأكد من SIGN_API_KEY في ملف .env';
  }
  return `تعذّر الاتصال: ${msg}`;
}

async function checkAccount(rawUsername) {
  const username = String(rawUsername || '').trim().replace(/^@/, '');
  if (!username) {
    pushEvent('error', 'اكتب اسم المستخدم أولًا.');
    return;
  }
  pushEvent('system', `جارٍ التحقق من @${username} …`);
  try {
    const probe = new TikTokLiveConnection(username, { signApiKey: SIGN_API_KEY });
    const live = await probe.fetchIsLive();
    pushEvent(
      'system',
      live ? `@${username} على الهواء الآن.` : `الاسم @${username} صحيح، لكن الحساب مو على الهواء حاليًا.`
    );
  } catch (err) {
    pushEvent('error', describeConnectError(err, username));
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

function stopConnection(silent = false) {
  autoReconnect = false;
  clearTimeout(reconnectTimer);
  reconnectDelay = 5000;
  if (!connection) {
    state.status = 'disconnected';
    state.statusDetail = 'غير متصل';
    pushStatus();
    return;
  }
  state.statusDetail = 'غير متصل';
  teardown('disconnected');
  if (!silent) pushEvent('connection', 'تم إيقاف الاتصال.');
}

/* ---------------------------------------------------------------
   تغيير حساب تيك توك من الواجهة
--------------------------------------------------------------- */

function setAccount(rawUsername) {
  const username = String(rawUsername || '').trim().replace(/^@/, '').slice(0, 40);
  if (!username) {
    pushEvent('error', 'اسم الحساب فاضي.');
    return;
  }
  if (username === state.config.username && state.status === 'connected') {
    pushEvent('system', `أنت متصل أصلًا بـ @${username}.`);
    return;
  }

  stopConnection(true);
  state.config.username = username;
  saveConfig();
  pushSettings();
  pushEvent('system', `تم تغيير الحساب إلى @${username}.`);
  startConnection(username);
}

/* ---------------------------------------------------------------
   معالجة كل رسالة شات
--------------------------------------------------------------- */

function isJoinOpen() {
  if (state.config.joinDuringRoundOnly && !state.round.active) return false;
  if (state.participants.size >= state.config.maxParticipants) return false;
  return true;
}

let fullNotified = false;

function onChat(event) {
  const user = readUser(event?.user);
  if (!user) return;
  const content = getChatText(event);

  // رسائل الفائز الحالي تُبثّ إلى شاشة المتابعة
  if (state.winner && state.winner.id === user.id) {
    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: content,
      at: Date.now(),
    };
    state.winnerMessages.push(message);
    if (state.winnerMessages.length > 300) state.winnerMessages.shift();
    io.emit('winner:message', message);
  }

  if (!isJoinMessage(content)) return;
  if (state.participants.has(user.id)) return;
  if (state.config.excludeWinners && state.excluded.has(user.id)) return;

  if (state.config.joinDuringRoundOnly && !state.round.active) return;

  if (state.participants.size >= state.config.maxParticipants) {
    if (!fullNotified) {
      fullNotified = true;
      pushEvent('system', `اكتمل العدد (${state.config.maxParticipants}) — التسجيل مقفل.`);
      io.emit('join:closed', { reason: 'full' });
      if (state.round.active && state.config.stopWhenFull) endRound(true);
    }
    return;
  }

  const participant = {
    ...user,
    order: state.participants.size + 1,
    joinedAt: Date.now(),
  };
  state.participants.set(user.id, participant);
  io.emit('participant:add', participant);
  pushEvent('join', `${participant.name} انضم للقائمة`, {
    handle: participant.handle,
    avatar: participant.avatar,
    order: participant.order,
  });

  if (state.participants.size >= state.config.maxParticipants) {
    fullNotified = true;
    pushEvent('system', `اكتمل العدد (${state.config.maxParticipants}) — التسجيل مقفل.`);
    io.emit('join:closed', { reason: 'full' });
    if (state.round.active && state.config.stopWhenFull) endRound(true);
  }
}

/* ---------------------------------------------------------------
   الجولة والعد التنازلي
--------------------------------------------------------------- */

function startRound() {
  if (state.round.active) return;

  const total = state.config.countdownSeconds;
  if (total <= 0) {
    pickWinner();
    return;
  }

  state.round = { active: true, total, remaining: total };
  io.emit('round:start', { ...state.round });
  pushEvent('round', `بدأ العد التنازلي · ${total} ثانية والتسجيل مفتوح`);

  clearInterval(roundTimer);
  roundTimer = setInterval(() => {
    state.round.remaining -= 1;
    if (state.round.remaining <= 0) {
      endRound(true);
      return;
    }
    io.emit('round:tick', { ...state.round });
  }, 1000);
}

function endRound(draw) {
  clearInterval(roundTimer);
  roundTimer = null;
  if (!state.round.active) return;
  state.round = { active: false, total: state.round.total, remaining: 0 };
  io.emit('round:end', { drew: Boolean(draw) });

  if (draw && state.config.autoDraw) {
    pushEvent('round', 'انتهى العد التنازلي · جارٍ اختيار الفائز');
    pickWinner();
  } else {
    pushEvent('round', draw ? 'انتهى العد التنازلي' : 'تم إلغاء العد التنازلي');
  }
}

/* ---------------------------------------------------------------
   السحب
--------------------------------------------------------------- */

function pickWinner() {
  const pool = [...state.participants.values()].filter(
    (p) => !(state.config.excludeWinners && state.excluded.has(p.id))
  );

  if (pool.length === 0) {
    pushEvent('system', 'ما فيه مشاركين مؤهلين للسحب.');
    io.emit('draw:empty');
    return;
  }

  const winner = pool[randomInt(0, pool.length)];
  state.winner = winner;
  state.winnerMessages = [];

  state.history.unshift({ ...winner, wonAt: Date.now() });
  if (state.history.length > 50) state.history.pop();
  store.saveWinner(winner).catch((err) => console.error('تعذّر حفظ الفائز:', err.message));

  if (state.config.excludeWinners) {
    state.excluded.add(winner.id);
    state.participants.delete(winner.id);
  }

  io.emit('winner', {
    winner,
    history: state.history,
    participants: [...state.participants.values()],
  });
  pushEvent('winner', `الفائز: ${winner.name}${winner.handle ? ` (@${winner.handle})` : ''}`, {
    handle: winner.handle,
    avatar: winner.avatar,
  });
}

function backToList() {
  state.winner = null;
  state.winnerMessages = [];
  io.emit('winner:clear');
}

function clearParticipants() {
  state.participants.clear();
  fullNotified = false;
  io.emit('participants:clear');
  pushEvent('system', 'تم مسح قائمة المشاركين.');
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
  res.send('\uFEFF' + csv);
});

app.get('/api/health', (req, res) => {
  res.json({
    status: state.status,
    username: state.config.username,
    participants: state.participants.size,
    round: state.round,
  });
});

/* ---------------------------------------------------------------
   قناة الوقت الفعلي
--------------------------------------------------------------- */

io.on('connection', (socket) => {
  socket.emit('state', snapshot());

  socket.on('account:set', (payload = {}) => setAccount(payload.username));
  socket.on('account:check', (payload = {}) => checkAccount(payload.username || state.config.username));
  socket.on('connection:retry', () => {
    stopConnection(true);
    startConnection(state.config.username);
  });
  socket.on('stop', () => stopConnection());

  socket.on('round:start', () => startRound());
  socket.on('round:cancel', () => endRound(false));
  socket.on('draw', () => {
    if (state.round.active) endRound(false);
    pickWinner();
  });
  socket.on('back', () => backToList());
  socket.on('clear', () => clearParticipants());

  socket.on('settings:set', (payload = {}) => {
    const next = sanitizeConfig({ ...state.config, ...payload, sound: { ...state.config.sound, ...(payload.sound || {}) } }, state.config);
    const keywordChanged = next.keyword !== state.config.keyword;
    next.username = state.config.username; // الحساب يتغيّر من زره الخاص فقط
    state.config = next;
    saveConfig();
    pushSettings();
    if (keywordChanged) pushEvent('system', `كلمة الدخول صارت «${state.config.keyword}»`);
    else pushEvent('system', 'تم حفظ الإعدادات.');
    if (state.participants.size < state.config.maxParticipants) fullNotified = false;
  });

  socket.on('history:clear', () => {
    state.history = [];
    state.excluded.clear();
    store.clearWinners().catch((err) => console.error('تعذّر مسح السجل:', err.message));
    io.emit('history:clear');
    pushEvent('system', 'تم مسح سجل الفائزين وإعادة تأهيل الجميع.');
  });

  socket.on('events:clear', () => {
    state.events = [];
    io.emit('events:clear');
  });

  // وضع التجربة: مشاركون وهميون لاختبار الواجهة بدون بث حقيقي
  socket.on('demo', (payload = {}) => {
    const room = Math.max(state.config.maxParticipants - state.participants.size, 0);
    const count = Math.min(Math.max(parseInt(payload.count, 10) || 12, 1), Math.min(60, room));
    if (count === 0) {
      pushEvent('system', 'القائمة ممتلئة — ما قدرت أضيف مشاركين تجريبيين.');
      return;
    }
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
      pushEvent('join', `${participant.name} انضم للقائمة (تجريبي)`, { handle: participant.handle });
    }
    if (state.participants.size >= state.config.maxParticipants) {
      fullNotified = true;
      pushEvent('system', `اكتمل العدد (${state.config.maxParticipants}) — التسجيل مقفل.`);
      io.emit('join:closed', { reason: 'full' });
      if (state.round.active && state.config.stopWhenFull) endRound(true);
    }
  });
});

/* ---------------------------------------------------------------
   الإقلاع
--------------------------------------------------------------- */

async function boot() {
  await store.init();

  const saved = await store.loadConfig();
  if (saved) state.config = sanitizeConfig(saved);

  // نرجّع سجل الفائزين حتى يظل الاستبعاد شغّالًا بعد إعادة التشغيل
  const winners = await store.loadWinners(50);
  state.history = winners;
  winners.forEach((w) => state.excluded.add(w.id));

  server.listen(PORT, () => {
    console.log(`\n  🚀 صاروخ الحظ يعمل على  →  http://localhost:${PORT}`);
    console.log(`  🟩 الشاشة الخضراء       →  http://localhost:${PORT}/green.html`);
    console.log(`  🏆 فائزون محفوظون: ${winners.length}\n`);

    if (state.config.username) {
      startConnection(state.config.username);
    } else {
      state.statusDetail = 'أضف حساب تيك توك من الشريط العلوي';
      console.log('  ℹ️  ما فيه حساب محفوظ — اكتب اسم حسابك من الشريط العلوي في الموقع.\n');
    }
  });
}

boot().catch((err) => {
  console.error('فشل الإقلاع:', err);
  process.exit(1);
});
