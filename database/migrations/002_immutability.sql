CREATE FUNCTION protect_route_revision() RETURNS trigger
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
       OR OLD.point_count IS DISTINCT FROM NEW.point_count
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

CREATE TRIGGER route_revision_protection
BEFORE UPDATE OR DELETE ON route_revision
FOR EACH ROW EXECUTE FUNCTION protect_route_revision();

CREATE FUNCTION require_draft_route_revision() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_status text;
  new_status text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO old_status
      FROM route_revision
      WHERE crew_id = OLD.crew_id AND id = OLD.route_revision_id;
    IF old_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'PUBLISHED_ROUTE_REVISION_POINTS_IMMUTABLE'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status INTO new_status
      FROM route_revision
      WHERE crew_id = NEW.crew_id AND id = NEW.route_revision_id;
    IF new_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'PUBLISHED_ROUTE_REVISION_POINTS_IMMUTABLE'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER route_revision_point_protection
BEFORE INSERT OR UPDATE OR DELETE ON route_revision_point
FOR EACH ROW EXECUTE FUNCTION require_draft_route_revision();

CREATE FUNCTION protect_service_point_version() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'SERVICE_POINT_VERSION_APPEND_ONLY'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER service_point_version_protection
BEFORE UPDATE OR DELETE ON service_point_version
FOR EACH ROW EXECUTE FUNCTION protect_service_point_version();

CREATE FUNCTION protect_audit_event() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_EVENT_APPEND_ONLY'
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER audit_event_row_protection
BEFORE UPDATE OR DELETE ON audit_event
FOR EACH ROW EXECUTE FUNCTION protect_audit_event();

CREATE TRIGGER route_revision_no_truncate
BEFORE TRUNCATE ON route_revision
FOR EACH STATEMENT EXECUTE FUNCTION protect_audit_event();

CREATE TRIGGER route_revision_point_no_truncate
BEFORE TRUNCATE ON route_revision_point
FOR EACH STATEMENT EXECUTE FUNCTION protect_audit_event();

CREATE TRIGGER service_point_version_no_truncate
BEFORE TRUNCATE ON service_point_version
FOR EACH STATEMENT EXECUTE FUNCTION protect_audit_event();

CREATE TRIGGER audit_event_no_truncate
BEFORE TRUNCATE ON audit_event
FOR EACH STATEMENT EXECUTE FUNCTION protect_audit_event();
