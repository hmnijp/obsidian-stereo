import type { Song } from "./subsonic";

/** Normalize a configured server URL before appending Navidrome web routes. */
export function navidromeBaseUrl(base: string): string {
	return base.trim().replace(/\/+$/, "");
}

/** Navidrome web UI route for an album. */
export function navidromeAlbumUrl(base: string, albumId: string): string {
	const root = navidromeBaseUrl(base);
	if (!root) return "";
	return `${root}/app/#/album/${encodeURIComponent(albumId)}/show`;
}

/** Navidrome web UI route for a playlist. */
export function navidromePlaylistUrl(base: string, playlistId: string): string {
	const root = navidromeBaseUrl(base);
	if (!root) return "";
	return `${root}/app/#/playlist/${encodeURIComponent(playlistId)}/show`;
}

/**
 * Navidrome has no per-song detail route: its song resource is list-only.
 * A track therefore opens the page of the album it belongs to.
 */
export function navidromeTrackUrl(
	base: string,
	song: Pick<Song, "albumId">
): string | null {
	return song.albumId ? navidromeAlbumUrl(base, song.albumId) : null;
}
