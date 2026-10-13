import { createLibrary, defineComponent } from "./sdk";
import {
	SettingsSectionView,
	SettingsNavigationView,
	SettingsChangesView,
} from "./settings-components";
import { z } from "zod";
import {
	ComponentsView,
	ImageFrame,
	MemoryReview,
	QuestionView,
	SettingsForm,
	SmallForm,
} from "./components";
import {
	layoutSchema,
	parseRequest,
	viewRegistry,
	type ArtifactRequest,
} from "./contracts";

import {
	MusicView,
	PlaylistView,
	GenerationView,
	MusicLibraryView,
	MusicWorkspaceView,
} from "./media-components";
import { TimerWorkspaceView } from "./timer-components";
import { SubtitlePreviewView } from "./subtitle-components";

const renderers = {
	"subtitle-preview": SubtitlePreviewView,
	"settings-section": SettingsSectionView,
	"settings-navigation": SettingsNavigationView,
	"settings-changes": SettingsChangesView,
	"timer-workspace": TimerWorkspaceView,
	"music-workspace": MusicWorkspaceView,
	"music-library": MusicLibraryView,
	"music-player": MusicView,
	playlist: PlaylistView,
	"generation-status": GenerationView,
	components: ComponentsView,
	"generated-image": ImageFrame,
	question: QuestionView,
	form: SmallForm,
	memory: MemoryReview,
	settings: SettingsForm,
};
function RegisteredView({ request }: { request: ArtifactRequest }) {
	const Component = renderers[request.view];
	return <Component request={request} />;
}
export const artifactLibrary = createLibrary({
	id: "eumenes-artifact-v1",
	components: [
		...Object.values(viewRegistry).map((definition) =>
			defineComponent({
				name: definition.name,
				description: definition.label,
				props: z.object({ request: definition.schema }),
				component: ({ props }) => (
					<RegisteredView request={parseRequest(props.request)} />
				),
			}),
		),
		defineComponent({
			name: "Composition",
			description: "登録済みの表示を並べる",
			props: z.object({ request: layoutSchema }),
			component: ({ props }) => {
				const request = layoutSchema.parse(props.request);
				return (
					<section
						aria-label={request.title ?? "組合せ表示"}
						className={`aui-composition aui-composition-${request.direction}`}
					>
						{request.children.map((child, index) => (
							<RegisteredView
								key={`${index}:${child.view}:${child.source ?? "inline"}`}
								request={child}
							/>
						))}
					</section>
				);
			},
		}),
	],
});
