import { describe, expect, it } from 'vitest'
import { clipAtTime, findCutAt } from '../components/timelineGeometry'

describe('clipAtTime', () => {
  const clips = [
    { id: 'a', offset: 0, duration: 10 },
    { id: 'b', offset: 10, duration: 5 },
    { id: 'c', offset: 15, duration: 5 },
  ]

  it('returns the clip whose span contains t', () => {
    expect(clipAtTime(clips, 3)?.id).toBe('a')
    expect(clipAtTime(clips, 12)?.id).toBe('b')
    expect(clipAtTime(clips, 19.9)?.id).toBe('c')
  })

  it('boundaries belong to the right (later) clip', () => {
    expect(clipAtTime(clips, 10)?.id).toBe('b')
    expect(clipAtTime(clips, 15)?.id).toBe('c')
  })

  it('past the end falls back to the last clip that started', () => {
    expect(clipAtTime(clips, 100)?.id).toBe('c')
  })

  it('before the first clip is null', () => {
    expect(clipAtTime(clips, -1)).toBeNull()
  })
})

describe('findCutAt', () => {
  const cuts = [
    { start: 1, end: 3 },
    { start: 5, end: 9 },
  ]
  const tol = 0.25

  it('hits a cut body as a move target', () => {
    expect(findCutAt(cuts, 2, tol)).toEqual({ index: 0, side: 'body' })
    expect(findCutAt(cuts, 7, tol)).toEqual({ index: 1, side: 'body' })
  })

  it('hits an edge within tol as a resize target', () => {
    expect(findCutAt(cuts, 1.1, tol)).toEqual({ index: 0, side: 'start' })
    expect(findCutAt(cuts, 9.05, tol)).toEqual({ index: 1, side: 'end' })
  })

  it('prefers the nearer edge when both are close (tiny cut)', () => {
    const tiny = [{ start: 4, end: 4.1 }]
    expect(findCutAt(tiny, 4.02, 0.3).side).toBe('start')
    expect(findCutAt(tiny, 4.08, 0.3).side).toBe('end')
  })

  it('returns null when nothing is within tol', () => {
    expect(findCutAt(cuts, 4, tol)).toBeNull()
    expect(findCutAt(cuts, 12, tol)).toBeNull()
  })

  it('minWidth pads a tiny cut so its body stays clickable', () => {
    const tiny = [{ start: 5, end: 5.01 }]
    // without padding, a click 0.1s away misses entirely
    expect(findCutAt(tiny, 5.1, 0.02)).toBeNull()
    // with a 0.4s min body, the same click lands on the body
    expect(findCutAt(tiny, 5.1, 0.02, 0.4)).toEqual({ index: 0, side: 'body' })
  })
})
