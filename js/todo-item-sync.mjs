const active = row => row && !row.deleted_at;
const same = (first, second) => String(first) === String(second);
const statusOf = value => ['todo', 'doing', 'done'].includes(value) ? value : 'todo';

export function reconcileTaskLinks(db, { sourceTable = '', sourceId = null, fields = [], now = new Date().toISOString() } = {}) {
  db.todos ||= []; db.items ||= []; db.seqs ||= {};
  let changed = false;
  const usedItems = new Set();
  const assign = (row, key, value) => {
    if (row[key] === value) return false;
    row[key] = value; changed = true; return true;
  };
  const nextId = table => {
    const next = Math.max(Number(db.seqs['id:' + table] || 0), ...db[table].map(row => Number(row.id) || 0)) + 1;
    db.seqs['id:' + table] = next;
    return next;
  };
  const nextSeq = key => { db.seqs[key] = Number(db.seqs[key] || 0) + 1; return db.seqs[key]; };
  const link = (note, item) => {
    usedItems.add(String(item.id));
    const noteTime = Date.parse(note.updated_at || note.created_at) || 0;
    const itemTime = Date.parse(item.updated_at || item.created_at) || 0;
    const source = sourceTable === 'todos' && same(sourceId, note.id) ? note : sourceTable === 'items' && same(sourceId, item.id) ? item : null;
    const winner = source && fields.includes('status') ? source : noteTime > itemTime ? note : item;
    const status = statusOf(winner.status);
    for (const row of [note, item]) {
      if (row.status !== status) { assign(row, 'status', status); assign(row, 'updated_at', winner.updated_at || winner.created_at || now); }
    }
    assign(note, 'ref_item_id', item.id);
    assign(item, 'source', '便签'); assign(item, 'ref_id', note.id);
    if (source) {
      const target = source === note ? item : note;
      let copied = false;
      for (const [noteField, itemField] of [['title', 'title'], ['content', 'detail'], ['due_at', 'start_at']]) {
        const sourceKey = source === note ? noteField : itemField;
        const targetKey = source === note ? itemField : noteField;
        if (fields.includes(sourceKey) && assign(target, targetKey, source[sourceKey] ?? (targetKey === 'content' || targetKey === 'detail' ? '' : null))) copied = true;
      }
      if (copied) assign(target, 'updated_at', source.updated_at || now);
    }
  };
  for (const note of [...db.todos].filter(active)) {
    const known = db.items.find(item => same(item.id, note.ref_item_id));
    if (known && !active(known)) continue;
    let item = known && (!known.source || known.source === '便签') && (!known.ref_id || same(known.ref_id, note.id)) && !usedItems.has(String(known.id)) ? known : null;
    item ||= db.items.find(row => active(row) && row.source === '便签' && same(row.ref_id, note.id) && !usedItems.has(String(row.id)));
    if (!item) {
      item = { id: nextId('items'), seq: nextSeq('item'), kind: '事项', title: note.title, detail: note.content || '', status: statusOf(note.status), start_at: note.due_at || null, end_at: null, priority: 'normal', created_at: note.created_at || now, updated_at: note.updated_at || note.created_at || now, deleted_at: null };
      db.items.push(item); changed = true;
    }
    link(note, item);
  }
  for (const item of db.items.filter(active)) {
    if (usedItems.has(String(item.id)) || (item.source && item.source !== '便签')) continue;
    if (db.todos.some(note => !active(note) && (same(note.ref_item_id, item.id) || (item.source === '便签' && same(item.ref_id, note.id))))) continue;
    const note = { id: nextId('todos'), seq: nextSeq('todo'), title: item.title, content: item.detail || '', status: statusOf(item.status), due_at: item.start_at || null, pin: 0, color: '', created_at: item.created_at || now, updated_at: item.updated_at || item.created_at || now, deleted_at: null };
    db.todos.push(note); changed = true;
    link(note, item);
  }
  return changed;
}

