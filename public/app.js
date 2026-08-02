'use strict';

const socket = io();
const $ = (id) => document.getElementById(id);

const el = {
  stageMain: $('stage-main'),
  stageWinner: $('stage-winner'),
  username: $('username'),
  accounts: $('accounts'),
  keyword: $('keyword'),
  emptyKeyword: $('empty-keyword'),
  exclude: $('exclude'),
  sound: $('sound'),
  status: $('status'),
  statusText: document.querySelector('.status__text'),
  count: $('count'),
  tickets: $('tickets'),
  empty: $('empty'),
  history: $('history'),
  log: $('log'),
  confetti: $('confetti'),
  thread: $('thread'),
  threadWait: $('thread-wait'),
  wAvatar: $('w-avatar'),
  wName: $('w-name'),
  wHandle: $('w-handle'),
  btnStart: $('btn-start'),
  btnCheck: $('btn-check'),
  btnStop: $('btn-stop'),
  btnClear: $('btn-clear'),
  btnDraw: $('btn-draw'),
  btnRedraw: $('btn-redraw'),
  btnBack: $('btn-back'),
  btnHistoryClear: $('btn-history-clear'),
};

let participants = [];
let drawing = false;
let pendingParticipants = null;

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

function renderHistory(list) {
  if (!list || list.length === 0) {
    el.history.innerHTML = '<li class="history__empty">لا فائزين بعد.</li>';
    return;
  }
  el.history.replaceChildren(...list.map((h, i) => {
    const li = document.createElement('li');
    const rank = document.createElement('span');
    rank.className = 'history__rank';
    rank.textContent = String(i + 1).padStart(2, '0');
    const name = document.createElement('span');
    name.textContent = h.name;
    li.append(rank, name);
    return li;
  }));
}

function renderAccounts(list) {
  if (!list || list.length === 0) { el.accounts.hidden = true; return; }
  el.accounts.hidden = false;
  el.accounts.replaceChildren(...list.map((name) => {
    const btn = document.createElement('button');
    btn.className = 'acct';
    btn.textContent = '@' + name;
    btn.dataset.name = name;
    btn.addEventListener('click', () => {
      el.username.value = name;
      markActiveAccount();
    });
    return btn;
  }));
  markActiveAccount();
}

function markActiveAccount() {
  const current = el.username.value.trim().toLowerCase();
  el.accounts.querySelectorAll('.acct').forEach((b) => {
    b.classList.toggle('is-on', b.dataset.name.toLowerCase() === current);
  });
}

function addLog(level, message) {
  const p = document.createElement('p');
  p.className = level;
  p.textContent = message;
  el.log.prepend(p);
  while (el.log.childElementCount > 30) el.log.lastElementChild.remove();
}

/* ═══════════ الصوت ═══════════ */

