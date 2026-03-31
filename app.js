(function() {

// ── APP STATE ──
let tasks = [];
let events = [];
let deadlines = [];
let db = null;
let syncEnabled = false;
let audioCtx = null;

const firebaseConfig = {
  apiKey: "AIzaSyBK9sjOnHmeoRqHz6sz31wYSClKYjKZYyQ",
  authDomain: "daily-planner-9ce7a.firebaseapp.com",
  projectId: "daily-planner-9ce7a",
  storageBucket: "daily-planner-9ce7a.firebasestorage.app",
  messagingSenderId: "776129481231",
  appId: "1:776129481231:web:098c5a5dfe0befb4fc317a"
};

try {
  firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
} catch(e) { console.warn('Firebase init failed:', e); }

// ── FIREBASE SYNC ──
async function syncLoad() {
  const lt = localStorage.getItem('dp_tasks');
  const le = localStorage.getItem('dp_events');
  const ld = localStorage.getItem('dp_deadlines');
  if (lt) try { tasks = JSON.parse(lt); } catch(e) {}
  if (le) try { events = JSON.parse(le); } catch(e) {}
  if (ld) try { deadlines = JSON.parse(ld); } catch(e) {}

  if (!db) { showSyncStatus('offline'); return; }

  try {
    const ref = db.collection('planner').doc('data');
    const timeoutPromise = new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 5000));
    const snap = await Promise.race([ref.get(), timeoutPromise]);

    if (snap.exists) {
      const d = snap.data();
      if (!lt || (d.updated && d.updated > (JSON.parse(lt).updated || 0))) {
        tasks     = d.tasks     || [];
        events    = d.events    || [];
        deadlines = d.deadlines || [];
      }
    } else {
      if (tasks.length || events.length || deadlines.length) {
        await ref.set({ tasks, events, deadlines, updated: Date.now() });
      }
    }
    syncEnabled = true;
    showSyncStatus('synced');

    ref.onSnapshot(snap => {
      if (!snap.exists) return;
      const d = snap.data();
      const incoming = JSON.stringify({ tasks: d.tasks, events: d.events, deadlines: d.deadlines });
      const current  = JSON.stringify({ tasks, events, deadlines });
      if (incoming !== current) {
        tasks     = d.tasks     || [];
        events    = d.events    || [];
        deadlines = d.deadlines || [];
        Object.keys(timers).forEach(id => {
          if (!tasks.find(t => t.id === id)) { clearInterval(timers[id]); delete timers[id]; }
        });
        renderTasks(); renderEventList(); renderCalendar(); renderTimeline(); renderDeadlines();
      }
    });
  } catch(e) {
    console.warn('Firebase sync failed:', e.message);
    showSyncStatus('offline');
    setTimeout(syncLoad, 30000);
  }
}

async function syncSave() {
  localStorage.setItem('dp_tasks',     JSON.stringify(tasks));
  localStorage.setItem('dp_events',    JSON.stringify(events));
  localStorage.setItem('dp_deadlines', JSON.stringify(deadlines));
  if (!syncEnabled || !db) return;
  try {
    await db.collection('planner').doc('data').set({ tasks, events, deadlines, updated: Date.now() });
    showSyncStatus('synced');
  } catch(e) { showSyncStatus('error'); }
}

function showSyncStatus(state) {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  if (state === 'synced')  { el.textContent = '☁ Synced';   el.style.color = 'rgba(255,255,255,0.75)'; }
  if (state === 'offline') { el.textContent = '⚠ Offline';  el.style.color = '#F1C40F'; }
  if (state === 'error')   { el.textContent = '✕ Sync err'; el.style.color = '#E74C3C'; }
}

