#!/usr/bin/env node
/* 用「取件码」重置密码。
 *
 *   node tools/reset-by-code.mjs 12345678                  → 只校验码，打印账号信息
 *   node tools/reset-by-code.mjs 12345678 'NewPass123!'     → 校验并重置密码
 *
 * 这个脚本存在的原因：本站可能没配短信通道，用户忘了密码就彻底进不来。
 * 登录页「忘记密码」会生成一个 8 位取件码，同时把这条命令整条显示出来，
 * 复制粘到终端回车即可。码 30 分钟有效、用一次就作废。
 *
 * 安全边界说清楚：
 *   - 这个脚本必须在**服务器上**跑，能跑它的人本来就对数据库有完全权限，
 *     所以它不构成额外的权限放大，只是把「改密码」这件事变得不容易写错。
 *   - 取件码只是防止「顺手改错人」和「码被截图后长期有效」，
 *     它不是密码学意义上的凭证，别把它当成短信验证码。
 */
import { one, run, nowISO } from '../server/db.mjs';
import { hashPassword } from '../server/auth.mjs';

const [code, pwd] = process.argv.slice(2);

if (!code) {
  console.error(`
用法：
  node tools/reset-by-code.mjs <取件码>                 查看该码对应的账号
  node tools/reset-by-code.mjs <取件码> '<新密码>'        重置为该密码

取件码在登录页「忘记密码」里生成，30 分钟内有效，只能用一次。
`.trim());
  process.exit(1);
}

const r = one('SELECT * FROM password_resets WHERE code=?', String(code).trim());
if (!r) {
  console.error(`❌ 取件码 ${code} 不存在。请回登录页重新生成（可能是复制时少了位数字）。`);
  process.exit(1);
}
if (r.used_at) {
  console.error('❌ 这个取件码已经用过了。请回登录页重新生成一个新的。');
  process.exit(1);
}
if (Number(r.expires_at) < Date.now()) {
  const min = Math.round((Date.now() - Number(r.expires_at)) / 60000);
  console.error(`❌ 取件码已过期 ${min} 分钟。请回登录页重新生成（有效期 30 分钟）。`);
  process.exit(1);
}

const u = one('SELECT id, phone, nickname FROM users WHERE phone=?', r.phone);
if (!u) {
  /* 这里才会暴露「这个手机号没有账号」。登录页那条接口是故意不说的，
     因为公网接口不该变成手机号探测器；而这句话只出现在终端里，
     能看到的人本来就能直接查库，不构成泄漏。 */
  console.error(`❌ 手机号 ${r.phone} 没有对应账号。请确认登录页填的号码是否正确。`);
  process.exit(1);
}

if (!pwd) {
  const left = Math.ceil((Number(r.expires_at) - Date.now()) / 60000);
  console.log(`✅ 取件码有效，对应账号：${u.phone}（${u.nickname || '未设昵称'}）`);
  console.log(`   还剩 ${left} 分钟有效期。`);
  console.log(`   要重置密码，重新执行并加上新密码：`);
  console.log(`   node tools/reset-by-code.mjs ${code} '你的新密码'`);
  process.exit(0);
}

if (String(pwd).length < 6) {
  console.error('❌ 密码至少 6 位（和注册时的规则一致）');
  process.exit(1);
}

run('UPDATE users SET password_hash=?, updated_at=? WHERE id=?', hashPassword(pwd), nowISO(), u.id);
/* 用掉即焚：同一条码不能改第二次。
   顺手把该账号所有已登录设备踢下线——改密码通常意味着「之前可能不安全了」，
   不踢等于旧会话还能继续用。 */
run('UPDATE password_resets SET used_at=? WHERE phone=?', Date.now(), r.phone);
const killed = run('UPDATE sessions SET revoked=1 WHERE user_id=?', u.id);

console.log(`✅ 已重置 ${u.phone}（${u.nickname || '未设昵称'}）的密码`);
console.log(`   同时注销了 ${killed.changes ?? 0} 个已登录设备，需要重新登录。`);
console.log('   现在可以回登录页用新密码进入了。');
