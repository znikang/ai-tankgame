const socket = io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const statusDiv = document.getElementById('status');

// Map dimensions (server-side)
const MAP_W = 1600;
const MAP_H = 1200;
const CAPTURE_TIME = 5000;

let players = {};
let bullets = [];
let weaponDrops = [];
let walls = [];
let explosions = [];
let particles = [];
let floatingTexts = [];
let DT = 1 / 60;
let state = {
    players: {},
    bullets: [],
    walls: [],
    explosions: [],
    weaponDrops: [],
    auth: {},
    capturePoints: [],
    theme: null,
};
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
const weaponHUD         = document.getElementById('weaponHUD');
const weaponIcon        = document.getElementById('weaponIcon');
const weaponName        = document.getElementById('weaponName');
const weaponPickupToast = document.getElementById('weaponPickupToast');

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

socket.on('gameState', (s) => {
    state = s;
    players = state.players;
    bullets = state.bullets;
    weaponDrops = state.weaponDrops || [];
    walls = state.walls;
    explosions = state.explosions;

    // Update weapon UI for my player
    if (myId && state.players[myId]) {
        updateWeaponUI(state.players[myId].weapon || 'basic');
    }

    // Generate particles for new explosions
    const newExplosions = explosions.filter(ex => ex.life > 0.5);
    for (const ex of newExplosions) {
        for (let i = 0; i < 15; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 50 + Math.random() * 150;
            particles.push({
                x: ex.x, y: ex.y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 1.0,
                color: '#ff8800',
                size: 3 + Math.random() * 3,
            });
        }
    }

    // Play explosion sound for new explosions
    if (explosions.length > 0) {
        playSound('explosion');
    }

    // Spawn floating text for player deaths
    for (let id in state.players) {
        const newP = state.players[id];
        const oldP = players[id];
        if (oldP && oldP.hp > 0 && newP.hp <= 0) {
            floatingTexts.push({
                x: newP.x, y: newP.y,
                text: '💀',
                life: 1.0,
                color: '#FF4444',
            });
        }
    }

    let aiCount = 0;
    for (let id in state.players) { if (state.players[id].isAI) aiCount++; }
    const humanCount = Object.keys(state.players).length - aiCount;
    statusDiv.innerText = `👤 Humans: ${humanCount} | 🤖 AI: ${aiCount} | [WASD] Drive | [Space] Fire`;
});

socket.on('initMap', (serverWalls) => { walls = serverWalls; });
socket.on('playerJoined', (p) => console.log("Player joined:", p.id));
socket.on('playerLeft', (id) => { delete players[id]; });

const WEAPON_NAMES = { basic: '基础武器', shotgun: '散弹枪', sniper: '狙击枪', freeze: '冰冻枪', accel: '加速弹' };
const WEAPON_COLORS = { basic: '#FFFF00', shotgun: '#FF8800', sniper: '#FF0000', freeze: '#00FFFF', accel: '#00FF00' };

function updateWeaponUI(weaponType) {
    weaponName.textContent = WEAPON_NAMES[weaponType] || weaponType;
    weaponIcon.style.backgroundColor = WEAPON_COLORS[weaponType] || '#fff';
}

socket.on('weaponPickup', (data) => {
    updateWeaponUI(data.weapon);
    weaponPickupToast.textContent = '🎯 获得：' + data.name;
    playSound('pickup');
    weaponPickupToast.classList.add('visible');
    clearTimeout(weaponPickupToast._timer);
    weaponPickupToast._timer = setTimeout(() => {
        weaponPickupToast.classList.remove('visible');
    }, 2000);
});

// Earthquake visual effect
socket.on('earthquake', () => {
    const flash = document.getElementById('earthquakeFlash');
    flash.classList.remove('active');
    void flash.offsetWidth; // force reflow
    flash.classList.add('active');
    setTimeout(() => flash.classList.remove('active'), 300);
    playSound('earthquake');
});

