import {
	ItemView,
	Menu,
	Notice,
	WorkspaceLeaf,
	requestUrl,
	setIcon,
} from "obsidian";
import radioTowerSvg from "../radio-tower.svg";
import boomboxSvg from "../boombox.svg";
import stereoBoomboxSvg from "../stereo-boombox.svg";
import { getLyrics, type Lyrics } from "./lyrics";
import { LibraryPane } from "./library";
import { PlaylistNameModal } from "./modals";
import { SearchPane } from "./search";
import { Visualizer, type VisualizerMode } from "./visualizer";
import type StereoPlugin from "./main";
import type { PlayerState } from "./player";
import { NOW_PLAYING_VIEWS, type NowPlayingView } from "./settings";
import type { Song } from "./subsonic";

export const STEREO_VIEW_TYPE = "stereo-player";

/** UTF-8-safe data URI for an inlined SVG (btoa would choke on non-Latin-1). */
function svgDataUri(svg: string): string {
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("Could not load the image."));
		img.src = src;
	});
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) =>
				blob ? resolve(blob) : reject(new Error("Could not encode the image.")),
			type
		);
	});
}

/** Sniff the common raster formats so the original PNG bytes can be copied
 * directly even when the server sends a generic content type. */
function sniffImageType(buffer: ArrayBuffer): string | null {
	const b = new Uint8Array(buffer, 0, Math.min(12, buffer.byteLength));
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
		return "image/png";
	}
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (
		b[0] === 0x52 &&
		b[1] === 0x49 &&
		b[2] === 0x46 &&
		b[3] === 0x46 &&
		b[8] === 0x57 &&
		b[9] === 0x45 &&
		b[10] === 0x42 &&
		b[11] === 0x50
	) {
		return "image/webp";
	}
	if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
		return "image/gif";
	}
	return null;
}

/** Queue is a full page like the others; it also has a tab, and the player's
 * list icon (and the mini player's) navigates to it. */
type TabId = "nowPlaying" | "library" | "queue";

const TAB_IDS: TabId[] = ["nowPlaying", "queue", "library"];

/** Views that render on the canvas visualizer rather than the album-art image. */
function isVizView(view: NowPlayingView): view is VisualizerMode {
	return (
		view === "bars" ||
		view === "waveform" ||
		view === "radio" ||
		view === "boombox" ||
		view === "stereo" ||
		view === "cover"
	);
}

/**
 * View shell. All pages stay mounted and are display-toggled so scroll
 * position and playback UI are never disturbed (AGENTS.md). Renders purely
 * from PlayerStore state. The full player lives on Now Playing; every other
 * screen shows a mini player bar at the bottom.
 */
export class StereoView extends ItemView {
	plugin: StereoPlugin;
	private unsubscribe: (() => void) | null = null;

	// Tabs
	private tabButtons: Partial<Record<TabId, HTMLButtonElement>> = {};
	private pages: Record<TabId, HTMLElement> = {} as Record<TabId, HTMLElement>;
	private activeTab: TabId = "nowPlaying";

	// Now Playing elements
	private artWrap!: HTMLElement;
	private artImg!: HTMLImageElement;
	private artPlaceholder!: HTMLElement;
	private viz!: Visualizer;
	private nowPlayingView: NowPlayingView = "record";
	private trackRowEl!: HTMLElement;
	private trackCoverEl!: HTMLElement;
	private trackCoverImg!: HTMLImageElement;
	private trackCoverPlaceholder!: HTMLElement;
	private trackInfoEl!: HTMLElement;
	private titleEl!: HTMLElement;
	private artistEl!: HTMLElement;
	private albumEl!: HTMLElement;
	private elapsedEl!: HTMLElement;
	private remainingEl!: HTMLElement;
	private seekSlider!: HTMLInputElement;
	private previousButton!: HTMLButtonElement;
	private playButton!: HTMLButtonElement;
	private nextButton!: HTMLButtonElement;
	private extrasRow!: HTMLElement;
	private volumeControlEl: HTMLElement | null = null;
	private volumeButton: HTMLButtonElement | null = null;
	private volumePopup: HTMLElement | null = null;
	private volumeSlider: HTMLInputElement | null = null;
	private volumeWheelDelta = 0;
	private volumeHideTimer: number | null = null;
	private volumeDismissCleanup: (() => void) | null = null;
	private shuffleButton!: HTMLButtonElement;
	private repeatButton!: HTMLButtonElement;
	private queueButton!: HTMLButtonElement;
	private stationButton!: HTMLButtonElement;
	private favoriteButton!: HTMLButtonElement;
	private errorEl!: HTMLElement;

	// Lyrics panel (swaps in for the art area while toggled on)
	private lyricsButton!: HTMLButtonElement;
	private lyricsWrap!: HTMLElement;
	private lyricsScroll!: HTMLElement;
	private lyricsVisible = false;
	// Inline playback queue panel (also swaps in for the art area)
	private nowQueueWrap!: HTMLElement;
	private nowQueueScroll!: HTMLElement;
	private queueVisible = false;
	/** Track id the panel currently shows; null forces a reload. */
	private lyricsLoadedFor: string | null = null;
	/** Bumped per load; stale async loads bail. */
	private lyricsToken = 0;
	private lyricsData: Lyrics | null = null;
	private lyricsLineEls: HTMLElement[] = [];
	private lyricsActiveLine = -1;

	// Queue page
	private queueTitleEl!: HTMLElement;
	private moreButton!: HTMLButtonElement;
	private queueList!: HTMLElement;
	private undoButton!: HTMLButtonElement;
	private queueErrorEl!: HTMLElement;
	private queueDrag: { queue: Song[]; index: number } | null = null;
	private queueDropRow: HTMLElement | null = null;

	// Mini player (visible on every screen except Now Playing)
	private miniEl!: HTMLElement;
	private miniThumbImg!: HTMLImageElement;
	private miniThumbPlaceholder!: HTMLElement;
	private miniTitleEl!: HTMLElement;
	private miniArtistEl!: HTMLElement;
	private miniAlbumEl!: HTMLElement;
	private miniSepEl!: HTMLElement;
	private miniElapsedEl!: HTMLElement;
	private miniSeekSlider!: HTMLInputElement;
	private miniPreviousButton!: HTMLButtonElement;
	private miniPlayButton!: HTMLButtonElement;
	private miniNextButton!: HTMLButtonElement;
	private miniFavoriteButton!: HTMLButtonElement;

	// Library & search
	private library!: LibraryPane;
	private search: SearchPane | null = null;
	private pagesEl!: HTMLElement;
	private searchResultsEl!: HTMLElement;
	private searchActive = false;

	// Keeps the controls clear of the floating status bar
	private statusBarObserver: ResizeObserver | null = null;

	// Shrinks the album art to fit short panes without scrolling
	private artSizeObserver: ResizeObserver | null = null;

	// Render guards (render() fires on every timeupdate)
	private renderedCoverArt: string | null = null;
	private renderedQueue: Song[] | null = null;
	private renderedIndex = -1;
	private seeking = false;
	private miniSeeking = false;

	constructor(leaf: WorkspaceLeaf, plugin: StereoPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return STEREO_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Stereo";
	}

	getIcon(): string {
		return "boom-box";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("stereo-view");

		// Search
		const searchRow = root.createDiv({ cls: "stereo-search-row" });
		setIcon(searchRow.createSpan({ cls: "stereo-search-icon" }), "search");
		const searchInput = searchRow.createEl("input", {
			cls: "stereo-search-input",
			type: "search",
			attr: {
				placeholder: "Search artists, albums, songs…",
				"aria-label": "Search",
			},
		});

		// Tabs
		const tabBar = root.createDiv({ cls: "stereo-tabs" });
		this.tabButtons.nowPlaying = this.tabButton(tabBar, "Now playing", "nowPlaying");
		this.tabButtons.queue = this.tabButton(tabBar, "Queue", "queue");
		this.tabButtons.library = this.tabButton(tabBar, "Library", "library");

		this.pagesEl = root.createDiv({ cls: "stereo-pages" });
		this.pages.nowPlaying = this.pagesEl.createDiv({
			cls: "stereo-page stereo-page-scroll",
		});
		this.pages.library = this.pagesEl.createDiv({ cls: "stereo-page" });
		this.pages.queue = this.pagesEl.createDiv({ cls: "stereo-page" });
		this.searchResultsEl = root.createDiv({
			cls: "stereo-search-results stereo-hidden",
		});

		this.buildNowPlaying(this.pages.nowPlaying);
		this.buildQueuePage(this.pages.queue);
		this.buildMiniPlayer(root);
		this.library = this.addChild(new LibraryPane(this.plugin, this.pages.library));
		this.search = new SearchPane(
			this.plugin,
			this.library,
			searchInput,
			this.searchResultsEl,
			{
				onActiveChange: (active) => {
					this.searchActive = active;
					if (active) this.closeVolumePopup();
					this.searchResultsEl.toggleClass("stereo-hidden", !active);
					this.pagesEl.toggleClass("stereo-hidden", active);
					this.updateMiniVisibility();
					this.updateVizRunning();
				},
				openArtist: (id, name) => {
					this.setActiveTab("library");
					this.library.openArtist(id, name);
				},
				openAlbum: (id, name) => {
					this.setActiveTab("library");
					this.library.openAlbum(id, name);
				},
			}
		);

		// The status bar floats over the window's bottom-right corner; watch
		// it so the clearance tracks status items appearing and disappearing.
		const statusBar = document.body.querySelector(".status-bar");
		if (statusBar) {
			this.statusBarObserver = new ResizeObserver(() => {
				this.updateStatusBarClearance();
			});
			this.statusBarObserver.observe(statusBar);
		}
		this.updateStatusBarClearance();

		// Re-fit the art when the page changes height or the track text
		// wraps to a different number of lines.
		this.artSizeObserver = new ResizeObserver(() => {
			this.updateArtSize();
		});
		this.artSizeObserver.observe(this.pages.nowPlaying);
		this.artSizeObserver.observe(this.trackInfoEl);

		this.setActiveTab("nowPlaying");
		this.applyNowPlayingView();
		this.unsubscribe = this.plugin.player.subscribe((state) => {
			this.render(state);
		});
	}

