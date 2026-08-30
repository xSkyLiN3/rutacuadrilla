-- Technical, synthetic operating context for the local-first reference vertical.
-- Product semantics remain provisional until the P0 business decisions are approved.

CREATE TABLE campaign (
  crew_id uuid NOT NULL REFERENCES crew(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  timezone text NOT NULL DEFAULT 'America/Santiago',
  currency char(3) NOT NULL DEFAULT 'CLP',
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('DRAFT', 'ACTIVE', 'CLOSED', 'ARCHIVED')),
  technical_fixture boolean NOT NULL DEFAULT false,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, id),
  FOREIGN KEY (crew_id, created_by_membership_id)
    REFERENCES crew_membership(crew_id, id) ON DELETE RESTRICT
);

CREATE TABLE campaign_route (
  crew_id uuid NOT NULL,
  id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  route_id uuid NOT NULL,
  route_revision_id uuid NOT NULL,
  route_content_hash char(64) NOT NULL
    CHECK (route_content_hash ~ '^[0-9a-f]{64}$'),
  point_count integer NOT NULL CHECK (point_count > 0),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'CLOSED', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, id),
  UNIQUE (crew_id, campaign_id, route_revision_id),
  FOREIGN KEY (crew_id, campaign_id)
    REFERENCES campaign(crew_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, route_id, route_revision_id)
    REFERENCES route_revision(crew_id, route_id, id) ON DELETE RESTRICT
);

CREATE TABLE campaign_point (
  crew_id uuid NOT NULL,
  id uuid NOT NULL,
  campaign_route_id uuid NOT NULL,
  service_point_id uuid NOT NULL,
  service_point_version_id uuid NOT NULL,
  display_order integer NOT NULL CHECK (display_order >= 0),
  display_state text NOT NULL DEFAULT 'SIN_VISITAR'
    CHECK (display_state IN (
      'SIN_VISITAR',
      'SOBRE_ENTREGADO',
      'VOLVER',
      'SIN_RESPUESTA',
      'APORTO',
      'NO_PARTICIPA'
    )),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  last_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, id),
  UNIQUE (crew_id, campaign_route_id, service_point_id),
  UNIQUE (crew_id, campaign_route_id, display_order),
  FOREIGN KEY (crew_id, campaign_route_id)
    REFERENCES campaign_route(crew_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, service_point_id, service_point_version_id)
    REFERENCES service_point_version(crew_id, service_point_id, id) ON DELETE RESTRICT
);

CREATE TABLE sync_sequence (
  crew_id uuid PRIMARY KEY REFERENCES crew(id) ON DELETE RESTRICT,
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0)
);

CREATE TABLE point_event (
  crew_id uuid NOT NULL,
  id uuid NOT NULL,
  operation_id uuid NOT NULL,
  campaign_point_id uuid NOT NULL,
  actor_membership_id uuid NOT NULL,
  device_id uuid NOT NULL,
  event_type text NOT NULL
    CHECK (event_type IN ('POINT_STATUS_CHANGED', 'POINT_STATUS_REVERTED')),
  base_version bigint NOT NULL CHECK (base_version >= 0),
  applied_version bigint NOT NULL CHECK (applied_version > 0),
  previous_state text NOT NULL,
  next_state text NOT NULL,
  depends_on_operation_id uuid,
  reverts_event_id uuid,
  occurred_at_device timestamptz,
  received_at_server timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, id),
  UNIQUE (crew_id, operation_id),
  UNIQUE (crew_id, campaign_point_id, applied_version),
  FOREIGN KEY (crew_id, campaign_point_id)
    REFERENCES campaign_point(crew_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, actor_membership_id)
    REFERENCES crew_membership(crew_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, reverts_event_id)
    REFERENCES point_event(crew_id, id) ON DELETE RESTRICT,
  CHECK (previous_state IN (
    'SIN_VISITAR', 'SOBRE_ENTREGADO', 'VOLVER',
    'SIN_RESPUESTA', 'APORTO', 'NO_PARTICIPA'
  )),
  CHECK (next_state IN (
    'SIN_VISITAR', 'SOBRE_ENTREGADO', 'VOLVER',
    'SIN_RESPUESTA', 'APORTO', 'NO_PARTICIPA'
  )),
  CHECK (
    (event_type = 'POINT_STATUS_CHANGED' AND reverts_event_id IS NULL)
    OR
    (event_type = 'POINT_STATUS_REVERTED' AND reverts_event_id IS NOT NULL)
  )
);

ALTER TABLE campaign_point
  ADD CONSTRAINT campaign_point_last_event_fk
  FOREIGN KEY (crew_id, last_event_id)
  REFERENCES point_event(crew_id, id) ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE sync_operation_receipt (
  crew_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  campaign_point_id uuid NOT NULL,
  device_id uuid NOT NULL,
  status text NOT NULL
    CHECK (status IN ('APPLIED', 'CONFLICT', 'REJECTED', 'BLOCKED_DEPENDENCY')),
  result_json jsonb NOT NULL,
  event_id uuid,
  change_sequence bigint,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, operation_id),
  FOREIGN KEY (crew_id, campaign_point_id)
    REFERENCES campaign_point(crew_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, event_id)
    REFERENCES point_event(crew_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(result_json) = 'object'),
  CHECK (
    (status = 'APPLIED' AND event_id IS NOT NULL AND change_sequence IS NOT NULL)
    OR
    (status <> 'APPLIED' AND event_id IS NULL AND change_sequence IS NULL)
  )
);

CREATE TABLE sync_change (
  crew_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_id uuid NOT NULL,
  campaign_point_id uuid NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, sequence),
  UNIQUE (crew_id, event_id),
  FOREIGN KEY (crew_id, event_id)
    REFERENCES point_event(crew_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, campaign_point_id)
    REFERENCES campaign_point(crew_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX campaign_route_campaign_idx
  ON campaign_route (crew_id, campaign_id, created_at DESC);

CREATE INDEX campaign_point_context_idx
  ON campaign_point (crew_id, campaign_route_id, id);

CREATE INDEX point_event_point_history_idx
  ON point_event (crew_id, campaign_point_id, applied_version DESC);

CREATE INDEX sync_change_pull_idx
  ON sync_change (crew_id, sequence);

CREATE TRIGGER point_event_row_protection
BEFORE UPDATE OR DELETE ON point_event
FOR EACH ROW EXECUTE FUNCTION protect_idempotency_receipt();

CREATE TRIGGER point_event_no_truncate
BEFORE TRUNCATE ON point_event
FOR EACH STATEMENT EXECUTE FUNCTION protect_idempotency_receipt();

CREATE TRIGGER sync_operation_receipt_row_protection
BEFORE UPDATE OR DELETE ON sync_operation_receipt
FOR EACH ROW EXECUTE FUNCTION protect_idempotency_receipt();

CREATE TRIGGER sync_operation_receipt_no_truncate
BEFORE TRUNCATE ON sync_operation_receipt
FOR EACH STATEMENT EXECUTE FUNCTION protect_idempotency_receipt();

CREATE TRIGGER sync_change_row_protection
BEFORE UPDATE OR DELETE ON sync_change
FOR EACH ROW EXECUTE FUNCTION protect_idempotency_receipt();

CREATE TRIGGER sync_change_no_truncate
BEFORE TRUNCATE ON sync_change
FOR EACH STATEMENT EXECUTE FUNCTION protect_idempotency_receipt();
