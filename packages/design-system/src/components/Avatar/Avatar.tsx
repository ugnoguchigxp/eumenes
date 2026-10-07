import * as React from "react";
import { cn } from "@/utils/cn";

interface IAvatarProps extends React.HTMLAttributes<HTMLDivElement> {
	src?: string;
	alt?: string;
	fallback?: React.ReactNode | string;
	size?: "xs" | "sm" | "md" | "lg" | "xl";
}

const sizeClasses = {
	xs: "h-7 w-7 text-xs",
	sm: "h-8 w-8 text-xs",
	md: "h-11 w-11 text-sm",
	lg: "h-16 w-16 text-lg",
	xl: "h-20 w-20 text-xl",
};

export const Avatar = React.memo(
	React.forwardRef<HTMLDivElement, IAvatarProps>(
		({ src, alt, fallback, size = "md", className, ...props }, ref) => {
			const [imgError, setImgError] = React.useState(false);

			const getInitials = () => {
				if (!fallback && !alt) return "?";

				if (typeof fallback === "string") {
					return fallback
						.split(" ")
						.map((n) => n[0])
						.join("")
						.toUpperCase()
						.slice(0, 2);
				}

				if (alt) {
					return alt
						.split(" ")
						.map((n) => n[0])
						.join("")
						.toUpperCase()
						.slice(0, 2);
				}

				return "?";
			};

			return (
				<div
					ref={ref}
					className={cn(
						"relative flex shrink-0 overflow-hidden rounded-full",
						sizeClasses[size],
						className,
					)}
					{...props}
				>
					{src && !imgError ? (
						<img
							src={src}
							alt={alt || "Avatar"}
							className="h-full w-full object-cover"
							onError={() => setImgError(true)}
						/>
					) : (
						<div className="flex h-full w-full items-center justify-center bg-muted text-muted-foreground">
							{React.isValidElement(fallback) ? fallback : getInitials()}
						</div>
					)}
				</div>
			);
		},
	),
);

Avatar.displayName = "Avatar";
