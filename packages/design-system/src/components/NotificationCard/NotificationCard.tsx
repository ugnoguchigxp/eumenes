import type { HTMLAttributes, ReactNode } from "react";
import "./NotificationCard.css";

export interface NotificationCardProps extends HTMLAttributes<HTMLElement> {
	appName: string;
	title: string;
	message: string;
	icon?: ReactNode;
	timestamp?: string;
	dateTime?: string;
	status?: ReactNode;
	actions?: ReactNode;
}

/** A compact notification surface; playback and dismissal belong to the caller. */
export function NotificationCard({
	appName,
	title,
	message,
	icon,
	timestamp,
	dateTime,
	status,
	actions,
	className = "",
	...props
}: NotificationCardProps) {
	return (
		<article className={`notification-card ${className}`} {...props}>
			<div className="notification-card-heading">
				{icon && <span className="notification-card-icon" aria-hidden="true">{icon}</span>}
				<span className="notification-card-app">{appName}</span>
				{timestamp && <time dateTime={dateTime}>{timestamp}</time>}
			</div>
			<div className="notification-card-content">
				<h3>{title}</h3>
				<p>{message}</p>
				{status && <div className="notification-card-status">{status}</div>}
			</div>
			{actions && <div className="notification-card-actions">{actions}</div>}
		</article>
	);
}
