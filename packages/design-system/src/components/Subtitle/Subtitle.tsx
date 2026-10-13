import "./Subtitle.css";

export type SubtitleProps = {
	text: string;
	style: "netflix" | "prime" | "classic" | "glass";
	size: "medium" | "large" | "xlarge";
	inline?: boolean;
};

/** The same renderer is used for speech overlays and settings previews. */
export function Subtitle({ text, style, size, inline }: SubtitleProps) {
	return (
		<div
			className={`subtitle${inline ? " subtitle-inline" : ""}`}
			data-style={style}
			data-size={size}
			data-testid="subtitle"
			aria-hidden="true"
		>
			<p>{text}</p>
		</div>
	);
}
