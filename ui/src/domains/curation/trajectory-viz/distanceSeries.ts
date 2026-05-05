/** Pure helpers for summarising and visualising the per-frame end-effector
 * distance series. No THREE dependencies — easy to unit test.
 */

export interface DistanceStats {
    min: number
    max: number
    mean: number
    belowCount: number
}

export interface BelowThresholdRange {
    startFrame: number
    endFrame: number
    startTime: number
    endTime: number
}

export function summarizeDistanceSeries(
    series: Float32Array,
    thresholdM: number,
): DistanceStats {
    if (series.length === 0) {
        return { min: 0, max: 0, mean: 0, belowCount: 0 }
    }
    let min = series[0]
    let max = series[0]
    let sum = 0
    let belowCount = 0
    for (let i = 0; i < series.length; i += 1) {
        const v = series[i]
        if (v < min) min = v
        if (v > max) max = v
        sum += v
        if (v < thresholdM) belowCount += 1
    }
    return { min, max, mean: sum / series.length, belowCount }
}

export function buildBelowThresholdRanges(
    series: Float32Array,
    thresholdM: number,
    timeS: number[],
): BelowThresholdRange[] {
    const ranges: BelowThresholdRange[] = []
    let runStart = -1
    for (let i = 0; i < series.length; i += 1) {
        const isBelow = series[i] < thresholdM
        if (isBelow && runStart === -1) {
            runStart = i
        } else if (!isBelow && runStart !== -1) {
            ranges.push(makeRange(runStart, i - 1, timeS))
            runStart = -1
        }
    }
    if (runStart !== -1) {
        ranges.push(makeRange(runStart, series.length - 1, timeS))
    }
    return ranges
}

function makeRange(startFrame: number, endFrame: number, timeS: number[]): BelowThresholdRange {
    return {
        startFrame,
        endFrame,
        startTime: timeS[startFrame] ?? 0,
        endTime: timeS[endFrame] ?? (timeS[startFrame] ?? 0),
    }
}

export interface DistanceSeriesPoints {
    frames: number[]
    values: number[]
}

export function downsampleDistanceSeries(
    series: Float32Array,
    maxPoints: number,
): DistanceSeriesPoints {
    const length = series.length
    if (length === 0 || maxPoints <= 0) {
        return { frames: [], values: [] }
    }
    if (length <= maxPoints) {
        const frames: number[] = new Array(length)
        const values: number[] = new Array(length)
        for (let i = 0; i < length; i += 1) {
            frames[i] = i
            values[i] = series[i]
        }
        return { frames, values }
    }
    if (maxPoints === 1) {
        return { frames: [0], values: [series[0]] }
    }
    const frames: number[] = new Array(maxPoints)
    const values: number[] = new Array(maxPoints)
    const step = (length - 1) / (maxPoints - 1)
    for (let i = 0; i < maxPoints; i += 1) {
        const idx = Math.round(i * step)
        frames[i] = idx
        values[i] = series[idx]
    }
    return { frames, values }
}