	async onClose(): Promise<void> {
		this.clearVolumeHideTimer();
		this.unregisterVolumeDismissListeners();
		this.removeChild(this.library);
		this.viz.stop();
		this.statusBarObserver?.disconnect();
		this.statusBarObserver = null;
		this.artSizeObserver?.disconnect();
		this.artSizeObserver = null;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.contentEl.empty();
	}

	/** Fires when the leaf is resized or dragged to a new spot in the layout. */
	onResize(): void {
		this.updateStatusBarClearance();
		this.updateArtSize();
	}

	/**
	 * Size the album art to the height left over after the fixed rows, so
	 * shrinking the pane shrinks the art instead of showing a scrollbar.
	 * Below the floor the page scrolls — better a scrollbar than a stamp.
	 */
	private updateArtSize(): void {
		// No upper cap: the art grows to the largest square the pane allows,
		// bounded by width via the CSS `min(92%, …)` rule and by the leftover
		// height measured here. ART_MIN is the floor below which the page scrolls.
		const ART_MIN = 120;
		const page = this.pages.nowPlaying;
		if (!page || page.clientHeight === 0) return;
		let others = 0;
		for (const child of Array.from(page.children)) {
			// The art wrap, lyrics panel and inline queue all flex-grow into the
			// leftover space, so none counts toward the fixed rows we subtract.
			if (
				child === this.artWrap ||
				child === this.lyricsWrap ||
				child === this.nowQueueWrap
			) {
				continue;
			}
			others += (child as HTMLElement).offsetHeight;
		}
		const pageStyle = getComputedStyle(page);
		const gaps =
			(parseFloat(pageStyle.rowGap) || 0) * Math.max(0, page.children.length - 1);
		const wrapStyle = getComputedStyle(this.artWrap);
		const padding =
			(parseFloat(wrapStyle.paddingTop) || 0) +
			(parseFloat(wrapStyle.paddingBottom) || 0);
		const available = page.clientHeight - others - gaps - padding;
		const size = Math.floor(Math.max(ART_MIN, available));
		page.style.setProperty("--stereo-art-size", `${size}px`);
		// Auto-sized lyrics track the pane width, so re-scale on the same pass.
		this.updateLyricsSize();
	}

	/**
	 * Measure how much of this pane the floating status bar covers and expose
	 * it as a CSS variable. Zero when the pane sits anywhere the status bar
	 * does not reach, so the player hugs the pane bottom normally there.
	 */
	private updateStatusBarClearance(): void {
		const statusBar = document.body.querySelector(".status-bar");
		const view = this.contentEl.getBoundingClientRect();
		let clearance = 0;
		if (statusBar instanceof HTMLElement && view.height > 0) {
			const bar = statusBar.getBoundingClientRect();
			const sharesColumn = view.left < bar.right && view.right > bar.left;
			if (sharesColumn && bar.height > 0 && view.bottom > bar.top) {
				clearance = Math.round(view.bottom - bar.top);
			}
		}
		this.contentEl.style.setProperty(
			"--stereo-status-bar-clearance",
			`${clearance}px`
		);
	}

