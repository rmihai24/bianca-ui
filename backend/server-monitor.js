#!/usr/bin/env node
/**
 * server-monitor.js - Bianca Monitor Server (Alternative Port)
 * Ejecuta en puerto 9000 para evitar conflictos
 */

process.env.PORT = 9000;
process.env.WS_PORT = 9001;

require('./server');
