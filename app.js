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
    elapsed:0, running:false, done:false
  });
  save();
  document.getElementById('newTaskName').value = '';
  renderTasks(); renderCalendar(); renderTimeline();
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
  list.innerHTML = tasks.map(task => {
    const total=task.duration*60, elapsed=task.elapsed||0;
    const pct=Math.min(elapsed/total,1), remaining=Math.max(total-elapsed,0);
    const td = task.running ? 'Remaining: '+fmtTime(remaining) : (elapsed>0?'Elapsed: '+fmtTime(elapsed):fmtTime(total)+' total');
    return `<div class="task-card${task.running?' running':''}" id="task_${task.id}">
      <div class="task-header">
        <div class="task-name">${escHtml(task.name)}</div>
        <span class="importance-badge ${impClass(task.importance)}">${impLabel(task.importance)}</span>
      </div>
      <div class="task-meta"><span>⏱ ${task.duration} min</span>${task.startTime?`<span>🕐 ${task.startTime}</span>`:''}</div>
      <div class="timer-bar-wrap"><div class="timer-bar" style="width:${pct*100}%;background:${timerColor(pct)};"></div></div>
      <div class="timer-display">${td}</div>
      <div class="task-actions">
        <button class="icon-btn start-btn" style="${task.running?'display:none':''}" onclick="startTimer('${task.id}')">▶ Start</button>
        <button class="icon-btn stop-btn"  style="${!task.running?'display:none':''}" onclick="stopTimer('${task.id}')">⏸ Pause</button>
        <button class="icon-btn" onclick="resetTimer('${task.id}')">↺ Reset</button>
        <button class="icon-btn" onclick="toggleEditTask('${task.id}')">✏ Edit</button>
        <button class="icon-btn del-btn" onclick="deleteTask('${task.id}')">✕</button>
      </div>
      <div class="edit-form" id="editForm_${task.id}">
        <input type="text" id="editName_${task.id}" value="${escHtml(task.name)}" placeholder="Task name" />
        <select id="editImp_${task.id}">
          <option value="low"${task.importance==='low'?' selected':''}>Low</option>
          <option value="medium"${task.importance==='medium'?' selected':''}>Medium</option>
          <option value="high"${task.importance==='high'?' selected':''}>High</option>
          <option value="critical"${task.importance==='critical'?' selected':''}>Critical</option>
        </select>
        <div class="form-row"><label>Duration (min)</label><input type="number" id="editDur_${task.id}" value="${task.duration}" min="1" max="480" /></div>
        <div class="form-row"><label>Start time</label><input type="time" id="editTime_${task.id}" value="${task.startTime||''}" style="flex:1;border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-family:'DM Sans',sans-serif;font-size:12px;background:var(--surface);color:var(--text);outline:none;" /></div>
        <div class="edit-actions">
          <button class="btn" style="font-size:12px;padding:6px 10px;" onclick="saveEditTask('${task.id}')">Save</button>
          <button class="btn secondary" style="font-size:12px;padding:6px 10px;" onclick="toggleEditTask('${task.id}')">Cancel</button>
        </div>
      </div>
    </div>`;
  }).join('');
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
  const sorted=[...deadlines].sort((a,b)=>a.date.localeCompare(b.date));
  list.innerHTML=sorted.map(dl=>{
    const cd=deadlineCountdown(dl.date);
    return `<div class="deadline-card" id="dlcard_${dl.id}">
      <div class="deadline-header">
        <div class="deadline-name">${escHtml(dl.name)}</div>
        <span class="importance-badge ${impClass(dl.importance)}">${impLabel(dl.importance)}</span>
      </div>
      <div class="deadline-meta"><span>📅 ${dl.date}</span><span class="deadline-countdown ${cd.cls}">${cd.label}</span></div>
      <div class="deadline-actions">
        <button class="icon-btn" onclick="toggleEditDeadline('${dl.id}')">✏ Edit</button>
        <button class="icon-btn del-btn" onclick="deleteDeadline('${dl.id}')">✕</button>
      </div>
      <div class="deadline-edit-form" id="dledit_${dl.id}">
        <input type="text" id="dlEditName_${dl.id}" value="${escHtml(dl.name)}" placeholder="Deadline name" />
        <select id="dlEditImp_${dl.id}">
          <option value="low"${dl.importance==='low'?' selected':''}>Low</option>
          <option value="medium"${dl.importance==='medium'?' selected':''}>Medium</option>
          <option value="high"${dl.importance==='high'?' selected':''}>High</option>
          <option value="critical"${dl.importance==='critical'?' selected':''}>Critical</option>
        </select>
        <input type="date" id="dlEditDate_${dl.id}" value="${dl.date}" />
        <div style="display:flex;gap:6px;">
          <button class="btn" style="font-size:12px;padding:5px 10px;" onclick="saveEditDeadline('${dl.id}')">Save</button>
          <button class="btn secondary" style="font-size:12px;padding:5px 10px;" onclick="toggleEditDeadline('${dl.id}')">Cancel</button>
        </div>
      </div>
    </div>`;
  }).join('');
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
  const today=new Date(), tlDiv=document.getElementById('timelineView'), items=[];
  tasks.forEach(t=>{ if(t.startTime){const[h,m]=t.startTime.split(':').map(Number); items.push({type:'task',hour:h,min:m,name:t.name,duration:t.duration,importance:t.importance}); }});
  events.forEach(ev=>{ if(eventOccursOn(ev,today)&&ev.time){const[h,m]=ev.time.split(':').map(Number); items.push({type:'event',hour:h,min:m,name:ev.name,duration:ev.duration,importance:ev.importance}); }});
  if(!items.length){tlDiv.innerHTML='<div class="empty-state">No scheduled items for today.</div>';return;}
  items.sort((a,b)=>a.hour*60+a.min-(b.hour*60+b.min));
  const minH=Math.max(0,items[0].hour-1), maxH=Math.min(23,items[items.length-1].hour+2);
  let html='';
  for(let h=minH;h<=maxH;h++){
    const label=h===0?'12 AM':h<12?h+' AM':h===12?'12 PM':(h-12)+' PM';
    const blocks=items.filter(i=>i.hour===h).map(i=>`<div class="timeline-block${i.type==='event'?' event-block':''}"><div class="tl-name">${escHtml(i.name)}</div><div class="tl-meta">${String(i.hour).padStart(2,'0')}:${String(i.min).padStart(2,'0')} · ${i.duration} min · <span class="${impClass(i.importance)}" style="font-size:10px;padding:1px 5px;border-radius:8px;font-weight:600;">${impLabel(i.importance)}</span></div></div>`).join('');
    html+=`<div class="timeline-hour"><div class="timeline-label">${label}</div>${blocks}</div>`;
  }
  tlDiv.innerHTML=html;
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
  updateClockMode(); renderAlarms();
  clockModeInterval=setInterval(updateClockMode,1000);
  fetchWeather();
  clockModeInterval2=setInterval(fetchWeather,600000);
}

