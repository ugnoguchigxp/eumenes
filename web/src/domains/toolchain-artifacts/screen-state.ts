import type { Snapshot } from "@eumenes/artifact-ui/contracts";
import type { RegisteredField } from "./documents";
import type { AdapterState } from "./registry";

/** What the screen's callbacks read at call time (the latest render), not at creation. */
type ScreenSnapshot = {
	state: AdapterState;
	snapshot: Snapshot;
	documentFields: Readonly<Record<string, ReadonlyArray<RegisteredField>>>;
};
export type GetLatest = () => ScreenSnapshot;