// Victory screen
socket.on('game:victory', (data) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999;';
    overlay.innerHTML = `
        <div style="background:#1a1a2e;border:2px solid gold;border-radius:16px;padding:40px;text-align:center;font-size:24px;color:#fff;">
            <div style="font-size:48px;margin-bottom:16px;">🏆</div>
            <div style="font-size:32px;font-weight:bold;color:gold;margin-bottom:8px;">勝利！</div>
            <div style="margin-bottom:8px;">${data.username} 佔領了所有據點！</div>
            <div style="color:#aaa;font-size:16px;">${data.message}</div>
            <div style="color:#ffcc00;font-size:20px;margin-top:12px;">+${Math.abs(data.score)} 分</div>
        </div>
    `;
    document.body.appendChild(overlay);
    setTimeout(() => overlay.remove(), 4000);
});

// Map reset — clear the canvas and prepare for new round
socket.on('map:reset', (data) => {
    walls = data.walls || [];
    state.capturePoints = data.capturePoints || [];
    bullets = [];
    explosions = [];
    weaponDrops = [];
    particles = [];
    floatingTexts = [];
    
    // Apply new map theme
    if (data.theme) {
        document.body.style.background = data.theme.bg;
        console.log(`🗺️ 切換地圖：${data.theme.name}`);
    }
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
        playSound('fire-' + (players[myId]?.weapon || 'basic'));
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

    let mapBg = '#0a0a0c';
    let mapGrid = '#1a1a1d';
    if (state.theme) {
        mapBg = state.theme.bg || '#0a0a0c';
        mapGrid = state.theme.gridColor || '#1a1a1d';
    }

    ctx.fillStyle = mapBg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.scale(cameraScale, cameraScale);
    ctx.translate(-cameraX * cameraScale + canvas.width / (2 * cameraScale) * (1 - cameraScale) * 0, 0);

    // Simpler transform: center camera on view
    const offsetX = canvas.width / cameraScale / 2 - cameraX;
    const offsetY = canvas.height / cameraScale / 2 - cameraY;
    ctx.setTransform(cameraScale, 0, 0, cameraScale, offsetX * cameraScale, offsetY * cameraScale);

    // Grid
    ctx.strokeStyle = mapGrid;
    ctx.lineWidth = 1;
    const step = 40;
    for (let x = 0; x <= MAP_W; x += step) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, MAP_H); ctx.stroke();
    }
    for (let y = 0; y <= MAP_H; y += step) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(MAP_W, y); ctx.stroke();
    }

    drawTerritoryOverlay(ctx);

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

    // Particles
    particles.forEach(p => {
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.life;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    });
    ctx.globalAlpha = 1;

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
        if (drop.type === 'health') {
            ctx.strokeStyle = '#00FF00';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(drop.x - 4, drop.y); ctx.lineTo(drop.x + 4, drop.y);
            ctx.moveTo(drop.x, drop.y - 4); ctx.lineTo(drop.x, drop.y + 4);
            ctx.stroke();
            ctx.fillStyle = '#fff';
            ctx.font = '9px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('+30', drop.x, drop.y + 16);
            ctx.textAlign = 'start';
        } else {
            const nameMap = { shotgun: '散弹枪', sniper: '狙击枪', freeze: '冰冻枪', accel: '加速弹' };
            ctx.fillStyle = '#fff';
            ctx.font = '9px monospace';
            ctx.textAlign = 'center';
                ctx.fillText(nameMap[drop.type] || drop.type, drop.x, drop.y - 14);
            ctx.textAlign = 'start';
        }
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

        // Freeze visual effect
        if (p.frozenUntil && Date.now() < p.frozenUntil) {
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.angle);
            ctx.beginPath();
            ctx.arc(0, 0, 18, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(0, 255, 255, 0.25)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(0, 255, 255, 0.6)';
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.restore();
        }

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

    // Floating text
    floatingTexts.forEach(ft => {
        ctx.globalAlpha = ft.life;
        ctx.fillStyle = ft.color;
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(ft.text, ft.x, ft.y - 40 + (1 - ft.life) * -40);
        ctx.textAlign = 'start';
    });
    ctx.globalAlpha = 1;

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

    drawCapturePoints(ctx);

    ctx.restore();
}

