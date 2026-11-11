// Task reminders are projections of their source records; reading is separate from completion.
export function reconcileTaskMessages(db, { today, now = new Date().toISOString() }) {
  db.messages ||= [];
  let changed = false;
  const set = (row, key, value) => { if (row[key] !== value) { row[key] = value; changed = true; } };
  const same = (a, b) => a != null && b != null && String(a) === String(b);
  const items = db.items || [], notes = db.todos || [];
  const groups = new Map();
  const sourceOf = message => {
    if (message.ref_type === 'items') return items.find(row => same(row.id, message.ref_id));
    if (message.ref_type === 'todos') {
      const note = notes.find(row => same(row.id, message.ref_id));
      if (!note || note.deleted_at) return note;
      return items.find(row => same(row.id, note.ref_item_id) || (row.source === '便签' && same(row.ref_id, note.id))) || note;
    }
    return null;
  };
  const keyOf = row => (items.includes(row) ? 'items:' : 'todos:') + row.id;
  // Keep tombstones so clearing or dismissing a reminder cannot recreate it on the next read.
  for (const message of db.messages) {
    if (message.type !== 'task' || !['items', 'todos'].includes(message.ref_type)) continue;
    const source = sourceOf(message);
    if (!source || source.deleted_at) { set(message, 'deleted_at', message.deleted_at || now); continue; }
    const key = keyOf(source);
    const group = groups.get(key) || { source, messages: [] };
    group.messages.push(message); groups.set(key, group);
  }
  for (const source of items.filter(row => !row.deleted_at)) {
    const date = source.start_at ? String(source.start_at).slice(0, 10)
      : new Date((Date.parse(source.created_at) || 0) + 8 * 3600000).toISOString().slice(0, 10);
    if (source.status === 'done' || date !== today || groups.has(keyOf(source))) continue;
    const message = { id: Math.max(0, ...db.messages.map(row => Number(row.id) || 0)) + 1, type: 'task', read: 0, created_at: now, ref_type: 'items', ref_id: source.id };
    db.messages.push(message); changed = true;
    groups.set(keyOf(source), { source, messages: [message] });
  }
  for (const { source, messages } of groups.values()) {
    const visible = messages.filter(row => !row.deleted_at);
    if (!visible.length) continue;
    const message = visible.sort((a, b) => Number(a.id) - Number(b.id))[0];
    const status = ['doing', 'done'].includes(source.status) ? source.status : 'todo';
    // Historic duplicate reminders refer to one task, including reverse note links.
    if (visible.some(row => !row.read) && status !== 'done') set(message, 'read', 0);
    for (const duplicate of visible.slice(1)) set(duplicate, 'deleted_at', now);
    set(message, 'title', source.title || '未命名事项');
    set(message, 'body', { todo: '待完成', doing: '进行中', done: '已完成' }[status]);
    set(message, 'task_status', status);
    set(message, 'ref_type', items.includes(source) ? 'items' : 'todos');
    set(message, 'ref_id', source.id);
    set(message, 'link', source.source === '便签' || notes.includes(source) ? '#/daily/notes' : '#/home');
    if (status === 'done' && !message.read) { set(message, 'read', 1); set(message, 'task_auto_read', true); }
    if (status !== 'done' && message.task_auto_read) { set(message, 'read', 0); set(message, 'task_auto_read', false); }
  }
  return changed;
}
