import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@eumenes/design-system";
import type { ArtifactRequest } from "./contracts";

export function TextBlockView({ request }: { request: ArtifactRequest }) {
	if (request.view !== "text-block") return null;
	return (
		<section
			className="aui-text-block"
			data-emphasis={
				request.emphasis === "normal" ? undefined : request.emphasis
			}
		>
			<h2>{request.title}</h2>
			{request.body && <p>{request.body}</p>}
		</section>
	);
}
export function InfoCardView({ request }: { request: ArtifactRequest }) {
	if (request.view !== "info-card") return null;
	return (
		<Card>
			<CardHeader>
				<CardTitle>{request.title}</CardTitle>
			</CardHeader>
			<CardContent>
				<p>{request.body}</p>
			</CardContent>
		</Card>
	);
}
