/**
 * controller.js - Simplified Bianca Controller (Local)
 * 
 * Handles core Bianca operations without external dependencies
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration
const WORKSPACE = 'C:\\Users\\DEEPGAMING\\.openclaw\\workspace';
const MEMORY_DIR = path.join(WORKSPACE, 'memory');
const STATUS = {
  ready: true,
  gateway: 'ws://127.0.0.1:18789',
  started: new Date().toISOString()
};

// Initialize controller
async function init() {
  try {
    // Create memory directory if not exists
    if (!fs.existsSync(MEMORY_DIR)) {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
    }
    
    // Initialize status log
    const todayLog = path.join(MEMORY_DIR, getTodayFilename());
    if (!fs.existsSync(todayLog)) {
      const header = `[BIANCA INIT] ${new Date().toISOString()}\nSystem initialized successfully\n`;
      fs.writeFileSync(todayLog, header);
    }
    
    console.log('[Controller] Initialized');
    return { status: 'ok', initialized: true };
  } catch (error) {
    console.error('[Controller] Init error:', error.message);
    throw error;
  }
}

// Get controller status
function getStatus() {
  return {
    ready: true,
    version: '1.0.0',
    gateway: 'ws://127.0.0.1:18789',
    memory: MEMORY_DIR,
    timestamp: new Date().toISOString()
  };
}

// Execute command
async function executeCommand(command, options = {}) {
  try {
    const { cwd = process.cwd(), timeout = 30000 } = options;
    
    const result = execSync(command, {
      cwd,
      timeout,
      encoding: 'utf8',
      shell: true
    });
    
    // Log to memory
    logToMemory(`[COMMAND] ${command}\n[OUTPUT]\n${result}`);
    
    return {
      status: 'success',
      output: result,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    const errorMsg = error.message || error.toString();
    
    // Log error
    logToMemory(`[ERROR] ${error.command}\n${errorMsg}`);
    
    return {
      status: 'error',
      error: errorMsg,
      timestamp: new Date().toISOString()
    };
  }
}

// Read memory
async function readMemory() {
  try {
    const todayLog = path.join(MEMORY_DIR, getTodayFilename());
    if (fs.existsSync(todayLog)) {
      const content = fs.readFileSync(todayLog, 'utf8');
      return { memory: content, updated: new Date().toISOString() };
    }
    return { memory: '', updated: new Date().toISOString() };
  } catch (error) {
    throw new Error(`Failed to read memory: ${error.message}`);
  }
}

// Write to memory log
function logToMemory(message) {
  try {
    const todayLog = path.join(MEMORY_DIR, getTodayFilename());
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    
    fs.appendFileSync(todayLog, logEntry);
  } catch (error) {
    console.error('[Memory] Write error:', error.message);
  }
}

// Get today's filename
function getTodayFilename() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}.log`;
}

// Export
module.exports = {
  init,
  getStatus,
  executeCommand,
  readMemory,
  logToMemory
};
