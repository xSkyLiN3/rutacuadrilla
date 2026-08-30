CREATE TABLE route_revision_edit (
  crew_id uuid NOT NULL,
  id uuid NOT NULL,
  route_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  edit_key text NOT NULL CHECK (length(edit_key) BETWEEN 1 AND 120),
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  point_count integer NOT NULL CHECK (point_count > 0),
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, id),
  UNIQUE (crew_id, edit_key),
  FOREIGN KEY (crew_id, route_id, revision_id)
    REFERENCES route_revision(crew_id, route_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, created_by_membership_id)
    REFERENCES crew_membership(crew_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(result_json) = 'object')
);

CREATE INDEX route_revision_edit_revision_idx
  ON route_revision_edit (crew_id, route_id, revision_id, created_at DESC);

ALTER TABLE service_point_version
  ALTER COLUMN import_batch_id DROP NOT NULL,
  ADD COLUMN route_revision_edit_id uuid,
  ADD CONSTRAINT service_point_version_edit_fk
    FOREIGN KEY (crew_id, route_revision_edit_id)
    REFERENCES route_revision_edit(crew_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT service_point_version_single_origin
    CHECK (num_nonnulls(import_batch_id, route_revision_edit_id) = 1);

CREATE FUNCTION protect_idempotency_receipt() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_APPEND_ONLY'
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER route_revision_edit_row_protection
BEFORE UPDATE OR DELETE ON route_revision_edit
FOR EACH ROW EXECUTE FUNCTION protect_idempotency_receipt();

CREATE TRIGGER route_revision_edit_no_truncate
BEFORE TRUNCATE ON route_revision_edit
FOR EACH STATEMENT EXECUTE FUNCTION protect_idempotency_receipt();

CREATE FUNCTION protect_service_point_identity() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.crew_id IS DISTINCT FROM NEW.crew_id
     OR OLD.id IS DISTINCT FROM NEW.id
     OR OLD.source IS DISTINCT FROM NEW.source
     OR OLD.external_id IS DISTINCT FROM NEW.external_id THEN
    RAISE EXCEPTION 'SERVICE_POINT_IDENTITY_IMMUTABLE'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER service_point_identity_protection
BEFORE UPDATE ON service_point
FOR EACH ROW EXECUTE FUNCTION protect_service_point_identity();
