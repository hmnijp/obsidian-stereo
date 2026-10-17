import { Notice, setIcon } from "obsidian";
import type { FavoritesIndex } from "./favorites";
import type { Song } from "./subsonic";

function favoriteLabel(starred: boolean, title: string): string {
	return starred
		? `Remove from favorites: ${title}`
		: `Add to favorites: ${title}`;
}

/**
 * Per-row favorite control. The row click handler must not fire when the heart
 * is pressed, and radio entries have no server-side favorite state.
 */
export function createSongHeart(
	parent: HTMLElement,
	song: Song,
	favorites: FavoritesIndex,
	toggle: (song: Song) => Promise<unknown>
): HTMLButtonElement {
	const button = parent.createEl("button", {
		cls: "stereo-button clickable-icon stereo-heart-button stereo-song-heart",
	});
	button.dataset.songId = song.id;
	button.dataset.songTitle = song.title;
	if (song.streamUrl) button.dataset.radio = "true";
	setIcon(button, "heart");
	favorites.learn(song);
	syncSongHeart(button, favorites);
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (button.disabled) return;
		button.disabled = true;
		void toggle(song)
			.catch(() => {
				new Notice("Could not update favorites on the server.");
			})
			.finally(() => {
				if (button.dataset.radio !== "true") button.disabled = false;
				syncSongHeart(button, favorites);
			});
	});
	return button;
}

/** Refresh one heart from the shared index (used after bulk index changes). */
export function syncSongHeart(
	button: HTMLButtonElement,
	favorites: FavoritesIndex
): void {
	const title = button.dataset.songTitle ?? "";
	if (button.dataset.radio === "true") {
		const label = `Favorites are unavailable for radio: ${title}`;
		button.disabled = true;
		button.toggleClass("stereo-button-active", false);
		button.setAttribute("aria-pressed", "false");
		button.setAttribute("aria-label", label);
		button.setAttribute("title", label);
		return;
	}
	const starred = favorites.isStarredById(button.dataset.songId ?? "");
	const label = favoriteLabel(starred, title);
	button.toggleClass("stereo-button-active", starred);
	button.setAttribute("aria-pressed", String(starred));
	button.setAttribute("aria-label", label);
	button.setAttribute("title", label);
}
