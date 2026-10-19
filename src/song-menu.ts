import { Menu, Notice } from "obsidian";
import type StereoPlugin from "./main";
import { shareTargetForSong } from "./share";
import type { Song } from "./subsonic";

/** "Add to playlist…" entry used by player and queue menus. */
export function addSongPlaylistItem(
	menu: Menu,
	plugin: StereoPlugin,
	song: Song,
	separator = false
): void {
	if (separator) menu.addSeparator();
	menu.addItem((item) =>
		item
			.setTitle("Add to playlist…")
			.setIcon("list-plus")
			.setDisabled(!!song.streamUrl)
			.onClick(() => {
				void plugin.addToPlaylist([song]);
			})
	);
}

/** Share, browser and clipboard-download entries for one track. */
export function addSongExternalItems(
	menu: Menu,
	plugin: StereoPlugin,
	song: Song
): void {
	if (song.streamUrl) return;
	if (plugin.settings.sharingEnabled) {
		menu.addItem((item) =>
			item
				.setTitle("Share…")
				.setIcon("share-2")
				.onClick(() => {
					plugin.openShare(shareTargetForSong(song));
				})
		);
	}
	const albumId = song.albumId;
	menu.addItem((item) =>
		item
			.setTitle("Open album in Navidrome")
			.setIcon("external-link")
			.setDisabled(!albumId)
			.onClick(() => {
				if (albumId) plugin.openNavidromeAlbum(albumId);
			})
	);
	menu.addItem((item) =>
		item
			.setTitle("Download track to clipboard")
			.setIcon("download")
			.onClick(() => {
				void plugin.downloadTrack(song);
			})
	);
}

/** Copy-track-name entries. The player title menu also includes artist-only. */
export function addSongCopyItems(
	menu: Menu,
	song: Song,
	includeArtist = false
): void {
	const artist = song.artist?.trim() ?? "";
	const title = song.title?.trim() ?? "";
	const album = song.album?.trim() ?? "";
	const entries: { label: string; parts: string[] }[] = [];
	if (includeArtist) {
		entries.push({ label: "Copy artist", parts: [artist] });
	}
	entries.push(
		{ label: "Copy artist - track", parts: [artist, title] },
		{ label: "Copy artist - album - track", parts: [artist, album, title] }
	);
	for (const entry of entries) {
		const text = entry.parts.filter(Boolean).join(" - ");
		const complete = entry.parts.every(Boolean);
		menu.addItem((item) =>
			item
				.setTitle(entry.label)
				.setIcon("copy")
				.setDisabled(!complete)
				.onClick(() => {
					void navigator.clipboard.writeText(text).catch(() => {
						new Notice("Could not copy to the clipboard.");
					});
				})
		);
	}
}

/** Cover-only entry matching the big player's art context menu. */
export function addCopyCoverItem(
	menu: Menu,
	song: Song,
	copyCover: (coverArt: string) => void
): void {
	const coverArt = song.coverArt;
	menu.addItem((item) =>
		item
			.setTitle("Copy cover")
			.setIcon("image")
			.setDisabled(!coverArt)
			.onClick(() => {
				if (coverArt) copyCover(coverArt);
			})
	);
}
