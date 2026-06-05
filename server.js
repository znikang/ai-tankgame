const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const Redis = require('ioredis');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// ============================================================
// Redis Setup
// ============================================================

let redis = null;
let redisAvailable = false;

try {
    redis = new Redis({
        host: 'localhost',
        port: 6379,
        maxRetriesPerRequest: 3,
        lazyConnect: true,
    });
    redis.on('error', (err) => {
        console.error(`Redis error: ${err.message}`);
        redisAvailable = false;
    });
    redis.connect().then(() => {
        redisAvailable = true;
        console.log('Redis connected');
    }).catch(() => {
        redisAvailable = false;
    });
} catch (err) {
    console.error(`Failed to create Redis client: ${err.message}`);
    redisAvailable = false;
}

// Graceful shutdown: close Redis on process exit
process.on('SIGINT', () => {
    if (redis) redis.quit();
    process.exit(0);
});
process.on('SIGTERM', () => {
    if (redis) redis.quit();
    process.exit(0);
});

// ============================================================
// Rate Limiting (in-memory)
// ============================================================

const authRateLimits = new Map();

function checkAuthRateLimit(socketId) {
    const now = Date.now();
    const entry = authRateLimits.get(socketId);
    if (!entry) return true;
    if (now > entry.resetTime) {
        authRateLimits.set(socketId, { count: 1, resetTime: now + 30000 });
        return true;
    }
    if (entry.count >= 5) {
        return false;
    }
    entry.count++;
    return true;
}

// ============================================================
// Game Constants
// ============================================================

const PLAYER_SPEED = 150;
const BULLET_SPEED = 450;
const FPS = 60;
const DT = 1 / FPS;
const MAP_W = 1600;  // doubled from 800
const MAP_H = 1200;  // doubled from 600
const RADIUS = 15;
const GRID = 40;

// ============================================================
// Weapon System
// ============================================================

const WEAPON_TYPES = ['basic', 'shotgun', 'sniper', 'freeze', 'accel'];

const WEAPON_CONFIG = {
  basic:    { damage: 35, fireRate: 400, bulletSpeed: 450, color: '#FFFF00', radius: 4 },
  shotgun:  { damage: 20, fireRate: 800, bulletSpeed: 400, color: '#FF8800', radius: 5, count: 5, spread: [-30, 30] },
  sniper:   { damage: 50, fireRate: 800, bulletSpeed: 500, color: '#FF0000', radius: 6 },
  freeze:   { damage: 10, fireRate: 400, bulletSpeed: 450, color: '#00FFFF', radius: 4, freeze: true },
  accel:    { damage: 15, fireRate: 400, bulletSpeed: 900, color: '#00FF00', radius: 3, accelerated: true },
};

const SPECIAL_WEAPONS = ['shotgun', 'sniper', 'freeze', 'accel'];

const WEAPON_NAMES = {
  basic: '基础武器',
  shotgun: '散弹枪',
  sniper: '狙击枪',
  freeze: '冰冻枪',
  accel: '加速弹',
};

let weaponDrops = [];

app.use(express.static(path.join(__dirname, 'public')));

// Game State
let players = {};
let bullets = [];
let explosions = [];
let walls = [];

