'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const { randomInt, randomBytes } = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');
const store = require('./store');

const PORT = process.env.PORT || 3000;
const SIGN_API_KEY = process.env.SIGN_API_KEY || undefined;

const MAX_EVENTS = 400;
const ROOM_IDLE_MS = 10 * 60 * 1000;   // نغلق اتصال البث بعد ١٠ دقائق بلا مشاهدين للغرفة
const MAX_ROOMS = 200;

/* ══════════════════════════════════════════════════════════════
   الإعدادات الافتراضية لكل غرفة
   ══════════════════════════════════════════════════════════════ */

const DEFAULT_CONFIG = {
  username: '',              // حساب تيك توك المربوط (بدون @)
  keyword: 'بلعب',           // الكلمة التي يكتبها المشاهد
  matchMode: 'contains',     // contains = تكفي الكلمة داخل الرسالة | exact = الرسالة كلها
  excludeWinners: true,      // استبعاد من فاز سابقًا
  maxParticipants: 100,      // الحد الأقصى للمشاركين
  countdownSeconds: 30,      // مدة العد التنازلي
  startMode: 'countdown',    // سلوك زر «ابدأ»: countdown أو instant
  autoDraw: true,            // السحب تلقائيًا بعد العد
  joinDuringRoundOnly: false,
  stopWhenFull: true,
  sound: { enabled: true, volume: 0.6 },

  overlay: {
    players: {
      bg: 'transparent', size: 26, layout: 'grid', cols: 'auto',
      align: 'start', max: 0, faces: true, bar: true, sound: true,
    },
    events: {
      bg: 'transparent', size: 22, rows: 8, fade: 0,
      filter: 'all', dir: 'down', width: 100, time: true,
    },
  },
};

const OVERLAY_RULES = {
  players: {
    bg: ['transparent', 'green', 'blue', 'magenta', 'dark'],
    size: [10, 80],
    layout: ['grid', 'list'],
    cols: ['auto', '1', '2', '3', '4', '5'],
    align: ['start', 'center', 'end'],
    max: [0, 200],
    faces: 'bool', bar: 'bool', sound: 'bool',
  },
  events: {
    bg: ['transparent', 'green', 'blue', 'magenta', 'dark'],
    size: [10, 64],
    rows: [1, 30],
    fade: [0, 120],
    filter: ['all', 'join', 'winner', 'round', 'connection'],
    dir: ['up', 'down'],
    width: [20, 100],
    time: 'bool',
  },
};

function sanitizeOverlay(screen, input = {}, base = DEFAULT_CONFIG.overlay[screen]) {
  const rules = OVERLAY_RULES[screen];
  const out = { ...base };

  Object.entries(rules).forEach(([key, rule]) => {
    const value = (input || {})[key];
    if (value === undefined) return;

    if (rule === 'bool') {
      out[key] = Boolean(value);
    } else if (Array.isArray(rule) && typeof rule[0] === 'string') {
      if (rule.includes(String(value))) out[key] = String(value);
    } else if (Array.isArray(rule)) {
      const n = Number.parseInt(value, 10);
      if (!Number.isNaN(n)) out[key] = Math.min(Math.max(n, rule[0]), rule[1]);
    }
  });

  return out;
}

