(function() {

// ── APP STATE ──
let tasks = [];
let events = [];
let deadlines = [];
let db = null;
let syncEnabled = false;
let audioCtx = null;
let templates = JSON.parse(localStorage.getItem('dp_templates') || '[]');
let heatmapData = JSON.parse(localStorage.getItem('dp_heatmap') || '{}');
let timeboxMode = false, timeboxInterval = null;
let weekViewDate = null;

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
        resetRecurringTasks();
  renderTasks(); renderEventList(); renderCalendar(); renderTimeline(); renderDeadlines();
      }
    });
  } catch(e) {
    console.warn('Firebase sync failed:', e.message);
    showSyncStatus('offline');
    setTimeout(syncLoad, 30000);
  }
}

let _saveTimer = null;
async function syncSave() {
  localStorage.setItem('dp_tasks', JSON.stringify(tasks));
  localStorage.setItem('dp_events', JSON.stringify(events));
  localStorage.setItem('dp_deadlines', JSON.stringify(deadlines));
  if (!syncEnabled || !db) return;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    try {
      await db.collection('planner').doc('data').set({ tasks, events, deadlines, updated: Date.now() });
      showSyncStatus('synced');
    } catch(e) { showSyncStatus('error'); }
  }, 5000);
}

function showSyncStatus(state) {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  if (state === 'synced')  { el.textContent = '☁ Synced';   el.style.color = 'rgba(255,255,255,0.75)'; }
  if (state === 'offline') { el.textContent = '⚠ Offline';  el.style.color = '#F1C40F'; }
  if (state === 'error')   { el.textContent = '✕ Sync err'; el.style.color = '#E74C3C'; }
}


