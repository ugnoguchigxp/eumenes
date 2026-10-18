import { useCallback, useEffect, useRef } from "react";
import type { Viewing } from "../../../api/domains/dialogue/contracts";
import { recognitionViewing } from "../domains/object-recognition/chat-inbox";
import type { useArtifactWorkspace } from "../domains/artifact";

/** What a message refers to when sent now: the specialist's saved work, else a still on the recognition screen. */
export function useCurrentViewing(
	specialistViewing: () => Viewing | undefined,
	active: ReturnType<typeof useArtifactWorkspace>["active"],
) {
	const tab = useRef(active);
	useEffect(() => {
		tab.current = active;
	}, [active]);
	return useCallback(
		() => specialistViewing() ?? recognitionViewing(tab.current),
		[specialistViewing],
	);
}
