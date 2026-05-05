/** Non-React playback clock driven by requestAnimationFrame.
 *
 * Owns the current virtual time and emits ticks; React components subscribe
 * via callbacks and update at their own (throttled) cadence.
 */

export interface ClockTick {
    timeSec: number
    frame: number
}

export class PlaybackClock {
    private playing = false
    private speed = 1
    private timeSec = 0
    private duration = 0
    private timestamps: number[] = []
    private rafHandle: number | null = null
    private lastWallMs = 0
    private subscribers = new Set<(t: ClockTick) => void>()
    private playingSubscribers = new Set<(playing: boolean) => void>()

    setTimeline(timestamps: number[]): void {
        this.timestamps = timestamps
        this.duration = timestamps.length ? timestamps[timestamps.length - 1] - timestamps[0] : 0
        this.timeSec = timestamps.length ? timestamps[0] : 0
        this.emit()
    }

    play(): void {
        if (this.playing || this.timestamps.length === 0) return
        this.setPlayingFlag(true)
        this.lastWallMs = performance.now()
        this.tick(this.lastWallMs)
    }

    pause(): void {
        this.setPlayingFlag(false)
        if (this.rafHandle !== null) {
            cancelAnimationFrame(this.rafHandle)
            this.rafHandle = null
        }
    }

    setSpeed(speed: number): void {
        this.speed = speed
    }

    scrubTo(seconds: number): void {
        if (this.timestamps.length === 0) return
        const t0 = this.timestamps[0]
        const tEnd = this.timestamps[this.timestamps.length - 1]
        this.timeSec = Math.max(t0, Math.min(tEnd, seconds))
        this.emit()
    }

    isPlaying(): boolean {
        return this.playing
    }

    getDuration(): number {
        return this.duration
    }

    getTimeSec(): number {
        return this.timeSec
    }

    subscribe(cb: (t: ClockTick) => void): () => void {
        this.subscribers.add(cb)
        return () => {
            this.subscribers.delete(cb)
        }
    }

    subscribePlaying(cb: (playing: boolean) => void): () => void {
        this.playingSubscribers.add(cb)
        return () => {
            this.playingSubscribers.delete(cb)
        }
    }

    private setPlayingFlag(playing: boolean): void {
        if (this.playing === playing) return
        this.playing = playing
        for (const cb of this.playingSubscribers) cb(playing)
    }

    private tick = (now: number): void => {
        if (!this.playing) return
        const dt = (now - this.lastWallMs) / 1000
        this.lastWallMs = now
        this.timeSec += dt * this.speed
        const tEnd = this.timestamps[this.timestamps.length - 1]
        if (this.timeSec >= tEnd) {
            this.timeSec = tEnd
            this.rafHandle = null
            this.setPlayingFlag(false)
            this.emit()
            return
        }
        this.emit()
        this.rafHandle = requestAnimationFrame(this.tick)
    }

    private emit(): void {
        const frame = locateFrame(this.timestamps, this.timeSec)
        const tick: ClockTick = { timeSec: this.timeSec, frame }
        for (const cb of this.subscribers) cb(tick)
    }
}

/** Binary search: largest i such that timestamps[i] <= t. */
export function locateFrame(timestamps: number[], t: number): number {
    if (timestamps.length === 0) return 0
    let lo = 0
    let hi = timestamps.length - 1
    if (t <= timestamps[lo]) return lo
    if (t >= timestamps[hi]) return hi
    while (lo + 1 < hi) {
        const mid = (lo + hi) >>> 1
        if (timestamps[mid] <= t) lo = mid
        else hi = mid
    }
    return lo
}
