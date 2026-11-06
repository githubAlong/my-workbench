# Supabase 测试库迁移评审（待批准）

目标项目：

- 名称：`my-workbench-dev`
- Ref：`xgvmwbzvvjnhzadfvdmj`
- URL：`https://xgvmwbzvvjnhzadfvdmj.supabase.co`
- 状态：`ACTIVE_HEALTHY`
- 当前 `public` 业务表：0
- 当前迁移记录：0

迁移文件：

`supabase/migrations/20261106032010_attendance_v1_foundation.sql`

## 将写入的对象

1. `public.wb_user_data`
   - 每个认证用户一行账号快照。
   - `revision` CAS，RPC 冲突使用 `40001 / WB_DATA_REVISION_CONFLICT`。
2. `public.attendance_tables`
   - `sheet_type` 只允许 `seat/research/class`。
   - 活跃表唯一索引：`(user_id, grade, sheet_date, sheet_type)`。
   - 每个账号只能读写自己的行。
3. `public.attendance_rows`
   - 外键关联考勤主表。
   - 活跃明细唯一索引：`(table_id, lower(teacher), lower(subject))`。
   - 父表归属触发器阻止把明细挂到其他账号或已删除表。
4. `public.attachments`
   - 考勤原表与现场照片元数据，继续按账号隔离。
5. RLS
   - 所有表启用并强制 RLS。
   - `authenticated` 仅能操作 `user_id = auth.uid()` 的行。
   - `anon` 无表访问权。
6. RPC
   - `wb_save_user_data(jsonb, bigint)`：账号快照 revision CAS。
   - `wb_save_attendance_rows(bigint, jsonb, boolean)`：锁表、预检全部行版本、事务内保存，冲突不静默覆盖。
   - `wb_rename_attendance_grade(text, text)`：年级改名同时迁移云考勤表。
   - `wb_delete_attendance_grade(text)`：软删除该年级考勤主表和明细。
7. Realtime
   - 将 `wb_user_data`、`attendance_tables`、`attendance_rows` 加入 `supabase_realtime` publication。

## 审批门槛

- 没有执行任何 SQL 写入。
- 没有创建测试用户、导入生产数据或读取 secret/service_role。
- 前端只内置 Supabase publishable key。
- 批准前不得运行旧 `supabase_setup.sql`、旧 `step5_att_day.sql` 或任何“先试试”的 SQL。

## 批准后执行顺序

1. 用户在会话中明确批准应用该迁移。
2. 先备份项目状态和迁移文件 SHA-256。
3. 在 dev 项目执行迁移。
4. 运行 Supabase security/performance advisors。
5. 验证 RLS：两个测试用户无法互读、越权更新返回 0 行/拒绝。
6. 验证 Realtime：两客户端在 3 秒内看到更新。
7. 创建隔离测试账号，再完成 Pages 测试站登录与考勤自测。

## 回滚

本迁移初始执行在空库。若审批后执行失败，应在同一维护窗口事务回滚；不要对已有生产库执行自动回滚。若迁移已成功且产生测试业务数据，回滚前先导出数据并单独批准删除。
