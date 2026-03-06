'use strict';

/**
 * bianca-voice.js — Módulo de voz continua para Bianca
 *
 * STT : OpenAI Whisper API  (alta precisión, requiere API key)
 * TTS : Windows SAPI via PowerShell  /  espeak-ng en Linux  (local, sin coste)
 * MIC : mic_capture.py + sounddevice/PortAudio  (Python, cross-platform)
 *
 * ─── Instalación ────────────────────────────────────────────────────────────
 *   Python 3.8+  +  pip install sounddevice numpy
 *   Linux: sudo apt install espeak-ng
 *
 * ─── Clave OpenAI (necesaria para STT) ─────────────────────────────────────
 *   Edita agents/main/agent/auth-profiles.json y añade dentro de "profiles":
 *     "openai:default": { "type": "api_key", "provider": "openai", "key": "sk-..." }
 *   O usa variable de entorno: OPENAI_API_KEY=sk-...
 *
 * ─── Uso mínimo ─────────────────────────────────────────────────────────────
 *   const BiancaVoice = require('./bianca-voice');
 *   const voice = new BiancaVoice(agentInstance);
 *   await voice.init();
 *   await voice.startListening();   // escucha continua en background
 *   await voice.speak('Hola, soy Bianca.');
 */

const EventEmitter = require('events');
const { exec, spawn } = require('child_process');
const https  = require('https');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');

// ── Platform ───────────────────────────────────────────────────────────────────
const IS_WINDOWS  = os.platform() === 'win32';
const POWERSHELL  = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/**
 * Locate the Python executable at runtime.
 * Falls back to 'python' (then 'python3') if not already in PATH.
 */
function _resolvePythonPath() {
  const { execSync } = require('child_process');
  for (const cmd of ['python', 'python3', 'py']) {
    try {
      const v = execSync(`${cmd} --version`, { timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
      if (/python/i.test(v)) return cmd;
    } catch { /* not found */ }
  }
  return 'python'; // last fallback
}

const PYTHON_PATH = _resolvePythonPath();
const MIC_SCRIPT  = path.join(__dirname, 'mic_capture.py');
const TTS_SCRIPT  = path.join(__dirname, 'tts_speak.py');

// ── Paths (resolved relative to this file) ────────────────────────────────────
// bianca-voice.js lives in bianca-ui/backend/
const BACKEND_DIR   = __dirname;
const BIANCAUI_DIR  = path.join(BACKEND_DIR, '..');
const WORKSPACE_DIR = path.join(BIANCAUI_DIR, '..');
const AUTH_PATH     = path.join(
  WORKSPACE_DIR, '..', 'agents', 'main', 'agent', 'auth-profiles.json'
);
const MEMORY_DIR    = path.join(WORKSPACE_DIR, 'memory', 'bianca');
const VOICE_LOG     = path.join(WORKSPACE_DIR, 'memory', 'voice.log');

const SAMPLE_RATE   = 16000;   // Hz — Whisper requires 16 kHz mono PCM

// ── Load OpenAI API key (from auth-profiles.json or env) ──────────────────────
function _loadOpenAIKey() {
  try {
    let raw = fs.readFileSync(AUTH_PATH, 'utf8');
    // Strip UTF-8 BOM that PowerShell sometimes writes
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const auth = JSON.parse(raw);
    const key  = auth?.profiles?.['openai:default']?.key;
    if (key && key.startsWith('sk-')) return key;
  } catch { /* file missing or malformed */ }
  return process.env.OPENAI_API_KEY || null;
}

// ── Pure-JS WAV encoder (16-bit LE PCM, mono) ────────────────────────────────
// Builds a minimal valid WAV header around a raw PCM buffer.
function _buildWav(pcmBuffer, sampleRate) {
  const byteRate  = sampleRate * 2;       // 16-bit mono: 2 bytes/sample
  const dataSize  = pcmBuffer.length;
  const hdr       = Buffer.alloc(44);

  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + dataSize, 4);
  hdr.write('WAVE', 8);
  hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16,         16); // PCM fmt chunk size
  hdr.writeUInt16LE(1,          20); // PCM = 1
  hdr.writeUInt16LE(1,          22); // channels = 1
  hdr.writeUInt32LE(sampleRate, 24);
  hdr.writeUInt32LE(byteRate,   28);
  hdr.writeUInt16LE(2,          32); // block align
  hdr.writeUInt16LE(16,         34); // bits per sample
  hdr.write('data', 36);
  hdr.writeUInt32LE(dataSize,   40);

  return Buffer.concat([hdr, pcmBuffer]);
}

