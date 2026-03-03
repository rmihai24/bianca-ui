const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 500,
    alwaysOnTop: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile('public/index.html');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Manejador IPC para enviar comandos al backend
ipcMain.handle('execute-command', async (event, command) => {
  try {
    const response = await fetch('http://localhost:3001/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command })
    });
    const data = await response.json();
    return data;
  } catch (error) {
    return { error: error.message };
  }
});

// Manejador IPC para hacer speak (TTS)
ipcMain.handle('speak', async (event, text) => {
  try {
    const response = await fetch('http://localhost:3001/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    return { success: true };
  } catch (error) {
    return { error: error.message };
  }
});

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
