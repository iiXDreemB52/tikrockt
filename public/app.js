'use strict';

const $ = (id) => document.getElementById(id);

/* ═══════════ الغرفة — تعزل بيانات كل مستخدم عن غيره ═══════════ */

const cleanRoom = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);

/* الرمز يُحفظ في مكانين (التخزين المحلي + كوكي سنة كاملة) حتى يبقى
   رابط الشاشة ثابتًا لصاحبه مهما أغلق المتصفح أو أعاد فتح الموقع */
function readRoomCookie() {
  const hit = document.cookie.split('; ').find((c) => c.startsWith('draw_room='));
  return hit ? cleanRoom(decodeURIComponent(hit.slice(10))) : '';
}
function writeRoomCookie(id) {
  document.cookie = `draw_room=${encodeURIComponent(id)}; path=/; max-age=34560000; samesite=lax`;
}
function rememberRoom(id) {
  try { localStorage.setItem('draw:room', id); } catch (_) { /* التخزين غير متاح */ }
  writeRoomCookie(id);
}

function resolveRoom() {
  const fromUrl = new URLSearchParams(location.search).get('room');

  let id = cleanRoom(fromUrl);
  if (!id) {
    try { id = cleanRoom(localStorage.getItem('draw:room')); } catch (_) { id = ''; }
  }
  if (!id) id = readRoomCookie();
  if (!id) {
    const bytes = new Uint8Array(5);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  rememberRoom(id);

  if (fromUrl !== id) {
    const url = new URL(location.href);
    url.searchParams.set('room', id);
    history.replaceState(null, '', url);
  }
  return id;
}

/* تغيير الرمز يدويًا — يفيد لاسترجاع نفس الرابط على جهاز أو متصفح آخر */
function switchRoom(raw) {
  const id = cleanRoom(raw);
  if (!id) { toast('اكتب رمزًا صحيحًا (حروف إنجليزية وأرقام)'); return; }
  if (id === ROOM) { toast('هذا هو رمزك الحالي'); return; }
  rememberRoom(id);
  const url = new URL(location.href);
  url.searchParams.set('room', id);
  location.href = url.toString();
}

const ROOM = resolveRoom();
const screenUrl = (page) => `${location.origin}/${page}?room=${ROOM}`;

const el = {
  stageMain: $('stage-main'),
  stageWinner: $('stage-winner'),
  count: $('count'),
  countCap: $('count-cap'),
  tallyFill: $('tally-fill'),
  tickets: $('tickets'),
  empty: $('empty'),
  emptyKeyword: $('empty-keyword'),
  hintKeyword: $('hint-keyword'),
  hintClosed: $('hint-closed'),
  countdownKeyword: $('countdown-keyword'),
  confetti: $('confetti'),
  thread: $('thread'),
  threadWait: $('thread-wait'),
  wAvatar: $('w-avatar'),
  wName: $('w-name'),
  wHandle: $('w-handle'),
  btnDraw: $('btn-draw'),
  drawLabel: document.querySelector('.launch-btn__label'),
  drawHint: $('draw-hint'),
  btnRedraw: $('btn-redraw'),
  btnProfile: $('btn-profile'),
  btnBack: $('btn-back'),
  countdown: $('countdown'),
  countdownNum: $('countdown-num'),
  countdownFill: $('countdown-fill'),
  btnCancel: $('btn-cancel'),
  startMode: $('start-mode'),
  accountPill: $('account-pill'),
  accountName: $('account-name'),
  accountForm: $('account-form'),
  accountInput: $('account-input'),
  accountCancel: $('account-cancel'),
  conn: $('conn-badge'),
  connText: $('conn-text'),
  recentList: $('recent-list'),
  drawer: $('events-drawer'),
  eventsList: $('events-list'),
  eventsFilters: $('events-filters'),
  modal: $('settings-modal'),
  screensModal: $('screens-modal'),
  toast: $('toast'),
};

let socket = null;
let participants = [];
let drawing = false;
let pendingParticipants = null;
let joinOpen = true;
let round = { active: false, total: 0, remaining: 0 };

let config = {
  username: '',
  keyword: 'بلعب',
  matchMode: 'contains',
  excludeWinners: true,
  maxParticipants: 100,
  countdownSeconds: 30,
  autoDraw: true,
  joinDuringRoundOnly: false,
  stopWhenFull: true,
  sound: { enabled: true, volume: 0.6 },
};

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const arabicNumber = (n) => Number(n).toLocaleString('ar-EG');

/* ═══════════ أدوات ═══════════ */

let toastTimer = null;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3200);
}

