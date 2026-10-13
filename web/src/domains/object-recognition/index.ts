import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
export function useRecognitionArtifacts(
	client: EumenesClient,
	open: () => void,
) {
	const seen = useRef<Set<string> | null>(null);
	const commands = useQuery({
		queryKey: [queryRoots.objectRecognition, client.identity, "commands"],
		queryFn: ({ signal }) => client.recognitionCommands("main", signal),
	});
	useEffect(() => {
		if (!commands.data) return;
		if (!seen.current) {
			seen.current = new Set(commands.data);
			return;
		}
		const added = commands.data.filter((id) => !seen.current!.has(id));
		added.forEach((id) => seen.current!.add(id));
		if (added.length) open();
	}, [commands.data, open]);
}
