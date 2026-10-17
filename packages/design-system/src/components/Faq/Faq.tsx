import { ChevronDown } from "lucide-react";
import { cn } from "../../utils/cn";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "../Collapsible";
import "./Faq.css";

export type FaqItem = { question: string; answer: string };

export type FaqProps = {
	title?: string;
	items: FaqItem[];
	className?: string;
};

/** 開閉状態は各項目が内部で持つ（Collapsible の非制御モード）。 */
export function Faq({ title, items, className }: FaqProps) {
	return (
		<section
			className={cn("ds-faq", className)}
			aria-label={title ?? "よくある質問"}
		>
			{title && <h3 className="ds-faq-title">{title}</h3>}
			<div className="ds-faq-list">
				{items.map((item, index) => (
					<Collapsible key={`${index}-${item.question}`} className="ds-faq-item">
						<CollapsibleTrigger className="ds-faq-trigger">
							<span>{item.question}</span>
							<ChevronDown className="ds-faq-chevron" aria-hidden="true" />
						</CollapsibleTrigger>
						<CollapsibleContent className="ds-faq-answer">
							{item.answer}
						</CollapsibleContent>
					</Collapsible>
				))}
			</div>
		</section>
	);
}