function initials(name) {
  const clean = String(name || '').trim();
  return clean ? [...clean][0] : '؟';
}

function paintAvatar(node, person) {
  node.replaceChildren();
  if (person.avatar) {
    const img = document.createElement('img');
    img.src = person.avatar;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => { node.textContent = initials(person.name); });
    node.appendChild(img);
  } else {
    node.textContent = initials(person.name);
  }
}

/* ═══════════ التذاكر ═══════════ */

function stubNode(p) {
  const node = document.createElement('article');
  node.className = 'stub';
  node.dataset.id = p.id;
  node.innerHTML = `
    <span class="stub__perf"></span>
    <span class="stub__no"></span>
    <span class="stub__avatar"></span>
    <div class="stub__meta">
      <div class="stub__name"></div>
      <div class="stub__handle"></div>
    </div>
    <span class="stub__stamp">فائز</span>`;

  node.querySelector('.stub__no').textContent = String(p.order).padStart(3, '0');
  node.querySelector('.stub__name').textContent = p.name;
  node.querySelector('.stub__handle').textContent = p.handle ? `@${p.handle}` : '';
  paintAvatar(node.querySelector('.stub__avatar'), p);
  return node;
}

function renderAll() {
  el.tickets.replaceChildren(...participants.map(stubNode));
  refreshCounter();
}

function addStub(p) {
  participants.push(p);
  el.tickets.prepend(stubNode(p));
  refreshCounter();
  joinTone();
}

function refreshCounter() {
  const total = participants.length;
  el.count.textContent = arabicNumber(total);
  el.countCap.textContent = `من ${arabicNumber(config.maxParticipants)}`;
  el.tallyFill.style.width = `${Math.min((total / config.maxParticipants) * 100, 100)}%`;
  el.count.classList.toggle('is-full', total >= config.maxParticipants);
  el.empty.classList.toggle('is-hidden', total > 0);
  updateHint();
  updateDrawButton();
}

function updateHint() {
  const closed = !joinOpen
    || participants.length >= config.maxParticipants
    || (config.joinDuringRoundOnly && !round.active);
  el.hintClosed.classList.toggle('is-hidden', !closed);
  document.body.classList.toggle('join-closed', closed);
}

function updateDrawButton() {
  const busy = drawing || round.active;
  const instant = config.startMode === 'instant' || config.countdownSeconds === 0;

  el.btnDraw.disabled = busy || participants.length === 0;
  el.drawLabel.textContent = round.active ? 'جارٍ العد' : 'ابدأ';
  el.drawHint.textContent = instant
    ? 'يسحب الفائز فور الضغط'
    : `عدّ تنازلي ${arabicNumber(config.countdownSeconds)} ثانية ثم يُسحب الفائز`;

  el.startMode.querySelectorAll('[data-mode]').forEach((button) => {
    button.classList.toggle('is-on', button.dataset.mode === config.startMode);
  });
}

/* ═══════════ آخر الفائزين ═══════════ */

function renderRecent(history) {
  const list = (history || []).slice(0, 4);
  el.recentList.replaceChildren();

  if (list.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'recent__item recent__item--empty';
    empty.textContent = 'لم يُسحب أحد بعد';
    el.recentList.appendChild(empty);
    return;
  }

  list.forEach((person, index) => {
    const item = document.createElement('li');
    item.className = 'recent__item';
    item.innerHTML = '<span class="recent__rank"></span><span class="recent__name"></span><span class="recent__handle"></span>';
    item.querySelector('.recent__rank').textContent = String(index + 1).padStart(2, '0');
    item.querySelector('.recent__name').textContent = person.name;
    item.querySelector('.recent__handle').textContent = person.handle ? `@${person.handle}` : '';
    el.recentList.appendChild(item);
  });
}

/* ═══════════ الصوت ═══════════ */

let audioCtx = null;
function tone(freq, duration, type = 'sine', gain = 0.05) {
  if (!config.sound.enabled) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const amp = audioCtx.createGain();
    const level = gain * (config.sound.volume ?? 0.6);
    osc.type = type;
    osc.frequency.value = freq;
    amp.gain.setValueAtTime(Math.max(level, 0.0001), audioCtx.currentTime);
    amp.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
    osc.connect(amp).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch (_) { /* الصوت غير متاح */ }
}

