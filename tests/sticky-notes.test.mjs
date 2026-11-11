import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTE_STATES, noteStatus, searchNotes, quickNote } from '../js/sticky-notes-domain.mjs';

test('notes expose exactly the three approved states and keep linked home state', () => {
  assert.deepEqual(NOTE_STATES.map(state => state.label), ['待完成', '进行中', '已完成']);
  assert.equal(noteStatus({ status: 'todo', item_status: 'done' }), 'done');
  assert.equal(noteStatus({ status: 'legacy' }), 'todo');
});
test('global search matches title and body across all three statuses', () => {
  const notes = [{ id: 1, title: '周末整理衣柜', status: 'todo' }, { id: 2, title: '旅行照片', content: '周末备份', status: 'doing' }, { id: 3, title: '周末取快递', status: 'done' }, { id: 4, title: '买牛奶', status: 'todo' }];
  assert.deepEqual(searchNotes(notes, ' 周末 ').map(note => note.id), [3, 2, 1]);
  assert.equal(searchNotes(notes, '').length, 4);
  assert.equal(searchNotes(notes, 'no match').length, 0);
});
test('search is case-insensitive and treats markup and punctuation as literal text', () => {
  const notes = [{ id: 1, title: 'Buy Milk', content: '<script>.*' }];
  assert.equal(searchNotes(notes, 'MILK').length, 1);
  assert.equal(searchNotes(notes, '<script>.*').length, 1);
});
test('quick recording uses first line as title and retains multiline details', () => {
  assert.deepEqual(quickNote(' 买牛奶\r\n两盒牛奶\r\n一盒鸡蛋 '), { title: '买牛奶', content: '两盒牛奶\n一盒鸡蛋', status: 'todo' });
  assert.equal(quickNote('  ').title, '');
});

