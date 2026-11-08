import { alwaysOnOutputContract } from "eumenes-agency";
import { conversationPersona } from "../../domains/dialogue";
import { systemContext } from "../../infrastructure/system-context";
import type { HostPersona } from "./host-types";

export function alwaysOnHostSystem(persona: HostPersona): string {
	return systemContext("dialogue.contexts.agency.think", {
		...conversationPersona(persona),
		contract: alwaysOnOutputContract.description,
	});
}
