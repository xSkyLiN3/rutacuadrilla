export const campaignStatuses = ["DRAFT", "ACTIVE", "CLOSED", "ARCHIVED"] as const;
export type CampaignStatus = (typeof campaignStatuses)[number];

export const vehicleStatuses = ["ACTIVE", "ARCHIVED"] as const;
export type VehicleStatus = (typeof vehicleStatuses)[number];

export type VehicleView = {
  createdAt: string;
  id: string;
  name: string;
  registration?: string;
  status: VehicleStatus;
};

export type CampaignRouteAssignmentView = {
  createdAt: string;
  id: string;
  pointCount: number;
  routeContentHash: string;
  routeId: string;
  routeName: string;
  routeRevisionId: string;
  segmentSideClaimCount: number;
  status: "ACTIVE" | "ARCHIVED" | "CLOSED";
  vehicle: VehicleView;
};

export type CampaignSummaryView = {
  createdAt: string;
  currency: string;
  endsOn?: string;
  id: string;
  name: string;
  pointCount: number;
  routeCount: number;
  startsOn?: string;
  status: CampaignStatus;
  timezone: string;
  updatedAt: string;
};

export type CampaignDetailView = CampaignSummaryView & {
  routes: CampaignRouteAssignmentView[];
};

export type CreateVehicleInput = {
  actorUserId: string;
  crewId: string;
  name: string;
  registration?: string;
};

export type CreateCampaignInput = {
  actorUserId: string;
  crewId: string;
  currency?: string;
  endsOn?: string;
  name: string;
  startsOn?: string;
  timezone?: string;
};

export type CampaignAccessInput = {
  actorUserId: string;
  campaignId: string;
  crewId: string;
};

export type AssignCampaignRouteInput = CampaignAccessInput & {
  routeRevisionId: string;
  vehicleId: string;
};

export type AssignCampaignRouteResult = {
  assignment: CampaignRouteAssignmentView;
  created: boolean;
};

export type RemoveCampaignRouteInput = CampaignAccessInput & {
  campaignRouteId: string;
};

export type CampaignServiceApi = {
  activateCampaign(input: CampaignAccessInput): Promise<CampaignDetailView>;
  assignRoute(input: AssignCampaignRouteInput): Promise<AssignCampaignRouteResult>;
  createCampaign(input: CreateCampaignInput): Promise<CampaignDetailView>;
  createVehicle(input: CreateVehicleInput): Promise<VehicleView>;
  getCampaign(input: CampaignAccessInput): Promise<CampaignDetailView | null>;
  listCampaigns(input: Omit<CampaignAccessInput, "campaignId">): Promise<CampaignSummaryView[]>;
  listVehicles(input: Omit<CampaignAccessInput, "campaignId">): Promise<VehicleView[]>;
  removeRoute(input: RemoveCampaignRouteInput): Promise<CampaignDetailView>;
};
