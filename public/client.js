const socket = io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const statusDiv = document.getElementById('status');

// Map dimensions (server-side)
const MAP_W = 1600;
const MAP_H = 1200;

let players = {};
let bullets = [];
let weaponDrops = [];
let walls = [];
let explosions = [];
let myId = null;
let lastShotTime = 0;
let authToken = localStorage.getItem('tank_token');

// ── Camera ──
let cameraX = 0, cameraY = 0, cameraScale = 1;

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
const leaderboardList = document.getElementById('leaderboardList');
const leaderboardSelect = document.getElementById('leaderboardSelect');
const toast           = document.getElementById('toast');

let currentDisplayName = null;

// ── Tab switching ──
authTabs.addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') return;
    authTabs.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
    document.getElementById(e.target.dataset.tab + 'Form').classList.add('active');
    authError.textContent = '';
});

closeAuthBtn.addEventListener('click', () => {
    authOverlay.classList.add('hidden');
    loggedInBar.classList.remove('visible');
    currentDisplayName = null;
    authToken = null;
});

loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    authError.textContent = '';
    socket.emit('auth:login', { username, password });
});

registerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('regUsername').value.trim();
    const password = document.getElementById('regPassword').value;
    const displayName = document.getElementById('regDisplayName').value.trim();
    authError.textContent = '';
    socket.emit('auth:register', { username, password, displayName });
});

document.getElementById('statsBtn').addEventListener('click', () => {
    if (!authToken) return;
    socket.emit('stats:me', { token: authToken });
    statsModal.classList.add('visible');
});
document.getElementById('closeStatsBtn').addEventListener('click', () => statsModal.classList.remove('visible'));
statsModal.addEventListener('click', (e) => { if (e.target === statsModal) statsModal.classList.remove('visible'); });

document.getElementById('leaderboardBtn').addEventListener('click', () => {
    socket.emit('leaderboard:query', { type: leaderboardSelect.value, limit: 10 });
    leaderboardModal.classList.add('visible');
});
document.getElementById('closeLeaderboardBtn').addEventListener('click', () => leaderboardModal.classList.remove('visible'));
leaderboardModal.addEventListener('click', (e) => { if (e.target === leaderboardModal) leaderboardModal.classList.remove('visible'); });
leaderboardSelect.addEventListener('change', () => {
    socket.emit('leaderboard:query', { type: leaderboardSelect.value, limit: 10 });
});

document.getElementById('logoutBtn').addEventListener('click', () => {
    if (!authToken) return;
    socket.emit('auth:logout', { token: authToken });
    authToken = null;
    localStorage.removeItem('tank_token');
    currentDisplayName = null;
    loggedInBar.classList.remove('visible');
    authOverlay.classList.remove('hidden');
});

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
        authError.textContent = data.message || 'Registration failed';
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
        authError.textContent = data.message || 'Login failed';
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
    document.getElementById('statShots').textContent  = data.shots_fired ?? '—';
});

socket.on('stats:query', (data) => {
    document.getElementById('statScore').textContent  = data.score ?? '—';
    document.getElementById('statWins').textContent   = data.wins ?? '—';
    document.getElementById('statLosses').textContent = data.losses ?? '—';
    document.getElementById('statKills').textContent  = data.kills ?? '—';
    document.getElementById('statDeaths').textContent = data.deaths ?? '—';
    document.getElementById('statShots').textContent  = data.shots_fired ?? '—';
});