let audioCtx = null;
function tone(freq, duration, type = 'sine', gain = 0.05) {
  if (!el.sound.checked) return;
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
  const colors = ['#f5b841', '#35d0a5', '#ff4d6d', '#f5f1e6', '#a78bfa'];
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
    // الخطوات الأخيرة تُوجَّه نحو التذكرة الفائزة
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
    const progress = step / totalSteps;          // تباطؤ تدريجي حتى التوقف
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

/* ═══════════ أحداث الخادم ═══════════ */

socket.on('state', (s) => {
  participants = s.participants || [];
  el.keyword.value = s.keyword;
  el.emptyKeyword.textContent = s.keyword;
  el.exclude.checked = s.excludeWinners;
  el.username.value = s.username || '';
  renderAccounts(s.accounts);
  document.querySelectorAll('.seg').forEach((b) => {
    const on = b.dataset.mode === s.matchMode;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-checked', String(on));
  });
  applyStatus(s);
  renderAll();
  renderHistory(s.history);

  if (s.winner) {
    showWinner(s.winner);
    (s.winnerMessages || []).forEach(addBubble);
  } else {
    showList();
  }
});

socket.on('status', applyStatus);

function applyStatus(s) {
  el.status.dataset.state = s.status;
  el.statusText.textContent = s.statusDetail || 'غير متصل';
  const live = s.status === 'connected' || s.status === 'connecting';
  el.btnStart.disabled = live;
  el.btnStop.disabled = !live;
  el.btnCheck.disabled = live;
  el.btnStart.textContent = s.status === 'connecting' ? 'جارٍ الاتصال…' : 'تشغيل الاتصال';
  // مزامنة الاسم مع النوافذ الأخرى، إلا إذا كان المستخدم يكتب فيه الآن
  if (s.username && document.activeElement !== el.username) {
    el.username.value = s.username;
    markActiveAccount();
  }
}

socket.on('participant:add', (p) => {
  if (drawing) return;                     // لا نغيّر الشبكة أثناء الحركة
  if (participants.some((x) => x.id === p.id)) return;
  addTicket(p);
});

socket.on('participants:clear', () => {
  participants = [];
  renderAll();
});

socket.on('winner', ({ winner, history, participants: list }) => {
  pendingParticipants = list;
  renderHistory(history);
  runDraw(winner);
});

socket.on('draw:empty', () => {
  drawing = false;
  refreshCounter();
  addLog('warn', 'لا يوجد مشاركون للسحب.');
});

socket.on('winner:clear', showList);
socket.on('winner:message', addBubble);
socket.on('history:clear', () => renderHistory([]));

socket.on('settings', (s) => {
  el.keyword.value = s.keyword;
  el.emptyKeyword.textContent = s.keyword;
  el.exclude.checked = s.excludeWinners;
});

socket.on('log', ({ level, message }) => addLog(level, message));

socket.on('disconnect', () => {
  el.status.dataset.state = 'error';
  el.statusText.textContent = 'انقطع الاتصال بالخادم';
});

/* ═══════════ تفاعل المستخدم ═══════════ */

el.btnStart.addEventListener('click', () => {
  const value = el.username.value.trim();
  // وضع التجربة: اكتب demo لتوليد مشاركين وهميين بدون بث حقيقي
  if (value.toLowerCase() === 'demo') {
    socket.emit('demo', { count: 14 });
    return;
  }
  socket.emit('start', { username: value });
});
el.btnCheck.addEventListener('click', () => {
  socket.emit('check', { username: el.username.value });
});

el.username.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !el.btnStart.disabled) el.btnStart.click();
});

el.btnStop.addEventListener('click', () => socket.emit('stop'));

el.btnClear.addEventListener('click', () => {
  if (participants.length && !confirm('مسح كل المشاركين الحاليين؟')) return;
  socket.emit('clear');
});

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

/* ═══ الإصلاح: زر "رجوع للقائمة" كان يعتمد بالكامل على رد السيرفر
   (حدث winner:clear). لو السيرفر ما أرسل الحدث (لأي سبب: حالة الفائز
   محفوظة عنده ولم تُمسح، أو الحدث "back" غير مُنفَّذ هناك)، تظل الشاشة
   عالقة للأبد ولا يقدر المستخدم يقفلها.
   الحل: نخفي الشاشة محليًا فورًا (بدون انتظار السيرفر)، ثم نبلغ
   السيرفر بالحدث لتحديث حالته أيضًا. ═══ */
el.btnBack.addEventListener('click', () => {
  showList();            // إغلاق فوري من طرف المتصفح
  socket.emit('back');   // إبلاغ السيرفر (اختياري الآن، لا نعتمد عليه)
});

el.keyword.addEventListener('change', () => {
  socket.emit('settings', { keyword: el.keyword.value });
});

el.exclude.addEventListener('change', () => {
  socket.emit('settings', { excludeWinners: el.exclude.checked });
});

document.querySelectorAll('.seg').forEach((btn) => {
  btn.addEventListener('click', () => socket.emit('settings', { matchMode: btn.dataset.mode }));
});

el.btnHistoryClear.addEventListener('click', () => {
  if (confirm('مسح سجل الفائزين وإعادة تأهيل الجميع للسحب؟')) socket.emit('history:clear');
});

/* اختصارات أثناء البث */
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); if (!el.btnDraw.disabled) requestDraw(); }
  if (e.key === 'Escape' && !el.stageWinner.hidden) {
    showList();          // إغلاق فوري بنفس منطق زر "رجوع" أعلاه
    socket.emit('back');
  }
});

/* تلميح وضع التجربة */
el.username.addEventListener('input', () => {
  markActiveAccount();
  if (el.btnStart.disabled) return;
  el.btnStart.textContent = el.username.value.trim().toLowerCase() === 'demo'
    ? 'إضافة مشاركين تجريبيين'
    : 'تشغيل الاتصال';
});
