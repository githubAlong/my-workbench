export const NOTE_STATES = [
  { value: 'todo', label: '待完成' },
  { value: 'doing', label: '进行中' },
  { value: 'done', label: '已完成' },
];

export function noteStatus(note) {
  const value = note.item_status || note.status;
  return NOTE_STATES.some(state => state.value === value) ? value : 'todo';
}

export function searchNotes(notes, query = '') {
  const keyword = String(query).trim().toLocaleLowerCase();
  return notes.filter(note => !keyword || [note.title, note.content].some(value => String(value || '').toLocaleLowerCase().includes(keyword)))
    .sort((first, second) => Number(second.pin || 0) - Number(first.pin || 0)
      || String(second.created_at || '').localeCompare(String(first.created_at || ''))
      || Number(second.id) - Number(first.id));
}

export function quickNote(text) {
  const [title, ...lines] = String(text || '').trim().split(/\r?\n/);
  return { title: title || '', content: lines.join('\n').trim(), status: 'todo' };
}

