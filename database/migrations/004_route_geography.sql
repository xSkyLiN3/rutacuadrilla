ALTER TABLE route_revision
  ADD COLUMN draft_version integer NOT NULL DEFAULT 1
    CHECK (draft_version > 0),
  ADD COLUMN area_version_id uuid,
  ADD COLUMN content_schema_version integer CHECK (content_schema_version = 2),
  ADD COLUMN segment_count integer NOT NULL DEFAULT 0
    CHECK (segment_count >= 0);

CREATE TABLE route_revision_change (
  crew_id uuid NOT NULL,
  id uuid NOT NULL,
  route_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  change_type text NOT NULL CHECK (
    change_type IN (
      'SET_AREA',
      'ADD_POINT',
      'UPDATE_POINT',
      'REMOVE_POINT',
      'REPLACE_SEGMENTS',
      'IMPORT_OSM_SELECTION'
    )
  ),
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  base_draft_version integer NOT NULL CHECK (base_draft_version > 0),
  resulting_draft_version integer NOT NULL CHECK (resulting_draft_version > base_draft_version),
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, id),
  UNIQUE (crew_id, revision_id, resulting_draft_version),
  FOREIGN KEY (crew_id, route_id, revision_id)
    REFERENCES route_revision(crew_id, route_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, created_by_membership_id)
    REFERENCES crew_membership(crew_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(result_json) = 'object')
);

CREATE INDEX route_revision_change_revision_idx
  ON route_revision_change (crew_id, route_id, revision_id, created_at DESC);

CREATE TABLE route_revision_area_version (
  crew_id uuid NOT NULL,
  id uuid NOT NULL,
  route_revision_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  geometry_geojson jsonb NOT NULL,
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  origin_change_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, id),
  UNIQUE (crew_id, route_revision_id, id),
  UNIQUE (crew_id, route_revision_id, version_number),
  UNIQUE (crew_id, route_revision_id, content_hash),
  FOREIGN KEY (crew_id, route_revision_id)
    REFERENCES route_revision(crew_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, origin_change_id)
    REFERENCES route_revision_change(crew_id, id) ON DELETE RESTRICT,
  CHECK (geometry_geojson ->> 'type' = 'MultiPolygon')
);

ALTER TABLE route_revision
  ADD CONSTRAINT route_revision_area_version_fk
  FOREIGN KEY (crew_id, id, area_version_id)
  REFERENCES route_revision_area_version(crew_id, route_revision_id, id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE route_street_segment (
  crew_id uuid NOT NULL REFERENCES crew(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('MANUAL', 'OSM', 'GEOJSON')),
  external_id text NOT NULL CHECK (length(btrim(external_id)) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, id),
  UNIQUE (crew_id, source, external_id),
  UNIQUE (crew_id, id, source)
);

CREATE UNIQUE INDEX route_street_segment_external_id_ci_unique
  ON route_street_segment (crew_id, source, lower(external_id));

CREATE TABLE route_street_segment_version (
  crew_id uuid NOT NULL,
  id uuid NOT NULL,
  street_segment_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  name text CHECK (name IS NULL OR length(name) <= 200),
  geometry_geojson jsonb NOT NULL,
  source text NOT NULL CHECK (source IN ('MANUAL', 'OSM', 'GEOJSON')),
  source_version text CHECK (source_version IS NULL OR length(source_version) <= 120),
  attribution text CHECK (attribution IS NULL OR length(attribution) <= 500),
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  origin_change_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, id),
  UNIQUE (crew_id, street_segment_id, id),
  UNIQUE (crew_id, street_segment_id, version_number),
  UNIQUE (crew_id, street_segment_id, content_hash),
  FOREIGN KEY (crew_id, street_segment_id)
    REFERENCES route_street_segment(crew_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, street_segment_id, source)
    REFERENCES route_street_segment(crew_id, id, source) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, origin_change_id)
    REFERENCES route_revision_change(crew_id, id) ON DELETE RESTRICT,
  CHECK (geometry_geojson ->> 'type' = 'MultiLineString'),
  CHECK (source <> 'OSM' OR length(btrim(COALESCE(attribution, ''))) > 0)
);