// ── Whisper API call — pure Node.js HTTPS, no extra npm packages ──────────────
// Sends a WAV buffer as multipart/form-data to OpenAI and returns the transcript.
function _whisperTranscribe(wavBuffer, apiKey, language) {
  return new Promise((resolve) => {
    if (!apiKey) { resolve(''); return; }

    const boundary = `----BiancaVoice${Date.now()}`;
    const CRLF     = '\r\n';

    // Build multipart parts manually
    const head = Buffer.from([
      `--${boundary}`,
      'Content-Disposition: form-data; name="model"',
      '',
      'whisper-1',
      `--${boundary}`,
      'Content-Disposition: form-data; name="language"',
      '',
      language || 'es',
      `--${boundary}`,
      'Content-Disposition: form-data; name="response_format"',
      '',
      'text',
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="audio.wav"',
      'Content-Type: audio/wav',
      '',
      ''
    ].join(CRLF));

    const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
    const body = Buffer.concat([head, wavBuffer, tail]);

    const req = https.request({
      hostname : 'api.openai.com',
      port     : 443,
      path     : '/v1/audio/transcriptions',
      method   : 'POST',
      headers  : {
        'Authorization' : `Bearer ${apiKey}`,
        'Content-Type'  : `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }, (res) => {
      let data = '';
      res.on('data', c  => { data += c; });
      res.on('end',  () => {
        // response_format=text → plain text; fallback handles JSON error
        if (res.statusCode === 200) {
          resolve(data.trim());
        } else {
          try {
            const err = JSON.parse(data);
            resolve(''); // log quietly, don't throw
            console.error(`[Voice][Whisper] API error ${res.statusCode}:`, err?.error?.message || data.substring(0, 200));
          } catch {
            resolve('');
          }
        }
      });
    });

    req.setTimeout(30000, () => { req.destroy(); resolve(''); });
    req.on('error', () => resolve(''));
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════

/**
 * BiancaVoice — continuous listen → transcribe → agent → speak loop.
 *
 * Events emitted:
 *   'ready'        { stt, mic, tts, platform }   after init()
 *   'listening'    true / false
 *   'transcribing'
 *   'transcription' text
 *   'processing'    text
 *   'response'      text
 *   'speaking'      true / false
 *   'error'         Error
 */
class BiancaVoice extends EventEmitter {
  /**
   * @param {BiancaAgent} agent   — The bianca-agent.js instance
   * @param {object}      options — Optional configuration (see defaults below)
   */
  constructor(agent, options = {}) {
    super();
    if (!agent || typeof agent.askClaude !== 'function') {
      throw new Error('BiancaVoice: se requiere una instancia válida de BiancaAgent');
    }

    this.agent        = agent;
    this.isListening  = false;
    this.isSpeaking   = false;
    this.isReady      = false;

    // Internal state
    this._recorder     = null;   // Python mic_capture.py child process
    this._audioChunks  = [];     // raw PCM accumulation (Int16 LE)
    this._silenceTimer = null;   // fires after silence to flush audio
    this._wakeActive   = false;  // true after wake word detected
    this._wakeTimer    = null;   // auto-expire wake state
    this._ttsQueue     = Promise.resolve();  // serialise TTS calls
    this._speaking     = false;  // VAD mute flag

    // Prevent unhandled 'error' event from crashing the Node process
    this.on('error', (err) => {
      this._log(`[error] ${err?.message || err}`, true);
    });

    // Load OpenAI key once at construction
    this._openAIKey = _loadOpenAIKey();

    // ── Config with sensible defaults ─────────────────────────────────────────
    this.opts = {
      // STT / microphone
      language         : options.language          || 'es',
      sampleRate       : options.sampleRate         || SAMPLE_RATE,
      silenceMs        : options.silenceMs          || 1200,  // ms silence → flush
      silenceThreshold : options.silenceThreshold   || 300,   // RMS level (0-32768)
      minDurationMs    : options.minDurationMs      || 400,   // ignore clips shorter

      // Wake word
      wakeWord         : options.wakeWord !== undefined ? options.wakeWord : 'bianca',
      requireWakeWord  : options.requireWakeWord !== false,
      wakeTimeoutMs    : options.wakeTimeoutMs      || 15000, // reset after inactivity

      // TTS
      ttsRate          : options.ttsRate  !== undefined ? options.ttsRate  : 0,
      // Windows SAPI rate: -10 (slowest) to +10 (fastest), 0 = normal
      // Linux espeak wpm : pass wpm directly (e.g. 150)
      ttsVolume        : options.ttsVolume !== undefined ? options.ttsVolume : 90,
      ttsVoice         : options.ttsVoice  || 'Microsoft Helena Desktop',  // es-ES female (SAPI fallback)
      // Neural TTS via edge-tts Python — much higher quality
      // Set to null/'' to use SAPI fallback
      neuralTtsVoice   : options.neuralTtsVoice !== undefined
                           ? options.neuralTtsVoice
                           : 'es-ES-ElviraNeural',
      maxTtsChunk      : options.maxTtsChunk || 200, // chars before splitting

      // Microphone device — index (number/string) or name substring
      // Leave null for auto-detection (first device supporting target rate)
      micDevice    : options.micDevice !== undefined ? options.micDevice : null,

      // Misc
      logEnabled   : options.logEnabled !== false,
      autoReconnect: options.autoReconnect !== false,
    };
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Initialise the voice module.
   * Checks dependencies and reports availability.
   * Call once before startListening().
   * @returns {Promise<boolean>} true if fully ready
   */
  async init() {
    this._log('Iniciando módulo de voz Bianca...');
    this._ensureDirs();

    // Check OpenAI key
    if (this._openAIKey) {
      this._log('Clave OpenAI: OK — STT via Whisper-1 habilitado.');
    } else {
      this._log(
        '[WARN] Clave OpenAI no encontrada. Para activar STT:\n' +
        '  1. Edita agents/main/agent/auth-profiles.json\n' +
        '  2. Añade: "openai:default": {"type":"api_key","provider":"openai","key":"sk-..."}\n' +
        '  3. O define env: OPENAI_API_KEY=sk-...', true
      );
    }

    // Check Python + mic_capture.py availability
    // PYTHON_PATH was already resolved at module load — just verify the script file exists
    const micOk = fs.existsSync(MIC_SCRIPT);
    if (!micOk) {
      this._log(`[WARN] mic_capture.py no encontrado en: ${MIC_SCRIPT}`, true);
    } else {
      this._log(`Micrófono: Python sounddevice OK (${PYTHON_PATH})`);
    }

    // TTS info
    const ttsName = IS_WINDOWS ? 'Windows SAPI (System.Speech)' : 'espeak-ng';
    this._log(`TTS: ${ttsName} | Velocidad: ${this.opts.ttsRate} | Volumen: ${this.opts.ttsVolume}%`);

    if (this.opts.requireWakeWord && this.opts.wakeWord) {
      this._log(`Palabra de activación: "${this.opts.wakeWord}"`);
    } else {
      this._log('Modo siempre activo (sin palabra de activación).');
    }

    this.isReady = !!(this._openAIKey && micOk);
    this.emit('ready', {
      stt     : !!this._openAIKey,
      mic     : micOk,
      tts     : true,
      platform: os.platform()
    });

    if (this.isReady) this._log('Módulo de voz listo.');
    return this.isReady;
  }

  /** Begin continuous microphone listening (non-blocking). */
  async startListening() {
    if (this.isListening) return;
    if (!this.isReady) {
      const msg = 'BiancaVoice.startListening() — módulo no está listo. Verifica init()';
      this._log(msg, true);
      throw new Error(msg);
    }
    this.isListening  = true;
    this._audioChunks = [];
    const hint = this.opts.requireWakeWord && this.opts.wakeWord
      ? `Di "${this.opts.wakeWord}" para activar`
      : 'Escuchando todo';
    this._log(`Micrófono activo. ${hint}`);
    this.emit('listening', true);
    this._startRecorder();
  }

  /** Stop the microphone immediately. */
  stopListening() {
    if (!this.isListening) return;
    this.isListening = false;
    clearTimeout(this._silenceTimer);
    clearTimeout(this._wakeTimer);
    this._silenceTimer = null;
    if (this._recorder) {
      try { this._recorder.kill(); } catch { /* ignore */ }
      this._recorder = null;
    }
    this._audioChunks = [];
    this._log('Micrófono detenido.');
    this.emit('listening', false);
  }

  /**
   * Speak text aloud via TTS.
   * Calls are automatically queued — never overlaps.
   * Long responses are split at sentence boundaries.
   * @param {string}  text
   * @returns {Promise<void>} resolves when speech finishes
   */
  speak(text) {
    if (!text || typeof text !== 'string') return Promise.resolve();
    text = text.trim();
    if (!text) return Promise.resolve();

    const chunks = this._chunkText(text, this.opts.maxTtsChunk);

    this._ttsQueue = this._ttsQueue
      .then(async () => {
        this.isSpeaking = true;
        this.emit('speaking', true);
        for (const chunk of chunks) {
          if (chunk.trim()) await this._ttsSay(chunk);
        }
        this.isSpeaking = false;
        this.emit('speaking', false);
      })
      .catch(e => {
        this.isSpeaking = false;
        this.emit('speaking', false);
        this._log(`Error TTS: ${e.message}`, true);
      });

    return this._ttsQueue;
  }

  /** Returns a status snapshot for the /api/voice/status endpoint. */
  getStatus() {
    return {
      isListening    : this.isListening,
      isSpeaking     : this.isSpeaking,
      isReady        : this.isReady,
      sttAvailable   : !!this._openAIKey,
      wakeWord       : this.opts.wakeWord || null,
      requireWakeWord: this.opts.requireWakeWord,
      language       : this.opts.language,
      platform       : os.platform(),
      micBackend     : `python sounddevice (${PYTHON_PATH})`,
    };
  }

  // ── Private: Recorder ──────────────────────────────────────────────────────

  _startRecorder() {
    if (!fs.existsSync(MIC_SCRIPT)) {
      this._log(`mic_capture.py no encontrado en: ${MIC_SCRIPT}`, true);
      this.isListening = false;
      return;
    }

    this._log(`Iniciando micrófono Python: ${PYTHON_PATH} ${MIC_SCRIPT} ${this.opts.sampleRate}`);

    try {
      const args = [MIC_SCRIPT, String(this.opts.sampleRate)];
      if (this.opts.micDevice !== null && this.opts.micDevice !== undefined) {
        args.push(String(this.opts.micDevice));
      }
      const proc = spawn(PYTHON_PATH, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      this._recorder = proc;

      proc.on('error', (err) => {
        this._log(`Error proceso Python mic: ${err.message}`, true);
        this.emit('error', err);
        if (this.isListening && this.opts.autoReconnect) {
          this._log('Reintentando micrófono en 3 s…');
          setTimeout(() => { if (this.isListening) this._startRecorder(); }, 3000);
        }
      });

      proc.on('close', (code, signal) => {
        this._log(`Python mic terminó (código ${code}, señal ${signal})`);
        if (this.isListening && this.opts.autoReconnect) {
          setTimeout(() => { if (this.isListening) this._startRecorder(); }, 800);
        }
      });

      // Log Python stderr (contains MIC_READY, errors, sounddevice warnings)
      proc.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) this._log(`[py] ${msg}`);
      });

      // Raw PCM comes from Python stdout — feed directly into VAD pipeline
      proc.stdout.on('data', chunk => this._onAudioChunk(chunk));
      proc.stdout.on('error', err => {
        this._log(`Error stream stdout Python: ${err.message}`, true);
      });

    } catch (e) {
      this._log(`Error iniciando Python mic: ${e.message}`, true);
      this._log(`Asegúrate de que Python está instalado y sounddevice disponible: pip install sounddevice numpy`, true);
      this.isListening = false;
    }
  }

  // ── Private: Voice Activity Detection (VAD) ────────────────────────────────

  _onAudioChunk(chunk) {
    // Mute while Bianca is speaking — prevents the mic picking up TTS output
    if (this.isSpeaking) return;

    const rms = this._rms(chunk);

    if (rms > this.opts.silenceThreshold) {
      // ── Voice detected: accumulate and cancel any pending flush ──
      this._audioChunks.push(chunk);
      clearTimeout(this._silenceTimer);
      this._silenceTimer = null;
    } else if (this._audioChunks.length > 0) {
      // ── Silence after speech: keep buffering but start countdown ──
      this._audioChunks.push(chunk);
      if (!this._silenceTimer) {
        this._silenceTimer = setTimeout(() => this._flushAudio(), this.opts.silenceMs);
      }
    }
    // Pure silence before any speech: ignore to avoid spurious API calls
  }

  /** Root-mean-square of a 16-bit LE PCM buffer. */
  _rms(buffer) {
    if (buffer.length < 2) return 0;
    let sum = 0;
    const samples = buffer.length >> 1;  // integer÷2
    for (let i = 0; i < buffer.length - 1; i += 2) {
      const s = buffer.readInt16LE(i);
      sum += s * s;
    }
    return Math.sqrt(sum / samples);
  }

  // ── Private: Transcription ──────────────────────────────────────────────────

  async _flushAudio() {
    this._silenceTimer = null;
    const chunks = this._audioChunks.splice(0);   // take all, reset array
    if (!chunks.length) return;

    const pcm       = Buffer.concat(chunks);
    const durationMs = (pcm.length / 2 / this.opts.sampleRate) * 1000;

    if (durationMs < this.opts.minDurationMs) {
      this._log(`Clip ignorado: ${Math.round(durationMs)} ms (< ${this.opts.minDurationMs} ms mínimo)`);
      return;
    }

    this._log(`Transcribiendo ${Math.round(durationMs)} ms de audio (Whisper)…`);
    this.emit('transcribing');

    const wav  = _buildWav(pcm, this.opts.sampleRate);
    const text = await _whisperTranscribe(wav, this._openAIKey, this.opts.language);

    if (!text || !text.trim()) {
      this._log('Transcripción vacía — ignorando.');
      return;
    }

    this._log(`[STT] "${text.trim()}"`);
    this.emit('transcription', text.trim());
    await this._processText(text.trim());
  }

  // ── Private: Agent + Wake word ──────────────────────────────────────────────

  async _processText(text) {
    const lc = text.toLowerCase();

    // ── Wake word gate ──────────────────────────────────────────────────────
    if (this.opts.requireWakeWord && this.opts.wakeWord) {
      const ww = this.opts.wakeWord.toLowerCase();

      if (!this._wakeActive) {
        if (!lc.includes(ww)) {
          this._log(`Wake word "${this.opts.wakeWord}" no detectada — descartando.`);
          return;
        }
        // Activate wake state
        this._wakeActive = true;
        clearTimeout(this._wakeTimer);
        this._wakeTimer = setTimeout(() => {
          this._wakeActive = false;
          this._log(`Wake state expirado — esperando "${this.opts.wakeWord}" de nuevo.`);
        }, this.opts.wakeTimeoutMs);

        // Trim wake word from input before sending to agent
        const wwIdx = lc.indexOf(ww);
        text = text.slice(wwIdx + ww.length).trim();
        if (!text) {
          // Just the wake word alone → acknowledge
          await this.speak('¿Sí?');
          return;
        }
      } else {
        // Already awake — refresh timeout
        clearTimeout(this._wakeTimer);
        this._wakeTimer = setTimeout(() => {
          this._wakeActive = false;
        }, this.opts.wakeTimeoutMs);
      }
    }

    // ── Send to Bianca agent ─────────────────────────────────────────────────
    this._log(`[Agente] "${text}"`);
    this.emit('processing', text);

    let response = '';
    try {
      response = await this.agent.askClaude(text, { voiceMode: true });
    } catch (e) {
      this._log(`Error en askClaude: ${e.message}`, true);
      response = 'Lo siento, me encontré con un error. Inténtalo de nuevo.';
    }

    response = (response || 'Hecho.').trim();
    this._log(`[Bianca] "${response.substring(0, 120)}${response.length > 120 ? '…' : ''}"`);

    // Heuristically register memory file accesses
    this._trackMemoryAccesses(text, response);

    this.emit('response', response);
    await this.speak(response);
  }

  /**
   * If the transcribed text or Bianca's response mentions a memory file by name,
   * increment its usage counter so the weekly analysis is accurate.
   */
  _trackMemoryAccesses(input, response) {
    try {
      if (!fs.existsSync(MEMORY_DIR)) return;
      const files    = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.txt'));
      const combined = `${input} ${response}`.toLowerCase();
      for (const file of files) {
        const stem = path.basename(file, '.txt').toLowerCase();
        if (combined.includes(stem) && typeof this.agent.trackMemoryUsage === 'function') {
          this.agent.trackMemoryUsage(path.join(MEMORY_DIR, file));
        }
      }
    } catch { /* non-critical — never block speech */ }
  }

  // ── Private: TTS ─────────────────────────────────────────────────────────────

  /** Strip markdown formatting so TTS doesn't say "asterisco asterisco". */
  _sanitizeForTts(text) {
    return text
      .replace(/\*\*(.*?)\*\*/gs, '$1')          // **bold**
      .replace(/\*(.*?)\*/gs, '$1')                // *italic*
      .replace(/`{1,3}[^`]*`{1,3}/gs, '')         // `code` / ```block```
      .replace(/#{1,6}\s+/g, '')                   // ## headings
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')   // [text](url)
      .replace(/[_~>|\\]/g, '')                    // leftover markdown chars
      .replace(/ {2,}/g, ' ')                       // collapse extra spaces
      .trim();
  }

  async _ttsSay(text) {
    // Strip markdown before speaking
    text = this._sanitizeForTts(text);
    if (!text) return;
    // Prefer neural edge-tts if available
    if (IS_WINDOWS && this.opts.neuralTtsVoice && fs.existsSync(TTS_SCRIPT)) {
      return this._ttsNeural(text);
    }
    return IS_WINDOWS ? this._ttsWindows(text) : this._ttsLinux(text);
  }

  /** Neural TTS via edge-tts Python script (Microsoft Azure Neural voices). */
  _ttsNeural(text) {
    return new Promise((resolve) => {
      const voice  = this.opts.neuralTtsVoice;
      // edge-tts rate/volume are percentage offset strings: '+0%', '+10%'
      const rate   = `+${Math.max(-50, Math.min(50, Number(this.opts.ttsRate) * 5))}%`;
      const volume = `+0%`;

      // Pass text as a single argument — spawn() sends it directly without shell parsing
      const args = [TTS_SCRIPT, voice, rate, volume, text];

      const proc = spawn(PYTHON_PATH, args, { windowsHide: true });

      proc.stderr.on('data', d => {
        const msg = d.toString().trim();
        if (msg) this._log(`[tts] ${msg}`);
      });

      proc.on('close', () => resolve());
      proc.on('error', (err) => {
        this._log(`Error TTS neural: ${err.message} — fallback a SAPI`, true);
        // Fallback to SAPI
        this._ttsWindows(text).then(resolve);
      });
    });
  }

  /**
   * Windows TTS using the built-in System.Speech synthesiser.
   * Zero external dependencies — just PowerShell which ships with Windows.
   * Rate   : -10 (slowest) to +10 (fastest); 0 = normal reading speed
   * Volume : 0–100 percent
   */
  _ttsWindows(text) {
    return new Promise((resolve) => {
      // Escape single quotes and strip PowerShell injection chars
      const safe   = text.replace(/'/g, "''").replace(/[`$\\]/g, '');
      const rate   = Math.max(-10, Math.min(10, Number(this.opts.ttsRate)   || 0));
      const volume = Math.max(0,   Math.min(100, Number(this.opts.ttsVolume) || 90));

      const lines = [
        'Add-Type -AssemblyName System.Speech',
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
        `$s.Rate   = ${rate}`,
        `$s.Volume = ${volume}`,
      ];
      if (this.opts.ttsVoice) {
        // Graceful: ignore unavailable voice names instead of crashing
        lines.push(`try { $s.SelectVoice('${this.opts.ttsVoice.replace(/'/g, "''")}') } catch {}`);
      }
      lines.push(`$s.Speak('${safe}')`, '$s.Dispose()');

      const tmpFile = path.join(os.tmpdir(), `bv_tts_${Date.now()}.ps1`);
      // Write with UTF-8 BOM so PowerShell 5.1 reads tildes/accents correctly
      fs.writeFileSync(tmpFile, '\uFEFF' + lines.join('\r\n'), 'utf8');

      exec(
        `"${POWERSHELL}" -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`,
        { timeout: 60000, windowsHide: true },
        (err) => {
          try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
          if (err) this._log(`TTS Windows error: ${err.message}`, true);
          resolve();
        }
      );
    });
  }

  /**
   * Linux TTS using espeak-ng.
   * Install: sudo apt install espeak-ng
   * Rate   : words-per-minute (default 150)
   * Volume : 0–100 → mapped to espeak amplitude 0–200
   */
  _ttsLinux(text) {
    return new Promise((resolve) => {
      const voice = this.opts.ttsVoice || 'es';
      const speed = Number(this.opts.ttsRate) || 150;    // wpm
      const amp   = Math.round((Number(this.opts.ttsVolume) / 100) * 200);

      const child = spawn('espeak-ng', [
        '-v', voice,
        '-s', String(speed),
        '-a', String(amp),
        text
      ]);

      child.on('close', () => resolve());
      child.on('error', e => {
        this._log(`espeak-ng no disponible: ${e.message}. Instala: sudo apt install espeak-ng`, true);
        resolve();
      });
    });
  }

  // ── Private: Helpers ─────────────────────────────────────────────────────────

  /**
   * Split text at sentence-ending punctuation (. ! ? ;) so TTS never cuts
   * a sentence in half. Falls back to maxLen hard-split if no boundary found.
   */
  _chunkText(text, maxLen) {
    if (!text || text.length <= maxLen) return [text || ''];

    const chunks    = [];
    // Lookbehind for sentence-ending chars followed by whitespace
    const sentences = text.split(/(?<=[.!?;])\s+/);
    let   current   = '';

    for (const sentence of sentences) {
      if ((current + sentence).length > maxLen && current) {
        chunks.push(current.trim());
        current = sentence + ' ';
      } else {
        current += sentence + ' ';
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.length ? chunks : [text];
  }

  _log(msg, isError = false) {
    const line = `[${new Date().toISOString()}] [Voice] ${msg}`;
    isError ? console.error(line) : console.log(line);
    if (!this.opts.logEnabled) return;
    try {
      const dir = path.dirname(VOICE_LOG);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(VOICE_LOG, line + '\n', 'utf8');
    } catch { /* never let logging break the voice loop */ }
  }

  _ensureDirs() {
    for (const d of [path.dirname(VOICE_LOG), MEMORY_DIR]) {
      if (!fs.existsSync(d)) {
        try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
      }
    }
  }
}

// ── Module export ──────────────────────────────────────────────────────────────
module.exports = BiancaVoice;
