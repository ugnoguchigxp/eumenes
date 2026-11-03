import { lazy, Suspense } from "react";
import type { BackgroundKind } from "../../../api/domains/settings/contracts";
import type { SpatialItem, SpatialOptions } from "../domains/background";
import type { AvatarCue } from "../domains/avatar";
import { LightAvatarBackground } from "./domains/conversation/LightAvatarBackground";
import { ErrorBoundary } from "./ErrorBoundary";

const HiyoriAvatarBackground = lazy(() =>
	import("./domains/conversation/HiyoriAvatarBackground").then((module) => ({
		default: module.HiyoriAvatarBackground,
	})),
);

const SpatialBackground = lazy(() =>
	import("../domains/background").then((module) => ({
		default: module.SpatialBackground,
	})),
);

/** Only the selected background is mounted; switching never owns conversation/audio. */
export function ConversationBackground({
	kind,
	spatial,
	items,
	interactive = false,
	...avatar
}: {
	kind: BackgroundKind;
	spatial?: Partial<SpatialOptions>;
	/** Monitored states for Spatial; absent: its unconfirmed samples. */
	items?: readonly SpatialItem[];
	/** Background mode: the chat is hidden and the background takes pointer input. */
	interactive?: boolean;
	active: boolean;
	cue?: AvatarCue | null;
	phase?: "neutral" | "listening" | "thinking";
}) {
	if (kind === "light-fairy")
		return <LightAvatarBackground {...avatar} interactive={interactive} />;
	if (kind === "live2d-hiyori")
		return (
			<ErrorBoundary label="avatar">
				<Suspense fallback={null}>
					<HiyoriAvatarBackground {...avatar} />
				</Suspense>
			</ErrorBoundary>
		);
	return (
		<ErrorBoundary label="background">
			<Suspense fallback={null}>
				<SpatialBackground
					active={avatar.active}
					options={spatial}
					items={items}
					interactive={interactive}
				/>
			</Suspense>
		</ErrorBoundary>
	);
}
