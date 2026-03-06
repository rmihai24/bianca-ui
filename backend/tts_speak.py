#!/usr/bin/env python3
"""
tts_speak.py — Neural TTS via edge-tts (Microsoft Azure Neural voices).

Usage:
    python tts_speak.py <voice> <rate> <volume> <text>

    voice  : e.g. es-ES-ElviraNeural
    rate   : speed offset e.g. +0%  +20%  -10%
    volume : volume offset e.g. +0%  +10%
    text   : the text to speak (rest of argv joined)

Outputs audio to the default playback device and exits when done.
"""

import sys
import asyncio
import tempfile
import os

async def speak(voice, rate, volume, text):
    import edge_tts
    import pygame

    communicate = edge_tts.Communicate(text, voice, rate=rate, volume=volume)

    tmp = tempfile.NamedTemporaryFile(suffix='.mp3', delete=False)
    tmp.close()

    await communicate.save(tmp.name)

    pygame.mixer.init()
    pygame.mixer.music.load(tmp.name)
    pygame.mixer.music.play()
    while pygame.mixer.music.get_busy():
        await asyncio.sleep(0.05)
    pygame.mixer.quit()

    try:
        os.unlink(tmp.name)
    except Exception:
        pass

if __name__ == '__main__':
    if len(sys.argv) < 5:
        print("Usage: tts_speak.py <voice> <rate> <volume> <text...>", file=sys.stderr)
        sys.exit(1)

    voice  = sys.argv[1]
    rate   = sys.argv[2]
    volume = sys.argv[3]
    text   = sys.argv[4]  # single arg — passed directly by spawn(), no shell splitting

    asyncio.run(speak(voice, rate, volume, text))