function sanitizeConfig(input = {}, base = DEFAULT_CONFIG) {
  const num = (value, fallback, min, max) => {
    const n = Number.parseInt(value, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(Math.max(n, min), max);
  };

  const soundInput = input.sound || {};
  const baseOverlay = base.overlay || DEFAULT_CONFIG.overlay;

  return {
    username: String(input.username ?? base.username).trim().replace(/^@/, '').slice(0, 40),
    keyword: (String(input.keyword ?? base.keyword).trim() || base.keyword).slice(0, 40),
    matchMode: input.matchMode === 'exact' || input.matchMode === 'contains' ? input.matchMode : base.matchMode,
    excludeWinners: typeof input.excludeWinners === 'boolean' ? input.excludeWinners : base.excludeWinners,
    maxParticipants: num(input.maxParticipants, base.maxParticipants, 1, 5000),
    countdownSeconds: num(input.countdownSeconds, base.countdownSeconds, 0, 900),
    startMode: input.startMode === 'instant' || input.startMode === 'countdown' ? input.startMode : base.startMode,
    autoDraw: typeof input.autoDraw === 'boolean' ? input.autoDraw : base.autoDraw,
    joinDuringRoundOnly:
      typeof input.joinDuringRoundOnly === 'boolean' ? input.joinDuringRoundOnly : base.joinDuringRoundOnly,
    stopWhenFull: typeof input.stopWhenFull === 'boolean' ? input.stopWhenFull : base.stopWhenFull,
    sound: {
      enabled: typeof soundInput.enabled === 'boolean' ? soundInput.enabled : base.sound.enabled,
      volume: Math.min(Math.max(Number(soundInput.volume ?? base.sound.volume) || 0, 0), 1),
    },
    overlay: {
      players: sanitizeOverlay('players', (input.overlay || {}).players, baseOverlay.players),
      events: sanitizeOverlay('events', (input.overlay || {}).events, baseOverlay.events),
    },
  };
}

/* ══════════════════════════════════════════════════════════════
   الغرف — كل مستخدم للموقع له غرفة مستقلة
   ══════════════════════════════════════════════════════════════ */

const rooms = new Map();
const loading = new Map();

function normalizeRoomId(raw) {
  const clean = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  return clean || 'default';
}

function newRoomId() {
  return randomBytes(5).toString('hex');
}

function createRoom(id) {
  return {
    id,
    config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
    status: 'disconnected',
    statusDetail: 'غير متصل',
    participants: new Map(),
    winner: null,
    winnerMessages: [],
    history: [],
    excluded: new Set(),
    removedWinners: [],       // فائزون أُخرجوا من القائمة بسبب خيار الاستبعاد
    events: [],
    round: { active: false, total: 0, remaining: 0 },
    connection: null,
    autoReconnect: true,
    reconnectTimer: null,
    reconnectDelay: 5000,
    roundTimer: null,
    idleTimer: null,
    fullNotified: false,
    lastNoise: { text: '', at: 0 },
  };
}

async function getRoom(rawId) {
  const id = normalizeRoomId(rawId);
  if (rooms.has(id)) return rooms.get(id);
  if (loading.has(id)) return loading.get(id);

  const task = (async () => {
    const room = createRoom(id);

    const saved = await store.loadConfig(id);
    if (saved) room.config = sanitizeConfig(saved);

    const winners = await store.loadWinners(id, 50);
    room.history = winners;
    winners.forEach((w) => room.excluded.add(w.id));

    // حماية بسيطة من امتلاء الذاكرة
    if (rooms.size >= MAX_ROOMS) dropIdlestRoom();

    rooms.set(id, room);
    loading.delete(id);
    return room;
  })();

  loading.set(id, task);
  return task;
}

function dropIdlestRoom() {
  let target = null;
  for (const room of rooms.values()) {
    const size = io.sockets.adapter.rooms.get(room.id)?.size || 0;
    if (size === 0) { target = room; break; }
  }
  if (target) closeRoom(target, 'ازدحام الذاكرة');
}

function closeRoom(room, reason) {
  clearTimeout(room.reconnectTimer);
  clearTimeout(room.idleTimer);
  clearInterval(room.roundTimer);
  room.autoReconnect = false;
  try { room.connection?.disconnect(); } catch (_) { /* تجاهل */ }
  rooms.delete(room.id);
  console.log(`أُغلقت الغرفة ${room.id} (${reason})`);
}

function scheduleIdleCleanup(room) {
  clearTimeout(room.idleTimer);
  room.idleTimer = setTimeout(() => {
    const size = io.sockets.adapter.rooms.get(room.id)?.size || 0;
    if (size > 0) return;
    closeRoom(room, 'بلا مشاهدين');
  }, ROOM_IDLE_MS);
}

/* ══════════════════════════════════════════════════════════════
   خادم الويب
   ══════════════════════════════════════════════════════════════ */

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ─────────── سجل الأحداث ─────────── */

function pushEvent(room, type, text, extra = {}) {
  if (type === 'error' || type === 'connection') {
    if (text === room.lastNoise.text && Date.now() - room.lastNoise.at < 8000) return null;
    room.lastNoise = { text, at: Date.now() };
  }

  const event = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    text,
    at: Date.now(),
    ...extra,
  };
  room.events.push(event);
  if (room.events.length > MAX_EVENTS) room.events.shift();
  io.to(room.id).emit('event', event);
  console.log(`[${room.id}] [${type}] ${text}`);
  return event;
}

