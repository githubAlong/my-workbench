import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  PREP_UNCLASSIFIED, PREP_TYPE_OPTIONS, normalizePrepType, prepTypeLabel,
  filterPrepRecords, validatePrepRecord, encodeLessonPlanContent,
  decodeLessonPlanContent, LESSON_PLAN_CONTENT_PREFIX,
} from '../js/prep-domain.mjs';
import { TABLES } from '../js/localdb.js';

const sample = {
  grade: '高一', target: '目标', keyPoint: '重点', hardPoint: '难点', prepare: '准备',
  process: '过程', blackboard: '板书', homeMust: '必做', homeExtra: '选做', reflect: '反思',
};

test('备课类型与待分类兼容（旧数据仍可读）', () => {
  assert.deepEqual(PREP_TYPE_OPTIONS.map((x) => x.value), ['information', 'specialty']);
  assert.equal(normalizePrepType({}), PREP_UNCLASSIFIED);
  assert.equal(prepTypeLabel({}), '待分类');
  assert.deepEqual(filterPrepRecords([{ id: 1 }], { type: PREP_UNCLASSIFIED }).map((x) => x.id), [1]);
});

test('领域层保留类型校验，供历史数据兼容使用', () => {
  assert.equal(validatePrepRecord({ topic: '课题' }, { isNew: true }), '请选择备课类型');
  assert.equal(validatePrepRecord({ topic: '课题', prep_type: 'information' }, { isNew: true }), '');
  assert.equal(validatePrepRecord({ topic: '课题' }, { isNew: false }), '');
});

test('教案内容写入原 content 字段，旧纯文本可读取，备注走 remark 列', () => {
  const content = encodeLessonPlanContent(sample);
  assert.ok(content.startsWith(LESSON_PLAN_CONTENT_PREFIX));
  assert.deepEqual(decodeLessonPlanContent({ class_name: '高一', content }), sample);
  assert.equal(decodeLessonPlanContent({ content: '旧内容' }).process, '旧内容');
  assert.ok(TABLES.preps.includes('prep_type'));
  assert.ok(TABLES.preps.includes('remark'));
  for (const key of ['grade', 'target', 'keyPoint', 'hardPoint', 'prepare', 'process', 'blackboard', 'homeMust', 'homeExtra', 'reflect', 'attachments']) {
    assert.equal(TABLES.preps.includes(key), false);
  }
});

test('备课记录接线：批量导入导出、附件与离线资源', async () => {
  const files = await Promise.all([
    '../js/work.js', '../js/prep.js', '../js/ui.js',
    '../js/localapi.js', '../js/ocr.js', '../sw.js',
  ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
  const [work, prep, ui, localapi, ocr, sw] = files;
  assert.match(work, /renderPreps\(body\)/);
  assert.match(prep, /lp-filter-subject/);
  assert.match(prep, /buildPrepCsv/);
  assert.match(prep, /parsePrepCsv/);
  assert.match(prep, /批量导入/);
  assert.match(prep, /批量导出/);
  assert.match(prep, /api\.req\('POST', '\/upload', fd\)/);
  assert.doesNotMatch(prep, /extractDocx|extractPdf|recognizeLessonPlanImage|lp-prep-type/);
  assert.match(ui, /label: '备课记录'/);
  assert.match(localapi, /\['attendance', 'prep'\]/);
  assert.match(ocr, /recognizeLessonPlanImage/);
  assert.equal([...sw.matchAll(/const CACHE\s*=\s*['"][^'"]+['"]/g)].length, 1);
  for (const asset of ['./js/prep.js', './js/prep-domain.mjs', './js/prep-csv.mjs']) {
    assert.ok(sw.includes(asset), 'SW 清单缺少 ' + asset);
  }
});

test('备课类型支持手动输入与原有选项标签映射', () => {
  assert.equal(normalizePrepType('信息课备课'), 'information');
  assert.equal(normalizePrepType('自定义实验课'), '自定义实验课');
  assert.equal(prepTypeLabel('自定义实验课'), '自定义实验课');
  assert.equal(validatePrepRecord({ topic: '课题', prep_type: '自定义实验课' }, { isNew: true }), '');
  assert.equal(filterPrepRecords([{ prep_type: '自定义实验课' }, { prep_type: 'information' }], { type: '自定义实验课' }).length, 1);
});
