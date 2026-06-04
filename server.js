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
const MAP_W = 800;
const MAP_H = 600;
const RADIUS = 15;
const GRID = 40;  // grid cell size

app.use(express.static(path.join(__dirname, 'public')));

// Game State
let players = {};
let bullets = [];
let explosions = [];
let walls = [];

// AI tank spawn positions
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

// Helper: clamp position within map bounds
function clampToMap(x, y) {
    return {
        x: Math.max(RADIUS, Math.min(MAP_W - RADIUS, x)),
        y: Math.max(RADIUS, Math.min(MAP_H - RADIUS, y))
    };
}

// Helper: find a valid (non-wall) spawn position within map bounds
function findSafeSpawn() {
    for (let attempt = 0; attempt < 100; attempt++) {
        const x = Math.random() * (MAP_W - 2 * RADIUS) + RADIUS;
        const y = Math.random() * (MAP_H - 2 * RADIUS) + RADIUS;
        if (!checkWallCollision(x, y, RADIUS)) {
            return { x, y };
        }
    }
    const spawn = AI_SPAWNS[0];
    return clampToMap(spawn.x, spawn.y);
}

// Generate random map with grid-based walls
function generateMap() {
    walls = [];
    const cols = Math.floor(MAP_W / GRID);
    const rows = Math.floor(MAP_H / GRID);

    // Reserve border cells (1 cell thick around edges)
    const isReserved = (c, r) => {
        return c === 0 || r === 0 || c === cols - 1 || r === rows - 1;
    };

    // Reserve spawn area cells (around center and corners)
    const isSpawnReserved = (c, r) => {
        const cx = Math.floor(cols / 2), cy = Math.floor(rows / 2);
        const distToCenter = Math.abs(c - cx) + Math.abs(r - cy);
        if (distToCenter < 3) return true;
        // Reserve corners
        if (c < 3 && r < 3) return true;
        if (c > cols - 4 && r < 3) return true;
        if (c < 3 && r > rows - 4) return true;
        if (c > cols - 4 && r > rows - 4) return true;
        return false;
    };

    // Place destructible walls — high density (~35% of inner cells)
    for (let r = 1; r < rows - 1; r++) {
        for (let c = 1; c < cols - 1; c++) {
            if (isReserved(c, r) || isSpawnReserved(c, r)) continue;
            if (Math.random() < 0.35) {
                walls.push({
                    x: c * GRID,
                    y: r * GRID,
                    w: GRID,
                    h: GRID,
                    destructible: true,
                    hp: 3
                });
            }
        }
    }

    // Place solid walls — medium density (~15% of inner cells), longer shapes
    for (let r = 1; r < rows - 1; r++) {
        for (let c = 1; c < cols - 1; c++) {
            if (isReserved(c, r) || isSpawnReserved(c, r)) continue;
            // Don't place solid if there's already a wall here
            const existing = walls.find(w => w.x === c * GRID && w.y === r * GRID);
            if (existing) continue;
            if (Math.random() < 0.12) {
                walls.push({
                    x: c * GRID,
                    y: r * GRID,
                    w: GRID,
                    h: GRID,
                    destructible: false,
                    hp: 999
                });
            }
        }
    }

    // Add some elongated solid walls (L-shapes, corridors)
    for (let attempt = 0; attempt < 15; attempt++) {
        const cx = 2 + Math.floor(Math.random() * (cols - 5));
        const cy = 2 + Math.floor(Math.random() * (rows - 5));
        const horizontal = Math.random() > 0.5;
        const length = 2 + Math.floor(Math.random() * 3);

        let placed = 0;
        for (let i = 0; i < length; i++) {
            const cc = horizontal ? cx + i : cx;
            const rr = horizontal ? cy : cy + i;
            if (cc < 1 || cc >= cols - 1 || rr < 1 || rr >= rows - 1) continue;
            if (isSpawnReserved(cc, rr)) continue;
            const existing = walls.find(w => w.x === cc * GRID && w.y === rr * GRID);
            if (existing) continue;
            walls.push({
                x: cc * GRID,
                y: rr * GRID,
                w: GRID,
                h: GRID,
                destructible: false,
                hp: 999
            });
            placed++;
        }
    }

    console.log(`Map generated: ${walls.length} walls (${walls.filter(w => w.destructible).length} destructible, ${walls.filter(w => !w.destructible).length} solid)`);
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
            isAI: true,
            strafeDir: 1
        };
    }
    console.log(`Spawned ${count} AI tanks`);
}

