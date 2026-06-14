import { useEffect, useRef } from 'react'
import WaveSurfer from 'wavesurfer.js'

interface Props {
  url: string
}

/** Read-only waveform visualization of the extracted audio (Phase 1).
 *  Playback sync with the video comes in Phase 3. */
export function Waveform({ url }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ws = WaveSurfer.create({
      container: el,
      height: 96,
      waveColor: '#7a9cc6',
      progressColor: '#1e3a5f',
      cursorWidth: 0,
      interact: false,
      url,
    })
    return () => ws.destroy()
  }, [url])

  return <div ref={containerRef} className="waveform" />
}
