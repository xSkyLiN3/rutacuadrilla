import type {
  AssignCampaignRouteResult,
  CampaignDetailView,
  CampaignServiceApi,
  CampaignSummaryView,
  VehicleView,
} from "@rutacuadrilla/domain";

export type { AssignCampaignRouteResult, CampaignDetailView, CampaignSummaryView, VehicleView };

export type CampaignServicePort = Pick<
  CampaignServiceApi,
  | "activateCampaign"
  | "assignRoute"
  | "createCampaign"
  | "createVehicle"
  | "getCampaign"
  | "listCampaigns"
  | "listVehicles"
  | "removeRoute"
>;
