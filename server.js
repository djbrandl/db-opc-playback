const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const OPC_PORT = parseInt(process.env.OPC_PORT) || 4334;

// Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Managers
const dbManager = require('./managers/dbManager');
const opcManager = require('./managers/opcManager');
const playbackEngine = require('./managers/playbackEngine');

// Global State
let appState = {
    isRunning: false,
    config: {},
    lastQuery: "",
    previewRow: null // To setup OPC tags
};

// Initialize OPC Server on startup (or lazy load)
opcManager.startServer(OPC_PORT).catch(console.error);

io.on('connection', (socket) => {
    console.log('Client connected');
    
    // Send configuration to client
    socket.emit('server-info', { 
        opcPort: OPC_PORT,
        opcEndpoint: `opc.tcp://localhost:${OPC_PORT}/UA/PlaybackServer`
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });

    socket.on('connect-db', async (config, callback) => {
        console.log('Connecting to DB...', config.type);
        const result = await dbManager.connect(config);
        callback(result);
    });

    socket.on('run-query', async (query, callback) => {
        console.log('Running query preview...');
        
        const previewRows = [];
        let columns = [];
        let error = null;

        try {
            const stream = dbManager.getStream(query);
            
            stream.on('data', (row) => {
                if (previewRows.length < 10) {
                    previewRows.push(row);
                } else {
                    // We have enough for preview, destroy stream
                    stream.destroy();
                }
            });

            stream.on('error', (err) => {
                // Ignore error if it's just from destroying the stream early
                if (err.message !== 'Premature close') {
                    error = err;
                }
            });

            stream.on('end', () => {
                // Determine columns from first row
                if (previewRows.length > 0) {
                    columns = Object.keys(previewRows[0]);
                    appState.previewRow = previewRows[0];
                }
                
                appState.lastQuery = query;
                
                if (error) {
                    callback({ success: false, message: error.message });
                } else {
                    callback({ success: true, preview: previewRows, columns, totalRows: 'Unknown (Streamed)' });
                }
            });

            // Close stream if it hangs or finishes
            stream.on('close', () => {
                 if (!error && !callback.called) {
                     // Ensure callback is called if 'end' didn't fire due to destroy
                     if (previewRows.length > 0) {
                        columns = Object.keys(previewRows[0]);
                        appState.previewRow = previewRows[0];
                    }
                    appState.lastQuery = query;
                    callback({ success: true, preview: previewRows, columns, totalRows: 'Unknown (Streamed)' });
                    callback.called = true; // prevent double call
                 }
            });
            // Hack to track callback state
            callback.called = false;

        } catch (err) {
            callback({ success: false, message: err.message });
        }
    });

    socket.on('start-playback', (config) => {
        // config: { timestampCol, mode, interval, multiplier, rbe }
        console.log('Starting playback...', config);
        
        if (!appState.lastQuery) {
            socket.emit('error', 'No query defined');
            return;
        }

        if (appState.isRunning) {
             playbackEngine.stop();
        }

        // Setup OPC Address Space using the preview row we saved
        if (appState.previewRow) {
            opcManager.setupAddressSpaceFromData(appState.previewRow);
        } else {
            socket.emit('error', 'No data structure found. Run query first.');
            return;
        }

        // Start Stream
        try {
            const stream = dbManager.getStream(appState.lastQuery);
            playbackEngine.initialize(stream, config);

            // UI RBE State
            let lastRow = null;

            // Bind events
            playbackEngine.on('row', (row) => {
                opcManager.updateTags(row, config.rbe);
                
                // Handle UI RBE
                if (config.rbe) {
                    if (!lastRow) {
                        io.emit('playback-update', row);
                        lastRow = { ...row };
                        return;
                    }

                    // Calculate Diff
                    const diff = {};
                    let hasChanges = false;

                    for (const key in row) {
                        // Skip timestamp column from "meaningful change" detection
                        if (key === config.timestampCol) continue;

                        // Compare with strict equality
                        // Note: Dates might need special handling if they are objects, but usually stream returns strings or standard types.
                        // If they are Date objects, this comparison might fail (always true).
                        // Let's assume primitives or strings for now.
                        let val = row[key];
                        let lastVal = lastRow[key];
                        
                        // Handle Date object comparison
                        if (val instanceof Date && lastVal instanceof Date) {
                             if (val.getTime() !== lastVal.getTime()) {
                                 diff[key] = val;
                                 hasChanges = true;
                             }
                        } else if (val !== lastVal) {
                            diff[key] = val;
                            hasChanges = true;
                        }
                    }

                    if (hasChanges) {
                         // Add timestamp to diff so user knows WHEN it happened, even if it's not the trigger
                         if (config.timestampCol && row[config.timestampCol]) {
                             diff[config.timestampCol] = row[config.timestampCol];
                         }
                         io.emit('playback-update', diff);
                         lastRow = { ...row };
                    }
                } else {
                    io.emit('playback-update', row);
                }
            });

            playbackEngine.on('finished', () => {
                io.emit('playback-finished');
                appState.isRunning = false;
                playbackEngine.removeAllListeners('row');
                playbackEngine.removeAllListeners('finished');
            });
            
            playbackEngine.on('error', (err) => {
                socket.emit('error', 'Playback Error: ' + err.message);
                appState.isRunning = false;
            });

            playbackEngine.start();
            appState.isRunning = true;
            socket.emit('playback-started');

        } catch (err) {
            socket.emit('error', 'Stream Error: ' + err.message);
        }
    });

    socket.on('stop-playback', () => {
        playbackEngine.stop();
        playbackEngine.removeAllListeners('row');
        playbackEngine.removeAllListeners('finished');
        appState.isRunning = false;
        io.emit('playback-stopped');
    });
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
