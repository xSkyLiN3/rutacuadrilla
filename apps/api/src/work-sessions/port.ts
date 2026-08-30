import type {
  CurrentWorkSessionInput,
  FinishWorkSessionInput,
  FinishWorkSessionResult,
  JoinWorkSessionInput,
  JoinWorkSessionResult,
  StartWorkSessionInput,
  StartWorkSessionResult,
  WorkSessionAccessInput,
  WorkSessionServiceApi,
  WorkSessionView,
} from "@rutacuadrilla/domain";

export type {
  CurrentWorkSessionInput,
  FinishWorkSessionInput,
  FinishWorkSessionResult,
  JoinWorkSessionInput,
  JoinWorkSessionResult,
  StartWorkSessionInput,
  StartWorkSessionResult,
  WorkSessionAccessInput,
  WorkSessionView,
};

export type WorkSessionServicePort = Pick<
  WorkSessionServiceApi,
  "finish" | "get" | "getCurrent" | "join" | "start"
>;
