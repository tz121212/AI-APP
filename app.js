(() => {
  const STORAGE_KEY = 'daily-assistant-data-v1';
  const SCHEDULE_PEOPLE = ['军', '震'];
  const today = toDateKey(new Date());
  const state = loadState();
  let activeView = 'today';
  let searchQuery = '';
  let noteFilter = '全部';
  let calendarMonth = new Date();
  calendarMonth.setDate(1);
  let selectedDate = today;
  let schedulePerson = SCHEDULE_PEOPLE[0];
  let showCompleted = false;
  let scheduleSync = null;
  let scheduleSyncStatus = window.CLOUDBASE_SYNC_CONFIG?.env ? '尚未连接云端' : '云端服务尚未配置';
  const browserReminderTimers = new Map();
  const HISTORY_RETENTION_MONTHS = 1;

  const root = document.getElementById('view-root');
  const dialog = document.getElementById('editor-dialog');
  const form = document.getElementById('editor-form');
  const searchInput = document.getElementById('global-search');
  const searchBox = document.querySelector('.search-box');

  function toDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function fromDateKey(value) {
    if (!value) return null;
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day);
  }

  function isValidDateKey(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
    return toDateKey(fromDateKey(value)) === value;
  }

  function normalizeDaysOff(items) {
    if (!Array.isArray(items)) return [];
    const seen = new Set();
    return items.filter((item) => {
      if (!item || !isValidDateKey(item.date) || !SCHEDULE_PEOPLE.includes(item.person)) return false;
      const key = `${item.date}:${item.person}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((item) => ({ date: item.date, person: item.person }));
  }

  function scheduleKey(date, person) {
    return `${date}_${person}`;
  }

  function normalizeScheduleRecords(records, daysOff = []) {
    const result = {};
    if (records && typeof records === 'object' && !Array.isArray(records)) {
      Object.entries(records).forEach(([key, value]) => {
        const separator = key.indexOf('_');
        if (separator < 0 || !value || typeof value !== 'object') return;
        const date = key.slice(0, separator);
        const person = key.slice(separator + 1);
        if (!isValidDateKey(date) || !SCHEDULE_PEOPLE.includes(person) || typeof value.off !== 'boolean') return;
        result[key] = {
          date,
          person,
          off: value.off,
          updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : 0,
          deviceId: String(value.deviceId || '')
        };
      });
    }
    normalizeDaysOff(daysOff).forEach((item) => {
      const key = scheduleKey(item.date, item.person);
      if (!result[key]) result[key] = { ...item, off: true, updatedAt: 0, deviceId: '' };
    });
    return result;
  }

  function activeDaysOff(records) {
    return Object.values(records).filter((record) => record.off).map(({ date, person }) => ({ date, person }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.person.localeCompare(b.person));
  }

  function compareScheduleRecords(left, right) {
    const timestampDifference = left.updatedAt - right.updatedAt;
    if (timestampDifference) return timestampDifference;
    return left.deviceId.localeCompare(right.deviceId);
  }

  function escapeHTML(value = '') {
    return String(value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return {
        tasks: Array.isArray(saved.tasks) ? saved.tasks : [],
        notes: Array.isArray(saved.notes) ? saved.notes : [],
        daysOff: normalizeDaysOff(saved.daysOff),
        scheduleRecords: normalizeScheduleRecords(saved.scheduleRecords, saved.daysOff)
      };
    } catch {
      return { tasks: [], notes: [], daysOff: [], scheduleRecords: {} };
    }
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function historyCutoffTimestamp(now = new Date()) {
    const cutoff = new Date(now);
    cutoff.setMonth(cutoff.getMonth() - HISTORY_RETENTION_MONTHS);
    return cutoff.getTime();
  }

  function parseTimestamp(value) {
    const timestamp = Date.parse(value || '');
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function taskHistoryTimestamp(task) {
    if (task.completed) return parseTimestamp(task.completedAt || task.updatedAt || task.createdAt);
    if (task.dueDate) {
      const dueTimestamp = Date.parse(`${task.dueDate}T${task.dueTime || '23:59'}:00`);
      if (Number.isFinite(dueTimestamp) && dueTimestamp < Date.now()) return dueTimestamp;
    }
    return parseTimestamp(task.updatedAt || task.createdAt);
  }

  function cleanupExpiredHistory() {
    const cutoff = historyCutoffTimestamp();
    const expiredTaskIds = state.tasks
      .filter((task) => task && task.id && taskHistoryTimestamp(task) > 0 && taskHistoryTimestamp(task) < cutoff)
      .map((task) => String(task.id));
    expiredTaskIds.forEach((taskId) => removeReminder(taskId));
    const beforeTasks = state.tasks.length;
    const beforeNotes = state.notes.length;
    state.tasks = state.tasks.filter((task) => !expiredTaskIds.includes(String(task?.id)));
    state.notes = state.notes.filter((note) => {
      const timestamp = parseTimestamp(note?.updatedAt || note?.createdAt);
      return !timestamp || timestamp >= cutoff;
    });
    const removed = beforeTasks - state.tasks.length + beforeNotes - state.notes.length;
    if (removed) persist();
    return removed;
  }

  function mergeScheduleRecords(remoteRecords) {
    const incoming = normalizeScheduleRecords(remoteRecords);
    const merged = { ...state.scheduleRecords };
    const publish = [];
    Object.entries(incoming).forEach(([key, remote]) => {
      const local = merged[key];
      if (!local || compareScheduleRecords(local, remote) <= 0) merged[key] = remote;
      else publish.push([key, local]);
    });
    Object.entries(merged).forEach(([key, local]) => {
      if (!Object.prototype.hasOwnProperty.call(incoming, key)) publish.push([key, local]);
    });
    state.scheduleRecords = merged;
    state.daysOff = activeDaysOff(merged);
    persist();
    publish.forEach(([key, record]) => scheduleSync?.writeRecord(key, record));
    if (activeView === 'calendar') renderCalendar();
  }

  function setScheduleRecord(date, person, off) {
    const key = scheduleKey(date, person);
    const record = { date, person, off, updatedAt: Date.now(), deviceId: scheduleSync?.deviceId() || '' };
    state.scheduleRecords[key] = record;
    state.daysOff = activeDaysOff(state.scheduleRecords);
    persist();
    scheduleSync?.writeRecord(key, record);
  }

  function newId() {
    return globalThis.crypto?.randomUUID?.() || `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function formatDate(value, options = { month: 'long', day: 'numeric' }) {
    const date = fromDateKey(value);
    if (!date) return '未安排日期';
    return new Intl.DateTimeFormat('zh-CN', options).format(date);
  }

  function formatToday(value = new Date()) {
    return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(value);
  }

  function relativeDate(value) {
    const date = fromDateKey(value);
    const base = fromDateKey(today);
    if (!date) return '未安排日期';
    const offset = Math.round((date - base) / 86400000);
    if (offset < 0) return `逾期 ${Math.abs(offset)} 天`;
    if (offset === 0) return '今天';
    if (offset === 1) return '明天';
    return formatDate(value);
  }

  function sortTasks(items) {
    return [...items].sort((a, b) => {
      const dateA = a.dueDate || '9999-12-31';
      const dateB = b.dueDate || '9999-12-31';
      return dateA.localeCompare(dateB) || (a.dueTime || '99:99').localeCompare(b.dueTime || '99:99') || (a.createdAt || '').localeCompare(b.createdAt || '');
    });
  }

  function sortedNotes(items = state.notes) {
    return [...items].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  function taskReminderEnabled(task) {
    return task.reminderEnabled === undefined ? Boolean(task.dueDate && task.dueTime) : task.reminderEnabled === true;
  }

  function taskRow(task, compact = false) {
    const dateLabel = task.dueDate ? relativeDate(task.dueDate) : '';
    const timeLabel = task.dueTime ? `<span class="task-time ${task.dueDate < today ? 'late' : ''}"><i data-lucide="clock-3"></i>${escapeHTML(task.dueTime)}</span>` : '';
    const repeatLabel = task.repeat && task.repeat !== 'none' ? `<span class="repeat-label"><i data-lucide="repeat-2"></i>${repeatText(task.repeat)}</span>` : '';
    const reminderLabel = taskReminderEnabled(task) ? '<span class="reminder-label"><i data-lucide="bell-ring"></i>闹钟</span>' : '';
    const meta = (dateLabel || timeLabel || repeatLabel || reminderLabel) ? `<div class="task-meta">${dateLabel ? `<span>${escapeHTML(dateLabel)}</span>` : ''}${timeLabel}${repeatLabel}${reminderLabel}</div>` : '';
    return `<article class="task-row ${task.completed ? 'is-complete' : ''}" data-task-row="${escapeHTML(task.id)}">
      <input class="task-check" type="checkbox" aria-label="${task.completed ? '标记未完成' : '标记完成'}：${escapeHTML(task.title)}" data-action="toggle-task" data-id="${escapeHTML(task.id)}" ${task.completed ? 'checked' : ''} />
      <div class="task-copy" data-action="edit-entry" data-kind="task" data-id="${escapeHTML(task.id)}" role="button" tabindex="0">
        <span class="task-title">${escapeHTML(task.title)}</span>
        ${task.body && !compact ? `<span class="task-body">${escapeHTML(task.body)}</span>` : ''}${meta}
      </div>
      <button class="task-more" type="button" data-action="edit-entry" data-kind="task" data-id="${escapeHTML(task.id)}" aria-label="编辑待办"><i data-lucide="ellipsis"></i></button>
    </article>`;
  }

  function noteCard(note, compact = false) {
    const date = note.updatedAt ? new Date(note.updatedAt) : new Date();
    const dateLabel = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date);
    return `<article class="note-card" data-action="edit-entry" data-kind="note" data-id="${escapeHTML(note.id)}" role="button" tabindex="0">
      <div class="note-card-head"><span class="note-tag" data-tag="${escapeHTML(note.tag || '其他')}">${escapeHTML(note.tag || '其他')}</span><span class="note-date">${note.pinned ? '<i class="pin-mark" data-lucide="pin"></i>' : ''}${dateLabel}</span></div>
      <h3>${escapeHTML(note.title)}</h3>${note.body && !compact ? `<p>${escapeHTML(note.body)}</p>` : note.body ? `<p>${escapeHTML(note.body)}</p>` : ''}
    </article>`;
  }

  function emptyState(iconName, title, description, actionLabel, actionName) {
    return `<div class="empty-state"><span class="empty-icon"><i data-lucide="${iconName}"></i></span><strong>${title}</strong><p>${description}</p><button class="text-button" type="button" data-action="${actionName}"><i data-lucide="plus"></i>${actionLabel}</button></div>`;
  }

  function repeatText(value) {
    return ({ daily: '每天', weekly: '每周', monthly: '每月' })[value] || '';
  }

  function refreshIcons() {
    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  function setHeader(title, eyebrow = '个人工作台') {
    document.getElementById('page-title').textContent = title;
    document.getElementById('page-eyebrow').textContent = eyebrow;
    document.title = `${title} · 日常`;
  }

  function updateNavigation() {
    document.querySelectorAll('[data-view]').forEach((button) => {
      button.classList.toggle('active', button.dataset.view === activeView);
    });
    const todayCount = state.tasks.filter((task) => !task.completed && task.dueDate === today).length;
    document.getElementById('today-count').textContent = todayCount || '';
  }

  function renderToday() {
    setHeader('今天');
    const dueToday = sortTasks(state.tasks.filter((task) => !task.completed && task.dueDate && task.dueDate <= today));
    const completedToday = sortTasks(state.tasks.filter((task) => task.completed && task.dueDate === today));
    const upcoming = sortTasks(state.tasks.filter((task) => !task.completed && task.dueDate > today)).slice(0, 3);
    const dueCount = dueToday.filter((task) => task.dueDate === today).length;
    const overdueCount = dueToday.filter((task) => task.dueDate < today).length;
    const completion = dueCount + completedToday.length;
    const ratio = completion ? Math.round((completedToday.length / completion) * 100) : 0;
    const recentNotes = sortedNotes().slice(0, 3);

    root.innerHTML = `<section class="welcome-row">
      <div><h2 class="welcome-title">把今天理清楚</h2><p class="welcome-subtitle">记下重要的事，一件一件完成。</p></div>
      <div class="date-chip"><i data-lucide="calendar-check-2"></i>${formatToday()}</div>
    </section>
    <section class="overview-strip" aria-label="今日概览">
      <div class="overview-cell"><span class="overview-icon"><i data-lucide="list-todo"></i></span><div><div class="overview-value">${dueCount}</div><div class="overview-label">今日待办</div></div></div>
      <div class="overview-cell"><span class="overview-icon"><i data-lucide="circle-alert"></i></span><div><div class="overview-value">${overdueCount}</div><div class="overview-label">逾期待办</div></div></div>
      <div class="overview-cell"><span class="overview-icon"><i data-lucide="chart-no-axes-column-increasing"></i></span><div><div class="overview-value">${ratio}%</div><div class="overview-label">今日完成</div></div></div>
    </section>
    <div class="today-grid">
      <section class="section-block">
        <div class="section-heading"><h2>待办清单<small>${dueToday.length} 项</small></h2><button class="small-action" data-action="new-task" type="button"><i data-lucide="plus"></i>添加</button></div>
        ${dueToday.length ? `<div class="task-list">${dueToday.map((task) => taskRow(task)).join('')}</div>` : emptyState('check-check', '今天还没有待办', '把要处理的事情记下来，稍后就能在这里找到。', '新建待办', 'new-task')}
        ${completedToday.length ? `<div class="completed-section"><button class="completed-toggle" type="button" data-action="toggle-completed" aria-expanded="${showCompleted}"><i data-lucide="chevron-right"></i>已完成 ${completedToday.length} 项</button>${showCompleted ? `<div class="task-list completed-list">${completedToday.map((task) => taskRow(task, true)).join('')}</div>` : ''}</div>` : ''}
        ${upcoming.length ? `<section class="section-block" style="margin-top:30px"><div class="section-heading"><h2>接下来</h2><button class="small-action" data-view="calendar" type="button">查看日历<i data-lucide="arrow-up-right"></i></button></div><div class="task-list">${upcoming.map((task) => taskRow(task, true)).join('')}</div></section>` : ''}
      </section>
      <section class="section-block notes-column">
        <div class="section-heading"><h2>最近备忘</h2><button class="small-action" data-view="notes" type="button">全部备忘<i data-lucide="arrow-up-right"></i></button></div>
        ${recentNotes.length ? `<div class="note-list">${recentNotes.map((note) => noteCard(note)).join('')}</div>` : emptyState('notebook-pen', '还没有备忘', '随手记下想法、信息或临时需要处理的内容。', '新建备忘', 'new-note')}
      </section>
    </div>`;
    updateNavigation();
    refreshIcons();
  }

  function renderNotes() {
    setHeader('备忘录', '随手记录，稍后查找');
    const filters = ['全部', '置顶', '工作', '生活', '灵感', '其他'];
    let notes = sortedNotes();
    if (noteFilter === '置顶') notes = notes.filter((note) => note.pinned);
    else if (noteFilter !== '全部') notes = notes.filter((note) => (note.tag || '其他') === noteFilter);
    root.innerHTML = `<div class="view-toolbar"><div><h2>所有备忘 <small>${notes.length} 条</small></h2></div><div class="filter-row">${filters.map((filter) => `<button type="button" class="filter-chip ${filter === noteFilter ? 'active' : ''}" data-action="note-filter" data-filter="${filter}">${filter}</button>`).join('')}</div></div>
      <div class="notes-grid">${notes.length ? notes.map((note) => noteCard(note)).join('') : `<div class="note-empty">${emptyState('notebook-pen', noteFilter === '全部' ? '还没有备忘' : '这里暂时没有内容', noteFilter === '全部' ? '记录下来，以后可以按标签或关键词快速找到。' : '换一个标签，或者新增一条备忘。', '新建备忘', 'new-note')}</div>`}</div>`;
    updateNavigation();
    refreshIcons();
  }

  function monthLabel(date) {
    return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(date);
  }

  function renderCalendar() {
    setHeader('日历', '按日期查看安排');
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const mondayIndex = (firstDay.getDay() + 6) % 7;
    const start = new Date(year, month, 1 - mondayIndex);
    const days = Array.from({ length: 42 }, (_, index) => {
      const day = new Date(start);
      day.setDate(start.getDate() + index);
      const key = toDateKey(day);
      const dayTasks = state.tasks.filter((task) => task.dueDate === key && !task.completed);
      const hasNotes = state.notes.some((note) => (note.createdAt || '').slice(0, 10) === key);
      const dayOffPeople = SCHEDULE_PEOPLE.filter((person) => state.daysOff.some((item) => item.date === key && item.person === person));
      const restTags = dayOffPeople.map((person) => `<span class="day-rest-tag" data-person="${person}">${person}</span>`).join('');
      const dots = `${dayTasks.length ? '<span class="day-dot"></span>' : ''}${hasNotes ? '<span class="day-dot note-dot"></span>' : ''}`;
      const restDescription = dayOffPeople.map((person) => `${person}休息`).join('，');
      return `<button type="button" class="day-cell ${day.getMonth() !== month ? 'outside' : ''} ${key === today ? 'today' : ''} ${key === selectedDate ? 'selected' : ''}" data-action="select-date" data-date="${key}" aria-label="${formatDate(key, { year: 'numeric', month: 'long', day: 'numeric' })}${dayTasks.length ? `，${dayTasks.length} 个待办` : ''}${restDescription ? `，${restDescription}` : ''}"><span>${day.getDate()}</span><span class="day-rest-tags">${restTags}</span><span class="day-dots">${dots}</span></button>`;
    }).join('');
    const agendaTasks = sortTasks(state.tasks.filter((task) => task.dueDate === selectedDate));
    const agendaNotes = sortedNotes(state.notes.filter((note) => (note.createdAt || '').slice(0, 10) === selectedDate));
    const selectedDayOffs = SCHEDULE_PEOPLE.filter((person) => state.daysOff.some((item) => item.date === selectedDate && item.person === person));
    const selectedPersonIsOff = selectedDayOffs.includes(schedulePerson);
    const selected = fromDateKey(selectedDate);
    const selectedLabel = selected ? new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(selected) : '';

    root.innerHTML = `<div class="calendar-layout">
      <section class="calendar-panel"><div class="calendar-header"><h2>${monthLabel(calendarMonth)}</h2><div class="calendar-nav"><button class="calendar-arrow" type="button" data-action="prev-month" aria-label="上个月"><i data-lucide="chevron-left"></i></button><button class="calendar-arrow" type="button" data-action="next-month" aria-label="下个月"><i data-lucide="chevron-right"></i></button></div></div>
        <div class="calendar-scheduler"><span class="calendar-scheduler-label">排班人员</span><div class="scheduler-people" role="group" aria-label="选择排班人员">${SCHEDULE_PEOPLE.map((person) => `<button class="scheduler-person ${schedulePerson === person ? 'active' : ''}" type="button" data-action="schedule-person" data-person="${person}" aria-pressed="${schedulePerson === person}">${person}</button>`).join('')}</div><span class="calendar-sync-status" data-schedule-sync-status aria-live="polite">${escapeHTML(scheduleSyncStatus)}</span></div>
        <div class="calendar-grid" role="grid" aria-label="${monthLabel(calendarMonth)}"><div class="weekday">一</div><div class="weekday">二</div><div class="weekday">三</div><div class="weekday">四</div><div class="weekday">五</div><div class="weekday">六</div><div class="weekday">日</div>${days}</div>
      </section>
      <aside class="calendar-side"><h3 class="selected-date-heading">${selectedLabel}</h3>
        <section class="calendar-schedule" aria-label="休息排班"><div class="calendar-section-title"><h4>休息安排</h4><span>只记录休息日</span></div><div class="schedule-person-list">${selectedDayOffs.length ? selectedDayOffs.map((person) => `<span class="schedule-person-tag" data-person="${person}">${person}休息</span>`).join('') : '<span class="schedule-empty">暂无休息安排</span>'}</div><button class="secondary-button schedule-toggle" type="button" data-action="toggle-day-off" data-date="${selectedDate}" data-person="${schedulePerson}"><i data-lucide="coffee"></i>${selectedPersonIsOff ? `取消${schedulePerson}休息` : `安排${schedulePerson}休息`}</button></section>
        <div class="calendar-agenda">${agendaTasks.length ? agendaTasks.map((task) => taskRow(task, true)).join('') : `<div class="agenda-empty">这一天没有待办</div>`}</div>
        <button class="small-action" type="button" data-action="new-task" data-date="${selectedDate}"><i data-lucide="plus"></i>添加到这一天</button>
        ${agendaNotes.length ? `<div class="agenda-note"><h3>当天备忘 · ${agendaNotes.length}</h3><div class="note-list">${agendaNotes.map((note) => noteCard(note, true)).join('')}</div></div>` : ''}
      </aside>
    </div>`;
    updateNavigation();
    refreshIcons();
  }

  function renderSearch() {
    setHeader('搜索结果', '备忘与待办');
    const query = searchQuery.trim().toLocaleLowerCase();
    const notes = sortedNotes(state.notes.filter((note) => `${note.title} ${note.body || ''} ${note.tag || ''}`.toLocaleLowerCase().includes(query)));
    const tasks = sortTasks(state.tasks.filter((task) => `${task.title} ${task.body || ''}`.toLocaleLowerCase().includes(query)));
    root.innerHTML = query ? `<section class="section-block"><div class="section-heading"><h2>待办 <small>${tasks.length} 项</small></h2></div>${tasks.length ? `<div class="task-list">${tasks.map((task) => taskRow(task)).join('')}</div>` : '<p class="agenda-empty">没有匹配的待办</p>'}</section><section class="section-block" style="margin-top:30px"><div class="section-heading"><h2>备忘 <small>${notes.length} 条</small></h2></div>${notes.length ? `<div class="notes-grid">${notes.map((note) => noteCard(note)).join('')}</div>` : '<p class="agenda-empty">没有匹配的备忘</p>'}</section>` : emptyState('search', '输入关键词开始搜索', '可以搜索标题、内容或标签。', '新建记录', 'new-task');
    updateNavigation();
    refreshIcons();
  }

  function renderSettings() {
    setHeader('设置与备份', '应用信息');
    const version = window.AndroidBridge?.getAppVersion?.() || '网页预览版';
    const syncConfigured = Boolean(scheduleSync?.configured);
    root.innerHTML = `<div class="settings-view">
      <section class="settings-section"><h2>排班同步</h2><p>只同步军、震的休息安排。两台设备使用同一个 CloudBase 账号，应用打开时约每 5 秒检查一次更新；返回应用时会立即同步。</p><p class="sync-status-line" data-schedule-sync-status aria-live="polite">${escapeHTML(scheduleSyncStatus)}</p><form class="sync-form" id="schedule-sync-form"><label class="field-grow"><span class="field-label">共享账号</span><input class="text-field" name="email" type="text" autocomplete="username" value="${escapeHTML(scheduleSync?.email() || '')}" required ${syncConfigured ? '' : 'disabled'} /></label><label class="field-grow"><span class="field-label">账号密码</span><input class="text-field" name="password" type="password" autocomplete="current-password" required ${syncConfigured ? '' : 'disabled'} /></label><button class="primary-button" type="submit" ${syncConfigured ? '' : 'disabled'}><i data-lucide="cloud"></i>连接同步</button></form><div class="settings-actions"><button class="secondary-button" type="button" data-action="disconnect-schedule-sync" ${scheduleSync?.email() ? '' : 'disabled'}><i data-lucide="cloud-off"></i>断开同步</button></div></section>
      <section class="settings-section"><h2>数据备份</h2><p>备忘和待办只保存在当前设备。你可以导出 JSON 文件留存，或从备份文件恢复。</p><div class="settings-actions"><button class="secondary-button" type="button" data-action="export"><i data-lucide="download"></i>导出数据</button><button class="secondary-button" type="button" data-action="import"><i data-lucide="upload"></i>导入备份</button></div></section>
      <section class="settings-section"><h2>提醒通知</h2><p>可在待办中单独开启闹钟提醒。到点会响铃，通知会一直保留到待办完成或取消。首次开启时，请允许通知权限。</p><div class="settings-actions"><button class="secondary-button" type="button" data-action="request-notification"><i data-lucide="bell-ring"></i>开启通知权限</button></div></section>
      <section class="settings-section"><h2>应用更新</h2><p>检查内部发布的 Android 版本。安装更新时，系统会显示安装确认。</p><div class="settings-version"><span>当前版本</span><strong>${escapeHTML(version)}</strong></div><div class="settings-actions"><button class="secondary-button" type="button" data-action="check-update"><i data-lucide="refresh-cw"></i>检查更新</button></div></section>
      <section class="settings-section"><h2>本机数据</h2><p>清除当前设备的备忘和待办，并清除共享休息安排。此操作无法撤销。</p><div class="settings-actions"><button class="secondary-button" type="button" data-action="clear-data"><i data-lucide="trash-2"></i>清除所有数据</button></div></section>
    </div>`;
    updateNavigation();
    refreshIcons();
  }

  function render() {
    if (activeView === 'today') renderToday();
    else if (activeView === 'notes') renderNotes();
    else if (activeView === 'calendar') renderCalendar();
    else if (activeView === 'search') renderSearch();
    else renderSettings();
  }

  function goTo(view) {
    activeView = view;
    if (view !== 'search') {
      searchQuery = '';
      searchInput.value = '';
    }
    render();
    root.focus({ preventScroll: true });
  }

  function setEditorKind(kind) {
    form.elements.kind.value = kind;
    document.querySelectorAll('.segment').forEach((button) => button.classList.toggle('active', button.dataset.kind === kind));
    document.getElementById('task-fields').classList.toggle('hidden', kind !== 'task');
    document.getElementById('note-fields').classList.toggle('hidden', kind !== 'note');
    document.getElementById('editor-heading').textContent = form.elements.id.value ? `编辑${kind === 'task' ? '待办' : '备忘'}` : `新建${kind === 'task' ? '待办' : '备忘'}`;
  }

  function openEditor(kind = 'task', entry = null, defaultDate = '') {
    form.reset();
    form.elements.id.value = entry?.id || '';
    form.elements.title.value = entry?.title || '';
    form.elements.body.value = entry?.body || '';
    form.elements.dueDate.value = entry?.dueDate || defaultDate || today;
    form.elements.dueTime.value = entry?.dueTime || '';
    form.elements.reminderEnabled.checked = entry ? taskReminderEnabled(entry) : false;
    form.elements.repeat.value = entry?.repeat || 'none';
    form.elements.tag.value = entry?.tag || '工作';
    form.elements.pinned.checked = Boolean(entry?.pinned);
    syncReminderControl();
    document.getElementById('delete-entry').classList.toggle('hidden', !entry);
    document.getElementById('save-label').textContent = entry ? '保存修改' : '保存';
    setEditorKind(kind);
    dialog.showModal();
    window.setTimeout(() => form.elements.title.focus(), 50);
  }

  function removeReminder(taskId) {
    browserReminderTimers.get(taskId)?.forEach(clearTimeout);
    browserReminderTimers.delete(taskId);
    window.AndroidBridge?.cancelReminder?.(String(taskId));
  }

  function syncReminderControl() {
    const reminderCheckbox = form.elements.reminderEnabled;
    const canEnable = Boolean(form.elements.dueDate.value && form.elements.dueTime.value);
    reminderCheckbox.disabled = !canEnable;
    if (!canEnable) reminderCheckbox.checked = false;
    document.getElementById('reminder-help').textContent = canEnable ? '到点响铃，并保持通知直到完成待办' : '选择日期和时间后可开启';
  }

  function updateReminder(task) {
    removeReminder(task.id);
    if (task.completed || !taskReminderEnabled(task) || !task.dueDate || !task.dueTime) return;
    let trigger = new Date(`${task.dueDate}T${task.dueTime}:00`);
    if (!Number.isFinite(trigger.getTime())) return;
    while (trigger.getTime() <= Date.now() && task.repeat && task.repeat !== 'none') {
      if (task.repeat === 'daily') trigger.setDate(trigger.getDate() + 1);
      else if (task.repeat === 'weekly') trigger.setDate(trigger.getDate() + 7);
      else if (task.repeat === 'monthly') trigger.setMonth(trigger.getMonth() + 1);
      else break;
    }
    const triggerAt = trigger.getTime();
    if (triggerAt <= Date.now()) return;
    if (window.AndroidBridge?.scheduleReminder) {
      window.AndroidBridge.scheduleReminder(String(task.id), task.title, task.body || '有一项待办需要处理', triggerAt, task.repeat || 'none');
      return;
    }
    if (!('Notification' in window)) return;
    const schedule = () => {
      if (Notification.permission !== 'granted') return;
      const timers = [];
      const tick = () => {
        const remaining = triggerAt - Date.now();
        if (remaining <= 0) {
          if (Notification.permission === 'granted') new Notification(task.title, { body: task.body || '有一项待办需要处理', icon: 'assets/app-icon.svg' });
          browserReminderTimers.delete(task.id);
          return;
        }
        timers.push(window.setTimeout(tick, Math.min(remaining, 2147480000)));
      };
      tick();
      browserReminderTimers.set(task.id, timers);
    };
    if (Notification.permission === 'default') Notification.requestPermission().then(schedule);
    else schedule();
  }

  function reminderDate(task, direction) {
    const date = fromDateKey(task.dueDate < today ? today : task.dueDate);
    if (!date) return null;
    if (task.repeat === 'daily') date.setDate(date.getDate() + direction);
    else if (task.repeat === 'weekly') date.setDate(date.getDate() + 7 * direction);
    else if (task.repeat === 'monthly') date.setMonth(date.getMonth() + direction);
    else return null;
    return toDateKey(date);
  }

  function toggleTask(taskId, checked) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return;
    task.completed = checked;
    task.updatedAt = new Date().toISOString();
    if (checked) {
      task.completedAt = task.updatedAt;
      removeReminder(task.id);
      const nextDate = reminderDate(task, 1);
      if (nextDate) {
        const nextTask = { ...task, id: newId(), dueDate: nextDate, completed: false, completedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        state.tasks.push(nextTask);
        updateReminder(nextTask);
        showToast(`已完成，下次安排在${formatDate(nextDate)}`);
      }
    } else {
      task.completedAt = null;
      updateReminder(task);
    }
    persist();
    render();
  }

  function saveEntry(event) {
    event.preventDefault();
    const kind = form.elements.kind.value;
    const id = form.elements.id.value;
    const now = new Date().toISOString();
    const title = form.elements.title.value.trim();
    const body = form.elements.body.value.trim();
    if (!title) return;

    if (kind === 'task') {
      const reminderEnabled = form.elements.reminderEnabled.checked;
      if (reminderEnabled && (!form.elements.dueDate.value || !form.elements.dueTime.value)) {
        showToast('请先设置待办日期和时间');
        return;
      }
      const existing = state.tasks.find((task) => task.id === id);
      const task = {
        ...(existing || {}), id: id || newId(), title, body,
        dueDate: form.elements.dueDate.value || null,
        dueTime: form.elements.dueDate.value ? form.elements.dueTime.value || '' : '',
        repeat: form.elements.dueDate.value ? form.elements.repeat.value : 'none',
        reminderEnabled,
        completed: existing?.completed || false,
        completedAt: existing?.completed ? existing?.completedAt || null : null,
        createdAt: existing?.createdAt || now, updatedAt: now
      };
      if (existing) Object.assign(existing, task);
      else state.tasks.push(task);
      updateReminder(task);
      if (reminderEnabled) window.AndroidBridge?.requestNotificationPermission?.();
    } else {
      const existing = state.notes.find((note) => note.id === id);
      const note = {
        ...(existing || {}), id: id || newId(), title, body,
        tag: form.elements.tag.value,
        pinned: form.elements.pinned.checked,
        createdAt: existing?.createdAt || now, updatedAt: now
      };
      if (existing) Object.assign(existing, note);
      else state.notes.push(note);
    }
    persist();
    dialog.close();
    render();
    showToast(id ? '已保存修改' : '已保存');
  }

  function deleteCurrentEntry() {
    const id = form.elements.id.value;
    const kind = form.elements.kind.value;
    if (!id || !window.confirm('确定删除这条内容吗？')) return;
    if (kind === 'task') {
      state.tasks = state.tasks.filter((task) => task.id !== id);
      removeReminder(id);
    } else state.notes = state.notes.filter((note) => note.id !== id);
    persist();
    dialog.close();
    render();
    showToast('已删除');
  }

  function showToast(message) {
    const region = document.getElementById('toast-region');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<i data-lucide="circle-check"></i><span>${escapeHTML(message)}</span>`;
    region.appendChild(toast);
    refreshIcons();
    window.setTimeout(() => toast.remove(), 2800);
  }

  function exportData() {
    const content = JSON.stringify({ format: 'daily-assistant-backup', version: 1, exportedAt: new Date().toISOString(), ...state }, null, 2);
    if (window.AndroidBridge?.saveBackup) {
      window.AndroidBridge.saveBackup(content);
      return;
    }
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `日常备忘备份-${today}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    showToast('备份文件已导出');
  }

  async function importDataText(content) {
    try {
      const backup = JSON.parse(content);
      if (!Array.isArray(backup.tasks) || !Array.isArray(backup.notes)) throw new Error('格式不正确');
      const daysOff = normalizeDaysOff(backup.daysOff);
      if (!window.confirm(`备份包含 ${backup.tasks.length} 项待办、${backup.notes.length} 条备忘和 ${daysOff.length} 条休息安排。导入会替换本机现有数据。`)) return;
      state.tasks.forEach((task) => removeReminder(task.id));
      state.tasks = backup.tasks.filter((item) => item && item.id && item.title).map((item) => ({ ...item, id: String(item.id), title: String(item.title).slice(0, 100) }));
      state.notes = backup.notes.filter((item) => item && item.id && item.title).map((item) => ({ ...item, id: String(item.id), title: String(item.title).slice(0, 100) }));
      const changedAt = Date.now();
      const replacementRecords = {};
      Object.values(state.scheduleRecords).forEach((record) => {
        replacementRecords[scheduleKey(record.date, record.person)] = { ...record, off: false, updatedAt: changedAt, deviceId: scheduleSync?.deviceId() || '' };
      });
      daysOff.forEach((record) => {
        replacementRecords[scheduleKey(record.date, record.person)] = { ...record, off: true, updatedAt: changedAt, deviceId: scheduleSync?.deviceId() || '' };
      });
      state.scheduleRecords = replacementRecords;
      state.daysOff = daysOff;
      persist();
      scheduleSync?.replaceRecords(daysOff);
      state.tasks.forEach(updateReminder);
      render();
      showToast('备份已恢复');
    } catch (error) {
      showToast(`无法导入：${error.message || '文件格式错误'}`);
    }
  }

  async function importData(file) {
    if (!file) return;
    try {
      await importDataText(await file.text());
    } finally {
      document.getElementById('import-file').value = '';
    }
  }

  function onAction(event) {
    const actionTarget = event.target.closest('[data-action]');
    if (actionTarget) {
      const { action, id } = actionTarget.dataset;
      if (action === 'new-task') openEditor('task', null, actionTarget.dataset.date || (activeView === 'calendar' ? selectedDate : ''));
      else if (action === 'new-note') openEditor('note');
      else if (action === 'schedule-person') {
        if (SCHEDULE_PEOPLE.includes(actionTarget.dataset.person)) {
          schedulePerson = actionTarget.dataset.person;
          renderCalendar();
        }
      } else if (action === 'toggle-day-off') {
        const date = actionTarget.dataset.date;
        const person = actionTarget.dataset.person;
        if (isValidDateKey(date) && SCHEDULE_PEOPLE.includes(person)) {
          const existingIndex = state.daysOff.findIndex((item) => item.date === date && item.person === person);
          if (existingIndex >= 0) {
            setScheduleRecord(date, person, false);
            showToast(`已取消${person}的休息安排`);
          } else {
            setScheduleRecord(date, person, true);
            showToast(`已安排${person}休息`);
          }
          renderCalendar();
        }
      } else if (action === 'disconnect-schedule-sync') {
        scheduleSync?.disconnect();
        showToast('已断开排班同步');
      } else if (action === 'edit-entry') {
        const collection = actionTarget.dataset.kind === 'task' ? state.tasks : state.notes;
        const entry = collection.find((item) => item.id === id);
        if (entry) openEditor(actionTarget.dataset.kind, entry);
      } else if (action === 'toggle-task') toggleTask(id, actionTarget.checked);
      else if (action === 'toggle-completed') {
        showCompleted = !showCompleted;
        render();
      } else if (action === 'note-filter') {
        noteFilter = actionTarget.dataset.filter;
        renderNotes();
      } else if (action === 'select-date') {
        selectedDate = actionTarget.dataset.date;
        const date = fromDateKey(selectedDate);
        calendarMonth = new Date(date.getFullYear(), date.getMonth(), 1);
        renderCalendar();
      } else if (action === 'prev-month' || action === 'next-month') {
        calendarMonth.setMonth(calendarMonth.getMonth() + (action === 'prev-month' ? -1 : 1));
        renderCalendar();
      } else if (action === 'export') exportData();
      else if (action === 'import') {
        if (window.AndroidBridge?.requestImportBackup) window.AndroidBridge.requestImportBackup();
        else document.getElementById('import-file').click();
      }
      else if (action === 'clear-data') {
        if (window.confirm('清除本机全部备忘、待办，并清除两台设备共享的休息安排？此操作无法撤销。')) {
          state.tasks.forEach((task) => removeReminder(task.id));
          Object.values(state.scheduleRecords).filter((record) => record.off).forEach((record) => setScheduleRecord(record.date, record.person, false));
          state.tasks = [];
          state.notes = [];
          state.daysOff = [];
          persist();
          render();
          showToast('本机数据已清除');
        }
      } else if (action === 'request-notification') {
        if (window.AndroidBridge?.requestNotificationPermission) window.AndroidBridge.requestNotificationPermission();
        else if ('Notification' in window) Notification.requestPermission().then((result) => showToast(result === 'granted' ? '通知权限已开启' : '通知权限未开启'));
        else showToast('当前环境不支持系统通知');
      } else if (action === 'check-update') {
        if (window.AndroidBridge?.checkForUpdates) window.AndroidBridge.checkForUpdates();
        else showToast('网页预览版没有应用更新');
      }
    }

    const viewTarget = event.target.closest('[data-view]');
    if (viewTarget) goTo(viewTarget.dataset.view);
  }

  document.addEventListener('click', onAction);
  document.addEventListener('submit', async (event) => {
    if (event.target.id !== 'schedule-sync-form') return;
    event.preventDefault();
    const syncForm = event.target;
    const submitButton = syncForm.querySelector('[type="submit"]');
    submitButton.disabled = true;
    try {
      await scheduleSync.connect(syncForm.elements.email.value, syncForm.elements.password.value);
      syncForm.elements.password.value = '';
      showToast('排班同步已连接');
    } catch (error) {
      showToast(error.message || scheduleSync.status());
    } finally {
      submitButton.disabled = !scheduleSync?.configured;
    }
  });
  document.addEventListener('keydown', (event) => {
    const actionable = event.target.closest('[data-action="edit-entry"]');
    if (actionable && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      actionable.click();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      searchInput.focus();
    }
  });

  document.querySelectorAll('.segment').forEach((button) => button.addEventListener('click', () => setEditorKind(button.dataset.kind)));
  document.getElementById('rail-create').addEventListener('click', () => openEditor());
  document.getElementById('top-create').addEventListener('click', () => openEditor());
  document.getElementById('mobile-create').addEventListener('click', () => openEditor());
  document.getElementById('close-editor').addEventListener('click', () => dialog.close());
  document.getElementById('cancel-editor').addEventListener('click', () => dialog.close());
  document.getElementById('delete-entry').addEventListener('click', deleteCurrentEntry);
  form.addEventListener('submit', saveEntry);
  form.elements.dueDate.addEventListener('input', syncReminderControl);
  form.elements.dueDate.addEventListener('change', syncReminderControl);
  form.elements.dueTime.addEventListener('input', syncReminderControl);
  form.elements.dueTime.addEventListener('change', syncReminderControl);
  document.getElementById('import-file').addEventListener('change', (event) => importData(event.target.files?.[0]));
  searchBox.addEventListener('click', (event) => {
    if (window.matchMedia('(max-width: 760px)').matches && !searchBox.classList.contains('search-open')) {
      event.preventDefault();
      searchBox.classList.add('search-open');
      searchInput.focus();
    }
  });
  searchInput.addEventListener('blur', () => {
    if (!searchInput.value && window.matchMedia('(max-width: 760px)').matches) searchBox.classList.remove('search-open');
  });
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    activeView = searchQuery.trim() ? 'search' : 'today';
    render();
  });
  window.onUpdateStatus = (message) => showToast(message);
  window.importBackupJson = (content) => importDataText(content);

  scheduleSync = window.createScheduleSync?.({
    config: window.CLOUDBASE_SYNC_CONFIG,
    onRecords: mergeScheduleRecords,
    onStatus: (status) => {
      scheduleSyncStatus = status;
      document.querySelectorAll('[data-schedule-sync-status]').forEach((node) => { node.textContent = status; });
      document.querySelectorAll('[data-action="disconnect-schedule-sync"]').forEach((button) => { button.disabled = !scheduleSync?.email(); });
    }
  }) || null;

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('./service-worker.js').catch(() => {}));
  }
  state.tasks.forEach(updateReminder);
  cleanupExpiredHistory();
  window.setInterval(cleanupExpiredHistory, 6 * 60 * 60 * 1000);
  scheduleSync?.resume();
  render();
  if (window.AndroidBridge?.isUpdateConfigured?.()) window.setTimeout(() => window.AndroidBridge.checkForUpdates(), 1400);
})();
