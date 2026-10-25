#!/usr/bin/env node
/* 用法：
 *   node tools/set-password.mjs 13800001111 'NewPassword123!'
 * 作用：修改指定手机号的登录密码，并注销该账号所有已登录设备。
 * 忘记密码、或想换一个更好记的密码时用它。
 */
import { one, run, nowISO } from '../server/db.mjs';
import { hashPassword } from '../server/auth.mjs';

const [phone, pwd] = process.argv.slice(2);
if (!phone || !pwd) {
  console.error("用法: node tools/set-password.mjs <手机号> '<新密码>'");
  process.exit(1);
}
if (String(pwd).length < 8) {
  console.error('密码至少 8 位');
  process.exit(1);
}
const u = one('SELECT id, phone, nickname FROM users WHERE phone=?', phone);
if (!u) {
  console.error(`没有找到手机号 ${phone} 的账号`);
  process.exit(1);
}
run('UPDATE users SET password_hash=?, updated_at=? WHERE id=?', hashPassword(pwd), nowISO(), u.id);
const killed = run('UPDATE sessions SET revoked=1 WHERE user_id=?', u.id);
console.log(`✅ 已修改 ${u.phone}（${u.nickname}）的密码，并注销了所有已登录设备`);
console.log('   现在可以用新密码登录了');
