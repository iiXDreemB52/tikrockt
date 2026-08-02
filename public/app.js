'use strict';

const $ = (id) => document.getElementById(id);

const el = {
  stageMain: $('stage-main'),
  stageWinner: $('stage-winner'),
  count: $('count'),
  countCap: $('count-cap'),
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
  drawHint: $('draw-hint'),
  btnRedraw: $('btn-redraw'),
  btnBack: $('btn-back'),
  countdown: $('countdown'),
  countdownNum: $('countdown-num'),
  countdownFill: $('countdown-fill'),
  btnCancel: $('btn-cancel'),
  accountPill: $('account-pill'),
  accountName: $('account-name'),
  accountForm: $('account-form'),
  accountInput: $('account-input'),
  accountCancel: $('account-cancel'),
  connBadge: $('conn-badge'),
  connText: $('conn-text'),
  drawer: $('events-drawer'),
  eventsList: $('events-list'),
  eventsFilters: $('events-filters'),
  modal: $('settings-modal'),
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

/* ═══════════ أدوات صغيرة ═══════════ */

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

function avatarMarkup(p) {
  if (!p.avatar) return initials(p.name);
  return `<img src="${p.avatar}" alt="" referrerpolicy="no-referrer" loading="lazy"
            onerror="this.replaceWith(document.createTextNode('${initials(p.name).replace(/'/g, '')}'))">`;
}

/* ═══════════ التذاكر ═══════════ */

function ticketNode(p) {
  const node = document.createElement('article');
  node.className = 'ticket';
  node.dataset.id = p.id;
  node.innerHTML = `
    <span class="avatar">${avatarMarkup(p)}</span>
    <div class="ticket__meta">
      <div class="ticket__name"></div>
      <div class="ticket__handle"></div>
    </div>
    <span class="ticket__serial">${String(p.order).padStart(3, '0')}</span>`;
  node.querySelector('.ticket__name').textContent = p.name;
  node.querySelector('.ticket__handle').textContent = p.handle ? `@${p.handle}` : '';
  return node;
}

function renderAll() {
  el.tickets.replaceChildren(...participants.map(ticketNode));
  refreshCounter();
}

function addTicket(p) {
  participants.push(p);
  el.tickets.prepend(ticketNode(p));
  refreshCounter();
  joinTone();
}

function refreshCounter() {
  el.count.textContent = arabicNumber(participants.length);
  el.countCap.textContent = `الحد الأقصى ${arabicNumber(config.maxParticipants)}`;
  const full = participants.length >= config.maxParticipants;
  el.count.classList.toggle('is-full', full);
  el.empty.classList.toggle('is-hidden', participants.length > 0);
  updateHint();
  updateDrawButton();
}

function updateHint() {
  const closed = !joinOpen || participants.length >= config.maxParticipants
    || (config.joinDuringRoundOnly && !round.active);
  el.hintClosed.classList.toggle('is-hidden', !closed);
  document.body.classList.toggle('join-closed', closed);
}

function updateDrawButton() {
  const busy = drawing || round.active;
  el.btnDraw.disabled = busy || participants.length === 0;
  el.btnDraw.querySelector('.draw-btn__text').textContent = round.active ? '⏳ جارٍ العد' : '🚀 ابدأ';
  el.drawHint.textContent = config.countdownSeconds > 0
    ? `عدّ تنازلي ${arabicNumber(config.countdownSeconds)} ثانية ثم يختار الفائز`
    : 'سحب فوري بدون عد تنازلي';
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

/* ═══════════ القصاصات ═══════════ */

function confetti() {
  if (reduceMotion) return;
  const colors = ['#33e1ff', '#7c5cff', '#ffd166', '#ff6a3d', '#eaf1ff'];
  const pieces = document.createDocumentFragment();
  for (let i = 0; i < 80; i += 1) {
    const bit = document.createElement('i');
    bit.style.left = `${Math.random() * 100}%`;
    bit.style.background = colors[i % colors.length];
    bit.style.animationDuration = `${2.2 + Math.random() * 1.8}s`;
    bit.style.animationDelay = `${Math.random() * 0.5}s`;
    bit.style.transform = `rotate(${Math.random() * 360}deg)`;
    if (i % 3 === 0) bit.style.borderRadius = '50%';
    pieces.appendChild(bit);
  }
  el.confetti.replaceChildren(pieces);
  setTimeout(() => el.confetti.replaceChildren(), 4600);
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
  const nodes = [...el.tickets.querySelectorAll('.ticket')];
  const target = nodes.find((n) => n.dataset.id === winner.id);

  if (reduceMotion || nodes.length < 2 || !target) {
    finishDraw(winner, target);
    return;
  }

  el.btnDraw.classList.add('is-drawing');
  const totalSteps = Math.max(18, Math.min(nodes.length * 2, 34));
  const startIndex = Math.floor(Math.random() * nodes.length);
  let step = 0;

  const hop = () => {
    nodes.forEach((n) => n.classList.remove('is-spot'));
    const remaining = totalSteps - step;
    const node = remaining <= 1 ? target : nodes[(startIndex + step) % nodes.length];
    node.classList.add('is-spot');
    node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    tick();
    step += 1;

    if (step > totalSteps) {
      nodes.forEach((n) => n.classList.remove('is-spot'));
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
    setTimeout(() => showWinner(winner), reduceMotion ? 0 : 520);
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
  el.wAvatar.innerHTML = avatarMarkup(winner);
  el.thread.replaceChildren();
  el.threadWait.classList.remove('is-hidden');
  el.stageMain.hidden = true;
  el.stageWinner.hidden = false;
  confetti();
}

function showList() {
  el.stageWinner.hidden = true;
  el.stageMain.hidden = false;
  el.confetti.replaceChildren();
  refreshCounter();
}

/* ═══════════ محادثة الفائز ═══════════ */

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
  if (!el.connBadge) return;
  el.connBadge.classList.remove('is-connecting', 'is-connected', 'is-error', 'is-disconnected');
  el.connBadge.classList.add(`is-${status || 'disconnected'}`);
}

/* ═══════════ الحساب ═══════════ */

function paintAccount() {
  el.accountName.textContent = config.username ? `@${config.username}` : 'أضف حسابك';
  el.accountPill.classList.toggle('is-empty', !config.username);
}

function openAccountEditor() {
  el.accountInput.value = config.username || '';
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
  if (!username) { toast('اكتب اسم الحساب أول'); return; }
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
  $('settings-note').textContent = 'تم الحفظ ✓';
  setTimeout(() => { $('settings-note').textContent = ''; }, 2000);
});

setFields.volume.addEventListener('input', () => {
  config.sound.volume = Number(setFields.volume.value);
  if (setFields.sound.checked) beep(true);
});

$('btn-clear-list').addEventListener('click', () => socket.emit('clear'));
$('btn-clear-history').addEventListener('click', () => socket.emit('history:clear'));
$('btn-demo').addEventListener('click', () => socket.emit('demo', { count: 12 }));

/* ═══════════ سجل الأحداث ═══════════ */

const EVENT_ICON = {
  join: '👤',
  winner: '🏆',
  round: '⏱️',
  connection: '📡',
  system: 'ℹ️',
  error: '⚠️',
};

let eventFilter = 'all';

function eventNode(event) {
  const row = document.createElement('div');
  row.className = `event event--${event.type}`;
  row.dataset.type = event.type;
  row.innerHTML = `
    <span class="event__icon">${EVENT_ICON[event.type] || '·'}</span>
    <span class="event__text"></span>
    <time class="event__time"></time>`;
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

$('btn-events').addEventListener('click', () => { el.drawer.hidden = !el.drawer.hidden; });
$('btn-events-close').addEventListener('click', () => { el.drawer.hidden = true; });
$('btn-events-clear').addEventListener('click', () => socket.emit('events:clear'));

/* ═══════════ الاتصال بالسيرفر ═══════════ */

function initializeSocket() {
  socket = io();

  socket.on('connect', () => updateConn('connecting', 'جارٍ قراءة الحالة…'));

  socket.on('connect_error', () => updateConn('error', 'السيرفر غير متاح'));

  socket.on('state', (s) => {
    applyConfig(s.config || {});
    participants = s.participants || [];
    joinOpen = s.joinOpen !== false;
    renderAll();
    updateConn(s.status, s.statusDetail);
    renderEvents(s.events || []);

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

  socket.on('settings', (next) => { applyConfig(next); });

  socket.on('participant:add', (p) => {
    if (drawing) return;
    if (participants.some((x) => x.id === p.id)) return;
    addTicket(p);
  });

  socket.on('participants:clear', () => {
    participants = [];
    joinOpen = true;
    renderAll();
  });

  socket.on('join:closed', () => { joinOpen = false; updateHint(); });

  socket.on('round:start', (r) => { showCountdown(r); beep(false); });
  socket.on('round:tick', (r) => { round = { ...r, active: true }; paintCountdown(); if (r.remaining <= 5) beep(true); });
  socket.on('round:end', () => hideCountdown());

  socket.on('winner', ({ winner, participants: list }) => {
    drawing = true;
    pendingParticipants = list;
    runDraw(winner);
  });

  socket.on('draw:empty', () => {
    drawing = false;
    refreshCounter();
    toast('ما فيه مشاركين للسحب');
  });

  socket.on('winner:clear', showList);
  socket.on('winner:message', addBubble);

  socket.on('event', addEvent);
  socket.on('events:clear', () => el.eventsList.replaceChildren());
  socket.on('history:clear', () => toast('تم مسح سجل الفائزين'));
}

/* ═══════════ تفاعل المستخدم ═══════════ */

function requestStart() {
  if (drawing || round.active) return;
  if (participants.length === 0) { toast('ما فيه مشاركين بعد'); return; }
  beep(false);
  el.btnDraw.disabled = true;
  socket.emit('round:start');
}

el.btnDraw.addEventListener('click', requestStart);
el.btnCancel.addEventListener('click', () => socket.emit('round:cancel'));

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
    if (!el.modal.hidden) { closeSettings(); return; }
    if (!el.drawer.hidden) { el.drawer.hidden = true; return; }
    if (!el.stageWinner.hidden) { showList(); socket.emit('back'); }
  }
});

applyConfig(config);
initializeSocket();