/* ─────────── تطبيع النص العربي ─────────── */

function normalizeArabic(input) {
  return String(input || '')
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627')
    .replace(/\u0629/g, '\u0647')
    .replace(/\u0649/g, '\u064A')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isJoinMessage(room, content) {
  const text = normalizeArabic(content);
  const key = normalizeArabic(room.config.keyword);
  if (!key || !text) return false;
  if (room.config.matchMode === 'contains') {
    return text.split(' ').includes(key) || text.includes(key);
  }
  return text === key;
}

/* ─────────── اللقطة والبث ─────────── */

function isJoinOpen(room) {
  if (room.config.joinDuringRoundOnly && !room.round.active) return false;
  if (room.participants.size >= room.config.maxParticipants) return false;
  return true;
}

function snapshot(room) {
  return {
    room: room.id,
    status: room.status,
    statusDetail: room.statusDetail,
    config: room.config,
    participants: [...room.participants.values()],
    winner: room.winner,
    winnerMessages: room.winnerMessages,
    history: room.history,
    events: room.events.slice(-120),
    round: room.round,
    joinOpen: isJoinOpen(room),
  };
}

function pushStatus(room) {
  io.to(room.id).emit('status', {
    status: room.status,
    statusDetail: room.statusDetail,
    username: room.config.username,
  });
}

function pushSettings(room) {
  io.to(room.id).emit('settings', room.config);
}

function saveRoom(room) {
  store.saveConfig(room.id, room.config).catch((err) => {
    console.error('تعذّر حفظ الإعدادات:', err.message);
  });
}

/* ─────────── قراءة بيانات المستخدم ─────────── */

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
    event?.comment ?? event?.content ?? event?.message ?? event?.text ??
    event?.commentText ?? event?.messageText ?? event?.msg ?? '';

  if (typeof value === 'string') return value;
  if (value && typeof value.text === 'string') return value.text;
  if (value && typeof value.content === 'string') return value.content;
  return '';
}

/* ─────────── الاتصال بالبث ─────────── */

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
    return 'تعذّر الاتصال: تجاوزت حد خدمة التوقيع. انتظر دقيقة، أو تأكد من SIGN_API_KEY.';
  }
  return `تعذّر الاتصال: ${msg}`;
}