function drawTerritoryOverlay(ctx) {
    if (!state.capturePoints) return;

    for (const cp of state.capturePoints) {
        if (cp.ownerId === null) continue;

        const owner = state.players[cp.ownerId];
        if (!owner) continue;

        ctx.save();
        ctx.globalAlpha = 0.15;
        ctx.fillStyle = owner.color;
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, cp.radius * 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}

function drawCapturePoints(ctx) {
    if (!state.capturePoints) return;

    for (const cp of state.capturePoints) {
        const isOwned = cp.ownerId !== null;
        const isCapturing = cp.capturingPlayerId !== null && cp.captureStartTime !== null;

        // Draw territory overlay (behind everything)
        if (isOwned) {
            const owner = state.players[cp.ownerId];
            if (owner) {
                ctx.save();
                ctx.globalAlpha = 0.15;
                ctx.fillStyle = owner.color;
                ctx.beginPath();
                ctx.arc(cp.x, cp.y, cp.radius * 3, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }
        }

        // Draw CP base circle
        ctx.save();
        if (isOwned) {
            const owner = state.players[cp.ownerId];
            ctx.strokeStyle = owner ? owner.color : '#888';
            ctx.lineWidth = 3;
            ctx.setLineDash([]);
        } else if (isCapturing) {
            const capturer = state.players[cp.capturingPlayerId];
            ctx.strokeStyle = capturer ? capturer.color : '#888';
            ctx.lineWidth = 2;
            ctx.setLineDash([]);
        } else {
            ctx.strokeStyle = '#555';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([5, 5]);
        }

        ctx.beginPath();
        ctx.arc(cp.x, cp.y, cp.radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        // Draw capture progress ring (only when capturing)
        if (isCapturing) {
            const now = Date.now();
            const elapsed = now - cp.captureStartTime;
            const progress = Math.min(elapsed / CAPTURE_TIME, 1);

            const capturer = state.players[cp.capturingPlayerId];
            const color = capturer ? capturer.color : '#888';

            ctx.save();
            ctx.beginPath();
            // Background ring (gray)
            ctx.arc(cp.x, cp.y, cp.radius + 8, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(100,100,100,0.3)';
            ctx.lineWidth = 6;
            ctx.stroke();

            // Progress ring (capturer color, clockwise from 12 o'clock)
            ctx.beginPath();
            ctx.arc(cp.x, cp.y, cp.radius + 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
            ctx.strokeStyle = color;
            ctx.lineWidth = 6;
            ctx.lineCap = 'round';
            ctx.stroke();
            ctx.restore();
        }

        // Draw center icon
        ctx.save();
        ctx.fillStyle = '#fff';
        ctx.font = '16px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        if (isOwned) {
            ctx.fillText('🏁', cp.x, cp.y);
        } else if (isCapturing) {
            ctx.fillText('⏳', cp.x, cp.y);
        } else {
            ctx.fillText('+', cp.x, cp.y);
        }
        ctx.restore();
    }
}

function updateParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx * DT;
        p.y += p.vy * DT;
        p.life -= DT * 2;
        if (p.life <= 0) particles.splice(i, 1);
    }
}

function gameLoop() {
    updateParticles();

    // Update floating texts
    for (let i = floatingTexts.length - 1; i >= 0; i--) {
        const ft = floatingTexts[i];
        ft.life -= DT;
        if (ft.life <= 0) floatingTexts.splice(i, 1);
    }

    draw();
    requestAnimationFrame(gameLoop);
}
gameLoop();

// ============================================================
// Web Audio Sound Effects
// ============================================================

let audioCtx = null;

function initAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
}

function playSound(name) {
    if (!audioCtx) initAudio();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;

    switch (name) {
        case 'fire-basic': {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            const filter = audioCtx.createBiquadFilter();
            filter.type = 'bandpass'; filter.frequency.value = 800; filter.Q.value = 2;
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(200, now);
            osc.frequency.exponentialRampToValueAtTime(100, now + 0.05);
            gain.gain.setValueAtTime(0.3, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
            osc.connect(filter); filter.connect(gain); gain.connect(audioCtx.destination);
            osc.start(now); osc.stop(now + 0.08);
            break;
        }
        case 'fire-shotgun': {
            const bufferSize = audioCtx.sampleRate * 0.06;
            const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * 0.8;
            const noise = audioCtx.createBufferSource();
            noise.buffer = buffer;
            const gain = audioCtx.createGain();
            const filter = audioCtx.createBiquadFilter();
            filter.type = 'bandpass'; filter.frequency.value = 1200; filter.Q.value = 0.5;
            gain.gain.setValueAtTime(0.4, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
            noise.connect(filter); filter.connect(gain); gain.connect(audioCtx.destination);
            noise.start(now); noise.stop(now + 0.12);
            break;
        }
        case 'fire-sniper': {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(1000, now);
            osc.frequency.exponentialRampToValueAtTime(4000, now + 0.15);
            gain.gain.setValueAtTime(0.3, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
            osc.connect(gain); gain.connect(audioCtx.destination);
            osc.start(now); osc.stop(now + 0.25);
            break;
        }
        case 'fire-freeze': {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            const lfo = audioCtx.createOscillator();
            const lfoGain = audioCtx.createGain();
            osc.type = 'sine'; osc.frequency.value = 200;
            lfo.frequency.value = 8; lfoGain.gain.value = 30;
            lfo.connect(lfoGain); lfoGain.connect(osc.frequency);
            gain.gain.setValueAtTime(0.25, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
            osc.connect(gain); gain.connect(audioCtx.destination);
            osc.start(now); lfo.start(now);
            osc.stop(now + 0.12); lfo.stop(now + 0.12);
            break;
        }
        case 'fire-accel': {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(600, now);
            osc.frequency.exponentialRampToValueAtTime(2000, now + 0.06);
            gain.gain.setValueAtTime(0.25, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
            osc.connect(gain); gain.connect(audioCtx.destination);
            osc.start(now); osc.stop(now + 0.08);
            break;
        }
        case 'explosion': {
            const bufferSize = audioCtx.sampleRate * 0.3;
            const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * Math.max(0, 1 - i / bufferSize);
            const noise = audioCtx.createBufferSource();
            noise.buffer = buffer;
            const gain = audioCtx.createGain();
            const filter = audioCtx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(500, now);
            filter.frequency.exponentialRampToValueAtTime(20, now + 0.3);
            gain.gain.setValueAtTime(0.5, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
            noise.connect(filter); filter.connect(gain); gain.connect(audioCtx.destination);
            noise.start(now); noise.stop(now + 0.3);
            break;
        }
        case 'pickup': {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(400, now);
            osc.frequency.linearRampToValueAtTime(800, now + 0.12);
            gain.gain.setValueAtTime(0.3, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
            osc.connect(gain); gain.connect(audioCtx.destination);
            osc.start(now); osc.stop(now + 0.15);
            break;
        }
        case 'earthquake': {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sawtooth'; osc.frequency.value = 50;
            gain.gain.setValueAtTime(0.3, now);
            gain.gain.setValueAtTime(0.3, now + 0.3);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
            osc.connect(gain); gain.connect(audioCtx.destination);
            osc.start(now); osc.stop(now + 0.5);
            break;
        }
    }
}

// Initialize audio on first user interaction
document.addEventListener('keydown', function initAudioOnce() {
    initAudio();
    document.removeEventListener('keydown', initAudioOnce);
}, { once: true });
document.addEventListener('click', function initAudioOnce() {
    initAudio();
    document.removeEventListener('click', initAudioOnce);
}, { once: true });