const SUBJECTS = {
  'chem':     { label:'Chemistry',    color:'#E67E22', bg:'#FEF5EC' },
  'bio':      { label:'Biology',      color:'#27AE60', bg:'#EAFAF1' },
  'math':     { label:'Math',         color:'#2980B9', bg:'#EBF5FB' },
  'physics':  { label:'Physics',      color:'#8E44AD', bg:'#F5EEF8' },
  'robotics': { label:'Robotics',     color:'#16A085', bg:'#E8F8F5' },
  'english':  { label:'English',      color:'#C0392B', bg:'#FDEDEC' },
  'history':  { label:'History',      color:'#795548', bg:'#EFEBE9' },
  'fll':      { label:'FLL',          color:'#1ABC9C', bg:'#E8F8F5' },
  'scioly':   { label:'Sci Oly',      color:'#F39C12', bg:'#FEF9E7' },
  'other':    { label:'Other',        color:'#7F8C8D', bg:'#F2F3F4' },
};
function subjectBadge(sub) {
  const s = SUBJECTS[sub];
  if (!s) return '';
  return '<span class="subject-badge" style="background:'+s.bg+';color:'+s.color+';border-color:'+s.color+'40;">'+s.label+'</span>';
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
    subject: document.getElementById('newTaskSubject')?.value || '',
    importance: document.getElementById('newTaskImp').value,
    duration: parseInt(document.getElementById('newTaskDur').value)||30,
    startTime: document.getElementById('newTaskTime').value||'',
    elapsed:0, running:false, done:false, checked:false,
    subtasks:[], notes:'', blockedBy:[], recurring:null,
    reminder: parseInt(document.getElementById('newTaskReminder')?.value||'0')||0,
    subject: document.getElementById('newTaskSubject')?.value||'',
    isExam: false,
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
  if (task.checked && (task.importance === 'critical' || task.importance === 'high')) burstConfetti();
  updateHeatmap();
  save(); renderTasks(); renderTimeline(); renderOverdueRadar();
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
    if (t.elapsed === t.duration*60) {
      playTaskEndSound(); // ding but keep running — overtime mode
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
  const overtime = elapsed > total;
  if (display) {
    if (task.running && overtime) {
      display.textContent = '+' + fmtTime(elapsed - total) + ' overtime';
      display.style.color = '#E74C3C';
    } else if (task.running) {
      display.textContent = 'Remaining: ' + fmtTime(remaining);
      display.style.color = '';
    } else {
      display.textContent = elapsed>0 ? 'Elapsed: '+fmtTime(elapsed) : fmtTime(total)+' total';
      display.style.color = '';
    }
  }
  const sb = el.querySelector('.start-btn'); const pb = el.querySelector('.stop-btn');
  if (sb) sb.style.display = task.running ? 'none' : '';
  if (pb) pb.style.display = task.running ? '' : 'none';
  el.classList.toggle('running', task.running);
  el.classList.toggle('task-glow', task.running);
}

function toggleEditTask(id) { document.getElementById('editForm_'+id)?.classList.toggle('open'); }

function saveEditTask(id) {
  const task = tasks.find(t => t.id === id); if (!task) return;
  const n = document.getElementById('editName_'+id).value.trim();
  if (n) task.name = n;
  task.importance = document.getElementById('editImp_'+id).value;
  task.duration   = parseInt(document.getElementById('editDur_'+id).value)||task.duration;
  task.startTime  = document.getElementById('editTime_'+id).value;
  const subEl = document.getElementById('editSubject_'+id);
  if (subEl) task.subject = subEl.value;
  const exEl = document.getElementById('editIsExam_'+id);
  if (exEl) task.isExam = exEl.checked;
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
    const now = new Date();
    const todayMins = now.getHours()*60+now.getMinutes();
    const isPastDue = !task.checked && !task.running && task.startTime && (()=>{
      const [h,m]=task.startTime.split(':').map(Number); return h*60+m < todayMins;
    })();
    const checkedClass = task.checked ? ' task-checked' : (isPastDue ? ' task-past-due' : '');
    return '<div class="task-card' + (task.running?' running':'') + checkedClass + '" id="task_' + task.id + '">' +
      '<div class="task-header">' +
        '<button class="task-check-btn' + (task.checked?' checked':'') + '" onclick="toggleTaskChecked(\''+ task.id +'\')" title="' + (task.checked?'Mark incomplete':'Mark complete') + '">' +
          (task.checked ? '✓' : '') +
        '</button>' +
        '<div class="task-name' + (task.checked?' done-text':'') + '">' + escHtml(task.name) + '</div>' +
        '<span class="importance-badge ' + impClass(task.importance) + '">' + impLabel(task.importance) + '</span>' +
        subjectBadge(task.subject||'') +
        (task.isExam ? '<span class="exam-flag-badge">📋 Exam</span>' : '') +
      '</div>' +
      (!task.checked ? (
        // dependency blocked?
        (()=>{
          const blockedBy = (task.blockedBy||[]).map(bid=>tasks.find(t=>t.id===bid)).filter(Boolean).filter(t=>!t.checked);
          if(blockedBy.length) return '<div class="task-blocked-banner">🔒 Blocked by: ' + blockedBy.map(t=>escHtml(t.name)).join(', ') + '</div>';
          return '';
        })() +
        '<div class="task-meta"><span>⏱ ' + task.duration + ' min</span>' + (task.startTime?'<span>🕐 '+task.startTime+'</span>':'') + (task.recurring?'<span class="task-recurring-badge">↻ '+task.recurring+'</span>':'') + '</div>' +
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
          '<div class="form-row"><label>Subject</label>' +
          '<select id="editSubject_' + task.id + '">' +
            Object.entries(SUBJECTS).map(([k,v]) => '<option value="'+k+'"'+(task.subject===k?' selected':'')+'>'+v.label+'</option>').join('') +
            '<option value=""'+((!task.subject)?' selected':'')+'>None</option>' +
          '</select></div>' +
          '<div class="form-row"><label>Is Exam?</label><input type="checkbox" id="editIsExam_' + task.id + '" '+(task.isExam?'checked':'')+' style="accent-color:var(--accent);" /></div>' +
          '<div class="edit-actions">' +
            '<button class="btn" style="font-size:12px;padding:6px 10px;" onclick="saveEditTask(\''+ task.id +'\')">Save</button>' +
            '<button class="btn secondary" style="font-size:12px;padding:6px 10px;" onclick="toggleEditTask(\''+ task.id +'\')">Cancel</button>' +
          '</div>' +
        '</div>' +
        // Notes section
        '<div class="task-notes-wrap">' +
          '<button class="task-notes-toggle" onclick="toggleTaskNotes(\''+ task.id +'\')">' + (task.notes ? '📝 Note ▸' : '+ Note') + '</button>' +
          '<div class="task-notes-body" id="notes_' + task.id + '" style="display:' + (task.notes?'block':'none') + ';">' +
            '<textarea class="task-notes-area" placeholder="Context, links, instructions…" oninput="saveTaskNote(\''+ task.id +'\',this.value)">' + escHtml(task.notes||'') + '</textarea>' +
          '</div>' +
        '</div>' +
        // Subtasks section
        '<div class="task-subtasks-wrap">' +
          ((task.subtasks&&task.subtasks.length) ? (
            '<div class="subtask-progress-bar-wrap"><div class="subtask-progress-bar" style="width:' +
              Math.round(task.subtasks.filter(s=>s.done).length/task.subtasks.length*100) + '%;"></div></div>' +
            '<div class="subtask-list">' +
              task.subtasks.map(s =>
                '<div class="subtask-row">' +
                  '<button class="subtask-check' + (s.done?' done':'') + '" onclick="toggleSubtask(\''+ task.id +'\',\''+ s.id +'\')">' + (s.done?'✓':'') + '</button>' +
                  '<span class="subtask-name' + (s.done?' done-text':'') + '">' + escHtml(s.name) + '</span>' +
                  '<button class="subtask-del" onclick="deleteSubtask(\''+ task.id +'\',\''+ s.id +'\')">✕</button>' +
                '</div>'
              ).join('') +
            '</div>'
          ) : '') +
          '<div class="subtask-add-row">' +
            '<input type="text" class="subtask-input" id="sti_'+ task.id +'" placeholder="Add subtask…" onkeydown="subtaskKeydown(event,\''+ task.id +'\')" />' +
            '<button class="subtask-add-btn" onclick="addSubtask(\''+ task.id +'\')">+</button>' +
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


// ── MINI AGENDA ──
function renderMiniAgenda() {
  const el = document.getElementById('miniAgenda');
  if (!el) return;
  const today = new Date(); today.setHours(0,0,0,0);
  const rows = [];
  for (let i = 0; i <= 7; i++) {
    const d = new Date(today); d.setDate(d.getDate()+i);
    const ds = toDateStr(d);
    const dayTasks = tasks.filter(t => t.startTime && !t.checked);
    const dayEvents = events.filter(e => eventOccursOn(e, d));
    const dayDl = deadlines.filter(dl => dl.date === ds && !dl.checked);
    if (!dayTasks.length && !dayEvents.length && !dayDl.length) continue;
    const label = i===0?'Today':i===1?'Tomorrow':DAYS[d.getDay()]+' '+(d.getMonth()+1)+'/'+d.getDate();
    rows.push('<div class="agenda-day-header">'+label+'</div>');
    dayDl.forEach(dl => {
      const cd = deadlineCountdown(dl.date);
      rows.push('<div class="agenda-row agenda-dl"><span class="agenda-dot" style="background:#E74C3C;"></span><span class="agenda-name">📅 '+escHtml(dl.name)+'</span><span class="agenda-time '+cd.cls+'">'+cd.label+'</span></div>');
    });
    dayEvents.sort((a,b)=>(a.time||'').localeCompare(b.time||'')).forEach(ev => {
      rows.push('<div class="agenda-row"><span class="agenda-dot" style="background:#8E44AD;"></span><span class="agenda-name">'+escHtml(ev.name)+'</span>'+(ev.time?'<span class="agenda-time">'+ev.time+'</span>':'')+'</div>');
    });
    if (i===0) {
      dayTasks.sort((a,b)=>(a.startTime||'').localeCompare(b.startTime||'')).forEach(t => {
        rows.push('<div class="agenda-row"><span class="agenda-dot" style="background:var(--accent2);"></span><span class="agenda-name">'+escHtml(t.name)+'</span>'+(t.startTime?'<span class="agenda-time">'+t.startTime+'</span>':'')+'</div>');
      });
    }
  }
  el.innerHTML = rows.length ? rows.join('') : '<div class="empty-state">Nothing in the next 7 days.</div>';
}


// ── KANBAN BOARD ──
let kanbanOpen = false;
const KANBAN_COLS = [
  { id:'todo',       label:'To Do',       color:'#7F8C8D' },
  { id:'inprogress', label:'In Progress', color:'#E67E22' },
  { id:'done',       label:'Done',        color:'#27AE60' },
];

function openKanban() {
  kanbanOpen = true;
  document.getElementById('kanbanOverlay').style.display = 'flex';
  renderKanban();
}
function closeKanban() {
  kanbanOpen = false;
  document.getElementById('kanbanOverlay').style.display = 'none';
}
function kanbanCol(t) {
  if (t.checked) return 'done';
  if (t.running || (t.elapsed||0)>0) return 'inprogress';
  return t.kanban || 'todo';
}
function setKanban(id, col) {
  const t = tasks.find(t=>t.id===id); if(!t) return;
  t.kanban = col;
  if (col === 'done' && !t.checked) { t.checked = true; if(t.running) stopTimer(id); if(t.importance==='critical'||t.importance==='high') burstConfetti(); updateHeatmap(); }
  if (col !== 'done') t.checked = false;
  save(); renderKanban(); renderTasks();
}
function renderKanban() {
  const board = document.getElementById('kanbanBoard');
  if (!board) return;
  board.innerHTML = KANBAN_COLS.map(col => {
    const colTasks = tasks.filter(t => kanbanCol(t) === col.id);
    return '<div class="kb-col">'+
      '<div class="kb-col-header" style="border-color:'+col.color+'">'+
        '<span class="kb-col-title">'+col.label+'</span>'+
        '<span class="kb-col-count" style="background:'+col.color+'">'+colTasks.length+'</span>'+
      '</div>'+
      '<div class="kb-cards" id="kbcol_'+col.id+'" ondragover="event.preventDefault()" ondrop="kanbanDrop(event,\''+col.id+'\')">'+ 
        (colTasks.length ? colTasks.map(t =>
          '<div class="kb-card" draggable="true" ondragstart="kanbanDragStart(event,\''+t.id+'\')" id="kbc_'+t.id+'">'+
            '<div class="kb-card-name">'+escHtml(t.name)+'</div>'+
            '<div class="kb-card-meta">'+
              '<span class="importance-badge '+impClass(t.importance)+'" style="font-size:9px;padding:1px 5px;">'+impLabel(t.importance)+'</span>'+
              (t.subject ? '<span class="subject-badge" style="font-size:9px;padding:1px 5px;background:'+((SUBJECTS[t.subject]||{}).bg||'#eee')+';color:'+((SUBJECTS[t.subject]||{}).color||'#333')+';border-color:'+((SUBJECTS[t.subject]||{}).color||'#ccc')+'40;">'+((SUBJECTS[t.subject]||{}).label||t.subject)+'</span>' : '')+
            '</div>'+
            '<div class="kb-card-actions">'+
              KANBAN_COLS.filter(c=>c.id!==col.id).map(c =>
                '<button class="kb-move-btn" onclick="setKanban(\''+t.id+'\',\''+c.id+'\')">→ '+c.label+'</button>'
              ).join('')+
            '</div>'+
          '</div>'
        ).join('') : '<div class="kb-empty">Drop tasks here</div>')+
      '</div>'+
    '</div>';
  }).join('');
}
let _kanbanDragId = null;
function kanbanDragStart(e, id) { _kanbanDragId = id; e.dataTransfer.effectAllowed = 'move'; }
function kanbanDrop(e, col) { e.preventDefault(); if(_kanbanDragId) { setKanban(_kanbanDragId, col); _kanbanDragId=null; } }


// ── ARCHIVE ──
let archivedTasks = JSON.parse(localStorage.getItem('dp_archive')||'[]');
function saveArchive() { localStorage.setItem('dp_archive', JSON.stringify(archivedTasks)); }
function archiveCheckedTasks() {
  const toArchive = tasks.filter(t => t.checked);
  if (!toArchive.length) { showToast('No completed tasks to archive'); return; }
  toArchive.forEach(t => archivedTasks.unshift({ ...t, archivedAt: Date.now() }));
  tasks = tasks.filter(t => !t.checked);
  saveArchive(); save(); renderTasks();
  showToast('Archived ' + toArchive.length + ' task(s)');
}
function openArchive() { renderArchivePanel(); document.getElementById('archiveOverlay').style.display='flex'; }
function closeArchive() { document.getElementById('archiveOverlay').style.display='none'; }
function restoreFromArchive(id) {
  const t = archivedTasks.find(t=>t.id===id); if(!t) return;
  t.checked=false; t.elapsed=0; t.running=false;
  tasks.push(t); archivedTasks = archivedTasks.filter(a=>a.id!==id);
  saveArchive(); save(); renderTasks(); renderArchivePanel();
  showToast('Restored: '+t.name);
}
function deleteFromArchive(id) {
  archivedTasks = archivedTasks.filter(a=>a.id!==id);
  saveArchive(); renderArchivePanel();
}
function clearArchive() {
  if (!confirm('Clear all archived tasks?')) return;
  archivedTasks = []; saveArchive(); renderArchivePanel();
}
function renderArchivePanel() {
  const el = document.getElementById('archiveList'); if(!el) return;
  if (!archivedTasks.length) { el.innerHTML='<div class="empty-state">No archived tasks.</div>'; return; }
  el.innerHTML = archivedTasks.map(t => {
    const d = new Date(t.archivedAt||0);
    const ds = d.toLocaleDateString();
    return '<div class="archive-card">'+
      '<div class="archive-name">'+escHtml(t.name)+'</div>'+
      '<div class="archive-meta">'+ds+' · '+t.duration+'min · <span class="importance-badge '+impClass(t.importance)+'">'+impLabel(t.importance)+'</span>'+
        (t.subject&&SUBJECTS[t.subject]?' · <span class="subject-badge" style="font-size:9px;background:'+SUBJECTS[t.subject].bg+';color:'+SUBJECTS[t.subject].color+'">'+SUBJECTS[t.subject].label+'</span>':'')+'</div>'+
      '<div class="archive-actions">'+
        '<button class="icon-btn" onclick="restoreFromArchive(\''+t.id+'\')" style="font-size:11px;">↩ Restore</button>'+
        '<button class="icon-btn del-btn" onclick="deleteFromArchive(\''+t.id+'\')" style="font-size:11px;">✕</button>'+
      '</div></div>';
  }).join('');
}


// ── SMART SCHEDULING ──
function smartSchedule() {
  const unscheduled = tasks.filter(t => !t.startTime && !t.checked);
  if (!unscheduled.length) { showToast('All tasks already scheduled'); return; }
  const today = new Date();
  const pad = n => String(n).padStart(2,'0');
  // Collect occupied slots today
  const occupied = [];
  tasks.filter(t => t.startTime).forEach(t => {
    const [h,m] = t.startTime.split(':').map(Number);
    occupied.push({ start: h*60+m, end: h*60+m+t.duration });
  });
  events.filter(e => eventOccursOn(e, today) && e.time).forEach(e => {
    const [h,m] = e.time.split(':').map(Number);
    occupied.push({ start: h*60+m, end: h*60+m+e.duration });
  });
  occupied.sort((a,b) => a.start-b.start);

  // Find free slots between 8am and 10pm
  let cursor = Math.max(today.getHours()*60+today.getMinutes()+5, 8*60);
  let scheduled = 0;
  for (const t of unscheduled) {
    // Advance past any occupied slot
    let tries = 0;
    while (tries++ < 200) {
      const clash = occupied.find(o => cursor < o.end && cursor+t.duration > o.start);
      if (!clash) break;
      cursor = clash.end + 5;
    }
    if (cursor + t.duration > 22*60) break; // past 10pm, stop
    t.startTime = pad(Math.floor(cursor/60)) + ':' + pad(cursor%60);
    occupied.push({ start: cursor, end: cursor+t.duration });
    occupied.sort((a,b)=>a.start-b.start);
    cursor += t.duration + 10; // 10 min buffer
    scheduled++;
  }
  save(); renderTasks(); renderTimeline();
  showToast('Scheduled ' + scheduled + ' task(s) into free slots');
}

// ── CALENDAR ──
function renderCalendar() { renderMiniAgenda();
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


function burstConfetti() {
  const canvas = document.getElementById('confettiCanvas');
  if (!canvas) return;
  canvas.style.display = 'block';
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const pieces = Array.from({length:120}, () => ({
    x: Math.random()*canvas.width,
    y: Math.random()*canvas.height*0.4,
    r: Math.random()*6+3,
    d: Math.random()*120,
    color: ['#52e89e','#2D6A4F','#F1C40F','#E67E22','#8E44AD','#3498DB'][Math.floor(Math.random()*6)],
    tilt: Math.random()*10-10,
    speed: Math.random()*3+1,
    opacity: 1,
  }));
  let frame = 0;
  function draw() {
    ctx.clearRect(0,0,canvas.width,canvas.height);
    pieces.forEach(p => {
      p.y += p.speed; p.tilt += 0.1; p.opacity -= 0.008;
      ctx.save(); ctx.globalAlpha = Math.max(0,p.opacity);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.r, p.r*0.4, p.tilt, 0, Math.PI*2);
      ctx.fill(); ctx.restore();
    });
    frame++;
    if (frame < 120) requestAnimationFrame(draw);
    else { ctx.clearRect(0,0,canvas.width,canvas.height); canvas.style.display='none'; }
  }
  draw();
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


// ── PER-TASK REMINDERS ──
let firedReminders = new Set(JSON.parse(sessionStorage.getItem('dp_remfired')||'[]'));
function checkPerTaskReminders(now) {
  const pad = n => String(n).padStart(2,'0');
  tasks.forEach(t => {
    if (!t.startTime || !t.reminder || t.checked || t.running) return;
    const [h,m] = t.startTime.split(':').map(Number);
    const startMins = h*60+m;
    const nowMins = now.getHours()*60+now.getMinutes();
    const diff = startMins - nowMins;
    if (diff === parseInt(t.reminder) && now.getSeconds() < 5) {
      const key = t.id + '_' + toDateStr(now);
      if (!firedReminders.has(key)) {
        firedReminders.add(key);
        sessionStorage.setItem('dp_remfired', JSON.stringify([...firedReminders]));
        showToast('⏰ Starting in ' + t.reminder + ' min: ' + t.name);
        if (Notification.permission === 'granted') {
          new Notification('Starting soon', { body: t.name + ' starts in ' + t.reminder + ' min', icon: './icon-192.png' });
        }
      }
    }
  });
}

function showToast(msg) {
  let toast = document.getElementById('globalToast');
  if (!toast) { toast = document.createElement('div'); toast.id='globalToast'; document.body.appendChild(toast); }
  toast.textContent = msg;
  toast.className = 'global-toast show';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('show'), 4000);
}


let morningDigestFired = sessionStorage.getItem('dp_digest') === new Date().toDateString();
function checkMorningDigest(now) {
  if (morningDigestFired) return;
  if (now.getHours() === 8 && now.getMinutes() === 0 && now.getSeconds() < 5) {
    morningDigestFired = true;
    sessionStorage.setItem('dp_digest', now.toDateString());
    const todayStr = toDateStr(now);
    const tmrw = new Date(now); tmrw.setDate(tmrw.getDate()+1);
    const tmrwStr = toDateStr(tmrw);
    const todayDl = deadlines.filter(d => !d.checked && d.date === todayStr);
    const tmrwDl  = deadlines.filter(d => !d.checked && d.date === tmrwStr);
    const todayEv = events.filter(e => eventOccursOn(e, now));
    let msg = '🌅 Good morning! ';
    if (todayDl.length) msg += todayDl.length + ' deadline(s) due today. ';
    if (tmrwDl.length)  msg += tmrwDl.length + ' due tomorrow. ';
    if (todayEv.length) msg += todayEv.length + ' event(s) today.';
    if (!todayDl.length && !tmrwDl.length && !todayEv.length) msg += 'Clear schedule today!';
    showToast(msg);
    if (Notification.permission === 'granted') {
      new Notification('Daily Planner — Morning Digest', { body: msg, icon: './icon-192.png' });
    }
  }
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
  updateNextTaskTicker();

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
  checkAutoStart(now);checkAlarms(now);checkDeadlineWarnings(now);checkPerTaskReminders(now);checkMorningDigest(now);checkInReminders();if(now.getMinutes()===0&&now.getSeconds()===0){updateHeatmap();}if(timeboxMode)updateTimeboxTicker();
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
      case 'template': case 'tmpl': cmdTemplate(sub, rest); break;
      case 'dep': case 'deps': cmdDep(sub, rest); break;
      case 'recurring': case 'rec': cmdRecurring(sub, rest); break;
      case 'timebox': case 'tb': if(sub==='off'||sub==='disable'){disableTimeboxMode();termOk('Timebox off');}else{enableTimeboxMode();}; break;
      case 'week': openWeekView(); termOk('Week view opened'); break;
      case 'exam': case 'exams': openExamCountdown(); termOk('Exam countdown opened'); break;
      case 'heatmap': renderHeatmap('termHeatmapDiv'); const thd=document.getElementById('termHeatmapDiv'); if(thd)thd.style.display='block'; break;
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
    '</div>' +
    '<div class="an-section-title">Productivity Heatmap (12 weeks)</div>' +
    '<div id="analyticsHeatmap"></div>';
  setTimeout(()=>renderHeatmap('analyticsHeatmap'),50);
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


// ══════════════════════════════════════════════════════
// ── SUBTASKS ──
// ══════════════════════════════════════════════════════
function addSubtask(taskId) {
  const inp = document.getElementById('sti_' + taskId);
  if (!inp) return;
  const name = inp.value.trim();
  if (!name) return;
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;
  if (!task.subtasks) task.subtasks = [];
  task.subtasks.push({ id: uid(), name, done: false });
  inp.value = '';
  save(); renderTasks();
}

function subtaskKeydown(e, taskId) {
  if (e.key === 'Enter') { e.preventDefault(); addSubtask(taskId); }
}

function toggleSubtask(taskId, subId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task || !task.subtasks) return;
  const sub = task.subtasks.find(s => s.id === subId);
  if (sub) { sub.done = !sub.done; save(); renderTasks(); }
}

function deleteSubtask(taskId, subId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;
  task.subtasks = (task.subtasks || []).filter(s => s.id !== subId);
  save(); renderTasks();
}

// ══════════════════════════════════════════════════════
// ── TASK NOTES ──
// ══════════════════════════════════════════════════════
function toggleTaskNotes(taskId) {
  const body = document.getElementById('notes_' + taskId);
  if (!body) return;
  const open = body.style.display === 'block';
  body.style.display = open ? 'none' : 'block';
  if (!open) { const ta = body.querySelector('textarea'); if (ta) ta.focus(); }
}

function saveTaskNote(taskId, val) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;
  task.notes = val;
  save();
}

// ══════════════════════════════════════════════════════
// ── TASK DEPENDENCIES ──
// ══════════════════════════════════════════════════════
function setDependency(taskId, blockedById) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;
  if (!task.blockedBy) task.blockedBy = [];
  if (!task.blockedBy.includes(blockedById)) {
    task.blockedBy.push(blockedById);
    save(); renderTasks();
  }
}

function removeDependency(taskId, blockedById) {
  const task = tasks.find(t => t.id === taskId);
  if (!task || !task.blockedBy) return;
  task.blockedBy = task.blockedBy.filter(id => id !== blockedById);
  save(); renderTasks();
}

function isBlocked(task) {
  if (!task.blockedBy || !task.blockedBy.length) return false;
  return task.blockedBy.some(bid => {
    const blocker = tasks.find(t => t.id === bid);
    return blocker && !blocker.checked;
  });
}

// ══════════════════════════════════════════════════════
// ── RECURRING TASKS ──
// ══════════════════════════════════════════════════════
function resetRecurringTasks() {
  const today = toDateStr(new Date());
  const lastReset = localStorage.getItem('dp_lastreset');
  if (lastReset === today) return; // already reset today
  tasks.forEach(t => {
    if (!t.recurring) return;
    t.checked = false;
    t.elapsed = 0;
    if (t.running) { clearInterval(timers[t.id]); delete timers[t.id]; t.running = false; }
  });
  localStorage.setItem('dp_lastreset', today);
  save();
}

// ══════════════════════════════════════════════════════
// ── TASK TEMPLATES ──
// ══════════════════════════════════════════════════════
function saveTemplates() { localStorage.setItem('dp_templates', JSON.stringify(templates)); }

function createTemplate(name, taskDefs) {
  // taskDefs: [{name, duration, importance}]
  templates.push({ id: uid(), name, tasks: taskDefs, created: Date.now() });
  saveTemplates();
}

function stampTemplate(templateId, startTime) {
  const tmpl = templates.find(t => t.id === templateId);
  if (!tmpl) return 0;
  let cursor = startTime ? timeToMins(startTime) : null;
  tmpl.tasks.forEach(def => {
    const newTask = {
      id: uid(), name: def.name,
      importance: def.importance || 'medium',
      duration: def.duration || 30,
      startTime: cursor !== null ? String(Math.floor(cursor/60)).padStart(2,'0')+':'+String(cursor%60).padStart(2,'0') : '',
      elapsed:0, running:false, done:false, checked:false,
      subtasks:[], notes:'', blockedBy:[], recurring:null
    };
    tasks.push(newTask);
    if (cursor !== null) cursor += def.duration + 5;
  });
  save(); renderTasks(); renderTimeline();
  return tmpl.tasks.length;
}

function deleteTemplate(id) {
  templates = templates.filter(t => t.id !== id);
  saveTemplates();
}

function openTemplateManager() {
  renderTemplateManager();
  document.getElementById('templateOverlay').style.display = 'flex';
}
function closeTemplateManager() {
  document.getElementById('templateOverlay').style.display = 'none';
}

function renderTemplateManager() {
  const el = document.getElementById('templateContent');
  if (!el) return;
  let html = '<div class="tmpl-list">';
  if (!templates.length) {
    html += '<div class="review-empty">No templates yet. Create one via terminal:<br><code>template save "Homework" "Read:30:high,Notes:20:medium,Review:15:medium"</code></div>';
  } else {
    templates.forEach(t => {
      html += '<div class="tmpl-card">' +
        '<div class="tmpl-name">' + escHtml(t.name) + '</div>' +
        '<div class="tmpl-tasks">' + t.tasks.map(d => escHtml(d.name) + ' ' + d.duration + 'min').join(' · ') + '</div>' +
        '<div class="tmpl-actions">' +
          '<button class="review-btn" style="font-size:12px;padding:6px 14px;" onclick="stampTemplateUI(\''+ t.id +'\')">▶ Stamp to today</button>' +
          '<button class="review-btn secondary" style="font-size:12px;padding:6px 10px;" onclick="deleteTemplate(\''+ t.id +'\');renderTemplateManager()">✕</button>' +
        '</div>' +
      '</div>';
    });
  }
  html += '</div>';
  // Create new template UI
  html += '<div class="tmpl-create">' +
    '<div class="an-section-title">Create New Template</div>' +
    '<input type="text" id="tmplName" class="tmpl-input" placeholder="Template name, e.g. Morning Routine" />' +
    '<textarea id="tmplDefs" class="review-textarea" style="min-height:70px;" placeholder="Tasks, one per line:\nRead chapters: 30min: high\nMake notes: 20min: medium\nReview: 15min: medium"></textarea>' +
    '<button class="review-btn" onclick="createTemplateUI()">+ Save Template</button>' +
  '</div>';
  el.innerHTML = html;
}

function stampTemplateUI(id) {
  const startVal = prompt('Start time for first task? (e.g. 14:30, 2pm) — leave blank for no time');
  const count = stampTemplate(id, startVal || null);
  closeTemplateManager();
  termOk('Stamped ' + count + ' tasks from template');
}

function createTemplateUI() {
  const name = document.getElementById('tmplName').value.trim();
  const defs = document.getElementById('tmplDefs').value.trim();
  if (!name || !defs) return;
  const taskDefs = defs.split('\n').map(line => {
    const parts = line.split(':').map(s => s.trim());
    return { name: parts[0] || 'Task', duration: parseInt(parts[1]) || 30, importance: normalizeImp(parts[2] || 'medium') };
  }).filter(d => d.name);
  if (!taskDefs.length) return;
  createTemplate(name, taskDefs);
  renderTemplateManager();
}

// ══════════════════════════════════════════════════════
// ── TIMEBOX MODE ──
// ══════════════════════════════════════════════════════
function enableTimeboxMode() {
  timeboxMode = true;
  document.getElementById('timeboxBanner').style.display = 'flex';
  timeboxInterval = setInterval(updateTimeboxTicker, 10000);
  updateTimeboxTicker();
  termOk('Timebox mode enabled — schedule locked, auto-advancing');
}

function disableTimeboxMode() {
  timeboxMode = false;
  clearInterval(timeboxInterval);
  document.getElementById('timeboxBanner').style.display = 'none';
}

function updateTimeboxTicker() {
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  // Find next scheduled task
  const upcoming = tasks
    .filter(t => t.startTime && !t.checked)
    .map(t => { const [h,m] = t.startTime.split(':').map(Number); return { ...t, startMins: h*60+m }; })
    .sort((a,b) => a.startMins - b.startMins);
  const next = upcoming.find(t => t.startMins >= nowMins);
  const current = upcoming.find(t => {
    const endMins = t.startMins + t.duration;
    return t.startMins <= nowMins && nowMins < endMins;
  });
  const el = document.getElementById('timeboxInfo');
  if (!el) return;
  if (current) {
    const elapsed = (nowMins - current.startMins);
    const remaining = current.duration - elapsed;
    const overrun = remaining < 0;
    el.innerHTML = (overrun ? '⚠ Overrunning: ' : '▶ Now: ') +
      '<strong>' + escHtml(current.name) + '</strong>' +
      (overrun ? ' by ' + Math.abs(remaining) + 'min' : ' — ' + remaining + 'min left') +
      (next ? ' → Next: ' + escHtml(next.name) + ' @' + next.startTime : '');
    el.style.color = overrun ? '#E74C3C' : 'inherit';
    if (overrun && !current.running) playTaskEndSound();
  } else if (next) {
    const diff = next.startMins - nowMins;
    el.innerHTML = 'Up next: <strong>' + escHtml(next.name) + '</strong> in ' + diff + 'min @' + next.startTime;
    el.style.color = 'inherit';
    // auto-start if it's time
    if (diff <= 0 && !next.running) startTimer(next.id);
  } else {
    el.innerHTML = 'No more scheduled tasks today';
  }
}

// ══════════════════════════════════════════════════════
// ── WEEK VIEW ──
// ══════════════════════════════════════════════════════
function openWeekView() {
  weekViewDate = weekViewDate || new Date();
  renderWeekView();
  document.getElementById('weekViewOverlay').style.display = 'flex';
}
function closeWeekView() { document.getElementById('weekViewOverlay').style.display = 'none'; }
function weekViewPrev() { weekViewDate.setDate(weekViewDate.getDate()-7); renderWeekView(); }
function weekViewNext() { weekViewDate.setDate(weekViewDate.getDate()+7); renderWeekView(); }

function renderWeekView() {
  const el = document.getElementById('weekViewContent');
  if (!el) return;
  // Get Monday of current week
  const d = new Date(weekViewDate);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff); d.setHours(0,0,0,0);
  const weekDays = Array.from({length:7}, (_,i) => { const dd = new Date(d); dd.setDate(d.getDate()+i); return dd; });
  const today = toDateStr(new Date());
  const HOUR_H = 40;

  // Week header
  let html = '<div class="wv-header">';
  html += '<div class="wv-time-col"></div>';
  weekDays.forEach(wd => {
    const ds = toDateStr(wd);
    const isToday = ds === today;
    html += '<div class="wv-day-head' + (isToday?' wv-today':'') + '">' +
      '<div class="wv-day-name">' + DAYS[wd.getDay()] + '</div>' +
      '<div class="wv-day-num' + (isToday?' wv-today-num':'') + '">' + wd.getDate() + '</div>' +
    '</div>';
  });
  html += '</div>';

  // Grid
  html += '<div class="wv-grid-wrap"><div class="wv-grid">';
  // Time labels + rows
  html += '<div class="wv-time-lanes">';
  for (let h = 0; h < 24; h++) {
    const lbl = h===0?'12am':h<12?h+'am':h===12?'12pm':(h-12)+'pm';
    html += '<div class="wv-hour-row" style="height:'+HOUR_H+'px;"><span class="wv-hour-lbl">'+lbl+'</span></div>';
  }
  html += '</div>';

  // Day columns
  weekDays.forEach(wd => {
    const ds = toDateStr(wd);
    const isToday = ds === today;
    html += '<div class="wv-day-col' + (isToday?' wv-today-col':'') + '">';
    // Hour lines
    for (let h = 0; h < 24; h++) html += '<div class="wv-hour-line" style="top:'+(h*HOUR_H)+'px;"></div>';
    // Tasks
    tasks.filter(t => t.startTime && !t.checked).forEach(t => {
      const [th, tm] = t.startTime.split(':').map(Number);
      const top = (th*60+tm)/60*HOUR_H;
      const height = Math.max(t.duration/60*HOUR_H, 18);
      html += '<div class="wv-block task-block" style="top:'+top+'px;height:'+height+'px;" title="'+escHtml(t.name)+' ('+t.duration+'min)">' +
        '<div class="wv-block-name">' + escHtml(t.name) + '</div>' +
      '</div>';
    });
    // Events
    events.filter(ev => eventOccursOn(ev, wd) && ev.time).forEach(ev => {
      const [eh, em] = ev.time.split(':').map(Number);
      const top = (eh*60+em)/60*HOUR_H;
      const height = Math.max(ev.duration/60*HOUR_H, 18);
      html += '<div class="wv-block event-block" style="top:'+top+'px;height:'+height+'px;" title="'+escHtml(ev.name)+'">' +
        '<div class="wv-block-name">' + escHtml(ev.name) + '</div>' +
      '</div>';
    });
    // Deadlines
    deadlines.filter(dl => dl.date === ds && !dl.checked).forEach(dl => {
      html += '<div class="wv-deadline-chip" title="Deadline: '+escHtml(dl.name)+'">📅 '+escHtml(dl.name.length>12?dl.name.slice(0,10)+'…':dl.name)+'</div>';
    });
    html += '</div>';
  });
  html += '</div></div>';

  // Week label
  const label = MONTHS[weekDays[0].getMonth()].slice(0,3) + ' ' + weekDays[0].getDate() + ' – ' +
    MONTHS[weekDays[6].getMonth()].slice(0,3) + ' ' + weekDays[6].getDate() + ', ' + weekDays[6].getFullYear();
  document.getElementById('weekViewLabel').textContent = label;
  el.innerHTML = html;

  // Scroll to 7am
  setTimeout(() => { const w = el.querySelector('.wv-grid-wrap'); if(w) w.scrollTop = 7*HOUR_H; }, 50);
}

// ══════════════════════════════════════════════════════
// ── EXAM COUNTDOWN MODE ──
// ══════════════════════════════════════════════════════
function openExamCountdown() {
  renderExamCountdown();
  document.getElementById('examOverlay').style.display = 'flex';
}
function closeExamCountdown() { document.getElementById('examOverlay').style.display = 'none'; }

function renderExamCountdown() {
  const el = document.getElementById('examContent');
  if (!el) return;
  const today = new Date(); today.setHours(0,0,0,0);
  // Find critical/high deadlines
  const exams = deadlines.filter(dl => !dl.checked && (dl.isExam || ['critical','high'].includes(dl.importance)))
    .sort((a,b) => a.date.localeCompare(b.date));

  if (!exams.length) {
    el.innerHTML = '<div class="review-empty">No high-priority deadlines found.<br>Add a deadline with <strong>Critical</strong> or <strong>High</strong> priority to use this feature.</div>';
    return;
  }

  let html = '';
  exams.forEach(exam => {
    const due = new Date(exam.date + 'T00:00:00');
    const daysLeft = Math.max(Math.round((due - today) / 86400000), 0);
    // Study plan: spread across available days, skip days with no time
    const studyDays = Math.max(daysLeft, 1);
    const hoursPerDay = daysLeft > 0 ? Math.max(1, Math.round(8 / Math.sqrt(daysLeft))) : 8;
    const planRows = Math.min(studyDays, 7);

    html += '<div class="exam-card">' +
      '<div class="exam-header">' +
        '<div class="exam-name">' + escHtml(exam.name) + '</div>' +
        '<span class="importance-badge ' + impClass(exam.importance) + '">' + impLabel(exam.importance) + '</span>' +
      '</div>' +
      '<div class="exam-countdown-row">' +
        '<div class="exam-days">' + daysLeft + '</div>' +
        '<div class="exam-days-label">' + (daysLeft === 1 ? 'day' : 'days') + ' left</div>' +
        '<div class="exam-date">Due ' + exam.date + '</div>' +
      '</div>' +
      '<div class="exam-plan-title">Suggested daily study</div>' +
      '<div class="exam-plan">' +
        Array.from({length: planRows}, (_,i) => {
          const dd = new Date(today); dd.setDate(today.getDate()+i);
          return '<div class="exam-plan-row">' +
            '<span class="exam-plan-day">' + DAYS[dd.getDay()] + ' ' + (dd.getMonth()+1) + '/' + dd.getDate() + '</span>' +
            '<span class="exam-plan-hrs">' + hoursPerDay + 'h study</span>' +
          '</div>';
        }).join('') +
        (daysLeft > 7 ? '<div class="exam-plan-more">+ ' + (daysLeft-7) + ' more days…</div>' : '') +
      '</div>' +
      '<button class="review-btn" style="font-size:12px;padding:7px 16px;margin-top:10px;" onclick="stampExamPlan(\''+ exam.id +'\','+ hoursPerDay +')">▶ Add study tasks to today</button>' +
    '</div>';
  });
  el.innerHTML = html;
}

function stampExamPlan(examId, hoursPerDay) {
  const exam = deadlines.find(d => d.id === examId);
  if (!exam) return;
  const mins = hoursPerDay * 60;
  tasks.push({ id:uid(), name:'Study: '+exam.name, importance: exam.importance,
    duration: mins, startTime:'', elapsed:0, running:false, done:false, checked:false,
    subtasks:[], notes:'Exam on '+exam.date, blockedBy:[], recurring:null });
  save(); renderTasks();
  closeExamCountdown();
  termOk('Added ' + mins + 'min study task for "' + exam.name + '"');
}

// ══════════════════════════════════════════════════════
// ── DAILY HEATMAP ──
// ══════════════════════════════════════════════════════
function updateHeatmap() {
  const today = toDateStr(new Date());
  const done = tasks.filter(t => t.checked).length;
  const total = tasks.length;
  const score = total > 0 ? Math.round(done / total * 100) : 0;
  heatmapData[today] = { done, total, score };
  localStorage.setItem('dp_heatmap', JSON.stringify(heatmapData));
}

function renderHeatmap(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  // Show last 12 weeks (84 days)
  const today = new Date(); today.setHours(0,0,0,0);
  const days = Array.from({length:84}, (_,i) => {
    const d = new Date(today); d.setDate(today.getDate()-83+i);
    return { date: toDateStr(d), dow: d.getDay(), label: DAYS[d.getDay()] + ' ' + (d.getMonth()+1) + '/' + d.getDate() };
  });

  // Pad start to Sunday
  const startDow = days[0].dow;
  const padded = Array(startDow).fill(null).concat(days);

  function heatColor(score) {
    if (score === undefined) return 'var(--surface2)';
    if (score === 0) return '#f0ede6';
    if (score < 25) return '#b7e4c7';
    if (score < 50) return '#74c69d';
    if (score < 75) return '#40916c';
    return '#1b4332';
  }

  let html = '<div class="heatmap-grid">';
  html += '<div class="heatmap-dow-labels">' + ['S','M','T','W','T','F','S'].map(d=>'<div>'+d+'</div>').join('') + '</div>';
  html += '<div class="heatmap-cells">';
  padded.forEach(day => {
    if (!day) { html += '<div class="heatmap-cell empty"></div>'; return; }
    const data = heatmapData[day.date];
    const score = data ? data.score : undefined;
    const isToday = day.date === toDateStr(new Date());
    html += '<div class="heatmap-cell' + (isToday?' hm-today':'') + '" style="background:' + heatColor(score) + ';" title="' + day.label + (data ? ': '+data.done+'/'+data.total+' tasks ('+score+'%)' : ': no data') + '"></div>';
  });
  html += '</div></div>';
  el.innerHTML = html;
}

// ══════════════════════════════════════════════════════
// ── OVERDUE RADAR ──
// ══════════════════════════════════════════════════════
function renderOverdueRadar() {
  const el = document.getElementById('overdueRadar');
  if (!el) return;
  const today = new Date(); today.setHours(0,0,0,0);
  const overdueDl = deadlines.filter(dl => {
    const due = new Date(dl.date+'T00:00:00');
    return due < today && !dl.checked;
  });
  const pendingHighTasks = tasks.filter(t => !t.checked && ['critical','high'].includes(t.importance));
  const total = overdueDl.length + (pendingHighTasks.filter(t=>isBlocked(t)).length);

  if (!overdueDl.length && !pendingHighTasks.length) {
    el.style.display = 'none';
    return;
  }

  el.style.display = 'flex';
  let msg = '';
  if (overdueDl.length) msg += overdueDl.length + ' overdue deadline' + (overdueDl.length>1?'s':'');
  if (pendingHighTasks.length) {
    if (msg) msg += ' · ';
    msg += pendingHighTasks.length + ' high-priority task' + (pendingHighTasks.length>1?'s':'') + ' pending';
  }
  el.innerHTML =
    '<span class="radar-icon">🔴</span>' +
    '<span class="radar-text">' + msg + '</span>' +
    '<div class="radar-items">' +
      overdueDl.map(dl => '<span class="radar-pill">📅 ' + escHtml(dl.name) + ' · ' + deadlineCountdown(dl.date).label + '</span>').join('') +
    '</div>' +
    '<button class="radar-close" onclick="document.getElementById(\'overdueRadar\').style.display=\'none\'">✕</button>';
}

// ══════════════════════════════════════════════════════
// ── NEXT TASK TICKER (clock mode) ──
// ══════════════════════════════════════════════════════
function updateNextTaskTicker() {
  const el = document.getElementById('cmNextTicker');
  if (!el) return;
  const now = new Date();
  const nowMins = now.getHours()*60 + now.getMinutes();
  const allItems = [];
  tasks.filter(t => t.startTime && !t.checked).forEach(t => {
    const [h,m] = t.startTime.split(':').map(Number);
    allItems.push({ name:t.name, startMins:h*60+m, duration:t.duration, type:'task' });
  });
  events.filter(ev => eventOccursOn(ev,now) && ev.time).forEach(ev => {
    const [h,m] = ev.time.split(':').map(Number);
    allItems.push({ name:ev.name, startMins:h*60+m, duration:ev.duration, type:'event' });
  });
  allItems.sort((a,b) => a.startMins - b.startMins);

  const current = allItems.find(i => i.startMins <= nowMins && nowMins < i.startMins+i.duration);
  const next = allItems.find(i => i.startMins > nowMins);

  if (current) {
    const remaining = current.startMins + current.duration - nowMins;
    el.innerHTML = '<span class="ticker-dot active"></span><span class="ticker-label">Now: <strong>' + escHtml(current.name) + '</strong> — ' + remaining + 'min left</span>' +
      (next ? '<span class="ticker-sep">→</span><span class="ticker-next">Next: ' + escHtml(next.name) + ' @' + fmtMins(next.startMins) + '</span>' : '');
    el.style.display = 'flex';
  } else if (next) {
    const diff = next.startMins - nowMins;
    el.innerHTML = '<span class="ticker-dot"></span><span class="ticker-label">Next: <strong>' + escHtml(next.name) + '</strong> in ' + diff + 'min @' + fmtMins(next.startMins) + '</span>';
    el.style.display = 'flex';
  } else {
    el.style.display = 'none';
  }
}

// ══════════════════════════════════════════════════════
// ── TERMINAL: NEW COMMANDS ──
// ══════════════════════════════════════════════════════
function cmdTemplate(sub, args) {
  if (sub === 'save' || sub === 's') {
    const name = args.shift();
    if (!name) { termError('Usage: template save "Name" "task1:mins:priority,task2:mins"'); return; }
    const defsStr = args.join(' ');
    if (!defsStr) { termError('Need task definitions'); return; }
    const taskDefs = defsStr.split(',').map(s => {
      const p = s.trim().split(':');
      return { name: p[0].trim(), duration: parseInt(p[1])||30, importance: normalizeImp(p[2]||'medium') };
    }).filter(d => d.name);
    createTemplate(name, taskDefs);
    termOk('Template "' + name + '" saved with ' + taskDefs.length + ' tasks');
  } else if (sub === 'ls' || sub === 'list' || !sub) {
    if (!templates.length) { termWarn('No templates'); return; }
    termPrint('head', 'Templates (' + templates.length + '):');
    templates.forEach(t => termPrint('out', '  ' + t.name + '  →  ' + t.tasks.map(d=>d.name+'('+d.duration+'m)').join(', ')));
  } else if (sub === 'stamp' || sub === 'use') {
    const q = args.join(' ');
    const t = templates.find(x => x.id===q || x.name.toLowerCase().includes(q.toLowerCase()));
    if (!t) { termError('Template not found: ' + q); return; }
    const count = stampTemplate(t.id, null);
    termOk('Stamped ' + count + ' tasks from "' + t.name + '"');
  } else if (sub === 'rm' || sub === 'del') {
    const q = args.join(' ');
    const t = templates.find(x => x.id===q || x.name.toLowerCase().includes(q.toLowerCase()));
    if (!t) { termError('Template not found: ' + q); return; }
    deleteTemplate(t.id);
    termOk('Deleted template: "' + t.name + '"');
  } else { termError('Usage: template ls|save|stamp|rm'); }
}

function cmdDep(sub, args) {
  if (sub === 'add') {
    const taskQ = args[0], blockerQ = args[1];
    if (!taskQ || !blockerQ) { termError('Usage: dep add <task> <blocker>'); return; }
    const task = findTask(taskQ), blocker = findTask(blockerQ);
    if (!task) { termError('Task not found: ' + taskQ); return; }
    if (!blocker) { termError('Blocker task not found: ' + blockerQ); return; }
    setDependency(task.id, blocker.id);
    termOk('"' + task.name + '" is now blocked by "' + blocker.name + '"');
  } else if (sub === 'rm') {
    const taskQ = args[0], blockerQ = args[1];
    const task = findTask(taskQ), blocker = findTask(blockerQ);
    if (!task || !blocker) { termError('Task or blocker not found'); return; }
    removeDependency(task.id, blocker.id);
    termOk('Dependency removed');
  } else if (sub === 'ls' || !sub) {
    const deps = tasks.filter(t => t.blockedBy && t.blockedBy.length);
    if (!deps.length) { termWarn('No dependencies set'); return; }
    termPrint('head', 'Dependencies:');
    deps.forEach(t => {
      const blockers = (t.blockedBy||[]).map(bid => { const b=tasks.find(x=>x.id===bid); return b?'"'+b.name+'"':'?'; });
      const status = isBlocked(t) ? ' 🔒 BLOCKED' : ' ✓ clear';
      termPrint('out', '  "' + t.name + '" blocked by ' + blockers.join(', ') + status);
    });
  } else { termError('Usage: dep ls|add|rm'); }
}

function cmdRecurring(sub, args) {
  const q = args.join(' ');
  if (sub === 'set') {
    const taskQ = args.shift(), schedule = args.join(' ') || 'daily';
    const t = findTask(taskQ);
    if (!t) { termError('Task not found: ' + taskQ); return; }
    t.recurring = schedule; save(); renderTasks();
    termOk('"' + t.name + '" set to recurring: ' + schedule);
  } else if (sub === 'clear') {
    const t = findTask(q);
    if (!t) { termError('Task not found: ' + q); return; }
    t.recurring = null; save(); renderTasks();
    termOk('Recurring cleared for "' + t.name + '"');
  } else if (sub === 'ls' || !sub) {
    const rec = tasks.filter(t => t.recurring);
    if (!rec.length) { termWarn('No recurring tasks'); return; }
    termPrint('head', 'Recurring tasks:');
    rec.forEach(t => termPrint('out', '  ' + t.name + '  [' + t.recurring + ']'));
  } else { termError('Usage: recurring ls|set <task> <schedule>|clear <task>'); }
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
  openKanban,closeKanban,setKanban,kanbanDragStart,kanbanDrop,
  openArchive,closeArchive,archiveCheckedTasks,restoreFromArchive,deleteFromArchive,clearArchive,
  smartSchedule,
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
  addSubtask,subtaskKeydown,toggleSubtask,deleteSubtask,
  toggleTaskNotes,saveTaskNote,
  openTemplateManager,closeTemplateManager,createTemplateUI,stampTemplateUI,renderTemplateManager,
  openWeekView,closeWeekView,weekViewPrev,weekViewNext,
  openExamCountdown,closeExamCountdown,stampExamPlan,
  enableTimeboxMode,disableTimeboxMode,
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
  // Request notification permission
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  await syncLoad();
  renderTasks();renderEventList();renderCalendar();renderDeadlines();
  renderOverdueRadar();updateHeatmap();
  tickClock();setInterval(tickClock,1000);handleResize();
  // Render heatmap in analytics on demand
}

init();
})();
