ALTER TABLE campaign
  ADD COLUMN starts_on date,
  ADD COLUMN ends_on date,
  ADD CONSTRAINT campaign_date_range_check
    CHECK (starts_on IS NULL OR ends_on IS NULL OR starts_on <= ends_on);

CREATE TABLE vehicle (
  crew_id uuid NOT NULL REFERENCES crew(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  registration text CHECK (
    registration IS NULL OR length(btrim(registration)) BETWEEN 1 AND 32
  ),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, id),
  FOREIGN KEY (crew_id, created_by_membership_id)
    REFERENCES crew_membership(crew_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX vehicle_name_ci_unique
  ON vehicle (crew_id, lower(name));

CREATE UNIQUE INDEX vehicle_registration_ci_unique
  ON vehicle (crew_id, lower(registration))
  WHERE registration IS NOT NULL;

ALTER TABLE campaign_route
  ADD COLUMN vehicle_id uuid,
  ADD CONSTRAINT campaign_route_vehicle_fk
    FOREIGN KEY (crew_id, vehicle_id)
    REFERENCES vehicle(crew_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT campaign_route_campaign_identity_unique
    UNIQUE (crew_id, campaign_id, id);

CREATE UNIQUE INDEX campaign_route_route_unique
  ON campaign_route (crew_id, campaign_id, route_id);

CREATE UNIQUE INDEX campaign_route_vehicle_unique
  ON campaign_route (crew_id, campaign_id, vehicle_id)
  WHERE vehicle_id IS NOT NULL;

ALTER TABLE campaign_point
  ADD COLUMN campaign_id uuid;

UPDATE campaign_point AS point
SET campaign_id = assignment.campaign_id
FROM campaign_route AS assignment
WHERE assignment.crew_id = point.crew_id
  AND assignment.id = point.campaign_route_id;

ALTER TABLE campaign_point
  ALTER COLUMN campaign_id SET NOT NULL,
  ADD CONSTRAINT campaign_point_campaign_fk
    FOREIGN KEY (crew_id, campaign_id)
    REFERENCES campaign(crew_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT campaign_point_campaign_identity_unique
    UNIQUE (crew_id, campaign_id, service_point_id);

CREATE TABLE campaign_route_segment_side (
  crew_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  campaign_route_id uuid NOT NULL,
  street_segment_id uuid NOT NULL,
  street_segment_version_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('MANUAL', 'OSM', 'GEOJSON')),
  external_id text NOT NULL CHECK (length(btrim(external_id)) BETWEEN 1 AND 160),
  physical_side text NOT NULL CHECK (physical_side IN ('LEFT', 'RIGHT')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crew_id, campaign_route_id, street_segment_id, physical_side),
  FOREIGN KEY (crew_id, campaign_id, campaign_route_id)
    REFERENCES campaign_route(crew_id, campaign_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, street_segment_id, street_segment_version_id)
    REFERENCES route_street_segment_version(crew_id, street_segment_id, id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX campaign_segment_physical_side_unique
  ON campaign_route_segment_side (
    crew_id,
    campaign_id,
    source,
    lower(external_id),
    physical_side
  );

CREATE INDEX campaign_segment_route_idx
  ON campaign_route_segment_side (crew_id, campaign_route_id);

COMMENT ON TABLE campaign_route_segment_side IS
  'Claims exactos por source+external_id normalizado y lado. BOTH se materializa como LEFT y RIGHT. No es una detección espacial.';

CREATE FUNCTION protect_campaign_identity_and_state() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.crew_id IS DISTINCT FROM NEW.crew_id
     OR OLD.id IS DISTINCT FROM NEW.id
     OR OLD.created_by_membership_id IS DISTINCT FROM NEW.created_by_membership_id
     OR OLD.technical_fixture IS DISTINCT FROM NEW.technical_fixture
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'CAMPAIGN_IDENTITY_IMMUTABLE'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
    (OLD.status = 'DRAFT' AND NEW.status = 'ACTIVE')
    OR (OLD.status = 'ACTIVE' AND NEW.status = 'CLOSED')
    OR (OLD.status = 'CLOSED' AND NEW.status = 'ARCHIVED')
  ) THEN
    RAISE EXCEPTION 'INVALID_CAMPAIGN_TRANSITION'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.status <> 'DRAFT' AND (
    OLD.name IS DISTINCT FROM NEW.name
    OR OLD.timezone IS DISTINCT FROM NEW.timezone
    OR OLD.currency IS DISTINCT FROM NEW.currency
    OR OLD.starts_on IS DISTINCT FROM NEW.starts_on
    OR OLD.ends_on IS DISTINCT FROM NEW.ends_on
  ) THEN
    RAISE EXCEPTION 'ACTIVE_CAMPAIGN_IMMUTABLE'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER campaign_identity_and_state_protection
BEFORE UPDATE ON campaign
FOR EACH ROW EXECUTE FUNCTION protect_campaign_identity_and_state();

CREATE FUNCTION require_draft_campaign_route() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  campaign_status text;
  target_crew_id uuid;
  target_campaign_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    target_crew_id := NEW.crew_id;
    target_campaign_id := NEW.campaign_id;
  ELSE
    target_crew_id := OLD.crew_id;
    target_campaign_id := OLD.campaign_id;
  END IF;

  SELECT status INTO campaign_status
    FROM campaign
    WHERE crew_id = target_crew_id AND id = target_campaign_id;

  IF campaign_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'CAMPAIGN_COMPOSITION_IMMUTABLE'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER campaign_route_draft_protection
BEFORE INSERT OR UPDATE OR DELETE ON campaign_route
FOR EACH ROW EXECUTE FUNCTION require_draft_campaign_route();

CREATE FUNCTION protect_campaign_point_composition() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  campaign_status text;
  target_crew_id uuid;
  target_campaign_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.crew_id IS DISTINCT FROM NEW.crew_id
       OR OLD.id IS DISTINCT FROM NEW.id
       OR OLD.campaign_id IS DISTINCT FROM NEW.campaign_id
       OR OLD.campaign_route_id IS DISTINCT FROM NEW.campaign_route_id
       OR OLD.service_point_id IS DISTINCT FROM NEW.service_point_id
       OR OLD.service_point_version_id IS DISTINCT FROM NEW.service_point_version_id
       OR OLD.display_order IS DISTINCT FROM NEW.display_order
       OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
      RAISE EXCEPTION 'CAMPAIGN_POINT_COMPOSITION_IMMUTABLE'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    target_crew_id := NEW.crew_id;
    target_campaign_id := NEW.campaign_id;
  ELSE
    target_crew_id := OLD.crew_id;
    target_campaign_id := OLD.campaign_id;
  END IF;

  SELECT status INTO campaign_status
    FROM campaign
    WHERE crew_id = target_crew_id AND id = target_campaign_id;

  IF campaign_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'CAMPAIGN_COMPOSITION_IMMUTABLE'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER campaign_point_composition_protection
BEFORE INSERT OR UPDATE OR DELETE ON campaign_point
FOR EACH ROW EXECUTE FUNCTION protect_campaign_point_composition();

CREATE TRIGGER campaign_segment_side_draft_protection
BEFORE INSERT OR UPDATE OR DELETE ON campaign_route_segment_side
FOR EACH ROW EXECUTE FUNCTION require_draft_campaign_route();

CREATE FUNCTION protect_vehicle_identity() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.crew_id IS DISTINCT FROM NEW.crew_id
     OR OLD.id IS DISTINCT FROM NEW.id
     OR OLD.created_by_membership_id IS DISTINCT FROM NEW.created_by_membership_id
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'VEHICLE_IDENTITY_IMMUTABLE'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER vehicle_identity_protection
BEFORE UPDATE ON vehicle
FOR EACH ROW EXECUTE FUNCTION protect_vehicle_identity();