async function startConnection(room, rawUsername) {
  if (room.status === 'connecting' || room.status === 'connected') {
    pushEvent(room, 'system', 'الاتصال شغّال بالفعل.');
    return;
  }

  const username = String(rawUsername || room.config.username || '').trim().replace(/^@/, '');
  if (!username) {
    room.status = 'disconnected';
    room.statusDetail = 'أضف حساب تيك توك من الشريط العلوي';
    pushStatus(room);
    pushEvent(room, 'system', 'ما فيه حساب مربوط. اكتب اسم حسابك في أعلى الصفحة.');
    return;
  }

  room.autoReconnect = true;
  room.config.username = username;
  room.status = 'connecting';
  room.statusDetail = 'جارٍ الاتصال…';
  pushStatus(room);

  const connection = new TikTokLiveConnection(username, {
    signApiKey: SIGN_API_KEY,
    processInitialData: false,
    fetchRoomInfoOnConnect: true,
    enableExtendedGiftInfo: false,
  });
  room.connection = connection;

  connection.on(WebcastEvent.CHAT, (event) => onChat(room, event));

  connection.on(WebcastEvent.STREAM_END, () => {
    if (room.connection !== connection) return;
    room.statusDetail = 'انتهى البث';
    pushEvent(room, 'connection', 'انتهى البث المباشر.');
    teardown(room, 'disconnected');
    scheduleReconnect(room, username);
  });

  connection.on(ControlEvent.DISCONNECTED, () => {
    if (room.connection !== connection || room.status === 'disconnected') return;
    room.statusDetail = 'انقطع الاتصال';
    pushEvent(room, 'connection', 'انقطع الاتصال بالبث.');
    teardown(room, 'disconnected');
    scheduleReconnect(room, username);
  });

  connection.on(ControlEvent.ERROR, (err) => {
    if (room.connection !== connection) return;
    pushEvent(room, 'error', `خطأ في الاتصال: ${errorText(err)}`);
  });

  try {
    await connection.connect();
    if (room.connection !== connection) return;
    room.status = 'connected';
    room.statusDetail = `متصل بـ @${username}`;
    pushStatus(room);
    pushEvent(room, 'connection', `تم الاتصال ببث @${username} · كلمة الدخول «${room.config.keyword}»`);
    room.reconnectDelay = 5000;
  } catch (err) {
    if (room.connection !== connection) return;
    room.status = 'error';
    room.statusDetail = 'فشل الاتصال';
    pushStatus(room);
    pushEvent(room, 'error', describeConnectError(err, username));
    room.connection = null;
    scheduleReconnect(room, username);
  }
}

function scheduleReconnect(room, username) {
  if (!room.autoReconnect || !username) return;
  clearTimeout(room.reconnectTimer);
  const delay = room.reconnectDelay;
  room.reconnectDelay = Math.min(room.reconnectDelay * 2, 60000);
  room.statusDetail = `إعادة المحاولة خلال ${Math.round(delay / 1000)} ثانية`;
  pushStatus(room);
  room.reconnectTimer = setTimeout(() => {
    if (!rooms.has(room.id)) return;
    if (room.status === 'disconnected' || room.status === 'error') startConnection(room, username);
  }, delay);
}

async function checkAccount(room, rawUsername) {
  const username = String(rawUsername || '').trim().replace(/^@/, '');
  if (!username) {
    pushEvent(room, 'error', 'اكتب اسم المستخدم أولًا.');
    return;
  }
  pushEvent(room, 'system', `جارٍ التحقق من @${username} …`);
  try {
    const probe = new TikTokLiveConnection(username, { signApiKey: SIGN_API_KEY });
    const live = await probe.fetchIsLive();
    pushEvent(room, 'system', live
      ? `@${username} على الهواء الآن.`
      : `الاسم @${username} صحيح، لكن الحساب مو على الهواء حاليًا.`);
  } catch (err) {
    pushEvent(room, 'error', describeConnectError(err, username));
  }
}

function teardown(room, nextStatus) {
  try { room.connection?.disconnect(); } catch (_) { /* تجاهل */ }
  room.connection = null;
  room.status = nextStatus;
  pushStatus(room);
}

function stopConnection(room, silent = false) {
  room.autoReconnect = false;
  clearTimeout(room.reconnectTimer);
  room.reconnectDelay = 5000;
  if (!room.connection) {
    room.status = 'disconnected';
    room.statusDetail = 'غير متصل';
    pushStatus(room);
    return;
  }
  room.statusDetail = 'غير متصل';
  teardown(room, 'disconnected');
  if (!silent) pushEvent(room, 'connection', 'تم إيقاف الاتصال.');
}

function setAccount(room, rawUsername) {
  const username = String(rawUsername || '').trim().replace(/^@/, '').slice(0, 40);
  if (!username) {
    pushEvent(room, 'error', 'اسم الحساب فاضي.');
    return;
  }
  if (username === room.config.username && room.status === 'connected') {
    pushEvent(room, 'system', `أنت متصل أصلًا بـ @${username}.`);
    return;
  }

  stopConnection(room, true);
  room.config.username = username;
  saveRoom(room);
  pushSettings(room);
  pushEvent(room, 'system', `تم تغيير الحساب إلى @${username}.`);
  startConnection(room, username);
}

