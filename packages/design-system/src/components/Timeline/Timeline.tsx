import { cn } from "../../utils/cn";
import "./Timeline.css";

export type TimelineItem = { label?: string; title: string; body?: string };

export type TimelineProps = {
	title?: string;
	items: TimelineItem[];
	className?: string;
};

export function Timeline({ title, items, className }: TimelineProps) {
	return (
		<section
			className={cn("ds-timeline", className)}
			aria-label={title ?? "タイムライン"}
		>
			{title && <h3 className="ds-timeline-title">{title}</h3>}
			<ol className="ds-timeline-list">
				{items.map((item, index) => (
					<li key={`${index}-${item.title}`} className="ds-timeline-item">
						<span className="ds-timeline-dot" aria-hidden="true" />
						{item.label && (
							<span className="ds-timeline-label">{item.label}</span>
						)}
						<h4 className="ds-timeline-item-title">{item.title}</h4>
						{item.body && <p className="ds-timeline-body">{item.body}</p>}
					</li>
				))}
			</ol>
		</section>
	);
}
