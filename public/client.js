const socket = io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const statusDiv = document.getElementById('status');

let players = {};
let bullets = [];
let walls = [];
let explosions = [];
let myId = null;
let lastShotTime = 0; // For shoot feedback
let authToken = localStorage.getItem('tank_token'); // persisted token

// ── Auth / UI DOM refs ──
const authOverlay     = document.getElementById('authOverlay');
const authError       = document.getElementById('authError');
const authTabs        = document.getElementById('authTabs');
const loginForm       = document.getElementById('loginForm');
const registerForm    = document.getElementById('registerForm');
const closeAuthBtn    = document.getElementById('closeAuthBtn');
const loggedInBar     = document.getElementById('loggedInBar');
const playerDisplayName = document.getElementById('playerDisplayName');
const statsModal      = document.getElementById('statsModal');
const leaderboardModal= document.getElementById('leaderboardModal');
const statsTable      = document.getElementById('statsTable');
const leaderboardList = document.getElementById('leaderboardList');
const leaderboardSelect = document.getElementById('leaderboardSelect');
const toast           = document.getElementById('toast');

let currentDisplayName = null; // set after successful login

// ── Tab switching ──
authTabs.addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') return;
    authTabs.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
    document.getElementById(e.target.dataset.tab + 'Form').classList.add('active');
    authError.textContent = '';
});

// ── Close auth panel (anonymous play) ──
closeAuthBtn.addEventListener('click', () => {
    authOverlay.classList.add('hidden');
    loggedInBar.classList.remove('visible');
    currentDisplayName = null;
    authToken = null;
});

// ── Login form ──
loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    authError.textContent = '';
    socket.emit('auth:login', { username, password });
});

// ── Register form ──
registerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('regUsername').value.trim();
    const password = document.getElementById('regPassword').value;
    const displayName = document.getElementById('regDisplayName').value.trim();
    authError.textContent = '';
    socket.emit('auth:register', { username, password, displayName });
});

// ── Stats modal ──
document.getElementById('statsBtn').addEventListener('click', () => {
    if (!authToken) return;
    socket.emit('stats:me', { token: authToken });
    statsModal.classList.add('visible');
});
document.getElementById('closeStatsBtn').addEventListener('click', () => {
    statsModal.classList.remove('visible');
});
statsModal.addEventListener('click', (e) => {
    if (e.target === statsModal) statsModal.classList.remove('visible');
});

// ── Leaderboard modal ──
document.getElementById('leaderboardBtn').addEventListener('click', () => {
    const type = leaderboardSelect.value;
    socket.emit('leaderboard:query', { type, limit: 10 });
    leaderboardModal.classList.add('visible');
});
document.getElementById('closeLeaderboardBtn').addEventListener('click', () => {
    leaderboardModal.classList.remove('visible');
});
leaderboardModal.addEventListener('click', (e) => {
    if (e.target === leaderboardModal) leaderboardModal.classList.remove('visible');
});
leaderboardSelect.addEventListener('change', () => {
    const type = leaderboardSelect.value;
    socket.emit('leaderboard:query', { type, limit: 10 });
});

// ── Logout ──
document.getElementById('logoutBtn').addEventListener('click', () => {
    if (!authToken) return;
    socket.emit('auth:logout', { token: authToken });
    authToken = null;
    localStorage.removeItem('tank_token');
    currentDisplayName = null;
    loggedInBar.classList.remove('visible');
    authOverlay.classList.remove('hidden');
});

// ── Toast helper ──
let toastTimer = null;
function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 2500);
}

// ── Socket.IO Auth events ──
socket.on('auth:register', (data) => {
    if (data.success) {
        authToken = data.token;
        currentDisplayName = data.displayName;
        localStorage.setItem('tank_token', data.token);
        loggedInBar.classList.add('visible');
        playerDisplayName.textContent = currentDisplayName;
        authOverlay.classList.add('hidden');
        authError.textContent = '';
    } else {
        authError.textContent = data.error || 'Registration failed';
    }
});

socket.on('auth:login', (data) => {
    if (data.success) {
        authToken = data.token;
        currentDisplayName = data.displayName;
        localStorage.setItem('tank_token', data.token);
        loggedInBar.classList.add('visible');
        playerDisplayName.textContent = currentDisplayName;
        authOverlay.classList.add('hidden');
        authError.textContent = '';
    } else {
        authError.textContent = data.error || 'Login failed';
    }
});