	/** Right-click context menu for switching the Now Playing presentation.
	 * Persists the choice and refreshes every open view, matching the settings
	 * dropdown exactly. */
	private showNowPlayingMenu(evt: MouseEvent): void {
		evt.preventDefault();
		const menu = new Menu();
		const current = this.plugin.settings.nowPlayingView;
		for (const opt of NOW_PLAYING_VIEWS) {
			menu.addItem((item) =>
				item
					.setTitle(opt.label)
					.setIcon(opt.icon)
					.setChecked(opt.value === current)
					.onClick(async () => {
						if (this.plugin.settings.nowPlayingView === opt.value) return;
						this.plugin.settings.nowPlayingView = opt.value;
						await this.plugin.saveSettings();
						this.plugin.refreshNowPlayingViews();
					})
			);
		}
		const coverArt = this.plugin.player.getState().track?.coverArt;
		if (this.plugin.settings.contextualCopyButtons) {
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("Copy cover")
					.setIcon("image")
					.setDisabled(!coverArt)
					.onClick(() => {
						if (coverArt) void this.copyCover(coverArt);
					})
			);
		}
		menu.showAtMouseEvent(evt);
	}

	/** Copy the track cover to the image clipboard. A PNG original is copied
	 * byte-for-byte; other formats (usually JPEG) are decoded and re-encoded
	 * losslessly as PNG, because Chromium's clipboard only accepts PNG. */
	private async copyCover(coverArt: string): Promise<void> {
		let objectUrl: string | null = null;
		try {
			const response = await requestUrl({
				url: this.plugin.client.coverArtUrl(coverArt),
			});
			const bytes = response.arrayBuffer;
			const headerType = (response.headers["content-type"] ?? "")
				.split(";")[0]
				?.trim()
				.toLowerCase() ?? "";
			const type = sniffImageType(bytes) ?? headerType;
			const canCopyOriginal =
				type === "image/png" ||
				(type === "image/jpeg" &&
					typeof ClipboardItem !== "undefined" &&
					typeof ClipboardItem.supports === "function" &&
					ClipboardItem.supports("image/jpeg"));
			if (canCopyOriginal) {
				await this.writeClipboardImage(new Blob([bytes], { type }), type);
				return;
			}

			const source = new Blob([bytes], {
				type: type.startsWith("image/") ? type : "image/jpeg",
			});
			objectUrl = URL.createObjectURL(source);
			const img = await loadImageElement(objectUrl);
			const canvas = document.createElement("canvas");
			canvas.width = Math.max(1, img.naturalWidth);
			canvas.height = Math.max(1, img.naturalHeight);
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("Could not create a 2D canvas.");
			ctx.drawImage(img, 0, 0);
			const png = await canvasToBlob(canvas, "image/png");
			await this.writeClipboardImage(png, "image/png");
		} catch {
			new Notice("Could not copy the cover to the clipboard.");
		} finally {
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		}
	}

	private async writeClipboardImage(blob: Blob, type: string): Promise<void> {
		if (typeof ClipboardItem === "undefined") {
			throw new Error("Image clipboard is not available.");
		}
		await navigator.clipboard.write([
			new ClipboardItem({ [type]: blob }),
		]);
	}

	/** Right-click menu on the track info: copy artist / artist - track /
	 * artist - album - track, plus the cover. Missing fields disable the
	 * relevant entries. */
	private showTrackCopyMenu(evt: MouseEvent): void {
		if (!this.plugin.settings.contextualCopyButtons) return;
		const track = this.plugin.player.getState().track;
		if (!track) return;
		evt.preventDefault();

		const artist = track.artist?.trim() ?? "";
		const title = track.title?.trim() ?? "";
		const album = track.album?.trim() ?? "";
		const entries: { label: string; parts: string[] }[] = [
			{ label: "Copy artist", parts: [artist] },
			{ label: "Copy artist - track", parts: [artist, title] },
			{ label: "Copy artist - album - track", parts: [artist, album, title] },
		];

		const menu = new Menu();
		for (const entry of entries) {
			const text = entry.parts.filter(Boolean).join(" - ");
			const complete = entry.parts.every(Boolean);
			menu.addItem((item) =>
				item
					.setTitle(entry.label)
					.setIcon("copy")
					.setDisabled(!complete)
					.onClick(() => this.copyToClipboard(text))
			);
		}
		const coverArt = track.coverArt;
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Copy cover")
				.setIcon("image")
				.setDisabled(!coverArt)
				.onClick(() => {
					if (coverArt) void this.copyCover(coverArt);
				})
		);
		menu.showAtMouseEvent(evt);
	}

	private copyToClipboard(text: string): void {
		void navigator.clipboard.writeText(text).catch(() => {
			new Notice("Could not copy to the clipboard.");
		});
	}

	/** The effective Now Playing view for a track. Internet-radio streams have no
	 * album art and can't be audio-analysed, so they override the chosen view with
	 * the internet-radio visualization (unless it's set to follow); library tracks
	 * always use the user's choice. Re-evaluated on track change in render(). */
	private effectiveNowPlayingView(track: Song | null): NowPlayingView {
		if (track?.streamUrl) {
			const radio = this.plugin.settings.radioVisualization;
			if (radio !== "follow") return radio;
		}
		return this.plugin.settings.nowPlayingView;
	}

	/** Apply the configured Now Playing view (art shape / visualizer). */
	applyNowPlayingView(): void {
		this.applyLyricsStyle();
		this.syncVolumeControl();
		const state = this.plugin.player.getState();
		this.setEffectiveView(this.effectiveNowPlayingView(state.track));
		this.render(state);
	}

	/** Switch the active presentation (art shape / visualizer mode). Does not
	 * re-render — the caller does — so it's safe to call from render() itself. */
	private setEffectiveView(view: NowPlayingView): void {
		this.nowPlayingView = view;
		const isViz = isVizView(view);
		this.artWrap.toggleClass("stereo-art-wrap-viz", isViz);
		this.artImg.toggleClass("stereo-art-square", view !== "record");
		this.artPlaceholder.toggleClass("stereo-art-square", view !== "record");
		if (isViz) {
			this.viz.setMode(view);
		}
		this.updateVizRunning();
		this.updateTrackCoverVisibility();
	}

	/** The visualizer animates only while it is actually on screen. */
	private updateVizRunning(): void {
		const isViz = isVizView(this.nowPlayingView);
		if (
			isViz &&
			this.activeTab === "nowPlaying" &&
			!this.searchActive &&
			!this.lyricsVisible &&
			!this.queueVisible
		) {
			this.viz.start();
		} else {
			this.viz.stop();
		}
	}

	/** Show the small cover beside the track text whenever the big art is not
	 * visible: lyrics/queue panel open, or a visualizer in the art slot. */
	private updateTrackCoverVisibility(): void {
		const coverArt = this.plugin.player.getState().track?.coverArt;
		const show =
			!!coverArt &&
			(this.lyricsVisible ||
				this.queueVisible ||
				isVizView(this.nowPlayingView));
		this.trackCoverEl.toggleClass("stereo-hidden", !show);
	}

	// --- lyrics ---

	/** Apply configured lyrics font settings as CSS variables. */
	applyLyricsStyle(): void {
		const { lyricsFontFamily, lyricsAlign } = this.plugin.settings;
		this.contentEl.style.setProperty(
			"--stereo-lyrics-font",
			lyricsFontFamily.trim() || "inherit"
		);
		this.contentEl.style.setProperty("--stereo-lyrics-align", lyricsAlign);
		this.updateLyricsSize();
	}

	/** Lyrics text size: either the fixed px setting, or — when auto-adjust is on
	 * — scaled to the pane width so it fills the panel the way the album art
	 * fills its space. Re-run on resize via updateArtSize(). */
	private updateLyricsSize(): void {
		const s = this.plugin.settings;
		let px = s.lyricsFontSize;
		if (s.lyricsAutoSize) {
			const width = this.pages.nowPlaying?.clientWidth ?? 0;
			if (width > 0) {
				// Tunable: font as a fraction of pane width, clamped to a readable range.
				const LYRICS_AUTO_RATIO = 0.05;
				const LYRICS_AUTO_MIN = 14;
				const LYRICS_AUTO_MAX = 40;
				px = Math.round(
					Math.min(LYRICS_AUTO_MAX, Math.max(LYRICS_AUTO_MIN, width * LYRICS_AUTO_RATIO))
				);
			}
		}
		this.contentEl.style.setProperty("--stereo-lyrics-size", `${px}px`);
	}

	/** Swap the art area between the cover/visualizer, lyrics and the inline
	 * queue. The two panels are mutually exclusive. */
	private applyArtPanels(): void {
		const showLyrics = this.lyricsVisible;
		const showQueue = this.queueVisible;
		this.artWrap.toggleClass("stereo-hidden", showLyrics || showQueue);
		this.lyricsWrap.toggleClass("stereo-hidden", !showLyrics);
		this.nowQueueWrap.toggleClass("stereo-hidden", !showQueue);
		this.lyricsButton.toggleClass("stereo-button-active", showLyrics);
		this.queueButton.toggleClass("stereo-button-active", showQueue);
		this.updateVizRunning();
		this.updateTrackCoverVisibility();
		this.updateArtSize();
		if (showLyrics) {
			void this.loadLyrics(this.plugin.player.getState().track);
		}
		if (showQueue) {
			this.renderNowQueue(this.plugin.player.getState(), true);
		}
	}

	private async loadLyrics(track: Song | null): Promise<void> {
		const token = ++this.lyricsToken;
		this.lyricsData = null;
		this.lyricsLineEls = [];
		this.lyricsActiveLine = -1;
		this.lyricsLoadedFor = track?.id ?? null;
		this.lyricsScroll.empty();
		this.lyricsScroll.removeClass("stereo-lyrics-synced");

		if (!track || track.streamUrl) {
			this.lyricsStatus(
				track ? "Lyrics are not available for radio." : "Nothing playing."
			);
			return;
		}

		this.lyricsStatus("Looking for lyrics…");
		const lyrics = await getLyrics(
			this.plugin.client,
			track,
			this.plugin.settings.lyricsOnlineLookup
		);
		if (token !== this.lyricsToken) return;

		this.lyricsScroll.empty();
		if (!lyrics) {
			this.lyricsStatus("No lyrics found for this track.");
			return;
		}

		this.lyricsData = lyrics;
		this.lyricsScroll.toggleClass("stereo-lyrics-synced", lyrics.synced);
		for (const line of lyrics.lines) {
			const el = this.lyricsScroll.createDiv({
				cls: "stereo-lyrics-line",
				// Empty lines keep their height so verses stay visually grouped.
				text: line.text || " ",
			});
			this.registerDomEvent(el, "contextmenu", (evt) => {
				this.showLyricsMenu(evt, line.text);
			});
			if (lyrics.synced && line.time != null) {
				const time = line.time;
				this.registerDomEvent(el, "click", () => {
					// Do not seek when the click finished a text selection.
					const selection = el.ownerDocument.getSelection();
					if (
						selection &&
						!selection.isCollapsed &&
						selection.toString().trim()
					) {
						return;
					}
					this.plugin.player.seek(time);
				});
			}
			this.lyricsLineEls.push(el);
		}
		this.updateLyricsHighlight(this.plugin.player.getState().position, true);
	}

	/** Right-click a lyric line: copy the line (or the current text selection)
	 * or the whole lyrics with an `Artist - Track` header. */
	private showLyricsMenu(evt: MouseEvent, lineText: string): void {
		if (!this.plugin.settings.contextualCopyButtons) return;
		const lyrics = this.lyricsData;
		if (!lyrics) return;
		evt.preventDefault();

		const line = lineText.trim();
		const body = lyrics.lines.map((entry) => entry.text).join("\n");
		const track = this.plugin.player.getState().track;
		const header = [track?.artist?.trim(), track?.title?.trim()]
			.filter(Boolean)
			.join(" - ");
		const fullText = header ? `**${header}**\n\n${body}` : body;

		// A selection inside the lyrics replaces "Copy line" with the selected
		// text, so the menu reflects what the user is about to copy.
		const selection = this.lyricsScroll.ownerDocument.getSelection();
		const selectionInLyrics =
			!!selection &&
			!selection.isCollapsed &&
			((!!selection.anchorNode &&
				this.lyricsScroll.contains(selection.anchorNode)) ||
				(!!selection.focusNode &&
					this.lyricsScroll.contains(selection.focusNode)));
		const selectedText =
			selection && selectionInLyrics ? selection.toString() : "";
		const copyingSelection = selectedText.trim().length > 0;

		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(copyingSelection ? "Copy selection" : "Copy line")
				.setIcon("copy")
				.setDisabled(copyingSelection ? false : !line)
				.onClick(() =>
					this.copyToClipboard(copyingSelection ? selectedText : line)
				)
		);
		menu.addItem((item) =>
			item
				.setTitle("Copy all lyrics")
				.setIcon("copy")
				.setDisabled(!body.trim())
				.onClick(() => this.copyToClipboard(fullText))
		);
		menu.showAtMouseEvent(evt);
	}

	private lyricsStatus(text: string): void {
		this.lyricsScroll.createDiv({ cls: "stereo-lyrics-empty", text });
	}

	/** Highlight and center the line for `position`; runs per timeupdate. */
	private updateLyricsHighlight(position: number, jump: boolean): void {
		const lyrics = this.lyricsData;
		if (!lyrics?.synced) return;

		let index = -1;
		for (let i = 0; i < lyrics.lines.length; i++) {
			const time = lyrics.lines[i]?.time;
			if (time == null) continue;
			if (time <= position + 0.2) index = i;
			else break;
		}
		if (index === this.lyricsActiveLine && !jump) return;

		const previous = this.lyricsLineEls[this.lyricsActiveLine];
		previous?.removeClass("stereo-lyrics-line-active");
		this.lyricsActiveLine = index;
		const current = this.lyricsLineEls[index];
		if (!current) return;
		current.addClass("stereo-lyrics-line-active");

		// Center manually — scrollIntoView would also scroll ancestor panes.
		// Keep the view still while the user is selecting text in the lyrics.
		const selection = this.lyricsScroll.ownerDocument.getSelection();
		const selecting =
			!!selection &&
			!selection.isCollapsed &&
			!!selection.anchorNode &&
			this.lyricsScroll.contains(selection.anchorNode);
		if (!selecting) {
			const target =
				current.offsetTop - this.lyricsScroll.clientHeight / 2 + current.clientHeight / 2;
			this.lyricsScroll.scrollTo({
				top: Math.max(0, target),
				behavior: jump ? "auto" : "smooth",
			});
		}
	}

	// --- construction ---

	private buildNowPlaying(page: HTMLElement): void {
		// Album art / visualizer area (which one shows is a setting)
		this.artWrap = page.createDiv({ cls: "stereo-art-wrap" });
		this.artImg = this.artWrap.createEl("img", {
			cls: "stereo-art",
			attr: { alt: "Album cover" },
		});
		this.artPlaceholder = this.artWrap.createDiv({ cls: "stereo-art-placeholder" });
		setIcon(this.artPlaceholder, "music");
		this.registerDomEvent(this.artImg, "error", () => {
			this.artImg.addClass("stereo-hidden");
			this.artPlaceholder.removeClass("stereo-hidden");
		});
		const vizCanvas = this.artWrap.createEl("canvas", { cls: "stereo-viz" });
		this.viz = new Visualizer(
			vizCanvas,
			() => this.plugin.player.getAnalyser(),
			() => this.plugin.player.getState().playing
		);
		// Right-click the art / visualizer to switch presentation without opening
		// settings. The menu is built from NOW_PLAYING_VIEWS (the same source the
		// settings dropdown uses), so any mode added there shows up here too.
		this.registerDomEvent(this.artWrap, "contextmenu", (evt) =>
			this.showNowPlayingMenu(evt)
		);
		// Base illustrations are bundled into main.js (store installs only
		// receive main.js/manifest.json/styles.css, never loose plugin-folder
		// files) and handed over as data URIs.
		this.viz.setTowerImage(svgDataUri(radioTowerSvg));
		this.viz.setBoomboxImage(svgDataUri(boomboxSvg));
		this.viz.setStereoImage(svgDataUri(stereoBoomboxSvg));

		// Lyrics panel: swaps in for the art area, sized by the same variable.
		this.lyricsWrap = page.createDiv({ cls: "stereo-lyrics-wrap stereo-hidden" });
		this.lyricsScroll = this.lyricsWrap.createDiv({ cls: "stereo-lyrics" });
		// Make Ctrl/Cmd+C work on a plain DOM selection (custom views are not
		// editors, so do not rely on Obsidian's editor clipboard handling).
		this.registerDomEvent(this.lyricsScroll, "copy", (evt) => {
			const selection = this.lyricsScroll.ownerDocument.getSelection();
			const text = selection?.toString() ?? "";
			if (!text || !evt.clipboardData) return;
			evt.clipboardData.setData("text/plain", text);
			evt.preventDefault();
		});

		// Inline queue panel for Now Playing. It shares the art/lyrics slot,
		// but rows are read-only here: click (or Enter/Space) plays an entry.
		this.nowQueueWrap = page.createDiv({ cls: "stereo-now-queue-wrap stereo-hidden" });
		this.nowQueueScroll = this.nowQueueWrap.createDiv({
			cls: "stereo-now-queue",
			attr: { role: "list" },
		});
		const nowQueueRowAt = (target: EventTarget | null): HTMLElement | null => {
			const element = target as Element | null;
			return element?.closest<HTMLElement>(".stereo-now-queue-row") ?? null;
		};
		this.registerDomEvent(this.nowQueueScroll, "click", (evt) => {
			const row = nowQueueRowAt(evt.target);
			if (!row) return;
			const index = Number(row.dataset.queueIndex);
			if (Number.isInteger(index)) void this.plugin.player.playAt(index);
		});
		this.registerDomEvent(this.nowQueueScroll, "keydown", (evt) => {
			if (evt.key !== "Enter" && evt.key !== " ") return;
			const row = nowQueueRowAt(evt.target);
			if (!row) return;
			evt.preventDefault();
			const index = Number(row.dataset.queueIndex);
			if (Number.isInteger(index)) void this.plugin.player.playAt(index);
		});
		this.registerDomEvent(this.nowQueueScroll, "contextmenu", (evt) => {
			const row = nowQueueRowAt(evt.target);
			if (!row) return;
			const index = Number(row.dataset.queueIndex);
			if (!Number.isInteger(index)) return;
			const song = this.plugin.player.getState().queue[index];
			this.showSongCopyMenu(evt, song);
		});

		// Track info — the three lines sit in one tight block. When the big art
		// is hidden (lyrics/queue panels) or replaced by a visualizer, a small
		// cover sits next to the text instead.
		this.trackRowEl = page.createDiv({ cls: "stereo-track-row" });
		this.trackCoverEl = this.trackRowEl.createDiv({
			cls: "stereo-track-cover stereo-hidden",
		});
		this.trackCoverImg = this.trackCoverEl.createEl("img", {
			cls: "stereo-track-cover-img stereo-hidden",
			attr: { alt: "" },
		});
		this.trackCoverPlaceholder = this.trackCoverEl.createDiv({
			cls: "stereo-track-cover-placeholder stereo-hidden",
		});
		setIcon(this.trackCoverPlaceholder, "music");
		this.registerDomEvent(this.trackCoverImg, "error", () => {
			this.trackCoverImg.addClass("stereo-hidden");
			this.trackCoverPlaceholder.removeClass("stereo-hidden");
		});
		this.trackInfoEl = this.trackRowEl.createDiv({ cls: "stereo-track-info" });
		this.titleEl = this.trackInfoEl.createDiv({ cls: "stereo-track-title", text: "Nothing playing" });
		this.artistEl = this.trackInfoEl.createDiv({ cls: "stereo-track-artist" });
		this.albumEl = this.trackInfoEl.createDiv({ cls: "stereo-track-album" });
		this.registerDomEvent(this.artistEl, "click", () => {
			const track = this.plugin.player.getState().track;
			if (!track?.artistId) return;
			this.setActiveTab("library");
			this.library.openArtist(track.artistId, track.artist ?? "");
		});
		this.registerDomEvent(this.albumEl, "click", () => {
			const track = this.plugin.player.getState().track;
			if (!track?.albumId) return;
			this.setActiveTab("library");
			this.library.openAlbum(track.albumId, track.album ?? "");
		});
		this.registerDomEvent(this.trackRowEl, "contextmenu", (evt) =>
			this.showTrackCopyMenu(evt)
		);

		// Seek row: elapsed | slider | −remaining
		const seekRow = page.createDiv({ cls: "stereo-seek-row" });
		this.elapsedEl = seekRow.createDiv({ cls: "stereo-time", text: "0:00" });
		this.seekSlider = seekRow.createEl("input", {
			cls: "stereo-seek",
			type: "range",
			attr: { min: "0", max: "0", step: "1", "aria-label": "Seek" },
		});
		this.remainingEl = seekRow.createDiv({ cls: "stereo-time", text: "0:00" });

		this.registerDomEvent(this.seekSlider, "input", () => {
			this.seeking = true;
			const position = Number(this.seekSlider.value);
			this.elapsedEl.setText(formatTime(position));
			this.setRemaining(position, Number(this.seekSlider.max));
		});
		this.registerDomEvent(this.seekSlider, "change", () => {
			this.plugin.player.seek(Number(this.seekSlider.value));
			this.seeking = false;
		});

		// Transport row
		const transportRow = page.createDiv({ cls: "stereo-transport-row" });
		this.previousButton = this.iconButton(transportRow, "skip-back", "Previous", () => {
			void this.plugin.player.previous();
		});
		this.playButton = this.iconButton(transportRow, "play", "Play or pause", () => {
			void this.plugin.player.togglePlayPause();
		});
		this.playButton.addClass("stereo-play-button");
		this.playButton.addClass("stereo-play-toggle");
		this.nextButton = this.iconButton(transportRow, "skip-forward", "Next", () => {
			void this.plugin.player.next();
		});

		// Extras row: queue · lyrics · random · station · favorite · volume
		// (playback modes live on the queue page — they operate on the queue).
		const extrasRow = page.createDiv({ cls: "stereo-extras-row" });
		this.extrasRow = extrasRow;
		this.queueButton = this.iconButton(extrasRow, "list-music", "Queue", () => {
			this.queueVisible = !this.queueVisible;
			if (this.queueVisible) this.lyricsVisible = false;
			this.applyArtPanels();
		});
		this.lyricsButton = this.iconButton(extrasRow, "mic-vocal", "Lyrics", () => {
			this.lyricsVisible = !this.lyricsVisible;
			if (this.lyricsVisible) this.queueVisible = false;
			this.applyArtPanels();
		});
		this.iconButton(extrasRow, "dices", "Play a random song", () => {
			void (async () => {
				try {
					const songs = await this.plugin.client.getRandomSongs(1);
					const song = songs[0];
					if (!song) {
						new Notice("The server returned no random song.");
						return;
					}
					await this.plugin.player.playTrack(song);
				} catch {
					new Notice("Could not fetch a random song from the server.");
				}
			})();
		});
		this.stationButton = this.iconButton(
			extrasRow,
			"disc-3",
			"Start station from this track",
			() => {
				const track = this.plugin.player.getState().track;
				if (!track || track.streamUrl) return;
				void this.plugin.startStation(
					{
						kind: "song",
						id: track.id,
						label: track.title,
						genre: track.genre,
					},
					track
				);
			}
		);
		this.favoriteButton = this.iconButton(extrasRow, "heart", "Add to favorites", () => {
			const track = this.plugin.player.getState().track;
			if (!track || track.streamUrl) return;
			this.plugin.toggleSongFavorite(track).catch(() => {
				new Notice("Could not update favorites on the server.");
			});
		});

		this.errorEl = page.createDiv({ cls: "stereo-error" });
	}

	/** Create or remove the volume control to match the setting. */
	private syncVolumeControl(): void {
		if (!this.plugin.settings.volumeControl) {
			this.destroyVolumeControl();
			this.plugin.applyVolumeControlSetting();
			return;
		}
		if (!this.volumeControlEl) this.createVolumeControl();
	}

	private createVolumeControl(): void {
		if (this.volumeControlEl || !this.extrasRow) return;
		const control = this.extrasRow.createDiv({ cls: "stereo-volume-control" });
		this.volumeControlEl = control;
		const button = this.iconButton(control, "volume-2", "Volume", () => {
			this.toggleVolumePopup();
		});
		this.volumeButton = button;
		button.setAttribute("aria-haspopup", "true");
		button.setAttribute("aria-expanded", "false");
		const popup = control.createDiv({
			cls: "stereo-volume-popup stereo-hidden",
		});
		this.volumePopup = popup;
		// Decorative triangular track and the slot both live behind the
		// native range input, which stays fully interactive.
		popup.createDiv({ cls: "stereo-volume-rail" });
		popup.createDiv({ cls: "stereo-volume-slot" });
		const slider = popup.createEl("input", {
			cls: "stereo-volume",
			type: "range",
			attr: {
				min: "0",
				max: "100",
				step: "1",
				"aria-label": "Volume",
				"aria-orientation": "vertical",
			},
		});
		this.volumeSlider = slider;
		this.registerDomEvent(slider, "input", () => {
			this.plugin.player.setVolume(Number(slider.value) / 100);
		});
		this.registerVolumeDismissListeners();

		// Wheel over the button or the slider changes volume in 5% steps.
		// Delta is accumulated so trackpads do not race through the range.
		this.registerDomEvent(
			control,
			"wheel",
			(evt) => {
				if (evt.deltaY === 0) return;
				evt.preventDefault();
				if (!popup.hasClass("stereo-hidden")) this.scheduleVolumeHide();
				let delta = evt.deltaY;
				if (evt.deltaMode === 1) delta *= 16;
				else if (evt.deltaMode === 2) delta *= 100;
				this.volumeWheelDelta += delta;
				const steps = Math.trunc(this.volumeWheelDelta / 100);
				if (steps === 0) return;
				this.volumeWheelDelta -= steps * 100;
				const volume = this.plugin.player.getState().volume - steps * 0.05;
				this.plugin.player.setVolume(Math.round(volume * 100) / 100);
				this.openVolumePopup(false);
			},
			{ passive: false }
		);
	}

	private destroyVolumeControl(): void {
		this.clearVolumeHideTimer();
		this.unregisterVolumeDismissListeners();
		this.volumeWheelDelta = 0;
		this.volumeControlEl?.remove();
		this.volumeControlEl = null;
		this.volumeButton = null;
		this.volumePopup = null;
		this.volumeSlider = null;
	}

	/** Close the popover on outside clicks/keys; only while the control exists. */
	private registerVolumeDismissListeners(): void {
		if (this.volumeDismissCleanup) return;
		const doc = this.containerEl.ownerDocument;
		const onPointerDown = (evt: PointerEvent): void => {
			if (!this.volumePopup || this.volumePopup.hasClass("stereo-hidden")) return;
			const target = evt.target as Node | null;
			if (target && this.volumeControlEl?.contains(target)) {
				// Keep it open while the user is grabbing the slider/button.
				this.clearVolumeHideTimer();
				return;
			}
			this.closeVolumePopup();
		};
		const onPointerUp = (): void => {
			if (!this.volumePopup || this.volumePopup.hasClass("stereo-hidden")) return;
			this.scheduleVolumeHide();
		};
		const onPointerCancel = (): void => {
			if (!this.volumePopup || this.volumePopup.hasClass("stereo-hidden")) return;
			this.scheduleVolumeHide();
		};
		const onKeyDown = (evt: KeyboardEvent): void => {
			if (!this.volumePopup || this.volumePopup.hasClass("stereo-hidden")) return;
			if (evt.key === "Escape") {
				this.closeVolumePopup(true);
				return;
			}
			const target = evt.target as Node | null;
			if (target && this.volumeControlEl?.contains(target)) {
				this.scheduleVolumeHide();
			}
		};
		doc.addEventListener("pointerdown", onPointerDown);
		doc.addEventListener("pointerup", onPointerUp);
		doc.addEventListener("pointercancel", onPointerCancel);
		doc.addEventListener("keydown", onKeyDown);
		this.volumeDismissCleanup = () => {
			doc.removeEventListener("pointerdown", onPointerDown);
			doc.removeEventListener("pointerup", onPointerUp);
			doc.removeEventListener("pointercancel", onPointerCancel);
			doc.removeEventListener("keydown", onKeyDown);
		};
	}

	private unregisterVolumeDismissListeners(): void {
		this.volumeDismissCleanup?.();
		this.volumeDismissCleanup = null;
	}

	private toggleVolumePopup(): void {
		if (!this.volumePopup) return;
		if (this.volumePopup.hasClass("stereo-hidden")) {
			this.openVolumePopup();
		} else {
			this.closeVolumePopup();
		}
	}

	private openVolumePopup(focusSlider = true): void {
		if (!this.volumePopup || !this.volumeButton) return;
		this.volumePopup.removeClass("stereo-hidden");
		this.volumeButton.setAttribute("aria-expanded", "true");
		this.volumeButton.addClass("stereo-button-active");
		if (focusSlider) this.volumeSlider?.focus();
		this.scheduleVolumeHide();
	}

	private closeVolumePopup(returnFocus = false): void {
		this.clearVolumeHideTimer();
		if (!this.volumePopup || this.volumePopup.hasClass("stereo-hidden")) return;
		this.volumePopup.addClass("stereo-hidden");
		this.volumeButton?.setAttribute("aria-expanded", "false");
		this.volumeButton?.removeClass("stereo-button-active");
		if (returnFocus) this.volumeButton?.focus();
	}

	/** Hide the popover after three seconds without interaction. */
	private scheduleVolumeHide(): void {
		this.clearVolumeHideTimer();
		this.volumeHideTimer = window.setTimeout(() => {
			this.volumeHideTimer = null;
			const control = this.volumeControlEl;
			if (!control) return;
			// Only hand focus back if focus is still in the control; otherwise
			// auto-hiding must not steal it from wherever the user went.
			const active = control.ownerDocument.activeElement;
			this.closeVolumePopup(control.contains(active));
		}, 3000);
	}

	private clearVolumeHideTimer(): void {
		if (this.volumeHideTimer !== null) {
			window.clearTimeout(this.volumeHideTimer);
			this.volumeHideTimer = null;
		}
	}

	private buildQueuePage(page: HTMLElement): void {
		const header = page.createDiv({ cls: "stereo-queue-header" });
		this.queueTitleEl = header.createSpan({ cls: "stereo-queue-title", text: "Queue" });
		const actions = header.createDiv({ cls: "stereo-queue-actions" });
		// "More" appends another station batch; visible only while one is active.
		this.moreButton = actions.createEl("button", {
			cls: "stereo-button stereo-text-button clickable-icon",
			text: "More",
			attr: { "aria-label": "Add more station tracks" },
		});
		this.registerDomEvent(this.moreButton, "click", async () => {
			this.moreButton.disabled = true;
			try {
				const added = await this.plugin.player.extendStation();
				if (added === 0) {
					new Notice("The station has no more tracks to add.");
				}
			} catch {
				new Notice("Could not fetch more station tracks.");
			} finally {
				this.moreButton.disabled = false;
			}
		});
		this.shuffleButton = this.iconButton(actions, "shuffle", "Shuffle queue", () => {
			this.plugin.player.shuffleQueue();
		});
		this.repeatButton = this.iconButton(actions, "repeat", "Repeat off", () => {
			this.plugin.player.cycleRepeat();
		});
		const saveButton = actions.createEl("button", {
			cls: "stereo-button stereo-text-button clickable-icon",
			text: "Save",
			attr: { "aria-label": "Save queue as playlist" },
		});
		this.registerDomEvent(saveButton, "click", () => {
			this.saveQueueAsPlaylist();
		});
		const clearButton = actions.createEl("button", {
			cls: "stereo-button stereo-text-button clickable-icon",
			text: "Clear",
		});
		this.registerDomEvent(clearButton, "click", () => {
			this.plugin.player.clearQueue();
		});
		this.undoButton = actions.createEl("button", {
			cls: "stereo-button stereo-text-button clickable-icon",
			text: "Undo",
			attr: { "aria-label": "Undo queue replacement or clear" },
		});
		this.registerDomEvent(this.undoButton, "click", () => {
			void this.plugin.player.undoQueue();
		});
		this.queueErrorEl = page.createDiv({ cls: "stereo-error", attr: { role: "status" } });
		this.queueList = page.createDiv({ cls: "stereo-queue-list", attr: { "aria-label": "Queue" } });
		this.registerQueueEvents();
	}

	private registerQueueEvents(): void {
		const rowAt = (target: EventTarget | null): HTMLElement | null =>
			target instanceof Element ? target.closest<HTMLElement>(".stereo-queue-row") : null;
		this.registerDomEvent(this.queueList, "click", (event) => {
			const row = rowAt(event.target);
			if (!row || !(event.target instanceof Element)) return;
			const index = Number(row.dataset.queueIndex);
			if (event.target.closest(".stereo-queue-row-remove")) void this.plugin.player.removeAt(index);
			else if (event.target.closest(".stereo-queue-row-meta")) void this.plugin.player.playAt(index);
		});
		this.registerDomEvent(this.queueList, "contextmenu", (event) => {
			const row = rowAt(event.target);
			if (!row) return;
			event.preventDefault();
			this.showQueueMenu(Number(row.dataset.queueIndex), event);
		});
		this.registerDomEvent(this.queueList, "keydown", (event) => {
			const row = rowAt(event.target);
			if (!row || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
			event.preventDefault();
			const rect = row.getBoundingClientRect();
			this.showQueueMenu(Number(row.dataset.queueIndex), { x: rect.left, y: rect.bottom });
		});
		this.registerDomEvent(this.queueList, "dragstart", (event) => {
			const row = rowAt(event.target);
			if (!row || !event.dataTransfer) return;
			const index = Number(row.dataset.queueIndex);
			this.queueDrag = { queue: this.plugin.player.getState().queue, index };
			event.dataTransfer.effectAllowed = "move";
			event.dataTransfer.setData("text/plain", String(index));
		});
		this.registerDomEvent(this.queueList, "dragover", (event) => {
			if (!this.queueDrag || this.queueDrag.queue !== this.plugin.player.getState().queue) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
			this.clearQueueDropMarker();
			const row = rowAt(event.target) ?? (this.queueList.lastElementChild as HTMLElement | null);
			if (!row) return;
			const rect = row.getBoundingClientRect();
			row.addClass(event.clientY < rect.top + rect.height / 2 ? "stereo-queue-drop-before" : "stereo-queue-drop-after");
			this.queueDropRow = row;
		});
		this.registerDomEvent(this.queueList, "drop", (event) => {
			const drag = this.queueDrag;
			const row = this.queueDropRow;
			if (drag && row && drag.queue === this.plugin.player.getState().queue) {
				event.preventDefault();
				const boundary = Number(row.dataset.queueIndex) + (row.hasClass("stereo-queue-drop-after") ? 1 : 0);
				this.plugin.player.moveQueueEntry(drag.index, boundary > drag.index ? boundary - 1 : boundary);
			}
			this.queueDrag = null;
			this.clearQueueDropMarker();
		});
		this.registerDomEvent(this.queueList, "dragleave", (event) => {
			if (!(event.relatedTarget instanceof Node) || !this.queueList.contains(event.relatedTarget)) this.clearQueueDropMarker();
		});
		this.registerDomEvent(this.queueList, "dragend", () => {
			this.queueDrag = null;
			this.clearQueueDropMarker();
		});
	}

	private clearQueueDropMarker(): void {
		this.queueDropRow?.removeClass("stereo-queue-drop-before", "stereo-queue-drop-after");
		this.queueDropRow = null;
	}

	private showQueueMenu(index: number, position: { x: number; y: number }): void {
		const queue = this.plugin.player.getState().queue;
		const song = queue[index];
		const menu = new Menu();
		menu.addItem((item) => {
			item.setTitle("Move to next").setIcon("list-plus")
				.setDisabled(!this.plugin.player.canMoveToNext(index)).onClick(() => {
					if (this.plugin.player.getState().queue === queue) this.plugin.player.moveToNext(index);
				});
		});
		this.addSongCopyItems(menu, song, true);
		menu.showAtPosition(position);
	}

	/** Right-click a row in the inline Now Playing queue: copy actions only. */
	private showSongCopyMenu(evt: MouseEvent, song: Song | undefined): void {
		if (!this.plugin.settings.contextualCopyButtons || !song) return;
		evt.preventDefault();
		const menu = new Menu();
		this.addSongCopyItems(menu, song, false);
		menu.showAtMouseEvent(evt);
	}

	/** Shared copy entries for queue rows (editor and inline player). */
	private addSongCopyItems(
		menu: Menu,
		song: Song | undefined,
		separator: boolean
	): void {
		if (!this.plugin.settings.contextualCopyButtons) return;
		const artist = song?.artist?.trim() ?? "";
		const title = song?.title?.trim() ?? "";
		const album = song?.album?.trim() ?? "";
		const artistTrack = [artist, title].filter(Boolean).join(" - ");
		const artistAlbumTrack = [artist, album, title].filter(Boolean).join(" - ");
		if (separator) menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Copy artist - track")
				.setIcon("copy")
				.setDisabled(!artist || !title)
				.onClick(() => this.copyToClipboard(artistTrack))
		);
		menu.addItem((item) =>
			item
				.setTitle("Copy artist - album - track")
				.setIcon("copy")
				.setDisabled(!artist || !album || !title)
				.onClick(() => this.copyToClipboard(artistAlbumTrack))
		);
	}

	private buildMiniPlayer(root: HTMLElement): void {
		this.miniEl = root.createDiv({ cls: "stereo-mini" });

		// Top row: cover and track info. Two text lines (title, then artist —
		// album) keep the row the same height as the cover. Artist and album
		// navigate into the library when known.
		const top = this.miniEl.createDiv({ cls: "stereo-mini-top" });
		const thumb = top.createDiv({ cls: "stereo-mini-thumb" });
		this.miniThumbImg = thumb.createEl("img", {
			cls: "stereo-mini-cover stereo-hidden",
			attr: { alt: "" },
		});
		this.miniThumbPlaceholder = thumb.createDiv({
			cls: "stereo-mini-cover stereo-mini-cover-empty",
		});
		setIcon(this.miniThumbPlaceholder, "music");

		// Clicking the track info opens the full player.
		const meta = top.createDiv({ cls: "stereo-mini-meta" });
		this.miniTitleEl = meta.createDiv({
			cls: "stereo-mini-title",
			text: "Nothing playing",
		});
		const byline = meta.createDiv({ cls: "stereo-mini-byline" });
		this.miniArtistEl = byline.createSpan({ cls: "stereo-mini-artist" });
		this.miniSepEl = byline.createSpan({
			cls: "stereo-mini-sep stereo-hidden",
			text: "—",
		});
		this.miniAlbumEl = byline.createSpan({ cls: "stereo-mini-album" });
		this.registerDomEvent(meta, "click", () => {
			this.setActiveTab("nowPlaying");
		});
		this.registerDomEvent(meta, "contextmenu", (evt) =>
			this.showTrackCopyMenu(evt)
		);
		this.registerDomEvent(this.miniArtistEl, "click", (evt) => {
			const track = this.plugin.player.getState().track;
			if (!track?.artistId) return;
			evt.stopPropagation();
			this.setActiveTab("library");
			this.library.openArtist(track.artistId, track.artist ?? "");
		});
		this.registerDomEvent(this.miniAlbumEl, "click", (evt) => {
			const track = this.plugin.player.getState().track;
			if (!track?.albumId) return;
			evt.stopPropagation();
			this.setActiveTab("library");
			this.library.openAlbum(track.albumId, track.album ?? "");
		});

		// Like sits on the right edge of the top row, sized like the mini
		// transport skips.
		this.miniFavoriteButton = this.iconButton(
			top,
			"heart",
			"Add to favorites",
			() => {
				const track = this.plugin.player.getState().track;
				if (!track || track.streamUrl) return;
				this.plugin.toggleSongFavorite(track).catch(() => {
					new Notice("Could not update favorites on the server.");
				});
			}
		);
		this.miniFavoriteButton.addClass("stereo-mini-heart");

		// Bottom row: elapsed · seek · transport.
		const bottom = this.miniEl.createDiv({ cls: "stereo-mini-bottom" });
		this.miniElapsedEl = bottom.createDiv({
			cls: "stereo-time stereo-mini-time",
			text: "0:00",
		});
		this.miniSeekSlider = bottom.createEl("input", {
			cls: "stereo-seek stereo-mini-seek",
			type: "range",
			attr: { min: "0", max: "0", step: "1", "aria-label": "Seek" },
		});
		this.registerDomEvent(this.miniSeekSlider, "input", () => {
			this.miniSeeking = true;
			this.miniElapsedEl.setText(
				formatTime(Number(this.miniSeekSlider.value))
			);
		});
		this.registerDomEvent(this.miniSeekSlider, "change", () => {
			this.plugin.player.seek(Number(this.miniSeekSlider.value));
			this.miniSeeking = false;
		});
		this.miniPreviousButton = this.iconButton(bottom, "skip-back", "Previous", () => {
			void this.plugin.player.previous();
		});
		this.miniPreviousButton.addClass("stereo-mini-skip");
		this.miniPlayButton = this.iconButton(bottom, "play", "Play or pause", () => {
			void this.plugin.player.togglePlayPause();
		});
		this.miniPlayButton.addClass("stereo-play-toggle");
		this.miniNextButton = this.iconButton(bottom, "skip-forward", "Next", () => {
			void this.plugin.player.next();
		});
		this.miniNextButton.addClass("stereo-mini-skip");
	}

	private saveQueueAsPlaylist(): void {
		// Radio entries are live streams, not server tracks — leave them out.
		const songIds = this.plugin.player
			.getState()
			.queue.filter((song) => !song.streamUrl)
			.map((song) => song.id);
		if (songIds.length === 0) {
			new Notice("The queue has no tracks to save.");
			return;
		}
		new PlaylistNameModal(this.app, (name) => {
			this.plugin.client
				.createPlaylist(name, songIds)
				.then(() => {
					new Notice(`Saved "${name}" with ${songIds.length} tracks.`);
					this.library.invalidatePlaylists();
				})
				.catch(() => {
					new Notice("Could not save the playlist on the server.");
				});
		}).open();
	}

	private tabButton(parent: HTMLElement, label: string, tab: TabId): HTMLButtonElement {
		const button = parent.createEl("button", {
			cls: "stereo-tab clickable-icon",
			text: label,
		});
		this.registerDomEvent(button, "click", () => {
			this.setActiveTab(tab);
		});
		return button;
	}

	private setActiveTab(tab: TabId): void {
		// Picking a tab always returns to the pages, ending any active search.
		this.closeVolumePopup();
		this.search?.close();
		this.activeTab = tab;
		for (const id of TAB_IDS) {
			this.pages[id].toggleClass("stereo-page-active", id === tab);
			this.tabButtons[id]?.toggleClass("stereo-tab-active", id === tab);
		}
		this.updateMiniVisibility();
		this.updateVizRunning();
		this.updateArtSize();
		if (tab === "nowPlaying" && this.queueVisible) {
			const index = this.plugin.player.getState().index;
			requestAnimationFrame(() => this.centerNowQueue(index));
		}
		if (tab === "queue") {
			requestAnimationFrame(() => this.centerQueueEditor());
		}
	}

	/** The mini player shows on every screen except the full player. */
	private updateMiniVisibility(): void {
		const showMini = this.activeTab !== "nowPlaying" || this.searchActive;
		this.miniEl.toggleClass("stereo-hidden", !showMini);
	}

	private iconButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void
	): HTMLButtonElement {
		// `clickable-icon` is Obsidian's native flat icon-button treatment —
		// no card chrome, themes style it consistently.
		const button = parent.createEl("button", {
			cls: "stereo-button clickable-icon",
			attr: { "aria-label": label },
		});
		setIcon(button, icon);
		this.registerDomEvent(button, "click", onClick);
		return button;
	}

	// --- rendering ---

	/** Right-hand seek time counts down; empty duration shows a plain 0:00. */
	private setRemaining(position: number, duration: number): void {
		this.remainingEl.setText(
			duration > 0 ? `-${formatTime(duration - position)}` : "0:00"
		);
	}

	private render(state: Readonly<PlayerState>): void {
		// Radio streams override the chosen view with the radio visualizer; snap
		// back to the user's choice for library tracks. Re-evaluated here so a
		// track change (which emits state) switches the presentation automatically.
		const effective = this.effectiveNowPlayingView(state.track);
		if (effective !== this.nowPlayingView) {
			this.setEffectiveView(effective);
		}

		this.renderArt(state);

		this.titleEl.setText(state.track?.title ?? "Nothing playing");
		this.artistEl.setText(state.track?.artist ?? "");
		this.albumEl.setText(state.track?.album ?? "");
		this.artistEl.toggleClass("stereo-link", !!state.track?.artistId);
		this.albumEl.toggleClass("stereo-link", !!state.track?.albumId);

		setIcon(this.playButton, state.playing ? "pause" : "play");
		this.playButton.toggleClass("stereo-playing", state.playing);
		this.playButton.disabled = !state.track;
		this.miniTitleEl.setText(state.track?.title ?? "Nothing playing");
		this.miniArtistEl.setText(state.track?.artist ?? "");
		this.miniAlbumEl.setText(state.track?.album ?? "");
		this.miniArtistEl.toggleClass("stereo-mini-link", !!state.track?.artistId);
		this.miniAlbumEl.toggleClass("stereo-mini-link", !!state.track?.albumId);
		this.miniSepEl.toggleClass(
			"stereo-hidden",
			!state.track?.artist || !state.track?.album
		);
		this.miniSeekSlider.max = String(Math.floor(state.duration));
		this.miniSeekSlider.disabled = !state.track || state.duration <= 0;
		if (!this.miniSeeking) {
			this.miniSeekSlider.value = String(Math.floor(state.position));
			this.miniElapsedEl.setText(formatTime(state.position));
		}
		setIcon(this.miniPlayButton, state.playing ? "pause" : "play");
		this.miniPlayButton.toggleClass("stereo-playing", state.playing);
		this.miniPlayButton.disabled = !state.track;
		this.miniPreviousButton.disabled = !state.track;
		this.miniNextButton.disabled = !this.plugin.player.canNext();
		this.miniFavoriteButton.disabled = !state.track || !!state.track.streamUrl;
		this.miniFavoriteButton.toggleClass(
			"stereo-button-active",
			!!state.track?.starred
		);
		this.miniFavoriteButton.setAttribute(
			"aria-label",
			state.track?.starred ? "Remove from favorites" : "Add to favorites"
		);
		this.favoriteButton.disabled = !state.track || !!state.track.streamUrl;
		this.favoriteButton.toggleClass("stereo-button-active", !!state.track?.starred);
		this.favoriteButton.setAttribute(
			"aria-label",
			state.track?.starred ? "Remove from favorites" : "Add to favorites"
		);
		this.previousButton.disabled = !state.track;
		this.nextButton.disabled = !this.plugin.player.canNext();
		this.shuffleButton.disabled = state.queue.length < 2;
		const repeatLabel = `Repeat ${state.repeat}`;
		setIcon(this.repeatButton, state.repeat === "track" ? "repeat-1" : "repeat");
		this.repeatButton.toggleClass("stereo-button-active", state.repeat !== "off");
		this.repeatButton.setAttribute("aria-label", repeatLabel);
		this.repeatButton.setAttribute("aria-pressed", String(state.repeat !== "off"));
		this.repeatButton.setAttribute("title", repeatLabel);
		this.stationButton.disabled = !state.track || !!state.track.streamUrl;
		this.stationButton.toggleClass("stereo-button-active", !!state.station);

		if (this.lyricsVisible) {
			if ((state.track?.id ?? null) !== this.lyricsLoadedFor) {
				void this.loadLyrics(state.track);
			} else {
				this.updateLyricsHighlight(state.position, false);
			}
		}

		this.queueTitleEl.setText(
			state.station ? `Station: ${state.station.label}` : "Queue"
		);
		this.moreButton.toggleClass("stereo-hidden", !state.station);
		this.undoButton.disabled = !state.canUndo;
		this.queueErrorEl.setText(state.error ?? "");
		this.queueErrorEl.toggleClass("stereo-error-visible", state.error != null);

		this.seekSlider.max = String(Math.floor(state.duration));
		if (!this.seeking) {
			this.seekSlider.value = String(Math.floor(state.position));
			this.elapsedEl.setText(formatTime(state.position));
			this.setRemaining(state.position, state.duration);
		}

		if (this.volumeSlider && this.volumePopup) {
			this.volumeSlider.value = String(Math.round(state.volume * 100));
			this.volumePopup.style.setProperty(
				"--stereo-volume-level",
				`${Math.round(state.volume * 100)}%`
			);
			this.volumePopup.style.setProperty(
				"--stereo-volume-ratio",
				String(state.volume)
			);
		}

		this.errorEl.setText(state.error ?? "");
		this.errorEl.toggleClass("stereo-error-visible", state.error != null);

		this.artImg.toggleClass(
			"stereo-art-spinning",
			state.playing && this.nowPlayingView === "record"
		);

		// Rebuild the queue list only when the queue or current index changes —
		// render() fires on every timeupdate.
		if (state.queue !== this.renderedQueue || state.index !== this.renderedIndex) {
			this.renderedQueue = state.queue;
			this.renderedIndex = state.index;
			this.renderQueue(state);
			if (this.queueVisible) this.renderNowQueue(state, true);
		}
	}

	/** Compact, read-only queue shown in place of the album art. */
	private renderNowQueue(
		state: Readonly<PlayerState>,
		center: boolean
	): void {
		const list = this.nowQueueScroll;
		list.empty();
		if (state.queue.length === 0) {
			list.removeAttribute("role");
			list.createDiv({ cls: "stereo-queue-empty", text: "The queue is empty." });
			return;
		}

		list.setAttribute("role", "list");
		state.queue.forEach((song, i) => {
			const row = list.createDiv({
				cls: "stereo-queue-row stereo-now-queue-row",
				attr: { role: "listitem" },
			});
			row.dataset.queueIndex = String(i);
			row.tabIndex = 0;
			row.toggleClass("stereo-queue-row-current", i === state.index);
			row.setAttribute("aria-label", `${i + 1}. ${song.title}. Play.`);
			row.createDiv({ cls: "stereo-queue-row-number", text: String(i + 1) });
			const meta = row.createDiv({ cls: "stereo-queue-row-meta" });
			meta.createDiv({ cls: "stereo-queue-row-title", text: song.title });
			meta.createDiv({ cls: "stereo-queue-row-artist", text: song.artist ?? "" });
		});

		if (center && state.index >= 0) {
			const index = state.index;
			requestAnimationFrame(() => this.centerNowQueue(index));
		}
	}

	/** Put the current row about a third of the way down the panel, leaving
	 * the upcoming queue visible below it. */
	private centerNowQueue(index: number): void {
		if (!this.queueVisible) return;
		const list = this.nowQueueScroll;
		if (!list || list.clientHeight === 0) return;
		const rows = list.querySelectorAll<HTMLElement>(".stereo-now-queue-row");
		const row = rows[index];
		if (!row) return;
		const listRect = list.getBoundingClientRect();
		const rowRect = row.getBoundingClientRect();
		const rowTop = rowRect.top - listRect.top + list.scrollTop;
		const target = rowTop - listRect.height / 3 + rowRect.height / 2;
		list.scrollTo({ top: Math.max(0, target), behavior: "auto" });
	}

	/** Same one-third positioning for the full Queue editor tab. */
	private centerQueueEditor(): void {
		const list = this.queueList;
		if (!list || list.clientHeight === 0) return;
		const row = list.querySelector<HTMLElement>(".stereo-queue-row-current");
		if (!row) return;
		const listRect = list.getBoundingClientRect();
		const rowRect = row.getBoundingClientRect();
		const rowTop = rowRect.top - listRect.top + list.scrollTop;
		const target = rowTop - listRect.height / 3 + rowRect.height / 2;
		list.scrollTo({ top: Math.max(0, target), behavior: "auto" });
	}

	private renderArt(state: Readonly<PlayerState>): void {
		const coverArt = state.track?.coverArt ?? null;
		if (coverArt === this.renderedCoverArt) return;
		this.renderedCoverArt = coverArt;

		if (!coverArt) {
			this.artImg.addClass("stereo-hidden");
			this.artImg.removeAttribute("src");
			this.artPlaceholder.removeClass("stereo-hidden");
			this.miniThumbImg.addClass("stereo-hidden");
			this.miniThumbImg.removeAttribute("src");
			this.miniThumbPlaceholder.removeClass("stereo-hidden");
			this.trackCoverImg.addClass("stereo-hidden");
			this.trackCoverImg.removeAttribute("src");
			this.trackCoverPlaceholder.removeClass("stereo-hidden");
			this.viz.setCoverImage(null);
			this.updateTrackCoverVisibility();
			return;
		}
		this.artImg.removeClass("stereo-hidden");
		this.artPlaceholder.addClass("stereo-hidden");
		this.artImg.src = this.plugin.client.coverArtUrl(coverArt, 600);
		// Feed the album-art bars view the same cover (masked, never read back).
		this.viz.setCoverImage(this.plugin.client.coverArtUrl(coverArt, 600));
		this.miniThumbImg.removeClass("stereo-hidden");
		this.miniThumbPlaceholder.addClass("stereo-hidden");
		this.miniThumbImg.src = this.plugin.client.coverArtUrl(coverArt, 120);
		this.trackCoverImg.removeClass("stereo-hidden");
		this.trackCoverPlaceholder.addClass("stereo-hidden");
		this.trackCoverImg.src = this.plugin.client.coverArtUrl(coverArt, 200);
		this.updateTrackCoverVisibility();
	}

	private renderQueue(state: Readonly<PlayerState>): void {
		this.queueDrag = null;
		this.clearQueueDropMarker();
		this.queueList.empty();
		if (state.queue.length === 0) {
			// The empty message is not a list item, so the list role goes with it.
			this.queueList.removeAttribute("role");
			this.queueList.createDiv({
				cls: "stereo-queue-empty",
				text: "The queue is empty.",
			});
			return;
		}
		this.queueList.setAttribute("role", "list");
		state.queue.forEach((song, i) => {
			const row = this.queueList.createDiv({ cls: "stereo-queue-row", attr: { role: "listitem" } });
			row.dataset.queueIndex = String(i);
			row.draggable = true;
			row.tabIndex = 0;
			row.setAttribute("aria-label", `${i + 1}. ${song.title}. Drag to reorder or open the context menu.`);
			const handle = row.createSpan({ cls: "stereo-queue-drag-handle", attr: { "aria-hidden": "true" } });
			setIcon(handle, "grip-vertical");
			row.toggleClass("stereo-queue-row-current", i === state.index);

			// Queue position (1-based) — not the album track number.
			row.createDiv({ cls: "stereo-queue-row-number", text: String(i + 1) });

			const meta = row.createDiv({ cls: "stereo-queue-row-meta" });
			meta.createDiv({ cls: "stereo-queue-row-title", text: song.title });
			meta.createDiv({ cls: "stereo-queue-row-artist", text: song.artist ?? "" });

			const removeButton = row.createEl("button", {
				cls: "stereo-button clickable-icon stereo-queue-row-remove",
				attr: { "aria-label": "Remove from queue" },
			});
			setIcon(removeButton, "x");
		});
		if (this.activeTab === "queue") {
			requestAnimationFrame(() => this.centerQueueEditor());
		}
	}
}

function formatTime(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${minutes}:${String(rest).padStart(2, "0")}`;
}
