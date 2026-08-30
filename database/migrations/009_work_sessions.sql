CREATE TABLE work_session (
  crew_id uuid NOT NULL REFERENCES crew(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  campaign_route_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'FINISHED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  started_by_membership_id uuid NOT NULL,
  started_by_device_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_by_membership_id uuid,
  finished_at timestamptz,
  PRIMARY KEY (crew_id, id),
  UNIQUE (crew_id, id, campaign_route_id),
  FOREIGN KEY (crew_id, campaign_id, campaign_route_id)
    REFERENCES campaign_route(crew_id, campaign_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, started_by_membership_id)
    REFERENCES crew_membership(crew_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, finished_by_membership_id)
    REFERENCES crew_membership(crew_id, id) ON DELETE RESTRICT,
  CHECK (
    (status = 'ACTIVE' AND finished_by_membership_id IS NULL AND finished_at IS NULL)
    OR
    (status = 'FINISHED' AND finished_by_membership_id IS NOT NULL AND finished_at IS NOT NULL)
  )
);

-- FINISHED remains an open state until the later reconciliation/closure vertical exists.
CREATE UNIQUE INDEX work_session_single_open_route
  ON work_session (crew_id, campaign_route_id)
  WHERE status IN ('ACTIVE', 'FINISHED');

CREATE TABLE session_participant (
  crew_id uuid NOT NULL,
  work_session_id uuid NOT NULL,
  campaign_route_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  -- Preserve the source identity exactly. app_user.display_name predates this
  -- migration and has no length constraint, so a tighter snapshot check would
  -- make an otherwise valid existing member unable to join a session.
  display_name_snapshot text NOT NULL,
  profile_snapshot text NOT NULL
    CHECK (profile_snapshot IN ('DRIVER', 'ASSISTANT', 'OTHER')),
  joined_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, work_session_id, membership_id),
  UNIQUE (crew_id, work_session_id, campaign_route_id, membership_id),
  FOREIGN KEY (crew_id, work_session_id, campaign_route_id)
    REFERENCES work_session(crew_id, id, campaign_route_id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, membership_id)
    REFERENCES crew_membership(crew_id, id) ON DELETE RESTRICT
);

CREATE TABLE session_device (
  crew_id uuid NOT NULL,
  work_session_id uuid NOT NULL,
  campaign_route_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  device_id uuid NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, work_session_id, device_id),
  UNIQUE (
    crew_id,
    work_session_id,
    campaign_route_id,
    membership_id,
    device_id
  ),
  FOREIGN KEY (crew_id, work_session_id, campaign_route_id, membership_id)
    REFERENCES session_participant(
      crew_id,
      work_session_id,
      campaign_route_id,
      membership_id
    ) ON DELETE RESTRICT
);

CREATE TABLE work_session_operation_receipt (
  crew_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  operation_type text NOT NULL CHECK (operation_type IN ('START', 'JOIN', 'FINISH')),
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  work_session_id uuid NOT NULL,
  campaign_route_id uuid NOT NULL,
  actor_membership_id uuid NOT NULL,
  result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, operation_id),
  FOREIGN KEY (crew_id, work_session_id, campaign_route_id)
    REFERENCES work_session(crew_id, id, campaign_route_id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, actor_membership_id)
    REFERENCES crew_membership(crew_id, id) ON DELETE RESTRICT
);

ALTER TABLE campaign_point
  ADD CONSTRAINT campaign_point_route_identity_unique
    UNIQUE (crew_id, campaign_route_id, id);

ALTER TABLE point_event
  ADD COLUMN campaign_route_id uuid,
  ADD COLUMN work_session_id uuid;

DROP TRIGGER point_event_row_protection ON point_event;

UPDATE point_event AS event
SET campaign_route_id = point.campaign_route_id
FROM campaign_point AS point
WHERE point.crew_id = event.crew_id
  AND point.id = event.campaign_point_id;

