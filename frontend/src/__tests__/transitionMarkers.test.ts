import { describe, expect, it } from 'vitest'
import { transitionMarkers } from '../components/timelineGeometry'

const clip = (id: string, offset: number) => ({ id, offset })

describe('transitionMarkers', () => {
  // Cut-join transitions are drawn by outlining the cut region (not markers), so
  // transitionMarkers only emits clip-to-clip JUNCTION lines.
  it('marks every still-enabled junction on the right clip’s offset', () => {
    const clips = [clip('a', 0), clip('b', 10), clip('c', 25)]
    const m = transitionMarkers(clips, [])
    expect(m).toEqual([
      { id: 'trans::junction::a', time: 10 },
      { id: 'trans::junction::b', time: 25 },
    ])
  })

  it('drops a junction whose left clip opted out', () => {
    const clips = [clip('a', 0), clip('b', 10), clip('c', 25)]
    const m = transitionMarkers(clips, ['a'])
    expect(m).toEqual([{ id: 'trans::junction::b', time: 25 }])
  })

  it('has no junction markers for a single clip', () => {
    expect(transitionMarkers([clip('a', 0)], [])).toEqual([])
  })
})
