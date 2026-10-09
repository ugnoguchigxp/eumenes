import { createLibrary, defineComponent } from "@openuidev/react-lang";
import { z } from "zod";
import { ComponentsView, ImageFrame, MemoryReview, QuestionView, SettingsForm, SmallForm } from "./components";
import { parseRequest, viewRegistry } from "./contracts";

const renderers = { components: ComponentsView, "generated-image": ImageFrame, question: QuestionView, form: SmallForm, memory: MemoryReview, settings: SettingsForm };
export const artifactLibrary = createLibrary({
	id: "eumenes-artifact-v1",
	components: Object.values(viewRegistry).map(definition => defineComponent({
		name: definition.name,
		description: definition.label,
		props: z.object({ request: definition.schema }),
		component: ({ props }) => {
			const request = parseRequest(props.request);
			const Component = renderers[request.view];
			return <Component key={`${request.view}:${request.source ?? "inline"}`} request={request}/>;
		},
	})),
});