// AI tank spawn positions
const AI_SPAWNS = [
    { x: 1400, y: 1050 },
    { x: 1400, y: 150 },
    { x: 100, y: 600 },
    { x: 700, y: 1050 },
    { x: 700, y: 150 },
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

    const isReserved = (c, r) => {
        return c === 0 || r === 0 || c === cols - 1 || r === rows - 1;
    };

    const isSpawnReserved = (c, r) => {
        const cx = Math.floor(cols / 2), cy = Math.floor(rows / 2);
        const distToCenter = Math.abs(c - cx) + Math.abs(r - cy);
        if (distToCenter < 4) return true;
        if (c < 4 && r < 4) return true;
        if (c > cols - 5 && r < 4) return true;
        if (c < 4 && r > rows - 5) return true;
        if (c > cols - 5 && r > rows - 5) return true;
        // Reserve other AI spawn areas
        for (const sp of AI_SPAWNS) {
            const sc = Math.floor(sp.x / GRID);
            const sr = Math.floor(sp.y / GRID);
            if (Math.abs(c - sc) < 3 && Math.abs(r - sr) < 3) return true;
        }
        return false;
    };

    // Destructible walls
    for (let r = 1; r < rows - 1; r++) {
        for (let c = 1; c < cols - 1; c++) {
            if (isReserved(c, r) || isSpawnReserved(c, r)) continue;
            if (Math.random() < 0.25) {
                walls.push({
                    x: c * GRID, y: r * GRID, w: GRID, h: GRID,
                    destructible: true, hp: 3
                });
            }
        }
    }

    // Solid walls
    for (let r = 1; r < rows - 1; r++) {
        for (let c = 1; c < cols - 1; c++) {
            if (isReserved(c, r) || isSpawnReserved(c, r)) continue;
            const existing = walls.find(w => w.x === c * GRID && w.y === r * GRID);
            if (existing) continue;
            if (Math.random() < 0.08) {
                walls.push({
                    x: c * GRID, y: r * GRID, w: GRID, h: GRID,
                    destructible: false, hp: 999
                });
            }
        }
    }

    // Elongated solid walls
    for (let attempt = 0; attempt < 30; attempt++) {
        const cx = 2 + Math.floor(Math.random() * (cols - 6));
        const cy = 2 + Math.floor(Math.random() * (rows - 6));
        const horizontal = Math.random() > 0.5;
        const length = 2 + Math.floor(Math.random() * 4);

        for (let i = 0; i < length; i++) {
            const cc = horizontal ? cx + i : cx;
            const rr = horizontal ? cy : cy + i;
            if (cc < 1 || cc >= cols - 1 || rr < 1 || rr >= rows - 1) continue;
            if (isSpawnReserved(cc, rr)) continue;
            const existing = walls.find(w => w.x === cc * GRID && w.y === rr * GRID);
            if (existing) continue;
            walls.push({
                x: cc * GRID, y: rr * GRID, w: GRID, h: GRID,
                destructible: false, hp: 999
            });
        }
    }

    console.log(`Map generated: ${walls.length} walls (${walls.filter(w => w.destructible).length} destructible, ${walls.filter(w => !w.destructible).length} solid)`);
}

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

generateMap();
spawnAITanks(3);

// ============================================================
// Redis Account System Helpers
// ============================================================

const BCRYPT_SALT_ROUNDS = 12;
const SESSION_TTL = 604800;
const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

async function getPlayerStats(username) {
    if (!redisAvailable || !username) {
        return { score: 0, wins: 0, losses: 0, kills: 0, deaths: 0, shots_fired: 0 };
    }
    try {
        const stats = await redis.hgetall(`user:stats:${username}`);
        if (!stats || Object.keys(stats).length === 0) {
            return { score: 0, wins: 0, losses: 0, kills: 0, deaths: 0, shots_fired: 0 };
        }
        return {
            score: parseInt(stats.score) || 0,
            wins: parseInt(stats.wins) || 0,
            losses: parseInt(stats.losses) || 0,
            kills: parseInt(stats.kills) || 0,
            deaths: parseInt(stats.deaths) || 0,
            shots_fired: parseInt(stats.shots_fired) || 0,
        };
    } catch (err) {
        console.error(`Error getting stats for ${username}: ${err.message}`);
        return { score: 0, wins: 0, losses: 0, kills: 0, deaths: 0, shots_fired: 0 };
    }
}

async function updatePlayerStats(username, updates) {
    if (!redisAvailable || !username) return;
    try {
        const fields = {};
        if (updates.score !== undefined) fields.score = updates.score;
        if (updates.wins !== undefined) fields.wins = updates.wins;
        if (updates.losses !== undefined) fields.losses = updates.losses;
        if (updates.kills !== undefined) fields.kills = updates.kills;
        if (updates.deaths !== undefined) fields.deaths = updates.deaths;
        if (updates.shots_fired !== undefined) fields.shots_fired = updates.shots_fired;

        if (Object.keys(fields).length > 0) {
            await redis.hset(`user:stats:${username}`, fields);
        }

        if (updates.score !== undefined) {
            await redis.zadd('leaderboard:score', updates.score, username);
        }
        if (updates.kills !== undefined) {
            await redis.zadd('leaderboard:kills', updates.kills, username);
        }
        if (updates.wins !== undefined) {
            await redis.zadd('leaderboard:wins', updates.wins, username);
        }
    } catch (err) {
        console.error(`Error updating stats for ${username}: ${err.message}`);
    }
}

