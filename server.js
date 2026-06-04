const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Game Constants
const PLAYER_SPEED = 150;
const BULLET_SPEED = 450;
const FPS = 60;
const DT = 1 / FPS;

app.use(express.static(path.join(__dirname, 'public')));

// Game State
let players = {};
let aiPlayers = [];
let bullets = [];
let explosions = [];
const walls = [
    {x: 100, y: 100, w: 100, h: 20},
    {x: 400, y: 150, w: 20, h: 150},
    {x: 200, y: 300, w: 150, h: 20},
    {x: 500, y: 400, w: 20, h: 100},
    {x: 50, y: 450, w: 100, h: 20},
    {x: 600, y: 50, w: 30, h: 100}
];

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    const safe = findSafeSpawn();
    players[socket.id] = {
        id: socket.id,
        x: safe.x,
        y: safe.y,
        angle: 0,
        targetX: 0,
        targetY: 0,
        hp: 100,
        color: '#' + (Math.floor(Math.random() * 0xFFFFFF)).toString(16).padStart(6, '0'),
        isMoving: false
    };

    io.emit('playerJoined', players[socket.id]);
    socket.emit('initMap', walls);

    socket.on('inputUpdate', (input) => {
        const p = players[socket.id];
        if (!p) return;
        let dx = 0, dy = 0;
        if (input.up) dy -= 1;
        if (input.down) dy += 1;
        if (input.left) dx -= 1;
        if (input.right) dx += 1;

        if (dx !== 0 || dy !== 0) {
            p.angle = Math.atan2(dy, dx);
            p.isMoving = true;
            p.targetX = 0;
            p.targetY = 0;
        } else {
            p.isMoving = false;
        }
    });

    socket.on('moveTarget', (target) => {
        const p = players[socket.id];
        if (p) {
            p.targetX = target.x;
            p.targetY = target.y;
            p.isMoving = true;
        }
    });

    socket.on('fire', () => {
        const p = players[socket.id];
        if (p && p.hp > 0) {
            bullets.push({
                x: p.x + Math.cos(p.angle) * 20,
                y: p.y + Math.sin(p.angle) * 20,
                angle: p.angle,
                ownerId: socket.id
            });
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerLeft', socket.id);
    });
});

// AI tank spawn positions (away from walls)
const AI_SPAWNS = [
    { x: 720, y: 520 },
    { x: 720, y: 80 },
    { x: 50, y: 280 },
    { x: 350, y: 520 }
];

// Helper: check if a position collides with any wall
function checkWallCollision(x, y, radius) {
    for (let wall of walls) {
        if (x + radius > wall.x && x - radius < wall.x + wall.w &&
            y + radius > wall.y && y - radius < wall.y + wall.h) {
            return true;
        }
    }
    return false;
}

// Helper: find a valid (non-wall) spawn position
function findSafeSpawn() {
    for (let attempt = 0; attempt < 50; attempt++) {
        const x = Math.random() * 700 + 50;
        const y = Math.random() * 500 + 50;
        if (!checkWallCollision(x, y, 15)) {
            return { x, y };
        }
    }
    // Fallback: pick the first AI spawn if all attempts fail
    const spawn = AI_SPAWNS[0];
    return { x: spawn.x, y: spawn.y };
}

// Spawn AI tanks on server start
function spawnAITanks(count) {
    for (let i = 0; i < count; i++) {
        const safe = findSafeSpawn();
        const aiId = 'ai-' + i;
        players[aiId] = {
            id: aiId,
            x: safe.x,
            y: safe.y,
            angle: Math.random() * Math.PI * 2,
            targetX: 0,
            targetY: 0,
            hp: 100,
            color: '#ff3333',
            isMoving: false,
            isAI: true
        };
    }
    console.log(`Spawned ${count} AI tanks`);
}

spawnAITanks(3); // Start with 3 AI tanks

