import type { SubtitleSettings } from "../../../../../api/domains/settings/contracts";

export function Subtitle({
	text,
	style,
	size,
	inline,
}: {
	text: string;
	style: SubtitleSettings["style"];
	size: SubtitleSettings["size"];
	inline?: boolean;
}) {
	return (
		<div
			className={`subtitle${inline ? " subtitle-inline" : ""}`}
			data-style={style}
			data-size={size}
			data-testid="subtitle"
			// The same words are spoken aloud; reading them again would double up.
			aria-hidden="true"
		>
			<p>{text}</p>
		</div>
	);
}
