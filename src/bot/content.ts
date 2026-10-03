// Content System V1 AI run kinds and their handlers (the runner itself is in ai.ts).
import type { RunHandlers } from "./ai";
import { caseHandler } from "./cases";
import { draftHandler } from "./drafts";
import { equipmentHandler } from "./equipment";
import { planHandler } from "./plan";

export const CONTENT_HANDLERS: RunHandlers = {
  PLAN: planHandler,
  EQUIPMENT: equipmentHandler,
  DRAFT: draftHandler,
  CASE: caseHandler,
};
