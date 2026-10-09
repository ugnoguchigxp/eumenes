import { Renderer } from "./sdk";
import { Component, useMemo, type ReactNode } from "react";
import { compileLang } from "./compiler";
import { artifactLibrary } from "./library";
import { ArtifactRuntimeContext, type ArtifactRuntime } from "./runtime";
export { compileArtifact, compileLang } from "./compiler";
export { artifactLibrary } from "./library";
export * from "./contracts";
export type { ArtifactRuntime } from "./runtime";

class ArtifactBoundary extends Component<
	{ resetKey: string; children: ReactNode },
	{ failed: boolean; resetKey: string }
> {
	state = { failed: false, resetKey: this.props.resetKey };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	static getDerivedStateFromProps(
		props: { resetKey: string },
		state: { resetKey: string },
	) {
		return props.resetKey === state.resetKey
			? null
			: { failed: false, resetKey: props.resetKey };
	}
	render() {
		return this.state.failed ? (
			<p role="alert">
				このアーティファクトを表示できません。情報を更新して再試行してください。
			</p>
		) : (
			this.props.children
		);
	}
}

/** Host supplies validated Lang and authorized data. No SDK toolProvider is installed. */
export function ArtifactRenderer({
	lang,
	runtime,
}: {
	lang: string;
	runtime: ArtifactRuntime;
}) {
	const validated = useMemo(() => {
		try {
			return compileLang(lang, runtime.snapshot);
		} catch {
			return null;
		}
	}, [lang, runtime.snapshot]);
	if (!validated)
		return (
			<p role="alert">この表示の定義または参照データを確認してください。</p>
		);
	const source = validated.request.source ?? `inline-${validated.request.view}`;
	return (
		<ArtifactRuntimeContext.Provider value={runtime}>
			<ArtifactBoundary
				resetKey={`${validated.lang}:${runtime.snapshot[source]?.revision ?? 0}`}
			>
				<div className="artifact-ui">
					<Renderer
						response={validated.lang}
						library={artifactLibrary}
						isStreaming={false}
						publishObservability={false}
					/>
				</div>
			</ArtifactBoundary>
		</ArtifactRuntimeContext.Provider>
	);
}
