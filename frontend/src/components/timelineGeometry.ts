// Pure geometry helpers shared by the reel timelines (the WaveSurfer one and the
// phase-18 canvas one) and unit-tested directly. No DOM, no React.

export interface TransMarker {
  id: string
  time: number // reel (page-rebased) seconds of the junction boundary
}

/** Gold line markers for still-enabled clip-to-clip junctions (on the boundary =
 *  the right clip's offset; auto-on unless the LEFT clip is in `disabled`).
 *  Cut-join transitions are NOT markers — they outline the cut region instead, so
 *  the indicator sits on the join (the cut's edges) rather than mid-gap. */
export function transitionMarkers(
  clips: { id: string; offset: number }[],
  disabled: string[],
): TransMarker[] {
  const out: TransMarker[] = []
  const off = new Set(disabled)
  for (let i = 1; i < clips.length; i++) {
    if (!off.has(clips[i - 1].id))
      out.push({ id: `trans::junction::${clips[i - 1].id}`, time: clips[i].offset })
  }
  return out
}

/** Snap `value` to the nearest of `targets` within `threshold`; else return `value`. */
export function nearestSnap(value: number, targets: number[], threshold: number): number {
  let best = value
  let bestDist = threshold
  for (const t of targets) {
    const d = Math.abs(t - value)
    if (d <= bestDist) {
      bestDist = d
      best = t
    }
  }
  return best
}

/** The clip containing `t` (its [offset, offset+duration) span), or the last clip
 *  that starts at/before `t` (so a click in a trailing gap still targets a clip). */
export function clipAtTime<T extends { offset: number; duration?: number | null }>(
  clips: T[],
  t: number,
): T | null {
  let target: T | null = null
  for (const c of clips) {
    const end = c.offset + (c.duration || 0)
    if (t >= c.offset && t < end) return c
    if (t >= c.offset) target = c
  }
  return target
}

export type CutSide = 'start' | 'end' | 'body'
export interface CutHit {
  index: number
  side: CutSide
}

/** Pick the cut under `t` (all values in the SAME unit — clip-local seconds). A
 *  hit is `t` inside [start,end] or within `tol` of an edge; edges win over the
 *  body so resize beats move. Ties broken by nearest. `null` when nothing's near.
 *  `minWidth` pads the body span of sub-`minWidth` cuts (centered) so tiny cuts
 *  stay clickable at low zoom; edges still report the real nearest side. */
export function findCutAt(
  cuts: { start: number; end: number }[],
  t: number,
  tol: number,
  minWidth = 0,
): CutHit | null {
  let best: { index: number; side: CutSide; dist: number } | null = null
  for (let i = 0; i < cuts.length; i++) {
    let { start, end } = cuts[i]
    if (end - start < minWidth) {
      const mid = (start + end) / 2
      start = mid - minWidth / 2
      end = mid + minWidth / 2
    }
    const dStart = Math.abs(t - start)
    const dEnd = Math.abs(t - end)
    const nearStart = dStart <= tol
    const nearEnd = dEnd <= tol
    const inside = t >= start && t <= end
    if (!inside && !nearStart && !nearEnd) continue
    let side: CutSide = 'body'
    if (nearStart && (!nearEnd || dStart <= dEnd)) side = 'start'
    else if (nearEnd) side = 'end'
    const dist = inside ? 0 : Math.min(dStart, dEnd)
    // an edge hit should beat a plain body hit at the same cut, and nearer wins
    const rank = side === 'body' ? dist + tol : dist
    const bestRank = best ? (best.side === 'body' ? best.dist + tol : best.dist) : Infinity
    if (!best || rank < bestRank) best = { index: i, side, dist }
  }
  return best ? { index: best.index, side: best.side } : null
}
