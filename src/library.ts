import { Component, Menu, Notice, requestUrl, setIcon } from "obsidian";
import type { HistoryEntry } from "./history";
import {
	ConfirmModal,
	PlaylistNameModal,
	RadioStationModal,
} from "./modals";
import { createSongHeart } from "./favorite-button";
import { albumDateValue, albumLabelFor, songMeta } from "./metadata";
import { SubsonicError } from "./subsonic";
import type StereoPlugin from "./main";
import type { AlbumSort, TrackSort } from "./settings";
import type { QueueOrigin } from "./player";
import {
	shareTargetForAlbum,
	shareTargetForArtist,
	shareTargetForPlaylist,
	shareTargetForSong,
} from "./share";
import type {
	Album,
	Artist,
	ArtistIndex,
	Playlist,
	RadioStation,
	Song,
} from "./subsonic";

type SubTab = "albums" | "tracks" | "artists" | "playlists" | "radio";

type Page =
	| { kind: "root" }
	| { kind: "artist"; id: string; name: string }
	| { kind: "album"; id: string; name: string }
	| { kind: "playlist"; id: string; name: string }
	| { kind: "favorites" }
	| { kind: "history" };

const SUB_TABS: { id: SubTab; label: string }[] = [
	{ id: "albums", label: "Albums" },
	{ id: "tracks", label: "Tracks" },
	{ id: "artists", label: "Artists" },
	{ id: "playlists", label: "Playlists" },
	{ id: "radio", label: "Radio" },
];

const ALBUM_PAGE_SIZE = 100;
const ALBUM_FETCH_SIZE = 500;

const ALBUM_SORTS: { value: AlbumSort; label: string }[] = [
	{ value: "alphabeticalByName", label: "Name" },
	{ value: "alphabeticalByArtist", label: "Artist" },
	{ value: "newest", label: "Newest (added)" },
	{ value: "releaseDate", label: "Release date (newest)" },
	{ value: "rating", label: "Rating" },
	{ value: "favorites", label: "Favorites" },
	{ value: "recent", label: "Recently played" },
	{ value: "frequent", label: "Most played" },
	{ value: "random", label: "Random" },
];

const ARTIST_ALBUM_SORTS = ALBUM_SORTS.filter((option) =>
	[
		"alphabeticalByName",
		"alphabeticalByArtist",
		"releaseDate",
		"rating",
		"favorites",
		"random",
	].includes(option.value)
);

function albumSortOf(value: AlbumSort): AlbumSort {
	if ((value as string) === "releaseYear") return "releaseDate";
	return ALBUM_SORTS.some((option) => option.value === value)
		? value
		: "alphabeticalByName";
}

function artistAlbumSortOf(value: AlbumSort): AlbumSort {
	if ((value as string) === "releaseYear") return "releaseDate";
	return ARTIST_ALBUM_SORTS.some((option) => option.value === value)
		? value
		: "releaseDate";
}

const TRACK_PAGE_SIZE = 250;
const TRACK_FETCH_SIZE = 500;

const TRACK_SORTS: { value: TrackSort; label: string }[] = [
	{ value: "title", label: "Title" },
	{ value: "artist", label: "Artist" },
	{ value: "album", label: "Album" },
	{ value: "newest", label: "Newest (added)" },
	{ value: "oldest", label: "Oldest (added)" },
	{ value: "releaseYear", label: "Release year (newest)" },
	{ value: "releaseYearOldest", label: "Release year (oldest)" },
	{ value: "rating", label: "Rating" },
	{ value: "favorites", label: "Favorites" },
	{ value: "plays", label: "Play count" },
	{ value: "random", label: "Random" },
];

function trackSortOf(value: TrackSort): TrackSort {
	return TRACK_SORTS.some((option) => option.value === value)
		? value
		: "title";
}

function sortTracks(tracks: Song[], sort: TrackSort): Song[] {
	const list = [...tracks];
	switch (sort) {
		case "artist":
			return list.sort(
				(first, second) =>
					(first.artist ?? "").localeCompare(second.artist ?? "") ||
					(first.album ?? "").localeCompare(second.album ?? "") ||
					first.title.localeCompare(second.title)
			);
		case "album":
			return list.sort(
				(first, second) =>
					(first.album ?? "").localeCompare(second.album ?? "") ||
					(first.track ?? 0) - (second.track ?? 0) ||
					first.title.localeCompare(second.title)
			);
		case "newest":
			return list.sort(
				(first, second) =>
					createdTimestamp(second.created) -
						createdTimestamp(first.created) ||
					first.title.localeCompare(second.title)
			);
		case "oldest":
			return list.sort(
				(first, second) =>
					createdTimestamp(first.created) -
						createdTimestamp(second.created) ||
					first.title.localeCompare(second.title)
			);
		case "releaseYear":
			return list.sort(
				(first, second) =>
					(second.year ?? 0) - (first.year ?? 0) ||
					(first.album ?? "").localeCompare(second.album ?? "") ||
					(first.track ?? 0) - (second.track ?? 0) ||
					first.title.localeCompare(second.title)
			);
		case "releaseYearOldest":
			return list.sort(
				(first, second) =>
					(first.year ?? 0) - (second.year ?? 0) ||
					(first.album ?? "").localeCompare(second.album ?? "") ||
					(first.track ?? 0) - (second.track ?? 0) ||
					first.title.localeCompare(second.title)
			);
		case "rating":
			return list.sort(
				(first, second) =>
					(second.userRating ?? 0) - (first.userRating ?? 0) ||
					first.title.localeCompare(second.title)
			);
		case "favorites":
			return list.sort(
				(first, second) =>
					(second.starred ? 1 : 0) - (first.starred ? 1 : 0) ||
					first.title.localeCompare(second.title)
			);
		case "plays":
			return list.sort(
				(first, second) =>
					(second.playCount ?? 0) - (first.playCount ?? 0) ||
					first.title.localeCompare(second.title)
			);
		case "random":
			return list.sort(() => Math.random() - 0.5);
		default:
			return list.sort((first, second) =>
				first.title.localeCompare(second.title)
			);
	}
}

function byReleaseDate(first: Album, second: Album): number {
	const firstDate = albumDateValue(first);
	const secondDate = albumDateValue(second);
	if (firstDate !== secondDate) return secondDate - firstDate;
	return first.name.localeCompare(second.name);
}

function sortAlbums(albums: Album[], sort: AlbumSort): Album[] {
	const list = [...albums];
	switch (sort) {
		case "alphabeticalByArtist":
			return list.sort(
				(first, second) =>
					(first.artist ?? "").localeCompare(second.artist ?? "") ||
					first.name.localeCompare(second.name)
			);
		case "releaseDate":
		case "newest":
		case "recent":
		case "frequent":
			return list.sort(byReleaseDate);
		case "rating":
			return list.sort(
				(first, second) =>
					(second.userRating ?? 0) - (first.userRating ?? 0) ||
					first.name.localeCompare(second.name)
			);
		case "favorites":
			return list.sort(
				(first, second) =>
					(second.starred ? 1 : 0) - (first.starred ? 1 : 0) ||
					first.name.localeCompare(second.name)
			);
		case "random":
			return list.sort(() => Math.random() - 0.5);
		default:
			return list.sort((first, second) =>
				first.name.localeCompare(second.name)
			);
	}
}

/**
 * Library tab: sub-tabs (Albums / Artists / Playlists / Radio), drill-in
 * navigation, and context menus. Interaction conventions per PRD §5.1:
 * left-clicking an artist/album/playlist navigates into it; playback is
 * always explicit (play button, track click per setting, or context menu).
 */