CREATE TABLE route_revision_segment (
  crew_id uuid NOT NULL,
  route_revision_id uuid NOT NULL,
  street_segment_id uuid NOT NULL,
  street_segment_version_id uuid NOT NULL,
  display_order integer NOT NULL CHECK (display_order >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, route_revision_id, street_segment_id),
  UNIQUE (crew_id, route_revision_id, street_segment_version_id),
  FOREIGN KEY (crew_id, route_revision_id)
    REFERENCES route_revision(crew_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, street_segment_id, street_segment_version_id)
    REFERENCES route_street_segment_version(crew_id, street_segment_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX route_revision_segment_revision_idx
  ON route_revision_segment (crew_id, route_revision_id, display_order);

ALTER TABLE service_point_version
  ADD COLUMN route_revision_change_id uuid,
  DROP CONSTRAINT service_point_version_single_origin,
  ADD CONSTRAINT service_point_version_change_fk
    FOREIGN KEY (crew_id, route_revision_change_id)
    REFERENCES route_revision_change(crew_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT service_point_version_single_origin
    CHECK (num_nonnulls(import_batch_id, route_revision_edit_id, route_revision_change_id) = 1);

CREATE OR REPLACE FUNCTION protect_route_revision() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'PUBLISHED_ROUTE_REVISION_IMMUTABLE'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.crew_id IS DISTINCT FROM NEW.crew_id
     OR OLD.id IS DISTINCT FROM NEW.id
     OR OLD.route_id IS DISTINCT FROM NEW.route_id
     OR OLD.created_by_membership_id IS DISTINCT FROM NEW.created_by_membership_id
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'ROUTE_REVISION_IDENTITY_IMMUTABLE'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.status IN ('PUBLISHED', 'SUPERSEDED', 'ARCHIVED') THEN
    IF OLD.revision_number IS DISTINCT FROM NEW.revision_number
       OR OLD.content_hash IS DISTINCT FROM NEW.content_hash
       OR OLD.content_schema_version IS DISTINCT FROM NEW.content_schema_version
       OR OLD.point_count IS DISTINCT FROM NEW.point_count
       OR OLD.segment_count IS DISTINCT FROM NEW.segment_count
       OR OLD.area_version_id IS DISTINCT FROM NEW.area_version_id
       OR OLD.draft_version IS DISTINCT FROM NEW.draft_version
       OR OLD.published_by_membership_id IS DISTINCT FROM NEW.published_by_membership_id
       OR OLD.published_at IS DISTINCT FROM NEW.published_at THEN
      RAISE EXCEPTION 'PUBLISHED_ROUTE_REVISION_CONTENT_IMMUTABLE'
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT (
      (OLD.status = 'PUBLISHED' AND NEW.status IN ('PUBLISHED', 'SUPERSEDED', 'ARCHIVED'))
      OR (OLD.status = 'SUPERSEDED' AND NEW.status IN ('SUPERSEDED', 'ARCHIVED'))
      OR (OLD.status = 'ARCHIVED' AND NEW.status = 'ARCHIVED')
    ) THEN
      RAISE EXCEPTION 'INVALID_ROUTE_REVISION_TRANSITION'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF OLD.status = 'DRAFT' AND NEW.status NOT IN ('DRAFT', 'PUBLISHED') THEN
    RAISE EXCEPTION 'INVALID_ROUTE_REVISION_TRANSITION'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION protect_route_geography_version() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ROUTE_GEOGRAPHY_VERSION_APPEND_ONLY'
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER route_revision_area_version_protection
BEFORE UPDATE OR DELETE ON route_revision_area_version
FOR EACH ROW EXECUTE FUNCTION protect_route_geography_version();

CREATE TRIGGER route_street_segment_version_protection
BEFORE UPDATE OR DELETE ON route_street_segment_version
FOR EACH ROW EXECUTE FUNCTION protect_route_geography_version();

CREATE TRIGGER route_revision_change_protection
BEFORE UPDATE OR DELETE ON route_revision_change
FOR EACH ROW EXECUTE FUNCTION protect_idempotency_receipt();

CREATE FUNCTION protect_route_street_segment_identity() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.crew_id IS DISTINCT FROM NEW.crew_id
     OR OLD.id IS DISTINCT FROM NEW.id
     OR OLD.source IS DISTINCT FROM NEW.source
     OR OLD.external_id IS DISTINCT FROM NEW.external_id
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'ROUTE_STREET_SEGMENT_IDENTITY_IMMUTABLE'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER route_street_segment_identity_protection
BEFORE UPDATE ON route_street_segment
FOR EACH ROW EXECUTE FUNCTION protect_route_street_segment_identity();

CREATE TRIGGER route_revision_segment_protection
BEFORE INSERT OR UPDATE OR DELETE ON route_revision_segment
FOR EACH ROW EXECUTE FUNCTION require_draft_route_revision();

CREATE TRIGGER route_revision_area_version_no_truncate
BEFORE TRUNCATE ON route_revision_area_version
FOR EACH STATEMENT EXECUTE FUNCTION protect_route_geography_version();

CREATE TRIGGER route_street_segment_version_no_truncate
BEFORE TRUNCATE ON route_street_segment_version
FOR EACH STATEMENT EXECUTE FUNCTION protect_route_geography_version();

CREATE TRIGGER route_revision_change_no_truncate
BEFORE TRUNCATE ON route_revision_change
FOR EACH STATEMENT EXECUTE FUNCTION protect_idempotency_receipt();

CREATE TRIGGER route_revision_segment_no_truncate
BEFORE TRUNCATE ON route_revision_segment
FOR EACH STATEMENT EXECUTE FUNCTION protect_route_geography_version();
