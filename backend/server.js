const express = require('express');
const cors = require('cors');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Simulación de respuestas (luego conectar con OpenClaw)
const responses = {
  'hola': 'Hola, soy Bianca. ¿Cómo puedo ayudarte?',
  'qué hora es': `Son las ${new Date().toLocaleTimeString('es-ES')}`,
  'que puedes hacer': 'Puedo ejecutar comandos, decirte la hora, responder preguntas general, conectarme con OpenClaw Gateway y procesar tus solicitudes de voz',
  'que haces': 'Soy Bianca, tu asistente de voz inteligente basada en Electron y Node.js',
  'ayuda': 'Estos son los comandos disponibles: holaola, qué hora es, quién eres, estado, ayuda, gracias, nombre, versión',
  'quién eres': 'Soy Bianca, tu asistente de voz inteligente integrado con OpenClaw Gateway',
  'estado': 'Sistema operativo al 100%. Todos los módulos activos. Conexión con backend establecida.',
  'gracias': 'De nada, siempre a tu disposición',
  'nombre': 'Mi nombre es Bianca',
  'versión': 'Bianca versión 1.0.0 - Voice Interface Electron',
  'conectar': 'Conectando con OpenClaw Gateway... Conexión establecida correctamente',
  'comando': 'Procesando comando en el gateway de OpenClaw',
  'default': 'Comando procesado correctamente. Para más ayuda escribe "ayuda"'
};

// API: Ejecutar comando
app.post('/api/command', (req, res) => {
  const { command } = req.body;
  
  if (!command) {
    return res.status(400).json({ error: 'Comando vacío' });
  }

  // Buscar respuesta (case-insensitive) - búsqueda flexible
  const lowerCommand = command.toLowerCase();
  let response = responses['default'];
  let foundExact = false;

  // Primero buscar coincidencia exacta
  for (const key in responses) {
    if (lowerCommand === key) {
      response = responses[key];
      foundExact = true;
      break;
    }
  }

  // Si no hay coincidencia exacta, buscar palabras clave
  if (!foundExact) {
    for (const key in responses) {
      if (lowerCommand.includes(key)) {
        response = responses[key];
        break;
      }
    }
  }

  console.log(`[COMANDO] ${command}`);
  console.log(`[RESPUESTA] ${response}`);

  res.json({
    command,
    response,
    timestamp: new Date().toISOString()
  });
});

// API: Text-to-Speech (Windows TTS)
app.post('/api/speak', (req, res) => {
  const { text } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'Texto vacío' });
  }

  // Usar PowerShell para Windows TTS (SAPI5)
  const psCommand = `
    Add-Type -AssemblyName System.Speech;
    $speak = New-Object System.Speech.Synthesis.SpeechSynthesizer;
    $speak.SelectVoice('Microsoft Server Speech Text to Speech Voice (es-ES, Helena)');
    $speak.Speak("${text.replace(/"/g, '\\"')}");
  `;

  try {
    const { spawn } = require('child_process');
    const powerShellPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    
    spawn(powerShellPath, ['-NoProfile', '-Command', psCommand], {
      stdio: 'ignore',
      detached: true
    }).unref();

    console.log(`[TTS] ${text}`);
    res.json({ success: true, text });
  } catch (error) {
    console.error('Error en TTS:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Info del servidor
app.get('/api/info', (req, res) => {
  res.json({
    name: 'Bianca Backend',
    version: '1.0.0',
    status: 'online',
    timestamp: new Date().toISOString()
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`[BIANCA] Backend iniciado en puerto ${PORT}`);
  console.log(`[INFO] Espera a que Electron se conecte...`);
});