const tick = () => tone(880, 0.045, 'square', 0.05);
const joinTone = () => tone(660, 0.09, 'triangle', 0.045);
const beep = (high) => tone(high ? 1200 : 620, 0.12, 'square', 0.06);

function fanfare() {
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
    setTimeout(() => tone(f, 0.5, 'triangle', 0.12), i * 110));
}

/* ═══════════ قصاصات ورق ═══════════ */

function shreds() {
  if (reduceMotion) return;
  const colors = ['#F59E0B', '#FCD34D', '#EA580C', '#F5F5F5', '#B45309'];
  const pieces = document.createDocumentFragment();
  for (let i = 0; i < 70; i += 1) {
    const bit = document.createElement('i');
    bit.style.left = `${Math.random() * 100}%`;
    bit.style.background = colors[i % colors.length];
    bit.style.animationDuration = `${2.4 + Math.random() * 1.8}s`;
    bit.style.animationDelay = `${Math.random() * 0.6}s`;
    bit.style.height = `${9 + Math.random() * 12}px`;
    bit.style.opacity = 0.55 + Math.random() * 0.45;
    pieces.appendChild(bit);
  }
  el.confetti.replaceChildren(pieces);
  setTimeout(() => el.confetti.replaceChildren(), 4800);
}

/* ═══════════ العد التنازلي ═══════════ */

function showCountdown(data) {
  round = { ...data, active: true };
  el.countdown.classList.remove('is-hidden');
  paintCountdown();
  updateDrawButton();
  updateHint();
}

function paintCountdown() {
  el.countdownNum.textContent = arabicNumber(Math.max(round.remaining, 0));
  const pct = round.total ? (round.remaining / round.total) * 100 : 0;
  el.countdownFill.style.width = `${Math.max(pct, 0)}%`;
  el.countdown.classList.toggle('is-urgent', round.remaining <= 5);
}

function hideCountdown() {
  round = { active: false, total: round.total, remaining: 0 };
  el.countdown.classList.add('is-hidden');
  el.countdown.classList.remove('is-urgent');
  updateDrawButton();
  updateHint();
}

/* ═══════════ حركة السحب ═══════════ */

function runDraw(winner) {
  const nodes = [...el.tickets.querySelectorAll('.stub')];
  const target = nodes.find((n) => n.dataset.id === winner.id);

  if (reduceMotion || nodes.length < 2 || !target) {
    finishDraw(winner, target);
    return;
  }

  el.btnDraw.classList.add('is-drawing');
  const totalSteps = Math.max(18, Math.min(nodes.length * 2, 34));
  const startIndex = Math.floor(Math.random() * nodes.length);
  let step = 0;
  let prevNode = null;

  const hop = () => {
    const remaining = totalSteps - step;
    const node = remaining <= 1 ? target : nodes[(startIndex + step) % nodes.length];
    if (prevNode && prevNode !== node) prevNode.classList.remove('is-spot');
    node.classList.add('is-spot');
    if (remaining % 4 === 0) node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    prevNode = node;
    tick();
    step += 1;

    if (step > totalSteps) {
      if (prevNode) prevNode.classList.remove('is-spot');
      finishDraw(winner, target);
      return;
    }
    const progress = step / totalSteps;
    setTimeout(hop, 55 + progress * progress * 320);
  };

  hop();
}

function finishDraw(winner, target) {
  el.btnDraw.classList.remove('is-drawing');
  fanfare();

  if (target) {
    target.classList.add('is-spot', 'is-torn');
    setTimeout(() => showWinner(winner), reduceMotion ? 0 : 620);
  } else {
    showWinner(winner);
  }
}

function showWinner(winner) {
  drawing = false;
  if (pendingParticipants) {
    participants = pendingParticipants;
    pendingParticipants = null;
    renderAll();
  }
  el.wName.textContent = winner.name;
  el.wHandle.textContent = winner.handle ? `@${winner.handle}` : '';
  paintAvatar(el.wAvatar, winner);
  if (winner.handle) {
    // فتح صفحة حساب الفائز على تيك توك؛ من هناك تقدر تضغط "رسالة" داخل تطبيقك
    el.btnProfile.href = `https://www.tiktok.com/@${encodeURIComponent(winner.handle)}`;
    el.btnProfile.classList.remove('is-hidden');
  } else {
    el.btnProfile.removeAttribute('href');
    el.btnProfile.classList.add('is-hidden');
  }
  el.thread.replaceChildren();
  el.threadWait.classList.remove('is-hidden');
  el.stageMain.hidden = true;
  el.stageWinner.hidden = false;
  shreds();
}