/* ─────────── معالجة الشات ─────────── */

function noticeFull(room) {
  if (room.fullNotified) return;
  room.fullNotified = true;
  pushEvent(room, 'system', `اكتمل العدد (${room.config.maxParticipants}) — التسجيل مقفل.`);
  io.to(room.id).emit('join:closed', { reason: 'full' });
  if (room.round.active && room.config.stopWhenFull) endRound(room, true);
}

function addParticipant(room, user, note = '') {
  const participant = { ...user, order: room.participants.size + 1, joinedAt: Date.now() };
  room.participants.set(user.id, participant);
  io.to(room.id).emit('participant:add', participant);
  pushEvent(room, 'join', `${participant.name} انضم للقائمة${note}`, {
    handle: participant.handle,
    avatar: participant.avatar,
    order: participant.order,
  });
  return participant;
}

function onChat(room, event) {
  const user = readUser(event?.user);
  if (!user) return;
  const content = getChatText(event);

  if (room.winner && room.winner.id === user.id) {
    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: content,
      at: Date.now(),
    };
    room.winnerMessages.push(message);
    if (room.winnerMessages.length > 300) room.winnerMessages.shift();
    io.to(room.id).emit('winner:message', message);
  }

  if (!isJoinMessage(room, content)) return;
  if (room.participants.has(user.id)) return;

  // الاستبعاد يعمل فقط عندما يكون الخيار مفعّلًا
  if (room.config.excludeWinners && room.excluded.has(user.id)) return;

  if (room.config.joinDuringRoundOnly && !room.round.active) return;

  if (room.participants.size >= room.config.maxParticipants) {
    noticeFull(room);
    return;
  }

  addParticipant(room, user);

  if (room.participants.size >= room.config.maxParticipants) noticeFull(room);
}

/* ─────────── الجولة ─────────── */

function startRound(room) {
  if (room.round.active) return;

  const total = room.config.countdownSeconds;
  if (total <= 0) {
    pickWinner(room);
    return;
  }

  room.round = { active: true, total, remaining: total };
  io.to(room.id).emit('round:start', { ...room.round });
  pushEvent(room, 'round', `بدأ العد التنازلي · ${total} ثانية والتسجيل مفتوح`);

  clearInterval(room.roundTimer);
  room.roundTimer = setInterval(() => {
    room.round.remaining -= 1;
    if (room.round.remaining <= 0) {
      endRound(room, true);
      return;
    }
    io.to(room.id).emit('round:tick', { ...room.round });
  }, 1000);
}

function endRound(room, draw) {
  clearInterval(room.roundTimer);
  room.roundTimer = null;
  if (!room.round.active) return;
  room.round = { active: false, total: room.round.total, remaining: 0 };
  io.to(room.id).emit('round:end', { drew: Boolean(draw) });

  if (draw && room.config.autoDraw) {
    pushEvent(room, 'round', 'انتهى العد التنازلي · جارٍ اختيار الفائز');
    pickWinner(room);
  } else {
    pushEvent(room, 'round', draw ? 'انتهى العد التنازلي' : 'تم إلغاء العد التنازلي');
  }
}

/* ─────────── السحب ─────────── */

function pickWinner(room) {
  const pool = [...room.participants.values()].filter(
    (p) => !(room.config.excludeWinners && room.excluded.has(p.id))
  );

  if (pool.length === 0) {
    pushEvent(room, 'system', 'ما فيه مشاركين مؤهلين للسحب.');
    io.to(room.id).emit('draw:empty');
    return;
  }

  const winner = pool[randomInt(0, pool.length)];
  room.winner = winner;
  room.winnerMessages = [];

  room.history.unshift({ ...winner, wonAt: Date.now() });
  if (room.history.length > 50) room.history.pop();
  store.saveWinner(room.id, winner).catch((err) => console.error('تعذّر حفظ الفائز:', err.message));

  if (room.config.excludeWinners) {
    room.excluded.add(winner.id);
    room.participants.delete(winner.id);
    room.removedWinners = room.removedWinners.filter((p) => p.id !== winner.id);
    room.removedWinners.push(winner);
    if (room.removedWinners.length > 100) room.removedWinners.shift();
  }

  io.to(room.id).emit('winner', {
    winner,
    history: room.history,
    participants: [...room.participants.values()],
  });
  pushEvent(room, 'winner', `الفائز: ${winner.name}${winner.handle ? ` (@${winner.handle})` : ''}`, {
    handle: winner.handle,
    avatar: winner.avatar,
  });
}

