import {
	DrawingWorkspace,
	type DrawingWorkspaceProps,
} from "@eumenes/design-system";
import type { ArtifactRequest } from "./contracts";
import { useAction } from "./components";
import { z } from "zod";
export type DrawingResource = Omit<
	DrawingWorkspaceProps,
	"onNew" | "onOpen" | "onRefresh" | "onDelete" | "onBrowse"
> & { kind: "drawing-workspace"; revision: number };
export function DrawingWorkspaceView({
	request,
}: {
	request: ArtifactRequest;
}) {
	const action = useAction(request),
		r = action.resource as DrawingResource;
	// URLs come only from the host's runtime snapshot, and stay within the authenticated SPA.
	let url: string | undefined;
	try {
		const target = new URL(r.url ?? "", window.location.origin);
		// A saved reference, or a new drawing's draft that is stored only by its first save.
		const match = /^#drawing\/(new\/)?([a-f0-9-]{36})(?:\?(.*))?$/.exec(
			target.hash,
		);
		const keys = match?.[1]
			? ["title", "conversationId"]
			: ["revision", "conversationId"];
		const context = new URLSearchParams(match?.[3]);
		if (
			r.url &&
			target.origin === window.location.origin &&
			!target.username &&
			!target.password &&
			match &&
			z.uuid().safeParse(match[2]).success &&
			(!context.has("revision") ||
				(/^\d+$/.test(context.get("revision")!) &&
					Number.isSafeInteger(Number(context.get("revision"))) &&
					Number(context.get("revision")) > 0)) &&
			(!context.has("title") ||
				(context.get("title")!.length > 0 &&
					context.get("title")!.length <= 200)) &&
			(!context.has("conversationId") ||
				(context.get("conversationId")!.length > 0 &&
					context.get("conversationId")!.length <= 128)) &&
			[...context.keys()].every(
				(key) => keys.includes(key) && context.getAll(key).length === 1,
			)
		) {
			target.pathname = "/excalidraw";
			target.search = "?embedded=1";
			url = target.href;
		}
	} catch {
		/* A malformed runtime URL is never navigated. */
	}
	return (
		<DrawingWorkspace
			{...r}
			url={url}
			busy={r.busy || action.pending}
			onBrowse={(open) => action.send("drawing-browse", { open })}
			onNew={() => {
				void action.send("drawing-new", {});
			}}
			onOpen={(id) => {
				void action.send("drawing-open", { id });
			}}
			onRefresh={() => {
				void action.send("drawing-refresh", {});
			}}
			onDelete={(id) => action.send("drawing-delete", { id })}
		/>
	);
}
