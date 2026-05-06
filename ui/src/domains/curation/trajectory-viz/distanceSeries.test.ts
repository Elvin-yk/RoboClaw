import { describe, expect, it } from 'vitest'
import {
    buildBelowThresholdRanges,
    downsampleDistanceSeries,
    summarizeDistanceSeries,
} from './distanceSeries'

describe('summarizeDistanceSeries', () => {
    it('returns zeros for an empty series', () => {
        const stats = summarizeDistanceSeries(new Float32Array(0), 0.05)
        expect(stats).toEqual({ min: 0, max: 0, mean: 0, belowCount: 0 })
    })

    it('handles a single value', () => {
        const stats = summarizeDistanceSeries(new Float32Array([0.1]), 0.05)
        expect(stats.min).toBeCloseTo(0.1)
        expect(stats.max).toBeCloseTo(0.1)
        expect(stats.mean).toBeCloseTo(0.1)
        expect(stats.belowCount).toBe(0)
    })

    it('computes min/max/mean for mixed values', () => {
        const series = new Float32Array([0.02, 0.04, 0.1, 0.2, 0.5])
        const stats = summarizeDistanceSeries(series, 0.05)
        expect(stats.min).toBeCloseTo(0.02)
        expect(stats.max).toBeCloseTo(0.5)
        expect(stats.mean).toBeCloseTo((0.02 + 0.04 + 0.1 + 0.2 + 0.5) / 5)
        // 0.02 and 0.04 are strictly below 0.05; 0.05 itself would NOT be below.
        expect(stats.belowCount).toBe(2)
    })

    it('uses strict less-than for the below count (boundary value not counted)', () => {
        const series = new Float32Array([0.05, 0.05, 0.05])
        const stats = summarizeDistanceSeries(series, 0.05)
        expect(stats.belowCount).toBe(0)
    })
})

describe('buildBelowThresholdRanges', () => {
    it('returns no ranges for an empty series', () => {
        expect(buildBelowThresholdRanges(new Float32Array(0), 0.05, [])).toEqual([])
    })

    it('returns no ranges when everything is above threshold', () => {
        const series = new Float32Array([0.1, 0.2, 0.3])
        expect(buildBelowThresholdRanges(series, 0.05, [0, 0.1, 0.2])).toEqual([])
    })

    it('returns one range covering the entire series when everything is below', () => {
        const series = new Float32Array([0.01, 0.02, 0.03])
        const ranges = buildBelowThresholdRanges(series, 0.05, [0, 0.1, 0.2])
        expect(ranges).toHaveLength(1)
        expect(ranges[0].startFrame).toBe(0)
        expect(ranges[0].endFrame).toBe(2)
        expect(ranges[0].startTime).toBeCloseTo(0)
        expect(ranges[0].endTime).toBeCloseTo(0.2)
    })

    it('returns two distinct ranges when separated by an above-threshold gap', () => {
        const series = new Float32Array([0.01, 0.02, 0.1, 0.02, 0.01, 0.1])
        const timeS = [0, 0.1, 0.2, 0.3, 0.4, 0.5]
        const ranges = buildBelowThresholdRanges(series, 0.05, timeS)
        expect(ranges).toHaveLength(2)
        expect(ranges[0]).toMatchObject({ startFrame: 0, endFrame: 1 })
        expect(ranges[1]).toMatchObject({ startFrame: 3, endFrame: 4 })
        expect(ranges[1].startTime).toBeCloseTo(0.3)
        expect(ranges[1].endTime).toBeCloseTo(0.4)
    })

    it('treats values equal to the threshold as NOT below', () => {
        const series = new Float32Array([0.05, 0.05, 0.05])
        expect(buildBelowThresholdRanges(series, 0.05, [0, 0.1, 0.2])).toEqual([])
    })
})

describe('downsampleDistanceSeries', () => {
    it('returns the full series when length <= maxPoints', () => {
        const series = new Float32Array([0.1, 0.2, 0.3])
        const out = downsampleDistanceSeries(series, 5)
        expect(out.frames).toEqual([0, 1, 2])
        expect(out.values.length).toBe(3)
        expect(out.values[0]).toBeCloseTo(0.1)
        expect(out.values[1]).toBeCloseTo(0.2)
        expect(out.values[2]).toBeCloseTo(0.3)
    })

    it('downsamples evenly across the series', () => {
        const series = new Float32Array(101)
        for (let i = 0; i < series.length; i += 1) series[i] = i
        const out = downsampleDistanceSeries(series, 11)
        expect(out.frames).toHaveLength(11)
        expect(out.frames[0]).toBe(0)
        expect(out.frames[out.frames.length - 1]).toBe(100)
        // even spacing → 0, 10, 20, ..., 100
        expect(out.frames).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
        expect(out.values[0]).toBeCloseTo(0)
        expect(out.values[5]).toBeCloseTo(50)
        expect(out.values[10]).toBeCloseTo(100)
    })

    it('returns empty arrays for a zero-length series', () => {
        expect(downsampleDistanceSeries(new Float32Array(0), 100)).toEqual({ frames: [], values: [] })
    })
})
