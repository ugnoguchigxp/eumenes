import { Save } from "lucide-react";
import type React from "react";
import { ActionButton, type ActionButtonProps } from "./ActionButton";

/**
 * 保存ボタン
 */
export const SaveButton: React.FC<ActionButtonProps> = ({
	label = "Save",
	icon = Save,
	variant = "default",
	...props
}) => {
	return (
		<ActionButton label={label} icon={icon} variant={variant} {...props} />
	);
};

SaveButton.displayName = "SaveButton";
