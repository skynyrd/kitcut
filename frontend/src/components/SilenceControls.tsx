import type { CutParams, CutStats } from '../api'

interface Props {
  params: CutParams
  stats: CutStats | null
  busy?: boolean
  onChange: (params: CutParams) => void
}

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  disabled?: boolean
  onChange: (v: number) => void
}

function Slider({ label, value, min, max, step, unit, disabled, onChange }: SliderProps) {
  return (
    <label className="slider">
      <span className="slider-label">
        {label}
        <strong>
          {value}
          {unit}
        </strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}

export function SilenceControls({ params, stats, busy, onChange }: Props) {
  const set = (patch: Partial<CutParams>) => onChange({ ...params, ...patch })
  const adaptive = params.mode === 'adaptive'

  return (
    <div className="silence-controls">
      <div className="mode-row">
        <span>Mode</span>
        <div className="seg-toggle">
          <button className={!adaptive ? 'active' : ''} onClick={() => set({ mode: 'uniform' })}>
            Uniform
          </button>
          <button className={adaptive ? 'active' : ''} onClick={() => set({ mode: 'adaptive' })}>
            Adaptive
          </button>
        </div>
        {stats && (
          <span className="stats">
            −{stats.removed_s}s · {stats.final_s}s final · {stats.n_cuts} cuts
            {busy ? ' · updating…' : ''}
          </span>
        )}
      </div>

      <div className="sliders">
        <Slider
          label="Speech threshold"
          value={params.vad_threshold}
          min={0.1}
          max={0.9}
          step={0.05}
          onChange={(v) => set({ vad_threshold: Math.round(v * 20) / 20 })}
        />
        <Slider
          label="Min pause to cut"
          value={params.speech_min_silence_ms}
          min={100}
          max={2000}
          step={50}
          unit="ms"
          onChange={(v) => set({ speech_min_silence_ms: v })}
        />
        <Slider
          label="Padding"
          value={params.pad_ms}
          min={0}
          max={500}
          step={10}
          unit="ms"
          onChange={(v) => set({ pad_ms: v })}
        />
      </div>

      {adaptive && (
        <fieldset className="broll">
          <legend>B-roll / non-speech</legend>
          <label className="check">
            <input
              type="checkbox"
              checked={params.keep_nonspeech}
              onChange={(e) => set({ keep_nonspeech: e.target.checked })}
            />
            Keep non-speech silence (preserve b-roll)
          </label>
          <div className="sliders">
            <Slider
              label="B-roll threshold"
              value={params.broll_min_ms}
              min={500}
              max={8000}
              step={100}
              unit="ms"
              onChange={(v) => set({ broll_min_ms: v })}
            />
            <Slider
              label="B-roll keep"
              value={params.broll_keep_ms}
              min={0}
              max={4000}
              step={100}
              unit="ms"
              disabled={params.keep_nonspeech}
              onChange={(v) => set({ broll_keep_ms: v })}
            />
          </div>
        </fieldset>
      )}
    </div>
  )
}
