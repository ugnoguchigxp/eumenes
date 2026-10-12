import { lazy, Suspense } from "react";
import type { BackgroundKind } from "../../../api/domains/settings/contracts";
import type { AvatarCue } from "../domains/avatar";
import { LightAvatarBackground } from "./domains/conversation/LightAvatarBackground";
import { ErrorBoundary } from "./ErrorBoundary";

const SpatialBackground = lazy(() =>
	import("../domains/background").then((module) => ({
		default: module.SpatialBackground,
	})),
);

/** Only the selected background is mounted; switching never owns conversation/audio. */
export function ConversationBackground({
	kind,
	...avatar
}: {
	kind: BackgroundKind;
	active: boolean;
	cue?: AvatarCue | null;
	phase?: "neutral" | "listening" | "thinking";
}) {
	if (kind === "light-fairy") return <LightAvatarBackground {...avatar} />;
	return (
		<ErrorBoundary label="background">
			<Suspense fallback={null}>
				<SpatialBackground active={avatar.active} />
			</Suspense>
		</ErrorBoundary>
	);
}
