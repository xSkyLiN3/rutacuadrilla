export const capabilityCodes = [
  "ROUTE_VIEW",
  "ROUTE_DRAFT_EDIT",
  "ROUTE_PUBLISH",
  "CAMPAIGN_MANAGE",
  "DENOMINATOR_AMEND",
  "SESSION_START",
  "SESSION_JOIN",
  "POINT_MARK",
  "POINT_CORRECT",
  "POINT_CONFLICT_RESOLVE",
  "GPS_TRACK",
  "SESSION_CLOSE",
  "SESSION_CLOSE_EXCEPTION",
  "FINANCE_VIEW_OWN",
  "FINANCE_VIEW_ALL",
  "CLOSURE_CORRECT",
  "MEMBERS_MANAGE",
] as const;

export type Capability = (typeof capabilityCodes)[number];

export const pointTypes = ["DWELLING", "BUILDING_ENTRANCE", "COMPLEX_ACCESS", "SPECIAL"] as const;

export type PointType = (typeof pointTypes)[number];

export const pointSources = ["MANUAL", "CSV", "OSM", "GEOJSON"] as const;
export type PointSource = (typeof pointSources)[number];

export const revisionStatuses = ["DRAFT", "PUBLISHED", "SUPERSEDED", "ARCHIVED"] as const;

export type RevisionStatus = (typeof revisionStatuses)[number];