function closeClockMode() {
  clockModeOpen=false;
  document.getElementById('clockOverlay').classList.remove('open');
  clearInterval(clockModeInterval);clearInterval(clockModeInterval2);
}

function switchCmTab(tab) {
  document.getElementById('cmActiveItems').style.display   = tab==='active'   ? '' : 'none';
  document.getElementById('cmUpcomingItems').style.display = tab==='upcoming' ? '' : 'none';
  document.getElementById('cmTabActive').classList.toggle('active',   tab==='active');
  document.getElementById('cmTabUpcoming').classList.toggle('active', tab==='upcoming');
}

function updateClockMode() {
  const now=new Date();
  const h=now.getHours(),m=now.getMinutes(),s=now.getSeconds();
  const ampm=h>=12?'PM':'AM',h12=h%12||12;
  const pad=n=>String(n).padStart(2,'0');
  document.getElementById('cmTime').childNodes[0].textContent=`${pad(h12)}:${pad(m)}:${pad(s)}`;
  document.getElementById('cmAmpm').textContent=ampm;
  document.getElementById('cmDate').textContent=DAYS[now.getDay()]+', '+MONTHS[now.getMonth()]+' '+now.getDate()+', '+now.getFullYear();
  const nowMins=h*60+m;

  // Active tasks
  const activeTasks=tasks.filter(t=>t.running);
  const activeEl=document.getElementById('cmActiveItems');
  activeEl.innerHTML=activeTasks.length?activeTasks.map(t=>{
    const total=t.duration*60,elapsed=t.elapsed||0,pct=Math.min(elapsed/total,1),remaining=Math.max(total-elapsed,0);
    const tc=pct>0.85?'danger':pct>0.65?'warn':'';
    const bc=pct>0.85?'#E74C3C':pct>0.65?'#E67E22':pct>0.4?'#F1C40F':'#52e89e';
    return `<div class="cm-item active-item"><div class="cm-item-dot active"></div><div class="cm-item-info"><div class="cm-item-name">${escHtml(t.name)}</div><div class="cm-item-meta">${t.duration} min · ${impLabel(t.importance)}</div><div class="cm-timer-bar"><div class="cm-timer-fill" style="width:${pct*100}%;background:${bc};"></div></div></div><div class="cm-timer ${tc}">${fmtTime(remaining)}</div></div>`;
  }).join(''):'<div class="cm-empty">Nothing running right now.</div>';

  // Upcoming
  const upcoming=[];
  tasks.forEach(t=>{if(!t.startTime)return;const[th,tm2]=t.startTime.split(':').map(Number);const diff=th*60+tm2-nowMins;if(diff>=0&&diff<=60)upcoming.push({...t,diff,isEvent:false});});
  events.forEach(ev=>{if(!ev.time||!eventOccursOn(ev,now))return;const[eh,em]=ev.time.split(':').map(Number);const diff=eh*60+em-nowMins;if(diff>=0&&diff<=60)upcoming.push({...ev,diff,isEvent:true});});
  upcoming.sort((a,b)=>a.diff-b.diff);
  document.getElementById('cmUpcomingItems').innerHTML=upcoming.length?upcoming.map(item=>`<div class="cm-item"><div class="cm-item-dot ${item.isEvent?'ev':''}"></div><div class="cm-item-info"><div class="cm-item-name">${escHtml(item.name)}</div><div class="cm-item-meta">${item.isEvent?'Event':'Task'} · ${item.duration} min · ${impLabel(item.importance)}</div></div><div style="font-size:13px;color:rgba(255,255,255,0.5);white-space:nowrap;">${item.diff===0?'Now':'in '+item.diff+' min'}</div></div>`).join(''):'<div class="cm-empty">Nothing in the next hour.</div>';

  // Deadlines
  updateClockModeDeadlines(now);
}

