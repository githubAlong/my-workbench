-- 同一账号的快照写入使用事务级 advisory lock 串行化。
-- 旧实现 pg_try_advisory_xact_lock 会在另一请求短暂持锁时立即报错；
-- 新实现最多等待 5 秒，并把超时保留为可识别的 WB_DATA_WRITE_BUSY，
-- 前端会保留本地修改并自动重试，不会把暂时性锁竞争提示成保存失败。

CREATE OR REPLACE FUNCTION public.wb_save_user_data(
  p_payload jsonb,
  p_expected_revision bigint
)
RETURNS TABLE(
  payload jsonb,
  revision bigint,
  updated_at timestamp with time zone
)
LANGUAGE plpgsql
SET search_path TO 'public'
SET lock_timeout TO '5000ms'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_current public.wb_user_data%rowtype;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Authentication required';
  END IF;

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Payload must be a JSON object';
  END IF;

  IF p_expected_revision IS NULL OR p_expected_revision < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Expected revision must be zero or greater';
  END IF;

  BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));
  EXCEPTION
    WHEN lock_not_available THEN
      RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'WB_DATA_WRITE_BUSY';
  END;

  RETURN QUERY
    INSERT INTO public.wb_user_data AS current_row (user_id, payload, revision, updated_at)
    VALUES (v_uid, p_payload, 1, now())
    ON CONFLICT (user_id) DO UPDATE
      SET payload = excluded.payload,
          revision = current_row.revision + 1,
          updated_at = now()
      WHERE current_row.revision = p_expected_revision
    RETURNING current_row.payload, current_row.revision, current_row.updated_at;

  IF NOT FOUND THEN
    SELECT *
      INTO v_current
      FROM public.wb_user_data
      WHERE user_id = v_uid;

    IF FOUND AND v_current.payload = p_payload THEN
      RETURN QUERY
        SELECT v_current.payload, v_current.revision, v_current.updated_at;
      RETURN;
    END IF;

    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'WB_DATA_REVISION_CONFLICT';
  END IF;
END
$function$;