function backToList(room) {
  room.winner = null;
  room.winnerMessages = [];
  io.to(room.id).emit('winner:clear');
}

function clearParticipants(room) {
  room.participants.clear();
  room.fullNotified = false;
  // نصفّر الاستبعاد أيضًا حتى تصير مسحة القائمة "تصفيرًا كاملًا" —
  // فمن فاز أو شارك سابقًا يقدر يشارك من جديد حتى لو خيار استبعاد
  // الفائزين السابقين مفعّل، بدل ما يبقى مستبعدًا بصمت.
  room.excluded.clear();
  room.removedWinners = [];
  io.to(room.id).emit('participants:clear');
  pushEvent(room, 'system', 'تم مسح قائمة المشاركين بالكامل — ومن فاز سابقًا صار يقدر يشارك من جديد.');
}

/* ─────────── عند إلغاء خيار الاستبعاد ─────────── */

function readmitWinners(room) {
  // نمسح الاستبعاد فقط حتى يصير الفائزون السابقون مؤهّلين من جديد —
  // لكن لا نُدرجهم تلقائيًا في القائمة، لازم يكتبوا كلمة الدخول مرة أخرى
  // حتى يُسجَّل اسمهم، تمامًا مثل أي مشاهد جديد.
  room.excluded.clear();
  room.removedWinners = [];
  pushEvent(room, 'system', 'تم إلغاء استبعاد الفائزين — لازم يكتبوا كلمة الدخول مرة أخرى عشان يتسجل اسمهم.');
}

/* ─────────── واجهات HTTP ─────────── */

