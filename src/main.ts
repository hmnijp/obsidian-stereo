import {
	Notice,
	Plugin,
	WorkspaceLeaf,
	debounce,
	type Editor,
	type Side,
	type WorkspaceItem,
} from "obsidian";
import { ConnectionManager } from "./connection";
import { FavoritesIndex } from "./favorites";
import { PlayerSnapshot, PlayerStore } from "./player";
import { RatingsIndex } from "./ratings";
import { historyConnection, legacyHistoryConnection, type HistorySnapshot } from "./history";
import {
	DEFAULT_SETTINGS,
	StereoSettings,
	StereoSettingTab,
	migrateSettings,
} from "./settings";
import { navidromeAlbumUrl, navidromePlaylistUrl } from "./navidrome";
import { normalizeServerConfig, type ServerConfig } from "./servers";
import {
	ShareCreateModal,
	SHARES_VIEW_TYPE,
	SharesView,
	resolveQueueShareTarget,
	type ShareTarget,
} from "./share";
import type { StationSeed } from "./station";
import { PlaylistNameModal, PlaylistPickerModal } from "./modals";
import { StatusBarPlayer } from "./status-bar";
import { Song, SubsonicClient, type Playlist } from "./subsonic";
import { downloadTrackToClipboard } from "./track-download";
import { STEREO_VIEW_TYPE, StereoView } from "./view";

interface SavedView {
	side: Side;
	/** Child indexes from the sidebar root down to the tab group. */
	path: number[];
	/** Tab position inside that group. */
	tab: number;
}

interface WorkspaceContainerLike {
	children?: unknown[];
	insertChild?: (index: number, child: WorkspaceLeaf) => void;
	selectTabIndex?: (index: number) => void;
}

interface StereoData {
	settings: StereoSettings;
	playerState?: PlayerSnapshot;
	history?: HistorySnapshot;
	/** Sidebar panes with their group and tab positions. */
	openViews?: SavedView[];
	/** Most recently active Stereo sidebar. */
	lastViewSide?: Side;
}

function isSide(value: unknown): value is Side {
	return value === "left" || value === "right";
}

function isSavedView(value: unknown): value is SavedView {
	if (!value || typeof value !== "object") return false;
	const view = value as Record<string, unknown>;
	const path = view.path;
	return (
		isSide(view.side) &&
		Array.isArray(path) &&
		path.every((index) => Number.isInteger(index) && index >= 0) &&
		Number.isInteger(view.tab) &&
		(view.tab as number) >= 0
	);
}

function countViewSides(views: SavedView[]): Record<Side, number> {
	const counts: Record<Side, number> = { left: 0, right: 0 };
	for (const view of views) counts[view.side] += 1;
	return counts;
}

export default class StereoPlugin extends Plugin {
	settings: StereoSettings = { ...DEFAULT_SETTINGS };
	connection: ConnectionManager = new ConnectionManager(() => this.settings);
	client: SubsonicClient = new SubsonicClient(
		() => this.settings,
		this.connection
	);
	player: PlayerStore = new PlayerStore(this.client, () => this.settings);
	favorites: FavoritesIndex = new FavoritesIndex(
		this.client,
		() => historyConnection(this.settings)
	);
	ratings: RatingsIndex = new RatingsIndex(
		this.client,
		() => historyConnection(this.settings)
	);

	private playerState: PlayerSnapshot | undefined;
	private pendingSave: Promise<void> = Promise.resolve();
	private savePlayerState = debounce(
		() => {
			void this.saveAll();
		},
		1000,
		true
	);
	private statusBar: StatusBarPlayer | null = null;
	private openViews: SavedView[] = [];
	private lastViewSide: Side = "right";
	private viewsInitialized = false;
	private sawOpenViews = false;
	private restoringViews = false;
	private unloading = false;
	private saveViewSides = debounce(
		() => {
			void this.saveAll();
		},
		300,
		true
	);

