CREATE TABLE app_user (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX app_user_email_ci_unique
  ON app_user (lower(email));

CREATE TABLE auth_session (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX auth_session_active_user_idx
  ON auth_session (user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE crew (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  timezone text NOT NULL DEFAULT 'America/Santiago',
  currency char(3) NOT NULL DEFAULT 'CLP',
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE crew_membership (
  crew_id uuid NOT NULL REFERENCES crew(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('ADMIN', 'MEMBER')),
  profile text NOT NULL DEFAULT 'OTHER'
    CHECK (profile IN ('DRIVER', 'ASSISTANT', 'OTHER')),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('INVITED', 'ACTIVE', 'SUSPENDED', 'LEFT')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, id),
  UNIQUE (crew_id, user_id)
);

CREATE INDEX crew_membership_user_idx
  ON crew_membership (user_id, status);

CREATE TABLE capability (
  code text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO capability (code, description) VALUES
  ('ROUTE_VIEW', 'View routes and their points'),
  ('ROUTE_DRAFT_EDIT', 'Create routes, import CSV and edit drafts'),
  ('ROUTE_PUBLISH', 'Publish immutable route revisions'),
  ('CAMPAIGN_MANAGE', 'Manage campaigns'),
  ('DENOMINATOR_AMEND', 'Amend campaign denominators'),
  ('SESSION_START', 'Start work sessions'),
  ('SESSION_JOIN', 'Join work sessions'),
  ('POINT_MARK', 'Record point outcomes'),
  ('POINT_CORRECT', 'Correct point outcomes'),
  ('POINT_CONFLICT_RESOLVE', 'Resolve conflicting point outcomes'),
  ('GPS_TRACK', 'Act as the tracking device'),
  ('SESSION_CLOSE', 'Close reconciled sessions'),
  ('SESSION_CLOSE_EXCEPTION', 'Close with a missing-device exception'),
  ('FINANCE_VIEW_OWN', 'View own distribution'),
  ('FINANCE_VIEW_ALL', 'View complete closures and distributions'),
  ('CLOSURE_CORRECT', 'Create corrected closure revisions'),
  ('MEMBERS_MANAGE', 'Manage crew memberships');

CREATE TABLE membership_capability (
  crew_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  capability_code text NOT NULL REFERENCES capability(code) ON DELETE RESTRICT,
  granted_by_membership_id uuid,
  granted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, membership_id, capability_code),
  FOREIGN KEY (crew_id, membership_id)
    REFERENCES crew_membership(crew_id, id) ON DELETE CASCADE,
  FOREIGN KEY (crew_id, granted_by_membership_id)
    REFERENCES crew_membership(crew_id, id) ON DELETE RESTRICT
);

CREATE TABLE sector (
  crew_id uuid NOT NULL REFERENCES crew(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  boundary_geojson jsonb,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, id),
  UNIQUE (crew_id, name),
  FOREIGN KEY (crew_id, created_by_membership_id)
    REFERENCES crew_membership(crew_id, id) ON DELETE RESTRICT,
  CHECK (boundary_geojson IS NULL OR jsonb_typeof(boundary_geojson) IN ('object', 'array'))
);

CREATE UNIQUE INDEX sector_name_ci_unique
  ON sector (crew_id, lower(name));

CREATE TABLE route (
  crew_id uuid NOT NULL REFERENCES crew(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  sector_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  published_revision_sequence integer NOT NULL DEFAULT 0
    CHECK (published_revision_sequence >= 0),
  current_published_revision_id uuid,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, id),
  UNIQUE (crew_id, sector_id, name),
  FOREIGN KEY (crew_id, sector_id)
    REFERENCES sector(crew_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, created_by_membership_id)
    REFERENCES crew_membership(crew_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX route_name_ci_unique
  ON route (crew_id, sector_id, lower(name));

CREATE TABLE route_revision (
  crew_id uuid NOT NULL,
  id uuid NOT NULL,
  route_id uuid NOT NULL,
  revision_number integer,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'ARCHIVED')),
  content_hash char(64),
  point_count integer NOT NULL DEFAULT 0 CHECK (point_count >= 0),
  created_by_membership_id uuid NOT NULL,
  published_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, id),
  UNIQUE (crew_id, route_id, id),
  UNIQUE (crew_id, route_id, revision_number),
  FOREIGN KEY (crew_id, route_id)
    REFERENCES route(crew_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, created_by_membership_id)
    REFERENCES crew_membership(crew_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, published_by_membership_id)
    REFERENCES crew_membership(crew_id, id) ON DELETE RESTRICT,
  CHECK (
    (
      status = 'DRAFT'
      AND revision_number IS NULL
      AND content_hash IS NULL
      AND published_at IS NULL
      AND published_by_membership_id IS NULL
    )
    OR
    (
      status IN ('PUBLISHED', 'SUPERSEDED', 'ARCHIVED')
      AND revision_number IS NOT NULL
      AND revision_number > 0
      AND content_hash ~ '^[0-9a-f]{64}$'
      AND published_at IS NOT NULL
      AND published_by_membership_id IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX route_revision_single_open_draft
  ON route_revision (crew_id, route_id)
  WHERE status = 'DRAFT';

CREATE UNIQUE INDEX route_revision_single_published
  ON route_revision (crew_id, route_id)
  WHERE status = 'PUBLISHED';

ALTER TABLE route
  ADD CONSTRAINT route_current_published_revision_fk
  FOREIGN KEY (crew_id, id, current_published_revision_id)
  REFERENCES route_revision(crew_id, route_id, id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE import_batch (
  crew_id uuid NOT NULL,
  id uuid NOT NULL,
  route_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  import_key text NOT NULL CHECK (length(import_key) BETWEEN 1 AND 120),
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('APPLIED', 'FAILED')),
  total_rows integer NOT NULL CHECK (total_rows >= 0),
  imported_rows integer NOT NULL CHECK (imported_rows >= 0),
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, id),
  UNIQUE (crew_id, import_key),
  UNIQUE (crew_id, revision_id),
  FOREIGN KEY (crew_id, route_id)
    REFERENCES route(crew_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, route_id, revision_id)
    REFERENCES route_revision(crew_id, route_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, created_by_membership_id)
    REFERENCES crew_membership(crew_id, id) ON DELETE RESTRICT,
  CHECK (imported_rows <= total_rows)
);

CREATE TABLE service_point (
  crew_id uuid NOT NULL REFERENCES crew(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('MANUAL', 'CSV', 'OSM', 'GEOJSON')),
  external_id text NOT NULL CHECK (length(btrim(external_id)) BETWEEN 1 AND 128),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'RETIRED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, id),
  UNIQUE (crew_id, source, external_id),
  UNIQUE (crew_id, id, source)
);

CREATE UNIQUE INDEX service_point_external_id_ci_unique
  ON service_point (crew_id, source, lower(external_id));

CREATE TABLE service_point_version (
  crew_id uuid NOT NULL,
  id uuid NOT NULL,
  service_point_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  street text CHECK (street IS NULL OR length(street) <= 200),
  house_number text CHECK (house_number IS NULL OR length(house_number) <= 50),
  point_type text NOT NULL
    CHECK (point_type IN ('DWELLING', 'BUILDING_ENTRANCE', 'COMPLEX_ACCESS', 'SPECIAL')),
  source text NOT NULL CHECK (source IN ('MANUAL', 'CSV', 'OSM', 'GEOJSON')),
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  import_batch_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, id),
  UNIQUE (crew_id, service_point_id, id),
  UNIQUE (crew_id, service_point_id, version_number),
  UNIQUE (crew_id, service_point_id, content_hash),
  FOREIGN KEY (crew_id, service_point_id)
    REFERENCES service_point(crew_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, service_point_id, source)
    REFERENCES service_point(crew_id, id, source) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, import_batch_id)
    REFERENCES import_batch(crew_id, id) ON DELETE RESTRICT
);

CREATE TABLE route_revision_point (
  crew_id uuid NOT NULL,
  route_revision_id uuid NOT NULL,
  service_point_id uuid NOT NULL,
  service_point_version_id uuid NOT NULL,
  display_order integer NOT NULL CHECK (display_order >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, route_revision_id, service_point_id),
  UNIQUE (crew_id, route_revision_id, service_point_version_id),
  FOREIGN KEY (crew_id, route_revision_id)
    REFERENCES route_revision(crew_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, service_point_id, service_point_version_id)
    REFERENCES service_point_version(crew_id, service_point_id, id) ON DELETE RESTRICT
);

CREATE TABLE audit_event (
  crew_id uuid NOT NULL REFERENCES crew(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  actor_membership_id uuid,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  aggregate_type text NOT NULL CHECK (length(aggregate_type) BETWEEN 1 AND 80),
  aggregate_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, id),
  FOREIGN KEY (crew_id, actor_membership_id)
    REFERENCES crew_membership(crew_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX route_revision_route_history_idx
  ON route_revision (crew_id, route_id, created_at DESC);

CREATE INDEX route_revision_point_revision_idx
  ON route_revision_point (crew_id, route_revision_id, display_order);

CREATE INDEX audit_event_aggregate_idx
  ON audit_event (crew_id, aggregate_type, aggregate_id, occurred_at DESC);
