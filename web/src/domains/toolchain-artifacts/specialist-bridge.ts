import { createContext, useContext } from "react";
import type {
	SpecialistCommandKind,
	SpecialistSession,
} from "../../../../api/domains/dialogue/contracts";

export type BridgeResult = { ok: true } | { ok: false; message: string };

/**
 * What the workspace gives a screen that works with a specialist session: the session itself,
 * its commands and the tab operations. Screens use it through a context so a domain adapter
 * never depends on dialogue code.
 */
export type SpecialistBridge = {
	/** The conversation's live session, or null. */
	session: SpecialistSession | null;
	/** Return to the normal addressee, resume a suspended work, or discard the draft. */
	command(kind: Exclude<SpecialistCommandKind, "close">): Promise<BridgeResult>;
	/** Cancel the run the session is working on. */
	stopRun(): Promise<BridgeResult>;
	/**
	 * Close the screen of this artifact revision: unsaved work asks the user first; a clean
	 * session is closed before the tab goes away.
	 */
	requestClose(artifactRevisionId: string): Promise<BridgeResult>;
	/**
	 * Edit the saved item chosen in the history instead: the active session's work ends (unsaved work
	 * only when `discardUnsaved`) and a session on the item takes over.
	 */
	retarget(targetRef: string, discardUnsaved: boolean): Promise<BridgeResult>;
	/** Close the session after a successful save while it was suspended. */
	closeSession(): Promise<BridgeResult>;
};

export const SpecialistBridgeContext = createContext<SpecialistBridge | null>(
	null,
);
export function useSpecialistBridge(): SpecialistBridge | null {
	return useContext(SpecialistBridgeContext);
}
