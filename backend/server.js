/**
 * server.js - Bianca WebSocket & REST API Server
 * 
 * Provides REST endpoints and WebSocket connection for Bianca UI
 * Bridges Electron frontend to agent backend
 * 
 * Usage:
 *   node server.js
 *   Server starts on http://localhost:3000 and ws://localhost:3001
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Import Bianca Agent
const BiancaAgent = require('./bianca-agent');
const bianca = new BiancaAgent();

// Configuration
const PORT = process.env.PORT || 3005;
const WS_PORT = process.env.WS_PORT || 3006;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Create Express app
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// Initialize Bianca agent
let agentReady = false;

bianca.init().then((result) => {
  console.log('[Server] Bianca agent initialized:', result);
  agentReady = true;
}).catch((error) => {
  console.error('[Server] Failed to initialize Bianca agent:', error);
});

/**
 * REST API Routes
 */

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    agent: agentReady ? 'ready' : 'initializing',
    openclaw: bianca.openclawConnected ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

// Agent status
app.get('/api/status', (req, res) => {
  const status = bianca.getStatus();
  res.json(status);
});

// Memory endpoints
app.get('/api/memory', async (req, res) => {
  try {
    const memoryManager = require('../../tools/memory_manager');
    const memory = await memoryManager.readMemory();
    res.json(memory);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/memory/today', async (req, res) => {
  try {
    const memoryManager = require('../../tools/memory_manager');
    const log = await memoryManager.readTodayLog();
    res.json(log);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Execute command
app.post('/api/execute', async (req, res) => {
  try {
    const { command, cwd, timeout } = req.body;
    
    if (!command) {
      return res.status(400).json({ error: 'Command required' });
    }
    
    const result = await bianca.executeSystemCommand(command);
    res.json({ success: true, output: result });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Screenshot endpoint — captures primary screen, returns base64 PNG
app.get('/api/screenshot', async (req, res) => {
  try {
    const data = await bianca.takeScreenshot();
    if (!data) return res.status(503).json({ error: 'Screenshot failed' });
    res.json({ success: true, image: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Active windows endpoint — lists visible windows with titles
app.get('/api/windows', async (req, res) => {
  try {
    const windows = await bianca.getActiveWindows();
    res.json({ success: true, windows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/memory/analysis', async (req, res) => {
  try {
    const report = await bianca.analyzeMemory();
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// File operations
app.post('/api/file/read', async (req, res) => {
  try {
    const { path: filePath } = req.body;
    
    if (!filePath) {
      return res.status(400).json({ error: 'Path required' });
    }
    
    const result = await bianca.readFile(filePath);
    res.json({ success: true, content: result });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/file/write', async (req, res) => {
  try {
    const { path: filePath, content, append } = req.body;
    
    if (!filePath || content === undefined) {
      return res.status(400).json({ error: 'Path and content required' });
    }
    
    // Write using PowerShell
    const safePath = filePath.replace(/'/g, "''");
    const safeContent = content.replace(/'/g, "''");
    const cmd = append 
      ? `Add-Content -Path '${safePath}' -Value '${safeContent}'`
      : `Set-Content -Path '${safePath}' -Value '${safeContent}'`;
    
    const result = await bianca.executeSystemCommand(cmd);
    res.json({ success: true, output: result });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * WebSocket Handlers
 */

wss.on('connection', (ws) => {
  console.log('[Server] New WebSocket client connected');
  
  const clientId = Math.random().toString(36).substring(7);
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      const { action, params, id } = data;
      
      console.log(`[WS] ${clientId} - Action: ${action}`);
      
      let result;
      
      switch (action) {
        case 'execute':
          result = await bianca.executeSystemCommand(params.command);
          break;
          
        case 'read_file':
          result = await bianca.readFile(params.path);
          break;
          
        case 'write_file':
          result = await bianca.executeSystemCommand(`Set-Content -Path '${params.path}' -Value '${params.content}'`);
          break;
          
        case 'append_file':
          result = await bianca.executeSystemCommand(`Add-Content -Path '${params.path}' -Value '${params.content}'`);
          break;
          
        case 'status':
          result = bianca.getStatus();
          break;
          
        default:
          result = { error: 'Unknown action: ' + action };
      }
      
      // Send response
      ws.send(JSON.stringify({
        id,
        action,
        result
      }));
      
    } catch (error) {
      ws.send(JSON.stringify({
        error: error.message,
        timestamp: new Date().toISOString()
      }));
    }
  });
  
  ws.on('close', () => {
    console.log(`[Server] Client ${clientId} disconnected`);
  });
  
  ws.on('error', (error) => {
    console.error(`[Server] WebSocket error (${clientId}):`, error.message);
  });
});

// Monitor dashboard
app.get('/monitor', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/monitor.html'));
});

/**
 * Start server
 */
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║         🤖 BIANCA SERVER             ║
╚══════════════════════════════════════╝

✅ HTTP API listening on: http://localhost:${PORT}
✅ Monitor Dashboard on: http://localhost:${PORT}/monitor
✅ WebSocket listening on: ws://localhost:${PORT}

Environment: ${NODE_ENV}
Timestamp: ${new Date().toISOString()}

Ready to receive commands! 🚀
`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down gracefully...');
  server.close(() => {
    console.log('[Server] Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n[Server] SIGTERM received, shutting down...');
  server.close(() => {
    console.log('[Server] Server closed');
    process.exit(0);
  });
});

// Process command with Bianca Agent
app.post('/api/command', async (req, res) => {
  try {
    const { command } = req.body;
    
    if (!command) {
      return res.status(400).json({ error: 'Comando vacío' });
    }

    // Process with Bianca agent
    const result = await bianca.processCommand(command);
    
    res.json({ response: result, success: true });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * OpenClaw Integration Endpoints
 */

// OpenClaw callback - for receiving tasks from OpenClaw
app.post('/api/openclaw/callback', async (req, res) => {
  try {
    const { task, command, data } = req.body;
    
    let result;
    if (command) {
      // Execute command sent from OpenClaw
      result = await bianca.processCommand(command);
    } else if (task) {
      // Execute task sent from OpenClaw
      result = await bianca.executeTask(task);
    } else {
      return res.status(400).json({ error: 'Task or command required' });
    }

    res.json({
      status: 'success',
      result: result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error',
      error: error.message 
    });
  }
});

// OpenClaw status - report Bianca status to OpenClaw
app.get('/api/openclaw/status', (req, res) => {
  res.json({
    agent: {
      id: bianca.agentId,
      name: 'Bianca',
      type: 'agent',
      status: agentReady ? 'ready' : 'initializing',
      sessionId: bianca.sessionId
    },
    capabilities: ['command', 'memory', 'speak', 'file', 'system'],
    api: {
      endpoint: 'http://localhost:3005',
      healthCheck: '/api/health',
      command: '/api/command',
      callback: '/api/openclaw/callback'
    },
    timestamp: new Date().toISOString()
  });
});

// Text-to-speech endpoint
app.post('/api/speak', async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text) {
      return res.status(400).json({ error: 'Texto vacío' });
    }

    // Log to memory
    const memoryFile = require('./controller').logToMemory;
    if (memoryFile) {
      memoryFile(`[SPEAK] ${text}`);
    }

    res.json({
      status: 'success',
      text,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Export for testing
module.exports = { app, server, wss };
