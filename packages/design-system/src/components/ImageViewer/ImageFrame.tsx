import type { CSSProperties } from "react";

/** Shared image content; the caller owns whether its frame is embedded or modal. */
export function ImageFrame({
	src,
	alt,
	className,
	style,
}: {
	src?: string;
	alt: string;
	className?: string;
	style?: CSSProperties;
}) {
	return (
		<img src={src || undefined} alt={alt} className={className} style={style} />
	);
}