export class LibraryPane extends Component {
	private historyButton: HTMLButtonElement;
	private renderedHistory: readonly HistoryEntry[] = [];
	private plugin: StereoPlugin;
	private subTabButtons = {} as Record<SubTab, HTMLButtonElement>;
	/** Album sort picker; shown on the Albums root and artist pages. */
	private albumSortButton!: HTMLButtonElement;
	/** Track sort picker; only shown on the Tracks root. */
	private trackSortButton!: HTMLButtonElement;
	/** "+" in the sub-tab bar; only shown on the Radio sub-tab. */
	private addStationButton!: HTMLButtonElement;
	/** Heart in the sub-tab bar; accent-highlighted while Favorites is open. */
	private favoritesButton!: HTMLButtonElement;
	/** Link icon in the sub-tab bar; opens the share manager. */
	private shareButton!: HTMLButtonElement;
	private bodyEl: HTMLElement;
	private contentEl: HTMLElement;
	/** Alphabet rail overlaying the artists list; exists only on that page. */
	private scrubEl: HTMLElement | null = null;
	private activeSubTab: SubTab = "albums";
	private stack: Page[] = [{ kind: "root" }];
	/** Bumped per render; async loaders bail if a newer render started. */
	private loadToken = 0;

	// Root-list caches so sub-tab flips don't refetch. Refresh clears them.
	private albums: Album[] | null = null;
	private albumsExhausted = false;
	private tracks: Song[] | null = null;
	private tracksVisible = TRACK_PAGE_SIZE;
	private artistIndexes: ArtistIndex[] | null = null;
	private playlists: Playlist[] | null = null;
	private stations: RadioStation[] | null = null;