function updateClockModeDeadlines(now) {
  const todayEl=document.getElementById('cmDeadlineItemsToday');
  const tmrwEl =document.getElementById('cmDeadlineItemsTomorrow');
  if(!todayEl||!tmrwEl) return;
  const isPM3=now.getHours()>=15;
  const primary=new Date(now);primary.setHours(0,0,0,0);if(isPM3)primary.setDate(primary.getDate()+1);
  const secondary=new Date(primary);secondary.setDate(primary.getDate()+1);
  const ps=toDateStr(primary),ss=toDateStr(secondary);
  const todayLbl=todayEl.previousElementSibling,tmrwLbl=tmrwEl.previousElementSibling;
  if(todayLbl) todayLbl.textContent=isPM3?'Deadlines — Tomorrow':'Deadlines — Today';
  if(tmrwLbl)  tmrwLbl.textContent =isPM3?'Deadlines — Day After':'Deadlines — Tomorrow';
  function renderList(el,dls,empty){
    if(!dls.length){el.innerHTML=`<div class="cm-empty">${empty}</div>`;return;}
    el.innerHTML=dls.map(dl=>{const cd=deadlineCountdown(dl.date);return `<div class="cm-deadline-item"><div class="cm-deadline-dot ${cd.dotCls}"></div><div style="flex:1;"><div class="cm-deadline-name">${escHtml(dl.name)}</div><div class="cm-deadline-sub">${impLabel(dl.importance)}</div></div><div class="cm-deadline-countdown ${cd.cmCls}">${cd.label}</div></div>`;}).join('');
  }
  renderList(todayEl,deadlines.filter(dl=>dl.date===ps), isPM3?'None tomorrow.':'None today.');
  renderList(tmrwEl, deadlines.filter(dl=>dl.date===ss), isPM3?'None the day after.':'None tomorrow.');
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
  document.getElementById('clockTime').childNodes[0].textContent=`${pad(h12)}:${pad(m)}:${pad(s)}`;
  document.getElementById('clockAmpm').textContent=ampm;
  document.getElementById('clockDate').textContent=DAYS[now.getDay()]+', '+MONTHS[now.getMonth()]+' '+now.getDate()+', '+now.getFullYear();
  checkAutoStart(now);checkAlarms(now);checkDeadlineWarnings(now);
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

// ── EXPOSE TO WINDOW ──
Object.assign(window,{
  addTask,deleteTask,startTimer,stopTimer,resetTimer,toggleEditTask,saveEditTask,
  addEvent,deleteEvent,toggleEditEvent,saveEditEvent,toggleEventForm,scheduleTypeChange,
  addDeadline,deleteDeadline,toggleEditDeadline,saveEditDeadline,
  selectDay,calPrev,calNext,switchMain,mobileTab,
  openClockMode,closeClockMode,switchCmTab,fetchWeather,
  addAlarm,deleteAlarm,toggleAlarm,dismissAlarm,snoozeAlarm
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
