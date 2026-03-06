/**
 * bianca-agent.js - Bianca Agent with Real Command Execution
 */

const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const https = require('https');
const WebSocket = require('ws');
const os = require('os');
const crypto = require('crypto');

// Configuration
const WORKSPACE = 'C:\\Users\\DEEPGAMING\\.openclaw\\workspace';
const MEMORY_DIR = path.join(WORKSPACE, 'memory');
const OPENCLAW_URL = 'ws://127.0.0.1:18789';
const POWERSHELL_PATH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const OPENCLAW_TOKEN = '7a59c41a69749f99e62210c800cc6e5a63b126dfbdee769c';

// Load Anthropic API key from OpenClaw's auth-profiles
const ANTHROPIC_API_KEY = (() => {
  try {
    const profilesPath = 'C:\\Users\\DEEPGAMING\\.openclaw\\agents\\main\\agent\\auth-profiles.json';
    const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    return profiles.profiles?.['anthropic:default']?.key || '';
  } catch { return ''; }
})();

const ANTHROPIC_MODEL = 'claude-haiku-4-5';
const SCREENSHOT_PATH = path.join(os.tmpdir(), 'bianca_screen.png');

class BiancaAgent {
  constructor() {
    this.ready = false;
    this.openclawConnected = false;
    this.ws = null;
    this.agentId = 'bianca';
    this.sessionId = this.generateId();
    this.commandHistory = [];
  }

  generateId() {
    return 'bianca_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  async init() {
    try {
      if (!fs.existsSync(MEMORY_DIR)) {
        fs.mkdirSync(MEMORY_DIR, { recursive: true });
      }
      // Enable OpenClaw connection
      this.connectToOpenClaw();
      this.ready = true;
      this.logToMemory(`[INIT] Bianca initialized - Session: ${this.sessionId}`);
      console.log('[Bianca] Initialized - Connecting to OpenClaw...');
      return { status: 'ok', sessionId: this.sessionId };
    } catch (error) {
      console.error('[Bianca] Init error:', error.message);
      throw error;
    }
  }

