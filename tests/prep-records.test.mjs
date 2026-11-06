import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TABLES } from '../js/localdb.js';
import {
  PREP_UNCLASSIFIED,
  filterPrepRecords,
  isPrepType,
  normalizePrepType,
  prepTypeLabel,
  validatePrepRecord,
} from '../js/prep-domain.mjs';

const legacyRecord = {
  id: 17,
  date: '2026-11-05',
  class_name: '三年级1班',
  subject: '信息技术',
  topic: '旧版备课记录',
  progress: '已完成第一部分',
  next_step: '继续准备第二部分',
  status: 'doing',
  remark: '保留原备注',
};

test('两种正式备课类型使用同一套选项与显示名称', () => {
  assert.equal(isPrepType('information'), true);
  assert.equal(isPrepType('specialty'), true);
  assert.equal(isPrepType('unclassified'), false);
  assert.equal(prepTypeLabel('information'), '信息课备课');
  assert.equal(prepTypeLabel('specialty'), '特色课备课');
});

test('没有类型字段的历史记录按待分类显示且原记录不被改写', () => {
  assert.equal(normalizePrepType(legacyRecord), PREP_UNCLASSIFIED);
  assert.equal(prepTypeLabel(legacyRecord), '待分类');
  const result = filterPrepRecords([legacyRecord], { type: PREP_UNCLASSIFIED });
  assert.deepEqual(result, [legacyRecord]);
  assert.equal(Object.hasOwn(legacyRecord, 'prep_type'), false);
  assert.equal(legacyRecord.topic, '旧版备课记录');
  assert.equal(legacyRecord.remark, '保留原备注');
});

test('类型、班级、状态与关键词可以组合筛选，关键词覆盖备课内容', () => {
  const rows = [
    { ...legacyRecord, id: 1, prep_type: 'information', content: '课堂导入与教学目标', status: 'doing' },
    { ...legacyRecord, id: 2, prep_type: 'specialty', content: '美术创作活动', status: 'done' },
    { ...legacyRecord, id: 3, content: '旧版课堂活动' },
  ];
  const result = filterPrepRecords(rows, {
    type: 'information',
    className: '三年级1班',
    status: 'doing',
    keyword: '教学目标',
  });
  assert.deepEqual(result.map((row) => row.id), [1]);
  assert.deepEqual(filterPrepRecords(rows, { type: 'specialty' }).map((row) => row.id), [2]);
  assert.deepEqual(filterPrepRecords(rows, { type: PREP_UNCLASSIFIED }).map((row) => row.id), [3]);
});

test('新建记录必须选择信息课或特色课，编辑旧记录可暂时保留待分类', () => {
  assert.equal(validatePrepRecord({ topic: '第一课' }, { isNew: true }), '请选择备课类型');
  assert.equal(validatePrepRecord({ prep_type: 'unclassified', topic: '第一课' }, { isNew: true }), '请选择备课类型');
  assert.equal(validatePrepRecord({ prep_type: 'information', topic: '第一课' }, { isNew: true }), '');
  assert.equal(validatePrepRecord({ prep_type: 'specialty', topic: '第一课' }, { isNew: true }), '');
  assert.equal(validatePrepRecord({ prep_type: 'unclassified', topic: '第一课' }, { isNew: false }), '');
  assert.equal(validatePrepRecord({ prep_type: 'information', topic: ' ' }, { isNew: false }), '请填「备的是哪一课」');
});

test('本地记录表允许保存类型和详细备课内容字段', () => {
  assert.ok(TABLES.preps.includes('prep_type'));
  assert.ok(TABLES.preps.includes('content'));
  for (const field of ['date', 'class_name', 'subject', 'topic', 'progress', 'next_step', 'minutes', 'status', 'lesson_id', 'remark']) {
    assert.ok(TABLES.preps.includes(field), `原有字段不能丢失：${field}`);
  }
});

test('备课页面展示电子记录表、类型筛选、备课内容和旧记录分类提示', async () => {
  const [work, nav, api] = await Promise.all([
    readFile(new URL('../js/work.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/ui.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/localapi.js', import.meta.url), 'utf8'),
  ]);
  assert.match(work, /电子备课记录表/);
  assert.match(work, /data-ft=/);
  assert.match(work, /id="p-type"/);
  assert.match(work, /id="p-content"/);
  assert.match(work, /待分类（旧记录）/);
  assert.match(nav, /label: '备课'/);
  assert.match(api, /请选择备课类型/);
});
