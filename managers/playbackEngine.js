const EventEmitter = require('events');

class PlaybackEngine extends EventEmitter {
    constructor() {
        super();
        this.stream = null;
        this.buffer = [];
        this.config = {};
        this.isPlaying = false;
        this.isStreamEnded = false;
        this.processLoop = null;
        
        // Backpressure settings
        this.highWaterMark = 1000; // Pause DB when buffer hits 1000
        this.lowWaterMark = 100;   // Resume DB when buffer drops to 100
    }

    initialize(stream, config) {
        this.stop(); // Reset
        this.stream = stream;
        this.config = config;
        this.buffer = [];
        this.isStreamEnded = false;
        this.isPlaying = false;

        // Setup Stream Listeners
        this.stream.on('data', (row) => {
            this.buffer.push(row);
            if (this.buffer.length >= this.highWaterMark) {
                this.stream.pause();
            }
        });

        this.stream.on('end', () => {
            this.isStreamEnded = true;
        });

        this.stream.on('error', (err) => {
            console.error("Stream Error:", err);
            this.stop();
            this.emit('error', err);
        });
    }

    start() {
        if (!this.stream) return;
        this.isPlaying = true;
        
        // Start processing loop
        this.processNext();
    }

    stop() {
        this.isPlaying = false;
        if (this.processLoop) {
            clearTimeout(this.processLoop);
            this.processLoop = null;
        }
        
        // Destroy stream if active
        if (this.stream) {
            this.stream.removeAllListeners();
            if (this.stream.destroy) this.stream.destroy();
            this.stream = null;
        }
        
        this.buffer = [];
    }

    getTimeVal(row) {
        if (!this.config.timestampCol) return 0;
        const raw = row[this.config.timestampCol];
        if (raw === null || raw === undefined) return 0;

        // "Auto" assumes standard Date parsable string or object
        if (!this.config.timestampUnit || this.config.timestampUnit === 'auto') {
            return new Date(raw).getTime();
        }

        // Numeric parsing
        const num = parseFloat(raw);
        if (isNaN(num)) return 0;

        switch (this.config.timestampUnit) {
            case 's': return num * 1000;
            case 'm': return num * 60000;
            case 'ms': 
            default: return num;
        }
    }

    processNext() {
        if (!this.isPlaying) return;

        // If buffer is empty
        if (this.buffer.length === 0) {
            if (this.isStreamEnded) {
                this.emit('finished');
                this.stop();
            } else {
                // Buffer underflow: wait a bit and retry (stream might be slow)
                this.processLoop = setTimeout(() => this.processNext(), 100);
            }
            return;
        }

        // Manage Flow Control
        if (this.buffer.length <= this.lowWaterMark && this.stream && this.stream.isPaused()) {
            this.stream.resume();
        }

        // Get current row
        const currentRow = this.buffer.shift();
        this.emit('row', currentRow);

        // Look ahead for delay calculation
        if (this.buffer.length === 0) {
            // Can't calculate delta without next row. 
            // If stream ended, we are done next tick.
            // If not, just wait a default small time or poll.
            this.processLoop = setTimeout(() => this.processNext(), 10); 
            return;
        }

        const nextRow = this.buffer[0];
        let delay = 1000;

        if (this.config.mode === 'fixed') {
            delay = parseInt(this.config.interval) || 1000;
        } else {
            // Realtime / Multiplier
            if (!this.config.timestampCol) {
                 // Fallback if TS missing
                 delay = 1000; 
            } else {
                const tCurrent = this.getTimeVal(currentRow);
                const tNext = this.getTimeVal(nextRow);
                let delta = tNext - tCurrent;

                // Handle unsorted data or identical timestamps gracefully
                if (isNaN(delta) || delta < 0) delta = 0; 

                if (this.config.mode === 'multiplier') {
                    const multiplier = parseFloat(this.config.multiplier) || 1.0;
                    delay = delta / multiplier;
                } else {
                    delay = delta;
                }
            }
        }

        this.processLoop = setTimeout(() => this.processNext(), delay);
    }
}

module.exports = new PlaybackEngine();