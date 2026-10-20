(() => {
  function oneMonthAgo(now) {
    const cutoff = new Date(now);
    const day = cutoff.getDate();
    cutoff.setDate(1);
    cutoff.setMonth(cutoff.getMonth() - 1);
    const lastDay = new Date(cutoff.getFullYear(), cutoff.getMonth() + 1, 0).getDate();
    cutoff.setDate(Math.min(day, lastDay));
    return cutoff.getTime();
  }

  function timestamp(value) {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function taskHistoryTimestamp(task, now) {
    if (task.completed) return timestamp(task.completedAt || task.updatedAt || task.createdAt);
    if (!task.dueDate) return 0;
    const dueAt = Date.parse(`${task.dueDate}T${task.dueTime || '23:59'}:00`);
    return Number.isFinite(dueAt) && dueAt < now ? dueAt : 0;
  }

  function cleanup(tasks, notes, now = new Date()) {
    const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
    const cutoff = oneMonthAgo(nowTime);
    const expiredTaskIds = [];
    const retainedTasks = tasks.filter((task) => {
      const time = taskHistoryTimestamp(task || {}, nowTime);
      const expired = Boolean(task?.id && time > 0 && time < cutoff);
      if (expired) expiredTaskIds.push(String(task.id));
      return !expired;
    });
    const retainedNotes = notes.filter((note) => {
      const time = timestamp(note?.updatedAt || note?.createdAt);
      return !time || time >= cutoff;
    });
    return {
      tasks: retainedTasks,
      notes: retainedNotes,
      expiredTaskIds,
      removedTasks: tasks.length - retainedTasks.length,
      removedNotes: notes.length - retainedNotes.length
    };
  }

  const api = { cleanup };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.DailyHistoryRetention = api;
})();