function showList() {
  el.stageWinner.hidden = true;
  el.stageMain.hidden = false;
  el.confetti.replaceChildren();
  refreshCounter();
}

/* ═══════════ رسائل الفائز ═══════════ */

function addBubble(message) {
  el.threadWait.classList.add('is-hidden');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = message.text;
  const time = document.createElement('span');
  time.className = 'bubble__time';
  time.textContent = new Date(message.at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
  bubble.appendChild(time);
  el.thread.appendChild(bubble);
  el.thread.scrollTop = el.thread.scrollHeight;
  while (el.thread.childElementCount > 200) el.thread.firstElementChild.remove();
}

/* ═══════════ الاتصال ═══════════ */

function updateConn(status, statusDetail) {
  if (el.connText) el.connText.textContent = statusDetail || '—';
  if (!el.conn) return;
  el.conn.classList.remove('is-connecting', 'is-connected', 'is-error', 'is-disconnected');
  el.conn.classList.add(`is-${status || 'disconnected'}`);
}

/* ═══════════ الحساب ═══════════ */

/* آخر حساب ربطه صاحب هذه الغرفة — يُحفظ في المتصفح أيضًا حتى يرجع
   تلقائيًا لو أُعيد تشغيل الخادم أو فُقدت إعدادات الغرفة */
const ACCOUNT_KEY = `draw:account:${ROOM}`;
let accountRestored = false;

function rememberAccount(username) {
  if (!username) return;
  try { localStorage.setItem(ACCOUNT_KEY, username); } catch (_) { /* التخزين غير متاح */ }
  document.cookie = `draw_account_${ROOM}=${encodeURIComponent(username)}; path=/; max-age=34560000; samesite=lax`;
}

function lastAccount() {
  let saved = '';
  try { saved = localStorage.getItem(ACCOUNT_KEY) || ''; } catch (_) { saved = ''; }
  if (!saved) {
    const hit = document.cookie.split('; ').find((c) => c.startsWith(`draw_account_${ROOM}=`));
    if (hit) saved = decodeURIComponent(hit.split('=').slice(1).join('='));
  }
  return String(saved || '').trim().replace(/^@/, '').slice(0, 40);
}

/* يُنادى مع أول حالة تصل من الخادم: إن كانت الغرفة بلا حساب واستعدنا
   حسابًا محفوظًا، نعيد ربطه تلقائيًا مرة واحدة فقط */
function restoreAccount() {
  if (accountRestored) return;
  accountRestored = true;
  if (config.username) { rememberAccount(config.username); return; }
  const saved = lastAccount();
  if (!saved) return;
  socket.emit('account:set', { username: saved });
  toast(`جارٍ إعادة الربط بآخر حساب: @${saved}`);
}

function paintAccount() {
  el.accountName.textContent = config.username ? `@${config.username}` : 'أضف حسابك';
  el.accountPill.classList.toggle('is-empty', !config.username);
  if (config.username) rememberAccount(config.username);
}

function openAccountEditor() {
  el.accountInput.value = config.username || lastAccount() || '';
  el.accountPill.classList.add('is-hidden');
  el.accountForm.classList.remove('is-hidden');
  el.accountInput.focus();
  el.accountInput.select();
}

function closeAccountEditor() {
  el.accountForm.classList.add('is-hidden');
  el.accountPill.classList.remove('is-hidden');
}

el.accountPill.addEventListener('click', openAccountEditor);
el.accountCancel.addEventListener('click', closeAccountEditor);
el.accountForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const username = el.accountInput.value.trim().replace(/^@/, '');
  if (!username) { toast('اكتب اسم الحساب أولًا'); return; }
  rememberAccount(username);
  socket.emit('account:set', { username });
  closeAccountEditor();
  toast(`جارٍ الربط بـ @${username}…`);
});

/* ═══════════ الإعدادات ═══════════ */

