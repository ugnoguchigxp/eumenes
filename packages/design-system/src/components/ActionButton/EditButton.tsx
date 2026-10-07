import { Pencil } from "lucide-react";
import type React from "react";
import { ActionButton, type ActionButtonProps } from "./ActionButton";

/**
 * 編集ボタン
 */
export const EditButton: React.FC<ActionButtonProps> = ({
	label = "Edit",
	icon = Pencil,
	variant = "secondary",
	...props
}) => {
	return (
		<ActionButton label={label} icon={icon} variant={variant} {...props} />
	);
};

EditButton.displayName = "EditButton";
