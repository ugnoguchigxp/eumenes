import { useState } from "react";
import { cn } from "../../utils/cn";
import { ContentImage, type ContentImageSource } from "../ContentImage";
import "./Testimonial.css";

export type TestimonialProps = {
	quote: string;
	name: string;
	role?: string;
	/** Shown round. Falls back to the initial of the name. */
	avatar?: ContentImageSource;
	className?: string;
};

function initialOf(name: string): string {
	return Array.from(name.trim())[0] ?? "?";
}

export function Testimonial({
	quote,
	name,
	role,
	avatar,
	className,
}: TestimonialProps) {
	const [failedSrc, setFailedSrc] = useState<string | null>(null);
	const image =
		avatar && "src" in avatar && failedSrc !== avatar.src ? avatar : null;
	return (
		<figure className={cn("ds-testimonial", className)}>
			<blockquote>
				<p>{quote}</p>
			</blockquote>
			<figcaption>
				{image ? (
					<ContentImage
						className="ds-testimonial-avatar"
						image={image}
						aspect="square"
						rounded={false}
						onImageError={() => setFailedSrc(image.src)}
					/>
				) : (
					<span
						className="ds-testimonial-avatar ds-testimonial-initial"
						aria-hidden="true"
					>
						{initialOf(name)}
					</span>
				)}
				<span className="ds-testimonial-person">
					<span className="ds-testimonial-name">{name}</span>
					{role && <span className="ds-testimonial-role">{role}</span>}
				</span>
			</figcaption>
		</figure>
	);
}