	constructor(plugin: StereoPlugin, containerEl: HTMLElement) {
		super();
		this.plugin = plugin;

		// The sub-tab bar stays put; only the content below it scrolls.
		const subTabBar = containerEl.createDiv({ cls: "stereo-subtabs" });
		for (const { id, label } of SUB_TABS) {
			const button = subTabBar.createEl("button", {
				cls: "stereo-subtab clickable-icon",
				text: label,
			});
			button.addEventListener("click", () => {
				this.setSubTab(id);
			});
			this.subTabButtons[id] = button;
		}
		this.albumSortButton = subTabBar.createEl("button", {
			cls: "stereo-button clickable-icon stereo-subtab-sort",
			attr: { "aria-label": "Sort albums", title: "Sort albums" },
		});
		setIcon(this.albumSortButton, "arrow-up-down");
		this.registerDomEvent(this.albumSortButton, "click", (event) => {
			this.showAlbumSortMenu(event);
		});
		this.trackSortButton = subTabBar.createEl("button", {
			cls: "stereo-button clickable-icon stereo-subtab-sort",
			attr: { "aria-label": "Sort tracks", title: "Sort tracks" },
		});
		setIcon(this.trackSortButton, "arrow-up-down");
		this.registerDomEvent(this.trackSortButton, "click", (event) => {
			this.showTrackSortMenu(event);
		});
		this.favoritesButton = subTabBar.createEl("button", {
			cls: "stereo-button clickable-icon stereo-subtab-refresh",
			attr: { "aria-label": "Favorites" },
		});
		setIcon(this.favoritesButton, "heart");
		this.favoritesButton.addEventListener("click", () => {
			this.openFavorites();
		});
		this.historyButton = subTabBar.createEl("button", {
			cls: "stereo-button clickable-icon",
			attr: { "aria-label": "Recently played", title: "Recently played" },
		});
		setIcon(this.historyButton, "history");
		this.registerDomEvent(this.historyButton, "click", () => {
			if (this.stack[this.stack.length - 1]?.kind !== "history") this.push({ kind: "history" });
		});
		this.shareButton = subTabBar.createEl("button", {
			cls: "stereo-button clickable-icon",
			attr: { "aria-label": "Share links", title: "Share links" },
		});
		setIcon(this.shareButton, "link");
		this.registerDomEvent(this.shareButton, "click", () => {
			this.plugin.openShares();
		});
		this.addStationButton = subTabBar.createEl("button", {
			cls: "stereo-button clickable-icon stereo-subtab-refresh",
			attr: { "aria-label": "Add radio station" },
		});
		setIcon(this.addStationButton, "plus");
		this.addStationButton.addEventListener("click", () => {
			this.addStation();
		});
		const refreshButton = subTabBar.createEl("button", {
			cls: "stereo-button clickable-icon stereo-subtab-refresh",
			attr: { "aria-label": "Refresh" },
		});
		setIcon(refreshButton, "refresh-cw");
		refreshButton.addEventListener("click", () => {
			this.refresh();
		});

		// The body hosts the scrolling content plus the (non-scrolling) scrub rail.
		this.bodyEl = containerEl.createDiv({ cls: "stereo-library-body" });
		this.contentEl = this.bodyEl.createDiv({ cls: "stereo-library-content" });
		this.register(this.plugin.player.history.subscribe(() => this.refreshHistoryPage()));
		let previousError: string | null = null;
		this.register(this.plugin.player.subscribe((state) => {
			if (state.error === previousError) return;
			previousError = state.error;
			this.refreshHistoryPage();
		}));
		this.registerDomEvent(this.contentEl, "click", (event) => {
			const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-history-action]");
			if (!button) return;
			if (button.dataset.historyAction === "clear") { this.plugin.player.history.clear(); return; }
			const entry = this.renderedHistory[Number(button.dataset.historyIndex)];
			if (entry) void this.plugin.player.playHistoryEntry(entry, button.dataset.historyAction === "append");
		});
		this.registerDomEvent(this.contentEl, "contextmenu", (event) => {
			const row = (event.target as HTMLElement).closest<HTMLElement>(".stereo-history-row");
			if (!row) return;
			event.preventDefault();
			const entry = this.renderedHistory[Number(row.dataset.historyIndex)];
			if (!entry) return;
			const menu = new Menu();
			menu.addItem((item) => item.setTitle("Play again").setIcon("play").onClick(() => { void this.plugin.player.playHistoryEntry(entry); }));
			menu.addItem((item) => item.setTitle("Add to queue").setIcon("list-plus").onClick(() => { void this.plugin.player.playHistoryEntry(entry, true); }));
			const song = entry.song;
			if (!song.streamUrl) {
				const albumId = song.albumId;
				menu.addSeparator();
				menu.addItem((item) =>
					item
						.setTitle("Open album in Navidrome")
						.setIcon("external-link")
						.setDisabled(!albumId)
						.onClick(() => {
							if (albumId) this.plugin.openNavidromeAlbum(albumId);
						})
				);
				menu.addItem((item) =>
					item
						.setTitle("Download track to clipboard")
						.setIcon("download")
						.onClick(() => {
							void this.plugin.downloadTrack(song);
						})
				);
			}
			menu.showAtMouseEvent(event);
		});
		this.registerDomEvent(this.contentEl, "error", (event) => {
			const target = event.target as HTMLElement;
			if (target.matches(".stereo-history-cover img")) target.remove();
		}, true);
		this.render();
	}

	// --- external navigation (Now Playing links, context menus) ---

	openArtist(id: string, name: string): void {
		this.activeSubTab = "artists";
		this.stack = [{ kind: "root" }, { kind: "artist", id, name }];
		this.render();
	}

	openAlbum(id: string, name: string): void {
		this.activeSubTab = "albums";
		this.stack = [{ kind: "root" }, { kind: "album", id, name }];
		this.render();
	}

	/** Drop the cached playlist list (e.g. after saving the queue as one). */
	invalidatePlaylists(): void {
		this.playlists = null;
		const page = this.stack[this.stack.length - 1];
		if (this.activeSubTab === "playlists" && page?.kind === "root") {
			this.render();
		}
	}

	/** Drop cached lists and rebuild after switching servers. */
	reload(): void {
		this.albums = null;
		this.albumsExhausted = false;
		this.tracks = null;
		this.tracksVisible = TRACK_PAGE_SIZE;
		this.artistIndexes = null;
		this.playlists = null;
		this.stations = null;
		this.stack = [{ kind: "root" }];
		this.render();
	}

	/** Show or hide share-related controls without rebuilding the pane. */
	setSharingEnabled(enabled: boolean): void {
		this.shareButton.toggleClass("stereo-hidden", !enabled);
		this.contentEl
			.querySelectorAll<HTMLElement>(".stereo-share-detail")
			.forEach((button) => {
				button.toggleClass("stereo-hidden", !enabled);
			});
	}

	// --- navigation internals ---

	private setSubTab(tab: SubTab): void {
		this.activeSubTab = tab;
		this.stack = [{ kind: "root" }];
		this.render();
	}

	private push(page: Page): void {
		this.stack.push(page);
		this.render();
	}

	private back(): void {
		if (this.stack.length > 1) this.stack.pop();
		this.render();
	}

	private refresh(): void {
		switch (this.activeSubTab) {
			case "albums":
				this.albums = null;
				this.albumsExhausted = false;
				break;
			case "tracks":
				this.tracks = null;
				this.tracksVisible = TRACK_PAGE_SIZE;
				break;
			case "artists":
				this.artistIndexes = null;
				break;
			case "playlists":
				this.playlists = null;
				break;
			case "radio":
				this.stations = null;
				break;
		}
		this.render();
	}

	private showAlbumSortMenu(event: MouseEvent): void {
		const page = this.stack[this.stack.length - 1];
		const artistPage = page?.kind === "artist";
		const options = artistPage ? ARTIST_ALBUM_SORTS : ALBUM_SORTS;
		const current = artistPage
			? artistAlbumSortOf(this.plugin.settings.artistAlbumSort)
			: albumSortOf(this.plugin.settings.albumSort);
		const menu = new Menu();
		for (const option of options) {
			menu.addItem((item) =>
				item
					.setTitle(option.label)
					.setChecked(option.value === current)
					.onClick(() => {
						if (artistPage) void this.setArtistAlbumSort(option.value);
						else void this.setAlbumSort(option.value);
					})
			);
		}
		menu.showAtMouseEvent(event);
	}

	private async setAlbumSort(value: AlbumSort): Promise<void> {
		if (albumSortOf(this.plugin.settings.albumSort) === value) return;
		this.plugin.settings.albumSort = value;
		await this.plugin.saveSettings();
		this.albums = null;
		this.albumsExhausted = false;
		const page = this.stack[this.stack.length - 1];
		if (this.activeSubTab === "albums" && page?.kind === "root") {
			this.render();
		}
	}

	private async setArtistAlbumSort(value: AlbumSort): Promise<void> {
		if (artistAlbumSortOf(this.plugin.settings.artistAlbumSort) === value) {
			return;
		}
		this.plugin.settings.artistAlbumSort = value;
		await this.plugin.saveSettings();
		if (this.stack[this.stack.length - 1]?.kind === "artist") {
			this.render();
		}
	}

	private showTrackSortMenu(event: MouseEvent): void {
		const current = trackSortOf(this.plugin.settings.trackSort);
		const menu = new Menu();
		for (const option of TRACK_SORTS) {
			menu.addItem((item) =>
				item
					.setTitle(option.label)
					.setChecked(option.value === current)
					.onClick(() => {
						void this.setTrackSort(option.value);
					})
			);
		}
		menu.showAtMouseEvent(event);
	}

	private async setTrackSort(value: TrackSort): Promise<void> {
		if (trackSortOf(this.plugin.settings.trackSort) === value) return;
		this.plugin.settings.trackSort = value;
		await this.plugin.saveSettings();
		this.tracksVisible = TRACK_PAGE_SIZE;
		if (this.activeSubTab === "tracks") this.render();
	}

	// --- rendering ---

	private render(): void {
		this.loadToken += 1;
		const page = this.stack[this.stack.length - 1] ?? { kind: "root" as const };
		const sortableAlbums =
			(this.activeSubTab === "albums" && page.kind === "root") ||
			page.kind === "artist";
		this.albumSortButton.toggleClass(
			"stereo-hidden",
			!sortableAlbums
		);
		const artistPage = page.kind === "artist";
		const sortOptions = artistPage ? ARTIST_ALBUM_SORTS : ALBUM_SORTS;
		const currentSort = artistPage
			? artistAlbumSortOf(this.plugin.settings.artistAlbumSort)
			: albumSortOf(this.plugin.settings.albumSort);
		const sortLabel =
			sortOptions.find((option) => option.value === currentSort)?.label ??
			"Name";
		this.albumSortButton.setAttribute(
			"aria-label",
			`Sort albums: ${sortLabel}`
		);
		this.albumSortButton.setAttribute("title", `Sort albums: ${sortLabel}`);
		const tracksRoot =
			this.activeSubTab === "tracks" && page.kind === "root";
		this.trackSortButton.toggleClass("stereo-hidden", !tracksRoot);
		const trackSortLabel =
			TRACK_SORTS.find(
				(option) =>
					option.value === trackSortOf(this.plugin.settings.trackSort)
			)?.label ?? "Title";
		this.trackSortButton.setAttribute(
			"aria-label",
			`Sort tracks: ${trackSortLabel}`
		);
		this.trackSortButton.setAttribute("title", `Sort tracks: ${trackSortLabel}`);
		for (const { id } of SUB_TABS) {
			this.subTabButtons[id].toggleClass(
				"stereo-subtab-active",
				id === this.activeSubTab
			);
		}
		this.addStationButton.toggleClass(
			"stereo-hidden",
			this.activeSubTab !== "radio"
		);
		this.shareButton.toggleClass(
			"stereo-hidden",
			!this.plugin.settings.sharingEnabled
		);
		this.scrubEl?.remove();
		this.scrubEl = null;
		this.contentEl.removeClass("stereo-has-scrub");
		this.contentEl.empty();
		this.contentEl.scrollTop = 0;

		this.favoritesButton.toggleClass(
			"stereo-button-active",
			page.kind === "favorites"
		);
		this.historyButton.toggleClass("stereo-button-active", page.kind === "history");
		this.historyButton.setAttribute("aria-pressed", String(page.kind === "history"));
		if (page.kind !== "root") this.buildBackRow(this.pageTitle(page));

		switch (page.kind) {
			case "root":
				this.renderRoot();
				break;
			case "artist":
				void this.renderArtistPage(page.id);
				break;
			case "album":
				void this.renderAlbumPage(page.id);
				break;
			case "playlist":
				void this.renderPlaylistPage(page.id);
				break;
			case "favorites":
				void this.renderFavoritesPage();
				break;
			case "history":
				this.renderHistoryPage();
				break;
		}
	}

	/** Heart in the sub-tab bar: one page for all favorites, every kind. */
	private openFavorites(): void {
		const top = this.stack[this.stack.length - 1];
		// Already there — re-render so the list reflects fresh toggles.
		if (top?.kind === "favorites") {
			this.render();
			return;
		}
		this.push({ kind: "favorites" });
	}

	/** Remove an unstarred row immediately while the Favorites page is open. */
	refreshFavoritesIfOpen(): void {
		if (this.stack[this.stack.length - 1]?.kind !== "favorites") return;
		this.render();
	}

	private pageTitle(page: Page): string {
		if (page.kind === "root") return "";
		if (page.kind === "favorites") return "Favorites";
		if (page.kind === "history") return "Recently played";
		return page.name;
	}

	/** Re-render the history page in place, keeping the scroll position. */
	private refreshHistoryPage(): void {
		if (this.stack[this.stack.length - 1]?.kind !== "history") return;
		const scroll = this.contentEl.scrollTop;
		this.render();
		this.contentEl.scrollTop = scroll;
	}

	private renderHistoryPage(): void {
		this.renderedHistory = this.plugin.player.history.getEntries();
		const clear = this.contentEl.createEl("button", {
			text: "Clear history", cls: "stereo-history-clear",
			attr: { "data-history-action": "clear" },
		});
		clear.disabled = this.renderedHistory.length === 0;
		const error = this.plugin.player.getState().error;
		if (error) this.contentEl.createDiv({ cls: "stereo-error stereo-error-visible", text: error, attr: { role: "alert" } });
		if (this.renderedHistory.length === 0) {
			this.emptyStatus("No recently played tracks. Songs appear here when playback starts.");
			return;
		}
		this.renderedHistory.forEach((entry, index) => {
			const { song, playedAt } = entry;
			const row = this.contentEl.createDiv({ cls: "stereo-list-row stereo-history-row", attr: { "data-history-index": String(index) } });
			const cover = row.createDiv({ cls: "stereo-history-cover" });
			setIcon(cover, "music");
			if (song.coverArt) {
				try {
					cover.createEl("img", { attr: { src: this.plugin.client.coverArtUrl(song.coverArt, 100), alt: "", loading: "lazy" } });
				} catch { /* The music placeholder remains when connection settings are incomplete. */ }
			}
			const meta = row.createDiv({ cls: "stereo-list-row-meta" });
			meta.createDiv({ cls: "stereo-list-row-title", text: song.title });
			meta.createDiv({ cls: "stereo-list-row-sub", text: songMeta(song) });
			const date = new Date(playedAt);
			const metaLine = meta.createDiv({ cls: "stereo-history-meta-line" });
			this.songHeart(metaLine, song);
			metaLine.createEl("time", {
				cls: "stereo-list-row-sub", text: date.toLocaleString(),
				attr: { datetime: date.toISOString() },
			});
			for (const [action, label, icon] of [["play", "Play again", "play"], ["append", "Add to queue", "list-plus"]]) {
				const button = row.createEl("button", {
					cls: "stereo-button clickable-icon",
					attr: { "data-history-action": action!, "data-history-index": String(index), "aria-label": `${label}: ${song.title}`, title: label! },
				});
				setIcon(button, icon!);
			}
		});
	}

	private buildBackRow(title: string): void {
		const row = this.contentEl.createDiv({ cls: "stereo-back-row" });
		const backButton = row.createEl("button", {
			cls: "stereo-button clickable-icon",
			attr: { "aria-label": "Back" },
		});
		setIcon(backButton, "chevron-left");
		backButton.addEventListener("click", () => {
			this.back();
		});
		row.createSpan({ cls: "stereo-back-title", text: title });
	}

	private renderRoot(): void {
		switch (this.activeSubTab) {
			case "albums":
				void this.renderAlbumsRoot();
				break;
			case "tracks":
				void this.renderTracksRoot();
				break;
			case "artists":
				void this.renderArtistsRoot();
				break;
			case "playlists":
				void this.renderPlaylistsRoot();
				break;
			case "radio":
				void this.renderRadioRoot();
				break;
		}
	}

	/** Run a loader with loading/error affordances; returns null when stale. */
	private async loadPage<T>(fetcher: () => Promise<T>): Promise<T | null> {
		const token = this.loadToken;
		const loadingEl = this.contentEl.createDiv({
			cls: "stereo-library-status",
			text: "Loading…",
		});
		try {
			const result = await fetcher();
			if (token !== this.loadToken) return null;
			loadingEl.remove();
			return result;
		} catch {
			if (token !== this.loadToken) return null;
			loadingEl.remove();
			const errorEl = this.contentEl.createDiv({ cls: "stereo-library-status" });
			errorEl.createSpan({ text: "Could not load from the server. " });
			const retry = errorEl.createEl("a", { text: "Retry" });
			retry.addEventListener("click", () => {
				this.render();
			});
			return null;
		}
	}

	// --- root lists ---

	/** Client-side album sorts need the whole collection, not just one page. */
	private async loadAllAlbums(): Promise<Album[] | null> {
		const token = this.loadToken;
		const loadingEl = this.contentEl.createDiv({
			cls: "stereo-library-status",
			text: "Loading all albums…",
		});
		try {
			const all: Album[] = [];
			let offset = 0;
			while (true) {
				const page = await this.plugin.client.getAlbumList2(
					"alphabeticalByName",
					ALBUM_FETCH_SIZE,
					offset
				);
				if (token !== this.loadToken) {
					loadingEl.remove();
					return null;
				}
				all.push(...page);
				if (page.length === 0) break;
				offset += page.length;
			}
			loadingEl.remove();
			return all;
		} catch {
			if (token !== this.loadToken) return null;
			loadingEl.remove();
			const errorEl = this.contentEl.createDiv({
				cls: "stereo-library-status",
			});
			errorEl.createSpan({ text: "Could not load albums. " });
			const retry = errorEl.createEl("a", { text: "Retry" });
			retry.addEventListener("click", () => {
				this.render();
			});
			return null;
		}
	}

	private async loadAllTracks(): Promise<Song[] | null> {
		const token = this.loadToken;
		const loadingEl = this.contentEl.createDiv({
			cls: "stereo-library-status",
			text: "Loading all tracks…",
		});
		try {
			const all: Song[] = [];
			let offset = 0;
			while (true) {
				const result = await this.plugin.client.search3(
					"",
					{ artistCount: 0, albumCount: 0, songCount: TRACK_FETCH_SIZE },
					{ songOffset: offset }
				);
				if (token !== this.loadToken) {
					loadingEl.remove();
					return null;
				}
				all.push(...result.songs);
				if (result.songs.length === 0) break;
				offset += result.songs.length;
			}
			loadingEl.remove();
			return all;
		} catch {
			if (token !== this.loadToken) return null;
			loadingEl.remove();
			const errorEl = this.contentEl.createDiv({
				cls: "stereo-library-status",
			});
			errorEl.createSpan({ text: "Could not load tracks. " });
			const retry = errorEl.createEl("a", { text: "Retry" });
			retry.addEventListener("click", () => {
				this.render();
			});
			return null;
		}
	}

	private async renderTracksRoot(): Promise<void> {
		if (!this.tracks) {
			const all = await this.loadAllTracks();
			if (!all) return;
			this.tracks = all;
			this.tracksVisible = TRACK_PAGE_SIZE;
		}
		if (this.tracks.length === 0) {
			this.emptyStatus("No tracks found.");
			return;
		}
		const songs = sortTracks(
			this.tracks,
			trackSortOf(this.plugin.settings.trackSort)
		);
		const visible = songs.slice(
			0,
			Math.min(this.tracksVisible, songs.length)
		);
		const list = this.contentEl.createDiv({ cls: "stereo-track-list" });
		visible.forEach((_, index) => {
			this.trackRow(list, songs, index, {
				showNumber: false,
				showPlayCount: true,
			});
		});

		if (this.tracksVisible < songs.length) {
			const moreRow = this.contentEl.createDiv({ cls: "stereo-more-row" });
			const moreButton = moreRow.createEl("button", {
				cls: "stereo-button stereo-text-button clickable-icon",
				text: "Load more",
			});
			moreButton.addEventListener("click", () => {
				this.tracksVisible += TRACK_PAGE_SIZE;
				const scroll = this.contentEl.scrollTop;
				this.render();
				this.contentEl.scrollTop = scroll;
			});
		}
	}

	private async renderAlbumsRoot(): Promise<void> {
		const sort = albumSortOf(this.plugin.settings.albumSort);
		const clientSort =
			sort === "releaseDate" || sort === "rating" || sort === "favorites";
		const serverSort = clientSort ? null : sort;
		if (!this.albums) {
			if (!serverSort) {
				const all = await this.loadAllAlbums();
				if (!all) return;
				this.albums = sortAlbums(all, sort);
				this.albumsExhausted = true;
			} else {
				const page = await this.loadPage(() =>
					this.plugin.client.getAlbumList2(
						serverSort,
						ALBUM_PAGE_SIZE,
						0
					)
				);
				if (!page) return;
				this.albums = page;
				this.albumsExhausted = page.length < ALBUM_PAGE_SIZE;
			}
		}

		const grid = this.contentEl.createDiv({ cls: "stereo-grid" });
		for (const album of this.albums) this.albumCard(grid, album);

		if (!this.albumsExhausted && serverSort) {
			const moreRow = this.contentEl.createDiv({ cls: "stereo-more-row" });
			const moreButton = moreRow.createEl("button", {
				cls: "stereo-button stereo-text-button clickable-icon",
				text: "Load more",
			});
			const loadMore = async (): Promise<void> => {
				if (!serverSort) return;
				moreButton.disabled = true;
				const token = this.loadToken;
				try {
					const next = await this.plugin.client.getAlbumList2(
						serverSort,
						ALBUM_PAGE_SIZE,
						this.albums?.length ?? 0
					);
					if (token !== this.loadToken || !this.albums) return;
					this.albums = [...this.albums, ...next];
					this.albumsExhausted = next.length < ALBUM_PAGE_SIZE;
					const scroll = this.contentEl.scrollTop;
					this.render();
					this.contentEl.scrollTop = scroll;
				} catch {
					if (token !== this.loadToken) return;
					moreButton.disabled = false;
					new Notice("Could not load more albums.");
				}
			};
			moreButton.addEventListener("click", () => {
				void loadMore();
			});
		}
	}

	private async renderArtistsRoot(): Promise<void> {
		if (!this.artistIndexes) {
			const indexes = await this.loadPage(() => this.plugin.client.getArtists());
			if (!indexes) return;
			this.artistIndexes = indexes;
		}

		if (this.artistIndexes.length === 0) {
			this.emptyStatus("No artists found.");
			return;
		}
		const headings = new Map<string, HTMLElement>();
		for (const group of this.artistIndexes) {
			const heading = this.contentEl.createDiv({
				cls: "stereo-index-letter",
				text: group.name,
			});
			headings.set(group.name, heading);
			for (const artist of group.artist) this.artistRow(artist);
		}
		this.buildScrubber(
			this.artistIndexes.map((group) => group.name),
			headings
		);
	}

	/**
	 * Alphabet rail on the right edge of the artists list. Works like a
	 * scrollbar: click or drag along it and the list jumps to that letter; the
	 * letter under the pointer grows slightly while scrubbing.
	 */
	private buildScrubber(letters: string[], headings: Map<string, HTMLElement>): void {
		if (letters.length < 2) return;
		this.contentEl.addClass("stereo-has-scrub");
		const rail = this.bodyEl.createDiv({ cls: "stereo-scrub" });
		this.scrubEl = rail;
		// Multi-character group names (e.g. "[Unknown]") get a compact glyph.
		const letterEls = letters.map((letter) =>
			rail.createDiv({
				cls: "stereo-scrub-letter",
				text: letter.length === 1 ? letter : "•",
			})
		);

		const clearActive = () => {
			for (const el of letterEls) el.removeClass("stereo-scrub-letter-active");
		};
		const scrubTo = (clientY: number) => {
			// Hit-test the letter glyphs themselves. The letters are centered
			// inside the rail, so mapping the pointer as a fraction of the rail's
			// height picks the wrong letter — the glyph under the cursor is the
			// only measurement that is always aligned with what the user sees.
			let index = -1;
			let bestDistance = Number.POSITIVE_INFINITY;
			letterEls.forEach((el, i) => {
				const rect = el.getBoundingClientRect();
				const distance =
					clientY < rect.top
						? rect.top - clientY
						: clientY > rect.bottom
							? clientY - rect.bottom
							: 0;
				if (distance < bestDistance) {
					bestDistance = distance;
					index = i;
				}
			});
			if (index < 0) return;
			letterEls.forEach((el, i) => {
				el.toggleClass("stereo-scrub-letter-active", i === index);
			});
			const heading = headings.get(letters[index] as string);
			if (heading) this.contentEl.scrollTop = heading.offsetTop;
		};

		rail.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			try {
				rail.setPointerCapture(event.pointerId);
			} catch {
				// Capture is best-effort; scrubbing still works without it.
			}
			scrubTo(event.clientY);
		});
		rail.addEventListener("pointermove", (event) => {
			if (event.buttons === 0) return;
			scrubTo(event.clientY);
		});
		rail.addEventListener("pointerup", clearActive);
		rail.addEventListener("pointercancel", clearActive);
	}

	private async renderPlaylistsRoot(): Promise<void> {
		if (!this.playlists) {
			const playlists = await this.loadPage(() => this.plugin.client.getPlaylists());
			if (!playlists) return;
			this.playlists = playlists;
		}

		if (this.playlists.length === 0) {
			this.emptyStatus("No playlists yet.");
			return;
		}
		for (const playlist of this.playlists) this.playlistRow(playlist);
	}

	private async renderRadioRoot(): Promise<void> {
		if (!this.stations) {
			const stations = await this.loadPage(() =>
				this.plugin.client.getInternetRadioStations()
			);
			if (!stations) return;
			this.stations = stations;
		}

		if (this.stations.length === 0) {
			this.emptyStatus("No radio stations yet — add one with the + button above.");
			return;
		}
		for (const station of this.stations) this.radioRow(station);
	}

	/** All favorites on one page: artists, then albums, then tracks. */
	private async renderFavoritesPage(): Promise<void> {
		const result = await this.loadPage(() => this.plugin.client.getStarred2());
		if (!result) return;
		const { artists, albums, songs } = result;
		this.plugin.favorites.learnSongs(songs);
		this.plugin.ratings.learnSongs(songs);

		if (artists.length === 0 && albums.length === 0 && songs.length === 0) {
			this.emptyStatus(
				"No favorites yet — use the heart on tracks, albums, and artists."
			);
			return;
		}

		if (artists.length > 0) {
			this.sectionHeading("Artists");
			for (const artist of artists) this.artistRow(artist);
		}
		if (albums.length > 0) {
			this.sectionHeading("Albums");
			const grid = this.contentEl.createDiv({ cls: "stereo-grid" });
			for (const album of albums) this.albumCard(grid, album);
		}
		if (songs.length > 0) {
			this.sectionHeading("Tracks");
			const list = this.contentEl.createDiv({ cls: "stereo-track-list" });
			songs.forEach((_, i) => {
				this.trackRow(list, songs, i, { showNumber: false });
			});
		}
	}

	private sectionHeading(text: string): void {
		this.contentEl.createDiv({ cls: "stereo-section-heading", text });
	}

	// --- detail pages ---

	private async renderArtistPage(id: string): Promise<void> {
		const result = await this.loadPage(() => this.plugin.client.getArtist(id));
		if (!result) return;

		const header = this.contentEl.createDiv({ cls: "stereo-detail-header" });
		header.createDiv({ cls: "stereo-detail-title", text: result.artist.name });
		header.createDiv({
			cls: "stereo-detail-meta",
			text: albumCountLabel(result.albums.length),
		});
		const actions = header.createDiv({ cls: "stereo-detail-actions" });
		this.heartButton(
			actions,
			() => !!result.artist.starred,
			() => this.toggleArtistFavorite(result.artist)
		);
		this.shareActionIcon(actions, "Share artist", () => {
			this.plugin.openShare(shareTargetForArtist(result.artist));
		});

		const grid = this.contentEl.createDiv({ cls: "stereo-grid" });
		const sort = artistAlbumSortOf(this.plugin.settings.artistAlbumSort);
		for (const album of sortAlbums(result.albums, sort)) {
			this.albumCard(grid, album);
		}
	}

	private async renderAlbumPage(id: string): Promise<void> {
		const result = await this.loadPage(() => this.plugin.client.getAlbum(id));
		if (!result) return;
		const { album, songs } = result;

		const header = this.contentEl.createDiv({ cls: "stereo-detail-header" });
		if (album.coverArt) {
			header.createEl("img", {
				cls: "stereo-detail-cover",
				attr: {
					src: this.plugin.client.coverArtUrl(album.coverArt, 300),
					alt: "Album cover",
				},
			});
		}
		const headerText = header.createDiv({ cls: "stereo-detail-text" });
		headerText.createDiv({
			cls: "stereo-detail-title",
			text: albumLabelFor(album),
		});
		const artistLine = headerText.createDiv({
			cls: "stereo-detail-meta",
			text: album.artist?.trim() || "Unknown artist",
		});
		if (album.artistId) {
			artistLine.addClass("stereo-link");
			artistLine.addEventListener("click", () => {
				this.openArtist(album.artistId as string, album.artist ?? "");
			});
		}
		headerText.createDiv({
			cls: "stereo-detail-meta",
			text: songCountLabel(songs.length),
		});

		const playRow = headerText.createDiv({ cls: "stereo-detail-actions" });
		this.actionIcon(playRow, "play", "Play album", () => {
			void this.plugin.player.setQueue(songs, 0, {
				kind: "album",
				id: album.id,
				name: album.name,
				artist: album.artist,
			});
		});
		this.heartButton(
			playRow,
			() => !!album.starred,
			() => this.toggleAlbumFavorite(album)
		);
		this.shareActionIcon(playRow, "Share album", () => {
			this.plugin.openShare(shareTargetForAlbum(album));
		});

		const list = this.contentEl.createDiv({ cls: "stereo-track-list" });
		songs.forEach((song, i) => {
			this.trackRow(list, songs, i, {
				showNumber: true,
				origin: {
					kind: "album",
					id: album.id,
					name: album.name,
					artist: album.artist,
				},
			});
		});
	}

	private async renderPlaylistPage(id: string): Promise<void> {
		const result = await this.loadPage(() => this.plugin.client.getPlaylist(id));
		if (!result) return;
		const { playlist, songs } = result;

		const header = this.contentEl.createDiv({ cls: "stereo-detail-header" });
		const headerText = header.createDiv({ cls: "stereo-detail-text" });
		headerText.createDiv({ cls: "stereo-detail-title", text: playlist.name });
		headerText.createDiv({
			cls: "stereo-detail-meta",
			text: songCountLabel(songs.length),
		});
		const playRow = headerText.createDiv({ cls: "stereo-detail-actions" });
		this.actionIcon(playRow, "play", "Play playlist", () => {
			void this.plugin.player.setQueue(songs, 0, {
				kind: "playlist",
				id: playlist.id,
				name: playlist.name,
				songCount: songs.length,
			});
		});
		this.shareActionIcon(playRow, "Share playlist", () => {
			this.plugin.openShare(shareTargetForPlaylist(playlist));
		});

		if (songs.length === 0) {
			this.emptyStatus("This playlist is empty.");
			return;
		}
		const list = this.contentEl.createDiv({ cls: "stereo-track-list" });
		songs.forEach((song, i) => {
			this.trackRow(list, songs, i, {
				showNumber: false,
				origin: {
					kind: "playlist",
					id: playlist.id,
					name: playlist.name,
					songCount: songs.length,
				},
				removeFromPlaylist: (index) => {
					void this.managePlaylist("Removed from playlist.", () =>
						this.plugin.client.updatePlaylist(playlist.id, {
							removeIndexes: [index],
						})
					).then((ok) => {
						// Rebuild the page so row indexes match the server again.
						if (ok) this.render();
					});
				},
			});
		});
	}

	// --- favorites plumbing (shared by detail-page hearts and context menus) ---

	private actionIcon(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void
	): HTMLButtonElement {
		const button = parent.createEl("button", {
			cls: "stereo-button clickable-icon",
			attr: { "aria-label": label, title: label },
		});
		setIcon(button, icon);
		button.addEventListener("click", onClick);
		return button;
	}

	private shareActionIcon(
		parent: HTMLElement,
		label: string,
		onClick: () => void
	): HTMLButtonElement {
		const button = this.actionIcon(parent, "share-2", label, onClick);
		button.addClass("stereo-share-detail");
		button.toggleClass(
			"stereo-hidden",
			!this.plugin.settings.sharingEnabled
		);
		return button;
	}

	/** Row-level favorite + rating control backed by the shared session indices. */
	private songHeart(parent: HTMLElement, song: Song): void {
		createSongHeart(
			parent,
			song,
			this.plugin.favorites,
			this.plugin.ratings,
			(target) => this.plugin.toggleSongFavorite(target),
			(target, rating) => this.plugin.toggleSongRating(target, rating),
			this.plugin.settings.showRating
		);
	}

	/** Heart toggle for detail-page headers; keeps its own filled state fresh. */
	private heartButton(
		parent: HTMLElement,
		isStarred: () => boolean,
		toggle: () => Promise<void>
	): void {
		const button = parent.createEl("button", {
			cls: "stereo-button clickable-icon stereo-heart-button",
		});
		setIcon(button, "heart");
		const sync = () => {
			button.toggleClass("stereo-button-active", isStarred());
			button.setAttribute(
				"aria-label",
				isStarred() ? "Remove from favorites" : "Add to favorites"
			);
		};
		sync();
		button.addEventListener("click", () => {
			void toggle()
				.catch(() => {
					new Notice("Could not update favorites on the server.");
				})
				.finally(() => {
					sync();
				});
		});
	}

	private async toggleAlbumFavorite(album: Album): Promise<void> {
		if (album.starred) {
			await this.plugin.client.unstar({ albumId: album.id });
			album.starred = undefined;
		} else {
			await this.plugin.client.star({ albumId: album.id });
			album.starred = new Date().toISOString();
		}
	}

	private async toggleArtistFavorite(artist: Artist): Promise<void> {
		if (artist.starred) {
			await this.plugin.client.unstar({ artistId: artist.id });
			artist.starred = undefined;
		} else {
			await this.plugin.client.star({ artistId: artist.id });
			artist.starred = new Date().toISOString();
		}
	}

	// --- row/card builders ---

	private albumCard(grid: HTMLElement, album: Album): void {
		const card = grid.createDiv({ cls: "stereo-card" });
		if (album.coverArt) {
			card.createEl("img", {
				cls: "stereo-card-cover",
				attr: {
					src: this.plugin.client.coverArtUrl(album.coverArt, 300),
					alt: "",
					loading: "lazy",
				},
			});
		} else {
			const placeholder = card.createDiv({ cls: "stereo-card-cover stereo-card-cover-empty" });
			setIcon(placeholder, "music");
		}
		card.createDiv({
			cls: "stereo-card-title",
			text: albumLabelFor(album),
		});
		card.createDiv({
			cls: "stereo-card-artist",
			text: album.artist?.trim() || "Unknown artist",
		});

		card.addEventListener("click", () => {
			this.push({ kind: "album", id: album.id, name: album.name });
		});
		card.addEventListener("contextmenu", (event) => {
			this.showAlbumMenu(event, album);
		});
	}

	private artistRow(artist: Artist): void {
		const row = this.contentEl.createDiv({ cls: "stereo-list-row" });
		const meta = row.createDiv({ cls: "stereo-list-row-meta" });
		meta.createDiv({ cls: "stereo-list-row-title", text: artist.name });
		meta.createDiv({
			cls: "stereo-list-row-sub",
			text: albumCountLabel(artist.albumCount ?? 0),
		});
		row.addEventListener("click", () => {
			this.push({ kind: "artist", id: artist.id, name: artist.name });
		});
		row.addEventListener("contextmenu", (event) => {
			this.showArtistMenu(event, artist);
		});
	}

	private playlistRow(playlist: Playlist): void {
		const row = this.contentEl.createDiv({ cls: "stereo-list-row" });
		const meta = row.createDiv({ cls: "stereo-list-row-meta" });
		meta.createDiv({ cls: "stereo-list-row-title", text: playlist.name });
		meta.createDiv({
			cls: "stereo-list-row-sub",
			text: songCountLabel(playlist.songCount ?? 0),
		});
		row.addEventListener("click", () => {
			this.push({ kind: "playlist", id: playlist.id, name: playlist.name });
		});
		row.addEventListener("contextmenu", (event) => {
			this.showPlaylistMenu(event, playlist);
		});
	}

	private radioRow(station: RadioStation): void {
		const row = this.contentEl.createDiv({ cls: "stereo-list-row" });
		const icon = row.createSpan({ cls: "stereo-list-row-icon" });
		setIcon(icon, "radio");
		const meta = row.createDiv({ cls: "stereo-list-row-meta" });
		meta.createDiv({ cls: "stereo-list-row-title", text: station.name });
		// Radio is click-to-play (PRD §5.4) — a station has nothing to drill into.
		row.addEventListener("click", () => {
			void this.playStation(station);
		});
		row.addEventListener("contextmenu", (event) => {
			this.showRadioMenu(event, station);
		});
	}

	private trackRow(
		list: HTMLElement,
		songs: Song[],
		index: number,
		options: {
			showNumber: boolean;
			showPlayCount?: boolean;
			/** Album/playlist this row belongs to, when the queue is replaced. */
			origin?: QueueOrigin;
			/** Present on playlist pages: removes this row from the playlist. */
			removeFromPlaylist?: (index: number) => void;
		}
	): void {
		const song = songs[index] as Song;
		const row = list.createDiv({ cls: "stereo-list-row" });
		if (options.showNumber) {
			row.createSpan({
				cls: "stereo-list-row-number",
				text: String(song.track ?? index + 1),
			});
		}
		const meta = row.createDiv({ cls: "stereo-list-row-meta" });
		meta.createDiv({ cls: "stereo-list-row-title", text: song.title });
		meta.createDiv({ cls: "stereo-list-row-sub", text: songMeta(song) });
		this.songHeart(row, song);
		if (options.showPlayCount) {
			const label = playCountLabel(song.playCount ?? 0);
			row.createSpan({
				cls: "stereo-list-row-plays",
				text: label,
				attr: { title: label },
			});
		}
		if (song.duration) {
			row.createSpan({
				cls: "stereo-list-row-duration",
				text: formatDuration(song.duration),
			});
		}

		row.addEventListener("click", () => {
			switch (this.plugin.settings.trackClickAction) {
				case "play":
					void this.plugin.player.setQueue(
						[...songs],
						index,
						options.origin ?? null
					);
					break;
				case "addToQueue":
					void this.plugin.player.addToQueue([song]);
					break;
				case "none":
					break;
			}
		});
		row.addEventListener("contextmenu", (event) => {
			const remove = options.removeFromPlaylist;
			this.showSongMenu(
				event,
				song,
				remove ? { removeFromPlaylist: () => remove(index) } : undefined
			);
		});
	}

	private emptyStatus(text: string): void {
		this.contentEl.createDiv({ cls: "stereo-library-status", text });
	}

	// --- context menus (PRD §5.1) — public: search results reuse them ---

	showSongMenu(
		event: MouseEvent,
		song: Song,
		context?: { removeFromPlaylist?: () => void }
	): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item.setTitle("Play").setIcon("play").onClick(() => {
				void this.plugin.player.playTrack(song);
			})
		);
		menu.addItem((item) =>
			item.setTitle("Play next").setIcon("corner-down-right").onClick(() => {
				this.plugin.player.playNext([song]);
			})
		);
		menu.addItem((item) =>
			item.setTitle("Add to queue").setIcon("list-plus").onClick(() => {
				void this.plugin.player.addToQueue([song]);
			})
		);
		menu.addItem((item) =>
			item.setTitle("Start station").setIcon("disc-3").onClick(() => {
				void this.plugin.startStation(
					{ kind: "song", id: song.id, label: song.title, genre: song.genre },
					song
				);
			})
		);
		menu.addItem((item) =>
			item
				.setTitle("Add to playlist…")
				.setIcon("list-music")
				.setDisabled(!!song.streamUrl)
				.onClick(() => {
					void this.addToPlaylist([song]);
				})
		);
		if (!song.streamUrl) {
			const albumId = song.albumId;
			menu.addSeparator();
			if (this.plugin.settings.sharingEnabled) {
				menu.addItem((item) =>
					item
						.setTitle("Share…")
						.setIcon("share-2")
						.onClick(() => {
							this.plugin.openShare(shareTargetForSong(song));
						})
				);
			}
			menu.addItem((item) =>
				item
					.setTitle("Open album in Navidrome")
					.setIcon("external-link")
					.setDisabled(!albumId)
					.onClick(() => {
						if (albumId) this.plugin.openNavidromeAlbum(albumId);
					})
			);
			menu.addItem((item) =>
				item
					.setTitle("Download track to clipboard")
					.setIcon("download")
					.onClick(() => {
						void this.plugin.downloadTrack(song);
					})
			);
		}
		if (context?.removeFromPlaylist) {
			const remove = context.removeFromPlaylist;
			menu.addItem((item) =>
				item
					.setTitle("Remove from playlist")
					.setIcon("list-x")
					.onClick(() => {
						remove();
					})
			);
		}
		if (song.artistId || song.albumId) menu.addSeparator();
		if (song.artistId) {
			menu.addItem((item) =>
				item.setTitle("Go to artist").setIcon("user").onClick(() => {
					this.openArtist(song.artistId as string, song.artist ?? "");
				})
			);
		}
		if (song.albumId) {
			menu.addItem((item) =>
				item.setTitle("Go to album").setIcon("disc").onClick(() => {
					this.openAlbum(song.albumId as string, song.album ?? "");
				})
			);
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(
					this.plugin.favorites.isStarred(song)
						? "Remove from favorites"
						: "Add to favorites"
				)
				.setIcon("heart")
				.onClick(async () => {
					try {
						await this.plugin.toggleSongFavorite(song);
					} catch {
						new Notice("Could not update favorites on the server.");
					}
				})
		);
		menu.showAtMouseEvent(event);
	}

	showAlbumMenu(event: MouseEvent, album: Album): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item.setTitle("Play").setIcon("play").onClick(() => {
				void this.withAlbumSongs(album, (songs) =>
					this.plugin.player.setQueue(songs, 0, {
						kind: "album",
						id: album.id,
						name: album.name,
						artist: album.artist,
					})
				);
			})
		);
		menu.addItem((item) =>
			item.setTitle("Play next").setIcon("corner-down-right").onClick(() => {
				void this.withAlbumSongs(album, (songs) => {
					this.plugin.player.playNext(songs);
				});
			})
		);
		menu.addItem((item) =>
			item.setTitle("Add to queue").setIcon("list-plus").onClick(() => {
				void this.withAlbumSongs(album, (songs) =>
					this.plugin.player.addToQueue(songs)
				);
			})
		);
		menu.addItem((item) =>
			item.setTitle("Start station").setIcon("disc-3").onClick(() => {
				void this.plugin.startStation({
					kind: "album",
					id: album.id,
					label: album.name,
					genre: album.genre,
				});
			})
		);
		menu.addItem((item) =>
			item.setTitle("Add to playlist…").setIcon("list-music").onClick(() => {
				void this.withAlbumSongs(album, (songs) => this.addToPlaylist(songs));
			})
		);
		if (this.plugin.settings.sharingEnabled) {
			menu.addItem((item) =>
				item.setTitle("Share…").setIcon("share-2").onClick(() => {
					this.plugin.openShare(shareTargetForAlbum(album));
				})
			);
		}
		menu.addItem((item) =>
			item
				.setTitle("Open album in Navidrome")
				.setIcon("external-link")
				.onClick(() => {
					this.plugin.openNavidromeAlbum(album.id);
				})
		);
		if (album.artistId) {
			menu.addSeparator();
			menu.addItem((item) =>
				item.setTitle("Go to artist").setIcon("user").onClick(() => {
					this.openArtist(album.artistId as string, album.artist ?? "");
				})
			);
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(album.starred ? "Remove from favorites" : "Add to favorites")
				.setIcon("heart")
				.onClick(async () => {
					try {
						await this.toggleAlbumFavorite(album);
					} catch {
						new Notice("Could not update favorites on the server.");
					}
				})
		);
		menu.showAtMouseEvent(event);
	}

	showArtistMenu(event: MouseEvent, artist: Artist): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item.setTitle("Start station").setIcon("disc-3").onClick(() => {
				void this.plugin.startStation({
					kind: "artist",
					id: artist.id,
					label: artist.name,
				});
			})
		);
		if (this.plugin.settings.sharingEnabled) {
			menu.addItem((item) =>
				item.setTitle("Share…").setIcon("share-2").onClick(() => {
					this.plugin.openShare(shareTargetForArtist(artist));
				})
			);
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(artist.starred ? "Remove from favorites" : "Add to favorites")
				.setIcon("heart")
				.onClick(async () => {
					try {
						await this.toggleArtistFavorite(artist);
					} catch {
						new Notice("Could not update favorites on the server.");
					}
				})
		);
		menu.showAtMouseEvent(event);
	}

	private showPlaylistMenu(event: MouseEvent, playlist: Playlist): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item.setTitle("Play").setIcon("play").onClick(() => {
				void this.withPlaylistSongs(playlist, (songs) =>
					this.plugin.player.setQueue(songs, 0, {
						kind: "playlist",
						id: playlist.id,
						name: playlist.name,
						songCount: songs.length,
					})
				);
			})
		);
		menu.addItem((item) =>
			item.setTitle("Play next").setIcon("corner-down-right").onClick(() => {
				void this.withPlaylistSongs(playlist, (songs) => {
					this.plugin.player.playNext(songs);
				});
			})
		);
		menu.addItem((item) =>
			item.setTitle("Add to queue").setIcon("list-plus").onClick(() => {
				void this.withPlaylistSongs(playlist, (songs) =>
					this.plugin.player.addToQueue(songs)
				);
			})
		);
		menu.addItem((item) =>
			item.setTitle("Add to playlist…").setIcon("list-music").onClick(() => {
				void this.withPlaylistSongs(playlist, (songs) =>
					this.addToPlaylist(songs)
				);
			})
		);
		if (this.plugin.settings.sharingEnabled) {
			menu.addItem((item) =>
				item.setTitle("Share…").setIcon("share-2").onClick(() => {
					this.plugin.openShare(shareTargetForPlaylist(playlist));
				})
			);
		}
		menu.addItem((item) =>
			item
				.setTitle("Open playlist in Navidrome")
				.setIcon("external-link")
				.onClick(() => {
					this.plugin.openNavidromePlaylist(playlist.id);
				})
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle("Rename…").setIcon("pencil").onClick(() => {
				new PlaylistNameModal(
					this.plugin.app,
					(name) => {
						void this.managePlaylist(`Renamed to "${name}".`, () =>
							this.plugin.client.updatePlaylist(playlist.id, { name })
						);
					},
					{ title: "Rename playlist", cta: "Rename", initial: playlist.name }
				).open();
			})
		);
		menu.addItem((item) =>
			item.setTitle("Delete playlist").setIcon("trash-2").onClick(() => {
				new ConfirmModal(
					this.plugin.app,
					"Delete playlist",
					`Delete "${playlist.name}" from the server?`,
					"Delete",
					() => {
						void this.managePlaylist(`Deleted "${playlist.name}".`, () =>
							this.plugin.client.deletePlaylist(playlist.id)
						);
					}
				).open();
			})
		);
		menu.showAtMouseEvent(event);
	}

	private showRadioMenu(event: MouseEvent, station: RadioStation): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item.setTitle("Play").setIcon("play").onClick(() => {
				void this.playStation(station);
			})
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle("Edit station…").setIcon("pencil").onClick(() => {
				new RadioStationModal(this.plugin.app, station, (input) => {
					void this.manageStation("update", () =>
						this.plugin.client.updateInternetRadioStation(
							station.id,
							input.name,
							input.streamUrl,
							input.homePageUrl
						)
					);
				}).open();
			})
		);
		menu.addItem((item) =>
			item.setTitle("Remove station").setIcon("trash-2").onClick(() => {
				new ConfirmModal(
					this.plugin.app,
					"Remove radio station",
					`Remove "${station.name}" from the server?`,
					"Remove",
					() => {
						void this.manageStation("remove", () =>
							this.plugin.client.deleteInternetRadioStation(station.id)
						);
					}
				).open();
			})
		);
		menu.showAtMouseEvent(event);
	}

	private addStation(): void {
		new RadioStationModal(this.plugin.app, null, (input) => {
			void this.manageStation("add", () =>
				this.plugin.client.createInternetRadioStation(
					input.name,
					input.streamUrl,
					input.homePageUrl
				)
			);
		}).open();
	}

	/** Run a station write against the server, then refresh the radio list. */
	private async manageStation(
		verb: "add" | "update" | "remove",
		action: () => Promise<void>
	): Promise<void> {
		try {
			await action();
		} catch (error) {
			if (error instanceof SubsonicError && error.code === 50) {
				new Notice("Your account is not allowed to manage radio stations.");
			} else {
				new Notice(`Could not ${verb} the radio station on the server.`);
			}
			return;
		}
		this.stations = null;
		if (this.activeSubTab === "radio") this.render();
	}

	private async withAlbumSongs(
		album: Album,
		action: (songs: Song[]) => void | Promise<void>
	): Promise<void> {
		try {
			const { songs } = await this.plugin.client.getAlbum(album.id);
			if (songs.length === 0) {
				new Notice("This album has no tracks.");
				return;
			}
			await action(songs);
		} catch {
			new Notice("Could not load the album from the server.");
		}
	}

	private async playStation(station: RadioStation): Promise<void> {
		let streamUrl: string;
		try {
			streamUrl = await resolveStreamUrl(station.streamUrl);
		} catch {
			new Notice("Could not resolve this station's stream URL.");
			return;
		}
		await this.plugin.player.playTrack({ ...radioSong(station), streamUrl });
	}

	/** "Add to playlist…" flow shared by lists, queues, and the player. */
	async addToPlaylist(songs: Song[]): Promise<void> {
		await this.plugin.addToPlaylist(songs);
	}

	/** Run a playlist write against the server, then refresh cached lists. */
	private async managePlaylist(
		successNotice: string,
		action: () => Promise<void>
	): Promise<boolean> {
		try {
			await action();
		} catch {
			new Notice("Could not update the playlist on the server.");
			return false;
		}
		new Notice(successNotice);
		this.invalidatePlaylists();
		return true;
	}

	private async withPlaylistSongs(
		playlist: Playlist,
		action: (songs: Song[]) => void | Promise<void>
	): Promise<void> {
		try {
			const { songs } = await this.plugin.client.getPlaylist(playlist.id);
			if (songs.length === 0) {
				new Notice("This playlist is empty.");
				return;
			}
			await action(songs);
		} catch {
			new Notice("Could not load the playlist from the server.");
		}
	}
}

