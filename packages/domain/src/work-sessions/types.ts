export const workSessionStatuses = ["ACTIVE", "FINISHED"] as const;
export type WorkSessionStatus = (typeof workSessionStatuses)[number];

export type WorkSessionParticipantView = {
  displayName: string;
  joinedAt: string;
  membershipId: string;
  profile: "ASSISTANT" | "DRIVER" | "OTHER";
};

export type WorkSessionDeviceView = {
  deviceId: string;
  joinedAt: string;
  membershipId: string;
};

export type WorkSessionView = {
  campaignId: string;
  campaignRouteId: string;
  devices: WorkSessionDeviceView[];
  finishedAt?: string;
  finishedByMembershipId?: string;
  id: string;
  participants: WorkSessionParticipantView[];
  startedAt: string;
  startedByDeviceId: string;
  startedByMembershipId: string;
  status: WorkSessionStatus;
  version: number;
};

export type StartWorkSessionInput = {
  actorUserId: string;
  campaignRouteId: string;
  crewId: string;
  deviceId: string;
  operationId: string;
};

export type StartWorkSessionResult = {
  created: boolean;
  replayed: boolean;
  workSession: WorkSessionView;
};

export type JoinWorkSessionInput = {
  actorUserId: string;
  crewId: string;
  deviceId: string;
  operationId: string;
  workSessionId: string;
};

export type JoinWorkSessionResult = {
  deviceJoined: boolean;
  participantJoined: boolean;
  replayed: boolean;
  workSession: WorkSessionView;
};

export type FinishWorkSessionInput = {
  actorUserId: string;
  crewId: string;
  expectedVersion: number;
  operationId: string;
  workSessionId: string;
};

export type FinishWorkSessionResult = {
  replayed: boolean;
  workSession: WorkSessionView;
};

export type WorkSessionAccessInput = {
  actorUserId: string;
  crewId: string;
  workSessionId: string;
};

export type CurrentWorkSessionInput = {
  actorUserId: string;
  campaignRouteId: string;
  crewId: string;
};

export type WorkSessionServiceApi = {
  finish(input: FinishWorkSessionInput): Promise<FinishWorkSessionResult>;
  get(input: WorkSessionAccessInput): Promise<WorkSessionView | null>;
  getCurrent(input: CurrentWorkSessionInput): Promise<WorkSessionView | null>;
  join(input: JoinWorkSessionInput): Promise<JoinWorkSessionResult>;
  start(input: StartWorkSessionInput): Promise<StartWorkSessionResult>;
};