socket.on('auth:resume', (data) => {
    if (data.success) {
        authToken = data.token;
        currentDisplayName = data.displayName;
        loggedInBar.classList.add('visible');
        playerDisplayName.textContent = currentDisplayName;
        authOverlay.classList.add('hidden');
    } else {
        // Token invalid — show login panel
        authOverlay.classList.remove('hidden');
    }
});

socket.on('auth:logout', (data) => {
    loggedInBar.classList.remove('visible');
    authOverlay.classList.remove('hidden');
    currentDisplayName = null;
    authToken = null;
    localStorage.removeItem('tank_token');
    showToast(data.message || 'Logged out');
});

// ── Socket.IO Stats events ──
socket.on('stats:me', (data) => {
    document.getElementById('statScore').textContent  = data.score ?? '—';
    document.getElementById('statWins').textContent   = data.wins ?? '—';
    document.getElementById('statLosses').textContent = data.losses ?? '—';
    document.getElementById('statKills').textContent  = data.kills ?? '—';
    document.getElementById('statDeaths').textContent = data.deaths ?? '—';
    document.getElementById('statShots').textContent  = data.shotsFired ?? '—';
});

socket.on('stats:query', (data) => {
    // Show stats for queried player
    document.getElementById('statScore').textContent  = data.score ?? '—';
    document.getElementById('statWins').textContent   = data.wins ?? '—';
    document.getElementById('statLosses').textContent = data.losses ?? '—';
    document.getElementById('statKills').textContent  = data.kills ?? '—';
    document.getElementById('statDeaths').textContent = data.deaths ?? '—';
    document.getElementById('statShots').textContent  = data.shotsFired ?? '—';
});

