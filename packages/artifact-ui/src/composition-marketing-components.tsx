import {
	ContentImage,
	CtaBanner,
	FeatureCard,
	Hero,
	MediaCard,
	ProductCard,
	Testimonial,
} from "@eumenes/design-system";
import { aspectSize, resolveCompositionImage } from "./composition-images";
import type { ImageAspect } from "./composition-images";
import type { ImageSpec } from "./composition-contracts";
import type { ArtifactRequest } from "./contracts";

/** Resolves an optional image spec of a view to the design system's image source. */
function image(
	spec: ImageSpec | undefined,
	aspect: ImageAspect | undefined,
	width: number,
) {
	return spec
		? resolveCompositionImage(spec, aspectSize(aspect, width))
		: undefined;
}

export function HeroView({ request }: { request: ArtifactRequest }) {
	if (request.view !== "hero") return null;
	return (
		<Hero
			variant={request.variant}
			eyebrow={request.eyebrow}
			title={request.title}
			body={request.body}
			primaryLabel={request.primaryLabel}
			secondaryLabel={request.secondaryLabel}
			image={image(
				request.image,
				"landscape",
				request.variant === "background" ? 1600 : 1200,
			)}
			overlay={request.overlay}
			align={request.align}
			height={request.height}
		/>
	);
}

export function ContentImageView({ request }: { request: ArtifactRequest }) {
	if (request.view !== "image") return null;
	return (
		<ContentImage
			image={resolveCompositionImage(
				request.image,
				aspectSize(request.aspect, 1200),
			)}
			aspect={request.aspect}
			caption={request.caption}
			rounded={request.rounded}
		/>
	);
}

export function MediaCardView({ request }: { request: ArtifactRequest }) {
	if (request.view !== "media-card") return null;
	return (
		<MediaCard
			variant={request.variant}
			image={resolveCompositionImage(
				request.image,
				aspectSize(request.aspect, 800),
			)}
			aspect={request.aspect}
			eyebrow={request.eyebrow}
			title={request.title}
			body={request.body}
		/>
	);
}

export function ProductCardView({ request }: { request: ArtifactRequest }) {
	if (request.view !== "product-card") return null;
	return (
		<ProductCard
			variant={request.variant}
			image={image(request.image, "square", 800)}
			name={request.name}
			price={request.price}
			compareAtPrice={request.compareAtPrice}
			badge={request.badge}
			body={request.body}
			rating={request.rating}
		/>
	);
}

export function FeatureCardView({ request }: { request: ArtifactRequest }) {
	if (request.view !== "feature-card") return null;
	return (
		<FeatureCard
			icon={request.icon}
			title={request.title}
			body={request.body}
		/>
	);
}

export function TestimonialView({ request }: { request: ArtifactRequest }) {
	if (request.view !== "testimonial") return null;
	return (
		<Testimonial
			quote={request.quote}
			name={request.name}
			role={request.role}
			avatar={image(request.avatar, "square", 160)}
		/>
	);
}

export function CtaBannerView({ request }: { request: ArtifactRequest }) {
	if (request.view !== "cta-banner") return null;
	return (
		<CtaBanner
			variant={request.variant}
			title={request.title}
			body={request.body}
			primaryLabel={request.primaryLabel}
			secondaryLabel={request.secondaryLabel}
			image={image(request.image, "wide", 1600)}
		/>
	);
}