const setFields = {
  keyword: $('set-keyword'),
  match: $('set-match'),
  max: $('set-max'),
  countdown: $('set-countdown'),
  autodraw: $('set-autodraw'),
  roundonly: $('set-roundonly'),
  stopfull: $('set-stopfull'),
  exclude: $('set-exclude'),
  sound: $('set-sound'),
  volume: $('set-volume'),
};

function paintSettings() {
  setFields.keyword.value = config.keyword;
  setFields.match.value = config.matchMode;
  setFields.max.value = config.maxParticipants;
  setFields.countdown.value = config.countdownSeconds;
  setFields.autodraw.checked = config.autoDraw;
  setFields.roundonly.checked = config.joinDuringRoundOnly;
  setFields.stopfull.checked = config.stopWhenFull;
  setFields.exclude.checked = config.excludeWinners;
  setFields.sound.checked = config.sound.enabled;
  setFields.volume.value = config.sound.volume;
}

function applyConfig(next) {
  config = { ...config, ...next, sound: { ...config.sound, ...(next.sound || {}) } };
  if (next.overlay) {
    overlayConfig = { players: { ...next.overlay.players }, events: { ...next.overlay.events } };
    paintScreens();
  }
  el.hintKeyword.textContent = config.keyword;
  el.emptyKeyword.textContent = config.keyword;
  el.countdownKeyword.textContent = config.keyword;
  paintAccount();
  paintSettings();
  refreshCounter();
}

function openSettings() { el.modal.hidden = false; paintSettings(); }
function closeSettings() { el.modal.hidden = true; }

$('btn-settings').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', closeSettings);
$('settings-backdrop').addEventListener('click', closeSettings);

$('settings-save').addEventListener('click', () => {
  socket.emit('settings:set', {
    keyword: setFields.keyword.value,
    matchMode: setFields.match.value,
    maxParticipants: setFields.max.value,
    countdownSeconds: setFields.countdown.value,
    autoDraw: setFields.autodraw.checked,
    joinDuringRoundOnly: setFields.roundonly.checked,
    stopWhenFull: setFields.stopfull.checked,
    excludeWinners: setFields.exclude.checked,
    sound: { enabled: setFields.sound.checked, volume: Number(setFields.volume.value) },
  });
  closeSettings();
  toast('تم حفظ الإعدادات');
});

setFields.volume.addEventListener('input', () => {
  config.sound.volume = Number(setFields.volume.value);
  if (setFields.sound.checked) beep(true);
});

$('btn-clear-list').addEventListener('click', () => socket.emit('clear'));
$('btn-clear-list-quick').addEventListener('click', () => {
  if (confirm('مسح كل قائمة المشاركين الحالية؟ ما ينرجّعون إلا يكتبون كلمة الدخول من جديد.')) {
    socket.emit('clear');
  }
});
$('btn-clear-history').addEventListener('click', () => socket.emit('history:clear'));
$('btn-demo').addEventListener('click', () => socket.emit('demo', { count: 12 }));
$('btn-demo-heavy').addEventListener('click', () => socket.emit('demo', { count: 50 }));

/* ═══════════ ضبط شاشات البث ═══════════ */

let overlayConfig = { players: {}, events: {} };

function paintScreens() {
  document.querySelectorAll('.sheet[data-screen]').forEach((sheet) => {
    const values = overlayConfig[sheet.dataset.screen] || {};

    sheet.querySelectorAll('.seg[data-key]').forEach((group) => {
      const current = String(values[group.dataset.key]);
      group.querySelectorAll('[data-value]').forEach((button) => {
        button.classList.toggle('is-on', button.dataset.value === current);
      });
    });

    sheet.querySelectorAll('input[data-key]').forEach((input) => {
      const value = values[input.dataset.key];
      if (value === undefined) return;
      if (input.type === 'checkbox') {
        input.checked = Boolean(value);
      } else {
        input.value = value;
        const view = input.parentElement.querySelector('.range-view');
        if (view) view.textContent = arabicNumber(value);
      }
    });
  });
}

function sendOverlay(screen, key, value) {
  overlayConfig[screen] = { ...overlayConfig[screen], [key]: value };
  paintScreens();
  socket.emit('overlay:set', { screen, patch: { [key]: value } });
}