	async onload(): Promise<void> {
		await this.loadDataFile();
		this.favorites.syncConnection();
		this.ratings.syncConnection();
		this.connection.setProbe((url) => this.client.probe(url));
		this.connection.start();

		if (this.playerState) {
			this.player.restore(this.playerState);
		}
		this.player.setPersistence((snapshot) => {
			this.playerState = snapshot;
			this.savePlayerState();
		});
		this.player.history.setPersistence(() => { void this.saveAll(); });
		this.applyVolumeControlSetting();

		this.registerView(STEREO_VIEW_TYPE, (leaf) => new StereoView(leaf, this));
		this.registerView(SHARES_VIEW_TYPE, (leaf) => new SharesView(leaf, this));
		this.addSettingTab(new StereoSettingTab(this.app, this));

		const statusBarItem = this.addStatusBarItem();
		if (statusBarItem) {
			this.statusBar = new StatusBarPlayer(this, statusBarItem);
		}

		this.addRibbonIcon("boom-box", "Open Stereo", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-player",
			name: "Open player",
			callback: () => {
				void this.activateView();
			},
		});

		this.addCommand({
			id: "open-player-window",
			name: "Open player in new window",
			callback: () => {
				void this.openPlayerInWindow();
			},
		});

		this.addCommand({
			id: "show-status-bar-player",
			name: "Show status bar player",
			callback: () => {
				this.statusBar?.togglePopup();
			},
		});

		this.addCommand({
			id: "open-current-album-in-navidrome",
			name: "Open current album in Navidrome",
			callback: () => {
				const track = this.player.getState().track;
				if (!track) {
					new Notice("Nothing playing.");
					return;
				}
				this.openNavidromeTrack(track);
			},
		});

		this.addCommand({
			id: "download-current-track",
			name: "Download current track to clipboard",
			callback: () => {
				const track = this.player.getState().track;
				if (!track) {
					new Notice("Nothing playing.");
					return;
				}
				void this.downloadTrack(track);
			},
		});

		this.addCommand({
			id: "add-current-track-to-favorites",
			name: "Add current track to favorites",
			callback: () => {
				void this.favoriteCurrentTrack();
			},
		});

		this.addCommand({
			id: "add-current-track-to-playlist",
			name: "Add current track to playlist",
			callback: () => {
				const track = this.currentTrack();
				if (!track) return;
				void this.addToPlaylist([track]);
			},
		});

		this.addCommand({
			id: "search-selected-text",
			name: "Search for selected text",
			editorCallback: (editor: Editor) => {
				const query = editor.getSelection().replace(/\s+/g, " ").trim();
				if (!query) {
					new Notice("Select some text to search for.");
					return;
				}
				void this.searchForText(query);
			},
		});

		this.addCommand({
			id: "manage-share-links",
			name: "Manage share links",
			callback: () => {
				void this.openShares();
			},
		});