setInterval(() => {
    if (Object.keys(players).length === 0) return;

    for (let id in players) {
        const p = players[id];
        if (!p || p.hp <= 0) continue;

        if (p.isAI) {
            // AI: find nearest human player
            let target = null;
            let minDist = Infinity;
            for (let otherId in players) {
                const other = players[otherId];
                if (!other.isAI && other.hp > 0) {
                    const d = Math.sqrt((p.x - other.x) ** 2 + (p.y - other.y) ** 2);
                    if (d < minDist) { minDist = d; target = other; }
                }
            }

            if (target) {
                // Aim at target
                p.angle = Math.atan2(target.y - p.y, target.x - p.x);
                p.isMoving = true;

                // Move towards target
                const speedStep = PLAYER_SPEED * DT;
                const nextX = p.x + Math.cos(p.angle) * speedStep;
                const nextY = p.y + Math.sin(p.angle) * speedStep;

                if (!checkWallCollision(nextX, nextY, 15)) {
                    p.x = nextX;
                    p.y = nextY;
                } else {
                    p.isMoving = false;
                }

                // Randomly fire
                if (Math.random() < 0.02) {
                    bullets.push({
                        x: p.x + Math.cos(p.angle) * 20,
                        y: p.y + Math.sin(p.angle) * 20,
                        angle: p.angle,
                        ownerId: p.id
                    });
                }
            } else {
                p.isMoving = false;
            }
        } else if (p.isMoving && p.targetX !== 0) {
            // Human mouse-driven movement
            const distToTarget = Math.sqrt((p.targetX - p.x) ** 2 + (p.targetY - p.y) ** 2);
            if (distToTarget < 10) {
                p.isMoving = false;
                p.targetX = 0;
                p.targetY = 0;
            } else {
                p.angle = Math.atan2(p.targetY - p.y, p.targetX - p.x);

                // Move towards target
                const speedStep = PLAYER_SPEED * DT;
                const nextX = p.x + Math.cos(p.angle) * speedStep;
                const nextY = p.y + Math.sin(p.angle) * speedStep;

                if (!checkWallCollision(nextX, nextY, 15)) {
                    p.x = nextX;
                    p.y = nextY;
                }
            }
        } else if (p.isMoving) {
            // Human WASD keyboard movement — move in current angle direction
            const speedStep = PLAYER_SPEED * DT;
            const nextX = p.x + Math.cos(p.angle) * speedStep;
            const nextY = p.y + Math.sin(p.angle) * speedStep;

            if (!checkWallCollision(nextX, nextY, 15)) {
                p.x = nextX;
                p.y = nextY;
            }
        }
    }

    // Bullet logic
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += Math.cos(b.angle) * BULLET_SPEED * DT;
        b.y += Math.sin(b.angle) * BULLET_SPEED * DT;

        // Out of bounds
        if (b.x < 0 || b.x > 800 || b.y < 0 || b.y > 600) {
            bullets.splice(i, 1);
            continue;
        }

        // Wall collision
        let wallHit = false;
        for (let wall of walls) {
            if (b.x > wall.x && b.x < wall.x + wall.w && b.y > wall.y && b.y < wall.y + wall.h) {
                wallHit = true;
                break;
            }
        }
        if (wallHit) { bullets.splice(i, 1); continue; }

        // Player collision
        for (let pid in players) {
            const p = players[pid];
            if (!p || p.hp <= 0 || pid === b.ownerId) continue;
            const dist = Math.sqrt((b.x - p.x) ** 2 + (b.y - p.y) ** 2);
            if (dist < 20) {
                p.hp -= 35;
                explosions.push({ x: b.x, y: b.y, life: 1.0 });
                bullets.splice(i, 1);
                if (p.hp <= 0) {
                    p.hp = 100;
                    const safe = findSafeSpawn();
                    p.x = safe.x;
                    p.y = safe.y;
                }
                break;
            }
        }
    }

    // Explosion logic
    for (let i = explosions.length - 1; i >= 0; i--) {
        explosions[i].life -= DT * 2;
        if (explosions[i].life <= 0) explosions.splice(i, 1);
    }

    io.emit('gameState', { players, bullets, walls, explosions });
}, 16);

server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
