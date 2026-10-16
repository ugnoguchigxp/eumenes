import { systemContext } from "../../../../infrastructure/system-context";
import { PREFACE } from "./common";

export const instructions =
	String(PREFACE) +
	systemContext("steward.contexts.summarize.instructions-text", {});
