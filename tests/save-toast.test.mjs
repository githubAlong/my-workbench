import test from 'node:test';
import assert from 'node:assert/strict';
import { isSilentSaveToast } from '../js/core.js';

test('纯保存确认文案统一静默', () => {
  const messages = [
    '已保存', '已添加', '本表已保存', '上课表修改已保存', '坐班表修改已保存',
    '教研表修改已保存', '草稿已保存', '布局已保存', '工作台品牌设置已保存',
    '个人信息已保存', '监考记录已保存', '计价规则已保存', '已保存作业情况',
    '学习记录已保存', '作息时间已保存', '课程已保存', '名单已保存', '冲突选择已保存',
    '已保存（3 次修改）', '已保存 5 个节次时间', '已添加「高一」',
  ];
  for (const msg of messages) assert.equal(isSilentSaveToast(msg, 'ok'), true, msg);
});

test('含额外信息、警告、错误的提示照常显示', () => {
  const messages = [
    '已保存，还没确认生成',
    '已保存「高一」，3 位老师、2 张表已同步更新',
    '记录已保存，但附件处理未完成：xxx',
    '保存失败',
    '布局没保存成功，下次打开会回到原来的排法',
    '本机存储空间不足，这次改动没有真正保存。',
    '草稿已保存到本机，联网后同步',
  ];
  for (const msg of messages) assert.equal(isSilentSaveToast(msg, 'ok'), false, msg);
  assert.equal(isSilentSaveToast('保存失败', 'err'), false);
  assert.equal(isSilentSaveToast('已保存', 'err'), false, '错误类提示即使文案相同也不能静默');
  assert.equal(isSilentSaveToast('已保存', 'warn'), false);
});