// ── UTILS ──
let calDate = new Date();
let selectedDay = null;
let timers = {};
const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function save() { syncSave(); }
function uid()  { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
function impClass(imp) { return {low:'imp-low',medium:'imp-medium',high:'imp-high',critical:'imp-critical'}[imp]||'imp-medium'; }
function impLabel(imp) { return {low:'Low',medium:'Medium',high:'High',critical:'Critical!'}[imp]||imp; }
function fmtTime(sec) {
  const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=sec%60;
  if(h>0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function timerColor(pct) {
  if(pct>=0.85) return '#C0392B';
  if(pct>0.65)  return '#E67E22';
  if(pct>0.4)   return '#F1C40F';
  return '#2D6A4F';
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function toDateStr(d) {
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

// ── TASKS ──
function addTask() {
  const name = document.getElementById('newTaskName').value.trim();
  if (!name) return;
  tasks.push({
    id: uid(), name,
    importance: document.getElementById('newTaskImp').value,
    duration: parseInt(document.getElementById('newTaskDur').value)||30,
    startTime: document.getElementById('newTaskTime').value||'',
    elapsed:0, running:false, done:false, checked:false
  });
  save();
  document.getElementById('newTaskName').value = '';
  renderTasks(); renderCalendar(); renderTimeline();
}

function toggleTaskChecked(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  task.checked = !task.checked;
  if (task.checked && task.running) stopTimer(id);
  save(); renderTasks(); renderTimeline();
}

function deleteTask(id) {
  stopTimer(id);
  tasks = tasks.filter(t => t.id !== id);
  save(); renderTasks(); renderCalendar(); renderTimeline();
}

function startTimer(id) {
  const task = tasks.find(t => t.id === id);
  if (!task || task.running) return;
  task.running = true; save();
  timers[id] = setInterval(() => {
    const t = tasks.find(t => t.id === id);
    if (!t) { clearInterval(timers[id]); return; }
    t.elapsed = (t.elapsed||0) + 1;
    if (t.elapsed >= t.duration*60) {
      t.running = false; clearInterval(timers[id]); delete timers[id]; playTaskEndSound();
    }
    save(); updateTaskCard(id);
  }, 1000);
  updateTaskCard(id);
}

function stopTimer(id) {
  const task = tasks.find(t => t.id === id);
  if (task) { task.running = false; save(); }
  if (timers[id]) { clearInterval(timers[id]); delete timers[id]; }
  updateTaskCard(id);
}

function resetTimer(id) {
  stopTimer(id);
  const task = tasks.find(t => t.id === id);
  if (task) { task.elapsed = 0; save(); }
  updateTaskCard(id);
}

function updateTaskCard(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  const el = document.getElementById('task_' + id);
  if (!el) return;
  const total = task.duration*60, elapsed = task.elapsed||0;
  const pct = Math.min(elapsed/total, 1);
  const bar = el.querySelector('.timer-bar');
  const display = el.querySelector('.timer-display');
  const remaining = Math.max(total-elapsed, 0);
  if (bar)     { bar.style.width = (pct*100)+'%'; bar.style.background = timerColor(pct); }
  if (display) { display.textContent = task.running ? 'Remaining: '+fmtTime(remaining) : (elapsed>0?'Elapsed: '+fmtTime(elapsed):fmtTime(total)+' total'); }
  const sb = el.querySelector('.start-btn'); const pb = el.querySelector('.stop-btn');
  if (sb) sb.style.display = task.running ? 'none' : '';
  if (pb) pb.style.display = task.running ? '' : 'none';
  el.classList.toggle('running', task.running);
}

function toggleEditTask(id) { document.getElementById('editForm_'+id)?.classList.toggle('open'); }

function saveEditTask(id) {
  const task = tasks.find(t => t.id === id); if (!task) return;
  const n = document.getElementById('editName_'+id).value.trim();
  if (n) task.name = n;
  task.importance = document.getElementById('editImp_'+id).value;
  task.duration   = parseInt(document.getElementById('editDur_'+id).value)||task.duration;
  task.startTime  = document.getElementById('editTime_'+id).value;
  task.elapsed = 0; stopTimer(id); save();
  renderTasks(); renderCalendar(); renderTimeline();
}

function renderTasks() {
  const list = document.getElementById('taskList');
  if (!tasks.length) { list.innerHTML='<div class="empty-state">No tasks yet. Add one above!</div>'; return; }

  const active = tasks.filter(t => !t.checked);
  const done   = tasks.filter(t => t.checked);

  function taskCard(task) {
    const total=task.duration*60, elapsed=task.elapsed||0;
    const pct=Math.min(elapsed/total,1), remaining=Math.max(total-elapsed,0);
    const td = task.running ? 'Remaining: '+fmtTime(remaining) : (elapsed>0?'Elapsed: '+fmtTime(elapsed):fmtTime(total)+' total');
    const checkedClass = task.checked ? ' task-checked' : '';
    return '<div class="task-card' + (task.running?' running':'') + checkedClass + '" id="task_' + task.id + '">' +
      '<div class="task-header">' +
        '<button class="task-check-btn' + (task.checked?' checked':'') + '" onclick="toggleTaskChecked(\''+ task.id +'\')" title="' + (task.checked?'Mark incomplete':'Mark complete') + '">' +
          (task.checked ? '✓' : '') +
        '</button>' +
        '<div class="task-name' + (task.checked?' done-text':'') + '">' + escHtml(task.name) + '</div>' +
        '<span class="importance-badge ' + impClass(task.importance) + '">' + impLabel(task.importance) + '</span>' +
      '</div>' +
      (!task.checked ? (
        '<div class="task-meta"><span>⏱ ' + task.duration + ' min</span>' + (task.startTime?'<span>🕐 '+task.startTime+'</span>':'') + '</div>' +
        '<div class="timer-bar-wrap"><div class="timer-bar" style="width:' + (pct*100) + '%;background:' + timerColor(pct) + ';"></div></div>' +
        '<div class="timer-display">' + td + '</div>' +
        '<div class="task-actions">' +
          '<button class="icon-btn start-btn" style="' + (task.running?'display:none':'') + '" onclick="startTimer(\''+ task.id +'\')">' + '▶ Start</button>' +
          '<button class="icon-btn stop-btn"  style="' + (!task.running?'display:none':'') + '" onclick="stopTimer(\''+ task.id +'\')">' + '⏸ Pause</button>' +
          '<button class="icon-btn" onclick="resetTimer(\''+ task.id +'\')">↺ Reset</button>' +
          '<button class="icon-btn" onclick="toggleEditTask(\''+ task.id +'\')">✏ Edit</button>' +
          '<button class="icon-btn del-btn" onclick="deleteTask(\''+ task.id +'\')">✕</button>' +
        '</div>' +
        '<div class="edit-form" id="editForm_' + task.id + '">' +
          '<input type="text" id="editName_' + task.id + '" value="' + escHtml(task.name) + '" placeholder="Task name" />' +
          '<select id="editImp_' + task.id + '">' +
            '<option value="low"' + (task.importance==='low'?' selected':'') + '>Low</option>' +
            '<option value="medium"' + (task.importance==='medium'?' selected':'') + '>Medium</option>' +
            '<option value="high"' + (task.importance==='high'?' selected':'') + '>High</option>' +
            '<option value="critical"' + (task.importance==='critical'?' selected':'') + '>Critical</option>' +
          '</select>' +
          '<div class="form-row"><label>Duration (min)</label><input type="number" id="editDur_' + task.id + '" value="' + task.duration + '" min="1" max="480" /></div>' +
          '<div class="form-row"><label>Start time</label><input type="time" id="editTime_' + task.id + '" value="' + (task.startTime||'') + '" style="flex:1;border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-family:sans-serif;font-size:12px;background:var(--surface);color:var(--text);outline:none;" /></div>' +
          '<div class="edit-actions">' +
            '<button class="btn" style="font-size:12px;padding:6px 10px;" onclick="saveEditTask(\''+ task.id +'\')">Save</button>' +
            '<button class="btn secondary" style="font-size:12px;padding:6px 10px;" onclick="toggleEditTask(\''+ task.id +'\')">Cancel</button>' +
          '</div>' +
        '</div>'
      ) : (
        '<div class="task-actions" style="margin-top:4px;">' +
          '<button class="icon-btn del-btn" onclick="deleteTask(\''+ task.id +'\')">✕ Remove</button>' +
        '</div>'
      )) +
    '</div>';
  }

  let html = '';
  if (active.length) {
    html += active.map(taskCard).join('');
  } else {
    html += '<div class="empty-state" style="padding:10px;">All tasks complete! 🎉</div>';
  }
  if (done.length) {
    html += '<div class="done-section-label">Completed (' + done.length + ')</div>';
    html += done.map(taskCard).join('');
  }
  list.innerHTML = html;
  tasks.forEach(t => { if (t.running && !timers[t.id]) startTimer(t.id); });
}
// ── EVENTS ──
function toggleEventForm() { document.getElementById('eventForm').classList.toggle('open'); }

function scheduleTypeChange() {
  const type = document.getElementById('evScheduleType').value;
  document.getElementById('evDateWrap').style.display   = type==='once'   ? '' : 'none';
  document.getElementById('evCustomDays').style.display = type==='custom' ? '' : 'none';
}

function addEvent() {
  const name = document.getElementById('evName').value.trim(); if (!name) return;
  const schedType = document.getElementById('evScheduleType').value;
  let schedDays = [];
  if (schedType==='once') { if (!document.getElementById('evDate').value) return alert('Pick a date.'); }
  else if (schedType==='weekdays') schedDays=[1,2,3,4,5];
  else if (schedType==='daily')    schedDays=[0,1,2,3,4,5,6];
  else { document.querySelectorAll('#evCustomDays input:checked').forEach(c=>schedDays.push(parseInt(c.value))); if(!schedDays.length) return alert('Select at least one day.'); }
  events.push({ id:uid(), name, importance:document.getElementById('evImp').value,
    duration:parseInt(document.getElementById('evDur').value)||60,
    time:document.getElementById('evTime').value||'', scheduleType:schedType,
    date:schedType==='once'?document.getElementById('evDate').value:'', schedDays,
    recurring:document.getElementById('evRecurring').checked,
    recurWeeks:parseInt(document.getElementById('evRecurWeeks').value)||1 });
  save(); document.getElementById('evName').value='';
  toggleEventForm(); renderEventList(); renderCalendar(); renderTimeline();
}

function deleteEvent(id) { events=events.filter(e=>e.id!==id); save(); renderEventList(); renderCalendar(); renderTimeline(); }

function toggleEditEvent(id) {
  const form = document.getElementById('evedit_'+id); if (!form) return;
  form.classList.toggle('open');
  if (form.classList.contains('open')) { const inp=document.getElementById('evEditName_'+id); if(inp){inp.focus();inp.select();} }
}

function saveEditEvent(id) {
  const ev=events.find(e=>e.id===id); if(!ev) return;
  const n=document.getElementById('evEditName_'+id); if(n&&n.value.trim()) ev.name=n.value.trim();
  const i=document.getElementById('evEditImp_'+id);  if(i) ev.importance=i.value;
  const d=document.getElementById('evEditDur_'+id);  if(d) ev.duration=parseInt(d.value)||ev.duration;
  const t=document.getElementById('evEditTime_'+id); if(t) ev.time=t.value;
  save(); renderEventList(); renderCalendar(); renderTimeline();
}

function renderEventList() {
  const list = document.getElementById('eventList');
  if (!events.length) { list.innerHTML='<div class="empty-state">No events yet.</div>'; return; }
  list.innerHTML = events.map(ev => {
    let sl='';
    if(ev.scheduleType==='once') sl=ev.date;
    else if(ev.scheduleType==='weekdays') sl='Mon–Fri';
    else if(ev.scheduleType==='daily')    sl='Every day';
    else sl=(ev.schedDays||[]).map(d=>DAYS[d]).join(', ');
    if(ev.recurring&&ev.scheduleType!=='once') sl+=` · every ${ev.recurWeeks}w`;
    return `<div class="event-card" id="evcard_${ev.id}">
      <div class="ev-name">${escHtml(ev.name)}</div>
      <div class="ev-meta">${sl}${ev.time?' · '+ev.time:''} · ${ev.duration} min · <span class="${impClass(ev.importance)}" style="font-size:10px;padding:1px 5px;border-radius:8px;font-weight:600;">${impLabel(ev.importance)}</span></div>
      <div class="ev-actions">
        <button class="icon-btn" onclick="toggleEditEvent('${ev.id}')">✏ Edit</button>
        <button class="icon-btn del-btn" onclick="deleteEvent('${ev.id}')">✕ Remove</button>
      </div>
      <div class="ev-edit-form" id="evedit_${ev.id}">
        <input type="text" id="evEditName_${ev.id}" value="${escHtml(ev.name)}" placeholder="Event name" />
        <select id="evEditImp_${ev.id}">
          <option value="low"${ev.importance==='low'?' selected':''}>Low</option>
          <option value="medium"${ev.importance==='medium'?' selected':''}>Medium</option>
          <option value="high"${ev.importance==='high'?' selected':''}>High</option>
          <option value="critical"${ev.importance==='critical'?' selected':''}>Critical</option>
        </select>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">
          <label style="font-size:11px;color:var(--text2);white-space:nowrap;">Duration (min)</label>
          <input type="number" id="evEditDur_${ev.id}" value="${ev.duration}" min="1" max="480" style="width:70px;" />
          <label style="font-size:11px;color:var(--text2);">Time</label>
          <input type="time" id="evEditTime_${ev.id}" value="${ev.time||''}" style="flex:1;" />
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn" style="font-size:12px;padding:5px 10px;" onclick="saveEditEvent('${ev.id}')">Save</button>
          <button class="btn secondary" style="font-size:12px;padding:5px 10px;" onclick="toggleEditEvent('${ev.id}')">Cancel</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function eventOccursOn(ev, date) {
  if (ev.scheduleType==='once') return ev.date===toDateStr(date);
  const dow=date.getDay();
  if (ev.scheduleType==='weekdays') return dow>=1&&dow<=5;
  if (ev.scheduleType==='daily')    return true;
  if (ev.scheduleType==='custom')   return (ev.schedDays||[]).includes(dow);
  return false;
}

// ── DEADLINES ──
function saveDeadlines() { save(); }

function addDeadline() {
  const name=document.getElementById('newDlName').value.trim();
  const date=document.getElementById('newDlDate').value;
  if (!name||!date) return;
  deadlines.push({ id:uid(), name, importance:document.getElementById('newDlImp').value, date });
  saveDeadlines(); document.getElementById('newDlName').value=''; renderDeadlines();
}

function deleteDeadline(id) { deadlines=deadlines.filter(d=>d.id!==id); saveDeadlines(); renderDeadlines(); }
function toggleDeadlineChecked(id) { const dl=deadlines.find(d=>d.id===id); if(dl){ dl.checked=!dl.checked; saveDeadlines(); renderDeadlines(); } }

function toggleEditDeadline(id) { document.getElementById('dledit_'+id)?.classList.toggle('open'); }

function saveEditDeadline(id) {
  const dl=deadlines.find(d=>d.id===id); if(!dl) return;
  const n=document.getElementById('dlEditName_'+id); if(n&&n.value.trim()) dl.name=n.value.trim();
  const i=document.getElementById('dlEditImp_'+id);  if(i) dl.importance=i.value;
  const d=document.getElementById('dlEditDate_'+id); if(d&&d.value) dl.date=d.value;
  saveDeadlines(); renderDeadlines();
}

function deadlineCountdown(dateStr) {
  const today=new Date(); today.setHours(0,0,0,0);
  const due=new Date(dateStr+'T00:00:00');
  const diff=Math.round((due-today)/86400000);
  if(diff<0)   return {label:`${Math.abs(diff)}d overdue`,cls:'dl-overdue',  dotCls:'dl-dot-overdue', cmCls:'cm-dl-overdue'};
  if(diff===0) return {label:'Due today!',               cls:'dl-today',    dotCls:'dl-dot-today',   cmCls:'cm-dl-today'};
  if(diff<=3)  return {label:`Due in ${diff}d`,          cls:'dl-soon',     dotCls:'dl-dot-soon',    cmCls:'cm-dl-soon'};
  return             {label:`Due in ${diff}d`,            cls:'dl-upcoming', dotCls:'dl-dot-upcoming',cmCls:'cm-dl-upcoming'};
}

function renderDeadlines() {
  const list=document.getElementById('deadlineList'); if(!list) return;
  if(!deadlines.length) { list.innerHTML='<div class="empty-state">No deadlines yet.</div>'; return; }
  const active=[...deadlines].filter(d=>!d.checked).sort((a,b)=>a.date.localeCompare(b.date));
  const done=[...deadlines].filter(d=>d.checked).sort((a,b)=>a.date.localeCompare(b.date));
  function dlCard(dl) {
    const cd=deadlineCountdown(dl.date);
    return '<div class="deadline-card' + (dl.checked?' task-checked':'') + '" id="dlcard_' + dl.id + '">' +
      '<div class="deadline-header">' +
        '<button class="task-check-btn' + (dl.checked?' checked':'') + '" onclick="toggleDeadlineChecked(\''+ dl.id +'\')" title="' + (dl.checked?'Mark incomplete':'Mark done') + '">' +
          (dl.checked ? '✓' : '') +
        '</button>' +
        '<div class="deadline-name' + (dl.checked?' done-text':'') + '">' + escHtml(dl.name) + '</div>' +
        '<span class="importance-badge ' + impClass(dl.importance) + '">' + impLabel(dl.importance) + '</span>' +
      '</div>' +
      (!dl.checked ? (
        '<div class="deadline-meta"><span>📅 ' + dl.date + '</span><span class="deadline-countdown ' + cd.cls + '">' + cd.label + '</span></div>' +
        '<div class="deadline-actions">' +
          '<button class="icon-btn" onclick="toggleEditDeadline(\''+ dl.id +'\')">✏ Edit</button>' +
          '<button class="icon-btn del-btn" onclick="deleteDeadline(\''+ dl.id +'\')">✕</button>' +
        '</div>' +
        '<div class="deadline-edit-form" id="dledit_' + dl.id + '">' +
          '<input type="text" id="dlEditName_' + dl.id + '" value="' + escHtml(dl.name) + '" placeholder="Deadline name" />' +
          '<select id="dlEditImp_' + dl.id + '">' +
            '<option value="low"' + (dl.importance==='low'?' selected':'') + '>Low</option>' +
            '<option value="medium"' + (dl.importance==='medium'?' selected':'') + '>Medium</option>' +
            '<option value="high"' + (dl.importance==='high'?' selected':'') + '>High</option>' +
            '<option value="critical"' + (dl.importance==='critical'?' selected':'') + '>Critical</option>' +
          '</select>' +
          '<input type="date" id="dlEditDate_' + dl.id + '" value="' + dl.date + '" />' +
          '<div style="display:flex;gap:6px;">' +
            '<button class="btn" style="font-size:12px;padding:5px 10px;" onclick="saveEditDeadline(\''+ dl.id +'\')">Save</button>' +
            '<button class="btn secondary" style="font-size:12px;padding:5px 10px;" onclick="toggleEditDeadline(\''+ dl.id +'\')">Cancel</button>' +
          '</div>' +
        '</div>'
      ) : (
        '<div class="task-actions" style="margin-top:4px;">' +
          '<button class="icon-btn del-btn" onclick="deleteDeadline(\''+ dl.id +'\')">✕ Remove</button>' +
        '</div>'
      )) +
    '</div>';
  }
  let html = active.map(dlCard).join('');
  if (done.length) {
    html += '<div class="done-section-label">Done (' + done.length + ')</div>';
    html += done.map(dlCard).join('');
  }
  list.innerHTML = html || '<div class="empty-state">No upcoming deadlines.</div>';
}

// ── CALENDAR ──
function renderCalendar() {
  document.getElementById('calMonthLabel').textContent = MONTHS[calDate.getMonth()]+' '+calDate.getFullYear();
  const grid=document.getElementById('calGrid');
  const today=new Date();
  const firstDay=new Date(calDate.getFullYear(),calDate.getMonth(),1);
  const lastDay =new Date(calDate.getFullYear(),calDate.getMonth()+1,0);
  let html=DAYS.map(d=>`<div class="cal-dow">${d[0]}</div>`).join('');
  const startPad=firstDay.getDay();
  const prevMonth=new Date(calDate.getFullYear(),calDate.getMonth(),0);
  for(let i=startPad-1;i>=0;i--) html+=calDayHtml(new Date(prevMonth.getFullYear(),prevMonth.getMonth(),prevMonth.getDate()-i),true,today);
  for(let day=1;day<=lastDay.getDate();day++) html+=calDayHtml(new Date(calDate.getFullYear(),calDate.getMonth(),day),false,today);
  const endPad=6-lastDay.getDay();
  for(let i=1;i<=endPad;i++) html+=calDayHtml(new Date(calDate.getFullYear(),calDate.getMonth()+1,i),true,today);
  grid.innerHTML=html;
  renderDayDetail();
}

function calDayHtml(d,otherMonth,today) {
  const isToday=toDateStr(d)===toDateStr(today);
  const isSelected=selectedDay&&toDateStr(d)===toDateStr(selectedDay);
  const ds=toDateStr(d);
  const evCount=events.filter(ev=>eventOccursOn(ev,d)).length;
  const dlCount=deadlines.filter(dl=>dl.date===ds).length;
  let dots='';
  if(evCount>0) dots+=`<div class="day-dot event-dot"></div>`.repeat(Math.min(evCount,3));
  if(dlCount>0) dots+=`<div class="day-dot" style="background:#E74C3C;"></div>`.repeat(Math.min(dlCount,2));
  let cls='cal-day';
  if(otherMonth) cls+=' other-month';
  if(isToday)    cls+=' today';
  if(isSelected) cls+=' selected';
  return `<div class="${cls}" onclick="selectDay('${ds}')"><span class="day-num">${d.getDate()}</span><div class="day-dots">${dots}</div></div>`;
}

function selectDay(ds) { selectedDay=new Date(ds+'T12:00:00'); renderCalendar(); renderDayDetail(); }

function renderDayDetail() {
  if(!selectedDay) { document.getElementById('dayDetail').style.display='none'; return; }
  document.getElementById('dayDetail').style.display='';
  document.getElementById('dayDetailTitle').textContent=DAYS[selectedDay.getDay()]+', '+MONTHS[selectedDay.getMonth()]+' '+selectedDay.getDate();
  const evOnDay=events.filter(ev=>eventOccursOn(ev,selectedDay));
  const tasksOnDay=tasks.filter(t=>t.startTime);
  const dlOnDay=deadlines.filter(dl=>dl.date===toDateStr(selectedDay));
  let html='';
  if(!tasksOnDay.length&&!evOnDay.length&&!dlOnDay.length) html='<div style="font-size:12px;color:var(--text3);font-style:italic;">Nothing scheduled.</div>';
  tasksOnDay.sort((a,b)=>(a.startTime||'').localeCompare(b.startTime||'')).forEach(t=>{
    html+=`<div class="day-item"><div class="day-item-dot"></div><div><div class="day-item-name">${escHtml(t.name)}</div><div class="day-item-sub">${t.startTime} · ${t.duration} min · ${impLabel(t.importance)}</div></div></div>`;
  });
  evOnDay.sort((a,b)=>(a.time||'').localeCompare(b.time||'')).forEach(ev=>{
    html+=`<div class="day-item"><div class="day-item-dot ev"></div><div><div class="day-item-name">${escHtml(ev.name)}</div><div class="day-item-sub">${ev.time?ev.time+' · ':''}${ev.duration} min · ${impLabel(ev.importance)}</div></div></div>`;
  });
  dlOnDay.forEach(dl=>{
    html+=`<div class="day-item"><div class="day-item-dot" style="background:#E74C3C;"></div><div><div class="day-item-name">📅 ${escHtml(dl.name)}</div><div class="day-item-sub">Deadline · ${impLabel(dl.importance)}</div></div></div>`;
  });
  document.getElementById('dayDetailItems').innerHTML=html;
}

function calPrev() { calDate=new Date(calDate.getFullYear(),calDate.getMonth()-1,1); renderCalendar(); }
function calNext() { calDate=new Date(calDate.getFullYear(),calDate.getMonth()+1,1); renderCalendar(); }

// ── TIMELINE ──
function renderTimeline() {
  const today=new Date(), tlDiv=document.getElementById('timelineView');
  const allItems=[];
  tasks.forEach(t=>{ if(t.startTime){const[h,m]=t.startTime.split(':').map(Number); allItems.push({type:'task',hour:h,min:m,name:t.name,duration:t.duration,importance:t.importance,checked:t.checked||false}); }});
  events.forEach(ev=>{ if(eventOccursOn(ev,today)&&ev.time){const[h,m]=ev.time.split(':').map(Number); allItems.push({type:'event',hour:h,min:m,name:ev.name,duration:ev.duration,importance:ev.importance,checked:false}); }});

  // Build full 24hr timeline with pixel-accurate blocks
  const HOUR_HEIGHT = 60; // px per hour
  const TOTAL_HEIGHT = 24 * HOUR_HEIGHT;
  const now = today;
  const nowMins = now.getHours()*60 + now.getMinutes();

  // Hour grid
  let hoursHtml = '';
  for(let h=0;h<24;h++){
    const label=h===0?'12 AM':h<12?h+' AM':h===12?'12 PM':(h-12)+' PM';
    hoursHtml += '<div class="tl24-hour" style="top:'+(h*HOUR_HEIGHT)+'px;"><span class="tl24-label">'+label+'</span></div>';
  }

  // Current time indicator
  const nowPx = (nowMins/60)*HOUR_HEIGHT;
  const nowLine = '<div class="tl24-now-line" style="top:'+nowPx+'px;"><div class="tl24-now-dot"></div></div>';

  // Inject today's time blocks as background shading
  const todayStr = toDateStr(today);
  let blocksBg = '';
  timeBlocks.filter(b => !b.date || b.date === todayStr).forEach(b => {
    const top = (b.startMins / 60) * HOUR_HEIGHT;
    const height = Math.max(((b.endMins - b.startMins) / 60) * HOUR_HEIGHT, 20);
    blocksBg += '<div class="tl24-block-bg" style="top:' + top + 'px;height:' + height + 'px;">' +
      '<div class="tl24-block-bg-label">' + escHtml(b.label) + '</div>' +
    '</div>';
  });

  // Sort items by start time
  allItems.sort((a,b)=>a.hour*60+a.min-(b.hour*60+b.min));

  // Layout blocks (simple column assignment to avoid overlap)
  const placed = allItems.map(item => {
    const startMins = item.hour*60+item.min;
    const endMins = startMins + item.duration;
    return { ...item, startMins, endMins };
  });

  // Assign columns
  const columns = [];
  placed.forEach(item => {
    let col = 0;
    while (columns[col] && columns[col] > item.startMins) col++;
    item.col = col;
    columns[col] = item.endMins;
    item.maxCol = col;
  });
  // Find max column per item
  placed.forEach(item => {
    item.totalCols = Math.max(...placed.filter(o =>
      !(o.endMins <= item.startMins || o.startMins >= item.endMins)
    ).map(o => o.col)) + 1;
  });

  let blocksHtml = '';
  placed.forEach(item => {
    const top = (item.startMins / 60) * HOUR_HEIGHT;
    const height = Math.max((item.duration / 60) * HOUR_HEIGHT, 22);
    const colW = 100 / item.totalCols;
    const left = item.col * colW;
    const timeStr = String(item.hour).padStart(2,'0')+':'+String(item.min).padStart(2,'0');
    const endH = Math.floor(item.endMins/60), endM = item.endMins%60;
    const endStr = String(endH).padStart(2,'0')+':'+String(endM).padStart(2,'0');
    const isEvent = item.type==='event';
    const cls = isEvent ? 'tl24-block event-block' : ('tl24-block task-block' + (item.checked?' tl-checked':''));
    blocksHtml += '<div class="'+cls+'" style="top:'+top+'px;height:'+height+'px;left:calc(60px + '+left+'%);width:calc('+colW+'% - 4px);">' +
      '<div class="tl24-name">'+escHtml(item.name)+'</div>' +
      '<div class="tl24-meta">'+timeStr+'–'+endStr+' · '+item.duration+'m</div>' +
      '<div class="tl24-imp '+ impClass(item.importance) +'" style="font-size:9px;padding:1px 4px;border-radius:6px;font-weight:600;display:inline-block;margin-top:2px;">'+impLabel(item.importance)+'</div>' +
    '</div>';
  });

  tlDiv.innerHTML = '<div class="tl24-container" style="height:'+TOTAL_HEIGHT+'px;">' +
    hoursHtml + blocksBg + nowLine + blocksHtml +
  '</div>';

  // Scroll to current time minus 1 hour
  const scrollTarget = Math.max(0, nowPx - HOUR_HEIGHT);
  setTimeout(() => { tlDiv.scrollTop = scrollTarget; }, 50);
}
function switchMain(view) {
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById('mainTasks').style.display    = view==='tasks'    ? '' : 'none';
  document.getElementById('mainTimeline').style.display = view==='timeline' ? '' : 'none';
  if(view==='timeline') renderTimeline();
}

// ── WEATHER ──
let weatherCache=null, weatherLastFetch=0;
const WMO_CODES={0:'Clear sky',1:'Mainly clear',2:'Partly cloudy',3:'Overcast',45:'Foggy',48:'Icy fog',51:'Light drizzle',53:'Drizzle',55:'Heavy drizzle',61:'Light rain',63:'Rain',65:'Heavy rain',71:'Light snow',73:'Snow',75:'Heavy snow',77:'Snow grains',80:'Light showers',81:'Showers',82:'Heavy showers',85:'Snow showers',86:'Heavy snow showers',95:'Thunderstorm',96:'Thunderstorm + hail',99:'Heavy thunderstorm + hail'};
const WMO_ICONS={0:'☀️',1:'🌤️',2:'⛅',3:'☁️',45:'🌫️',48:'🌫️',51:'🌦️',53:'🌦️',55:'🌧️',61:'🌧️',63:'🌧️',65:'🌧️',71:'🌨️',73:'❄️',75:'❄️',77:'❄️',80:'🌦️',81:'🌧️',82:'⛈️',85:'🌨️',86:'🌨️',95:'⛈️',96:'⛈️',99:'⛈️'};

async function fetchWeather() {
  if(weatherCache&&Date.now()-weatherLastFetch<600000){renderWeather(weatherCache);return;}
  try {
    const pos=await new Promise((res,rej)=>navigator.geolocation.getCurrentPosition(res,rej,{timeout:6000}));
    const{latitude:lat,longitude:lon}=pos.coords;
    let cityName='';
    try{const gr=await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`);const gd=await gr.json();cityName=gd.address?.city||gd.address?.town||gd.address?.suburb||gd.address?.county||'';}catch(e){}
    const url=`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,precipitation&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_sum,wind_speed_10m_max&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto&forecast_days=2`;
    const res=await fetch(url); const data=await res.json(); const c=data.current; const d=data.daily;
    const tm=d?{temperature_2m_max:d.temperature_2m_max[1],temperature_2m_min:d.temperature_2m_min[1],weather_code:d.weather_code[1],precipitation_sum:d.precipitation_sum[1],wind_speed_10m_max:d.wind_speed_10m_max[1]}:null;
    weatherCache={c,tm,cityName,lat,lon}; weatherLastFetch=Date.now(); renderWeather(weatherCache);
  } catch(e) { const el=document.getElementById('cmWeatherToday'); if(el) el.innerHTML='<div class="cm-weather-loading">Weather unavailable — enable location</div>'; }
}

function renderWeather(cache) {
  if(!cache) return;
  const{c,tm,cityName}=cache;
  function card(label,temp,sub,subLabel,humidity,humLabel,wind,windLabel,precip,code,loc) {
    const icon=WMO_ICONS[code]||'🌡️'; const desc=WMO_CODES[code]||'Unknown';
    return `<div class="cm-weather-day-label">${label}</div>
      <div class="cm-weather-main"><div class="cm-weather-icon">${icon}</div><div><div class="cm-weather-temp">${Math.round(temp)}°F</div><div class="cm-weather-desc">${desc}</div></div></div>
      <div class="cm-weather-stats">
        <div class="cm-weather-stat"><div class="cm-weather-stat-val">${Math.round(sub)}°F</div><div class="cm-weather-stat-lbl">${subLabel}</div></div>
        <div class="cm-weather-stat"><div class="cm-weather-stat-val">${Math.round(humidity)}${humLabel.includes('%')?'%':''}</div><div class="cm-weather-stat-lbl">${humLabel}</div></div>
        <div class="cm-weather-stat"><div class="cm-weather-stat-val">${Math.round(wind)} mph</div><div class="cm-weather-stat-lbl">${windLabel}</div></div>
        <div class="cm-weather-stat"><div class="cm-weather-stat-val">${Number(precip).toFixed(2)}"</div><div class="cm-weather-stat-lbl">Precip</div></div>
      </div>${loc?`<div class="cm-weather-loc">📍 ${loc}</div>`:''}`;
  }
  const te=document.getElementById('cmWeatherToday'),me=document.getElementById('cmWeatherTomorrow');
  if(te&&c) te.innerHTML=card('Today',c.temperature_2m,c.apparent_temperature,'Feels like',c.relative_humidity_2m,'Humidity%',c.wind_speed_10m,'Wind',c.precipitation||0,c.weather_code,cityName);
  if(me&&tm) me.innerHTML=card('Tomorrow',tm.temperature_2m_max,tm.temperature_2m_min,'Low',tm.wind_speed_10m_max,'Max wind',tm.wind_speed_10m_max,'Wind',tm.precipitation_sum||0,tm.weather_code,'');
}

// ── SOUNDS ──
function playTaskEndSound() {
  try {
    if(!audioCtx) audioCtx=new(window.AudioContext||window.webkitAudioContext)();
    if(audioCtx.state==='suspended') audioCtx.resume();
    const now=audioCtx.currentTime;
    [523.25,659.25,783.99].forEach((freq,i)=>{
      const osc=audioCtx.createOscillator(),gain=audioCtx.createGain();
      osc.connect(gain);gain.connect(audioCtx.destination);osc.type='sine';osc.frequency.value=freq;
      gain.gain.setValueAtTime(0,now+i*0.18);gain.gain.linearRampToValueAtTime(0.35,now+i*0.18+0.04);gain.gain.exponentialRampToValueAtTime(0.001,now+i*0.18+0.5);
      osc.start(now+i*0.18);osc.stop(now+i*0.18+0.55);
    });
  } catch(e){}
}

function playDeadlineWarningSound(criticality) {
  try {
    if(!audioCtx) audioCtx=new(window.AudioContext||window.webkitAudioContext)();
    if(audioCtx.state==='suspended') audioCtx.resume();
    const now=audioCtx.currentTime;
    const configs={critical:{freqs:[880,880,1100],interval:0.22,gain:0.5},high:{freqs:[660,880],interval:0.3,gain:0.4},medium:{freqs:[523,659],interval:0.4,gain:0.3},low:{freqs:[440,523],interval:0.5,gain:0.25}};
    const cfg=configs[criticality]||configs.medium;
    cfg.freqs.forEach((freq,i)=>{
      const osc=audioCtx.createOscillator(),gain=audioCtx.createGain();
      osc.connect(gain);gain.connect(audioCtx.destination);osc.type=criticality==='critical'?'square':'sine';osc.frequency.value=freq;
      const start=now+i*cfg.interval;gain.gain.setValueAtTime(cfg.gain,start);gain.gain.exponentialRampToValueAtTime(0.001,start+0.35);osc.start(start);osc.stop(start+0.4);
    });
  } catch(e){}
}

// ── DEADLINE WARNINGS ──
let deadlineWarnedKeys=new Set(JSON.parse(sessionStorage.getItem('dp_dlwarned')||'[]'));

function checkDeadlineWarnings(now) {
  const today=new Date();today.setHours(0,0,0,0);
  deadlines.forEach(dl=>{
    const due=new Date(dl.date+'T00:00:00');
    const daysUntil=Math.round((due-today)/86400000);
    const threshold={critical:0,high:1,medium:0,low:0}[dl.importance]??0;
    if(daysUntil!==threshold) return;
    const warnKey=`${dl.id}_${dl.date}`;
    if(deadlineWarnedKeys.has(warnKey)) return;
    if(now.getHours()===9&&now.getMinutes()<5){
      deadlineWarnedKeys.add(warnKey);
      sessionStorage.setItem('dp_dlwarned',JSON.stringify([...deadlineWarnedKeys]));
      playDeadlineWarningSound(dl.importance);
    }
  });
}

// ── ALARMS ──
let alarms=JSON.parse(localStorage.getItem('dp_alarms')||'[]');
let firingAlarm=null, alarmAudio=null;

function saveAlarms() { localStorage.setItem('dp_alarms',JSON.stringify(alarms)); }

function addAlarm() {
  const timeVal=document.getElementById('newAlarmTime').value; if(!timeVal) return;
  const label=document.getElementById('newAlarmLabel').value.trim()||'Alarm';
  alarms.push({id:uid(),time:timeVal,label,on:true,fired:false});
  saveAlarms();renderAlarms();document.getElementById('newAlarmLabel').value='';
}
function deleteAlarm(id) { alarms=alarms.filter(a=>a.id!==id); saveAlarms(); renderAlarms(); }
function toggleAlarm(id) { const a=alarms.find(a=>a.id===id);if(a){a.on=!a.on;saveAlarms();renderAlarms();} }

function renderAlarms() {
  const list=document.getElementById('alarmList');if(!list)return;
  if(!alarms.length){list.innerHTML='<div style="color:rgba(255,255,255,0.25);font-size:12px;font-style:italic;">No alarms set.</div>';return;}
  list.innerHTML=alarms.map(a=>`
    <div class="cm-alarm-item" id="alarmitem_${a.id}">
      <button class="cm-alarm-toggle ${a.on?'on':''}" onclick="toggleAlarm('${a.id}')"></button>
      <div class="cm-alarm-info"><div class="cm-alarm-time-display">${a.time}</div><div class="cm-alarm-label-display">${escHtml(a.label)}</div></div>
      <button class="cm-alarm-del" onclick="deleteAlarm('${a.id}')">✕</button>
    </div>`).join('');
}

function checkAlarms(now) {
  if(firingAlarm) return;
  const pad=n=>String(n).padStart(2,'0');
  const cur=`${pad(now.getHours())}:${pad(now.getMinutes())}`;
  alarms.forEach(a=>{if(a.on&&a.time===cur&&!a.fired){a.fired=true;saveAlarms();fireAlarm(a);}});
  if(now.getSeconds()===58){alarms.forEach(a=>{if(a.fired&&a.time!==cur)a.fired=false;});saveAlarms();}
}

function fireAlarm(alarm) {
  firingAlarm=alarm;
  document.getElementById('alarmRingTime').textContent=alarm.time;
  document.getElementById('alarmRingLabel').textContent=alarm.label;
  document.getElementById('alarmRingOverlay').classList.add('ringing');
  playAlarmSound();
}

function playAlarmSound() {
  try {
    if(!audioCtx) audioCtx=new(window.AudioContext||window.webkitAudioContext)();
    if(audioCtx.state==='suspended') audioCtx.resume();
    const beep=(freq,start,dur)=>{
      const osc=audioCtx.createOscillator(),g=audioCtx.createGain();
      osc.connect(g);g.connect(audioCtx.destination);osc.frequency.value=freq;osc.type='sine';
      g.gain.setValueAtTime(0.45,audioCtx.currentTime+start);g.gain.exponentialRampToValueAtTime(0.001,audioCtx.currentTime+start+dur);
      osc.start(audioCtx.currentTime+start);osc.stop(audioCtx.currentTime+start+dur+0.05);
    };
    for(let i=0;i<6;i++){beep(880,i*0.6,0.2);beep(1100,i*0.6+0.25,0.15);}
    alarmAudio=setTimeout(playAlarmSound,4000);
  } catch(e){}
}

function dismissAlarm() { firingAlarm=null;clearTimeout(alarmAudio);document.getElementById('alarmRingOverlay').classList.remove('ringing');renderAlarms(); }
function snoozeAlarm() {
  if(!firingAlarm) return;
  const now=new Date();now.setMinutes(now.getMinutes()+5);
  const pad=n=>String(n).padStart(2,'0');
  firingAlarm.time=`${pad(now.getHours())}:${pad(now.getMinutes())}`;
  firingAlarm.fired=false;saveAlarms();dismissAlarm();
}

// ── CLOCK MODE ──
let clockModeOpen=false,clockModeInterval=null,clockModeInterval2=null;

function openClockMode() {
  clockModeOpen=true;
  document.getElementById('clockOverlay').classList.add('open');
  renderAlarms();
  fetchWeather();
  updateClockMode();
  renderPom(); renderSw(); renderNotes();
  clockModeInterval=setInterval(updateClockMode,1000);
  clockModeInterval2=setInterval(fetchWeather,600000);
}

function closeClockMode() {
  clockModeOpen=false;
  document.getElementById('clockOverlay').classList.remove('open');
  clearInterval(clockModeInterval);clearInterval(clockModeInterval2);
}

function switchCmTab(tab) {
  // tabs removed in new layout — no-op kept for compatibility
}

function updateClockMode() {
  const now=new Date();
  const h=now.getHours(),m=now.getMinutes(),s=now.getSeconds();
  const ampm=h>=12?'PM':'AM',h12=h%12||12;
  const pad=n=>String(n).padStart(2,'0');
  const cmTimeEl=document.getElementById('cmTime');
  if(cmTimeEl){
    // Find the text node (not the ampm span) and update it
    for(const node of cmTimeEl.childNodes){
      if(node.nodeType===3){ node.textContent=`${pad(h12)}:${pad(m)}:${pad(s)}`; break; }
    }
  }
  document.getElementById('cmAmpm').textContent=ampm;
  document.getElementById('cmDate').textContent=DAYS[now.getDay()]+', '+MONTHS[now.getMonth()]+' '+now.getDate()+', '+now.getFullYear();
  const nowMins=h*60+m;

  // ── Deadline pills under clock ──
  const dlStrip=document.getElementById('cmDeadlineStrip');
  if(dlStrip){
    const today=new Date();today.setHours(0,0,0,0);
    const sorted=[...deadlines].sort((a,b)=>a.date.localeCompare(b.date));
    if(!sorted.length){
      dlStrip.innerHTML='<span class="cm-dl-pill cm-dl-pill-empty">No deadlines</span>';
    } else {
      dlStrip.innerHTML=sorted.map(dl=>{
        const due=new Date(dl.date+'T00:00:00');
        const diff=Math.round((due-today)/86400000);
        let pillCls,label;
        if(diff<0)      { pillCls='cm-dl-pill-overdue'; label=escHtml(dl.name)+' · '+Math.abs(diff)+'d overdue'; }
        else if(diff===0){ pillCls='cm-dl-pill-today';   label=escHtml(dl.name)+' · today'; }
        else if(diff<=3) { pillCls='cm-dl-pill-soon';    label=escHtml(dl.name)+' · '+diff+'d'; }
        else             { pillCls='cm-dl-pill-upcoming'; label=escHtml(dl.name)+' · '+diff+'d'; }
        return '<span class="cm-dl-pill '+pillCls+'">'+label+'</span>';
      }).join('');
    }
  }

  // ── Countdown tiles (top deadlines) ──
  const tilesEl = document.getElementById('cmCountdownTiles');
  if (tilesEl) {
    const today2 = new Date(); today2.setHours(0,0,0,0);
    const topDl = [...deadlines].filter(d => !d.checked)
      .sort((a,b) => a.date.localeCompare(b.date)).slice(0, 4);
    if (topDl.length) {
      tilesEl.innerHTML = topDl.map(dl => {
        const due = new Date(dl.date + 'T00:00:00');
        const diff = Math.round((due - today2) / 86400000);
        let cls = diff < 0 ? 'ct-overdue' : diff === 0 ? 'ct-today' : diff <= 3 ? 'ct-soon' : 'ct-upcoming';
        let label = diff < 0 ? Math.abs(diff) + 'd overdue' : diff === 0 ? 'TODAY' : diff + ' days';
        return '<div class="countdown-tile ' + cls + '">' +
          '<div class="ct-days">' + (diff < 0 ? '-' : '') + Math.abs(diff) + '</div>' +
          '<div class="ct-unit">' + (Math.abs(diff) === 1 ? 'day' : 'days') + '</div>' +
          '<div class="ct-name">' + escHtml(dl.name.length > 18 ? dl.name.slice(0,16)+'…' : dl.name) + '</div>' +
          '<div class="ct-imp importance-badge ' + impClass(dl.importance) + '" style="font-size:9px;padding:1px 5px;">' + impLabel(dl.importance) + '</div>' +
        '</div>';
      }).join('');
      tilesEl.style.display = 'flex';
    } else {
      tilesEl.style.display = 'none';
    }
  }

  // ── Weather refresh from cache ──
  if(weatherCache) renderWeather(weatherCache);

  // ── Upcoming panel (right column) ──
  const upEl=document.getElementById('cmUpcomingPanel');
  if(upEl){
    const rows=[];
    // Running tasks first
    tasks.filter(t=>t.running).forEach(t=>{
      const total=t.duration*60,elapsed=t.elapsed||0,pct=Math.min(elapsed/total,1),remaining=Math.max(total-elapsed,0);
      const tc=pct>0.85?'danger':pct>0.65?'warn':'';
      const bc=pct>0.85?'#E74C3C':pct>0.65?'#E67E22':pct>0.4?'#F1C40F':'#52e89e';
      rows.push({sort:-1,html:`<div class="cm-up-item cm-up-active">
        <div class="cm-up-dot active"></div>
        <div class="cm-up-info"><div class="cm-up-name">${escHtml(t.name)}</div><div class="cm-up-sub">${t.duration}m · ${impLabel(t.importance)}</div>
        <div class="cm-timer-bar" style="margin-top:4px;"><div class="cm-timer-fill" style="width:${pct*100}%;background:${bc};"></div></div></div>
        <div class="cm-timer ${tc}" style="font-size:16px;">${fmtTime(remaining)}</div></div>`});
    });
    // Upcoming 90min tasks
    tasks.forEach(t=>{
      if(!t.startTime||t.running) return;
      const[th,tm2]=t.startTime.split(':').map(Number);
      const diff=th*60+tm2-nowMins;
      if(diff>=0&&diff<=90) rows.push({sort:diff,html:`<div class="cm-up-item"><div class="cm-up-dot"></div><div class="cm-up-info"><div class="cm-up-name">${escHtml(t.name)}</div><div class="cm-up-sub">Task · ${t.duration}m · ${impLabel(t.importance)}</div></div><div class="cm-up-time">${diff===0?'Now':'in '+diff+'m'}</div></div>`});
    });
    // Upcoming 90min events
    events.forEach(ev=>{
      if(!ev.time||!eventOccursOn(ev,now)) return;
      const[eh,em]=ev.time.split(':').map(Number);
      const diff=eh*60+em-nowMins;
      if(diff>=0&&diff<=90) rows.push({sort:diff,html:`<div class="cm-up-item"><div class="cm-up-dot ev"></div><div class="cm-up-info"><div class="cm-up-name">${escHtml(ev.name)}</div><div class="cm-up-sub">Event · ${ev.duration}m · ${impLabel(ev.importance)}</div></div><div class="cm-up-time">${diff===0?'Now':'in '+diff+'m'}</div></div>`});
    });
    rows.sort((a,b)=>a.sort-b.sort);
    upEl.innerHTML=rows.length?rows.map(r=>r.html).join(''):'<div class="cm-empty">Nothing in the next 90 min.</div>';
  }
}




// ── POMODORO / STOPWATCH / NOTES ──
let pomState = { running: false, mode: 'work', remaining: 25*60, workMins: 25, breakMins: 5, sessions: 0, interval: null };
let stopwatchState = { running: false, elapsed: 0, interval: null };
let cmNotes = localStorage.getItem('dp_cmnotes') || '';

function pomStart() {
  if (pomState.running) return;
  pomState.running = true;
  pomState.interval = setInterval(() => {
    pomState.remaining--;
    if (pomState.remaining <= 0) {
      if (pomState.mode === 'work') { pomState.sessions++; pomState.mode='break'; pomState.remaining=pomState.breakMins*60; playTaskEndSound(); }
      else { pomState.mode='work'; pomState.remaining=pomState.workMins*60; }
    }
    renderPom();
  }, 1000);
  renderPom();
}
function pomPause() { pomState.running=false; clearInterval(pomState.interval); renderPom(); }
function pomReset() { pomPause(); pomState.mode='work'; pomState.remaining=pomState.workMins*60; renderPom(); }
function pomSetWork(v) { pomState.workMins=Math.max(1,Math.min(60,v)); if(!pomState.running){pomState.remaining=pomState.workMins*60;} renderPom(); }
function pomSetBreak(v) { pomState.breakMins=Math.max(1,Math.min(30,v)); renderPom(); }
function renderPom() {
  const el=document.getElementById('cmPomDisplay'); if(!el) return;
  const m=Math.floor(pomState.remaining/60),s=pomState.remaining%60;
  const pad=n=>String(n).padStart(2,'0');
  el.innerHTML =
    '<div class="pom-mode-badge '+(pomState.mode==='work'?'pom-work':'pom-break')+'">'+(pomState.mode==='work'?'Work':'Break')+'</div>' +
    '<div class="pom-time">'+pad(m)+':'+pad(s)+'</div>' +
    '<div class="pom-sessions">Sessions: '+pomState.sessions+'</div>' +
    '<div class="pom-controls">' +
      (!pomState.running ? '<button class="cm-util-btn" onclick="pomStart()">▶ Start</button>' : '<button class="cm-util-btn" onclick="pomPause()">⏸ Pause</button>') +
      '<button class="cm-util-btn secondary" onclick="pomReset()">↺ Reset</button>' +
    '</div>' +
    '<div class="pom-settings">' +
      '<label>Work <input type="number" value="'+pomState.workMins+'" min="1" max="60" oninput="pomSetWork(parseInt(this.value)||25)" style="width:40px;" /> min</label>' +
      '<label>Break <input type="number" value="'+pomState.breakMins+'" min="1" max="30" oninput="pomSetBreak(parseInt(this.value)||5)" style="width:40px;" /> min</label>' +
    '</div>';
}

function swStart() { if(stopwatchState.running)return; stopwatchState.running=true; stopwatchState.interval=setInterval(()=>{stopwatchState.elapsed++;renderSw();},1000); renderSw(); }
function swPause() { stopwatchState.running=false; clearInterval(stopwatchState.interval); renderSw(); }
function swReset() { swPause(); stopwatchState.elapsed=0; renderSw(); }
function renderSw() {
  const el=document.getElementById('cmSwDisplay'); if(!el) return;
  const t=fmtTime(stopwatchState.elapsed);
  el.innerHTML =
    '<div class="pom-time sw-time">'+t+'</div>' +
    '<div class="pom-controls">' +
      (!stopwatchState.running ? '<button class="cm-util-btn" onclick="swStart()">▶ Start</button>' : '<button class="cm-util-btn" onclick="swPause()">⏸ Pause</button>') +
      '<button class="cm-util-btn secondary" onclick="swReset()">↺ Reset</button>' +
    '</div>';
}

function saveNote(v) { cmNotes=v; localStorage.setItem('dp_cmnotes',v); }
function renderNotes() {
  const el=document.getElementById('cmNotesArea'); if(!el) return;
  el.value = cmNotes;
}

function openCmTab(tab) {
  document.querySelectorAll('.cm-util-tab').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  document.querySelectorAll('.cm-util-panel').forEach(p=>p.style.display = p.dataset.panel===tab ? '' : 'none');
  if(tab==='pom') renderPom();
  if(tab==='sw') renderSw();
  if(tab==='notes') renderNotes();
}

// ── WAKE LOCK ──
let wakeLock=null,silentPingInterval=null,wakeLockHeartbeat=null,wakeLockEnabled=false;

function playSilentPing() {
  try {
    if(!audioCtx) audioCtx=new(window.AudioContext||window.webkitAudioContext)();
    if(audioCtx.state==='suspended') audioCtx.resume();
    const buf=audioCtx.createBuffer(1,Math.max(1,audioCtx.sampleRate*0.05),audioCtx.sampleRate);
    const src=audioCtx.createBufferSource();src.buffer=buf;
    const gain=audioCtx.createGain();gain.gain.value=0.001;
    src.connect(gain);gain.connect(audioCtx.destination);src.start();
  } catch(e){}
}

async function requestWakeLock() {
  if(!('wakeLock' in navigator)) return;
  try {
    if(wakeLock){try{await wakeLock.release();}catch(e){}wakeLock=null;}
    wakeLock=await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release',()=>{wakeLock=null;if(wakeLockEnabled&&document.visibilityState==='visible')setTimeout(requestWakeLock,500);});
    updateWakeLockUI(true);
  } catch(e){updateWakeLockUI(false);}
}

function updateWakeLockUI(active) {
  const btn=document.getElementById('wakeLockBtn'),lbl=document.getElementById('wlLabel');
  if(!btn||!lbl) return;
  btn.classList.toggle('active',active);lbl.textContent=active?'Awake':'Screen lock';
}

async function enableWakeLock() {
  wakeLockEnabled=true;await requestWakeLock();
  if(silentPingInterval) clearInterval(silentPingInterval);
  silentPingInterval=setInterval(playSilentPing,20000);
  if(wakeLockHeartbeat) clearInterval(wakeLockHeartbeat);
  wakeLockHeartbeat=setInterval(async()=>{if(document.visibilityState==='visible'&&!wakeLock)await requestWakeLock();},10000);
}

document.addEventListener('visibilitychange',async()=>{if(document.visibilityState==='visible'&&wakeLockEnabled){await requestWakeLock();if(audioCtx&&audioCtx.state==='suspended')audioCtx.resume();}});
window.addEventListener('focus',async()=>{if(wakeLockEnabled&&!wakeLock)await requestWakeLock();});
window.addEventListener('pageshow',async()=>{if(wakeLockEnabled)await requestWakeLock();});
document.addEventListener('click',function _fc(){
  if(!audioCtx) audioCtx=new(window.AudioContext||window.webkitAudioContext)();
  if(audioCtx.state==='suspended') audioCtx.resume().then(()=>enableWakeLock());
  else enableWakeLock();
  document.removeEventListener('click',_fc);
},{once:true});

// ── CLOCK TICK ──
function tickClock() {
  const now=new Date(),h=now.getHours(),m=now.getMinutes(),s=now.getSeconds();
  const ampm=h>=12?'PM':'AM',h12=h%12||12;
  const pad=n=>String(n).padStart(2,'0');
  const ckEl=document.getElementById('clockTime');
  if(ckEl){ for(const node of ckEl.childNodes){ if(node.nodeType===3){ node.textContent=`${pad(h12)}:${pad(m)}:${pad(s)}`; break; } } }
  document.getElementById('clockAmpm').textContent=ampm;
  document.getElementById('clockDate').textContent=DAYS[now.getDay()]+', '+MONTHS[now.getMonth()]+' '+now.getDate()+', '+now.getFullYear();
  checkAutoStart(now);checkAlarms(now);checkDeadlineWarnings(now);checkInReminders();
}

function checkAutoStart(now) {
  const pad=n=>String(n).padStart(2,'0');
  const cur=`${pad(now.getHours())}:${pad(now.getMinutes())}`;
  tasks.forEach(task=>{if(task.startTime&&task.startTime===cur&&!task.running&&(task.elapsed||0)===0)startTimer(task.id);});
}

// ── MOBILE NAV ──
function mobileTab(tab) {
  document.querySelectorAll('.mnav-btn').forEach(b=>b.classList.remove('active'));
  const btn=document.getElementById('mnav-'+tab);if(btn)btn.classList.add('active');
  if(window.innerWidth>900) return;
  const tp=document.getElementById('taskPanel'),ma=document.querySelector('.main-area'),cp=document.querySelector('.panel.right');
  [tp,ma,cp].forEach(el=>{if(el)el.classList.add('hidden-mobile');});
  if(tab==='tasks'){tp.classList.remove('hidden-mobile');document.getElementById('mainTasks').style.display='';document.getElementById('mainTimeline').style.display='none';}
  else if(tab==='timeline'){ma.classList.remove('hidden-mobile');document.getElementById('mainTasks').style.display='none';document.getElementById('mainTimeline').style.display='';renderTimeline();}
  else if(tab==='calendar'){cp.classList.remove('hidden-mobile');}
}

function handleResize() {
  const isMobile=window.innerWidth<=900;
  const mobileNav=document.getElementById('mobileNav');
  if(isMobile){mobileNav.style.display='block';mobileTab('tasks');}
  else{
    mobileNav.style.display='none';
    const tp=document.getElementById('taskPanel'),ma=document.querySelector('.main-area'),cp=document.querySelector('.panel.right');
    [tp,ma,cp].forEach(el=>{if(el)el.classList.remove('hidden-mobile');});
  }
}
window.addEventListener('resize',handleResize);

// ═══════════════════════════════════════════════════
// ── TERMINAL ──
// ═══════════════════════════════════════════════════
let termHistory = [], termHistIdx = -1, termOpen = false;

function toggleTerminal() {
  termOpen = !termOpen;
  const panel = document.getElementById('termPanel');
  panel.classList.toggle('open', termOpen);
  if (termOpen) {
    if (!document.getElementById('termOutput').children.length) termWelcome();
    document.getElementById('termInput').focus();
  }
}

function termWelcome() {
  termPrint('head', '  Daily Planner Terminal  ');
  termPrint('dim',  '  type help for commands  ');
  termPrint('dim',  '──────────────────────────');
}

function termPrint(cls, text) {
  const out = document.getElementById('termOutput');
  const el = document.createElement('div');
  el.className = 't-line t-' + cls;
  el.textContent = text;
  out.appendChild(el);
  out.scrollTop = out.scrollHeight;
}

function termEcho(cmd, result) {
  termPrint('prompt', 'planner> ' + cmd);
  if (Array.isArray(result)) result.forEach(([c,t]) => termPrint(c,t));
  else if (result) termPrint('out', result);
}

function termError(msg) { termPrint('err', '✕  ' + msg); }
function termOk(msg)    { termPrint('ok',  '✓  ' + msg); }
function termWarn(msg)  { termPrint('warn','⚠  ' + msg); }

// ── PARSE HELPERS ──
function parseArgs(str) {
  // split on spaces but keep quoted strings together
  const args = [];
  let cur = '', inQ = false, q = '';
  for (const ch of str) {
    if ((ch === '"' || ch === "'") && !inQ) { inQ = true; q = ch; }
    else if (ch === q && inQ)               { inQ = false; q = ''; }
    else if (ch === ' ' && !inQ)            { if (cur) { args.push(cur); cur = ''; } }
    else cur += ch;
  }
  if (cur) args.push(cur);
  return args;
}

function parseTimeArg(str) {
  // Accepts: 14:30, 2:30pm, 2pm, 14h30, 230pm
  if (!str) return '';
  str = str.toLowerCase().trim();
  const ampm = str.includes('am') ? 'am' : str.includes('pm') ? 'pm' : null;
  str = str.replace(/[ap]m/, '');
  let h, m = 0;
  if (str.includes(':')) { [h, m] = str.split(':').map(Number); }
  else if (str.length <= 2) { h = parseInt(str); }
  else { h = parseInt(str.slice(0, -2)); m = parseInt(str.slice(-2)); }
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2,'0')}:${String(m||0).padStart(2,'0')}`;
}

function parseDateArg(str) {
  // Accepts: today, tomorrow, mon, 2025-12-25, 25/12, dec25, 25dec
  if (!str) return toDateStr(new Date());
  str = str.toLowerCase().trim();
  const now = new Date();
  if (str === 'today')    return toDateStr(now);
  if (str === 'tomorrow') { const d = new Date(now); d.setDate(d.getDate()+1); return toDateStr(d); }
  const days = ['sun','mon','tue','wed','thu','fri','sat'];
  const dayIdx = days.indexOf(str.slice(0,3));
  if (dayIdx !== -1) {
    const d = new Date(now); let diff = dayIdx - d.getDay();
    if (diff <= 0) diff += 7;
    d.setDate(d.getDate() + diff);
    return toDateStr(d);
  }
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  // dec25 or 25dec
  for (let i = 0; i < months.length; i++) {
    const mo = months[i];
    if (str.startsWith(mo)) { const day = parseInt(str.slice(3)); return `${now.getFullYear()}-${String(i+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`; }
    if (str.endsWith(mo))   { const day = parseInt(str.slice(0,-3)); return `${now.getFullYear()}-${String(i+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`; }
  }
  if (str.includes('-')) return str; // already yyyy-mm-dd
  if (str.includes('/')) { const [d,m] = str.split('/'); return `${now.getFullYear()}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`; }
  return toDateStr(now);
}

function findTask(q)     { return tasks.find(t => t.id===q || t.name.toLowerCase().includes(q.toLowerCase())); }
function findEvent(q)    { return events.find(e => e.id===q || e.name.toLowerCase().includes(q.toLowerCase())); }
function findDeadline(q) { return deadlines.find(d => d.id===q || d.name.toLowerCase().includes(q.toLowerCase())); }
function findAlarm(q)    { return alarms.find(a => a.id===q || a.label.toLowerCase().includes(q.toLowerCase()) || a.time===q); }

// ── COMMAND ROUTER ──
function termRun(raw) {
  raw = raw.trim();
  if (!raw) return;
  termHistory.unshift(raw);
  termHistIdx = -1;
  const parts = parseArgs(raw);
  const cmd = parts[0]?.toLowerCase();
  const sub = parts[1]?.toLowerCase();
  const rest = parts.slice(2);

  try {
    switch (cmd) {
      case 'help': case '?': cmdHelp(sub); break;
      case 'task': case 't': cmdTask(sub, rest); break;
      case 'event': case 'ev': cmdEvent(sub, rest); break;
      case 'deadline': case 'dl': cmdDeadline(sub, rest); break;
      case 'alarm': case 'al': cmdAlarm(sub, rest); break;
      case 'ls': case 'list': cmdList(sub); break;
      case 'rm': case 'del': case 'delete': cmdDelete(sub, rest); break;
      case 'edit': cmdEdit(sub, rest); break;
      case 'start': cmdTimerCtl('start', sub); break;
      case 'stop': case 'pause': cmdTimerCtl('stop', sub); break;
      case 'reset': cmdTimerCtl('reset', sub); break;
      case 'done': cmdTimerCtl('done', sub); break;
      case 'clock': openClockMode(); termOk('Clock mode opened'); break;
      case 'clear': case 'cls': document.getElementById('termOutput').innerHTML = ''; break;
      case 'sync': syncLoad().then(()=>termOk('Synced with Firebase')).catch(()=>termError('Sync failed')); break;
      case 'firebase': case 'fb': cmdFirebase(sub, rest); break;
      case 'stats': cmdStats(); break;
      case 'export': cmdExport(sub); break;
      case 'purge': cmdPurge(sub, rest); break;
      case 'check': case 'tick': cmdTimerCtl('done', sub); break;
      case 'weather': fetchWeather(); termOk('Fetching weather…'); break;
      case 'pomodoro': case 'pom': openClockMode(); setTimeout(()=>openCmTab('pom'),200); termOk('Opened pomodoro timer'); break;
      case 'stopwatch': case 'sw': openClockMode(); setTimeout(()=>openCmTab('sw'),200); termOk('Opened stopwatch'); break;
      case 'note': case 'notes': { const txt=rest.join(' '); if(txt){ cmNotes=(cmNotes?cmNotes+'\n':'')+txt; localStorage.setItem('dp_cmnotes',cmNotes); termOk('Note saved'); } else { termPrint('head','Quick Notes:'); (cmNotes||'(empty)').split('\n').forEach(l=>termPrint('out','  '+l)); } break; }
      case 'today': cmdToday(); break;
      case 'summarize': cmdSummarize(); break;
      case 'reschedule': case 'shift': cmdReschedule(sub, rest); break;
      case 'block': cmdBlock(sub, rest); break;
      case 'in': cmdRemindIn(sub, rest); break;
      case 'analytics': case 'analytics': cmdAnalytics(sub); break;
      case 'focus': cmdFocus(sub); break;
      case 'review': openDailyReview(); termOk('Opening daily review…'); break;
      case 'audit': openTimeAudit(); termOk('Opening time audit…'); break;
      case 'autoschedule': case 'auto': cmdAutoSchedule(); break;
      case 'unblock': cmdUnblock(sub, rest); break;
      case 'blocks': case 'ls-blocks': cmdListBlocks(); break;
      default: termError(`Unknown command: ${cmd}. Type 'help' for commands.`);
    }
  } catch(e) { termError(e.message); }
}

// ── HELP ──
function cmdHelp(topic) {
  if (!topic) {
    termPrint('head', 'Commands:');
    const cmds = [
      ['task add',      'Add a task'],
      ['task ls',       'List tasks'],
      ['task edit',     'Edit a task'],
      ['task rm',       'Delete a task'],
      ['event add',     'Add an event'],
      ['event ls',      'List events'],
      ['event edit',    'Edit an event'],
      ['event rm',      'Delete an event'],
      ['deadline add',  'Add a deadline'],
      ['deadline ls',   'List deadlines'],
      ['deadline edit', 'Edit a deadline'],
      ['deadline rm',   'Delete a deadline'],
      ['alarm add',     'Add an alarm'],
      ['alarm ls',      'List alarms'],
      ['alarm rm',      'Delete an alarm'],
      ['start <name>',  'Start task timer'],
      ['stop <name>',   'Pause task timer'],
      ['reset <name>',  'Reset task timer'],
      ['ls',            'List everything'],
      ['clear',         'Clear terminal'],
      ['sync',          'Force Firebase sync'],
      ['clock',         'Open clock mode'],
      ['firebase get',  'Fetch raw Firebase data'],
      ['fb count',      'Count Firebase records'],
      ['fb status',     'Show sync status'],
      ['stats',         'Planner statistics'],
      ['export',        'Download data as JSON'],
      ['export tasks',  'Print tasks JSON'],
      ['purge done',    'Remove completed tasks'],
      ['purge done-dl', 'Remove completed deadlines'],
      ['today',         'Show today summary'],
      ['note <text>',   'Add quick note'],
      ['notes',         'Show notes'],
      ['pomodoro',      'Open pomodoro timer'],
      ['stopwatch',     'Open stopwatch'],
      ['weather',       'Refresh weather'],
      ['check <n>',     'Mark task done (alias for done)'],
    ];
    cmds.forEach(([c,d]) => termPrint('out', `  ${c.padEnd(20)} ${d}`));
    termPrint('dim', "  Type 'help task' for task syntax");
    return;
  }
  const helpText = {
    task: [
      ['head','task add <name> [options]'],
      ['out', '  Options:'],
      ['out', '  -p low|medium|high|critical   priority (default: medium)'],
      ['out', '  -d <minutes>                  duration (default: 30)'],
      ['out', '  -t <time>                     start time e.g. 14:30, 2pm'],
      ['out', ''],
      ['out', '  Examples:'],
      ['out', "  task add 'Study chem' -p high -d 60 -t 3pm"],
      ['out', "  task add Robotics -d 90 -t 14:30"],
      ['out', ''],
      ['head','task edit <name> [options]  (same options as add)'],
      ['head','task rm <name>'],
      ['head','task ls'],
    ],
    event: [
      ['head','event add <name> [options]'],
      ['out', '  Options:'],
      ['out', '  -p low|medium|high|critical'],
      ['out', '  -d <minutes>                  duration'],
      ['out', '  -t <time>                     time'],
      ['out', '  -s once|daily|weekdays|custom schedule'],
      ['out', '  --date <date>                 for one-time events'],
      ['out', ''],
      ['out', '  Date formats: today, tomorrow, mon, dec25, 2025-12-25'],
      ['out', "  event add 'Team meeting' -t 10am -d 60 -s weekdays"],
      ['out', "  event add 'Dentist' -t 2pm --date tomorrow"],
    ],
    deadline: [
      ['head','deadline add <name> [options]'],
      ['out', '  Options:'],
      ['out', '  -p low|medium|high|critical'],
      ['out', '  --date <date>  (required)'],
      ['out', ''],
      ['out', "  deadline add 'Chem lab report' --date friday -p high"],
      ['out', "  deadline add 'FLL submission' --date dec25"],
    ],
    alarm: [
      ['head','alarm add <time> [label]'],
      ['out', '  alarm add 7:30am Wake up'],
      ['out', '  alarm add 14:00 Lunch'],
      ['head','alarm rm <time or label>'],
      ['head','alarm ls'],
    ],
  };
  const lines = helpText[topic];
  if (!lines) { termError(`No help for '${topic}'`); return; }
  lines.forEach(([c,t]) => termPrint(c,t));
}

// ── TASK COMMANDS ──
function cmdTask(sub, args) {
  if (sub === 'add' || sub === 'a') {
    const name = args.shift();
    if (!name) { termError('Name required: task add <name>'); return; }
    const opts = parseOpts(args);
    const task = {
      id: uid(), name,
      importance: normalizeImp(opts['-p'] || opts['--priority'] || 'medium'),
      duration: parseInt(opts['-d'] || opts['--duration'] || '30') || 30,
      startTime: opts['-t'] || opts['--time'] ? parseTimeArg(opts['-t'] || opts['--time']) : '',
      elapsed: 0, running: false, done: false
    };
    tasks.push(task); save(); renderTasks(); renderCalendar(); renderTimeline();
    termOk(`Task added: "${name}" [${task.importance}] ${task.duration}min${task.startTime?' @ '+task.startTime:''}`);

  } else if (sub === 'rm' || sub === 'del' || sub === 'delete') {
    const q = args.join(' '); const t = findTask(q);
    if (!t) { termError(`Task not found: ${q}`); return; }
    stopTimer(t.id); tasks = tasks.filter(x => x.id !== t.id);
    save(); renderTasks(); renderCalendar(); renderTimeline();
    termOk(`Deleted task: "${t.name}"`);

  } else if (sub === 'edit' || sub === 'e') {
    const q = args.shift(); const t = findTask(q);
    if (!t) { termError(`Task not found: ${q}`); return; }
    const opts = parseOpts(args);
    if (opts['-n'] || opts['--name'])     t.name       = opts['-n'] || opts['--name'];
    if (opts['-p'] || opts['--priority']) t.importance = normalizeImp(opts['-p'] || opts['--priority']);
    if (opts['-d'] || opts['--duration']) t.duration   = parseInt(opts['-d'] || opts['--duration']) || t.duration;
    if (opts['-t'] || opts['--time'])     t.startTime  = parseTimeArg(opts['-t'] || opts['--time']);
    t.elapsed = 0; stopTimer(t.id); save(); renderTasks(); renderCalendar(); renderTimeline();
    termOk(`Updated task: "${t.name}"`);

  } else if (sub === 'ls' || sub === 'list' || !sub) {
    if (!tasks.length) { termWarn('No tasks'); return; }
    termPrint('head', `Tasks (${tasks.length}):`);
    tasks.forEach(t => {
      const timer = t.running ? ` ▶ ${fmtTime(Math.max(t.duration*60-(t.elapsed||0),0))}` : '';
      termPrint('out', `  ${t.name.padEnd(24)} [${t.importance.padEnd(8)}] ${t.duration}min${t.startTime?' @'+t.startTime:''}${timer}`);
    });
  } else { termError(`Unknown task subcommand: ${sub}`); }
}

// ── EVENT COMMANDS ──
function cmdEvent(sub, args) {
  if (sub === 'add' || sub === 'a') {
    const name = args.shift();
    if (!name) { termError('Name required: event add <name>'); return; }
    const opts = parseOpts(args);
    const schedType = opts['-s'] || opts['--schedule'] || 'once';
    let schedDays = [];
    if (schedType === 'weekdays') schedDays = [1,2,3,4,5];
    else if (schedType === 'daily') schedDays = [0,1,2,3,4,5,6];
    const ev = {
      id: uid(), name,
      importance: normalizeImp(opts['-p'] || opts['--priority'] || 'medium'),
      duration: parseInt(opts['-d'] || opts['--duration'] || '60') || 60,
      time: opts['-t'] || opts['--time'] ? parseTimeArg(opts['-t'] || opts['--time']) : '',
      scheduleType: schedType,
      date: schedType === 'once' ? parseDateArg(opts['--date'] || opts['-dt'] || 'today') : '',
      schedDays,
      recurring: !!(opts['--recurring'] || opts['-r']),
      recurWeeks: parseInt(opts['--every'] || '1') || 1
    };
    events.push(ev); save(); renderEventList(); renderCalendar(); renderTimeline();
    termOk(`Event added: "${name}" [${ev.scheduleType}]${ev.time?' @ '+ev.time:''}${ev.date?' on '+ev.date:''}`);

  } else if (sub === 'rm' || sub === 'del' || sub === 'delete') {
    const q = args.join(' '); const ev = findEvent(q);
    if (!ev) { termError(`Event not found: ${q}`); return; }
    events = events.filter(e => e.id !== ev.id);
    save(); renderEventList(); renderCalendar(); renderTimeline();
    termOk(`Deleted event: "${ev.name}"`);

  } else if (sub === 'edit' || sub === 'e') {
    const q = args.shift(); const ev = findEvent(q);
    if (!ev) { termError(`Event not found: ${q}`); return; }
    const opts = parseOpts(args);
    if (opts['-n'] || opts['--name'])     ev.name       = opts['-n'] || opts['--name'];
    if (opts['-p'] || opts['--priority']) ev.importance = normalizeImp(opts['-p'] || opts['--priority']);
    if (opts['-d'] || opts['--duration']) ev.duration   = parseInt(opts['-d'] || opts['--duration']) || ev.duration;
    if (opts['-t'] || opts['--time'])     ev.time       = parseTimeArg(opts['-t'] || opts['--time']);
    if (opts['--date'] || opts['-dt'])    ev.date       = parseDateArg(opts['--date'] || opts['-dt']);
    save(); renderEventList(); renderCalendar(); renderTimeline();
    termOk(`Updated event: "${ev.name}"`);

  } else if (sub === 'ls' || sub === 'list' || !sub) {
    if (!events.length) { termWarn('No events'); return; }
    termPrint('head', `Events (${events.length}):`);
    events.forEach(ev => {
      const sched = ev.scheduleType === 'once' ? ev.date : ev.scheduleType;
      termPrint('out', `  ${ev.name.padEnd(24)} [${ev.importance.padEnd(8)}] ${ev.duration}min${ev.time?' @'+ev.time:''} ${sched}`);
    });
  } else { termError(`Unknown event subcommand: ${sub}`); }
}

// ── DEADLINE COMMANDS ──
function cmdDeadline(sub, args) {
  if (sub === 'add' || sub === 'a') {
    const name = args.shift();
    if (!name) { termError('Name required: deadline add <name>'); return; }
    const opts = parseOpts(args);
    const date = parseDateArg(opts['--date'] || opts['-dt'] || opts['-d'] || '');
    const dl = { id: uid(), name, importance: normalizeImp(opts['-p'] || opts['--priority'] || 'medium'), date };
    deadlines.push(dl); saveDeadlines(); renderDeadlines(); renderCalendar();
    const cd = deadlineCountdown(date);
    termOk(`Deadline added: "${name}" due ${date} (${cd.label})`);

  } else if (sub === 'rm' || sub === 'del' || sub === 'delete') {
    const q = args.join(' '); const dl = findDeadline(q);
    if (!dl) { termError(`Deadline not found: ${q}`); return; }
    deadlines = deadlines.filter(d => d.id !== dl.id);
    saveDeadlines(); renderDeadlines(); renderCalendar();
    termOk(`Deleted deadline: "${dl.name}"`);

  } else if (sub === 'edit' || sub === 'e') {
    const q = args.shift(); const dl = findDeadline(q);
    if (!dl) { termError(`Deadline not found: ${q}`); return; }
    const opts = parseOpts(args);
    if (opts['-n'] || opts['--name'])     dl.name       = opts['-n'] || opts['--name'];
    if (opts['-p'] || opts['--priority']) dl.importance = normalizeImp(opts['-p'] || opts['--priority']);
    if (opts['--date'] || opts['-dt'] || opts['-d']) dl.date = parseDateArg(opts['--date'] || opts['-dt'] || opts['-d']);
    saveDeadlines(); renderDeadlines(); renderCalendar();
    termOk(`Updated deadline: "${dl.name}"`);

  } else if (sub === 'ls' || sub === 'list' || !sub) {
    if (!deadlines.length) { termWarn('No deadlines'); return; }
    termPrint('head', `Deadlines (${deadlines.length}):`);
    const sorted = [...deadlines].sort((a,b) => a.date.localeCompare(b.date));
    sorted.forEach(dl => {
      const cd = deadlineCountdown(dl.date);
      termPrint('out', `  ${dl.name.padEnd(24)} [${dl.importance.padEnd(8)}] ${dl.date}  ${cd.label}`);
    });
  } else { termError(`Unknown deadline subcommand: ${sub}`); }
}

// ── ALARM COMMANDS ──
function cmdAlarm(sub, args) {
  if (sub === 'add' || sub === 'a') {
    const timeRaw = args.shift();
    if (!timeRaw) { termError('Time required: alarm add <time> [label]'); return; }
    const time = parseTimeArg(timeRaw);
    const label = args.join(' ') || 'Alarm';
    alarms.push({ id: uid(), time, label, on: true, fired: false });
    saveAlarms(); renderAlarms();
    termOk(`Alarm set: ${time} — "${label}"`);

  } else if (sub === 'rm' || sub === 'del') {
    const q = args.join(' '); const al = findAlarm(q);
    if (!al) { termError(`Alarm not found: ${q}`); return; }
    alarms = alarms.filter(a => a.id !== al.id);
    saveAlarms(); renderAlarms();
    termOk(`Deleted alarm: ${al.time} "${al.label}"`);

  } else if (sub === 'ls' || sub === 'list' || !sub) {
    if (!alarms.length) { termWarn('No alarms'); return; }
    termPrint('head', `Alarms (${alarms.length}):`);
    alarms.forEach(a => termPrint('out', `  ${a.time}  ${a.label.padEnd(20)} ${a.on ? '[ON]' : '[OFF]'}`));
  } else { termError(`Unknown alarm subcommand: ${sub}`); }
}

// ── LIST ALL ──
function cmdList(sub) {
  const target = sub || 'all';
  if (target === 'all' || target === 'tasks' || target === 't') {
    termPrint('head', `Tasks (${tasks.length}):`);
    if (!tasks.length) termPrint('dim','  (none)');
    tasks.forEach(t => termPrint('out', `  ${t.name.padEnd(24)} [${t.importance.padEnd(8)}] ${t.duration}min${t.startTime?' @'+t.startTime:''}${t.running?' ▶':''}`));
  }
  if (target === 'all' || target === 'events' || target === 'ev') {
    termPrint('head', `Events (${events.length}):`);
    if (!events.length) termPrint('dim','  (none)');
    events.forEach(ev => { const s = ev.scheduleType==='once'?ev.date:ev.scheduleType; termPrint('out', `  ${ev.name.padEnd(24)} [${ev.importance.padEnd(8)}] ${ev.duration}min${ev.time?' @'+ev.time:''} ${s}`); });
  }
  if (target === 'all' || target === 'deadlines' || target === 'dl') {
    const sorted = [...deadlines].sort((a,b)=>a.date.localeCompare(b.date));
    termPrint('head', `Deadlines (${deadlines.length}):`);
    if (!sorted.length) termPrint('dim','  (none)');
    sorted.forEach(dl => { const cd=deadlineCountdown(dl.date); termPrint('out', `  ${dl.name.padEnd(24)} [${dl.importance.padEnd(8)}] ${dl.date}  ${cd.label}`); });
  }
  if (target === 'all' || target === 'alarms' || target === 'al') {
    termPrint('head', `Alarms (${alarms.length}):`);
    if (!alarms.length) termPrint('dim','  (none)');
    alarms.forEach(a => termPrint('out', `  ${a.time}  ${a.label.padEnd(20)} ${a.on?'[ON]':'[OFF]'}`));
  }
}

// ── DELETE (shorthand) ──
function cmdDelete(sub, args) {
  // rm task <name> | rm event <name> | rm deadline <name> | rm alarm <name>
  const q = args.join(' ');
  if (sub === 'task' || sub === 't')         { const t=findTask(q); if(!t){termError('Task not found: '+q);return;} stopTimer(t.id);tasks=tasks.filter(x=>x.id!==t.id);save();renderTasks();renderCalendar();termOk('Deleted task: "'+t.name+'"'); }
  else if (sub === 'event' || sub === 'ev')  { const e=findEvent(q); if(!e){termError('Event not found: '+q);return;} events=events.filter(x=>x.id!==e.id);save();renderEventList();renderCalendar();termOk('Deleted event: "'+e.name+'"'); }
  else if (sub === 'deadline' || sub === 'dl'){ const d=findDeadline(q); if(!d){termError('Deadline not found: '+q);return;} deadlines=deadlines.filter(x=>x.id!==d.id);saveDeadlines();renderDeadlines();renderCalendar();termOk('Deleted deadline: "'+d.name+'"'); }
  else if (sub === 'alarm' || sub === 'al')  { const a=findAlarm(q); if(!a){termError('Alarm not found: '+q);return;} alarms=alarms.filter(x=>x.id!==a.id);saveAlarms();renderAlarms();termOk('Deleted alarm: '+a.time+' "'+a.label+'"'); }
  else termError('Specify type: rm task|event|deadline|alarm <name>');
}

// ── EDIT (shorthand) ──
function cmdEdit(sub, args) {
  const q = args.shift();
  if (sub === 'task' || sub === 't')          cmdTask('edit', [q, ...args]);
  else if (sub === 'event' || sub === 'ev')   cmdEvent('edit', [q, ...args]);
  else if (sub === 'deadline' || sub === 'dl') cmdDeadline('edit', [q, ...args]);
  else termError('Specify type: edit task|event|deadline <name> [options]');
}

// ── TIMER CONTROLS ──
function cmdTimerCtl(action, q) {
  if (!q) { termError(`Specify task name: ${action} <name>`); return; }
  const t = findTask(q);
  if (!t) { termError(`Task not found: ${q}`); return; }
  if (action === 'start') { startTimer(t.id); termOk(`Started: "${t.name}"`); }
  else if (action === 'stop') { stopTimer(t.id); termOk(`Paused: "${t.name}"`); }
  else if (action === 'reset') { resetTimer(t.id); termOk(`Reset: "${t.name}"`); }
  else if (action === 'done') { stopTimer(t.id); t.elapsed = t.duration*60; save(); renderTasks(); termOk(`Marked done: "${t.name}"`); }
}

// ── OPTION PARSER ──
function parseOpts(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-')) { opts[args[i]] = args[i+1] || true; i++; }
  }
  return opts;
}

function normalizeImp(s) {
  if (!s) return 'medium';
  s = s.toLowerCase();
  if (s === 'c' || s === 'crit' || s === 'critical') return 'critical';
  if (s === 'h' || s === 'hi')   return 'high';
  if (s === 'l' || s === 'lo')   return 'low';
  return 'medium';
}

// ── FIREBASE RAW DATA COMMAND ──
async function cmdFirebase(sub, args) {
  if (!db) { termError('Firebase not connected'); return; }
  const validSubs = ['get','raw','dump','count','collections'];
  if (!sub || sub === 'get' || sub === 'raw' || sub === 'dump') {
    termPrint('dim', 'Fetching from Firestore…');
    try {
      const snap = await db.collection('planner').doc('data').get();
      if (!snap.exists) { termWarn('Document does not exist in Firestore'); return; }
      const d = snap.data();
      termPrint('head', '── Firebase Raw Data ──');
      termPrint('out', 'Collection: planner / doc: data');
      termPrint('out', 'Updated: ' + (d.updated ? new Date(d.updated).toLocaleString() : 'unknown'));
      termPrint('dim',  '──────────────────────');
      termPrint('head', 'tasks (' + (d.tasks||[]).length + '):');
      (d.tasks||[]).forEach((t,i) => {
        termPrint('out', '  ['+i+'] id:'+t.id+' name:'+JSON.stringify(t.name)+' imp:'+t.importance+' dur:'+t.duration+(t.startTime?' @'+t.startTime:'')+' elapsed:'+t.elapsed+' running:'+t.running);
      });
      termPrint('head', 'events (' + (d.events||[]).length + '):');
      (d.events||[]).forEach((e,i) => {
        termPrint('out', '  ['+i+'] id:'+e.id+' name:'+JSON.stringify(e.name)+' imp:'+e.importance+' sched:'+e.scheduleType+(e.time?' @'+e.time:'')+' dur:'+e.duration);
      });
      termPrint('head', 'deadlines (' + (d.deadlines||[]).length + '):');
      (d.deadlines||[]).forEach((dl,i) => {
        termPrint('out', '  ['+i+'] id:'+dl.id+' name:'+JSON.stringify(dl.name)+' imp:'+dl.importance+' date:'+dl.date);
      });
      termPrint('dim', '──────────────────────');
      if (args && args[0] === '--json') {
        termPrint('out', JSON.stringify({tasks:d.tasks,events:d.events,deadlines:d.deadlines,updated:d.updated}, null, 2));
      } else {
        termPrint('dim', "  tip: 'fb get --json' to see full JSON");
      }
    } catch(e) { termError('Firestore error: ' + e.message); }
  } else if (sub === 'count') {
    termPrint('head', 'Local counts:');
    termPrint('out', '  tasks:     ' + tasks.length);
    termPrint('out', '  events:    ' + events.length);
    termPrint('out', '  deadlines: ' + deadlines.length);
    termPrint('out', '  alarms:    ' + alarms.length);
  } else if (sub === 'status') {
    const el = document.getElementById('syncStatus');
    termPrint('out', 'Sync status: ' + (el ? el.textContent : 'unknown'));
    termPrint('out', 'DB connected: ' + (db ? 'yes' : 'no'));
    termPrint('out', 'syncEnabled: ' + syncEnabled);
  } else {
    termError('Usage: fb [get|count|status] [--json]');
  }
}

// ── STATS COMMAND ──
function cmdStats() {
  termPrint('head', '── Planner Stats ──');
  const done = tasks.filter(t=>t.checked).length;
  const running = tasks.filter(t=>t.running).length;
  const totalMins = tasks.reduce((s,t)=>s+t.duration,0);
  const elapsedMins = tasks.reduce((s,t)=>s+Math.floor((t.elapsed||0)/60),0);
  termPrint('out', '  Tasks:       ' + tasks.length + ' total, ' + done + ' done, ' + running + ' running');
  termPrint('out', '  Time planned:' + totalMins + 'min  |  Elapsed: ' + elapsedMins + 'min');
  const today=new Date(); today.setHours(0,0,0,0);
  const overdue = deadlines.filter(dl=>{ const due=new Date(dl.date+'T00:00:00'); return due<today && !dl.checked; }).length;
  termPrint('out', '  Deadlines:   ' + deadlines.length + ' total, ' + overdue + ' overdue');
  termPrint('out', '  Events:      ' + events.length + ' total');
  termPrint('out', '  Alarms:      ' + alarms.filter(a=>a.on).length + ' active');
  termPrint('dim', '  localStorage: ' + (JSON.stringify({tasks,events,deadlines}).length/1024).toFixed(1) + 'KB');
}

// ── EXPORT COMMAND ──
function cmdExport(fmt) {
  try {
    const data = { tasks, events, deadlines, alarms, exported: new Date().toISOString() };
    if (fmt === 'tasks') {
      termPrint('head', 'Tasks JSON:');
      termPrint('out', JSON.stringify(tasks, null, 2));
    } else if (fmt === 'deadlines' || fmt === 'dl') {
      termPrint('head', 'Deadlines JSON:');
      termPrint('out', JSON.stringify(deadlines, null, 2));
    } else {
      const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href=url; a.download='planner-export-'+toDateStr(new Date())+'.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      termOk('Downloaded planner-export-'+toDateStr(new Date())+'.json');
    }
  } catch(e) { termError('Export failed: '+e.message); }
}

// ── PURGE COMMAND ──
function cmdPurge(sub, args) {
  if (!sub) { termError('Usage: purge done-tasks | done-deadlines | all-tasks | all-events'); return; }
  if (sub === 'done-tasks' || sub === 'done') {
    const before = tasks.length;
    tasks.filter(t=>t.checked).forEach(t=>stopTimer(t.id));
    tasks = tasks.filter(t=>!t.checked);
    save(); renderTasks(); renderTimeline();
    termOk('Removed ' + (before-tasks.length) + ' completed tasks');
  } else if (sub === 'done-deadlines' || sub === 'done-dl') {
    const before = deadlines.length;
    deadlines = deadlines.filter(d=>!d.checked);
    saveDeadlines(); renderDeadlines();
    termOk('Removed ' + (before-deadlines.length) + ' completed deadlines');
  } else if (sub === 'all-tasks') {
    const q = args[0];
    if (q !== '--confirm') { termWarn('This deletes ALL tasks. Run: purge all-tasks --confirm'); return; }
    Object.keys(timers).forEach(id=>{clearInterval(timers[id]); delete timers[id];});
    tasks=[]; save(); renderTasks(); renderTimeline();
    termOk('All tasks deleted');
  } else if (sub === 'all-events') {
    const q = args[0];
    if (q !== '--confirm') { termWarn('This deletes ALL events. Run: purge all-events --confirm'); return; }
    events=[]; save(); renderEventList(); renderCalendar();
    termOk('All events deleted');
  } else { termError('Unknown purge target: '+sub); }
}

// ── TODAY COMMAND ──
function cmdToday() {
  const now = new Date();
  termPrint('head', '── Today: ' + DAYS[now.getDay()] + ', ' + MONTHS[now.getMonth()] + ' ' + now.getDate() + ' ──');
  const todayStr = toDateStr(now);
  const todayTasks = tasks.filter(t=>!t.checked);
  const todayEvents = events.filter(ev=>eventOccursOn(ev,now));
  const todayDl = deadlines.filter(dl=>{
    const due = new Date(dl.date+'T00:00:00');
    const today = new Date(); today.setHours(0,0,0,0);
    return Math.round((due-today)/86400000) <= 1 && !dl.checked;
  });
  termPrint('out', '  Active tasks: ' + todayTasks.length);
  todayTasks.filter(t=>t.startTime).sort((a,b)=>a.startTime.localeCompare(b.startTime)).forEach(t=>{
    termPrint('out', '    '+t.startTime+' '+t.name+' ('+t.duration+'m)');
  });
  if (todayEvents.length) {
    termPrint('out', '  Events today: ' + todayEvents.length);
    todayEvents.filter(e=>e.time).sort((a,b)=>a.time.localeCompare(b.time)).forEach(e=>{
      termPrint('out', '    '+e.time+' '+e.name+' ('+e.duration+'m)');
    });
  }
  if (todayDl.length) {
    termPrint('warn', '  ⚠ Deadlines due soon: ' + todayDl.length);
    todayDl.forEach(dl=>{ const cd=deadlineCountdown(dl.date); termPrint('warn','    '+dl.name+' — '+cd.label); });
  }
}


// ══════════════════════════════════════════════════════
// ── FOCUS MODE ──
// ══════════════════════════════════════════════════════
let focusModeTask = null, focusInterval = null;

function openFocusMode(taskId) {
  const task = taskId ? tasks.find(t => t.id === taskId) : tasks.find(t => t.running);
  if (!task) { alert('No running task found. Start a task first, or pass a task name.'); return; }
  focusModeTask = task;
  const overlay = document.getElementById('focusOverlay');
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  updateFocusMode();
  focusInterval = setInterval(updateFocusMode, 1000);
  if (!task.running) startTimer(task.id);
}

function closeFocusMode() {
  document.getElementById('focusOverlay').style.display = 'none';
  document.body.style.overflow = '';
  clearInterval(focusInterval);
  focusModeTask = null;
}

function updateFocusMode() {
  if (!focusModeTask) return;
  const task = tasks.find(t => t.id === focusModeTask.id);
  if (!task) { closeFocusMode(); return; }
  const total = task.duration * 60, elapsed = task.elapsed || 0;
  const remaining = Math.max(total - elapsed, 0);
  const pct = Math.min(elapsed / total, 1);
  const m = Math.floor(remaining / 60), s = remaining % 60;
  const pad = n => String(n).padStart(2, '0');
  document.getElementById('focusTaskName').textContent = task.name;
  document.getElementById('focusCountdown').textContent = pad(m) + ':' + pad(s);
  document.getElementById('focusBar').style.width = (pct * 100) + '%';
  document.getElementById('focusBar').style.background = timerColor(pct);
  document.getElementById('focusImp').textContent = impLabel(task.importance);
  document.getElementById('focusImp').className = 'focus-imp-badge ' + impClass(task.importance);
  const now = new Date(), h = now.getHours(), min = now.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM', h12 = h % 12 || 12;
  document.getElementById('focusClock').textContent = pad(h12) + ':' + pad(min) + ' ' + ampm;
  if (remaining === 0) {
    document.getElementById('focusCountdown').textContent = 'Done!';
    document.getElementById('focusCountdown').style.color = '#52e89e';
  }
}

function focusMarkDone() {
  if (!focusModeTask) return;
  const task = tasks.find(t => t.id === focusModeTask.id);
  if (task) { task.checked = true; if (task.running) stopTimer(task.id); save(); renderTasks(); renderTimeline(); }
  closeFocusMode();
}

function cmdFocus(q) {
  if (q) {
    const t = findTask(q);
    if (!t) { termError('Task not found: ' + q); return; }
    openFocusMode(t.id);
    termOk('Focus mode: "' + t.name + '"');
  } else {
    const running = tasks.find(t => t.running);
    if (!running) { termError('No running task. Start one first or: focus <name>'); return; }
    openFocusMode(running.id);
    termOk('Focus mode: "' + running.name + '"');
  }
}

// ══════════════════════════════════════════════════════
// ── DAILY REVIEW ──
// ══════════════════════════════════════════════════════
let reviewData = { finished: [], carryover: [], blockers: '', wins: '', step: 0 };
let reviews = JSON.parse(localStorage.getItem('dp_reviews') || '[]');

function openDailyReview() {
  reviewData = { finished: [], carryover: [], blockers: '', wins: '', step: 0 };
  document.getElementById('reviewOverlay').style.display = 'flex';
  renderReviewStep();
}

function closeDailyReview() {
  document.getElementById('reviewOverlay').style.display = 'none';
}

function renderReviewStep() {
  const el = document.getElementById('reviewContent');
  const doneTasks = tasks.filter(t => t.checked);
  const pendingTasks = tasks.filter(t => !t.checked);
  const steps = [
    {
      title: "What did you finish today?",
      sub: "Check off everything you completed",
      html: () => {
        if (!tasks.length) return '<div class="review-empty">No tasks tracked today.</div>';
        return tasks.map(t =>
          '<label class="review-check-row"><input type="checkbox" ' + (t.checked ? 'checked' : '') + ' onchange="reviewToggle(\'' + t.id + '\', this.checked)"><span class="' + (t.checked ? 'done-text' : '') + '">' + escHtml(t.name) + '</span><span class="review-dur">' + t.duration + 'min</span></label>'
        ).join('');
      }
    },
    {
      title: "What's carrying over?",
      sub: "Tasks to keep for tomorrow",
      html: () => pendingTasks.map(t =>
          '<label class="review-check-row"><input type="checkbox" checked onchange="reviewCarryover(\'' + t.id + '\', this.checked)"><span>' + escHtml(t.name) + '</span><span class="review-dur">' + t.duration + 'min</span></label>'
        ).join('') || '<div class="review-empty">Nothing pending — great work!</div>'
    },
    {
      title: "Any blockers or friction?",
      sub: "What slowed you down or needs to change?",
      html: () => '<textarea class="review-textarea" id="reviewBlockers" placeholder="e.g. kept getting interrupted, task was too vague, lost 30min to context switching…" oninput="reviewData.blockers=this.value">' + escHtml(reviewData.blockers) + '</textarea>'
    },
    {
      title: "What went well?",
      sub: "Your win for the day",
      html: () => '<textarea class="review-textarea" id="reviewWins" placeholder="e.g. finished the lab report draft, had a productive 2-hour focus block…" oninput="reviewData.wins=this.value">' + escHtml(reviewData.wins) + '</textarea>'
    },
    {
      title: "Review complete",
      sub: "Here's your summary",
      html: () => {
        const d = tasks.filter(t => t.checked);
        const p = tasks.filter(t => !t.checked);
        return '<div class="review-summary">' +
          '<div class="review-sum-row"><span class="review-sum-label">✓ Finished</span><span>' + d.length + ' task' + (d.length!==1?'s':'') + '</span></div>' +
          (d.map(t => '<div class="review-sum-item">· ' + escHtml(t.name) + '</div>').join('')) +
          (p.length ? '<div class="review-sum-row" style="margin-top:8px;"><span class="review-sum-label">↻ Carry over</span><span>' + p.length + '</span></div>' : '') +
          (reviewData.blockers ? '<div class="review-sum-row" style="margin-top:8px;"><span class="review-sum-label">⚠ Blocker</span></div><div class="review-sum-item">' + escHtml(reviewData.blockers) + '</div>' : '') +
          (reviewData.wins ? '<div class="review-sum-row" style="margin-top:8px;"><span class="review-sum-label">🌟 Win</span></div><div class="review-sum-item">' + escHtml(reviewData.wins) + '</div>' : '') +
          '</div>';
      }
    }
  ];
  const step = steps[reviewData.step];
  el.innerHTML =
    '<div class="review-progress">' + steps.map((_,i) => '<div class="review-pip' + (i <= reviewData.step ? ' active' : '') + '"></div>').join('') + '</div>' +
    '<div class="review-title">' + step.title + '</div>' +
    '<div class="review-sub">' + step.sub + '</div>' +
    '<div class="review-body">' + step.html() + '</div>' +
    '<div class="review-nav">' +
      (reviewData.step > 0 ? '<button class="review-btn secondary" onclick="reviewPrev()">← Back</button>' : '<div></div>') +
      (reviewData.step < steps.length - 1
        ? '<button class="review-btn" onclick="reviewNext()">Next →</button>'
        : '<button class="review-btn" onclick="saveReview()">Save & Close</button>') +
    '</div>';
}

function reviewToggle(id, val) { const t = tasks.find(x => x.id===id); if(t){ t.checked=val; save(); } }
function reviewCarryover(id, keep) { /* carryover is just kept tasks */ }
function reviewNext() { reviewData.step++; renderReviewStep(); }
function reviewPrev() { reviewData.step--; renderReviewStep(); }

function saveReview() {
  const entry = {
    date: toDateStr(new Date()),
    finished: tasks.filter(t => t.checked).map(t => t.name),
    pending: tasks.filter(t => !t.checked).map(t => t.name),
    blockers: reviewData.blockers,
    wins: reviewData.wins,
    ts: Date.now()
  };
  reviews.unshift(entry);
  if (reviews.length > 90) reviews = reviews.slice(0, 90);
  localStorage.setItem('dp_reviews', JSON.stringify(reviews));
  renderTasks();
  closeDailyReview();
}

// ══════════════════════════════════════════════════════
// ── TIME AUDIT ──
// ══════════════════════════════════════════════════════
function openTimeAudit() {
  const overlay = document.getElementById('auditOverlay');
  renderTimeAudit();
  overlay.style.display = 'flex';
}

function closeTimeAudit() {
  document.getElementById('auditOverlay').style.display = 'none';
}

function renderTimeAudit() {
  const el = document.getElementById('auditContent');
  const totalPlanned = tasks.reduce((s, t) => s + t.duration, 0);
  const totalElapsed = tasks.reduce((s, t) => s + Math.floor((t.elapsed || 0) / 60), 0);
  const done = tasks.filter(t => t.checked);
  const running = tasks.filter(t => t.running);
  const notStarted = tasks.filter(t => !t.checked && !t.running && !(t.elapsed > 0));

  function bar(planned, actual) {
    const maxMins = Math.max(planned, actual, 1);
    const pw = Math.min((planned / maxMins) * 100, 100);
    const aw = Math.min((actual / maxMins) * 100, 100);
    const over = actual > planned;
    return '<div class="audit-bar-wrap">' +
      '<div class="audit-bar planned" style="width:' + pw + '%"></div>' +
      '<div class="audit-bar actual' + (over ? ' over' : '') + '" style="width:' + aw + '%"></div>' +
    '</div>';
  }

  let rows = tasks.map(t => {
    const planned = t.duration;
    const actual = Math.floor((t.elapsed || 0) / 60);
    const diff = actual - planned;
    const diffStr = diff === 0 ? '=' : (diff > 0 ? '+' + diff + 'm over' : Math.abs(diff) + 'm left');
    const diffCls = diff > 5 ? 'audit-over' : diff < -5 ? 'audit-under' : 'audit-ok';
    return '<div class="audit-row">' +
      '<div class="audit-task-name' + (t.checked ? ' done-text' : '') + '">' + escHtml(t.name) + (t.running ? ' <span class="audit-running">▶</span>' : '') + '</div>' +
      '<div class="audit-times"><span class="audit-planned">' + planned + 'm planned</span> · <span class="audit-actual">' + actual + 'm tracked</span> · <span class="' + diffCls + '">' + diffStr + '</span></div>' +
      bar(planned, actual) +
    '</div>';
  }).join('');

  el.innerHTML =
    '<div class="audit-header">' +
      '<div class="audit-stat"><div class="audit-stat-val">' + totalPlanned + 'm</div><div class="audit-stat-lbl">Planned</div></div>' +
      '<div class="audit-stat"><div class="audit-stat-val">' + totalElapsed + 'm</div><div class="audit-stat-lbl">Tracked</div></div>' +
      '<div class="audit-stat"><div class="audit-stat-val">' + done.length + '/' + tasks.length + '</div><div class="audit-stat-lbl">Done</div></div>' +
      '<div class="audit-stat"><div class="audit-stat-val">' + (totalPlanned > 0 ? Math.round(totalElapsed / totalPlanned * 100) : 0) + '%</div><div class="audit-stat-lbl">Time used</div></div>' +
    '</div>' +
    '<div class="audit-legend"><span class="audit-legend-planned">■ Planned</span><span class="audit-legend-actual">■ Actual</span></div>' +
    (rows || '<div class="review-empty">No tasks with time data yet.</div>') +
    '<div class="audit-footer">Sessions run today · timer data only</div>';
}

// ══════════════════════════════════════════════════════
// ── AUTO-SCHEDULE ──
// ══════════════════════════════════════════════════════
function cmdAutoSchedule() {
  const unscheduled = tasks.filter(t => !t.startTime && !t.checked);
  if (!unscheduled.length) { termWarn('All tasks already have start times (or are done).'); return; }

  // Build occupied slots from existing timed tasks + events + blocks
  const today = new Date();
  const occupied = [];
  tasks.filter(t => t.startTime && !t.checked).forEach(t => {
    const [h, m] = t.startTime.split(':').map(Number);
    occupied.push({ start: h * 60 + m, end: h * 60 + m + t.duration });
  });
  events.filter(ev => eventOccursOn(ev, today) && ev.time).forEach(ev => {
    const [h, m] = ev.time.split(':').map(Number);
    occupied.push({ start: h * 60 + m, end: h * 60 + m + ev.duration });
  });
  timeBlocks.forEach(b => {
    occupied.push({ start: b.startMins, end: b.endMins });
  });
  occupied.sort((a, b) => a.start - b.start);

  // Start scheduling from next 15-min boundary after now
  const now = today.getHours() * 60 + today.getMinutes();
  let cursor = Math.ceil(now / 15) * 15;
  if (cursor < 480) cursor = 480; // not before 8am

  const scheduled = [];
  for (const task of unscheduled) {
    // Find next free slot with 10min buffer
    while (true) {
      const end = cursor + task.duration;
      const conflict = occupied.find(o => !(end + 10 <= o.start || cursor >= o.end + 10));
      if (!conflict) break;
      cursor = conflict.end + 10;
      cursor = Math.ceil(cursor / 15) * 15;
    }
    const h = Math.floor(cursor / 60), m = cursor % 60;
    task.startTime = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    occupied.push({ start: cursor, end: cursor + task.duration });
    occupied.sort((a, b) => a.start - b.start);
    cursor += task.duration + 10;
    cursor = Math.ceil(cursor / 60) * 60;
    scheduled.push(task);
  }

  // Check buffer warnings
  const warnings = checkBufferWarnings();
  save(); renderTasks(); renderTimeline();
  termOk('Scheduled ' + scheduled.length + ' task' + (scheduled.length !== 1 ? 's' : '') + ':');
  scheduled.forEach(t => termPrint('out', '  ' + t.startTime + '  ' + t.name + ' (' + t.duration + 'min)'));
  if (warnings.length) { termPrint('warn', ''); warnings.forEach(w => termPrint('warn', '  ⚠ ' + w)); }
}

// ══════════════════════════════════════════════════════
// ── BUFFER TIME WARNINGS ──
// ══════════════════════════════════════════════════════
function checkBufferWarnings() {
  const warnings = [];
  const today = new Date();
  const all = [];
  tasks.filter(t => t.startTime && !t.checked).forEach(t => {
    const [h, m] = t.startTime.split(':').map(Number);
    all.push({ name: t.name, start: h*60+m, end: h*60+m+t.duration, type: 'task' });
  });
  events.filter(ev => eventOccursOn(ev, today) && ev.time).forEach(ev => {
    const [h, m] = ev.time.split(':').map(Number);
    all.push({ name: ev.name, start: h*60+m, end: h*60+m+ev.duration, type: 'event' });
  });
  all.sort((a, b) => a.start - b.start);
  for (let i = 0; i < all.length - 1; i++) {
    const gap = all[i+1].start - all[i].end;
    if (gap < 0) warnings.push('"' + all[i].name + '" overlaps with "' + all[i+1].name + '"');
    else if (gap < 5) warnings.push('"' + all[i].name + '" ends at ' + fmtMins(all[i].end) + ', "' + all[i+1].name + '" starts at ' + fmtMins(all[i+1].start) + ' — no buffer');
  }
  // Past midnight check
  all.forEach(item => { if (item.end > 1440) warnings.push('"' + item.name + '" runs past midnight'); });
  return warnings;
}

function fmtMins(mins) {
  const h = Math.floor(mins / 60) % 24, m = mins % 60;
  const ampm = h >= 12 ? 'PM' : 'AM', h12 = h % 12 || 12;
  return h12 + ':' + String(m).padStart(2, '0') + ' ' + ampm;
}

// ══════════════════════════════════════════════════════
// ── TIME BLOCKS (focus blocks / blocked periods) ──
// ══════════════════════════════════════════════════════
let timeBlocks = JSON.parse(localStorage.getItem('dp_blocks') || '[]');

function saveBlocks() { localStorage.setItem('dp_blocks', JSON.stringify(timeBlocks)); }

function cmdBlock(start, rest) {
  if (!start) { termError('Usage: block <start> <end> "<label>"  e.g. block 9am 10:30am "Deep work"'); return; }
  const endArg = rest[0], label = rest.slice(1).join(' ') || 'Focus block';
  if (!endArg) { termError('Need an end time: block <start> <end> "<label>"'); return; }
  const startMins = timeToMins(parseTimeArg(start));
  const endMins   = timeToMins(parseTimeArg(endArg));
  if (endMins <= startMins) { termError('End time must be after start time'); return; }
  const block = { id: uid(), label, startMins, endMins, type: 'focus', date: toDateStr(new Date()) };
  timeBlocks.push(block); saveBlocks(); renderTimeline();
  termOk('Block added: "' + label + '" ' + fmtMins(startMins) + ' – ' + fmtMins(endMins));
  const warnings = checkBufferWarnings();
  warnings.forEach(w => termWarn(w));
}

function cmdUnblock(id, rest) {
  const q = [id, ...rest].join(' ');
  const b = timeBlocks.find(b => b.id === q || b.label.toLowerCase().includes(q.toLowerCase()));
  if (!b) { termError('Block not found: ' + q); return; }
  timeBlocks = timeBlocks.filter(x => x.id !== b.id); saveBlocks(); renderTimeline();
  termOk('Removed block: "' + b.label + '"');
}

function cmdListBlocks() {
  if (!timeBlocks.length) { termWarn('No blocks set'); return; }
  termPrint('head', 'Time blocks (' + timeBlocks.length + '):');
  timeBlocks.forEach(b => termPrint('out', '  ' + fmtMins(b.startMins) + ' – ' + fmtMins(b.endMins) + '  "' + b.label + '"'));
}

function timeToMins(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + (m || 0);
}

// Also render blocks in timeline - patch renderTimeline to include them
// (done in the renderTimeline function via timeBlocks global)

// ══════════════════════════════════════════════════════
// ── IN-REMINDERS (fire in X minutes) ──
// ══════════════════════════════════════════════════════
let inReminders = [];

function cmdRemindIn(timeArg, rest) {
  if (!timeArg) { termError('Usage: in <time> <message>  e.g. in 20m check the oven'); return; }
  // Parse duration: 20m, 1h, 90s, 1h30m
  let mins = 0;
  const str = timeArg.toLowerCase();
  const hm = str.match(/(\d+)h(\d+)?m?/);
  const hOnly = str.match(/^(\d+)h$/);
  const mOnly = str.match(/^(\d+)m$/);
  const sOnly = str.match(/^(\d+)s$/);
  if (hm) mins = parseInt(hm[1]) * 60 + parseInt(hm[2] || 0);
  else if (hOnly) mins = parseInt(hOnly[1]) * 60;
  else if (mOnly) mins = parseInt(mOnly[1]);
  else if (sOnly) mins = parseInt(sOnly[1]) / 60;
  else mins = parseInt(str) || 5;

  const msg = rest.join(' ') || 'Reminder';
  const fireAt = Date.now() + mins * 60000;
  const id = uid();
  inReminders.push({ id, msg, fireAt });
  const pad = n => String(n).padStart(2, '0');
  const fireDate = new Date(fireAt);
  termOk('Reminder set: "' + msg + '" in ' + mins + 'min (at ' + pad(fireDate.getHours()) + ':' + pad(fireDate.getMinutes()) + ')');
}

function checkInReminders() {
  const now = Date.now();
  const fired = inReminders.filter(r => r.fireAt <= now);
  if (!fired.length) return;
  inReminders = inReminders.filter(r => r.fireAt > now);
  fired.forEach(r => fireInReminder(r));
}

function fireInReminder(r) {
  // Show overlay notification
  const overlay = document.getElementById('reminderOverlay');
  document.getElementById('reminderMsg').textContent = r.msg;
  overlay.style.display = 'flex';
  playTaskEndSound();
  setTimeout(() => { if (overlay.style.display !== 'none') dismissReminder(); }, 30000);
}

function dismissReminder() {
  document.getElementById('reminderOverlay').style.display = 'none';
}

// ══════════════════════════════════════════════════════
// ── ANALYTICS ──
// ══════════════════════════════════════════════════════
function openAnalytics() {
  const overlay = document.getElementById('analyticsOverlay');
  renderAnalytics();
  overlay.style.display = 'flex';
}

function closeAnalytics() {
  document.getElementById('analyticsOverlay').style.display = 'none';
}

function renderAnalytics() {
  const el = document.getElementById('analyticsContent');
  const reviewHistory = JSON.parse(localStorage.getItem('dp_reviews') || '[]');

  // --- Compute stats ---
  const totalTasks = tasks.length;
  const doneTasks = tasks.filter(t => t.checked).length;
  const totalMinsPlanned = tasks.reduce((s, t) => s + t.duration, 0);
  const totalMinsTracked = tasks.reduce((s, t) => s + Math.floor((t.elapsed || 0) / 60), 0);
  const completionRate = totalTasks > 0 ? Math.round(doneTasks / totalTasks * 100) : 0;

  // Importance breakdown
  const impBreakdown = ['low', 'medium', 'high', 'critical'].map(imp => ({
    imp,
    total: tasks.filter(t => t.importance === imp).length,
    done:  tasks.filter(t => t.importance === imp && t.checked).length
  })).filter(x => x.total > 0);

  // Most time-intensive tasks
  const topTasks = [...tasks].sort((a, b) => (b.elapsed || 0) - (a.elapsed || 0)).slice(0, 5);

  // Deadlines health
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const overdueCount  = deadlines.filter(dl => { const d = new Date(dl.date+'T00:00:00'); return d < today && !dl.checked; }).length;
  const dueSoonCount  = deadlines.filter(dl => { const d = new Date(dl.date+'T00:00:00'); const diff = Math.round((d-today)/86400000); return diff >= 0 && diff <= 3 && !dl.checked; }).length;
  const doneDeadlines = deadlines.filter(dl => dl.checked).length;

  // Review streaks
  const recentReviews = reviewHistory.slice(0, 7);

  // --- Render ---
  function statCard(val, lbl, sub, color) {
    return '<div class="an-stat-card"><div class="an-stat-val" style="color:' + (color||'var(--accent)') + '">' + val + '</div><div class="an-stat-lbl">' + lbl + '</div>' + (sub ? '<div class="an-stat-sub">' + sub + '</div>' : '') + '</div>';
  }

  function progressBar(val, max, color) {
    const pct = max > 0 ? Math.min(val / max * 100, 100) : 0;
    return '<div class="an-bar-bg"><div class="an-bar-fill" style="width:' + pct + '%;background:' + (color || 'var(--accent)') + ';"></div></div>';
  }

  el.innerHTML =
    // Header stats
    '<div class="an-stat-grid">' +
      statCard(completionRate + '%', 'Completion', doneTasks + '/' + totalTasks + ' tasks', completionRate >= 75 ? '#2D6A4F' : completionRate >= 40 ? '#E67E22' : '#C0392B') +
      statCard(totalMinsTracked + 'm', 'Time tracked', 'of ' + totalMinsPlanned + 'm planned') +
      statCard(deadlines.length, 'Deadlines', overdueCount ? overdueCount + ' overdue' : dueSoonCount ? dueSoonCount + ' due soon' : 'all clear', overdueCount ? '#C0392B' : dueSoonCount ? '#E67E22' : '#2D6A4F') +
      statCard(reviewHistory.length, 'Reviews done', 'all time') +
    '</div>' +

    // Task priority breakdown
    '<div class="an-section-title">Tasks by Priority</div>' +
    '<div class="an-imp-list">' +
    impBreakdown.map(x => {
      const pct = Math.round(x.done / x.total * 100);
      const color = {low:'#3B6D11',medium:'#856404',high:'#854F0B',critical:'#A32D2D'}[x.imp];
      return '<div class="an-imp-row">' +
        '<div class="an-imp-label"><span class="importance-badge ' + impClass(x.imp) + '">' + impLabel(x.imp) + '</span></div>' +
        '<div class="an-imp-bar">' + progressBar(x.done, x.total, color) + '</div>' +
        '<div class="an-imp-count">' + x.done + '/' + x.total + '</div>' +
      '</div>';
    }).join('') +
    '</div>' +

    // Time spent on tasks
    '<div class="an-section-title">Most Time Spent</div>' +
    '<div class="an-task-time-list">' +
    (topTasks.filter(t => (t.elapsed||0) > 0).map(t => {
      const actual = Math.floor((t.elapsed || 0) / 60);
      const planned = t.duration;
      const over = actual > planned;
      return '<div class="an-task-time-row">' +
        '<div class="an-task-time-name' + (t.checked ? ' done-text' : '') + '">' + escHtml(t.name) + '</div>' +
        '<div class="an-task-time-bar">' + progressBar(actual, Math.max(planned, actual), over ? '#C0392B' : 'var(--accent)') + '</div>' +
        '<div class="an-task-time-val' + (over ? ' audit-over' : '') + '">' + actual + 'm' + (over ? ' (+' + (actual-planned) + ')' : '') + '</div>' +
      '</div>';
    }).join('') || '<div class="review-empty">No time tracked yet</div>') +
    '</div>' +

    // Deadline health
    '<div class="an-section-title">Deadline Health</div>' +
    '<div class="an-dl-health">' +
      '<div class="an-dl-stat an-dl-done"><div class="an-dl-num">' + doneDeadlines + '</div><div>Done</div></div>' +
      '<div class="an-dl-stat an-dl-soon"><div class="an-dl-num">' + dueSoonCount + '</div><div>Due soon</div></div>' +
      '<div class="an-dl-stat an-dl-over"><div class="an-dl-num">' + overdueCount + '</div><div>Overdue</div></div>' +
    '</div>' +

    // Review history
    '<div class="an-section-title">Daily Reviews (last 7)</div>' +
    '<div class="an-reviews">' +
    (recentReviews.length ? recentReviews.map(r =>
      '<div class="an-review-row">' +
        '<div class="an-review-date">' + r.date + '</div>' +
        '<div class="an-review-pills">' +
          '<span class="an-review-pill done">✓ ' + r.finished.length + ' done</span>' +
          (r.pending.length ? '<span class="an-review-pill carry">↻ ' + r.pending.length + ' carry</span>' : '') +
          (r.wins ? '<span class="an-review-pill win">🌟</span>' : '') +
        '</div>' +
        (r.wins ? '<div class="an-review-win">' + escHtml(r.wins.slice(0, 80)) + (r.wins.length > 80 ? '…' : '') + '</div>' : '') +
      '</div>'
    ).join('') : '<div class="review-empty">No review history yet. Run daily reviews to see trends.</div>') +
    '</div>';
}

function cmdAnalytics(sub) {
  if (sub === 'summary' || !sub) {
    // Print quick stats to terminal
    const done = tasks.filter(t => t.checked).length;
    const rate = tasks.length ? Math.round(done / tasks.length * 100) : 0;
    const tracked = tasks.reduce((s,t) => s + Math.floor((t.elapsed||0)/60), 0);
    const planned = tasks.reduce((s,t) => s + t.duration, 0);
    const today = new Date(); today.setHours(0,0,0,0);
    const overdue = deadlines.filter(dl => new Date(dl.date+'T00:00:00') < today && !dl.checked).length;
    termPrint('head', '── Analytics Summary ──');
    termPrint('out',  '  Completion rate:  ' + rate + '%  (' + done + '/' + tasks.length + ' tasks)');
    termPrint('out',  '  Time tracked:     ' + tracked + 'min  of ' + planned + 'min planned');
    termPrint('out',  '  Overdue deadlines:' + overdue);
    termPrint('out',  '  Reviews logged:   ' + JSON.parse(localStorage.getItem('dp_reviews')||'[]').length);
    termPrint('dim',  "  Run 'analytics' without args to open the full dashboard");
    openAnalytics();
  }
}

// ══════════════════════════════════════════════════════
// ── SUMMARIZE COMMAND ──
// ══════════════════════════════════════════════════════
function cmdSummarize() {
  const now = new Date();
  const dateStr = DAYS[now.getDay()] + ', ' + MONTHS[now.getMonth()] + ' ' + now.getDate();
  const done = tasks.filter(t => t.checked);
  const pending = tasks.filter(t => !t.checked);
  const tracked = tasks.reduce((s,t) => s + Math.floor((t.elapsed||0)/60), 0);
  const today = new Date(); today.setHours(0,0,0,0);
  const urgent = deadlines.filter(dl => { const d=new Date(dl.date+'T00:00:00'); const diff=Math.round((d-today)/86400000); return diff<=1&&!dl.checked; });
  const evToday = events.filter(ev => eventOccursOn(ev, now));
  let summary = dateStr + '. ';
  if (done.length) summary += 'Completed ' + done.map(t => t.name).join(', ') + '. ';
  if (tracked > 0) summary += 'Tracked ' + tracked + ' min of focused work. ';
  if (pending.length) summary += 'Still pending: ' + pending.map(t => t.name).join(', ') + '. ';
  if (evToday.length) summary += 'Events: ' + evToday.map(e => e.name + (e.time?' @'+e.time:'')).join(', ') + '. ';
  if (urgent.length) summary += '⚠ Urgent deadlines: ' + urgent.map(dl => dl.name + ' (' + deadlineCountdown(dl.date).label + ')').join(', ') + '.';
  termPrint('head', '── Day Summary ──');
  termPrint('out', summary);
  termPrint('dim', '  (copy the line above to paste into a journal)');
  // Also copy to clipboard if available
  if (navigator.clipboard) navigator.clipboard.writeText(summary).then(() => termPrint('dim', '  ✓ Copied to clipboard'));
}

// ══════════════════════════════════════════════════════
// ── RESCHEDULE COMMAND ──
// ══════════════════════════════════════════════════════
function cmdReschedule(shiftArg, rest) {
  if (!shiftArg) { termError('Usage: reschedule +30  or  reschedule -15  (minutes)'); return; }
  const sign = shiftArg.startsWith('-') ? -1 : 1;
  const mins = parseInt(shiftArg.replace(/[+\-]/g, '')) || 0;
  if (!mins) { termError('Invalid shift: ' + shiftArg + '. Use +30 or -15'); return; }
  const shifted = [];
  tasks.forEach(t => {
    if (!t.startTime || t.checked) return;
    const [h, m] = t.startTime.split(':').map(Number);
    let total = h * 60 + m + sign * mins;
    total = Math.max(0, Math.min(1439, total));
    t.startTime = String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
    shifted.push(t.name + ' → ' + t.startTime);
  });
  if (!shifted.length) { termWarn('No timed tasks to shift'); return; }
  save(); renderTasks(); renderTimeline();
  termOk('Shifted ' + shifted.length + ' task' + (shifted.length!==1?'s':'') + ' by ' + (sign>0?'+':'') + (sign*mins) + 'min:');
  shifted.forEach(s => termPrint('out', '  ' + s));
  const warnings = checkBufferWarnings();
  warnings.forEach(w => termWarn(w));
}

// ── KEYBOARD HANDLER ──
function termKeydown(e) {
  const inp = document.getElementById('termInput');
  if (e.key === 'Enter') {
    const val = inp.value.trim();
    inp.value = '';
    if (val) termRun(val);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (termHistIdx < termHistory.length - 1) { termHistIdx++; inp.value = termHistory[termHistIdx]; }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (termHistIdx > 0) { termHistIdx--; inp.value = termHistory[termHistIdx]; }
    else { termHistIdx = -1; inp.value = ''; }
  } else if (e.key === 'Tab') {
    e.preventDefault();
    // Tab completion for commands
    const cmds = ['task','event','deadline','alarm','ls','clear','sync','clock','help','start','stop','reset','done'];
    const cur = inp.value.toLowerCase();
    const match = cmds.find(c => c.startsWith(cur));
    if (match) inp.value = match + ' ';
  } else if (e.key === '`' || (e.key === 't' && e.ctrlKey)) {
    e.preventDefault(); toggleTerminal();
  }
}

// ── DRAG TO REPOSITION ──
function initTermDrag() {
  const panel = document.getElementById('termPanel');
  const bar   = document.getElementById('termTitlebar');
  if (!bar || !panel) return;
  let startX, startY, startR, startB;
  bar.addEventListener('mousedown', e => {
    const rect = panel.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    startR = window.innerWidth  - rect.right;
    startB = window.innerHeight - rect.bottom;
    panel.style.transition = 'none';
    const onMove = ev => {
      const dx = startX - ev.clientX, dy = startY - ev.clientY;
      panel.style.right  = Math.max(0, startR + dx) + 'px';
      panel.style.bottom = Math.max(0, startB + dy) + 'px';
    };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── KEYBOARD SHORTCUT: backtick to toggle ──
document.addEventListener('keydown', e => {
  if (e.key === '`' && !e.ctrlKey && !e.metaKey && document.activeElement.id !== 'termInput') {
    toggleTerminal();
  }
});

// ── INIT TERMINAL ──
window.addEventListener('load', () => {
  const inp = document.getElementById('termInput');
  if (inp) inp.addEventListener('keydown', termKeydown);
  initTermDrag();
});

// ── INIT TERMINAL ──

// ── EXPOSE TO WINDOW ──
Object.assign(window,{
  addTask,deleteTask,startTimer,stopTimer,resetTimer,toggleEditTask,saveEditTask,
  toggleTaskChecked,toggleDeadlineChecked,
  addEvent,deleteEvent,toggleEditEvent,saveEditEvent,toggleEventForm,scheduleTypeChange,
  addDeadline,deleteDeadline,toggleEditDeadline,saveEditDeadline,
  selectDay,calPrev,calNext,switchMain,mobileTab,
  openClockMode,closeClockMode,switchCmTab,fetchWeather,
  addAlarm,deleteAlarm,toggleAlarm,dismissAlarm,snoozeAlarm,
  pomStart,pomPause,pomReset,pomSetWork,pomSetBreak,
  swStart,swPause,swReset,openCmTab,saveNote,
  openFocusMode,closeFocusMode,focusMarkDone,
  openDailyReview,closeDailyReview,reviewNext,reviewPrev,saveReview,reviewToggle,reviewCarryover,
  openTimeAudit,closeTimeAudit,
  openAnalytics,closeAnalytics,
  dismissReminder,
  toggleTerminal,termRun
});

// ── INIT ──
async function init() {
  const today=new Date();
  document.getElementById('todayLabel').textContent=DAYS[today.getDay()]+', '+MONTHS[today.getMonth()]+' '+today.getDate()+', '+today.getFullYear();
  const pad=n=>String(n).padStart(2,'0');
  document.getElementById('newTaskTime').value=`${pad(today.getHours())}:${pad(today.getMinutes())}`;
  document.getElementById('evTime').value=`${pad(today.getHours())}:${pad(today.getMinutes())}`;
  document.getElementById('evDate').value=toDateStr(today);
  selectedDay=today;
  const cb=document.getElementById('clockModeBtnWire');
  if(cb) cb.addEventListener('click',openClockMode);
  await syncLoad();
  renderTasks();renderEventList();renderCalendar();renderDeadlines();
  tickClock();setInterval(tickClock,1000);handleResize();
}

init();
})();
