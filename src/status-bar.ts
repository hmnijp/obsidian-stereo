import { Menu, Notice, setIcon } from "obsidian";
import { copyCoverToClipboard } from "./cover-clipboard";
import { LyricsPanel } from "./lyrics-panel";
import type StereoPlugin from "./main";
import { albumLabel, songMeta } from "./metadata";
import { PlaylistSharePickerModal } from "./modals";
import { WHEEL_SEEK_SECONDS, type PlayerState } from "./player";
import {
	createStarButtons,
	setStarsDisabled,
	syncStarButtons,
} from "./rating-button";
import { activeServer, serverLabel } from "./servers";
import { normalizeExtrasOrder } from "./settings";
import { shareTargetForPlaylist, shareTargetForSong } from "./share";
import {
	addCopyCoverItem,
	addSongCopyItems,
	addSongExternalItems,
	addSongPlaylistItem,
} from "./song-menu";
import { statusBarPresentation } from "./status-bar-state";
import type { Song } from "./subsonic";

type ServerHealth = "checking" | "ok" | "error";

const QUEUE_ROW_HEIGHT = 30;
const QUEUE_ROW_GAP = 2;
const STATUS_ROWS_MIN = 3;
const STATUS_ROWS_MAX = 20;
const STATUS_ROWS_DEFAULT = 7;

/**
 * Obsidian status-bar play/pause button plus its right-click mini player.
 * Playback state comes from the shared PlayerStore, so this control keeps
 * working even when no Stereo view is open.
 */
export class StatusBarPlayer {
	private plugin: StereoPlugin;
	private item: HTMLElement;
	private button: HTMLButtonElement;
	private transportGroup!: HTMLElement;
	private transportPrevious!: HTMLButtonElement;
	private transportPlay!: HTMLButtonElement;
	private transportNext!: HTMLButtonElement;
	private unsubs: Array<() => void> = [];

	private popup: HTMLElement | null = null;
	private dismiss: (() => void) | null = null;
	private coverImg: HTMLImageElement | null = null;
	private coverPlaceholder: HTMLElement | null = null;
	private titleEl: HTMLElement | null = null;
	private artistEl: HTMLElement | null = null;
	private albumEl: HTMLElement | null = null;
	private renderedCoverArt: string | null = null;
	private seekSlider: HTMLInputElement | null = null;
	private elapsedEl: HTMLElement | null = null;
	private remainingEl: HTMLElement | null = null;
	private seeking = false;
	private repeatButton: HTMLButtonElement | null = null;
	private previousButton: HTMLButtonElement | null = null;
	private playButton: HTMLButtonElement | null = null;
	private nextButton: HTMLButtonElement | null = null;
	private shuffleButton: HTMLButtonElement | null = null;
	private ratingRow: HTMLElement | null = null;
	private starsEl: HTMLElement | null = null;
	private stars: HTMLButtonElement[] = [];
	private favoriteButton: HTMLButtonElement | null = null;
	private queueButton: HTMLButtonElement | null = null;
	private randomButton: HTMLButtonElement | null = null;
	private stationButton: HTMLButtonElement | null = null;
	private playlistButton: HTMLButtonElement | null = null;
	private shareButton: HTMLButtonElement | null = null;
	private navidromeButton: HTMLButtonElement | null = null;
	private downloadButton: HTMLButtonElement | null = null;
	private volumeControl: HTMLElement | null = null;
	private volumeRow: HTMLElement | null = null;
	private volumeSlider: HTMLInputElement | null = null;
	/** Container of the track-action buttons; the order setting is applied here. */
	private extrasMain: HTMLElement | null = null;
	/** Order already applied to `extrasMain`, to skip re-appending every tick. */
	private appliedExtrasOrder = "";
	private queuePanel: HTMLElement | null = null;
	private queueList: HTMLElement | null = null;
	private queueVisible = false;
	private renderedQueue: Song[] | null = null;
	private renderedIndex = -1;
	private lyricsButton: HTMLButtonElement | null = null;
	private lyricsPanelEl: HTMLElement | null = null;
	private lyrics: LyricsPanel | null = null;
	private lyricsVisible = false;
	private serversEl: HTMLElement | null = null;
	private serverList: HTMLElement | null = null;

	private serverHealth: ServerHealth = "checking";
	private healthToken = 0;
	private ratingPending = false;
	private favoritePending = false;

	constructor(plugin: StereoPlugin, item: HTMLElement) {
		this.plugin = plugin;
		this.item = item;
		this.queueVisible = plugin.settings.statusBarQueueOpen === true;
		// The queue and lyrics share the mini player's top slot: at most one is
		// open at a time. A hidden button would leave its panel with no way to
		// close it again, so the saved state is ignored in that case.
		this.queueVisible =
			this.queueVisible && plugin.settings.showQueueButton === true;
		this.lyricsVisible =
			!this.queueVisible &&
			plugin.settings.showLyricsButton === true &&
			plugin.settings.statusBarLyricsOpen === true;
		this.item.addClass("stereo-status-bar-item");
		this.item.setAttribute("aria-haspopup", "true");
		this.item.setAttribute("aria-expanded", "false");

		this.button = this.statusButton(
			this.item,
			"boom-box",
			"Open Stereo",
			() => this.onClick()
		);
		this.transportGroup = this.item.createDiv({
			cls: "stereo-status-transport stereo-hidden",
			attr: { role: "group", "aria-label": "Playback controls" },
		});
		this.transportPrevious = this.statusButton(
			this.transportGroup,
			"skip-back",
			"Previous",
			() => {
				void this.plugin.player.previous();
			}
		);
		this.transportPrevious.addClass("stereo-status-nav");
		this.transportPlay = this.statusButton(
			this.transportGroup,
			"play",
			"Play or pause",
			() => {
				void this.plugin.player.togglePlayPause();
			}
		);
		this.transportPlay.addClass("stereo-play-toggle");
		this.transportNext = this.statusButton(
			this.transportGroup,
			"skip-forward",
			"Next",
			() => {
				void this.plugin.player.next();
			}
		);
		this.transportNext.addClass("stereo-status-nav");

		plugin.registerDomEvent(this.item, "contextmenu", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.togglePopup();
		});

		this.unsubs.push(
			plugin.player.subscribe((state) => {
				this.render(state);
				this.renderPopup();
			})
		);
		this.unsubs.push(plugin.favorites.subscribe(() => this.renderPopup()));
		this.unsubs.push(plugin.ratings.subscribe(() => this.renderPopup()));
		this.unsubs.push(
			plugin.player.availability.subscribe(() => {
				// Verdicts land one probe at a time; rebuild the queue so the
				// rows that were just found missing can dim.
				this.renderedQueue = null;
				this.renderPopup();
			})
		);

