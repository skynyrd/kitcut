from __future__ import annotations

from pathlib import Path

_SR = 16000


def detect_speech(
    audio_path: Path, threshold: float = 0.5
) -> list[tuple[float, float]]:
    """Voiced-speech [start, end] regions via Silero VAD (bundled in
    faster-whisper). Robust to background music/noise where energy-based
    silence detection fails. Higher `threshold` = stricter (less speech)."""
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    audio = decode_audio(str(audio_path), sampling_rate=_SR)
    opts = VadOptions(
        threshold=threshold,
        min_speech_duration_ms=80,
        min_silence_duration_ms=100,
        speech_pad_ms=30,
    )
    ts = get_speech_timestamps(audio, opts, sampling_rate=_SR)
    return [(d["start"] / _SR, d["end"] / _SR) for d in ts]
