import { useCallback, useEffect } from "react";
import { useArtifactRuntime } from "./runtime";

export function useInputStatus(source: string, id: string) {
	const { setEditing } = useArtifactRuntime();
	useEffect(
		() => () => setEditing?.(source, id, null),
		[setEditing, source, id],
	);
	return useCallback(
		(message: string | null) => setEditing?.(source, id, message),
		[setEditing, source, id],
	);
}