CREATE TRIGGER point_event_row_protection
BEFORE UPDATE OR DELETE ON point_event
FOR EACH ROW EXECUTE FUNCTION protect_idempotency_receipt();

ALTER TABLE point_event
  ALTER COLUMN campaign_route_id SET NOT NULL,
  ADD CONSTRAINT point_event_campaign_point_route_fk
    FOREIGN KEY (crew_id, campaign_route_id, campaign_point_id)
    REFERENCES campaign_point(crew_id, campaign_route_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT point_event_work_session_fk
    FOREIGN KEY (crew_id, work_session_id, campaign_route_id)
    REFERENCES work_session(crew_id, id, campaign_route_id) ON DELETE RESTRICT,
  ADD CONSTRAINT point_event_session_participant_fk
    FOREIGN KEY (crew_id, work_session_id, campaign_route_id, actor_membership_id)
    REFERENCES session_participant(
      crew_id,
      work_session_id,
      campaign_route_id,
      membership_id
    ) ON DELETE RESTRICT,
  ADD CONSTRAINT point_event_session_device_fk
    FOREIGN KEY (
      crew_id,
      work_session_id,
      campaign_route_id,
      actor_membership_id,
      device_id
    ) REFERENCES session_device(
      crew_id,
      work_session_id,
      campaign_route_id,
      membership_id,
      device_id
    ) ON DELETE RESTRICT;

ALTER TABLE sync_operation_receipt
  ADD COLUMN campaign_route_id uuid,
  ADD COLUMN work_session_id uuid,
  ADD COLUMN actor_membership_id uuid;

DROP TRIGGER sync_operation_receipt_row_protection ON sync_operation_receipt;

UPDATE sync_operation_receipt AS receipt
SET campaign_route_id = point.campaign_route_id
FROM campaign_point AS point
WHERE point.crew_id = receipt.crew_id
  AND point.id = receipt.campaign_point_id;

CREATE TRIGGER sync_operation_receipt_row_protection
BEFORE UPDATE OR DELETE ON sync_operation_receipt
FOR EACH ROW EXECUTE FUNCTION protect_idempotency_receipt();

ALTER TABLE sync_operation_receipt
  ALTER COLUMN campaign_route_id SET NOT NULL,
  ADD CONSTRAINT sync_receipt_session_actor_legacy_check
    CHECK (
      (work_session_id IS NULL AND actor_membership_id IS NULL)
      OR
      (work_session_id IS NOT NULL AND actor_membership_id IS NOT NULL)
    ),
  ADD CONSTRAINT sync_receipt_campaign_point_route_fk
    FOREIGN KEY (crew_id, campaign_route_id, campaign_point_id)
    REFERENCES campaign_point(crew_id, campaign_route_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT sync_receipt_work_session_fk
    FOREIGN KEY (crew_id, work_session_id, campaign_route_id)
    REFERENCES work_session(crew_id, id, campaign_route_id) ON DELETE RESTRICT,
  ADD CONSTRAINT sync_receipt_session_participant_fk
    FOREIGN KEY (crew_id, work_session_id, campaign_route_id, actor_membership_id)
    REFERENCES session_participant(
      crew_id,
      work_session_id,
      campaign_route_id,
      membership_id
    ) ON DELETE RESTRICT,
  ADD CONSTRAINT sync_receipt_session_device_fk
    FOREIGN KEY (
      crew_id,
      work_session_id,
      campaign_route_id,
      actor_membership_id,
      device_id
    ) REFERENCES session_device(
      crew_id,
      work_session_id,
      campaign_route_id,
      membership_id,
      device_id
    ) ON DELETE RESTRICT;

CREATE FUNCTION protect_work_session() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'WORK_SESSION_APPEND_ONLY' USING ERRCODE = 'P0001';
  END IF;

  IF OLD.crew_id IS DISTINCT FROM NEW.crew_id
     OR OLD.id IS DISTINCT FROM NEW.id
     OR OLD.campaign_id IS DISTINCT FROM NEW.campaign_id
     OR OLD.campaign_route_id IS DISTINCT FROM NEW.campaign_route_id
     OR OLD.started_by_membership_id IS DISTINCT FROM NEW.started_by_membership_id
     OR OLD.started_by_device_id IS DISTINCT FROM NEW.started_by_device_id
     OR OLD.started_at IS DISTINCT FROM NEW.started_at THEN
    RAISE EXCEPTION 'WORK_SESSION_IDENTITY_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;

  IF NOT (
    OLD.status = 'ACTIVE'
    AND NEW.status IN ('ACTIVE', 'FINISHED')
    AND NEW.version = OLD.version + 1
  ) THEN
    RAISE EXCEPTION 'INVALID_WORK_SESSION_TRANSITION' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER work_session_protection
BEFORE UPDATE OR DELETE ON work_session
FOR EACH ROW EXECUTE FUNCTION protect_work_session();

CREATE TRIGGER work_session_no_truncate
BEFORE TRUNCATE ON work_session
FOR EACH STATEMENT EXECUTE FUNCTION protect_idempotency_receipt();

CREATE TRIGGER session_participant_row_protection
BEFORE UPDATE OR DELETE ON session_participant
FOR EACH ROW EXECUTE FUNCTION protect_idempotency_receipt();

CREATE TRIGGER session_participant_no_truncate
BEFORE TRUNCATE ON session_participant
FOR EACH STATEMENT EXECUTE FUNCTION protect_idempotency_receipt();

CREATE TRIGGER session_device_row_protection
BEFORE UPDATE OR DELETE ON session_device
FOR EACH ROW EXECUTE FUNCTION protect_idempotency_receipt();

CREATE TRIGGER session_device_no_truncate
BEFORE TRUNCATE ON session_device
FOR EACH STATEMENT EXECUTE FUNCTION protect_idempotency_receipt();

CREATE TRIGGER work_session_receipt_row_protection
BEFORE UPDATE OR DELETE ON work_session_operation_receipt
FOR EACH ROW EXECUTE FUNCTION protect_idempotency_receipt();

CREATE TRIGGER work_session_receipt_no_truncate
BEFORE TRUNCATE ON work_session_operation_receipt
FOR EACH STATEMENT EXECUTE FUNCTION protect_idempotency_receipt();

CREATE FUNCTION require_active_session_for_new_sync_artifact() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_status text;
BEGIN
  IF NEW.work_session_id IS NULL THEN
    RAISE EXCEPTION 'WORK_SESSION_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  IF TG_TABLE_NAME = 'sync_operation_receipt'
     AND NEW.actor_membership_id IS NULL THEN
    RAISE EXCEPTION 'WORK_SESSION_PARTICIPANT_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  SELECT status INTO session_status
    FROM work_session
    WHERE crew_id = NEW.crew_id
      AND id = NEW.work_session_id
      AND campaign_route_id = NEW.campaign_route_id
    FOR SHARE;

  IF session_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'WORK_SESSION_NOT_ACTIVE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER point_event_active_session_required
BEFORE INSERT ON point_event
FOR EACH ROW EXECUTE FUNCTION require_active_session_for_new_sync_artifact();

CREATE TRIGGER sync_receipt_active_session_required
BEFORE INSERT ON sync_operation_receipt
FOR EACH ROW EXECUTE FUNCTION require_active_session_for_new_sync_artifact();

COMMENT ON TABLE work_session IS
  'MVS de jornada: solo ACTIVE y FINISHED. Reconciliación, checkpoints y cierre llegan en otro corte.';

COMMENT ON COLUMN point_event.work_session_id IS
  'NULL únicamente para historia anterior a 009; el trigger lo exige en eventos nuevos.';

COMMENT ON COLUMN sync_operation_receipt.work_session_id IS
  'NULL únicamente para historia anterior a 009; el trigger lo exige en recibos nuevos.';
