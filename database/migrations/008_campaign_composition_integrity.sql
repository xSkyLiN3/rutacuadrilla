ALTER TABLE campaign_point
  ADD CONSTRAINT campaign_point_campaign_route_identity_fk
    FOREIGN KEY (crew_id, campaign_id, campaign_route_id)
    REFERENCES campaign_route(crew_id, campaign_id, id)
    ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION require_draft_campaign_route() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_status text;
  destination_status text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO source_status
      FROM campaign
      WHERE crew_id = OLD.crew_id AND id = OLD.campaign_id
      FOR SHARE;

    IF source_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'CAMPAIGN_COMPOSITION_IMMUTABLE'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status INTO destination_status
      FROM campaign
      WHERE crew_id = NEW.crew_id AND id = NEW.campaign_id
      FOR SHARE;

    IF destination_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'CAMPAIGN_COMPOSITION_IMMUTABLE'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION protect_campaign_point_composition() RETURNS trigger
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
    WHERE crew_id = target_crew_id AND id = target_campaign_id
    FOR SHARE;

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

COMMENT ON CONSTRAINT campaign_point_campaign_route_identity_fk ON campaign_point IS
  'Impide asociar un punto a una campaña distinta de la campaña de su CampaignRoute.';
