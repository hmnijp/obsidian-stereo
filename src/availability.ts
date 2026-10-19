import type { SubsonicClient } from "./subsonic";

/** `getSong` probes that may be in flight while sweeping a queue. */
const PROBE_CONCURRENCY = 3;

type Verdict = "present" | "missing";

/**
 * Remembers which track ids the active account still has. Playing a track
 * marks it present, so an ordinary session never probes the server; probes run
 * when a server change leaves an inherited queue behind. The queue UI dims the
 * ids the server no longer knows.
 */
export class AvailabilityStore {
	private client: SubsonicClient;
	private getKey: () => string;
	private key: string;
	private verdicts = new Map<string, Verdict>();
	private pending: string[] = [];
	private active = 0;
	private listeners = new Set<() => void>();

	constructor(client: SubsonicClient, getKey: () => string) {
		this.client = client;
		this.getKey = getKey;
		this.key = getKey();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	isMissing(id: string): boolean { return this.verdicts.get(id) === "missing"; }
	isPresent(id: string): boolean { return this.verdicts.get(id) === "present"; }

	/** A track the server just played: no probe needed for it any more. */
	markPresent(id: string): void {
		if (this.verdicts.get(id) === "present") return;
		this.verdicts.set(id, "present");
		this.forget(id);
	}

	/** A track the server rejected (Subsonic code 70). */
	markMissing(id: string): void {
		if (this.verdicts.get(id) === "missing") return;
		this.verdicts.set(id, "missing");
		this.forget(id);
		this.changed();
	}

	/** Queue probes for ids with no verdict yet; unknown ids are skipped. */
	ensure(ids: readonly string[]): void {
		let queued = false;
		for (const id of ids) {
			if (!id || this.verdicts.has(id) || this.pending.includes(id)) continue;
			this.pending.push(id);
			queued = true;
		}
		if (queued) this.pump();
	}

	/** Drop verdicts when the active account changes. */
	syncKey(): void {
		const key = this.getKey();
		if (key === this.key) return;
		this.key = key;
		this.verdicts.clear();
		this.pending = [];
		this.changed();
	}

	private forget(id: string): void {
		const index = this.pending.indexOf(id);
		if (index >= 0) this.pending.splice(index, 1);
	}

	private pump(): void {
		while (this.active < PROBE_CONCURRENCY && this.pending.length > 0) {
			this.active += 1;
			void this.probe(this.pending.shift() as string);
		}
	}

	private async probe(id: string): Promise<void> {
		const key = this.key;
		try {
			const song = await this.client.getSong(id);
			if (key !== this.key) return;
			if (song) this.verdicts.set(id, "present");
			else {
				this.verdicts.set(id, "missing");
				this.changed();
			}
		} catch {
			// A network or auth failure says nothing about the track: leave it
			// unknown so it keeps its normal look.
		} finally {
			this.active -= 1;
			this.pump();
		}
	}

	private changed(): void {
		for (const listener of this.listeners) listener();
	}
}
