import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/* 计花括号深度时要跳过字符串与注释，否则文案里的括号会把层数算错 */
function braceDepthAt(src, index) {
  let depth = 0;
  for (let i = 0; i < index; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < index && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < index && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < index && src[i] !== quote) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
  }
  return depth;
}

/* 线上事故（11-20）：编辑已有监考记录点保存必报
   「操作没成功：oldState is not defined」。原因是 oldState 用 const 声明在
   if (row) { ... } 块里，而拼 payload 时又在这个块外读它——块级作用域外访问
   会直接抛 ReferenceError，新增记录（row 为空）反而正常，所以只有改单条才炸。 */
test('监考保存处理器里 oldState 声明在处理器顶层，供后续收付判断复用', async () => {
  const src = await readFile(new URL('../js/invigilation.js', import.meta.url), 'utf8');
  const anchor = src.indexOf("q('iv-edit-save').onclick");
  assert.ok(anchor > 0, '没找到监考保存按钮的处理器，测试锚点需要更新');
  const end = src.indexOf('async function openRules', anchor);
  assert.ok(end > anchor, '没找到 openRules 作为处理器结束锚点');
  const handler = src.slice(anchor, end);

  const decl = handler.indexOf('const oldState');
  assert.ok(decl > 0, '保存处理器里应显式声明 oldState');
  // 与处理器第一条语句同层，才算声明在处理器顶层（若被塞进 if (row) 块，层数会高一层）
  const baseline = handler.indexOf('const date = q(');
  assert.ok(baseline > 0, '没找到处理器首条语句，测试锚点需要更新');
  assert.equal(
    braceDepthAt(handler, decl),
    braceDepthAt(handler, baseline),
    'oldState 必须声明在处理器顶层；写进 if (row) 块里，块外读取会抛 ReferenceError',
  );

  // 声明必须在所有使用点之前
  const firstUse = handler.indexOf('oldState.legacy');
  const guardedUse = handler.indexOf('oldState.structured');
  assert.ok(firstUse > decl, 'oldState 必须先声明再用于旧版结清校验');
  assert.ok(guardedUse > firstUse, 'oldState 应先用于旧版校验，再用于结构化收付判断');
  assert.match(handler, /if \(row && oldState\.structured\)/);
});