/**
 * Stations are often configured with a `.m3u`/`.pls` playlist URL rather than
 * the stream itself, which `<audio>` cannot play. Fetch the playlist (via
 * `requestUrl`, which is CORS-exempt) and extract the first stream entry.
 * `.m3u8` (HLS) is deliberately excluded — Chromium has no native HLS support.
 */
async function resolveStreamUrl(url: string): Promise<string> {
	const path = (url.split("?")[0] ?? url).toLowerCase();
	if (!path.endsWith(".m3u") && !path.endsWith(".pls")) return url;

	const response = await requestUrl({ url });
	for (const raw of response.text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || line.startsWith("[")) continue;
		// PLS entries look like `File1=http://…`; M3U lines are bare URLs.
		const candidate = /^file\d*=/i.test(line)
			? line.slice(line.indexOf("=") + 1).trim()
			: line;
		if (/^https?:\/\//i.test(candidate)) return candidate;
	}
	throw new Error("The playlist contained no stream URL.");
}

/** Represent a radio station as a queue entry with a direct stream URL. */
function radioSong(station: RadioStation): Song {
	return {
		id: `radio-${station.id}`,
		title: station.name,
		artist: "Internet radio",
		streamUrl: station.streamUrl,
	};
}

function albumCountLabel(count: number): string {
	return count === 1 ? "1 album" : `${count} albums`;
}

function songCountLabel(count: number): string {
	return count === 1 ? "1 track" : `${count} tracks`;
}

function formatDuration(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function playCountLabel(count: number): string {
	return count === 1 ? "1 play" : `${count} plays`;
}

function createdTimestamp(value: string | undefined): number {
	if (!value) return 0;
	const time = Date.parse(value);
	return Number.isFinite(time) ? time : 0;
}
