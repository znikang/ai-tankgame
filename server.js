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

    players[socket.id] = {
        id: socket.id,
        x: Math.random() * 700 + 50,
        y: Math.random() * 500 + 50,
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
            p.targetX = 0; // Disable mouse tracking when using keys
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

setInterval(() => {
    if (Object.keys(players).length === 0) return;

    for (let id in players) {
        const p = players[id];
        if (!p || p.hp <= 0) continue;

        if (p.isMoving) {
            // If mouse-driven, update angle towards target
            if (p.targetX !== 0) {
                const distToTarget = Math.sqrt((p.targetX - p.x)**2 + (p.targetY - p.y)**2);
                if (distToTarget < 10) {
                    p.isMoving = false;
                    p.targetX = 0;
                } else {
                    p.angle = Math.atan2(p.targetY - p.y, p.targetX - p.x);
                }
            }

            // Calculate next step
            const speedStep = PLAYER_SPEED * DT;
            const nextX = p.x + Math.cos(p.angle) * speedStep;
            const nextY = p.y + Math.sin(p.angle) * speedStep;

            // Collision Check (Boundary & Walls)
            let collision = false;
            const margin = 20;
            if (nextX < margin || nextX > 780 || nextY < margin || nextY > 580) {
                collision = true;
            } else {
                for (let wall of walls) {
                    if (nextX + 15 > wall.x && nextX - 15 < wall.x + wall.w &&
                        nextY + 15 > wall.y && nextY - 15 < wall.y + wall.h) {
                        collision = true;
                        break;
                    }
                }
            }

            if (!collision) {
                p.x = nextX;
                p.y = nextY;
            } else {
                p.isMoving = false;
            }
        }
    }

    // Bullet logic
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += Math.cos(b.angle) * BULLET_SPEED * DT;
        b.y += Math.sin(b.angle) * BULLET_SPEED * DT;

        if (b.x < 0 || b.x > 800 || b.y < 0 || b.y > 600) {
            bullets.splice(i, 1);
            continue;
        }

        let wallHit = false;
        for (let wall of walls) {
            if (b.x > wall.x && b.x < wall.x + wall.w && b.y > wall.y && b.y < wall.y + wall.h) {
                wallHit = true; break;
            }
        }
        if (wallHit) { bullets.splice(i, 1); continue; }

        for (let id in players) {
            const p = players[id];
            if (!p || p.hp <= 0 || id === b.ownerId) continue;
            const dist = Math.sqrt((b.x - p.x)**2 + (b.y - p.y)**2);
            if (dist < 20) {
                p.hp -= 35;
                explosions.push({ x: b.x, y: b.y, life: 1.0 });
                bullets.splice(i, 1);
                if (p.hp <= 0) { p.hp = 100; p.x = Math.random()*700+50; p.y = Math.random()*500+50; }
                break;
            }
        }
    }

    for (let i = explosions.length - 1; i >= 0; i--) {
        explosions[i].life -= DT * 2;
        if (explosions[i].life <= 0) explosions.splice(i, 1);
    }

    io.emit('gameState', { players, bullets, walls, explosions });
}, 16);

server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));