const socket = io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const statusDiv = document.getElementById('status');

let players = {};
let bullets = [];
let walls = [];
let explosions = [];
let myId = null;

socket.on('connect', () => {
    myId = socket.id;
    statusDiv.innerText = "Connected! [Arrows] to Drive | [Space] to Fire";
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
    if (e.key === 'ArrowUp')    inputState.up = true;
    if (e.key === 'ArrowDown')  inputState.down = true;
    if (e.key === 'ArrowLeft')  inputState.left = true;
    if (e.key === 'ArrowRight') inputState.right = true;
    if (e.code === 'Space') socket.emit('fire');
    socket.emit('inputUpdate', inputState);
});

document.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowUp')    inputState.up = false;
    if (e.key === 'ArrowDown')  inputState.down = false;
    if (e.key === 'ArrowLeft')  inputState.left = false;
    if (e.key === 'ArrowRight') inputState.right = false;
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
    ctx.fillStyle = '#222';
    walls.forEach(w => {
        ctx.fillRect(w.x, w.y, w.w, w.h);
        ctx.strokeStyle = '#444';
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
        ctx.fillStyle = '#00ff00';
        ctx.fillRect(p.x - 15, p.y - 30, (p.hp / 100) * 30, 4);

        // ID
        ctx.fillStyle = 'white';
        ctx.font = '10px monospace';
        ctx.fillText(id.substring(0, 5), p.x - 15, p.y - 35);
    }
}

function gameLoop() {
    draw();
    requestAnimationFrame(gameLoop);
}
gameLoop();