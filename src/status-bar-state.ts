import type { PlayerState } from "./player";

/** What the status-bar button shows for the current player state. */
export interface StatusBarPresentation {
	icon: "boom-box" | "play" | "pause";
	/** No track: the button behaves as "open Stereo", not play/pause. */
	idle: boolean;
	playing: boolean;
	label: string;
}

export function statusBarPresentation(
	state: Pick<PlayerState, "track" | "playing">
): StatusBarPresentation {
	const track = state.track;
	if (!track) {
		return {
			icon: "boom-box",
			idle: true,
			playing: false,
			label: "Open Stereo",
		};
	}

	const artist = track.artist?.trim() ?? "";
	const title = track.title?.trim() || "Untitled";
	const name = artist ? `${artist} - ${title}` : title;
	return {
		icon: state.playing ? "pause" : "play",
		idle: false,
		playing: state.playing,
		label: `${state.playing ? "Pause" : "Play"}: ${name}`,
	};
}
