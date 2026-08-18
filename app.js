'use strict';

/* ================= 工具函数 ================= */
const $ = (id) => document.getElementById(id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function fmtDuration(ms, withSeconds = false) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (withSeconds) return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`;
}
function fmtClock(ms) { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function isoDateTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function shade(hex, amt) {   // amt: -1(变暗) ~ 1(变亮)
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (amt >= 0) { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
  else { r *= 1 + amt; g *= 1 + amt; b *= 1 + amt; }
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}
function isLightColor(hex) {   // 判断颜色明暗，决定用深色还是白色文字
  const n = parseInt(hex.slice(1), 16);
  const lum = ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
  return lum / 255 > 0.62;
}

/* ================= 数据层 (IndexedDB) ================= */
const DB_NAME = 'lyubishchev', DB_VERSION = 1;
let dbPromise = null;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('activities')) db.createObjectStore('activities', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('start', 'start');
        s.createIndex('activityId', 'activityId');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function db() { if (!dbPromise) dbPromise = openDB(); return dbPromise; }
function idb(store, method, arg) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, method === 'put' || method === 'delete' || method === 'clear' ? 'readwrite' : 'readonly');
    const os = t.objectStore(store);
    let req;
    if (method === 'getAll') req = os.getAll();
    else if (method === 'get') req = os.get(arg);
    else if (method === 'put') req = os.put(arg);
    else if (method === 'delete') req = os.delete(arg);
    else if (method === 'clear') req = os.clear();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}
function sessionsInRange(start, end) {
  return db().then((d) => new Promise((resolve, reject) => {
    const idx = d.transaction('sessions').objectStore('sessions').index('start');
    const req = idx.getAll(IDBKeyRange.bound(start, end, false, true));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

/* ================= 分类知识库（本地规则，无 API Key） ================= */
const CATEGORIES = ClassifyRules.CATEGORIES;
const CATEGORY_ORDER = new Map(CATEGORIES.map((c, i) => [c.id, i]));
const LEGACY_ACTIVITY_MAP = {
  work: 'kaituo', study: 'xuexi', life: 'yunwei', sport: 'jianshen', rest: 'shuimian',
  'mu-yin': 'kaituo', 'mu-mao': 'xuexi', 'huo-si': 'biaoda', 'huo-wu': 'xiezuo',
  'huo-xu': 'jianshen', 'tu-xu': 'jianshen', 'tu-chen': 'yunwei', 'tu-wei': 'shuimian',
  'tu-chou': 'zhengli', 'jin-shen': 'jinglian', 'jin-you': 'shouwei',
  'shui-hai': 'mingxiang', 'shui-zi': 'fupan',
};
const UNCLASSIFIED = { id: null, name: '未分类', element: '—', color: '#9ca3af', dizhi: '—', icon: '❓', words: [] };
const DEFAULT_SETTINGS = { idleMin: 60, longHours: 4, vibrate: true, theme: 'light', smartClassify: true };

// 分类是固定的，每次直接从知识库读取（不存 IndexedDB，改规则刷新即生效）
function catOf(session) {
  return state.activities.find((c) => c.id === session.activityId) || UNCLASSIFIED;
}

/* ================= 状态 ================= */
const state = {
  activities: [],
  settings: { ...DEFAULT_SETTINGS },
  running: null,        // 进行中的 session (end === null)
  view: 'record',
  period: 'day',
  periodOffset: 0,
};
let lastInteraction = Date.now();

/* ================= 初始化 ================= */
async function init() {
  try {
    setupEvents();
    applyTheme();

    // 分类固定为知识库十四行为（不存库，规则更新即时生效）
    state.activities = CATEGORIES.map((c) => ({ ...c }));

    const saved = (await idb('kv', 'get', 'settings'))?.value;
    state.settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
    applyTheme();               // 读取保存的设置后再应用主题

    // 旧版 session 活动 id 迁移（work/study/... → 五行分类 id）
    const sessions = await idb('sessions', 'getAll');
    let migrated = false;
    for (const s of sessions) {
      if (!CATEGORY_ORDER.has(s.activityId) && LEGACY_ACTIVITY_MAP[s.activityId]) {
        s.activityId = LEGACY_ACTIVITY_MAP[s.activityId];
        migrated = true;
      }
    }
    if (migrated) {
      await idb('sessions', 'clear');
      for (const s of sessions) await idb('sessions', 'put', s);
    }
    const running = sessions.find((s) => s.end == null);
    if (running) {
      if (Date.now() - running.start > 24 * 3600e3) {   // 超过 24 小时的僵尸会话自动关闭
        running.end = Date.now();
        await idb('sessions', 'put', running);
      } else {
        state.running = running;
      }
    }

    fillSelects();
    renderAll();
    startTicker();
    registerSW();
  } catch (err) {
    console.error('初始化失败:', err);
  }
}

/* ================= 视图切换 ================= */
function switchView(v) {
  state.view = v;
  document.querySelectorAll('.view').forEach((el) => el.classList.toggle('hidden', el.id !== 'view-' + v));
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.dataset.view === v));
  if (v === 'stats') renderStats();
}
function renderAll() { renderSettings(); updateStatusCard(); }

/* ================= 记录视图 ================= */
function updateStatusCard() {
  const card = $('statusCard'), label = $('statusLabel'), time = $('statusTime'), hint = $('statusHint'), chip = $('categoryChip');
  if (state.running) {
    const c = catOf(state.running);
    card.classList.add('running');
    if (c.id == null) {
      // 未分类：用用户上传的背景图（加深色蒙版），或渐变兜底
      if (state.settings.unclassifiedBg) {
        card.style.background = `linear-gradient(rgba(0,0,0,.38), rgba(0,0,0,.38)), url(${state.settings.unclassifiedBg}) center / cover`;
        card.style.color = '#ffffff';
      } else {
        card.style.background = 'linear-gradient(135deg, #aeb6c0, #7b8494)';
        card.style.color = '#ffffff';
      }
    } else {
      // 背景块 = 五行分类色，文字颜色按明暗自适应
      card.style.background = c.color;
      card.style.color = isLightColor(c.color) ? '#111827' : '#ffffff';
    }
    chip.textContent = `${c.icon} ${c.name} · ${c.element}·${c.dizhi}`;
    chip.classList.remove('hidden');
    label.textContent = state.running.note ? `📝 ${state.running.note}` : (c.id ? '正在计时' : '未分类');
    time.textContent = fmtDuration(Date.now() - state.running.start, true);
    hint.textContent = '点击分类可修改，或点「停止」结束计时';
  } else {
    card.classList.remove('running');
    card.style.background = '';
    card.style.color = '';
    chip.classList.add('hidden');
    label.textContent = '未在计时';
    time.textContent = '--:--:--';
    hint.textContent = '输入你在做什么即开始计时，识别不到记为未分类，可事后修改';
  }
}
async function startTimer(activityId, note = '') {
  const s = { id: uid(), activityId, note: note || '', start: Date.now(), end: null };
  await idb('sessions', 'put', s);
  state.running = s;
  buzz();
  updateStatusCard();
  updateTodayTotal();
}
async function stopTimer() {
  if (!state.running) return;
  state.running.end = Date.now();
  await idb('sessions', 'put', state.running);
  state.running = null;
  buzz();
  $('reminderBanner').classList.add('hidden');
  updateStatusCard();
  updateTodayTotal();
}
function buzz() { if (state.settings.vibrate && navigator.vibrate) navigator.vibrate(30); }

/* ================= 输入 + 本地智能分类（不卡录入，识别不到记为未分类） ================= */
async function submitNote() {
  const text = $('noteInput').value.trim();
  if (!text) return;
  // 计时中直接输入内容点开始 = 自动切换（先结束当前计时）
  if (state.running) await stopTimer();
  let activityId = null;
  if (state.settings.smartClassify) {
    const cat = ClassifyRules.classify(text, state.activities);   // 纯本地，无 API
    activityId = cat ? cat.id : null;
  }
  $('noteInput').value = '';
  await startTimer(activityId, text);
}

/* ================= 今日汇总与计时器 ================= */
async function updateTodayTotal() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const sessions = await sessionsInRange(start, start + 86400e3);
  let ms = 0;
  for (const s of sessions) ms += Math.max(0, (s.end == null ? Date.now() : s.end) - s.start);
  $('todayTotal').textContent = `今日 ${fmtDuration(ms)}`;
}
function startTicker() {
  setInterval(() => {                       // 每秒刷新计时显示
    if (state.running) updateStatusCard();
  }, 1000);
  setInterval(() => { updateTodayTotal(); checkReminders(); }, 30000);
}

/* ================= 提醒 ================= */
function checkReminders() {
  const banner = $('reminderBanner');
  if (!state.running) { banner.classList.add('hidden'); return; }
  // 睡眠修复类不提醒遗忘/超长（睡觉时手机不会操作，提醒无意义）
  if (catOf(state.running).id === 'shuimian') { banner.classList.add('hidden'); return; }
  const now = Date.now();
  const durMs = now - state.running.start;
  const name = actName(state.running.activityId);
  let msg = null;
  if (state.settings.longHours && durMs >= state.settings.longHours * 3600e3) {
    msg = `「${name}」已持续 ${fmtDuration(durMs)}，还在进行吗？`;
  } else if (state.settings.idleMin && now - lastInteraction >= state.settings.idleMin * 60e3) {
    msg = `已 ${state.settings.idleMin} 分钟没有操作，「${name}」还在进行吗？`;
  }
  if (msg) { $('reminderText').textContent = msg; banner.classList.remove('hidden'); }
  else banner.classList.add('hidden');
}
function actName(id) { const c = state.activities.find((x) => x.id === id); return c ? c.name : '未分类'; }

/* ================= 统计视图（饼图 + 图例 + 时间线） ================= */
function periodRange() {
  const now = new Date();
  const { period, periodOffset: off } = state;
  if (period === 'day') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + off);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return { start, end: start + 86400e3, label: `${d.getMonth() + 1}月${d.getDate()}日` };
  }
  if (period === 'week') {
    const day = now.getDay() || 7;
    const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1 + off * 7);
    const start = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate()).getTime();
    return { start, end: start + 7 * 86400e3, label: `${mon.getMonth() + 1}月${mon.getDate()}日 起` };
  }
  const m = new Date(now.getFullYear(), now.getMonth() + off, 1);
  const start = m.getTime();
  return { start, end: new Date(m.getFullYear(), m.getMonth() + 1, 1).getTime(), label: `${m.getFullYear()}年${m.getMonth() + 1}月` };
}
// 饼图专用色：同五行内微调明暗，让相邻同色扇区可区分（分类本身的颜色不变）
function pieColor(cat) {
  const group = state.activities.filter((c) => c.element === cat.element);
  const idx = group.findIndex((c) => c.id === cat.id);
  const amt = (idx - (group.length - 1) / 2) * 0.16;
  return shade(cat.color, amt);
}
// 饼图周期总时长（小时）：日=24，周=7×24，月=当月天数×24
function periodTotalHours() {
  if (state.period === 'week') return 7 * 24;
  if (state.period === 'month') {
    const now = new Date();
    const days = new Date(now.getFullYear(), now.getMonth() + 1 + state.periodOffset, 0).getDate();
    return days * 24;
  }
  return 24;
}
function drawPie(entries, totalMs, periodMs) {
  const canvas = $('pieChart');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(160, canvas.parentElement.clientWidth - 24);
  const h = 190;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#f3f4f6';
  const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#111827';
  if (!entries.length) {
    ctx.fillStyle = textColor;
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('该时段暂无记录', w / 2, h / 2);
    return;
  }
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 6;
  let angle = -Math.PI / 2;
  ctx.lineWidth = 2;
  for (const e of entries) {
    if (!e.value) continue;
    const sweep = (e.value / periodMs) * Math.PI * 2;
    const gapS = Math.min(0.03, sweep * 0.4);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, angle + gapS, angle + sweep - gapS);
    ctx.closePath();
    ctx.fillStyle = e.color;
    ctx.fill();
    ctx.strokeStyle = bg;
    ctx.stroke();
    angle += sweep;
  }
  // 未记录的时间：白色扇区
  const remain = Math.max(0, periodMs - totalMs);
  if (remain > 0) {
    const sweep = (remain / periodMs) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, angle, angle + sweep);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = bg;
    ctx.stroke();
  }
  ctx.fillStyle = textColor;
  ctx.font = '600 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(fmtDuration(totalMs), cx, cy - 2);
  ctx.font = '11px sans-serif';
  ctx.fillStyle = textColor;
  ctx.globalAlpha = 0.6;
  ctx.fillText('共记录', cx, cy + 14);
  ctx.globalAlpha = 1;
}
function renderLegend(sorted, totalMs, periodMs) {
  const el = $('pieLegend');
  el.innerHTML = '';
  for (const { cat, ms } of sorted) {
    const pct = periodMs ? (ms / periodMs) * 100 : 0;
    const row = document.createElement('div');
    row.className = 'legend-row';
    row.innerHTML = `<span class="dot" style="background:${pieColor(cat)}"></span>` +
      `<span class="l-name">${cat.icon} ${esc(cat.name)}</span>` +
      `<span class="l-meta">${cat.element}·${cat.dizhi}</span>` +
      `<span class="l-val">${fmtDuration(ms)} · ${pct.toFixed(0)}%</span>`;
    el.appendChild(row);
  }
  const remain = Math.max(0, periodMs - totalMs);
  if (periodMs > 0 && remain > 0) {
    const row = document.createElement('div');
    row.className = 'legend-row';
    row.innerHTML = `<span class="dot bordered"></span>` +
      `<span class="l-name">未记录</span><span class="l-meta"></span>` +
      `<span class="l-val">${fmtDuration(remain)} · ${((remain / periodMs) * 100).toFixed(0)}%</span>`;
    el.appendChild(row);
  }
}
async function renderStats() {
  const { start, end, label } = periodRange();
  $('periodLabel').textContent = label;
  const sessions = await sessionsInRange(start, end);
  const now = Date.now();
  const totals = new Map();
  let totalMs = 0;
  const list = [];
  for (const s of sessions) {
    const dur = Math.max(0, (s.end == null ? Math.min(now, end) : s.end) - s.start);
    const key = s.activityId ?? null;
    totals.set(key, (totals.get(key) || 0) + dur);
    totalMs += dur;
    list.push({ s, dur, running: s.end == null });
  }
  $('statsSummary').textContent = `共记录 ${fmtDuration(totalMs)} · 占${periodTotalHours()}小时 ${periodMs ? ((totalMs / periodMs) * 100).toFixed(0) : 0}%`;

  const sorted = [...totals.entries()]
    .map(([aid, ms]) => ({ cat: aid == null ? UNCLASSIFIED : state.activities.find((c) => c.id === aid), ms }))
    .filter((e) => e.cat)
    .sort((a, b) => b.ms - a.ms);
  const periodMs = periodTotalHours() * 3600e3;
  drawPie(sorted.map((e) => ({ color: pieColor(e.cat), value: e.ms })), totalMs, periodMs);
  renderLegend(sorted, totalMs, periodMs);

  const listEl = $('sessionList');
  listEl.innerHTML = '';
  if (state.period === 'day') {
    const h = document.createElement('div');
    h.className = 'list-heading';
    h.textContent = '时间线（点击可重新分类）';
    listEl.appendChild(h);
    list.sort((a, b) => b.s.start - a.s.start);
    if (!list.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = '今天还没有记录';
      listEl.appendChild(e);
    }
    for (const { s, dur, running } of list) {
      const c = catOf(s);
      const noteText = s.note || (c.id ? c.name : '未分类');
      const row = document.createElement('div');
      row.className = 'session-row clickable';
      row.innerHTML = `<span class="dot" style="background:${c.color}"></span>` +
        `<span class="s-name">${c.icon} ${esc(noteText)}</span>` +
        `<span class="s-time">${fmtClock(s.start)} – ${running ? '现在' : fmtClock(s.end)}</span>` +
        `<span class="s-dur">${fmtDuration(dur)}</span>`;
      row.addEventListener('click', () => openCategoryPicker('重新分类这条记录', async (cat) => {
        s.activityId = cat.id;
        await idb('sessions', 'put', s);
        renderStats();
      }));
      listEl.appendChild(row);
    }
  }
}

/* ================= 分类选择弹窗（重新分类用） ================= */
let pickerOnPick = null;
let pickerSelectedCat = null;
function openCategoryPicker(title, onPick) {
  pickerOnPick = onPick;
  $('catPickerTitle').textContent = title;
  const grid = $('catPickerGrid');
  grid.innerHTML = '';
  for (const c of state.activities) {
    const b = document.createElement('button');
    b.className = 'picker-btn';
    b.innerHTML = `<span class="p-icon">${c.icon}</span><span class="p-name">${esc(c.name)}</span><span class="p-meta">${c.element}·${c.dizhi}</span>`;
    b.addEventListener('click', () => showPickerDetail(c));
    grid.appendChild(b);
  }
  showPickerPage('grid');
  $('catPicker').classList.remove('hidden');
}
function showPickerDetail(cat) {
  pickerSelectedCat = cat;
  $('pickerDetail').innerHTML =
    `<div class="pd-head" style="background:${cat.color};color:${isLightColor(cat.color) ? '#111827' : '#ffffff'}">` +
      `<span class="pd-icon">${cat.icon}</span><span class="pd-name">${esc(cat.name)}</span><span class="pd-meta">${cat.element} · ${cat.dizhi}</span>` +
    `</div>` +
    `<div class="pd-rules-title">分类规则（含以下关键词即归入此类）</div>` +
    `<div class="pd-rules">${cat.words.map((w) => `<span class="pd-word">${esc(w)}</span>`).join('')}</div>`;
  showPickerPage('detail');
}
function showPickerPage(which) {
  const isGrid = which === 'grid';
  $('catPickerGrid').classList.toggle('hidden', !isGrid);
  $('pickerDetail').classList.toggle('hidden', isGrid);
  $('pickerGridActions').classList.toggle('hidden', !isGrid);
  $('pickerDetailActions').classList.toggle('hidden', isGrid);
}
function closePicker() { $('catPicker').classList.add('hidden'); }

/* ================= 设置视图（分类知识库，只读） ================= */
function renderSettings() {
  const list = $('categoryList');
  list.innerHTML = '';
  for (const c of state.activities) {
    const row = document.createElement('div');
    row.className = 'kb-row';
    row.innerHTML = `<span class="kb-dot" style="background:${c.color}"></span>` +
      `<span class="kb-icon">${c.icon}</span>` +
      `<span class="kb-name">${esc(c.name)}</span>` +
      `<span class="kb-meta">${c.element} · ${c.dizhi}</span>` +
      `<span class="kb-words">${esc(c.words.slice(0, 4).join('、'))}…</span>`;
    list.appendChild(row);
  }
}
async function saveSettings() {
  await idb('kv', 'put', { key: 'settings', value: state.settings });
}
function fillSelects() {
  const idleOpts = [[0, '关闭'], [30, '30 分钟'], [60, '60 分钟'], [120, '120 分钟']];
  const longOpts = [[0, '关闭'], [2, '2 小时'], [4, '4 小时'], [8, '8 小时']];
  $('setIdle').innerHTML = idleOpts.map(([v, l]) => `<option value="${v}"${v === state.settings.idleMin ? ' selected' : ''}>${l}</option>`).join('');
  $('setLong').innerHTML = longOpts.map(([v, l]) => `<option value="${v}"${v === state.settings.longHours ? ' selected' : ''}>${l}</option>`).join('');
  $('setVibrate').checked = !!state.settings.vibrate;
  $('setAI').checked = !!state.settings.smartClassify;
  $('setTheme').value = ['light', 'dark', 'custom'].includes(state.settings.theme) ? state.settings.theme : 'light';
  toggleBgUpload();
}

/* ================= 数据导出 / 导入 ================= */
function download(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function exportCSV() {
  idb('sessions', 'getAll').then((all) => {
    const rows = [['开始时间', '结束时间', '时长(分钟)', '行为标签', '五行', '地支', '备注']];
    all.filter((s) => s.end != null).sort((a, b) => a.start - b.start)
      .forEach((s) => {
        const c = catOf(s);
        rows.push([isoDateTime(s.start), isoDateTime(s.end), ((s.end - s.start) / 60000).toFixed(1),
          c.name, c.element, c.dizhi, s.note || '']);
      });
    const csv = '\ufeff' + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    download('柳比歇夫-记录.csv', csv, 'text/csv;charset=utf-8');
  });
}
function exportJSON() {
  idb('sessions', 'getAll').then((all) => {
    const data = { version: 2, exportedAt: new Date().toISOString(), sessions: all, settings: state.settings };
    download('柳比歇夫-备份.json', JSON.stringify(data, null, 2), 'application/json');
  });
}
function importJSON(file) {
  file.text().then((txt) => {
    try {
      const data = JSON.parse(txt);
      if (!Array.isArray(data.sessions)) throw new Error('缺少 sessions 数组');
      const sessions = data.sessions
        .filter((s) => s && s.id && s.activityId && typeof s.start === 'number')
        .map((s) => {
          if (!CATEGORY_ORDER.has(s.activityId) && LEGACY_ACTIVITY_MAP[s.activityId]) s.activityId = LEGACY_ACTIVITY_MAP[s.activityId];
          return s;
        });
      (async () => {
        await idb('sessions', 'clear');
        for (const s of sessions) await idb('sessions', 'put', s);
        if (data.settings && typeof data.settings === 'object') {
          state.settings = { ...DEFAULT_SETTINGS, ...data.settings };
          await idb('kv', 'put', { key: 'settings', value: state.settings });
          fillSelects();
          applyTheme();
        }
        state.running = sessions.find((s) => s.end == null) || null;
        renderAll();
        updateTodayTotal();
        if (state.view === 'stats') renderStats();
        alert('导入成功');
      })().catch((e) => alert('导入失败: ' + e.message));
    } catch (e) {
      alert('导入失败: ' + e.message);
    }
  });
}

/* ================= 导出明细表（Markdown 文档，储存在手机） ================= */
// 今日：0 点起；本周：周一起；本月：1 号起
function dayRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return { start, end: Date.now(), label: `${now.getMonth() + 1}月${now.getDate()}日` };
}
function weekRange() {
  const now = new Date();
  const day = now.getDay() || 7;   // 周一=1 … 周日=7
  const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1);
  const start = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate()).getTime();
  return { start, end: Date.now(), label: `本周（${mon.getMonth() + 1}月${mon.getDate()}日起）` };
}
function monthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return { start, end: Date.now(), label: `${now.getFullYear()}年${now.getMonth() + 1}月` };
}
async function buildDetailTable(range) {
  const sessions = (await sessionsInRange(range.start, range.end)).filter((s) => s.end != null);
  if (!sessions.length) return '';
  const lines = [];
  lines.push(`# 时间明细（${range.label}）`);
  const totalMs = sessions.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
  lines.push(`共记录 ${fmtDuration(totalMs)}`);
  lines.push('');
  // 按行为汇总
  const totals = new Map();
  for (const s of sessions) {
    const key = s.activityId ?? '';
    totals.set(key, (totals.get(key) || 0) + Math.max(0, s.end - s.start));
  }
  lines.push('## 按行为汇总');
  lines.push('| 行为 | 时长 | 占比 |');
  lines.push('|---|---|---|');
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  for (const [aid, ms] of sorted) {
    const c = aid === '' ? UNCLASSIFIED : state.activities.find((x) => x.id === aid);
    if (!c) continue;
    lines.push(`| ${c.name} | ${fmtDuration(ms)} | ${((ms / totalMs) * 100).toFixed(0)}% |`);
  }
  lines.push('');
  // 明细
  lines.push('## 明细');
  lines.push('| 开始 | 结束 | 时长 | 行为 | 内容 |');
  lines.push('|---|---|---|---|---|');
  sessions.sort((a, b) => a.start - b.start);
  for (const s of sessions) {
    const c = catOf(s);
    const note = (s.note || '').replace(/\|/g, '｜').replace(/\n/g, ' ');
    lines.push(`| ${fmtClock(s.start)} | ${fmtClock(s.end)} | ${fmtDuration(Math.max(0, s.end - s.start))} | ${c.name} | ${note} |`);
  }
  return lines.join('\n');
}
async function exportDetail(range, fileName, toastMsg) {
  const text = await buildDetailTable(range);
  if (!text) { showToast('该时段暂无记录'); return; }
  download(fileName, text, 'text/markdown;charset=utf-8');
  showToast(toastMsg);
}
let toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2400);
}