document.querySelectorAll('.sheet[data-screen]').forEach((sheet) => {
  const screen = sheet.dataset.screen;

  sheet.querySelectorAll('.seg[data-key]').forEach((group) => {
    group.addEventListener('click', (e) => {
      const button = e.target.closest('[data-value]');
      if (!button) return;
      sendOverlay(screen, group.dataset.key, button.dataset.value);
    });
  });

  sheet.querySelectorAll('input[data-key]').forEach((input) => {
    const event = input.type === 'checkbox' ? 'change' : 'input';
    input.addEventListener(event, () => {
      const value = input.type === 'checkbox' ? input.checked : Number(input.value);
      sendOverlay(screen, input.dataset.key, value);
    });
  });
});

function currentScreenPage() {
  const active = document.querySelector('.sheet[data-screen]:not(.is-hidden)');
  return active && active.dataset.screen === 'events' ? 'green.html' : 'players.html';
}

function paintScreenLink() {
  const url = screenUrl(currentScreenPage());
  $('screen-link').value = url;
  $('screens-open').setAttribute('href', url);
  const code = $('room-code');
  if (code && code.value !== ROOM) code.value = ROOM;
}

function showSheet(name) {
  document.querySelectorAll('.sheet[data-screen]').forEach((sheet) => {
    sheet.classList.toggle('is-hidden', sheet.dataset.screen !== name);
  });
  document.querySelectorAll('#screens-tabs [data-tab]').forEach((tab) => {
    tab.classList.toggle('is-on', tab.dataset.tab === name);
  });
  paintScreenLink();
}

const roomCodeInput = $('room-code');
if (roomCodeInput) {
  roomCodeInput.value = ROOM;
  $('room-code-copy').addEventListener('click', () => {
    navigator.clipboard?.writeText(ROOM).then(() => toast('انتسخ رمز شاشتك'), () => toast(ROOM));
  });
  $('room-code-apply').addEventListener('click', () => switchRoom(roomCodeInput.value));
  roomCodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') switchRoom(roomCodeInput.value); });
}

$('screens-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) showSheet(tab.dataset.tab);
});

$('btn-screens').addEventListener('click', () => {
  el.screensModal.hidden = false;
  paintScreens();
  paintScreenLink();
});

$('screen-copy').addEventListener('click', async () => {
  const input = $('screen-link');
  input.select();
  try {
    await navigator.clipboard.writeText(input.value);
    toast('تم نسخ الرابط');
  } catch (_) {
    document.execCommand('copy');
    toast('تم نسخ الرابط');
  }
});
$('screens-close').addEventListener('click', () => { el.screensModal.hidden = true; });
$('screens-backdrop').addEventListener('click', () => { el.screensModal.hidden = true; });

/* ═══════════ سجل الأحداث ═══════════ */

const EVENT_TAG = {
  join: 'انضمام',
  winner: 'فوز',
  round: 'جولة',
  connection: 'اتصال',
  system: 'نظام',
  error: 'خطأ',
};

let eventFilter = 'all';

