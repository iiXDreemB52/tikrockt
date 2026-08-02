'use strict';

let socket = null;
let socketStarted = false;
const $ = (id) => document.getElementById(id);

const el = {
  stageMain: $('stage-main'),
  stageWinner: $('stage-winner'),
  count: $('count'),
  tickets: $('tickets'),
  empty: $('empty'),
  confetti: $('confetti'),
  thread: $('thread'),
  threadWait: $('thread-wait'),
  wAvatar: $('w-avatar'),
  wName: $('w-name'),
  wHandle: $('w-handle'),
  btnDraw: $('btn-draw'),
  btnRedraw: $('btn-redraw'),
  btnBack: $('btn-back'),
};


function setAppEnabled(enabled) {
  el.btnDraw.disabled = !enabled || participants.length === 0 || drawing;
  el.btnRedraw.disabled = !enabled;
  el.btnBack.disabled = !enabled;
}

let participants = [];
let drawing = false;
let pendingParticipants = null;
let soundOn = true; /* لا توجد لوحة تحكم بعد الآن؛ المؤثر الصوتي مفعّل افتراضيًا */

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const arabicNumber = (n) => Number(n).toLocaleString('ar-EG');

/* ═══════════ العرض ═══════════ */

function initials(name) {
  const clean = String(name || '').trim();
  return clean ? [...clean][0] : '؟';
}

function avatarMarkup(p) {
  if (!p.avatar) return initials(p.name);
  return `<img src="${p.avatar}" alt="" referrerpolicy="no-referrer" loading="lazy"
            onerror="this.replaceWith(document.createTextNode('${initials(p.name).replace(/'/g, '')}'))">`;
}

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
}

function refreshCounter() {
  el.count.textContent = arabicNumber(participants.length);
  el.empty.classList.toggle('is-hidden', participants.length > 0);
  el.btnDraw.disabled = participants.length === 0 || drawing;
}

/* ═══════════ الصوت ═══════════ */

let audioCtx = null;
function tone(freq, duration, type = 'sine', gain = 0.05) {
  if (!soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const amp = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    amp.gain.setValueAtTime(gain, audioCtx.currentTime);
    amp.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
    osc.connect(amp).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch (_) { /* الصوت غير متاح */ }
}

const tick = () => tone(880, 0.045, 'square', 0.028);
function fanfare() {
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => setTimeout(() => tone(f, 0.5, 'triangle', 0.07), i * 110));
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

/* ═══════════ حالة الاتصال ═══════════ */

const connBadge = $('conn-badge');
const connText = $('conn-text');

function updateConn(status, statusDetail) {
  if (connText) connText.textContent = statusDetail || '—';
  if (!connBadge) return;
  connBadge.classList.remove('is-connecting', 'is-connected', 'is-error', 'is-disconnected');
  connBadge.classList.add(`is-${status || 'disconnected'}`);
}

function initializeSocket() {
  if (socket) return;
  socket = io();

  socket.on('connect', () => {
    setAppEnabled(true);
    if (!socketStarted) {
      socketStarted = true;
      socket.emit('start', { username: '' });
    }
  });

  socket.on('connect_error', (err) => {
    console.error('WebSocket connection failed:', err);
  });

  socket.on('status', (s) => updateConn(s.status, s.statusDetail));

  socket.on('state', (s) => {
    participants = s.participants || [];
    renderAll();
    updateConn(s.status, s.statusDetail);

    if (s.winner) {
      showWinner(s.winner);
      (s.winnerMessages || []).forEach(addBubble);
    } else {
      showList();
    }
  });

  socket.on('participant:add', (p) => {
    if (drawing) return;
    if (participants.some((x) => x.id === p.id)) return;
    addTicket(p);
  });

  socket.on('participants:clear', () => {
    participants = [];
    renderAll();
  });

  socket.on('winner', ({ winner, participants: list }) => {
    pendingParticipants = list;
    runDraw(winner);
  });

  socket.on('draw:empty', () => {
    drawing = false;
    refreshCounter();
  });

  socket.on('winner:clear', showList);
  socket.on('winner:message', addBubble);
}

function initializeApp() {
  initializeSocket();
}

/* ═══════════ تفاعل المستخدم ═══════════ */

function requestDraw() {
  if (drawing) return;
  drawing = true;
  el.btnDraw.disabled = true;
  socket.emit('draw');
}

el.btnDraw.addEventListener('click', requestDraw);

el.btnRedraw.addEventListener('click', () => {
  showList();
  setTimeout(requestDraw, 220);
});

el.btnBack.addEventListener('click', () => {
  showList();
  socket.emit('back');
});

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); if (!el.btnDraw.disabled) requestDraw(); }
  if (e.key === 'Escape' && !el.stageWinner.hidden) {
    showList();
    if (socket) socket.emit('back');
  }
});

setAppEnabled(false);
initializeApp();