/* ================= 主题 / 背景 / 未分类背景图 / PWA ================= */
function applyTheme() {
  const body = document.body;
  let theme = 'light';
  if (state.settings.theme === 'dark') theme = 'dark';
  else if (state.settings.theme === 'custom' && state.settings.bgImage) theme = 'custom';
  document.documentElement.dataset.theme = theme;
  if (theme === 'custom') {
    body.style.backgroundImage = `url(${state.settings.bgImage})`;
    body.style.backgroundSize = 'cover';
    body.style.backgroundPosition = 'center';
  } else {
    body.style.backgroundImage = '';
    body.style.backgroundSize = '';
    body.style.backgroundPosition = '';
  }
  document.querySelector('meta[name="theme-color"]').setAttribute('content', theme === 'dark' ? '#0f1115' : '#1a73e8');
}
function toggleBgUpload() {
  $('bgUploadRow').style.display = state.settings.theme === 'custom' ? 'flex' : 'none';
}
if (matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {});
function registerSW() {
  // Service Worker 需要安全上下文 (https 或 localhost)，局域网 http 下自动跳过，不影响使用
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

/* ================= 确认对话框 ================= */
let dialogResolve = null;
function setupDialog() {
  const dlg = $('confirmDialog');
  $('dialogOk').addEventListener('click', () => { dlg.classList.add('hidden'); dialogResolve && dialogResolve(true); });
  $('dialogCancel').addEventListener('click', () => { dlg.classList.add('hidden'); dialogResolve && dialogResolve(false); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) { dlg.classList.add('hidden'); dialogResolve && dialogResolve(false); } });
}
function confirmDialog(text) {
  $('dialogText').textContent = text;
  $('confirmDialog').classList.remove('hidden');
  return new Promise((res) => { dialogResolve = res; });
}

