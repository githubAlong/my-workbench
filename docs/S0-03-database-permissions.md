# S0-03 数据库权限风险与后续收口

## 当前事实

- `wb_user_data` 的 RLS 只允许用户访问 `auth.uid() = user_id` 的行。
- `authenticated` 当前对 `wb_user_data` 仍有表级 INSERT/UPDATE 权限。
- `wb_save_user_data` 当前是 `SECURITY INVOKER`，依赖调用者持有的表权限和 RLS。
- 正常应用代码只通过 `wb_save_user_data` 保存账号快照。
- 浏览器仍可直接调用 PostgREST 更新自己的 `wb_user_data` 行，因此服务端 revision CAS 可以被自选客户端绕过。

## 限制

在 `SECURITY INVOKER` 前提下，如果直接撤销 authenticated 的 INSERT/UPDATE，
`wb_save_user_data` 也会失去写入能力。

因此不能在未完成函数 redesign 和集成测试前直接撤销表权限。

## 后续建议

1. 新建受控保存函数，明确检查 `auth.uid()`。
2. 继续使用 revision 条件更新和用户级 advisory lock。
3. 函数只允许写入当前 `user_id`，不接受客户端传入用户 ID。
4. 保存成功后返回实际持久化的 payload、revision 和 updated_at。
5. 在独立 Supabase 环境验证 A/B 用户隔离和并发冲突。
6. 验证客户端全部走受控 RPC 后，再撤销普通用户的直接 INSERT/UPDATE。
7. 保留 SELECT 或改用只读 RPC，取决于最终读取策略。
8. 不恢复匿名旧 `wb_get` / `wb_put` 权限。

以上仅记录方案，本轮没有修改数据库结构、函数或权限。
