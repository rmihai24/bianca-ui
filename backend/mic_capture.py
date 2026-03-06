#!/usr/bin/env python3
"""
mic_capture.py — Microphone → raw PCM int16 to stdout.

Used by bianca-voice.js as a portable audio capture backend.
Avoids SoX entirely: uses sounddevice (PortAudio) which works
natively on Windows without any extra configuration.

Usage:
    python mic_capture.py [sample_rate]
    python mic_capture.py 16000

Outputs raw signed-integer 16-bit little-endian mono PCM to stdout.
Writes status lines to stderr so Node.js can log them.
"""

import sys
import signal
import numpy as np
import sounddevice as sd

SAMPLE_RATE = int(sys.argv[1]) if len(sys.argv) > 1 else 16000
# Optional: explicit device index (or name substring) as 3rd argument
DEVICE_ARG  = sys.argv[2] if len(sys.argv) > 2 else None
CHANNELS = 1
# 50ms chunks — small enough for low latency VAD, large enough to be efficient
CHUNK_FRAMES = max(160, int(SAMPLE_RATE * 0.05))

_running = True


def _stop(sig, frame):
    global _running
    _running = False


signal.signal(signal.SIGINT, _stop)
signal.signal(signal.SIGTERM, _stop)


def _find_input_device(requested=None, target_sr=16000):
    """Return (device_index, actual_sample_rate).
    Prefers a device that supports target_sr natively.
    If requested is an int string or name substring, uses that device (any rate).
    Otherwise picks the first device accepting target_sr; falls back to any input device."""
    devices = sd.query_devices()

    if requested is not None:
        # Try numeric index first
        try:
            idx = int(requested)
            if idx >= 0 and devices[idx]['max_input_channels'] > 0:
                for sr in [target_sr, 44100, 48000]:
                    try:
                        sd.check_input_settings(device=idx, samplerate=sr, channels=1, dtype='int16')
                        return idx, sr
                    except Exception:
                        pass
        except (ValueError, IndexError):
            pass
        # Try name match
        req_lower = str(requested).lower()
        for i, d in enumerate(devices):
            if req_lower in d['name'].lower() and d['max_input_channels'] > 0:
                for sr in [target_sr, 44100, 48000]:
                    try:
                        sd.check_input_settings(device=i, samplerate=sr, channels=1, dtype='int16')
                        return i, sr
                    except Exception:
                        pass
        print(f'[mic] WARN: "{requested}" no encontrado, usando detección automática.',
              file=sys.stderr, flush=True)

    # Phase 1: prefer a device that supports target_sr natively
    for i, d in enumerate(devices):
        if d['max_input_channels'] > 0:
            try:
                sd.check_input_settings(device=i, samplerate=target_sr, channels=1, dtype='int16')
                return i, target_sr
            except Exception:
                pass

    # Phase 2: any input device at any common rate
    for i, d in enumerate(devices):
        if d['max_input_channels'] > 0:
            for sr in [44100, 48000, 8000]:
                try:
                    sd.check_input_settings(device=i, samplerate=sr, channels=1, dtype='int16')
                    return i, sr
                except Exception:
                    pass

    raise RuntimeError('No se encontró ningún dispositivo de entrada de audio compatible.')


def _resample_if_needed(data, from_sr, to_sr):
    """Quick linear resample from from_sr to to_sr using numpy."""
    if from_sr == to_sr:
        return data
    ratio      = to_sr / from_sr
    n_in       = len(data)
    n_out      = int(round(n_in * ratio))
    x_in       = np.arange(n_in, dtype=np.float32)
    x_out      = np.linspace(0, n_in - 1, n_out, dtype=np.float32)
    resampled  = np.interp(x_out, x_in, data.astype(np.float32))
    return np.clip(resampled, -32768, 32767).astype(np.int16)


def _make_callback(from_sr, to_sr):
    def _callback(indata, frames, time_info, status):
        if status:
            print(f'[mic] {status}', file=sys.stderr, flush=True)
        # indata shape: (frames, channels) — flatten to 1D for mono
        mono = indata[:, 0]
        out  = _resample_if_needed(mono, from_sr, to_sr)
        sys.stdout.buffer.write(out.tobytes())
        sys.stdout.buffer.flush()
    return _callback


try:
    device, actual_sr = _find_input_device(DEVICE_ARG, target_sr=SAMPLE_RATE)
    dev_name = sd.query_devices(device)['name']
    print(f'[mic] Usando dispositivo {device}: {dev_name} @ {actual_sr}Hz'
          + (f' (resample→{SAMPLE_RATE}Hz)' if actual_sr != SAMPLE_RATE else ''),
          file=sys.stderr, flush=True)

    with sd.InputStream(
        device=device,
        samplerate=actual_sr,
        channels=CHANNELS,
        dtype='int16',
        blocksize=CHUNK_FRAMES,
        callback=_make_callback(actual_sr, SAMPLE_RATE),
    ):
        print(f'MIC_READY samplerate={SAMPLE_RATE} chunk_frames={CHUNK_FRAMES}',
              file=sys.stderr, flush=True)
        while _running:
            sd.sleep(50)

    print('MIC_STOPPED', file=sys.stderr, flush=True)

except Exception as e:
    print(f'[mic] ERROR: {e}', file=sys.stderr, flush=True)
    sys.exit(1)
