import { Notice, setIcon } from "obsidian";
import type { FavoritesIndex } from "./favorites";
import {
	clearStarPreview,
	createStarButtons,
	setStarsDisabled,
	syncStarButtons,
} from "./rating-button";
import type { RatingsIndex } from "./ratings";
import type { Song } from "./subsonic";

/**
 * Combined favorite + rating control for song rows. A plain heart click
 * toggles the favorite; hovering the heart opens the five-star rating picker.
 * The current rating is printed on the heart until it is cleared in the picker.
 */
export function createSongHeart(
	parent: HTMLElement,
	song: Song,
	favorites: FavoritesIndex,
	ratings: RatingsIndex,
	toggleFavorite: (song: Song) => Promise<unknown>,
	toggleRating: (song: Song, rating: number) => Promise<unknown>,
	allowRating: boolean
): HTMLButtonElement {
	const container = parent.createDiv({ cls: "stereo-heart-rating" });
	container.dataset.songId = song.id;
	container.dataset.songTitle = song.title;

	const button = container.createEl("button", {
		cls: "stereo-button clickable-icon stereo-heart-button stereo-song-heart",
		attr: { "aria-label": "Add to favorites", "aria-haspopup": "true" },
	});
	button.dataset.songId = song.id;
	button.dataset.songTitle = song.title;
	setIcon(button, "heart");
	button.createSpan({ cls: "stereo-favorite-value" });

	const picker = container.createDiv({ cls: "stereo-heart-rating-picker" });
	const stars = createStarButtons(picker, (rating) => {
		setStarsDisabled(stars, true);
		void toggleRating(song, rating)
			.catch(() => {
				new Notice("Could not update the rating on the server.");
			})
			.finally(() => {
				setStarsDisabled(stars, false);
				syncSongHeart(button, favorites, ratings, allowRating);
			});
	});
	attachHeartRatingHover(container, button, picker);

	container.addEventListener("click", (event) => event.stopPropagation());
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (button.disabled) return;
		button.disabled = true;
		void toggleFavorite(song)
			.catch(() => {
				new Notice("Could not update favorites on the server.");
			})
			.finally(() => {
				button.disabled = false;
				syncSongHeart(button, favorites, ratings, allowRating);
			});
	});

	favorites.learn(song);
	ratings.learn(song);
	syncSongHeart(button, favorites, ratings, allowRating);
	return button;
}

const HEART_RATING_CLOSE_MS = 250;

/**
 * Hover open/close with a short grace period. The picker floats beside the
 * heart, so moving across the gap must not dismiss it immediately.
 */
export function attachHeartRatingHover(
	container: HTMLElement,
	trigger: HTMLElement,
	picker: HTMLElement
): void {
	let closeTimer: number | null = null;
	const open = (): void => {
		if (closeTimer !== null) {
			window.clearTimeout(closeTimer);
			closeTimer = null;
		}
		container.addClass("stereo-heart-rating-open");
	};
	const scheduleClose = (): void => {
		if (closeTimer !== null) window.clearTimeout(closeTimer);
		closeTimer = window.setTimeout(() => {
			container.removeClass("stereo-heart-rating-open");
			closeTimer = null;
		}, HEART_RATING_CLOSE_MS);
	};
	trigger.addEventListener("mouseenter", open);
	picker.addEventListener("mouseenter", open);
	picker.addEventListener("mouseleave", scheduleClose);
	container.addEventListener("mouseleave", scheduleClose);
	container.addEventListener("focusin", open);
	container.addEventListener("focusout", (event) => {
		const next = event.relatedTarget as Node | null;
		if (next && container.contains(next)) return;
		scheduleClose();
	});
}

export function syncSongHeart(
	button: HTMLButtonElement,
	favorites: FavoritesIndex,
	ratings: RatingsIndex,
	allowRating: boolean
): void {
	const id = button.dataset.songId ?? "";
	const starred = favorites.isStarredById(id);
	const rating = ratings.ratingById(id);
	const container = button.closest<HTMLElement>(".stereo-heart-rating");
	container?.toggleClass("stereo-has-rating", allowRating && rating > 0);

	const value = button.querySelector<HTMLElement>(".stereo-favorite-value");
	if (value) value.setText(allowRating && rating > 0 ? String(rating) : "");

	const favoriteLabel = starred ? "Remove from favorites" : "Add to favorites";
	button.toggleClass("stereo-button-active", starred);
	const ratingLabel = rating > 0 ? `Rating: ${rating} of 5` : "Not rated";
	const label = allowRating
		? `${favoriteLabel}. ${ratingLabel}. Hover for rating.`
		: favoriteLabel;
	button.setAttribute("aria-label", label);
	button.setAttribute("title", label);
	if (allowRating) button.setAttribute("aria-haspopup", "true");
	else button.removeAttribute("aria-haspopup");

	const picker = container?.querySelector<HTMLElement>(".stereo-heart-rating-picker");
	if (!picker) return;
	const stars = Array.from(
		picker.querySelectorAll<HTMLButtonElement>(".stereo-rating-star")
	);
	syncStarButtons(stars, rating, !allowRating);
	if (!allowRating) clearStarPreview(stars);
}
