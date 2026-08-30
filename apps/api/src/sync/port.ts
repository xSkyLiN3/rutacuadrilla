import type {
  PullChangesResult,
  PushCommandsInput,
  PushCommandsResult,
  SyncServiceApi,
  TechnicalContextPackage,
  TechnicalContextSummary,
} from "@rutacuadrilla/domain";

export type {
  PullChangesResult,
  PushCommandsInput,
  PushCommandsResult,
  TechnicalContextPackage,
  TechnicalContextSummary,
};

export type SyncServicePort = Pick<
  SyncServiceApi,
  "createTechnicalContext" | "getContextPackage" | "listContexts" | "pullChanges" | "pushCommands"
>;