  connectToOpenClaw(retryCount = 0) {
    const MAX_RETRIES = 5;

    if (retryCount >= MAX_RETRIES) {
      console.log(`[OpenClaw] Max retries (${MAX_RETRIES}) reached. Giving up WS connection.`);
      console.log('[OpenClaw] Bianca will still work normally — AI via direct API, commands via REST.');
      return;
    }

    try {
      // Pass the auth token as Authorization header (required by OpenClaw gateway)
      console.log(`[OpenClaw] Attempting connection (attempt ${retryCount + 1}/${MAX_RETRIES})...`);
      this.ws = new WebSocket(OPENCLAW_URL, {
        headers: {
          'Authorization': `Bearer ${OPENCLAW_TOKEN}`
        }
      });
      // Track retries on the instance, not on the ws object (avoids reset on reconnect)
      this._wsRetryCount = retryCount;

      this.ws.on('open', () => {
        console.log('[OpenClaw] ✓ Connected to gateway');
        this.openclawConnected = true;
        this._wsRetryCount = 0;
        this.logToMemory('[OPENCLAW] Connected to gateway');
        this.registerAsAgent();
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          console.log('[OpenClaw] Message received:', msg.type || msg.event);
          this.handleOpenClawMessage(msg);
        } catch (e) {
          console.error('[OpenClaw] Parse error:', e.message);
        }
      });

      this.ws.on('error', (error) => {
        console.warn('[OpenClaw] Connection error:', error.message);
        this.openclawConnected = false;
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[OpenClaw] Disconnected (code: ${code})`);
        this.openclawConnected = false;

        // 1008 = policy violation / unauthorized — no point retrying without fix
        if (code === 1008) {
          console.log('[OpenClaw] Gateway rejected connection (token/policy). Stopping reconnect.');
          return;
        }

        const nextAttempt = this._wsRetryCount + 1;
        if (nextAttempt < MAX_RETRIES) {
          const delay = nextAttempt * 2000;
          console.log(`[OpenClaw] Reconnecting in ${delay}ms...`);
          setTimeout(() => this.connectToOpenClaw(nextAttempt), delay);
        } else {
          console.log('[OpenClaw] Max retries reached. Running in standalone mode.');
        }
      });
    } catch (error) {
      console.warn('[OpenClaw] Connection initialization failed:', error.message);
      this.openclawConnected = false;
    }
  }

  registerAsAgent() {
    try {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        console.warn('[OpenClaw] Cannot register - WebSocket not connected');
        return;
      }

      const registration = {
        type: 'agent.register',
        agentId: this.agentId,
        sessionId: this.sessionId,
        capabilities: {
          execute: true,
          read: true,
          write: true,
          memory: true
        },
        metadata: {
          name: 'Bianca',
          version: '2.0',
          type: 'autonomous_assistant'
        }
      };

      this.ws.send(JSON.stringify(registration));
      console.log('[OpenClaw] ✓ Registration message sent');
      this.logToMemory('[OPENCLAW] Agent registration sent');
    } catch (error) {
      console.error('[OpenClaw] Registration failed:', error.message);
    }
  }

  handleOpenClawMessage(msg) {
    // Handle different message types
    
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      // OpenClaw is challenging us to authenticate
      console.log('[OpenClaw] 🔐 Challenge received - responding with ACK');
      
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          // Send simple ACK response
          const response = {
            type: 'ack',
            event: 'connect'
          };
          
          this.ws.send(JSON.stringify(response));
          console.log('[OpenClaw] ✓ ACK sent');
        } catch (err) {
          console.warn('[OpenClaw] Error responding to challenge:', err.message);
        }
      }
    } else if (msg.type === 'event' && msg.event === 'connect.authenticated') {
      console.log('[OpenClaw] 🔓 Authentication successful!');
      this.openclawConnected = true;
      this.logToMemory('[OPENCLAW] ✓ Authenticated and connected');
    } else if (msg.type === 'task.request') {
      console.log('[OpenClaw] Task request received:', msg.data?.command || msg.data?.action);
      this.executeTask(msg.data);
      console.log('[OpenClaw] ✓ Task handled');
    } else if (msg.type === 'agent.register.ack') {
      console.log('[OpenClaw] ✓ Registration acknowledged');
      this.logToMemory('[OPENCLAW] Agent registered successfully');
      this.openclawConnected = true;
    } else if (msg.type === 'command' || msg.type === 'execute') {
      // Alternative command format
      console.log('[OpenClaw] Command received:', msg.command);
      this.executeTask({ command: msg.command, id: msg.id });
    } else if (msg.type === 'ping') {
      // Respond to ping
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'pong', id: msg.id }));
      }
    } else {
      console.log('[OpenClaw] Message:', JSON.stringify(msg).substring(0, 100));
    }
  }

  async processCommand(input) {
    try {
      const cmd = input.toLowerCase().trim();
      this.commandHistory.push({ command: cmd, timestamp: new Date() });
      this.logToMemory(`[CMD] ${cmd}`);

      if (!cmd || cmd.length < 2) {
        return 'Comando vacío. Escribe "ayuda" para ver opciones.';
      }

      // Simple commands
      if (cmd === 'hola' || cmd === 'hi' || cmd === 'hey') {
        return '¡Hola! Soy Bianca, tu asistente autónomo. ¿En qué puedo ayudarte?';
      }
      if (cmd === 'ayuda' || cmd === 'help') {
        return 'Comandos disponibles: hora | fecha | estado | memoria | procesos | lista <ruta> | ejecuta <comando> | info | chiste';
      }
      if (cmd === 'info' || cmd === 'version' || cmd === 'versión') {
        return 'Bianca v2.0 - Autonomous Assistant\nPowerShell: ' + POWERSHELL_PATH + '\nSession: ' + this.sessionId;
      }

      // Time/Date
      if (cmd === 'hora' || cmd === 'time') {
        return await this.getTime();
      }
      if (cmd === 'fecha' || cmd === 'date') {
        return await this.executeSystemCommand('Get-Date');
      }

      // System Info
      if (cmd === 'estado' || cmd === 'status') {
        const mem = await this.checkMemory();
        const disk = await this.checkDiskSpace();
        return `ESTADO DEL SISTEMA\n${mem}\n${disk}`;
      }
      if (cmd === 'memoria' || cmd === 'memory') {
        return await this.checkMemory();
      }
      if (cmd === 'procesos' || cmd === 'processes') {
        return await this.listProcesses();
      }
      if (cmd === 'disco' || cmd === 'disk' || cmd.includes('espacio')) {
        return await this.checkDiskSpace();
      }

      // File operations
      if (cmd.startsWith('lista ') || cmd.startsWith('ls ') || cmd.startsWith('dir ')) {
        const pathArg = cmd.replace(/^(lista|ls|dir)\s+/, '').trim();
        return await this.listDirectory(pathArg);
      }
      if (cmd.startsWith('lee ') || cmd.startsWith('cat ')) {
        const file = cmd.replace(/^(lee|cat)\s+/, '').trim();
        return await this.readFile(file);
      }

      // Jokes
      if (cmd.includes('chiste') || cmd.includes('joke')) {
        const jokes = [
          'Un byte entra a un bar y le pregunta al camarero: ¿tienes un bit?',
          '¿Por qué los programadores odian la naturaleza? ¡Tiene demasiados bugs!',
          'How do programmers stay cool? They sit in front of a fan!'
        ];
        return jokes[Math.floor(Math.random() * jokes.length)];
      }

      // System execution (explicit prefix)
      if (cmd.startsWith('ejecuta ') || cmd.startsWith('run ')) {
        const command = cmd.replace(/^(ejecuta|run)\s+/, '').trim();
        return await this.executeSystemCommand(command);
      }

      // Everything else → Claude AI with optional screen vision
      const needsVision = /abre |cierra |chrome|firefox|edge|opera|brave|ventana|pantalla|screenshot|captura|ve si|mira si|está.abiert|pestaña|\btab\b|clic|click|escribe en|envía/i.test(cmd);
      return await this.askClaude(input, { withVision: needsVision });
    } catch (error) {
      return `Error procesando comando: ${error.message}`;
    }
  }

  async askClaude(input, options = {}) {
    if (!ANTHROPIC_API_KEY) {
      return 'Error: No se encontró la clave de API de Anthropic. Verifica agents/main/agent/auth-profiles.json';
    }

    const now = new Date();
    const fechaActual = now.toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const horaActual = now.toLocaleTimeString('es-ES');
    const memInfo = await this.checkMemory().catch(() => 'no disponible');
    const windows = await this.getActiveWindows();
    const windowsStr = windows.length > 0
      ? `Ventanas abiertas: ${windows.join(' | ')}`
      : 'No hay ventanas visibles detectadas.';

    let screenshot = null;
    if (options.withVision) {
      screenshot = await this.takeScreenshot();
      if (screenshot) console.log('[Vision] Screenshot captured for Claude.');
      else console.warn('[Vision] Screenshot failed, proceeding without image.');
    }

    return new Promise((resolve) => {
      const systemPrompt = [
        'Eres Bianca, asistente autónoma con control TOTAL de Windows. Responde SIEMPRE en español, texto plano sin markdown ni asteriscos.',
        `Sistema — Fecha: ${fechaActual} | Hora: ${horaActual} | ${memInfo} | ${windowsStr}.`,
        'PUEDES EJECUTAR ACCIONES reales poniendo cada comando en una línea que empiece exactamente con "CMD: " seguido del comando PowerShell. Ejemplos:',
        'Abrir Chrome → CMD: Start-Process chrome',
        'Nueva pestaña Chrome ya abierto → CMD: Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate("chrome"); Start-Sleep -Milliseconds 300; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^t")',
        'Abrir Notepad → CMD: Start-Process notepad',
        'Crear archivo → CMD: Set-Content -Path "$env:USERPROFILE\\Desktop\\nota.txt" -Value "contenido"',
        'IMPORTANTE: escribe PRIMERO tu explicación/respuesta en texto, LUEGO pon las líneas CMD: al final. Nunca respondas solo con CMD: sin texto explicativo.'
      ].join(' ');

      const userContent = screenshot
        ? [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot } },
            { type: 'text', text: input }
          ]
        : input;

      const body = JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      });

      const bodyBuffer = Buffer.from(body, 'utf8');

      const reqOptions = {
        hostname: 'api.anthropic.com',
        port: 443,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': bodyBuffer.length,
          'anthropic-version': '2023-06-01',
          'x-api-key': ANTHROPIC_API_KEY
        }
      };

      const req = https.request(reqOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (response.error) {
              console.warn('[Claude] API error:', response.error.message);
              resolve(`Error de IA: ${response.error.message}`);
              return;
            }
            const text = response.content?.[0]?.text || 'Sin respuesta de la IA.';
            this.logToMemory(`[CLAUDE] Q: ${input.substring(0, 80)} | A: ${text.substring(0, 80)}`);
            this.executeClaudeActions(text).then(resolve);
          } catch (e) {
            console.warn('[Claude] Parse error:', e.message, data.substring(0, 100));
            resolve('Error al procesar la respuesta de la IA.');
          }
        });
      });

      req.on('error', (error) => {
        console.warn('[Claude] HTTPS error:', error.message);
        resolve(`Error de conexión con la IA: ${error.message}`);
      });

      req.setTimeout(35000, () => {
        req.destroy();
        resolve('Timeout: La IA tardó demasiado en responder. Inténtalo de nuevo.');
      });

      req.write(bodyBuffer);
      req.end();
    });
  }

  async takeScreenshot() {
    const scriptPath = path.join(os.tmpdir(), 'bianca_sc.ps1');
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
      '$b = New-Object System.Drawing.Bitmap($s.Width, $s.Height)',
      '$g = [System.Drawing.Graphics]::FromImage($b)',
      '$g.CopyFromScreen($s.X, $s.Y, 0, 0, $s.Size)',
      `$b.Save('${SCREENSHOT_PATH}')`,
      '$g.Dispose(); $b.Dispose()',
      'Write-Output "SCREENSHOT_OK"'
    ].join('\r\n');
    return new Promise((resolve) => {
      try {
        fs.writeFileSync(scriptPath, script, 'utf8');
        exec(
          `"${POWERSHELL_PATH}" -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
          { timeout: 12000, windowsHide: true },
          (error, stdout) => {
            if (error || !stdout.includes('SCREENSHOT_OK')) {
              console.warn('[Vision] takeScreenshot error:', error?.message);
              resolve(null);
              return;
            }
            try { resolve(fs.readFileSync(SCREENSHOT_PATH).toString('base64')); }
            catch { resolve(null); }
          }
        );
      } catch { resolve(null); }
    });
  }

  async getActiveWindows() {
    return new Promise((resolve) => {
      const cmd = `"${POWERSHELL_PATH}" -NoProfile -Command "Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object -First 15 ProcessName,MainWindowTitle | ConvertTo-Json -Compress -Depth 1"`;
      exec(cmd, { timeout: 5000, windowsHide: true }, (error, stdout) => {
        if (error || !stdout.trim()) { resolve([]); return; }
        try {
          const arr = JSON.parse(stdout.trim());
          const list = Array.isArray(arr) ? arr : [arr];
          resolve(list.map(w => `${w.ProcessName} — "${w.MainWindowTitle}"`));
        } catch { resolve([]); }
      });
    });
  }

  async executeClaudeActions(text) {
    const cmdRegex = /^CMD:\s*(.+)$/gm;
    let match;
    const executed = [];
    while ((match = cmdRegex.exec(text)) !== null) {
      const command = match[1].trim();
      console.log('[Action] Executing:', command.substring(0, 80));
      const scriptPath = path.join(os.tmpdir(), `bianca_action_${Date.now()}.ps1`);
      const result = await new Promise((resolve) => {
        try {
          fs.writeFileSync(scriptPath, command, 'utf8');
          exec(
            `"${POWERSHELL_PATH}" -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
            { timeout: 15000, windowsHide: true },
            (error, stdout, stderr) => {
              try { fs.unlinkSync(scriptPath); } catch {}
              resolve(((stdout || stderr || '').trim()).substring(0, 300));
            }
          );
        } catch (e) { resolve(`Error: ${e.message}`); }
      });
      executed.push(result ? `Ejecutado: ${result}` : 'Acción ejecutada.');
    }
    const cleanText = text.replace(/^CMD:\s*.+\n?/gm, '').trim();
    return executed.length > 0
      ? cleanText + (cleanText ? '\n\n' : '') + executed.join('\n')
      : cleanText;
  }

  async getTime() {
    const now = new Date();
    return `Hora: ${now.toLocaleTimeString('es-ES')}`;
  }

  async executeSystemCommand(command) {
    return new Promise((resolve) => {
      try {
        const psCommand = `"${POWERSHELL_PATH}" -NoProfile -Command "${command.replace(/"/g, '\\"')}"`;
        
        exec(psCommand, { 
          cwd: WORKSPACE,
          timeout: 10000,
          maxBuffer: 1024 * 1024,
          windowsHide: true
        }, (error, stdout, stderr) => {
          if (error && !stdout && !stderr) {
            resolve(`Error: ${error.message}`.substring(0, 500));
          } else {
            const output = (stdout || stderr || 'Comando ejecutado').trim();
            resolve(output.substring(0, 500));
          }
        });
      } catch (error) {
        resolve(`Error ejecutando comando: ${error.message}`);
      }
    });
  }

  async listDirectory(dirPath) {
    return new Promise((resolve) => {
      try {
        const safePath = dirPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const cmd = `"${POWERSHELL_PATH}" -NoProfile -Command "Get-ChildItem '${safePath}' -Force -ErrorAction SilentlyContinue | Select-Object -First 20 Name"`;
        
        exec(cmd, { 
          timeout: 5000, 
          maxBuffer: 1024 * 1024,
          windowsHide: true
        }, (error, stdout, stderr) => {
          const output = stdout && stdout.trim() ? stdout.trim() : (stderr ? stderr.trim() : 'Directorio vacío');
          resolve(output.substring(0, 500));
        });
      } catch (error) {
        resolve(`Error: ${error.message}`);
      }
    });
  }

  async readFile(filePath) {
    return new Promise((resolve) => {
      try {
        if (!fs.existsSync(filePath)) {
          resolve(`Archivo no encontrado: ${filePath}`);
          return;
        }
        const content = fs.readFileSync(filePath, 'utf8');
        resolve(content.substring(0, 500) + (content.length > 500 ? '\n...' : ''));
      } catch (error) {
        resolve(`Error leyendo archivo: ${error.message}`);
      }
    });
  }

  async listProcesses() {
    return new Promise((resolve) => {
      try {
        // Simple, reliable PowerShell command
        const cmd = `"${POWERSHELL_PATH}" -NoProfile -Command "Get-Process | Sort-Object WorkingSet -Descending | Select-Object -First 15 ProcessName, Id | Format-Table -AutoSize"`;
        
        exec(cmd, {
          timeout: 5000,
          maxBuffer: 1024 * 1024,
          windowsHide: true
        }, (error, stdout, stderr) => {
          let output = stdout && stdout.trim() ? stdout.trim() : (stderr ? stderr.trim() : '');
          if (!output) {
            output = 'No processes data available';
          }
          resolve(output.substring(0, 800));
        });
      } catch (error) {
        resolve(`Error: ${error.message}`);
      }
    });
  }

  async checkDiskSpace() {
    return new Promise((resolve) => {
      try {
        const cmd = `"${POWERSHELL_PATH}" -NoProfile -Command "$d=Get-PSDrive C;'C: {0:F2}GB / {1:F2}GB' -f [math]::Round($d.Used/1GB,2),[math]::Round(($d.Used+$d.Free)/1GB,2)"`;
        
        exec(cmd, {
          timeout: 5000,
          maxBuffer: 1024 * 1024,
          windowsHide: true
        }, (error, stdout, stderr) => {
          const output = stdout && stdout.trim() ? stdout.trim() : (stderr ? stderr.trim() : 'No disk info');
          resolve(output.substring(0, 300));
        });
      } catch (error) {
        resolve(`Error: ${error.message}`);
      }
    });
  }

  async checkMemory() {
    return new Promise((resolve) => {
      try {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const usage = ((usedMem / totalMem) * 100).toFixed(2);
        resolve(`Memoria: ${(usedMem / (1024 ** 3)).toFixed(2)} GB / ${(totalMem / (1024 ** 3)).toFixed(2)} GB (${usage}% en uso)`);
      } catch (error) {
        resolve(`Error: ${error.message}`);
      }
    });
  }

  async executeTask(task) {
    try {
      const result = await this.processCommand(task.command || task.action);
      
      if (this.openclawConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'task.result',
          taskId: task.id,
          result,
          status: 'completed'
        }));
      }
    } catch (error) {
      console.error('[Bianca] Task error:', error.message);
    }
  }

  logToMemory(message) {
    try {
      const todayLog = path.join(MEMORY_DIR, this.getTodayFilename());
      const timestamp = new Date().toISOString();
      const logEntry = `[${timestamp}] ${message}\n`;
      fs.appendFileSync(todayLog, logEntry);
    } catch (error) {
      console.error('[Memory] Write error:', error.message);
    }
  }

  getTodayFilename() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}.log`;
  }

  getStatus() {
    return {
      ready: this.ready,
      sessionId: this.sessionId,
      openclawConnected: this.openclawConnected,
      commandCount: this.commandHistory.length,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = BiancaAgent;
