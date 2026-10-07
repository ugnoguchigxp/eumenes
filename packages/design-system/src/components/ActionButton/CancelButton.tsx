import { X } from "lucide-react";
import type React from "react";
import { ActionButton, type ActionButtonProps } from "./ActionButton";

/**
 * キャンセルボタン
 */
export const CancelButton: React.FC<ActionButtonProps> = ({
	label = "Cancel",
	icon = X,
	variant = "secondary",
	...props
}) => {
	return (
		<ActionButton label={label} icon={icon} variant={variant} {...props} />
	);
};

CancelButton.displayName = "CancelButton";