// ── Socket.IO Leaderboard events ──
socket.on('leaderboard:query', (data) => {
    leaderboardList.innerHTML = '';
    if (!data.players || data.players.length === 0) {
        leaderboardList.innerHTML = '<li><span class="name">No players yet</span></li>';
        return;
    }
    data.players.forEach((entry, i) => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="rank">${i + 1}</span><span class="name">${entry.displayName || entry.username}</span><span class="value">${entry[data.type] ?? entry.score ?? '—'}</span>`;
        leaderboardList.appendChild(li);
    });
});

// ── Socket.IO Account events ──
socket.on('account:changePassword', (data) => {
    showToast(data.message || 'Password updated');
});

socket.on('account:delete', (data) => {
    showToast(data.message || 'Account deleted');
    loggedInBar.classList.remove('visible');
    authOverlay.classList.remove('hidden');
    authToken = null;
    localStorage.removeItem('tank_token');
});

// ── Socket.IO Game stats update ──
socket.on('game:statsUpdate', (data) => {
    let msg = '';
    if (data.kills) msg += `+${data.kills} Kill${data.kills > 1 ? 's' : ''}`;
    if (data.score) msg += ` ${data.score} pts`;
    if (msg) showToast(msg);
});

// ── Resume session on connect (auto) ──
socket.on('connect', () => {
    myId = socket.id;
    statusDiv.innerText = "Connected! [WASD] to Drive | [Space] to Fire | 🤖 AI Tanks: 3";

    // Auto-resume if we have a saved token
    if (authToken) {
        socket.emit('auth:resume', { token: authToken });
    }
});

socket.on('gameState', (state) => {
    players = state.players;
    bullets = state.bullets;
    walls = state.walls;
    explosions = state.explosions;

    // Count AI tanks and update status
    let aiCount = 0;
    for (let id in players) {
        if (players[id].isAI) aiCount++;
    }
    const humanCount = Object.keys(players).length - aiCount;
    statusDiv.innerText = `👤 Humans: ${humanCount} | 🤖 AI: ${aiCount} | [WASD] Drive | [Space] Fire`;
});

socket.on('initMap', (serverWalls) => {
    walls = serverWalls;
});

socket.on('playerJoined', (p) => console.log("Player joined:", p.id));
socket.on('playerLeft', (id) => {
    delete players[id];
});

socket.on('gameState', (state) => {
    players = state.players;
    bullets = state.bullets;
    walls = state.walls;
    explosions = state.explosions;
});

const inputState = { up: false, down: false, left: false, right: false };

document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (key === 'w') inputState.up = true;
    if (key === 's') inputState.down = true;
    if (key === 'a') inputState.left = true;
    if (key === 'd') inputState.right = true;
    if (e.code === 'Space') {
        e.preventDefault();
        socket.emit('fire');
        lastShotTime = Date.now();
    }
    socket.emit('inputUpdate', inputState);
});

document.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    if (key === 'w') inputState.up = false;
    if (key === 's') inputState.down = false;
    if (key === 'a') inputState.left = false;
    if (key === 'd') inputState.right = false;
    socket.emit('inputUpdate', inputState);
});

function drawGrid(ctx, width, height) {
    ctx.strokeStyle = '#1a1a1d';
    ctx.lineWidth = 1;
    const step = 40;
    for (let x = 0; x <= width; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
    }
    for (let y = 0; y <= height; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
    }
}

function draw() {
    // Background
    ctx.fillStyle = '#0a0a0c'; 
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawGrid(ctx, canvas.width, canvas.height);

     // Draw Walls
    ctx.shadowBlur = 0;
    walls.forEach(w => {
        if (w.destructible) {
            const alpha = w.hp / 3;
            ctx.fillStyle = `rgba(139, 90, 43, ${alpha + 0.3})`;
            ctx.strokeStyle = `rgba(160, 110, 60, ${alpha + 0.2})`;
        } else {
            ctx.fillStyle = '#444';
            ctx.strokeStyle = '#666';
        }
        ctx.fillRect(w.x, w.y, w.w, w.h);
        ctx.lineWidth = 1;
        ctx.strokeRect(w.x, w.y, w.w, w.h);
    });

    // Draw Bullets (Neon Glow)
    ctx.shadowBlur = 15;
    ctx.shadowColor = 'yellow';
    ctx.fillStyle = '#ffff00';
    bullets.forEach(b => {
        ctx.beginPath();
        ctx.arc(b.x, b.y, 4, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.shadowBlur = 0;

    // Draw Explosions
    explosions.forEach(ex => {
        ctx.beginPath();
        ctx.arc(ex.x, ex.y, (1 - ex.life) * 30, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 165, 0, ${ex.life})`;
        ctx.lineWidth = 3;
        ctx.stroke();
    });

    // Draw Players
    for (let id in players) {
        const p = players[id];
        if (p.hp <= 0) continue;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        
        // Body with Gradient
        const gradient = ctx.createRadialGradient(0, 0, 5, 0, 0, 15);
        gradient.addColorStop(0, p.color);
        gradient.addColorStop(1, '#000');
        ctx.fillStyle = gradient;
        ctx.fillRect(-15, -15, 30, 30);
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 1;
        ctx.strokeRect(-15, -15, 30, 30);
        
        // Turret
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, -4, 20, 8);
        ctx.restore();

        // HP Bar
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(p.x - 15, p.y - 30, 30, 4);
        ctx.fillStyle = p.hp > 60 ? '#00ff00' : (p.hp > 30 ? '#ffaa00' : '#ff0000');
        ctx.fillRect(p.x - 15, p.y - 30, (p.hp / 100) * 30, 4);

        // ID
        ctx.fillStyle = 'white';
        ctx.font = '10px monospace';
        ctx.fillText(id.substring(0, 5), p.x - 15, p.y - 35);
    }

    // Draw last shot muzzle flash (my tank only)
    const elapsed = Date.now() - lastShotTime;
    if (elapsed < 150) {
        const alpha = 1 - elapsed / 150;
        const flashRadius = 8 + elapsed / 150 * 12;
        ctx.save();
        for (let id in players) {
            const p = players[id];
            if (id !== myId) continue;
            ctx.translate(p.x, p.y);
            ctx.rotate(p.angle);
            ctx.beginPath();
            ctx.arc(22, 0, flashRadius, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255, 200, 50, ${alpha * 0.7})`;
            ctx.fill();
            ctx.restore();
            break;
        }
    }
}

function gameLoop() {
    draw();
    requestAnimationFrame(gameLoop);
}
gameLoop();