		this.setVisible(plugin.settings.showStatusBarPlayer);
		this.render(plugin.player.getState());
	}

	private statusButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void
	): HTMLButtonElement {
		const button = parent.createEl("button", {
			cls: "stereo-status-bar-button clickable-icon",
			attr: {
				type: "button",
				"aria-label": label,
				title: label,
			},
		});
		setIcon(button, icon);
		this.plugin.registerDomEvent(button, "click", (event) => {
			event.preventDefault();
			if (
				!button.disabled &&
				button.getAttribute("aria-disabled") !== "true"
			) {
				onClick();
			}
		});
		return button;
	}

	private setStatusDisabled(
		button: HTMLButtonElement,
		disabled: boolean
	): void {
		// Native `disabled` suppresses context events; the status-bar transport
		// still needs right-click on every button to open the mini player.
		button.setAttribute("aria-disabled", String(disabled));
		button.toggleClass("stereo-status-button-disabled", disabled);
		if (disabled) button.setAttribute("tabindex", "-1");
		else button.removeAttribute("tabindex");
	}

	destroy(): void {
		this.closePopup();
		for (const unsub of this.unsubs) unsub();
		this.unsubs = [];
		this.item.remove();
	}

	setVisible(visible: boolean): void {
		this.item.toggleClass("stereo-hidden", !visible);
		if (!visible) this.closePopup();
	}

	refresh(): void {
		this.render(this.plugin.player.getState());
		this.renderPopup();
		this.applyExtraPanelHeight();
		if (!this.popup) return;
		this.positionPopup();
		if (this.plugin.settings.showStatusBarServers) {
			void this.checkServerHealth();
		}
	}

	render(state: Readonly<PlayerState> = this.plugin.player.getState()): void {
		const transport = this.plugin.settings.showStatusBarTransport;
		this.button.toggleClass("stereo-hidden", transport);
		this.transportGroup.toggleClass("stereo-hidden", !transport);
		if (transport) {
			this.renderTransport(state);
			return;
		}

		const presentation = statusBarPresentation(state);
		setIcon(this.button, presentation.icon);
		this.button.toggleClass("stereo-status-idle", presentation.idle);
		this.button.toggleClass("stereo-play-toggle", !presentation.idle);
		this.button.toggleClass("stereo-playing", presentation.playing);
		this.button.setAttribute("aria-label", presentation.label);
		this.button.setAttribute("title", presentation.label);
		if (presentation.idle) this.button.removeAttribute("aria-pressed");
		else this.button.setAttribute("aria-pressed", String(presentation.playing));
	}

	private renderTransport(state: Readonly<PlayerState>): void {
		const hasTrack = !!state.track;
		this.setStatusDisabled(this.transportPrevious, !hasTrack);
		this.setStatusDisabled(
			this.transportNext,
			!this.plugin.player.canNext()
		);
		this.setStatusDisabled(this.transportPlay, !hasTrack);
		setIcon(this.transportPlay, state.playing ? "pause" : "play");
		this.transportPlay.toggleClass("stereo-playing", state.playing);
		const playLabel = state.playing ? "Pause" : "Play";
		this.transportPlay.setAttribute("aria-label", playLabel);
		this.transportPlay.setAttribute("title", playLabel);
		this.transportPlay.setAttribute(
			"aria-pressed",
			String(state.playing)
		);
		this.transportGroup.setAttribute("aria-label", "Playback controls");
	}

	private onClick(): void {
		const state = this.plugin.player.getState();
		if (!state.track) {
			// An empty queue has nothing to toggle; the idle icon still opens the
			// player in the right sidebar.
			void this.plugin.activateView("right");
			return;
		}
		void this.plugin.player.togglePlayPause();
	}

	// --- popup ---

	/** Open or close the mini player; also the target of the Obsidian command. */
	togglePopup(): void {
		if (this.popup) {
			this.closePopup();
			return;
		}
		this.openPopup();
	}

	private openPopup(): void {
		if (!this.plugin.settings.showStatusBarPlayer) return;

		const popup = document.body.createDiv({ cls: "stereo-status-popup" });
		popup.setAttribute("role", "dialog");
		popup.setAttribute("aria-label", "Stereo mini player");
		popup.tabIndex = -1;
		popup.style.visibility = "hidden";
		this.popup = popup;
		this.item.setAttribute("aria-expanded", "true");
		this.buildPopup(popup);
		this.renderPopup();
		this.positionPopup();
		popup.style.visibility = "";
		void this.checkServerHealth();

		const doc = popup.ownerDocument;
		const win = doc.defaultView ?? window;
		const onPointerDown = (event: PointerEvent): void => {
			const target = event.target as Node | null;
			if (target && (popup.contains(target) || this.item.contains(target))) {
				return;
			}
			this.closePopup();
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			this.closePopup();
		};
		const onResize = (): void => this.closePopup();
		doc.addEventListener("pointerdown", onPointerDown, true);
		doc.addEventListener("keydown", onKeyDown, true);
		win.addEventListener("resize", onResize);
		this.dismiss = () => {
			doc.removeEventListener("pointerdown", onPointerDown, true);
			doc.removeEventListener("keydown", onKeyDown, true);
			win.removeEventListener("resize", onResize);
		};
		popup.focus({ preventScroll: true });
	}

	private closePopup(): void {
		this.healthToken++;
		this.dismiss?.();
		this.dismiss = null;
		this.popup?.remove();
		this.popup = null;
		this.item.setAttribute("aria-expanded", "false");
		this.coverImg = null;
		this.coverPlaceholder = null;
		this.titleEl = null;
		this.artistEl = null;
		this.albumEl = null;
		this.renderedCoverArt = null;
		this.seekSlider = null;
		this.elapsedEl = null;
		this.remainingEl = null;
		this.seeking = false;
		this.repeatButton = null;
		this.previousButton = null;
		this.playButton = null;
		this.nextButton = null;
		this.shuffleButton = null;
		this.ratingRow = null;
		this.starsEl = null;
		this.stars = [];
		this.favoriteButton = null;
		this.queueButton = null;
		this.randomButton = null;
		this.stationButton = null;
		this.playlistButton = null;
		this.shareButton = null;
		this.navidromeButton = null;
		this.downloadButton = null;
		this.volumeControl = null;
		this.volumeRow = null;
		this.volumeSlider = null;
		this.extrasMain = null;
		this.queuePanel = null;
		this.queueList = null;
		this.renderedQueue = null;
		this.renderedIndex = -1;
		this.lyricsButton = null;
		this.lyricsPanelEl = null;
		this.lyrics = null;
		this.serversEl = null;
		this.serverList = null;
		this.serverHealth = "checking";
	}

	private buildPopup(popup: HTMLElement): void {
		this.queuePanel = popup.createDiv({
			cls: "stereo-status-queue stereo-hidden",
			attr: { role: "region", "aria-label": "Queue" },
		});
		this.queueList = this.queuePanel.createDiv({
			cls: "stereo-status-queue-list",
			attr: { role: "list" },
		});
		this.queuePanel.toggleClass("stereo-hidden", !this.queueVisible);

		this.lyricsPanelEl = popup.createDiv({
			cls: "stereo-status-lyrics stereo-hidden",
			attr: { role: "region", "aria-label": "Lyrics" },
		});
		this.lyrics = new LyricsPanel(
			this.plugin,
			this.lyricsPanelEl.createDiv({ cls: "stereo-lyrics" }),
			"top"
		);
		this.lyrics.applyStyle();
		this.lyricsPanelEl.toggleClass("stereo-hidden", !this.lyricsVisible);
		this.applyExtraPanelHeight();

		const header = popup.createDiv({ cls: "stereo-status-header" });
		const cover = header.createDiv({ cls: "stereo-status-cover" });
		this.coverImg = cover.createEl("img", {
			cls: "stereo-status-cover-img stereo-hidden",
			attr: { alt: "" },
		});
		this.coverPlaceholder = cover.createDiv({
			cls: "stereo-status-cover-placeholder",
		});
		setIcon(this.coverPlaceholder, "music");
		this.coverImg.addEventListener("error", () => {
			this.coverImg?.addClass("stereo-hidden");
			this.coverPlaceholder?.removeClass("stereo-hidden");
		});

		const headerText = header.createDiv({
			cls: "stereo-status-header-text",
		});
		cover.addEventListener("contextmenu", (event) => {
			this.showTrackContextMenu(event);
		});
		headerText.addEventListener("contextmenu", (event) => {
			this.showTrackContextMenu(event);
		});
		this.titleEl = headerText.createDiv({
			cls: "stereo-status-popup-title",
		});
		this.artistEl = headerText.createDiv({
			cls: "stereo-status-popup-artist",
			attr: { tabindex: "-1" },
		});
		this.albumEl = headerText.createDiv({
			cls: "stereo-status-popup-album",
			attr: { tabindex: "-1" },
		});
		this.artistEl.addEventListener("click", () => this.openArtist());
		this.albumEl.addEventListener("click", () => this.openAlbum());
		for (const [element, open] of [
			[this.artistEl, () => this.openArtist()],
			[this.albumEl, () => this.openAlbum()],
		] as const) {
			element.addEventListener("keydown", (event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				open();
			});
		}

		const rating = popup.createDiv({
			cls: "stereo-status-popup-row stereo-status-popup-rating",
		});
		this.ratingRow = rating;
		this.starsEl = rating.createDiv({ cls: "stereo-status-stars" });
		this.stars = createStarButtons(this.starsEl, (value) =>
			this.setRating(value)
		);
		this.favoriteButton = this.iconButton(
			rating,
			"heart",
			"Add to favorites",
			() => {
				void this.toggleFavorite();
			}
		);
		this.favoriteButton.addClass("stereo-heart-button");

		const seekRow = popup.createDiv({
			cls: "stereo-seek-row stereo-status-seek-row",
		});
		this.elapsedEl = seekRow.createDiv({
			cls: "stereo-time",
			text: "0:00",
		});
		const seekZone = seekRow.createDiv({ cls: "stereo-seek-zone" });
		this.seekSlider = seekZone.createEl("input", {
			cls: "stereo-seek",
			type: "range",
			attr: {
				min: "0",
				max: "0",
				step: "1",
			},
		});
		this.remainingEl = seekRow.createDiv({
			cls: "stereo-time",
			text: "0:00",
		});
		this.seekSlider.addEventListener("input", () => {
			if (!this.seekSlider) return;
			this.seeking = true;
			const position = Number(this.seekSlider.value);
			this.elapsedEl?.setText(formatTime(position));
			this.setRemaining(position, Number(this.seekSlider.max));
		});
		this.seekSlider.addEventListener("change", () => {
			if (!this.seekSlider) return;
			this.plugin.player.seek(Number(this.seekSlider.value));
			this.seeking = false;
		});
		// Click the timers to jump by the configured step; roll the wheel over
		// the bar to nudge in the same increments.
		this.elapsedEl.addEventListener("click", () => {
			this.seekBy(-this.plugin.settings.seekStep);
		});
		this.remainingEl.addEventListener("click", () => {
			this.seekBy(this.plugin.settings.seekStep);
		});
		seekZone.addEventListener(
			"wheel",
			(event) => {
				event.preventDefault();
				this.seekBy(
					event.deltaY < 0 ? -WHEEL_SEEK_SECONDS : WHEEL_SEEK_SECONDS
				);
			},
			{ passive: false }
		);

		const transport = popup.createDiv({
			cls: "stereo-status-popup-row stereo-status-popup-transport",
		});
		const transportLeft = transport.createDiv({
			cls: "stereo-status-transport-side stereo-status-transport-left",
		});
		this.repeatButton = this.iconButton(
			transportLeft,
			"repeat",
			"Repeat off",
			() => this.plugin.player.cycleRepeat()
		);
		const transportMain = transport.createDiv({
			cls: "stereo-status-transport-main",
		});
		this.previousButton = this.iconButton(
			transportMain,
			"skip-back",
			"Previous",
			() => {
				void this.plugin.player.previous();
			}
		);
		this.playButton = this.iconButton(
			transportMain,
			"play",
			"Play or pause",
			() => {
				void this.plugin.player.togglePlayPause();
			}
		);
		this.playButton.addClass("stereo-play-toggle");
		this.nextButton = this.iconButton(
			transportMain,
			"skip-forward",
			"Next",
			() => {
				void this.plugin.player.next();
			}
		);
		const transportRight = transport.createDiv({
			cls: "stereo-status-transport-side stereo-status-transport-right",
		});
		this.shuffleButton = this.iconButton(
			transportRight,
			"list-ordered",
			"Shuffle off",
			() => this.plugin.player.toggleShuffle()
		);

		const extras = popup.createDiv({
			cls: "stereo-status-popup-row stereo-status-popup-extras",
		});
		const extrasMain = extras.createDiv({
			cls: "stereo-status-extras-main",
		});
		this.extrasMain = extrasMain;
		this.appliedExtrasOrder = "";
		const extrasOpen = extras.createDiv({
			cls: "stereo-status-extras-open",
		});
		this.queueButton = this.iconButton(
			extrasMain,
			"list-music",
			"Queue",
			() => this.toggleQueue()
		);
		this.queueButton.setAttribute("aria-pressed", "false");
		this.lyricsButton = this.iconButton(
			extrasMain,
			"mic-vocal",
			"Lyrics",
			() => this.toggleLyrics()
		);
		this.lyricsButton.setAttribute(
			"aria-pressed",
			String(this.lyricsVisible)
		);
		this.stationButton = this.iconButton(
			extrasMain,
			"disc-3",
			"Start station from this track",
			() => this.startStation()
		);
		this.randomButton = this.iconButton(
			extrasMain,
			"dices",
			"Random play off",
			() => {
				void this.toggleRandom();
			}
		);
		this.playlistButton = this.iconButton(
			extrasMain,
			"list-music",
			"Add to playlist",
			() => this.addToPlaylist()
		);
		this.shareButton = this.iconButton(
			extrasMain,
			"share-2",
			"Share track",
			() => this.shareTrack()
		);
		this.shareButton.setAttribute("aria-haspopup", "menu");
		this.shareButton.addEventListener("contextmenu", (event) => {
			this.showShareMenu(event);
		});
		this.navidromeButton = this.iconButton(
			extrasMain,
			"external-link",
			"Open album in Navidrome",
			() => this.openNavidrome()
		);
		this.downloadButton = this.iconButton(
			extrasMain,
			"download",
			"Download track to clipboard",
			() => this.downloadTrack()
		);
		this.volumeControl = extrasMain.createDiv({
			cls: "stereo-status-volume-control",
		});
		this.iconButton(
			this.volumeControl,
			"volume-2",
			"Volume",
			() => this.toggleVolumeRow()
		);
		this.iconButton(extrasOpen, "panel-right", "Open player", () =>
			this.openPlayer()
		);
		this.iconButton(
			extrasOpen,
			"monitor",
			"Open player in new window",
			() => this.openPlayerInWindow()
		);

		this.volumeRow = popup.createDiv({
			cls: "stereo-status-volume-row stereo-hidden",
		});
		this.volumeSlider = this.volumeRow.createEl("input", {
			cls: "stereo-status-volume-slider",
			type: "range",
			attr: {
				min: "0",
				max: "100",
				step: "1",
				"aria-label": "Volume",
			},
		});
		this.volumeSlider.addEventListener("input", () => {
			if (!this.volumeSlider) return;
			this.plugin.player.setVolume(
				Number(this.volumeSlider.value) / 100
			);
		});

		this.serversEl = popup.createDiv({ cls: "stereo-status-servers" });
		this.serverList = this.serversEl.createDiv({
			cls: "stereo-status-server-list",
		});
		this.serversEl.toggleClass(
			"stereo-hidden",
			!this.plugin.settings.showStatusBarServers
		);
		this.renderServers();
	}

	private setRemaining(position: number, duration: number): void {
		this.remainingEl?.setText(
			duration > 0 ? `-${formatTime(duration - position)}` : "0:00"
		);
	}

	/** Nudge playback by ±step seconds (time-label clicks, seek-bar wheel). */
	private seekBy(delta: number): void {
		const state = this.plugin.player.getState();
		if (!state.track) return;
		this.plugin.player.seek(state.position + delta);
	}

	private statusScale(): number {
		const raw = Number(this.plugin.settings.statusBarScale);
		const value = Number.isFinite(raw) ? raw / 100 : 1;
		return Math.min(2, Math.max(0.5, value));
	}

	private positionPopup(): void {
		const popup = this.popup;
		if (!popup) return;
		const win = popup.ownerDocument.defaultView ?? window;
		const scale = this.statusScale();
		popup.style.setProperty("--stereo-status-scale", String(scale));
		const rect = this.item.getBoundingClientRect();
		const margin = 8;
		const gap = 6;
		const maxVisualWidth = Math.max(1, win.innerWidth - margin * 2);
		const baseWidth = Math.min(280, maxVisualWidth / scale);
		popup.style.width = `${baseWidth}px`;
		const maxVisualHeight = Math.max(1, win.innerHeight - margin * 2);
		popup.style.maxHeight = `${maxVisualHeight / scale}px`;
		const width = popup.offsetWidth * scale;
		const baseHeight = popup.offsetHeight;
		const height = baseHeight * scale;
		const maxLeft = Math.max(margin, win.innerWidth - width - margin);
		const left = Math.min(Math.max(margin, rect.left), maxLeft);
		let top: number;
		if (rect.top - gap - height >= margin) {
			// Bottom edge stays anchored just above the status bar.
			top = rect.top - gap - baseHeight;
		} else if (rect.bottom + gap + height <= win.innerHeight - margin) {
			// No room above: visual top sits just below the status bar.
			top = rect.bottom + gap - baseHeight + height;
		} else {
			top = margin - baseHeight + height;
		}
		popup.style.left = `${Math.round(left)}px`;
		popup.style.top = `${Math.round(top)}px`;
	}

	private iconButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void
	): HTMLButtonElement {
		const button = parent.createEl("button", {
			cls: "stereo-button clickable-icon stereo-status-popup-button",
			attr: {
				type: "button",
				"aria-label": label,
				title: label,
			},
		});
		setIcon(button, icon);
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (!button.disabled) onClick();
		});
		return button;
	}

	private renderPopup(): void {
		if (!this.popup) return;
		const state = this.plugin.player.getState();
		const track = state.track;
		const radio = !!track?.streamUrl;
		const hasTrack = !!track;

		this.serversEl?.toggleClass(
			"stereo-hidden",
			!this.plugin.settings.showStatusBarServers
		);
		// A hidden panel button would leave its panel with no way to close it,
		// so hiding the button closes the panel as well.
		if (!this.plugin.settings.showQueueButton && this.queueVisible) {
			this.setQueueOpen(false);
		}
		if (!this.plugin.settings.showLyricsButton && this.lyricsVisible) {
			this.setLyricsOpen(false);
		}
		this.queueButton?.toggleClass(
			"stereo-hidden",
			!this.plugin.settings.showQueueButton
		);
		this.lyricsButton?.toggleClass(
			"stereo-hidden",
			!this.plugin.settings.showLyricsButton
		);
		if (this.queueVisible) this.renderQueue(state);
		this.queueButton?.toggleClass(
			"stereo-button-active",
			this.queueVisible
		);
		this.queueButton?.setAttribute(
			"aria-pressed",
			String(this.queueVisible)
		);
		if (this.lyricsVisible) {
			this.lyrics?.syncFontSize(this.lyricsPanelEl?.clientWidth ?? 0);
			this.lyrics?.sync(track, state.position);
		}
		this.lyricsButton?.toggleClass(
			"stereo-button-active",
			this.lyricsVisible
		);
		this.lyricsButton?.setAttribute(
			"aria-pressed",
			String(this.lyricsVisible)
		);
		this.renderHeader(track);
		if (this.seekSlider) {
			this.seekSlider.max = String(Math.floor(state.duration));
			this.seekSlider.disabled = !hasTrack || state.duration <= 0;
			if (!this.seeking) {
				this.seekSlider.value = String(Math.floor(state.position));
				this.elapsedEl?.setText(formatTime(state.position));
				this.setRemaining(state.position, state.duration);
			}
		}

		const settings = this.plugin.settings;
		if (this.repeatButton) {
			const repeatLabel =
				state.repeat !== "off" ? `Repeat ${state.repeat}` : "Repeat off";
			setIcon(
				this.repeatButton,
				state.repeat === "track" ? "repeat-1" : "repeat"
			);
			this.repeatButton.toggleClass(
				"stereo-button-active",
				state.repeat !== "off"
			);
			this.repeatButton.toggleClass(
				"stereo-hidden",
				!settings.showRepeatButton
			);
			this.repeatButton.setAttribute("aria-label", repeatLabel);
			this.repeatButton.setAttribute("title", repeatLabel);
			this.repeatButton.setAttribute(
				"aria-pressed",
				String(state.repeat !== "off")
			);
		}

		if (this.shuffleButton) {
			const shuffleLabel = state.shuffle ? "Shuffle on" : "Shuffle off";
			setIcon(
				this.shuffleButton,
				state.shuffle ? "shuffle" : "list-ordered"
			);
			this.shuffleButton.disabled =
				state.random || (state.queue.length < 2 && !state.shuffle);
			this.shuffleButton.toggleClass(
				"stereo-button-active",
				state.shuffle
			);
			this.shuffleButton.toggleClass(
				"stereo-hidden",
				!settings.showShuffleButton
			);
			this.shuffleButton.setAttribute("aria-label", shuffleLabel);
			this.shuffleButton.setAttribute("title", shuffleLabel);
			this.shuffleButton.setAttribute(
				"aria-pressed",
				String(state.shuffle)
			);
		}

		if (this.previousButton) this.previousButton.disabled = !hasTrack;
		if (this.nextButton) {
			this.nextButton.disabled = !this.plugin.player.canNext();
		}
		if (this.playButton) {
			setIcon(this.playButton, state.playing ? "pause" : "play");
			this.playButton.toggleClass("stereo-playing", state.playing);
			this.playButton.disabled = !hasTrack;
			const playLabel = state.playing ? "Pause" : "Play";
			this.playButton.setAttribute("aria-label", playLabel);
			this.playButton.setAttribute("title", playLabel);
			this.playButton.setAttribute(
				"aria-pressed",
				String(state.playing)
			);
		}

		const rating = hasTrack && !radio
			? this.plugin.ratings.rating(track as Song)
			: 0;
		if (this.stars.length > 0) {
			syncStarButtons(
				this.stars,
				rating,
				!hasTrack || radio || this.ratingPending
			);
		}
		// The mini player always keeps the direct five-star + heart row, even
		// when those controls are hidden from the full player's extras row.
		this.ratingRow?.removeClass("stereo-hidden");
		this.starsEl?.removeClass("stereo-hidden");
		this.favoriteButton?.removeClass("stereo-hidden");
		if (this.favoriteButton) {
			const starred = hasTrack
				? this.plugin.favorites.isStarred(track as Song)
				: false;
			this.favoriteButton.disabled =
				!hasTrack || radio || this.favoritePending;
			this.favoriteButton.toggleClass("stereo-button-active", starred);
			const ratingLabel =
				rating > 0 ? `Rating: ${rating} of 5` : "Not rated";
			const label = `${starred ? "Remove from favorites" : "Add to favorites"}. ${ratingLabel}`;
			this.favoriteButton.setAttribute("aria-label", label);
			this.favoriteButton.setAttribute("title", label);
		}

		if (this.randomButton) {
			const randomLabel = state.random
				? "Random play on"
				: "Random play off";
			this.randomButton.toggleClass(
				"stereo-button-active",
				state.random
			);
			this.randomButton.toggleClass(
				"stereo-hidden",
				!settings.showRandomButton
			);
			this.randomButton.setAttribute("aria-label", randomLabel);
			this.randomButton.setAttribute("title", randomLabel);
			this.randomButton.setAttribute(
				"aria-pressed",
				String(state.random)
			);
		}
		if (this.stationButton) {
			this.stationButton.disabled = !hasTrack || radio;
			this.stationButton.toggleClass(
				"stereo-button-active",
				!!state.station
			);
			this.stationButton.toggleClass(
				"stereo-hidden",
				!settings.showStationButton
			);
		}
		if (this.playlistButton) {
			this.playlistButton.disabled = !hasTrack || radio;
			this.playlistButton.toggleClass(
				"stereo-hidden",
				!settings.showPlaylistButton
			);
		}
		if (this.shareButton) {
			const shareVisible =
				settings.sharingEnabled && settings.showShareButton;
			this.shareButton.disabled =
				!shareVisible || !hasTrack || radio;
			this.shareButton.toggleClass("stereo-hidden", !shareVisible);
		}
		if (this.navidromeButton) {
			this.navidromeButton.disabled =
				!hasTrack || radio || !track?.albumId;
			this.navidromeButton.toggleClass(
				"stereo-hidden",
				!settings.showNavidromeButton
			);
		}
		if (this.downloadButton) {
			this.downloadButton.disabled = !hasTrack || radio;
			this.downloadButton.toggleClass(
				"stereo-hidden",
				!settings.showDownloadButton
			);
		}
		if (this.volumeControl) {
			this.volumeControl.toggleClass(
				"stereo-hidden",
				!settings.volumeControl
			);
		}
		if (this.volumeSlider) {
			this.volumeSlider.value = String(Math.round(state.volume * 100));
		}
		if (!settings.volumeControl) {
			this.volumeRow?.addClass("stereo-hidden");
		}
		this.applyExtrasOrder();
	}

	/**
	 * Lay the mini player's track-action buttons out in the same order as the
	 * player pane. The popup-only buttons (open player, open in a new window)
	 * live in their own group on the right and are not part of the order.
	 */
	applyExtrasOrder(): void {
		const main = this.extrasMain;
		if (!main) return;
		const order = normalizeExtrasOrder(this.plugin.settings.extrasOrder);
		const key = order.join("|");
		// renderPopup runs on every player tick; moving nine nodes each time
		// would be wasted work.
		if (key === this.appliedExtrasOrder) return;
		const buttons: Record<string, HTMLElement | null> = {
			queue: this.queueButton,
			lyrics: this.lyricsButton,
			station: this.stationButton,
			random: this.randomButton,
			playlist: this.playlistButton,
			share: this.shareButton,
			navidrome: this.navidromeButton,
			download: this.downloadButton,
			volume: this.volumeControl,
		};
		for (const id of order) {
			const el = buttons[id];
			if (el) main.appendChild(el);
		}
		this.appliedExtrasOrder = key;
	}

	private renderHeader(track: Song | null): void {
		this.titleEl?.setText(
			track?.title?.trim() || (track ? "Untitled" : "Nothing playing")
		);
		this.titleEl?.toggleClass("stereo-status-popup-title-empty", !track);
		this.artistEl?.setText(
			track ? track.artist?.trim() || "Unknown artist" : ""
		);
		this.albumEl?.setText(
			track ? albumLabel(track.album, track.year) : ""
		);

		const artistLink = !!track?.artistId;
		const albumLink = !!track?.albumId;
		this.artistEl?.toggleClass("stereo-link", artistLink);
		this.artistEl?.toggleClass("stereo-hidden", !track);
		this.artistEl?.setAttribute("tabindex", artistLink ? "0" : "-1");
		if (artistLink) this.artistEl?.setAttribute("role", "link");
		else this.artistEl?.removeAttribute("role");
		this.albumEl?.toggleClass("stereo-link", albumLink);
		this.albumEl?.toggleClass("stereo-hidden", !track?.album?.trim());
		this.albumEl?.setAttribute("tabindex", albumLink ? "0" : "-1");
		if (albumLink) this.albumEl?.setAttribute("role", "link");
		else this.albumEl?.removeAttribute("role");

		this.renderCover(track);
	}

	private renderCover(track: Song | null): void {
		const coverArt = track?.coverArt ?? null;
		if (coverArt === this.renderedCoverArt) return;
		this.renderedCoverArt = coverArt;
		if (!coverArt) {
			this.coverImg?.addClass("stereo-hidden");
			this.coverImg?.removeAttribute("src");
			this.coverPlaceholder?.removeClass("stereo-hidden");
			return;
		}
		try {
			const src = this.plugin.client.coverArtUrl(coverArt, 96);
			this.coverImg?.removeClass("stereo-hidden");
			this.coverPlaceholder?.addClass("stereo-hidden");
			if (this.coverImg) this.coverImg.src = src;
		} catch {
			this.coverImg?.addClass("stereo-hidden");
			this.coverImg?.removeAttribute("src");
			this.coverPlaceholder?.removeClass("stereo-hidden");
		}
	}

	private openArtist(): void {
		const track = this.plugin.player.getState().track;
		if (!track?.artistId) return;
		this.closePopup();
		void this.plugin.openArtistInLibrary(
			track.artistId,
			track.artist ?? ""
		);
	}

	private openAlbum(): void {
		const track = this.plugin.player.getState().track;
		if (!track?.albumId) return;
		this.closePopup();
		void this.plugin.openAlbumInLibrary(track.albumId, track.album ?? "");
	}

	private collectionTarget(
		state: Readonly<PlayerState>
	): { kind: "album" | "playlist"; id: string } | null {
		if (state.queueOrigin) {
			return { kind: state.queueOrigin.kind, id: state.queueOrigin.id };
		}
		const albumId = state.track?.albumId;
		return albumId ? { kind: "album", id: albumId } : null;
	}

	private showTrackContextMenu(event: MouseEvent): void {
		const state = this.plugin.player.getState();
		const track = state.track;
		if (!track) return;
		event.preventDefault();
		event.stopPropagation();
		const collection = this.collectionTarget(state);
		const canAddSong = !track.streamUrl;
		const copy = this.plugin.settings.contextualCopyButtons;
		if (!canAddSong && !collection && !copy) return;

		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Add to playlist…")
				.setIcon("list-music")
				.setDisabled(!canAddSong)
				.onClick(() => {
					if (canAddSong) void this.plugin.addToPlaylist([track]);
				})
		);
		menu.addItem((item) =>
			item
				.setTitle(
					collection
						? `Add ${collection.kind} to playlist…`
						: "Add album/playlist to playlist…"
				)
				.setIcon("list-music")
				.setDisabled(!collection)
				.onClick(() => {
					if (collection) {
						void this.plugin.addCollectionToPlaylist(
							collection.kind,
							collection.id
						);
					}
				})
		);
		if (canAddSong) {
			menu.addSeparator();
			addSongExternalItems(menu, this.plugin, track);
		}
		if (copy) {
			menu.addSeparator();
			addSongCopyItems(menu, track, true);
			addCopyCoverItem(menu, track, (coverArt) => {
				void copyCoverToClipboard(this.plugin.client, coverArt);
			});
		}
		menu.showAtMouseEvent(event);
	}

	private showQueueContextMenu(event: MouseEvent, index: number): void {
		const queue = this.plugin.player.getState().queue;
		const song = queue[index];
		if (!song) return;
		event.preventDefault();
		event.stopPropagation();
		const menu = new Menu();
		menu.addItem((item) => {
			item
				.setTitle("Move to next")
				.setIcon("list-plus")
				.setDisabled(!this.plugin.player.canMoveToNext(index))
				.onClick(() => {
					if (this.plugin.player.getState().queue === queue) {
						this.plugin.player.moveToNext(index);
					}
				});
		});
		menu.addSeparator();
		addSongPlaylistItem(menu, this.plugin, song);
		if (!song.streamUrl) {
			menu.addSeparator();
			addSongExternalItems(menu, this.plugin, song);
		}
		if (this.plugin.settings.contextualCopyButtons) {
			menu.addSeparator();
			addSongCopyItems(menu, song);
		}
		menu.showAtMouseEvent(event);
	}

	private setRating(rating: number): void {
		const track = this.plugin.player.getState().track;
		if (!track || track.streamUrl || this.ratingPending) return;
		this.ratingPending = true;
		setStarsDisabled(this.stars, true);
		this.renderPopup();
		void this.plugin
			.toggleSongRating(track, rating)
			.catch(() => {
				new Notice("Could not update the rating on the server.");
			})
			.finally(() => {
				this.ratingPending = false;
				this.renderPopup();
			});
	}

	private async toggleFavorite(): Promise<void> {
		const track = this.plugin.player.getState().track;
		if (!track || track.streamUrl || this.favoritePending) return;
		this.favoritePending = true;
		this.renderPopup();
		try {
			await this.plugin.toggleSongFavorite(track);
		} catch {
			new Notice("Could not update favorites on the server.");
		} finally {
			this.favoritePending = false;
			this.renderPopup();
		}
	}

	private addToPlaylist(): void {
		const track = this.plugin.player.getState().track;
		if (!track || track.streamUrl) return;
		void this.plugin.addToPlaylist([track]);
	}

	private downloadTrack(): void {
		const track = this.plugin.player.getState().track;
		if (!track || track.streamUrl) return;
		void this.plugin.downloadTrack(track);
	}

	private async toggleRandom(): Promise<void> {
		try {
			const ok = await this.plugin.player.toggleRandom();
			if (!ok && this.plugin.player.getState().error) {
				new Notice("Could not fetch a random song from the server.");
			}
		} catch {
			new Notice("Could not toggle random playback.");
		}
	}

	private startStation(): void {
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

	private openNavidrome(): void {
		const track = this.plugin.player.getState().track;
		if (!track || track.streamUrl || !track.albumId) return;
		this.closePopup();
		this.plugin.openNavidromeTrack(track);
	}

	private toggleVolumeRow(): void {
		if (!this.volumeRow) return;
		const opening = this.volumeRow.hasClass("stereo-hidden");
		this.volumeRow.toggleClass("stereo-hidden", !opening);
		if (opening) this.volumeSlider?.focus();
		this.positionPopup();
	}

	/** Show/hide the queue panel, keeping its button and settings in sync. */
	private setQueueOpen(open: boolean): void {
		this.queueVisible = open;
		this.plugin.settings.statusBarQueueOpen = open;
		this.queuePanel?.toggleClass("stereo-hidden", !open);
		this.queueButton?.toggleClass("stereo-button-active", open);
		this.queueButton?.setAttribute("aria-pressed", String(open));
		if (open) {
			this.renderedQueue = null;
			this.renderedIndex = -1;
			this.renderQueue(this.plugin.player.getState());
		}
	}

	/** Show/hide the lyrics panel, keeping its button and settings in sync. */
	private setLyricsOpen(open: boolean): void {
		this.lyricsVisible = open;
		this.plugin.settings.statusBarLyricsOpen = open;
		this.lyricsPanelEl?.toggleClass("stereo-hidden", !open);
		this.lyricsButton?.toggleClass("stereo-button-active", open);
		this.lyricsButton?.setAttribute("aria-pressed", String(open));
		this.applyExtraPanelHeight();
		if (open) {
			this.lyrics?.syncFontSize(this.lyricsPanelEl?.clientWidth ?? 0);
			void this.lyrics?.load(this.plugin.player.getState().track);
		}
	}

	private toggleQueue(): void {
		if (!this.queuePanel) return;
		const opening = !this.queueVisible;
		if (opening) this.setLyricsOpen(false);
		this.setQueueOpen(opening);
		void this.plugin.saveSettings();
		if (!opening) this.positionPopup();
	}

	private toggleLyrics(): void {
		if (!this.lyrics) return;
		const opening = !this.lyricsVisible;
		if (opening) this.setQueueOpen(false);
		this.setLyricsOpen(opening);
		void this.plugin.saveSettings();
		this.positionPopup();
	}

	/** Configured number of rows the queue/lyrics show in the mini player. */
	private extraRows(): number {
		const raw = Number(this.plugin.settings.statusBarExtraRows);
		const rows = Number.isFinite(raw)
			? Math.round(raw)
			: STATUS_ROWS_DEFAULT;
		return Math.min(STATUS_ROWS_MAX, Math.max(STATUS_ROWS_MIN, rows));
	}

	/** Pixel height of the queue's scroll area (and its gap-separated rows). */
	private extraPanelHeight(): number {
		const rows = this.extraRows();
		return rows * QUEUE_ROW_HEIGHT + (rows - 1) * QUEUE_ROW_GAP;
	}

	/** Match the lyrics panel to the queue's height so both fill the slot. */
	private applyExtraPanelHeight(): void {
		this.popup?.style.setProperty(
			"--stereo-status-rows-height",
			`${this.extraPanelHeight()}px`
		);
	}

	/** Re-apply lyrics settings to an open mini player (settings change). */
	applyLyricsSettings(): void {
		this.lyrics?.applyStyle();
		this.lyrics?.syncFontSize(this.lyricsPanelEl?.clientWidth ?? 0);
		if (this.lyricsVisible) {
			void this.lyrics?.load(this.plugin.player.getState().track);
		}
	}

	private markQueueAvailability(row: HTMLElement, song: Song): void {
		if (!this.plugin.player.availability.isMissing(song.id)) return;
		row.addClass("stereo-queue-row-unavailable");
		row.setAttribute("title", "Not available on this server");
		const label = row.getAttribute("aria-label");
		if (label) row.setAttribute("aria-label", `${label} Not available on this server.`);
	}

	private renderQueue(state: Readonly<PlayerState>): void {
		const list = this.queueList;
		if (!list) return;
		if (
			state.queue === this.renderedQueue &&
			state.index === this.renderedIndex
		) {
			return;
		}
		this.renderedQueue = state.queue;
		this.renderedIndex = state.index;
		list.empty();
		if (state.queue.length === 0) {
			list.createDiv({
				cls: "stereo-status-queue-empty",
				text: "Queue is empty",
			});
			this.positionPopup();
			return;
		}
		state.queue.forEach((song, index) => {
			const row = list.createDiv({
				cls: "stereo-status-queue-row",
				attr: { role: "listitem", tabindex: "0" },
			});
			row.dataset.queueIndex = String(index);
			row.toggleClass(
				"stereo-status-queue-current",
				index === state.index
			);
			row.setAttribute(
				"aria-label",
				`${index + 1}. ${song.title}. Play.`
			);
			this.markQueueAvailability(row, song);
			row.createSpan({
				cls: "stereo-status-queue-number",
				text: String(index + 1),
			});
			const meta = row.createDiv({ cls: "stereo-status-queue-meta" });
			meta.createDiv({
				cls: "stereo-status-queue-title",
				text: song.title,
			});
			meta.createDiv({
				cls: "stereo-status-queue-artist",
				text: songMeta(song),
			});
			const play = (): void => {
				void this.plugin.player.playAt(index);
			};
			row.addEventListener("click", play);
			row.addEventListener("keydown", (event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				play();
			});
			row.addEventListener("contextmenu", (event) => {
				this.showQueueContextMenu(event, index);
			});
		});
		this.positionPopup();
		requestAnimationFrame(() => this.scrollQueueCurrent());
	}

	private scrollQueueCurrent(): void {
		const list = this.queueList;
		if (!list) return;
		const row = list.querySelector<HTMLElement>(
			".stereo-status-queue-current"
		);
		if (!row) return;
		const target =
			row.offsetTop - list.clientHeight / 2 + row.offsetHeight / 2;
		list.scrollTop = Math.max(0, target);
	}

	private showShareMenu(event: MouseEvent): void {
		event.preventDefault();
		event.stopPropagation();
		const track = this.plugin.player.getState().track;
		if (
			!track ||
			track.streamUrl ||
			!this.plugin.settings.sharingEnabled ||
			!this.plugin.settings.showShareButton
		) {
			return;
		}
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Share track")
				.setIcon("music")
				.onClick(() => this.shareTrack())
		);
		menu.addItem((item) =>
			item
				.setTitle("Share album")
				.setIcon("disc")
				.setDisabled(!track.albumId)
				.onClick(() => this.shareAlbum())
		);
		menu.addItem((item) =>
			item
				.setTitle("Share artist")
				.setIcon("user")
				.setDisabled(!track.artistId)
				.onClick(() => this.shareArtist())
		);
		menu.addItem((item) =>
			item
				.setTitle("Share playlist…")
				.setIcon("list-music")
				.onClick(() => {
					void this.sharePlaylist();
				})
		);
		menu.showAtMouseEvent(event);
	}

	private shareTrack(): void {
		const track = this.plugin.player.getState().track;
		if (!track || track.streamUrl || !this.plugin.settings.sharingEnabled) {
			return;
		}
		this.closePopup();
		this.plugin.openShare(shareTargetForSong(track));
	}

	private shareAlbum(): void {
		const track = this.plugin.player.getState().track;
		if (
			!track?.albumId ||
			track.streamUrl ||
			!this.plugin.settings.sharingEnabled
		) {
			return;
		}
		this.closePopup();
		this.plugin.openShare({
			kind: "album",
			resourceIds: [track.albumId],
			title: track.album ?? "Album",
			subtitle: ["Album", track.artist].filter(Boolean).join(" · "),
		});
	}

	private shareArtist(): void {
		const track = this.plugin.player.getState().track;
		if (
			!track?.artistId ||
			track.streamUrl ||
			!this.plugin.settings.sharingEnabled
		) {
			return;
		}
		this.closePopup();
		this.plugin.openShare({
			kind: "artist",
			resourceIds: [track.artistId],
			title: track.artist ?? "Artist",
			subtitle: "Artist",
		});
	}

	private async sharePlaylist(): Promise<void> {
		if (!this.plugin.settings.sharingEnabled) return;
		this.closePopup();
		try {
			const playlists = await this.plugin.client.getPlaylists();
			if (playlists.length === 0) {
				new Notice("No playlists found.");
				return;
			}
			new PlaylistSharePickerModal(
				this.plugin.app,
				playlists,
				(playlist) => {
					this.plugin.openShare(shareTargetForPlaylist(playlist));
				}
			).open();
		} catch {
			new Notice("Could not load playlists.");
		}
	}

	private openPlayer(): void {
		this.closePopup();
		void this.plugin.activateView("right");
	}

	private openPlayerInWindow(): void {
		this.closePopup();
		void this.plugin.openPlayerInWindow();
	}

	// --- servers ---

	private async checkServerHealth(): Promise<void> {
		if (!this.popup || !this.plugin.settings.showStatusBarServers) return;
		const token = ++this.healthToken;
		const server = activeServer(this.plugin.settings);
		this.serverHealth = "checking";
		this.renderServers();
		if (!server) {
			this.serverHealth = "ok";
			this.renderServers();
			return;
		}
		try {
			await this.plugin.client.ping();
			if (token !== this.healthToken) return;
			this.serverHealth = "ok";
		} catch {
			if (token !== this.healthToken) return;
			this.serverHealth = "error";
		}
		this.renderServers();
	}

	private renderServers(): void {
		const list = this.serverList;
		if (!list) return;
		list.empty();
		const servers = this.plugin.settings.servers;
		if (servers.length === 0) {
			list.createDiv({
				cls: "stereo-status-server-empty",
				text: "No servers configured.",
			});
			return;
		}

		const activeId = this.plugin.settings.activeServerId;
		for (const server of servers) {
			const active = server.id === activeId;
			const row = list.createDiv({
				cls: "stereo-status-server-row",
				attr: {
					role: "button",
					tabindex: "0",
					"aria-label": `Use ${serverLabel(server)}`,
				},
			});
			row.toggleClass(
				"stereo-status-server-active",
				active && this.serverHealth !== "error"
			);
			row.toggleClass(
				"stereo-status-server-error",
				active && this.serverHealth === "error"
			);
			row.setAttribute("aria-current", active ? "true" : "false");
			row.createSpan({ cls: "stereo-status-server-dot" });
			row.createSpan({
				cls: "stereo-status-server-name",
				text: serverLabel(server),
			});
			const select = (): void => {
				void this.selectServer(server.id);
			};
			row.addEventListener("click", select);
			row.addEventListener("keydown", (event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				select();
			});
		}
		this.applyServerLayout(list);
	}

	/**
	 * Lay the server switchers in a single row when every label fits on one
	 * line, and stack them vertically when the row would overflow.
	 */
	private applyServerLayout(list: HTMLElement): void {
		list.removeClass("stereo-status-servers-inline");
		const rows = Array.from(
			list.querySelectorAll<HTMLElement>(".stereo-status-server-row")
		);
		if (rows.length === 0) return;
		const available = list.clientWidth;
		if (available <= 0) return;
		const listStyle = getComputedStyle(list);
		const listGap = parseFloat(listStyle.columnGap || "0") || 0;
		let needed = listGap * (rows.length - 1);
		for (const row of rows) {
			const rowStyle = getComputedStyle(row);
			const padX =
				(parseFloat(rowStyle.paddingLeft) || 0) +
				(parseFloat(rowStyle.paddingRight) || 0);
			const gap = parseFloat(rowStyle.columnGap || "0") || 0;
			const dot = row.querySelector<HTMLElement>(".stereo-status-server-dot");
			const dotWidth = dot ? dot.getBoundingClientRect().width : 0;
			const name = row.querySelector<HTMLElement>(".stereo-status-server-name");
			needed += padX + dotWidth + gap + (name?.scrollWidth ?? 0);
		}
		if (needed <= available) {
			list.addClass("stereo-status-servers-inline");
		}
	}

	private async selectServer(id: string): Promise<void> {
		if (id === this.plugin.settings.activeServerId) {
			void this.checkServerHealth();
			return;
		}
		try {
			await this.plugin.setActiveServer(id);
		} catch {
			new Notice("Could not switch servers.");
			return;
		}
		this.serverHealth = "checking";
		this.renderServers();
		this.renderPopup();
		void this.checkServerHealth();
	}
}

function formatTime(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${minutes}:${String(rest).padStart(2, "0")}`;
}