app.get('/api/participants.csv', async (req, res) => {
  const room = await getRoom(req.query.room);
  const rows = [['#', 'الاسم', 'المعرف', 'وقت التسجيل']];
  for (const p of room.participants.values()) {
    const t = new Date(p.joinedAt);
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
    rows.push([p.order, p.name, p.handle ? `@${p.handle}` : '', stamp]);
  }
  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="participants-${room.id}.csv"`);
  res.send('\uFEFF' + csv);
});

app.get('/api/health', async (req, res) => {
  res.json({
    ok: true,
    activeRooms: rooms.size,
    storage: await store.health(),
  });
});

app.get('/api/room/new', (req, res) => {
  res.json({ room: newRoomId() });
});

/* ─────────── قناة الوقت الفعلي ─────────── */

io.on('connection', (socket) => {
  const roomId = normalizeRoomId(socket.handshake.query.room);
  socket.join(roomId);

  const withRoom = (handler) => async (payload) => {
    const room = await getRoom(roomId);
    clearTimeout(room.idleTimer);
    handler(room, payload || {});
  };

  getRoom(roomId).then((room) => {
    clearTimeout(room.idleTimer);
    socket.emit('state', snapshot(room));
  });

  socket.on('account:set', withRoom((room, p) => setAccount(room, p.username)));
  socket.on('account:check', withRoom((room, p) => checkAccount(room, p.username || room.config.username)));
  socket.on('connection:retry', withRoom((room) => {
    stopConnection(room, true);
    startConnection(room, room.config.username);
  }));
  socket.on('stop', withRoom((room) => stopConnection(room)));

  socket.on('round:start', withRoom((room) => {
    if (room.config.startMode === 'instant') {
      if (room.round.active) endRound(room, false);
      pickWinner(room);
    } else {
      startRound(room);
    }
  }));
  socket.on('round:cancel', withRoom((room) => endRound(room, false)));
  socket.on('draw', withRoom((room) => {
    if (room.round.active) endRound(room, false);
    pickWinner(room);
  }));
  socket.on('back', withRoom((room) => backToList(room)));
  socket.on('clear', withRoom((room) => clearParticipants(room)));

  socket.on('settings:set', withRoom((room, payload) => {
    const wasExcluding = room.config.excludeWinners;
    const next = sanitizeConfig(
      { ...room.config, ...payload, sound: { ...room.config.sound, ...(payload.sound || {}) } },
      room.config
    );
    const keywordChanged = next.keyword !== room.config.keyword;
    next.username = room.config.username;   // الحساب يتغيّر من زره الخاص فقط
    next.overlay = room.config.overlay;      // الشاشات لها قناتها الخاصة
    room.config = next;
    saveRoom(room);
    pushSettings(room);

    if (keywordChanged) pushEvent(room, 'system', `كلمة الدخول صارت «${room.config.keyword}»`);
    else pushEvent(room, 'system', 'تم حفظ الإعدادات.');

    // إلغاء الاستبعاد يعيد الفائزين السابقين فورًا
    if (wasExcluding && !room.config.excludeWinners) readmitWinners(room);

    if (room.participants.size < room.config.maxParticipants) room.fullNotified = false;
  }));

  socket.on('overlay:set', withRoom((room, payload) => {
    const screen = payload.screen === 'events' ? 'events' : 'players';
    const patch = payload.patch || {};
    room.config.overlay[screen] = sanitizeOverlay(
      screen,
      { ...room.config.overlay[screen], ...patch },
      room.config.overlay[screen]
    );
    saveRoom(room);
    io.to(room.id).emit('overlay', { screen, settings: room.config.overlay[screen] });
  }));

  socket.on('history:clear', withRoom((room) => {
    room.history = [];
    room.excluded.clear();
    room.removedWinners = [];
    store.clearWinners(room.id).catch((err) => console.error('تعذّر مسح السجل:', err.message));
    io.to(room.id).emit('history:clear');
    pushEvent(room, 'system', 'تم مسح سجل الفائزين وإعادة تأهيل الجميع.');
  }));

  socket.on('events:clear', withRoom((room) => {
    room.events = [];
    io.to(room.id).emit('events:clear');
  }));

  socket.on('demo', withRoom((room, payload) => {
    const space = Math.max(room.config.maxParticipants - room.participants.size, 0);
    const count = Math.min(Math.max(parseInt(payload.count, 10) || 12, 1), Math.min(60, space));
    if (count === 0) {
      pushEvent(room, 'system', 'القائمة ممتلئة — ما قدرت أضيف مشاركين تجريبيين.');
      return;
    }
    const names = ['أحمد', 'سارة', 'خالد', 'نورة', 'يوسف', 'ليان', 'عبدالله', 'جنى', 'محمد', 'رهف', 'سلطان', 'دانة', 'فهد', 'مريم', 'تركي', 'شهد'];
    for (let i = 0; i < count; i += 1) {
      addParticipant(room, {
        id: `demo-${Date.now()}-${i}`,
        handle: `user${Math.floor(Math.random() * 9000) + 1000}`,
        name: `${names[i % names.length]} ${Math.floor(Math.random() * 99)}`,
        avatar: '',
      }, ' (تجريبي)');
    }
    if (room.participants.size >= room.config.maxParticipants) noticeFull(room);
  }));

  socket.on('disconnect', () => {
    const room = rooms.get(roomId);
    if (!room) return;
    const size = io.sockets.adapter.rooms.get(roomId)?.size || 0;
    if (size === 0) scheduleIdleCleanup(room);
  });
});

/* ─────────── الإقلاع ─────────── */

async function boot() {
  await store.init();

  server.listen(PORT, () => {
    console.log(`\n  لوحة القرعة تعمل على   →  http://localhost:${PORT}`);
    console.log(`  شاشة اللاعبين          →  http://localhost:${PORT}/players.html`);
    console.log(`  شاشة الأحداث           →  http://localhost:${PORT}/green.html\n`);
  });
}

boot().catch((err) => {
  console.error('فشل الإقلاع:', err);
  process.exit(1);
});