// ── Socket.IO Leaderboard events ──
socket.on('leaderboard:query', (data) => {
    leaderboardList.innerHTML = '';
    if (!data.results || data.results.length === 0) {
        leaderboardList.innerHTML = '<li><span class="name">No players yet</span></li>';
        return;
    }
    data.results.forEach((entry, i) => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="rank">${i + 1}</span><span class="name">${entry.username}</span><span class="value">${entry.score}</span>`;
        leaderboardList.appendChild(li);
    });
});

// ── Socket.IO Account events ──
socket.on('account:changePassword', (data) => { showToast(data.message || 'Password updated'); });
socket.on('account:delete', (data) => {
    showToast(data.message || 'Account deleted');
    loggedInBar.classList.remove('visible');
    authOverlay.classList.remove('hidden');
    authToken = null;
    localStorage.removeItem('tank_token');
});

// ── Socket.IO Game stats update ──
socket.on('game:statsUpdate', (data) => {
    if (data.kills) showToast(`+${data.kills} Kill${data.kills > 1 ? 's' : ''}, Score: ${data.score}`);
});

// ── Resume session on connect ──
socket.on('connect', () => {
    myId = socket.id;
    if (authToken) {
        socket.emit('auth:resume', { token: authToken });
    }
});

socket.on('gameState', (state) => {
    players = state.players;
    bullets = state.bullets;
    weaponDrops = state.weaponDrops || [];
    walls = state.walls;
    explosions = state.explosions;

    let aiCount = 0;
    for (let id in players) { if (players[id].isAI) aiCount++; }
    const humanCount = Object.keys(players).length - aiCount;
    statusDiv.innerText = `👤 Humans: ${humanCount} | 🤖 AI: ${aiCount} | [WASD] Drive | [Space] Fire`;
});

socket.on('initMap', (serverWalls) => { walls = serverWalls; });
socket.on('playerJoined', (p) => console.log("Player joined:", p.id));
socket.on('playerLeft', (id) => { delete players[id]; });

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

// ── Resize canvas to fit window ──
function resizeCanvas() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = w;
    canvas.height = h;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function draw() {
    // Calculate camera: follow my player, fit map to screen
    const myPlayer = players[myId];
    let targetCX = MAP_W / 2;
    let targetCY = MAP_H / 2;
    if (myPlayer) {
        targetCX = myPlayer.x;
        targetCY = myPlayer.y;
    }
    cameraX += (targetCX - cameraX) * 0.1;
    cameraY += (targetCY - cameraY) * 0.1;

    const scaleX = canvas.width / MAP_W;
    const scaleY = canvas.height / MAP_H;
    cameraScale = Math.min(scaleX, scaleY);

    ctx.fillStyle = '#0a0a0c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.scale(cameraScale, cameraScale);
    ctx.translate(-cameraX * cameraScale + canvas.width / (2 * cameraScale) * (1 - cameraScale) * 0, 0);

    // Simpler transform: center camera on view
    const offsetX = canvas.width / cameraScale / 2 - cameraX;
    const offsetY = canvas.height / cameraScale / 2 - cameraY;
    ctx.setTransform(cameraScale, 0, 0, cameraScale, offsetX * cameraScale, offsetY * cameraScale);

    // Grid
    ctx.strokeStyle = '#1a1a1d';
    ctx.lineWidth = 1;
    const step = 40;
    for (let x = 0; x <= MAP_W; x += step) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, MAP_H); ctx.stroke();
    }
    for (let y = 0; y <= MAP_H; y += step) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(MAP_W, y); ctx.stroke();
    }

    // Walls
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

    // Bullets
    bullets.forEach(b => {
        ctx.shadowBlur = 12;
        ctx.shadowColor = b.color || '#ffff00';
        ctx.fillStyle = b.color || '#ffff00';
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.radius || 4, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.shadowBlur = 0;

    // Weapon drops
    weaponDrops.forEach(drop => {
        ctx.beginPath();
        ctx.arc(drop.x, drop.y, 8, 0, Math.PI * 2);
        ctx.fillStyle = drop.color;
        ctx.shadowBlur = 10;
        ctx.shadowColor = drop.color;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#fff';
        ctx.font = '9px monospace';
        ctx.textAlign = 'center';
        const nameMap = { shotgun: '散弹枪', sniper: '狙击枪', freeze: '冰冻枪', accel: '加速弹' };
        ctx.fillText(nameMap[drop.type] || drop.type, drop.x, drop.y - 14);
        ctx.textAlign = 'start';
    });

    // Explosions
    explosions.forEach(ex => {
        ctx.beginPath();
        ctx.arc(ex.x, ex.y, (1 - ex.life) * 30, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 165, 0, ${ex.life})`;
        ctx.lineWidth = 3;
        ctx.stroke();
    });

    // Players
    for (let id in players) {
        const p = players[id];
        if (p.hp <= 0) continue;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);

        const gradient = ctx.createRadialGradient(0, 0, 5, 0, 0, 15);
        gradient.addColorStop(0, p.color);
        gradient.addColorStop(1, '#000');
        ctx.fillStyle = gradient;
        ctx.fillRect(-15, -15, 30, 30);
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 1;
        ctx.strokeRect(-15, -15, 30, 30);

        ctx.fillStyle = '#fff';
        ctx.fillRect(0, -4, 20, 8);
        ctx.restore();

        // HP Bar
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(p.x - 15, p.y - 30, 30, 4);
        ctx.fillStyle = p.hp > 60 ? '#00ff00' : (p.hp > 30 ? '#ffaa00' : '#ff0000');
        ctx.fillRect(p.x - 15, p.y - 30, (p.hp / 100) * 30, 4);

        // Name / ID
        ctx.fillStyle = 'white';
        ctx.font = '10px monospace';
        const label = p.username || id.substring(0, 5);
        ctx.fillText(label, p.x - 15, p.y - 35);
    }

    // Muzzle flash
    const elapsed = Date.now() - lastShotTime;
    if (elapsed < 150 && myPlayer) {
        const alpha = 1 - elapsed / 150;
        const flashRadius = 8 + elapsed / 150 * 12;
        ctx.save();
        ctx.translate(myPlayer.x, myPlayer.y);
        ctx.rotate(myPlayer.angle);
        ctx.beginPath();
        ctx.arc(22, 0, flashRadius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 200, 50, ${alpha * 0.7})`;
        ctx.fill();
        ctx.restore();
    }

    ctx.restore();
}

function gameLoop() {
    draw();
    requestAnimationFrame(gameLoop);
}
gameLoop();