function eventNode(event) {
  const row = document.createElement('div');
  row.className = `event event--${event.type}`;
  row.dataset.type = event.type;
  row.innerHTML = `
    <span class="event__tag"></span>
    <span class="event__text"></span>
    <time class="event__time"></time>`;
  row.querySelector('.event__tag').textContent = EVENT_TAG[event.type] || '—';
  row.querySelector('.event__text').textContent = event.text;
  row.querySelector('.event__time').textContent =
    new Date(event.at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  row.hidden = eventFilter !== 'all' && eventFilter !== event.type;
  return row;
}

function addEvent(event) {
  el.eventsList.prepend(eventNode(event));
  while (el.eventsList.childElementCount > 200) el.eventsList.lastElementChild.remove();
}

function renderEvents(list) {
  el.eventsList.replaceChildren(...[...list].reverse().map(eventNode));
}

el.eventsFilters.addEventListener('click', (e) => {
  const button = e.target.closest('[data-filter]');
  if (!button) return;
  eventFilter = button.dataset.filter;
  [...el.eventsFilters.children].forEach((b) => b.classList.toggle('is-on', b === button));
  [...el.eventsList.children].forEach((row) => {
    row.hidden = eventFilter !== 'all' && eventFilter !== row.dataset.type;
  });
});

$('btn-players').setAttribute('href', screenUrl('players.html'));
$('btn-green').setAttribute('href', screenUrl('green.html'));
$('csv-link').setAttribute('href', `/api/participants.csv?room=${ROOM}`);

$('btn-events').addEventListener('click', () => { el.drawer.hidden = !el.drawer.hidden; });
$('btn-events-close').addEventListener('click', () => { el.drawer.hidden = true; });
$('btn-events-clear').addEventListener('click', () => socket.emit('events:clear'));

/* ═══════════ السيرفر ═══════════ */

function initializeSocket() {
  socket = io({ query: { room: ROOM } });

  socket.on('connect', () => updateConn('connecting', 'جارٍ قراءة الحالة…'));
  socket.on('connect_error', () => updateConn('error', 'السيرفر غير متاح'));

  socket.on('state', (s) => {
    applyConfig(s.config || {});
    restoreAccount();
    participants = s.participants || [];
    joinOpen = s.joinOpen !== false;
    renderAll();
    updateConn(s.status, s.statusDetail);
    renderEvents(s.events || []);
    renderRecent(s.history || []);

    if (s.round && s.round.active) showCountdown(s.round); else hideCountdown();

    if (s.winner) {
      showWinner(s.winner);
      (s.winnerMessages || []).forEach(addBubble);
    } else {
      showList();
    }
  });

  socket.on('status', (s) => {
    if (s.username !== undefined) { config.username = s.username; paintAccount(); }
    updateConn(s.status, s.statusDetail);
  });

  socket.on('settings', (next) => applyConfig(next));

  socket.on('participant:add', (p) => {
    if (drawing) return;
    if (participants.some((x) => x.id === p.id)) return;
    addStub(p);
  });

  socket.on('participants:clear', () => {
    participants = [];
    joinOpen = true;
    renderAll();
  });

  socket.on('join:closed', () => { joinOpen = false; updateHint(); });

  socket.on('round:start', (r) => { showCountdown(r); beep(false); });
  socket.on('round:tick', (r) => {
    round = { ...r, active: true };
    paintCountdown();
    if (r.remaining <= 5) beep(true);
  });
  socket.on('round:end', hideCountdown);

  socket.on('winner', ({ winner, participants: list, history }) => {
    drawing = true;
    pendingParticipants = list;
    renderRecent(history || []);
    runDraw(winner);
  });

  socket.on('draw:empty', () => {
    drawing = false;
    refreshCounter();
    toast('لا يوجد مشاركون للسحب');
  });

  socket.on('winner:clear', showList);
  socket.on('winner:message', addBubble);

  socket.on('overlay', ({ screen, settings }) => {
    overlayConfig[screen] = settings;
    paintScreens();
  });

  socket.on('event', addEvent);
  socket.on('events:clear', () => el.eventsList.replaceChildren());
  socket.on('history:clear', () => { renderRecent([]); toast('تم مسح سجل الفائزين'); });
}

/* ═══════════ التفاعل ═══════════ */

function requestStart() {
  if (drawing || round.active) return;
  if (participants.length === 0) { toast('لا يوجد مشاركون بعد'); return; }
  beep(false);
  el.btnDraw.disabled = true;
  socket.emit('round:start');
}

el.btnDraw.addEventListener('click', requestStart);
el.btnCancel.addEventListener('click', () => socket.emit('round:cancel'));

el.startMode.addEventListener('click', (e) => {
  const button = e.target.closest('[data-mode]');
  if (!button) return;
  socket.emit('settings:set', { startMode: button.dataset.mode });
  toast(button.dataset.mode === 'instant' ? 'زر ابدأ يسحب فورًا' : 'زر ابدأ يبدأ العد التنازلي');
});

el.btnRedraw.addEventListener('click', () => {
  showList();
  setTimeout(requestStart, 220);
});

el.btnBack.addEventListener('click', () => {
  showList();
  socket.emit('back');
});

document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName);
  if (typing) {
    if (e.key === 'Escape') closeAccountEditor();
    return;
  }
  if (e.code === 'Space') { e.preventDefault(); if (!el.btnDraw.disabled) requestStart(); }
  if (e.key === 'Escape') {
    if (!el.screensModal.hidden) { el.screensModal.hidden = true; return; }
    if (!el.modal.hidden) { closeSettings(); return; }
    if (!el.drawer.hidden) { el.drawer.hidden = true; return; }
    if (!el.stageWinner.hidden) { showList(); socket.emit('back'); }
  }
});

applyConfig(config);
renderRecent([]);
initializeSocket();
