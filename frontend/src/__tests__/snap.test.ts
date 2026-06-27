import { describe, expect, it } from 'vitest'
import { nearestSnap } from '../components/ReelWaveTimeline'

describe('nearestSnap', () => {
  const targets = [0, 10, 25]

  it('snaps to a target within the threshold', () => {
    expect(nearestSnap(9.5, targets, 1)).toBe(10)
    expect(nearestSnap(0.4, targets, 1)).toBe(0)
  })

  it('leaves the value untouched when no target is within the threshold', () => {
    expect(nearestSnap(15, targets, 1)).toBe(15)
    expect(nearestSnap(11.5, targets, 1)).toBe(11.5)
  })

  it('snaps to the nearest when several are in range', () => {
    expect(nearestSnap(10.6, [10, 11, 25], 2)).toBe(11)
    expect(nearestSnap(10.4, [10, 11, 25], 2)).toBe(10)
  })

  it('treats a target exactly at the threshold as a hit', () => {
    expect(nearestSnap(9, [10], 1)).toBe(10)
  })

  it('returns the value with no targets', () => {
    expect(nearestSnap(7, [], 5)).toBe(7)
  })
})