function emitStatsUpdate(socket, username) {
    if (!username) return;
    getPlayerStats(username).then(stats => {
        socket.emit('game:statsUpdate', { username, ...stats });
    });
}

// ============================================================
// Auth Middleware Helper
// ============================================================

async function authenticateSocket(socket, payload) {
    const token = payload && payload.token;
    if (!token) return { success: false, username: null, message: 'Authentication required' };

    let username = null;
    try {
        if (redisAvailable) {
            username = await redis.get(`session:${token}`);
        }
    } catch (err) {
        console.error(`Auth error: ${err.message}`);
    }

    if (!username) {
        return { success: false, username: null, message: 'Session expired' };
    }

    return { success: true, username, message: null };
}

// ============================================================
// Socket.IO Connection Handler
// ============================================================

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    let loggedInUsername = null;

    function setLoggedInUsername(username) {
        loggedInUsername = username;
        const p = players[socket.id];
        if (p) {
            p.username = username;
        }
    }

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

    // ---- Auth Events ----

    socket.on('auth:register', async (data) => {
        const { username, password, displayName } = data || {};

        if (!checkAuthRateLimit(socket.id)) {
            return socket.emit('auth:register', { success: false, token: null, message: 'Rate limited. Try again later.' });
        }
        if (!username || !password) {
            return socket.emit('auth:register', { success: false, token: null, message: 'Username and password required' });
        }

        const lowerUsername = username.toLowerCase().trim();
        if (!USERNAME_REGEX.test(lowerUsername)) {
            return socket.emit('auth:register', { success: false, token: null, message: 'Username must be 3-20 chars (alphanumeric + underscore)' });
        }
        if (password.length < 4) {
            return socket.emit('auth:register', { success: false, token: null, message: 'Password must be at least 4 chars' });
        }
        if (!redisAvailable) {
            return socket.emit('auth:register', { success: false, token: null, message: 'Account service unavailable' });
        }

        try {
            const existing = await redis.exists(`user:${lowerUsername}`);
            if (existing) {
                return socket.emit('auth:register', { success: false, token: null, message: 'Username already exists' });
            }

            const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
            const now = new Date().toISOString();
            await redis.hset(`user:${lowerUsername}`, {
                username: lowerUsername,
                password_hash: passwordHash,
                display_name: displayName || lowerUsername,
                created_at: now
            });
            await redis.hset(`user:stats:${lowerUsername}`, {
                score: 0, wins: 0, losses: 0, kills: 0, deaths: 0, shots_fired: 0
            });

            const token = generateToken();
            await redis.set(`session:${token}`, lowerUsername, 'EX', SESSION_TTL);

            setLoggedInUsername(lowerUsername);
            console.log(`Registered: ${lowerUsername}`);
            return socket.emit('auth:register', { success: true, token, message: 'Registration successful' });
        } catch (err) {
            console.error(`Registration error: ${err.message}`);
            return socket.emit('auth:register', { success: false, token: null, message: 'Registration failed' });
        }
    });

    socket.on('auth:login', async (data) => {
        const { username, password } = data || {};

        if (!checkAuthRateLimit(socket.id)) {
            return socket.emit('auth:login', { success: false, token: null, message: 'Rate limited. Try again later.' });
        }
        if (!username || !password) {
            return socket.emit('auth:login', { success: false, token: null, message: 'Username and password required' });
        }

        const lowerUsername = username.toLowerCase().trim();
        if (!redisAvailable) {
            return socket.emit('auth:login', { success: false, token: null, message: 'Account service unavailable' });
        }

        try {
            const user = await redis.hgetall(`user:${lowerUsername}`);
            if (!user || !user.password_hash) {
                return socket.emit('auth:login', { success: false, token: null, message: 'Invalid username or password' });
            }

            const valid = await bcrypt.compare(password, user.password_hash);
            if (!valid) {
                return socket.emit('auth:login', { success: false, token: null, message: 'Invalid username or password' });
            }

            const token = generateToken();
            await redis.set(`session:${token}`, lowerUsername, 'EX', SESSION_TTL);

            setLoggedInUsername(lowerUsername);
            console.log(`Login: ${lowerUsername}`);
            return socket.emit('auth:login', { success: true, token, message: 'Login successful' });
        } catch (err) {
            console.error(`Login error: ${err.message}`);
            return socket.emit('auth:login', { success: false, token: null, message: 'Login failed' });
        }
    });

    socket.on('auth:resume', async (data) => {
        const { token } = data || {};
        if (!token) {
            return socket.emit('auth:resume', { success: false, username: null, message: 'Token required' });
        }

        let username = null;
        try {
            if (redisAvailable) {
                username = await redis.get(`session:${token}`);
            }
        } catch (err) {
            console.error(`Resume error: ${err.message}`);
        }

        if (!username) {
            return socket.emit('auth:resume', { success: false, username: null, message: 'Session expired' });
        }

        setLoggedInUsername(username);
        const p = players[socket.id];
        if (p) p.username = username;

        console.log(`Resume: ${username}`);
        return socket.emit('auth:resume', { success: true, username, message: 'Session resumed' });
    });

    socket.on('auth:logout', async (data) => {
        const { token } = data || {};
        if (!token) {
            return socket.emit('auth:logout', { success: false });
        }
        if (redisAvailable) {
            try { await redis.del(`session:${token}`); } catch (err) { /* ignore */ }
        }
        setLoggedInUsername(null);
        return socket.emit('auth:logout', { success: true });
    });

    // ---- Stats Events ----

    socket.on('stats:query', async (data) => {
        const { username } = data || {};
        if (!username) {
            return socket.emit('stats:query', { username: null, score: 0, wins: 0, losses: 0, kills: 0, deaths: 0, shots_fired: 0 });
        }
        const lowerUsername = username.toLowerCase().trim();
        const stats = await getPlayerStats(lowerUsername);

        if (!redisAvailable || Object.keys(stats).every(k => stats[k] === 0)) {
            if (redisAvailable) {
                const exists = await redis.exists(`user:${lowerUsername}`);
                if (!exists) {
                    return socket.emit('stats:query', {
                        username: lowerUsername, message: 'User not found',
                        score: 0, wins: 0, losses: 0, kills: 0, deaths: 0, shots_fired: 0
                    });
                }
            }
        }

        return socket.emit('stats:query', { username: lowerUsername, ...stats });
    });

    socket.on('stats:me', async (data) => {
        const auth = await authenticateSocket(socket, data);
        if (!auth.success) {
            return socket.emit('stats:me', { message: auth.message, username: null, score: 0, wins: 0, losses: 0, kills: 0, deaths: 0, shots_fired: 0 });
        }
        const stats = await getPlayerStats(auth.username);
        return socket.emit('stats:me', { username: auth.username, ...stats });
    });

    // ---- Leaderboard Events ----

    socket.on('leaderboard:query', async (data) => {
        const { type, limit } = data || {};
        if (!['score', 'wins', 'kills'].includes(type)) {
            return socket.emit('leaderboard:query', { type: type || null, results: [], message: 'Invalid type' });
        }
        const lim = Math.min(parseInt(limit) || 10, 100);

        if (!redisAvailable) {
            return socket.emit('leaderboard:query', { type, results: [], message: 'Leaderboard unavailable' });
        }

        try {
            const entries = await redis.zrangebyscore(
                `leaderboard:${type}`, '-inf', '+inf', 'REV', 'LIMIT', 0, lim
            );
            const results = [];
            for (const entry of entries) {
                const s = await redis.zscore(`leaderboard:${type}`, entry);
                results.push({ username: entry, score: parseInt(s) || 0 });
            }
            return socket.emit('leaderboard:query', { type, results });
        } catch (err) {
            console.error(`Leaderboard error: ${err.message}`);
            return socket.emit('leaderboard:query', { type, results: [], message: 'Leaderboard query failed' });
        }
    });

    // ---- Account Events ----

    socket.on('account:changePassword', async (data) => {
        const auth = await authenticateSocket(socket, data);
        if (!auth.success) {
            return socket.emit('account:changePassword', { success: false, message: auth.message });
        }
        const { oldPassword, newPassword } = data || {};
        if (!oldPassword || !newPassword) {
            return socket.emit('account:changePassword', { success: false, message: 'Old and new password required' });
        }
        if (newPassword.length < 4) {
            return socket.emit('account:changePassword', { success: false, message: 'New password must be at least 4 chars' });
        }
        if (!redisAvailable) {
            return socket.emit('account:changePassword', { success: false, message: 'Account service unavailable' });
        }

        try {
            const user = await redis.hgetall(`user:${auth.username}`);
            if (!user || !user.password_hash) {
                return socket.emit('account:changePassword', { success: false, message: 'User not found' });
            }
            const valid = await bcrypt.compare(oldPassword, user.password_hash);
            if (!valid) {
                return socket.emit('account:changePassword', { success: false, message: 'Old password incorrect' });
            }
            const newHash = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS);
            await redis.hset(`user:${auth.username}`, 'password_hash', newHash);
            console.log(`Password changed: ${auth.username}`);
            return socket.emit('account:changePassword', { success: true, message: 'Password changed successfully' });
        } catch (err) {
            console.error(`Change password error: ${err.message}`);
            return socket.emit('account:changePassword', { success: false, message: 'Failed to change password' });
        }
    });

    socket.on('account:delete', async (data) => {
        const auth = await authenticateSocket(socket, data);
        if (!auth.success) {
            return socket.emit('account:delete', { success: false, message: auth.message });
        }
        const { password } = data || {};
        if (!password) {
            return socket.emit('account:delete', { success: false, message: 'Password required' });
        }
        if (!redisAvailable) {
            return socket.emit('account:delete', { success: false, message: 'Account service unavailable' });
        }

        try {
            const user = await redis.hgetall(`user:${auth.username}`);
            if (!user || !user.password_hash) {
                return socket.emit('account:delete', { success: false, message: 'User not found' });
            }
            const valid = await bcrypt.compare(password, user.password_hash);
            if (!valid) {
                return socket.emit('account:delete', { success: false, message: 'Invalid password' });
            }

            const pipe = redis.pipeline();
            pipe.del(`user:${auth.username}`);
            pipe.del(`user:stats:${auth.username}`);
            pipe.zrem('leaderboard:score', auth.username);
            pipe.zrem('leaderboard:wins', auth.username);
            pipe.zrem('leaderboard:kills', auth.username);
            await pipe.exec();

            setLoggedInUsername(null);
            console.log(`Account deleted: ${auth.username}`);
            return socket.emit('account:delete', { success: true, message: 'Account deleted' });
        } catch (err) {
            console.error(`Account delete error: ${err.message}`);
            return socket.emit('account:delete', { success: false, message: 'Failed to delete account' });
        }
    });

    // ---- Game Events ----

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

            if (loggedInUsername && redisAvailable) {
                getPlayerStats(loggedInUsername).then(stats => {
                    updatePlayerStats(loggedInUsername, { shots_fired: stats.shots_fired + 1 });
                });
            }
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerLeft', socket.id);
    });
});

