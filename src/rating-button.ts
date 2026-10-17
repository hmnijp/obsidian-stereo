import { setIcon } from "obsidian";

export interface RatingSummary {
	button: HTMLButtonElement;
	value: HTMLElement;
}

/** A star button with the current rating printed inside (overlay and extras). */
export function createRatingSummary(
	parent: HTMLElement,
	cls: string
): RatingSummary {
	const button = parent.createEl("button", {
		cls: `stereo-button clickable-icon stereo-rating-summary ${cls}`,
	});
	setIcon(button, "star");
	const value = button.createSpan({ cls: "stereo-rating-value", text: "0" });
	return { button, value };
}

export function syncRatingSummary(
	summary: RatingSummary,
	rating: number
): void {
	const value = Math.max(0, Math.min(5, Math.round(rating)));
	summary.value.setText(String(value));
	summary.button.toggleClass("stereo-button-active", value > 0);
	summary.button.toggleClass("stereo-rating-empty", value === 0);
	const label = value > 0 ? `Rating: ${value} of 5` : "Not rated";
	summary.button.setAttribute("aria-label", label);
	summary.button.setAttribute("title", label);
}

/** Five clickable stars used by lists, the cover overlay and the extras popup. */
export function createStarButtons(
	parent: HTMLElement,
	onSelect: (rating: number) => void
): HTMLButtonElement[] {
	const buttons: HTMLButtonElement[] = [];
	for (let rating = 1; rating <= 5; rating++) {
		const button = parent.createEl("button", {
			cls: "stereo-button clickable-icon stereo-rating-star",
			attr: { "data-rating": String(rating) },
		});
		setIcon(button, "star");
		button.addEventListener("mouseenter", () => {
			if (button.disabled) return;
			parent.dataset.preview = String(rating);
			paintStars(buttons, rating, true);
		});
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (button.disabled) return;
			delete parent.dataset.preview;
			paintStars(buttons, rating, false);
			onSelect(rating);
		});
		buttons.push(button);
	}
	parent.addEventListener("mouseleave", () => {
		delete parent.dataset.preview;
		paintStars(buttons, Number(parent.dataset.rating ?? 0), false);
	});
	return buttons;
}

function paintStars(
	buttons: readonly HTMLButtonElement[],
	count: number,
	preview: boolean
): void {
	buttons.forEach((button, index) => {
		const filled = index < count;
		button.toggleClass("stereo-rating-star-filled", filled);
		button.toggleClass("stereo-rating-star-preview", filled && preview);
	});
}

export function syncStarButtons(
	buttons: readonly HTMLButtonElement[],
	rating: number,
	disabled = false
): void {
	const value = Math.max(0, Math.min(5, Math.round(rating)));
	const parent = buttons[0]?.parentElement;
	if (parent) parent.dataset.rating = String(value);
	const preview = Number(parent?.dataset.preview ?? 0);
	if (preview > 0) paintStars(buttons, preview, true);
	else paintStars(buttons, value, false);
	buttons.forEach((button, index) => {
		const star = index + 1;
		button.disabled = disabled;
		const label = disabled
			? "Rating is unavailable"
			: star === value
				? `Clear rating (${value} of 5)`
				: `Set rating ${star} of 5`;
		button.setAttribute("aria-label", label);
		button.setAttribute("title", label);
	});
}

/** Drop a hover preview, e.g. when its popup is closed from the keyboard. */
export function clearStarPreview(buttons: readonly HTMLButtonElement[]): void {
	const parent = buttons[0]?.parentElement;
	if (parent) delete parent.dataset.preview;
	paintStars(buttons, Number(parent?.dataset.rating ?? 0), false);
}

export function setStarsDisabled(
	buttons: readonly HTMLButtonElement[],
	disabled: boolean
): void {
	for (const button of buttons) button.disabled = disabled;
}

