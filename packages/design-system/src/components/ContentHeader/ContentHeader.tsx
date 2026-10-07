import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { AdaptiveText } from "../AdaptiveText/AdaptiveText";
import { Button } from "../Button/Button";

export interface IContentHeaderProps {
	patientName: string;
	patientId?: string;
	variant?: "session" | "detail" | "compact";
	additionalInfo?: ReactNode;
	className?: string;
	navigationBack?: ReactNode;
	onBack?: () => void;
	backLabel?: string;
}

// Simplified placeholder to avoid external app dependencies
export const ContentHeader: React.FC<IContentHeaderProps> = ({
	patientName,
	patientId,
	additionalInfo,
	className = "",
	navigationBack,
	onBack,
	backLabel,
}) => {
	return (
		<header
			className={`w-full border-b border-border bg-background ${className}`}
		>
			<div className="flex items-center justify-between gap-4 px-ui py-ui">
				<div className="flex items-center gap-3 min-w-0">
					{onBack ? (
						<Button variant="link" className="px-2 -ml-2" onClick={onBack}>
							<ArrowLeft className="h-4 w-4 mr-2" />
							{backLabel || "戻る"}
						</Button>
					) : (
						navigationBack
					)}
					<div className="min-w-0">
						<div className="flex items-center gap-2 min-w-0">
							<h1 className="text-xl font-semibold text-foreground truncate">
								{patientName}
							</h1>
							{patientId && (
								<span className="text-sm text-muted-foreground bg-card rounded px-2 py-1 flex items-center max-w-[120px]">
									<AdaptiveText
										text={
											patientId.length > 8
												? `${patientId.slice(0, 8)}...`
												: patientId
										}
										className="w-full"
									/>
								</span>
							)}
						</div>
						{additionalInfo && (
							<div className="text-sm text-muted-foreground truncate">
								{additionalInfo}
							</div>
						)}
					</div>
				</div>
			</div>
		</header>
	);
};