// ============================================================
// Game Loop
// ============================================================

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

// Helper: get AI target (can be human or other AI)
function getAITarget(aiPlayer, includeAI = true) {
    let target = null;
    let minDist = Infinity;
    for (let otherId in players) {
        if (otherId === aiPlayer.id) continue;
        const other = players[otherId];
        if (!other || other.hp <= 0) continue;
        if (!includeAI && other.isAI) continue;
        const d = Math.sqrt((aiPlayer.x - other.x) ** 2 + (aiPlayer.y - other.y) ** 2);
        if (d < minDist) { minDist = d; target = other; }
    }
    return target;
}

// Helper: AI fires at target
function aiFire(aiPlayer, target) {
    const angleToTarget = Math.atan2(target.y - aiPlayer.y, target.x - aiPlayer.x);
    let angleDiff = angleToTarget - aiPlayer.angle;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

    if (Math.abs(angleDiff) < 0.3 && Math.random() < 0.06) {
        bullets.push({
            x: aiPlayer.x + Math.cos(aiPlayer.angle) * 20,
            y: aiPlayer.y + Math.sin(aiPlayer.angle) * 20,
            angle: aiPlayer.angle,
            ownerId: aiPlayer.id
        });
    }
}

setInterval(() => {
    if (Object.keys(players).length === 0) return;

    for (let id in players) {
        const p = players[id];
        if (!p || p.hp <= 0) continue;

        if (p.isAI) {
            // AI targets humans first; if no humans, targets other AIs
            let target = getAITarget(p, true);

            if (target) {
                const distToTarget = Math.sqrt((target.x - p.x) ** 2 + (target.y - p.y) ** 2);

                if (distToTarget > 300) {
                    p.angle = Math.atan2(target.y - p.y, target.x - p.x);
                    p.isMoving = true;
                    moveTank(p, p.angle, 1);
                } else if (distToTarget > 120) {
                    const angleToTarget = Math.atan2(target.y - p.y, target.x - p.x);
                    p.angle = angleToTarget;
                    const strafeAngle = angleToTarget + (p.strafeDir || 1) * Math.PI / 2.5;
                    p.isMoving = true;
                    moveTank(p, strafeAngle, 0.7);
                } else {
                    const angleToTarget = Math.atan2(target.y - p.y, target.x - p.x);
                    p.angle = angleToTarget;
                    const backAngle = angleToTarget + Math.PI;
                    p.isMoving = true;
                    moveTank(p, backAngle, 1);
                }

                aiFire(p, target);

                if (Math.random() < 0.01) {
                    p.strafeDir = p.strafeDir === 1 ? -1 : 1;
                }
            } else {
                p.isMoving = false;
            }
        } else if (p.isMoving && p.targetX !== 0) {
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
            moveTank(p, p.angle, 1);
        }
    }

    // Bullet logic
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += Math.cos(b.angle) * BULLET_SPEED * DT;
        b.y += Math.sin(b.angle) * BULLET_SPEED * DT;

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

        // Player collision — includes AI vs AI
        for (let pid in players) {
            const p = players[pid];
            if (!p || p.hp <= 0 || pid === b.ownerId) continue;
            const dist = Math.sqrt((b.x - p.x) ** 2 + (b.y - p.y) ** 2);
            if (dist < 20) {
                p.hp -= 35;
                explosions.push({ x: b.x, y: b.y, life: 1.0 });
                bullets.splice(i, 1);

                const killerSocketId = b.ownerId;
                const victimId = pid;

                if (p.hp <= 0) {
                    p.hp = 100;
                    const safe = findSafeSpawn();
                    p.x = safe.x;
                    p.y = safe.y;

                    // Update stats for both killer and victim
                    const killerPlayer = players[killerSocketId];
                    const victimUsername = p.username || null;
                    const killerUsername = killerPlayer ? killerPlayer.username : null;

                    if (killerUsername && redisAvailable) {
                        getPlayerStats(killerUsername).then(kStats => {
                            updatePlayerStats(killerUsername, { kills: kStats.kills + 1, score: kStats.score + 5 });
                        });
                        const killerSocket = io.sockets.sockets.get(killerSocketId);
                        if (killerSocket) {
                            getPlayerStats(killerUsername).then(s => {
                                killerSocket.emit('game:statsUpdate', { username: killerUsername, ...s });
                            });
                        }
                    }

                    if (victimUsername && victimUsername !== killerUsername && redisAvailable) {
                        getPlayerStats(victimUsername).then(vStats => {
                            updatePlayerStats(victimUsername, { deaths: vStats.deaths + 1, score: vStats.score - 10 });
                        });
                        const victimSocket = io.sockets.sockets.get(victimId);
                        if (victimSocket) {
                            getPlayerStats(victimUsername).then(s => {
                                victimSocket.emit('game:statsUpdate', { username: victimUsername, ...s });
                            });
                        }
                    }
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

    // Emit gameState with auth info
    const authInfo = {};
    for (let id in players) {
        const p = players[id];
        if (p.isAI) {
            authInfo[id] = null;
        } else {
            const uname = p.username || null;
            authInfo[id] = { username: uname, loggedIn: !!uname };
        }
    }

    io.emit('gameState', { players, bullets, walls, explosions, auth: authInfo });
}, 16);

server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
