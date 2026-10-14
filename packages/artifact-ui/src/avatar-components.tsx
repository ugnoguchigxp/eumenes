import type { ArtifactRequest } from "./contracts";
import { useArtifactRuntime } from "./runtime";

/** The host owns the WebGL preview; this view only places it. */
export function AvatarMotionLabView({ request }: { request: ArtifactRequest }) {
	const runtime = useArtifactRuntime();
	const view = runtime.hostViews?.["avatar-motion-lab"];
	return (
		<section
			className="aui-avatar-motion-lab"
			aria-label={request.title ?? "光の精霊の動作試写"}
		>
			{view ? view() : <p>この画面では光の精霊の試写を利用できません。</p>}
		</section>
	);
}