/* ================= 事件绑定 ================= */
function setupEvents() {
  // 视图切换
  document.querySelectorAll('.tab').forEach((el) => el.addEventListener('click', () => switchView(el.dataset.view)));
  // 统计周期
  document.querySelectorAll('.period-btn').forEach((el) => el.addEventListener('click', () => {
    document.querySelectorAll('.period-btn').forEach((x) => x.classList.toggle('active', x === el));
    state.period = el.dataset.period;
    state.periodOffset = 0;
    renderStats();
  }));
  $('prevPeriod').addEventListener('click', () => { state.periodOffset--; renderStats(); });
  $('nextPeriod').addEventListener('click', () => { state.periodOffset++; renderStats(); });
  // 交互追踪（遗忘提醒用）
  document.addEventListener('pointerdown', () => { lastInteraction = Date.now(); });
  document.addEventListener('keydown', () => { lastInteraction = Date.now(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { updateTodayTotal(); checkReminders(); }
  });
  // 提醒横幅
  $('reminderStop').addEventListener('click', () => stopTimer());
  $('reminderKeep').addEventListener('click', () => { lastInteraction = Date.now(); $('reminderBanner').classList.add('hidden'); });
  $('stopBtn').addEventListener('click', () => stopTimer());
  // 计时中点击分类 chip = 重新分类
  $('categoryChip').addEventListener('click', () => {
    if (state.running) {
      openCategoryPicker('重新分类进行中的计时', async (cat) => {
        state.running.activityId = cat.id;
        await idb('sessions', 'put', state.running);
        updateStatusCard();
      });
    }
  });
  // 设置项
  $('setIdle').addEventListener('change', async (e) => { state.settings.idleMin = +e.target.value; await saveSettings(); });
  $('setLong').addEventListener('change', async (e) => { state.settings.longHours = +e.target.value; await saveSettings(); });
  $('setVibrate').addEventListener('change', async (e) => { state.settings.vibrate = e.target.checked; await saveSettings(); });
  $('setAI').addEventListener('change', async (e) => { state.settings.smartClassify = e.target.checked; await saveSettings(); });
  $('setTheme').addEventListener('change', async (e) => {
    state.settings.theme = e.target.value;
    await saveSettings();
    applyTheme();
    toggleBgUpload();
    if (state.view === 'stats') renderStats();
  });
  // 自定义背景图
  $('uploadBg').addEventListener('click', () => $('bgFile').click());
  $('bgFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) { showToast('图片过大，请选 4MB 以内'); e.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = async () => {
      state.settings.bgImage = reader.result;
      state.settings.theme = 'custom';
      await saveSettings();
      applyTheme();
      fillSelects();
      toggleBgUpload();
    };
    reader.readAsDataURL(f);
    e.target.value = '';
  });
  $('removeBg').addEventListener('click', async () => {
    state.settings.bgImage = '';
    state.settings.theme = 'light';
    await saveSettings();
    applyTheme();
    fillSelects();
    toggleBgUpload();
  });
  // 未分类背景图（计时状态卡与饼图扇区用）
  $('uploadUncBg').addEventListener('click', () => $('uncBgFile').click());
  $('uncBgFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) { showToast('图片过大，请选 4MB 以内'); e.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = async () => {
      state.settings.unclassifiedBg = reader.result;
      await saveSettings();
      updateStatusCard();
      if (state.view === 'stats') renderStats();
      showToast('未分类背景图已更新');
    };
    reader.readAsDataURL(f);
    e.target.value = '';
  });
  $('removeUncBg').addEventListener('click', async () => {
    state.settings.unclassifiedBg = '';
    await saveSettings();
    updateStatusCard();
    if (state.view === 'stats') renderStats();
  });
  // 输入 + 本地分类
  $('startNoteBtn').addEventListener('click', submitNote);
  $('noteInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitNote(); });
  // 分类选择弹窗
  $('catPickerCancel').addEventListener('click', closePicker);
  $('catPicker').addEventListener('click', (e) => { if (e.target === $('catPicker')) closePicker(); });
  $('pickerBack').addEventListener('click', () => showPickerPage('grid'));
  $('pickerConfirm').addEventListener('click', () => {
    if (pickerSelectedCat && pickerOnPick) {
      const cb = pickerOnPick;
      const cat = pickerSelectedCat;
      closePicker();
      cb(cat);
    }
  });
  // 数据操作
  $('exportToday').addEventListener('click', () => exportDetail(dayRange(), '时间明细-今日.md', '已导出今日明细表，保存在手机下载目录'));
  $('exportWeek').addEventListener('click', () => exportDetail(weekRange(), '时间明细-本周.md', '已导出本周明细表（周一起），保存在手机下载目录'));
  $('exportMonth').addEventListener('click', () => exportDetail(monthRange(), '时间明细-本月.md', '已导出本月明细表（1号起），保存在手机下载目录'));
  $('exportCsv').addEventListener('click', exportCSV);
  $('exportJson').addEventListener('click', exportJSON);
  $('importJson').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (e) => {
    if (e.target.files[0]) importJSON(e.target.files[0]);
    e.target.value = '';
  });
  $('clearData').addEventListener('click', async () => {
    if (await confirmDialog('确定清空所有时间记录吗？分类与设置保留。')) {
      await idb('sessions', 'clear');
      state.running = null;
      $('reminderBanner').classList.add('hidden');
      updateStatusCard();
      updateTodayTotal();
      if (state.view === 'stats') renderStats();
    }
  });
  $('resetAll').addEventListener('click', async () => {
    if (await confirmDialog('恢复默认设置？将清空全部记录与设置。')) {
      await idb('sessions', 'clear');
      state.settings = { ...DEFAULT_SETTINGS };
      await idb('kv', 'put', { key: 'settings', value: state.settings });
      state.running = null;
      $('reminderBanner').classList.add('hidden');
      fillSelects();
      applyTheme();
      renderAll();
      updateTodayTotal();
      if (state.view === 'stats') renderStats();
    }
  });
  setupDialog();
}

init();