		this.setupViewPersistence();
	}

	onunload(): void {
		// Per Obsidian guidelines: do not detach leaves of our view type here.
		// Registered events/DOM listeners are cleaned up automatically.
		this.unloading = true;
		this.saveViewSides.cancel();
		if (this.viewsInitialized) {
			const current = this.currentSidebarViews();
			if (current.length > 0) this.openViews = current;
		}
		this.connection.stop();
		this.statusBar?.destroy();
		this.statusBar = null;
		this.player.destroy();
		this.favorites.destroy();
		this.ratings.destroy();
		this.savePlayerState.cancel();
		void this.saveAll();
	}

	/** The current player track, or a notice when nothing is playing. */
	private currentTrack(): Song | null {
		const track = this.player.getState().track;
		if (!track) {
			new Notice("Nothing playing.");
			return null;
		}
		return track;
	}

	/** Add the current track to favorites once; never removes an existing star. */
	private async favoriteCurrentTrack(): Promise<void> {
		const track = this.currentTrack();
		if (!track) return;
		if (track.streamUrl) {
			new Notice("Radio streams cannot be favorited.");
			return;
		}
		if (this.favorites.isStarred(track)) {
			new Notice("Already in favorites.");
			return;
		}
		try {
			await this.toggleSongFavorite(track);
			new Notice("Added to favorites.");
		} catch {
			new Notice("Could not update favorites on the server.");
		}
	}

	/** Open Stereo and search the library for editor-selected text. */
	private async searchForText(query: string): Promise<void> {
		await this.activateView();
		const view = this.firstStereoView();
		if (!view) {
			new Notice("Could not open the player.");
			return;
		}
		view.searchFor(query);
	}

	/**
	 * Toggle a song's favorite flag on the server and mirror it into the play
	 * queue. Returns the new `starred` value so callers can update their own
	 * copies. Throws on server failure.
	 */
	async toggleSongFavorite(song: Song): Promise<string | undefined> {
		const starred = await this.favorites.toggle(song);
		this.player.updateSong(song.id, { starred });
		this.player.history.updateSong(song.id, { starred });
		return starred;
	}

	/** Set or clear a song's 1–5 star rating and mirror it into playback state. */
	async toggleSongRating(song: Song, rating: number): Promise<number> {
		const value = await this.ratings.toggleRating(song, rating);
		const userRating = value > 0 ? value : undefined;
		this.player.updateSong(song.id, { userRating });
		this.player.history.updateSong(song.id, { userRating });
		return value;
	}

	/**
	 * Start a station and report the outcome — the shared entry point for the
	 * player button and the context menus. `lead` is the seeded track when the
	 * seed is a song; it plays first (or keeps playing, if it already is).
	 */
	async startStation(seed: StationSeed, lead?: Song): Promise<void> {
		try {
			const queued = await this.player.startStation(seed, lead);
			if (queued === 0) {
				new Notice("The server had no tracks to build this station from.");
				return;
			}
			new Notice(`Station started: ${seed.label}`);
		} catch {
			new Notice("Could not build the station from the server.");
		}
	}

	/** Re-apply the Now Playing view choice to open players (settings change). */
	refreshNowPlayingViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(STEREO_VIEW_TYPE)) {
			if (leaf.view instanceof StereoView) leaf.view.applyNowPlayingView();
		}
		this.statusBar?.applyLyricsSettings();
	}

	/** Apply External badge and cover-frame visibility to open players. */
	applyExternalHighlightSetting(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(STEREO_VIEW_TYPE)) {
			if (leaf.view instanceof StereoView) {
				leaf.view.applyExternalHighlightSetting();
			}
		}
	}

	/** Open the share dialog for one library item or a queue snapshot. */
	openShare(target: ShareTarget): void {
		new ShareCreateModal(this.app, this, target).open();
	}

	/** Open the share-link manager as a tab in the current window. */
	async openShares(): Promise<void> {
		const workspace = this.app.workspace;
		const existing = workspace.getLeavesOfType(SHARES_VIEW_TYPE)[0];
		if (existing) {
			await workspace.revealLeaf(existing);
			return;
		}
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: SHARES_VIEW_TYPE, active: true });
		await workspace.revealLeaf(leaf);
	}

	/** Open an artist page in the right-sidebar player. */
	async openArtistInLibrary(id: string, name: string): Promise<void> {
		await this.activateView("right");
		this.firstStereoView()?.openArtistInLibrary(id, name);
	}

	/** Open an album page in the right-sidebar player. */
	async openAlbumInLibrary(id: string, name: string): Promise<void> {
		await this.activateView("right");
		this.firstStereoView()?.openAlbumInLibrary(id, name);
	}

	private firstStereoView(): StereoView | null {
		for (const leaf of this.app.workspace.getLeavesOfType(STEREO_VIEW_TYPE)) {
			if (leaf.view instanceof StereoView) return leaf.view;
		}
		return null;
	}

	/** "Add to playlist…" flow shared by the player, status bar, and library. */
	async addToPlaylist(songs: Song[]): Promise<void> {
		const addable = songs.filter((song) => !song.streamUrl);
		if (addable.length === 0) {
			new Notice("There are no tracks to add to a playlist.");
			return;
		}
		let playlists: Playlist[];
		try {
			playlists = await this.client.getPlaylists();
		} catch {
			new Notice("Could not load playlists from the server.");
			return;
		}
		const ids = addable.map((song) => song.id);
		const added = `Added ${
			addable.length === 1 ? "1 track" : `${addable.length} tracks`
		}`;
		new PlaylistPickerModal(this.app, playlists, (choice) => {
			if (choice.kind === "new") {
				new PlaylistNameModal(
					this.app,
					(name) => {
						void this.managePlaylist(`${added} to "${name}".`, () =>
							this.client.createPlaylist(name, ids)
						);
					},
					{ title: "New playlist", cta: "Create" }
				).open();
				return;
			}
			void this.managePlaylist(
				`${added} to "${choice.playlist.name}".`,
				() =>
					this.client.updatePlaylist(choice.playlist.id, {
						addSongIds: ids,
					})
			);
		}).open();
	}

	/** Load an album or playlist and pass its tracks to the playlist picker. */
	async addCollectionToPlaylist(
		kind: "album" | "playlist",
		id: string
	): Promise<void> {
		let songs: Song[];
		try {
			songs =
				kind === "album"
					? (await this.client.getAlbum(id)).songs
					: (await this.client.getPlaylist(id)).songs;
		} catch {
			new Notice(
				kind === "album"
					? "Could not load the album from the server."
					: "Could not load the playlist from the server."
			);
			return;
		}
		if (songs.length === 0) {
			new Notice(
				kind === "album"
					? "This album has no tracks."
					: "This playlist is empty."
			);
			return;
		}
		await this.addToPlaylist(songs);
	}

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
		this.refreshPlaylistCaches();
		return true;
	}

	private refreshPlaylistCaches(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(STEREO_VIEW_TYPE)) {
			if (leaf.view instanceof StereoView) leaf.view.invalidatePlaylists();
		}
	}

	/** Open an album in the Navidrome web UI. */
	openNavidromeAlbum(albumId: string): void {
		this.openNavidromeUrl((base) => navidromeAlbumUrl(base, albumId));
	}

	/** Open a playlist in the Navidrome web UI. */
	openNavidromePlaylist(playlistId: string): void {
		this.openNavidromeUrl((base) => navidromePlaylistUrl(base, playlistId));
	}

	/** Open a track's album in Navidrome; its song resource has no detail page. */
	openNavidromeTrack(song: Song): void {
		if (song.streamUrl) {
			new Notice("Radio streams cannot be opened in Navidrome.");
			return;
		}
		if (!song.albumId) {
			new Notice("This track has no album in Navidrome.");
			return;
		}
		this.openNavidromeAlbum(song.albumId);
	}

	private openNavidromeUrl(build: (base: string) => string): void {
		try {
			const url = build(this.client.webBaseUrl());
			if (!url) {
				new Notice("Configure a server first.");
				return;
			}
			window.open(url, "_blank");
		} catch {
			new Notice("Configure a server first.");
		}
	}

	/** Download the original track and put the file on the system clipboard. */
	async downloadTrack(song: Song): Promise<void> {
		if (song.streamUrl) {
			new Notice("Radio streams cannot be downloaded.");
			return;
		}
		const progress = new Notice("Preparing track…", 0);
		try {
			const result = await downloadTrackToClipboard(this.client, song);
			progress.hide();
			const prefix = result.cached ? "Already downloaded. " : "";
			new Notice(
				result.mode === "file"
					? `${prefix}Track copied to clipboard: ${result.fileName}`
					: `${prefix}File saved. Path copied to clipboard: ${result.filePath}`
			);
		} catch (error) {
			progress.hide();
			new Notice(
				error instanceof Error
					? error.message
					: "Could not download the track."
			);
		}
	}

	/** Switch the active server and reload the views. */
	async setActiveServer(id: string): Promise<void> {
		if (
			!this.settings.servers.some((server) => server.id === id) ||
			id === this.settings.activeServerId
		) {
			return;
		}
		this.settings.activeServerId = id;
		this.connection.reset();
		this.favorites.syncConnection();
		this.ratings.syncConnection();
		this.player.syncConnection();
		await this.saveAll();
		this.refreshAllViews();
	}

	/** Insert or update a server configuration. */
	async upsertServer(server: ServerConfig): Promise<void> {
		const normalized = normalizeServerConfig(server);
		const index = this.settings.servers.findIndex(
			(entry) => entry.id === normalized.id
		);
		if (index >= 0) this.settings.servers[index] = normalized;
		else this.settings.servers.push(normalized);
		if (
			!this.settings.servers.some(
				(entry) => entry.id === this.settings.activeServerId
			)
		) {
			this.settings.activeServerId = this.settings.servers[0]?.id ?? "";
		}
		this.connection.reset();
		this.favorites.syncConnection();
		this.ratings.syncConnection();
		this.player.syncConnection();
		await this.saveAll();
		this.refreshAllViews();
	}

	/** Remove a server, selecting another one when the active one is deleted. */
	async deleteServer(id: string): Promise<void> {
		this.settings.servers = this.settings.servers.filter(
			(server) => server.id !== id
		);
		if (this.settings.activeServerId === id) {
			this.settings.activeServerId = this.settings.servers[0]?.id ?? "";
		}
		this.connection.reset();
		this.favorites.syncConnection();
		this.ratings.syncConnection();
		this.player.syncConnection();
		await this.saveAll();
		this.refreshAllViews();
	}

	private refreshAllViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(STEREO_VIEW_TYPE)) {
			if (leaf.view instanceof StereoView) leaf.view.reloadForConnection();
		}
		for (const leaf of this.app.workspace.getLeavesOfType(SHARES_VIEW_TYPE)) {
			if (leaf.view instanceof SharesView) leaf.view.reloadForConnection();
		}
	}

	/** Resolve the current queue to its album/playlist source or a snapshot. */
	async openShareQueue(): Promise<void> {
		const state = this.player.getState();
		const target = await resolveQueueShareTarget(
			state.queue,
			state.queueOrigin,
			this.client
		);
		if (!target) {
			new Notice("The queue has no shareable tracks.");
			return;
		}
		this.openShare(target);
	}

	/** Update share-button visibility in every open player. */
	syncShareUi(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(STEREO_VIEW_TYPE)) {
			if (leaf.view instanceof StereoView) leaf.view.syncShareUi();
		}
	}

	/** Apply the status-bar visibility and layout toggles immediately. */
	applyStatusBarSetting(): void {
		this.statusBar?.setVisible(this.settings.showStatusBarPlayer);
		this.statusBar?.refresh();
	}

	/** When the volume control is disabled, output stays at 100% and only the
	 * device controls loudness. */
	applyVolumeControlSetting(): void {
		if (!this.settings.volumeControl && this.player.getState().volume !== 1) {
			this.player.setVolume(1);
		}
	}

	/** Track Stereo panes in the left/right sidebars so a plugin reload can
	 * restore the same layout. Main-area and popout leaves are intentionally
	 * ignored until a dedicated restore command supports them. */
	private setupViewPersistence(): void {
		const workspace = this.app.workspace;
		if (!workspace) return;

		this.registerEvent(
			workspace.on("layout-change", () => {
				if (!this.viewsInitialized || this.restoringViews || this.unloading) {
					return;
				}
				this.syncOpenViews();
			})
		);
		this.registerEvent(
			workspace.on("active-leaf-change", (leaf) => {
				if (!this.viewsInitialized || !leaf || this.unloading) return;
				if (leaf.getViewState().type !== STEREO_VIEW_TYPE) return;
				const side = this.sideOfLeaf(leaf);
				if (!side || side === this.lastViewSide) return;
				this.lastViewSide = side;
				this.saveViewSides();
			})
		);
		workspace.onLayoutReady(() => {
			void this.initializeViewPersistence();
		});
	}

	private async initializeViewPersistence(): Promise<void> {
		if (this.viewsInitialized || this.unloading) return;
		const workspace = this.app.workspace;
		if (!workspace) return;

		if (this.settings.restoreOpenViews) {
			// Give Obsidian a moment to finish its own view registration dance
			// before we fill gaps left by a user-initiated plugin disable.
			if (this.openViews.length > 0) {
				await new Promise<void>((resolve) => {
					window.setTimeout(resolve, 500);
				});
				if (this.unloading) return;
			}
			await this.restoreSavedViews();
		}
		const current = this.currentSidebarViews();
		if (current.length > 0) {
			this.sawOpenViews = true;
			this.setOpenViews(current);
		}
		this.viewsInitialized = true;
		this.rememberActiveSide();
	}

	/** Reopen every saved sidebar pane in its previous tab group. Public so a
	 * future command can call it independently of the automatic-restore
	 * setting. */
	async restoreSavedViews(): Promise<void> {
		const workspace = this.app.workspace;
		if (!workspace || this.restoringViews || this.unloading) return;
		const saved = this.openViews.map((view) => ({
			...view,
			path: [...view.path],
		}));
		if (saved.length === 0) return;

		const existing = countViewSides(this.currentSidebarViews());
		const missing: SavedView[] = [];
		for (const view of saved) {
			if (existing[view.side] > 0) {
				existing[view.side] -= 1;
				continue;
			}
			missing.push(view);
		}
		if (missing.length === 0) return;

		this.restoringViews = true;
		try {
			for (const view of missing) {
				await this.restoreView(view);
			}
		} finally {
			this.restoringViews = false;
		}

		const restored = this.currentSidebarViews();
		if (restored.length > 0) {
			this.sawOpenViews = true;
			this.setOpenViews(restored);
		}
	}

	private async restoreView(view: SavedView): Promise<void> {
		const workspace = this.app.workspace;
		if (!workspace) return;
		const root = (
			view.side === "left" ? workspace.leftSplit : workspace.rightSplit
		) as unknown as WorkspaceContainerLike;

		let container: WorkspaceContainerLike | null = null;
		if (view.path.length > 0) {
			container = root;
			for (const index of view.path) {
				const children = container.children;
				const next = Array.isArray(children) ? children[index] : undefined;
				if (!next) {
					container = null;
					break;
				}
				container = next as WorkspaceContainerLike;
			}
		}

		if (
			container &&
			Array.isArray(container.children) &&
			typeof container.insertChild === "function"
		) {
			try {
				const create = WorkspaceLeaf as unknown as new (
					app: unknown
				) => WorkspaceLeaf;
				const leaf = new create(this.app);
				const index = Math.min(
					Math.max(0, view.tab),
					container.children.length
				);
				container.insertChild(index, leaf);
				const tabIndex = Array.isArray(container.children)
					? container.children.indexOf(leaf)
					: index;
				if (tabIndex >= 0) container.selectTabIndex?.(tabIndex);
				await leaf.setViewState({
					type: STEREO_VIEW_TYPE,
					active: false,
				});
				return;
			} catch (error) {
				console.warn("Stereo could not restore a sidebar tab.", error);
			}
		}

		const leaf =
			view.side === "left"
				? workspace.getLeftLeaf(true)
				: workspace.getRightLeaf(true);
		if (!leaf) return;
		try {
			await leaf.setViewState({ type: STEREO_VIEW_TYPE, active: false });
		} catch (error) {
			console.warn("Stereo could not restore a sidebar pane.", error);
		}
	}

	/** Read the current sidebars and persist a changed layout. */
	private syncOpenViews(): void {
		const views = this.currentSidebarViews();
		if (views.length > 0) {
			this.sawOpenViews = true;
		} else if (!this.sawOpenViews) {
			// With automatic restore off, keep the saved views available for the
			// future manual restore command even while nothing is open.
			return;
		}
		this.setOpenViews(views);
		this.rememberActiveSide();
	}

	private setOpenViews(views: SavedView[]): void {
		const changed =
			views.length !== this.openViews.length ||
			views.some((view, index) => {
				const previous = this.openViews[index];
				return (
					view.side !== previous?.side ||
					view.tab !== previous?.tab ||
					view.path.length !== previous.path.length ||
					view.path.some((index, pathIndex) => index !== previous.path[pathIndex])
				);
			});
		if (!changed) return;
		this.openViews = views.map((view) => ({
			side: view.side,
			path: [...view.path],
			tab: view.tab,
		}));
		this.saveViewSides();
	}

	private rememberActiveSide(): void {
		const workspace = this.app.workspace;
		if (!workspace) return;
		const active = workspace.getActiveViewOfType(StereoView);
		let leaf: WorkspaceLeaf | null = null;
		if (active) {
			leaf =
				workspace
					.getLeavesOfType(STEREO_VIEW_TYPE)
					.find((candidate) => candidate.view === active) ?? null;
		}
		const side = leaf ? this.sideOfLeaf(leaf) : null;
		if (!side || side === this.lastViewSide) return;
		this.lastViewSide = side;
		this.saveViewSides();
	}

	private currentSidebarViews(): SavedView[] {
		const workspace = this.app.workspace;
		if (!workspace) return [];
		const views: SavedView[] = [];
		workspace.iterateAllLeaves((leaf) => {
			if (leaf.getViewState().type !== STEREO_VIEW_TYPE) return;
			const view = this.savedViewForLeaf(leaf);
			if (view) views.push(view);
		});
		return views;
	}

	private savedViewForLeaf(leaf: WorkspaceLeaf): SavedView | null {
		const workspace = this.app.workspace;
		if (!workspace) return null;
		const side = this.sideOfLeaf(leaf);
		if (!side) return null;

		const root =
			side === "left" ? workspace.leftSplit : workspace.rightSplit;
		const path: number[] = [];
		let current: unknown = leaf;
		while (current && current !== root) {
			const parent = (current as { parent?: unknown }).parent;
			if (!parent) return null;
			const children = (parent as WorkspaceContainerLike).children;
			const index = Array.isArray(children) ? children.indexOf(current) : -1;
			if (index < 0) return null;
			path.unshift(index);
			current = parent;
		}
		if (current !== root || path.length === 0) return null;

		return {
			side,
			path: path.slice(0, -1),
			tab: path[path.length - 1] ?? 0,
		};
	}

	private sideOfLeaf(leaf: WorkspaceLeaf): Side | null {
		const workspace = this.app.workspace;
		if (!workspace) return null;
		const el = leaf.view?.containerEl;
		if (el) {
			const left = (
				workspace.leftSplit as unknown as { containerEl?: HTMLElement }
			).containerEl;
			if (left?.contains(el)) return "left";
			const right = (
				workspace.rightSplit as unknown as { containerEl?: HTMLElement }
			).containerEl;
			if (right?.contains(el)) return "right";

			// Fallback for Obsidian versions where the sidedock container is not
			// exposed. Popouts are ignored because their document differs.
			if (el.ownerDocument === workspace.containerEl.ownerDocument) {
				const split = el.closest(
					".workspace-split.mod-left-split, .workspace-split.mod-right-split"
				);
				if (split?.classList.contains("mod-left-split")) return "left";
				if (split?.classList.contains("mod-right-split")) return "right";
			}
		}

		let item: WorkspaceItem | null = leaf;
		while (item) {
			if (item === workspace.leftSplit) return "left";
			if (item === workspace.rightSplit) return "right";
			item =
				(item as WorkspaceItem & { parent?: WorkspaceItem | null }).parent ??
				null;
		}
		return null;
	}

	/** Open a player in a separate desktop window. */
	async openPlayerInWindow(): Promise<void> {
		const workspace = this.app.workspace;
		if (typeof workspace.openPopoutLeaf !== "function") return;
		try {
			const leaf = workspace.openPopoutLeaf({
				size: { width: 420, height: 760 },
			});
			await leaf.setViewState({ type: STEREO_VIEW_TYPE, active: true });
		} catch {
			new Notice("Could not open the player in a new window.");
		}
	}

	async activateView(side: Side = this.lastViewSide): Promise<void> {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null =
			workspace.getLeavesOfType(STEREO_VIEW_TYPE)[0] ?? null;

		if (!leaf) {
			leaf =
				side === "left"
					? workspace.getLeftLeaf(true)
					: workspace.getRightLeaf(false);
			if (!leaf) return;
			await leaf.setViewState({ type: STEREO_VIEW_TYPE, active: true });
		}

		await workspace.revealLeaf(leaf);
	}

	private async loadDataFile(): Promise<void> {
		const raw = (await this.loadData()) as
			| (Partial<StereoData> & Record<string, unknown>)
			| null;
		if (!raw) {
			this.player.history.restore(undefined, historyConnection(this.settings));
			return;
		}

		// Current shape: { settings, playerState, history, openViews }.
		// Legacy shape: flat settings.
		const settingsRaw = (raw.settings ?? raw) as Record<string, unknown>;
		this.settings = {
			...DEFAULT_SETTINGS,
			...migrateSettings(settingsRaw),
		};
		const connection = historyConnection(this.settings);
		const legacyConnection = legacyHistoryConnection(this.settings);
		// A server URL or username saved mid-edit still carries the previous
		// account's queue; the history snapshot names the account it belongs to.
		// Data from before history support has no snapshot and keeps its queue.
		// With "keep across servers" the saved state is restored either way, and
		// the entries keep the account they were played under.
		const keepPlayback = this.settings.keepPlaybackAcrossServers === true;
		const historyRaw = raw.history as
			| { connection?: unknown; entries?: unknown }
			| undefined;
		const savedConnection = historyRaw?.connection;
		const sameAccount =
			savedConnection === connection || savedConnection === legacyConnection;
		this.playerState =
			savedConnection === undefined || sameAccount || keepPlayback
				? raw.playerState
				: undefined;
		const historySnapshot =
			sameAccount && historyRaw
				? { ...historyRaw, connection }
				: raw.history;
		this.player.history.restore(historySnapshot, connection);

		this.openViews = Array.isArray(raw.openViews)
			? raw.openViews.filter(isSavedView)
			: [];
		this.lastViewSide = isSide(raw.lastViewSide) ? raw.lastViewSide : "right";
		if (
			this.openViews.length > 0 &&
			!this.openViews.some((view) => view.side === this.lastViewSide)
		) {
			this.lastViewSide =
				this.openViews[this.openViews.length - 1]?.side ?? "right";
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveAll();
	}

	/**
	 * Apply a finished server URL or username edit: drop the previous account's
	 * history, queue and undo. Called when the field is left, not per keystroke,
	 * so correcting a typo does not throw the current session away.
	 */
	async commitConnection(): Promise<void> {
		this.favorites.syncConnection();
		this.ratings.syncConnection();
		this.player.syncConnection();
		await this.saveAll();
	}

	private async saveAll(): Promise<void> {
		const data: StereoData = {
			settings: { ...this.settings },
			playerState: this.playerState,
			history: this.player.history.getSnapshot(),
			openViews: this.openViews,
			lastViewSide: this.lastViewSide,
		};
		// Keep an earlier playback save from overwriting a later history clear.
		this.pendingSave = this.pendingSave.then(() => this.saveData(data)).catch(() => {
			new Notice("Could not save Stereo data.");
		});
		await this.pendingSave;
	}
}
