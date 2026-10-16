import { systemContext } from "../../../../infrastructure/system-context";
/** The preface every step shares. No model or profile name appears in a prompt. */
export const PREFACE = systemContext("steward.contexts.common.preface", {});