// Initialize map and tanks
generateMap();
spawnAITanks(3);

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

// Helper: move a tank in a direction with wall + map clamping
function moveTank(p, angle, speedMult) {
    const speedStep = PLAYER_SPEED * DT * (speedMult || 1);
    const nextX = p.x + Math.cos(angle) * speedStep;
    const nextY = p.y + Math.sin(angle) * speedStep;

    if (!checkWallCollision(nextX, nextY, RADIUS)) {
        const clamped = clampToMap(nextX, nextY);
        p.x = clamped.x;
        p.y = clamped.y;
    } else {
        p.isMoving = false;
    }
}

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
                const distToTarget = Math.sqrt((target.x - p.x) ** 2 + (target.y - p.y) ** 2);

                if (distToTarget > 300) {
                    // Chase
                    p.angle = Math.atan2(target.y - p.y, target.x - p.x);
                    p.isMoving = true;
                    moveTank(p, p.angle, 1);
                } else if (distToTarget > 120) {
                    // Strafe
                    const angleToTarget = Math.atan2(target.y - p.y, target.x - p.x);
                    p.angle = angleToTarget;
                    const strafeAngle = angleToTarget + (p.strafeDir || 1) * Math.PI / 2.5;
                    p.isMoving = true;
                    moveTank(p, strafeAngle, 0.7);
                } else {
                    // Back away
                    const angleToTarget = Math.atan2(target.y - p.y, target.x - p.x);
                    p.angle = angleToTarget;
                    const backAngle = angleToTarget + Math.PI;
                    p.isMoving = true;
                    moveTank(p, backAngle, 1);
                }

                // Fire when aimed at target
                const angleToTarget = Math.atan2(target.y - p.y, target.x - p.x);
                let angleDiff = angleToTarget - p.angle;
                while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
                while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
                if (Math.abs(angleDiff) < 0.3 && Math.random() < 0.06) {
                    bullets.push({
                        x: p.x + Math.cos(p.angle) * 20,
                        y: p.y + Math.sin(p.angle) * 20,
                        angle: p.angle,
                        ownerId: p.id
                    });
                }

                // Randomly change strafe direction
                if (Math.random() < 0.01) {
                    p.strafeDir = p.strafeDir === 1 ? -1 : 1;
                }
            } else {
                p.isMoving = false;
            }
        } else if (p.isMoving && p.targetX !== 0) {
            // Mouse-driven movement
            const distToTarget = Math.sqrt((p.targetX - p.x) ** 2 + (p.targetY - p.y) ** 2);
            if (distToTarget < 10) {
                p.isMoving = false;
                p.targetX = 0;
                p.targetY = 0;
            } else {
                p.angle = Math.atan2(p.targetY - p.y, p.targetX - p.x);
                moveTank(p, p.angle, 1);
            }
        } else if (p.isMoving) {
            // WASD keyboard movement
            moveTank(p, p.angle, 1);
        }
    }

    // Bullet logic
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += Math.cos(b.angle) * BULLET_SPEED * DT;
        b.y += Math.sin(b.angle) * BULLET_SPEED * DT;

        // Out of bounds
        if (b.x < 0 || b.x > MAP_W || b.y < 0 || b.y > MAP_H) {
            bullets.splice(i, 1);
            continue;
        }

        // Wall collision
        let wallHit = false;
        for (let wi = walls.length - 1; wi >= 0; wi--) {
            const wall = walls[wi];
            if (b.x > wall.x && b.x < wall.x + wall.w && b.y > wall.y && b.y < wall.y + wall.h) {
                wallHit = true;
                if (wall.destructible) {
                    wall.hp -= 1;
                    if (wall.hp <= 0) {
                        walls.splice(wi, 1);
                        explosions.push({ x: b.x, y: b.y, life: 1.0 });
                    }
                }
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
