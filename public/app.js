const socket = io();

// Elements
const connForm = document.getElementById('connForm');
const connStatus = document.getElementById('connStatus');
const runQueryBtn = document.getElementById('runQueryBtn');
const sqlQuery = document.getElementById('sqlQuery');
const queryResult = document.getElementById('queryResult');
const previewTable = document.getElementById('previewTable');
const rowCount = document.getElementById('rowCount');
const tsCol = document.getElementById('tsCol');
const playMode = document.getElementById('playMode');
const modeOptions = document.getElementById('modeOptions');
const multiplierInput = document.getElementById('multiplierInput');
const intervalInput = document.getElementById('intervalInput');
const valMultiplier = document.getElementById('valMultiplier');
const valInterval = document.getElementById('valInterval');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const liveLogs = document.getElementById('liveLogs');
const liveIndicator = document.getElementById('liveIndicator');
const opcEndpointDisplay = document.getElementById('opcEndpointDisplay');

let availableColumns = [];

socket.on('server-info', (info) => {
    if (opcEndpointDisplay && info.opcEndpoint) {
        opcEndpointDisplay.textContent = info.opcEndpoint;
    }
});

// DB Connection
connForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const config = {
        type: document.getElementById('dbType').value,
        host: document.getElementById('dbHost').value,
        port: document.getElementById('dbPort').value,
        user: document.getElementById('dbUser').value,
        password: document.getElementById('dbPass').value,
        database: document.getElementById('dbName').value
    };

    connStatus.textContent = 'Connecting...';
    connStatus.className = 'text-[10px] text-yellow-500 animate-pulse';

    socket.emit('connect-db', config, (res) => {
        if (res.success) {
            connStatus.textContent = 'CONNECTED';
            connStatus.className = 'text-[10px] text-green-500 font-bold';
            runQueryBtn.disabled = false;
        } else {
            connStatus.textContent = 'ERROR';
            connStatus.className = 'text-[10px] text-red-500 font-bold';
            alert('Connection Failed: ' + res.message);
        }
    });
});

// Run Query
runQueryBtn.addEventListener('click', () => {
    const query = sqlQuery.value;
    if (!query.trim()) return;

    runQueryBtn.disabled = true;
    runQueryBtn.textContent = 'Running...';
    queryResult.classList.add('opacity-50');

    socket.emit('run-query', query, (res) => {
        runQueryBtn.disabled = false;
        runQueryBtn.textContent = 'Run Query';
        queryResult.classList.remove('opacity-50');

        if (res.success) {
            // Render Preview
            renderPreview(res.columns, res.preview);
            rowCount.textContent = `${res.totalRows} rows`;
            // queryResult is always visible in new design, but we populate it
            
            // Populate Timestamp Dropdown
            availableColumns = res.columns;
            tsCol.innerHTML = '<option selected disabled>Select Column...</option>';
            res.columns.forEach(col => {
                const opt = document.createElement('option');
                opt.value = col;
                opt.textContent = col;
                tsCol.appendChild(opt);
            });
            
            checkStartReady();
        } else {
            alert('Query Error: ' + res.message);
        }
    });
});

// Helper: Render Table
function renderPreview(columns, rows) {
    const thead = previewTable.querySelector('thead');
    const tbody = previewTable.querySelector('tbody');
    thead.innerHTML = '';
    tbody.innerHTML = '';

    // Header
    const trHead = document.createElement('tr');
    columns.forEach(col => {
        const th = document.createElement('th');
        th.className = "sticky top-0 bg-[#333] p-2 text-xs font-semibold text-gray-300 border-b border-[#3e3e42] text-left";
        th.textContent = col;
        trHead.appendChild(th);
    });
    thead.appendChild(trHead);

    // Body
    if (rows.length === 0) {
        document.getElementById('emptyState').classList.remove('hidden');
    } else {
        document.getElementById('emptyState').classList.add('hidden');
        rows.forEach(row => {
            const tr = document.createElement('tr');
            tr.className = "hover:bg-[#2a2d2e] transition-colors border-b border-[#3e3e42]";
            columns.forEach(col => {
                const td = document.createElement('td');
                td.className = "p-2 text-xs font-mono text-gray-400";
                td.textContent = row[col];
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
    }
}

// Mode Selection UI
playMode.addEventListener('change', () => {
    const mode = playMode.value;
    const modeHint = document.getElementById('modeHint');
    
    // Reset
    multiplierInput.classList.add('hidden');
    intervalInput.classList.add('hidden');
    modeHint.classList.add('hidden');

    if (mode === 'multiplier') {
        multiplierInput.classList.remove('hidden');
    } else if (mode === 'fixed') {
        intervalInput.classList.remove('hidden');
    } else if (mode === 'realtime') {
        modeHint.textContent = "Replays data using original timestamp deltas.";
        modeHint.classList.remove('hidden');
    }
    checkStartReady();
});

tsCol.addEventListener('change', checkStartReady);

function checkStartReady() {
    const hasCols = availableColumns.length > 0;
    const tsSelected = tsCol.value && tsCol.value !== 'Select Column...';
    
    if (hasCols && tsSelected) {
        startBtn.disabled = false;
    } else {
        startBtn.disabled = true;
    }
}

// Playback Control
startBtn.addEventListener('click', () => {
    const config = {
        timestampCol: tsCol.value,
        timestampUnit: document.getElementById('tsUnit').value,
        mode: playMode.value,
        multiplier: valMultiplier.value,
        interval: valInterval.value,
        rbe: document.getElementById('rbeCheck').checked
    };
    
    socket.emit('start-playback', config);
    liveLogs.innerHTML = ''; // Clear logs
});

stopBtn.addEventListener('click', () => {
    socket.emit('stop-playback');
});

// Socket Events
socket.on('playback-started', () => {
    startBtn.disabled = true;
    stopBtn.disabled = false;
    connForm.querySelectorAll('input, select, button').forEach(el => el.disabled = true);
    addLog('System', 'Playback Started', 'text-green-500');
    if(liveIndicator) liveIndicator.classList.remove('hidden');
});

socket.on('playback-stopped', () => {
    startBtn.disabled = false;
    stopBtn.disabled = true;
    connForm.querySelectorAll('input, select, button').forEach(el => el.disabled = false);
    addLog('System', 'Playback Stopped', 'text-yellow-500');
    if(liveIndicator) liveIndicator.classList.add('hidden');
});

socket.on('playback-finished', () => {
    startBtn.disabled = false;
    stopBtn.disabled = true;
    connForm.querySelectorAll('input, select, button').forEach(el => el.disabled = false);
    addLog('System', 'Playback Finished', 'text-blue-500');
    if(liveIndicator) liveIndicator.classList.add('hidden');
});

socket.on('playback-update', (row) => {
    addLog('Data', JSON.stringify(row), 'text-gray-300');
});

socket.on('error', (msg) => {
    addLog('Error', msg, 'text-red-500');
    alert(msg);
});

function addLog(source, msg, colorClass = 'text-gray-400') {
    const div = document.createElement('div');
    div.className = "border-l-2 border-[#3e3e42] pl-2 py-1";
    
    const time = new Date().toLocaleTimeString();
    div.innerHTML = `
        <span class="text-[10px] text-[#565656] mr-2">${time}</span>
        <span class="text-[10px] font-bold uppercase tracking-wider ${colorClass} mr-2">${source}</span>
        <span class="text-gray-400">${msg}</span>
    `;
    
    liveLogs.appendChild(div);
    liveLogs.scrollTop = liveLogs.scrollHeight;
}