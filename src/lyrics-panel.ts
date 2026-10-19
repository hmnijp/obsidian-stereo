import { Menu, Notice } from "obsidian";
import { getLyrics, type Lyrics } from "./lyrics";
import type StereoPlugin from "./main";
import type { Song } from "./subsonic";

/** Auto-size tunables, shared so the mini player scales like the main one. */
const LYRICS_AUTO_RATIO = 0.05;
const LYRICS_AUTO_MIN = 14;
const LYRICS_AUTO_MAX = 40;

/**
 * Lyrics renderer shared by the main Now Playing view and the status-bar mini
 * player. It owns the scroll element, so both callers get the same font,
 * alignment, online-lookup and synced-highlight behaviour from one place and
 * always honour the same settings.
 */
export class LyricsPanel {
	private plugin: StereoPlugin;
	private scrollEl: HTMLElement;
	private data: Lyrics | null = null;
	private lineEls: HTMLElement[] = [];
	private activeLine = -1;
	private token = 0;
	private loadedFor: string | null = null;

	constructor(plugin: StereoPlugin, scrollEl: HTMLElement) {
		this.plugin = plugin;
		this.scrollEl = scrollEl;
		// Custom views are not editors, so keep Ctrl/Cmd+C working on a plain
		// DOM selection inside the lyrics.
		this.scrollEl.addEventListener("copy", (evt) => {
			const selection = this.scrollEl.ownerDocument.getSelection();
			const text = selection?.toString() ?? "";
			if (!text || !evt.clipboardData) return;
			evt.clipboardData.setData("text/plain", text);
			evt.preventDefault();
		});
	}

	/** Apply the configured lyrics font family and alignment. */
	applyStyle(): void {
		const { lyricsFontFamily, lyricsAlign } = this.plugin.settings;
		this.scrollEl.style.setProperty(
			"--stereo-lyrics-font",
			lyricsFontFamily.trim() || "inherit"
		);
		this.scrollEl.style.setProperty("--stereo-lyrics-align", lyricsAlign);
	}

	/** Resolve the text size: the fixed px value, or one scaled to `width`
	 * when auto-adjust is on — re-run on resize. */
	syncFontSize(width: number): void {
		const s = this.plugin.settings;
		let px = s.lyricsFontSize;
		if (s.lyricsAutoSize && width > 0) {
			px = Math.round(
				Math.min(
					LYRICS_AUTO_MAX,
					Math.max(LYRICS_AUTO_MIN, width * LYRICS_AUTO_RATIO)
				)
			);
		}
		this.scrollEl.style.setProperty("--stereo-lyrics-size", `${px}px`);
	}

	/** Forget the loaded track and empty the panel. */
	reset(): void {
		this.token++;
		this.data = null;
		this.lineEls = [];
		this.activeLine = -1;
		this.loadedFor = null;
		this.scrollEl.empty();
		this.scrollEl.removeClass("stereo-lyrics-synced");
	}

	async load(track: Song | null): Promise<void> {
		const token = ++this.token;
		this.data = null;
		this.lineEls = [];
		this.activeLine = -1;
		this.loadedFor = track?.id ?? null;
		this.scrollEl.empty();
		this.scrollEl.removeClass("stereo-lyrics-synced");

		if (!track || track.streamUrl) {
			this.status(
				track ? "Lyrics are not available for radio." : "Nothing playing."
			);
			return;
		}

		this.status("Looking for lyrics…");
		const lyrics = await getLyrics(
			this.plugin.client,
			track,
			this.plugin.settings.lyricsOnlineLookup
		);
		if (token !== this.token) return;

		this.scrollEl.empty();
		if (!lyrics) {
			this.status("No lyrics found for this track.");
			return;
		}

		this.data = lyrics;
		this.scrollEl.toggleClass("stereo-lyrics-synced", lyrics.synced);
		for (const line of lyrics.lines) {
			const el = this.scrollEl.createDiv({
				cls: "stereo-lyrics-line",
				// Empty lines keep their height so verses stay visually grouped.
				text: line.text || " ",
			});
			el.addEventListener("contextmenu", (evt) =>
				this.showMenu(evt, line.text)
			);
			if (lyrics.synced && line.time != null) {
				const time = line.time;
				el.addEventListener("click", () => {
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
			this.lineEls.push(el);
		}
		this.update(this.plugin.player.getState().position, true);
	}

	/** Load on track change, otherwise just move the synced highlight. */
	sync(track: Song | null, position: number): void {
		if ((track?.id ?? null) !== this.loadedFor) {
			void this.load(track);
		} else {
			this.update(position, false);
		}
	}

	/** Highlight and center the line for `position`; runs per timeupdate. */
	update(position: number, jump: boolean): void {
		const lyrics = this.data;
		if (!lyrics?.synced) return;

		let index = -1;
		for (let i = 0; i < lyrics.lines.length; i++) {
			const time = lyrics.lines[i]?.time;
			if (time == null) continue;
			if (time <= position + 0.2) index = i;
			else break;
		}
		if (index === this.activeLine && !jump) return;

		const previous = this.lineEls[this.activeLine];
		previous?.removeClass("stereo-lyrics-line-active");
		this.activeLine = index;
		const current = this.lineEls[index];
		if (!current) return;
		current.addClass("stereo-lyrics-line-active");

		// Center manually — scrollIntoView would also scroll ancestor panes.
		// Keep the view still while the user is selecting text in the lyrics.
		const selection = this.scrollEl.ownerDocument.getSelection();
		const selecting =
			!!selection &&
			!selection.isCollapsed &&
			!!selection.anchorNode &&
			this.scrollEl.contains(selection.anchorNode);
		if (!selecting) {
			const target =
				current.offsetTop -
				this.scrollEl.clientHeight / 2 +
				current.clientHeight / 2;
			this.scrollEl.scrollTo({
				top: Math.max(0, target),
				behavior: jump ? "auto" : "smooth",
			});
		}
	}

	private status(text: string): void {
		this.scrollEl.createDiv({ cls: "stereo-lyrics-empty", text });
	}

	/** Right-click a lyric line: copy the line (or the current text selection)
	 * or the whole lyrics with an `Artist - Track` header. */
	private showMenu(evt: MouseEvent, lineText: string): void {
		if (!this.plugin.settings.contextualCopyButtons) return;
		const lyrics = this.data;
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
		const selection = this.scrollEl.ownerDocument.getSelection();
		const selectionInLyrics =
			!!selection &&
			!selection.isCollapsed &&
			((!!selection.anchorNode &&
				this.scrollEl.contains(selection.anchorNode)) ||
				(!!selection.focusNode &&
					this.scrollEl.contains(selection.focusNode)));
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
					this.copy(copyingSelection ? selectedText : line)
				)
		);
		menu.addItem((item) =>
			item
				.setTitle("Copy all lyrics")
				.setIcon("copy")
				.setDisabled(!body.trim())
				.onClick(() => this.copy(fullText))
		);
		menu.showAtMouseEvent(evt);
	}

	private copy(text: string): void {
		void navigator.clipboard.writeText(text).catch(() => {
			new Notice("Could not copy to the clipboard.");
		});
	}
}
