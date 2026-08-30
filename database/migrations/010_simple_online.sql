CREATE TABLE simple_route_assignment (
  crew_id uuid NOT NULL REFERENCES crew(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  route_id uuid NOT NULL,
  route_revision_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  assigned_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, id),
  FOREIGN KEY (crew_id, route_id)
    REFERENCES route(crew_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, route_id, route_revision_id)
    REFERENCES route_revision(crew_id, route_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, user_id)
    REFERENCES crew_membership(crew_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, assigned_by_membership_id)
    REFERENCES crew_membership(crew_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX simple_route_assignment_active_user_unique
  ON simple_route_assignment (user_id)
  WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX simple_route_assignment_active_route_unique
  ON simple_route_assignment (crew_id, route_id)
  WHERE status = 'ACTIVE';

CREATE INDEX simple_route_assignment_revision_idx
  ON simple_route_assignment (crew_id, route_revision_id, status);

CREATE TABLE simple_route_point_state (
  crew_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  service_point_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'SIN_VISITAR'
    CHECK (
      state IN (
        'SIN_VISITAR',
        'SOBRE_ENTREGADO',
        'VOLVER',
        'SIN_RESPUESTA',
        'APORTO',
        'NO_PARTICIPA'
      )
    ),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_by_user_id uuid REFERENCES app_user(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, assignment_id, service_point_id),
  FOREIGN KEY (crew_id, assignment_id)
    REFERENCES simple_route_assignment(crew_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, service_point_id)
    REFERENCES service_point(crew_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, updated_by_user_id)
    REFERENCES crew_membership(crew_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX simple_route_point_state_progress_idx
  ON simple_route_point_state (crew_id, assignment_id, state);

CREATE TABLE simple_route_point_event (
  crew_id uuid NOT NULL,
  id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  service_point_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  previous_state text NOT NULL,
  state text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, id),
  UNIQUE (crew_id, assignment_id, operation_id),
  FOREIGN KEY (crew_id, assignment_id, service_point_id)
    REFERENCES simple_route_point_state(crew_id, assignment_id, service_point_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, actor_user_id)
    REFERENCES crew_membership(crew_id, user_id) ON DELETE RESTRICT,
  CHECK (
    previous_state IN (
      'SIN_VISITAR',
      'SOBRE_ENTREGADO',
      'VOLVER',
      'SIN_RESPUESTA',
      'APORTO',
      'NO_PARTICIPA'
    )
  ),
  CHECK (
    state IN (
      'SIN_VISITAR',
      'SOBRE_ENTREGADO',
      'VOLVER',
      'SIN_RESPUESTA',
      'APORTO',
      'NO_PARTICIPA'
    )
  )
);

CREATE FUNCTION protect_simple_route_point_event() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'SIMPLE_ROUTE_POINT_EVENT_APPEND_ONLY'
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER simple_route_point_event_protection
BEFORE UPDATE OR DELETE ON simple_route_point_event
FOR EACH ROW EXECUTE FUNCTION protect_simple_route_point_event();
