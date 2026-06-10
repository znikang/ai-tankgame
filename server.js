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
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
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

function cleanupAuthRateLimits() {
    const now = Date.now();
    for (const [socketId, entry] of authRateLimits.entries()) {
        if (now > entry.resetTime) {
            authRateLimits.delete(socketId);
        }
    }
}

setInterval(cleanupAuthRateLimits, 60000);

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

const CAPTURE_TIME = 5000; // 佔領所需時間 (ms)
const CAPTURE_RADIUS = 80; // 點位交互範圍

// ============================================================
// Map Themes — each map has different wall density and background
// ============================================================

const MAP_THEMES = [
    {
        name: '廢墟戰場',
        bg: '#0a0a0c',
        gridColor: '#1a1a1d',
        destructibleChance: 0.25,
        solidChance: 0.08,
        elongatedCount: 30,
    },
    {
        name: '冰封要塞',
        bg: '#0c1220',
        gridColor: '#162035',
        destructibleChance: 0.18,
        solidChance: 0.12,
        elongatedCount: 20,
    },
    {
        name: '熔岩裂谷',
        bg: '#1a0c0a',
        gridColor: '#2d1a15',
        destructibleChance: 0.30,
        solidChance: 0.06,
        elongatedCount: 35,
    },
    {
        name: '叢林迷宮',
        bg: '#0a140c',
        gridColor: '#152a1a',
        destructibleChance: 0.22,
        solidChance: 0.10,
        elongatedCount: 25,
    },
    {
        name: '霓虹都市',
        bg: '#0e0a1a',
        gridColor: '#1a1530',
        destructibleChance: 0.15,
        solidChance: 0.14,
        elongatedCount: 40,
    },
];

let currentMapTheme = 0; // 0-indexed into MAP_THEMES

let capturePoints = [];
let gameWon = false; // 防止重複觸發勝利

function initCapturePoints() {
    capturePoints = [
        { id: 'cp-1', x: 200, y: 200, radius: CAPTURE_RADIUS, ownerId: null, regionTag: 'corner-nw', capturingPlayerId: null, captureStartTime: null },
        { id: 'cp-2', x: 1400, y: 200, radius: CAPTURE_RADIUS, ownerId: null, regionTag: 'corner-ne', capturingPlayerId: null, captureStartTime: null },
        { id: 'cp-3', x: 200, y: 1000, radius: CAPTURE_RADIUS, ownerId: null, regionTag: 'corner-sw', capturingPlayerId: null, captureStartTime: null },
        { id: 'cp-4', x: 1400, y: 1000, radius: CAPTURE_RADIUS, ownerId: null, regionTag: 'corner-se', capturingPlayerId: null, captureStartTime: null },
        { id: 'cp-5', x: 800, y: 600, radius: CAPTURE_RADIUS * 1.5, ownerId: null, regionTag: 'center', capturingPlayerId: null, captureStartTime: null },
    ];
}

initCapturePoints();

function updateCapturePoints() {
    const now = Date.now();

    for (const cp of capturePoints) {
        // Check which players are inside the CP radius
        const playersInRange = [];

        for (const id in players) {
            const p = players[id];
            if (!p || p.hp <= 0) continue;

            const dist = Math.sqrt((p.x - cp.x) ** 2 + (p.y - cp.y) ** 2);
            if (dist < cp.radius) {
                playersInRange.push(p);
            }
        }

        // No one in range — reset capture progress
        if (playersInRange.length === 0) {
            cp.capturingPlayerId = null;
            cp.captureStartTime = null;
            continue;
        }

        // Separate players by ownership
        const ownerInRange = cp.ownerId !== null
            ? playersInRange.find(p => p.id === cp.ownerId)
            : null;
        const enemiesInRange = cp.ownerId !== null
            ? playersInRange.filter(p => p.id !== cp.ownerId)
            : playersInRange;

        if (cp.ownerId === null) {
            // Unowned CP — first player starts capturing
            if (cp.capturingPlayerId !== playersInRange[0].id) {
                cp.capturingPlayerId = playersInRange[0].id;
                cp.captureStartTime = now;
            }
        } else if (ownerInRange && enemiesInRange.length === 0) {
            // Owner alone in range — maintains ownership, cancel any pending capture
            cp.capturingPlayerId = null;
            cp.captureStartTime = null;
        } else if (ownerInRange && enemiesInRange.length > 0) {
            // Both owner and enemies in range — owner holds, but enemies can steal
            const enemy = enemiesInRange[0];
            if (cp.capturingPlayerId !== enemy.id) {
                cp.capturingPlayerId = enemy.id;
                cp.captureStartTime = now;
            }
        } else if (!ownerInRange && enemiesInRange.length > 0) {
            // Owner NOT in range — enemies steal
            const enemy = enemiesInRange[0];
            if (cp.capturingPlayerId !== enemy.id) {
                cp.capturingPlayerId = enemy.id;
                cp.captureStartTime = now;
            }
        }

        // Check if capture completed
        if (cp.capturingPlayerId !== null && cp.captureStartTime !== null) {
            if (now - cp.captureStartTime >= CAPTURE_TIME) {
                const newOwnerId = cp.capturingPlayerId;
                const wasOwned = cp.ownerId !== null;
                cp.ownerId = newOwnerId;
                cp.capturingPlayerId = null;
                cp.captureStartTime = null;
                console.log(`CP ${cp.id} ${wasOwned ? 'stolen by' : 'captured by'} ${newOwnerId}`);

                // 勝利判斷：檢查是否所有點位都已被同一人佔領
                if (!gameWon && capturePoints.every(p => p.ownerId === cp.ownerId)) {
                    gameWon = true;
                    const player = players[cp.ownerId];
                    if (player && player.username) {
                        handleVictory(player.username);
                    }
                }
            }
        }
    }
}

// ============================================================
// Weapon System
// ============================================================
const WEAPON_TYPES = ['basic', 'shotgun', 'sniper', 'freeze', 'accel'];

const WEAPON_CONFIG = {
    basic:    { damage: 35, fireRate: 200, bulletSpeed: 450, color: '#FFFF00', radius: 4 },
    shotgun:  { damage: 20, fireRate: 800, bulletSpeed: 400, color: '#FF8800', radius: 5, count: 5, spread: [-30, 30] },
    sniper:   { damage: 100, fireRate: 800, bulletSpeed: 500, color: '#FF0000', radius: 6 },
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
let earthquakeTimer = null;
const EARTHQUAKE_MIN = 30000; // 30 seconds
const EARTHQUAKE_MAX = 90000; // 90 seconds

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
    for (let attempt = 0; attempt < 200; attempt++) {
        const x = Math.random() * (MAP_W - 2 * RADIUS) + RADIUS;
        const y = Math.random() * (MAP_H - 2 * RADIUS) + RADIUS;
        if (!checkWallCollision(x, y, RADIUS)) {
            return { x, y };
        }
    }
    // Fallback: try each AI_SPAWN position with a small random offset
    for (const sp of AI_SPAWNS) {
        for (let r = 0; r < 20; r++) {
            const ox = (Math.random() - 0.5) * GRID;
            const oy = (Math.random() - 0.5) * GRID;
            const px = sp.x + ox;
            const py = sp.y + oy;
            if (px >= RADIUS && px <= MAP_W - RADIUS && py >= RADIUS && py <= MAP_H - RADIUS) {
                if (!checkWallCollision(px, py, RADIUS)) {
                    return { x: px, y: py };
                }
            }
        }
    }
    // Absolute last resort: center of map
    return clampToMap(MAP_W / 2, MAP_H / 2);
}

// Generate random map with grid-based walls
function generateMap() {
    walls = [];
    const cols = Math.floor(MAP_W / GRID);
    const rows = Math.floor(MAP_H / GRID);
    const theme = MAP_THEMES[currentMapTheme];

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
            if (Math.random() < theme.destructibleChance) {
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
            if (Math.random() < theme.solidChance) {
                walls.push({
                    x: c * GRID, y: r * GRID, w: GRID, h: GRID,
                    destructible: false, hp: 999
                });
            }
        }
    }

    // Elongated solid walls
    for (let attempt = 0; attempt < theme.elongatedCount; attempt++) {
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

    console.log(`[${theme.name}] Map generated: ${walls.length} walls (${walls.filter(w => w.destructible).length} destructible, ${walls.filter(w => !w.destructible).length} solid)`);
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
            strafeDir: 1,
            weapon: 'basic',
            lastFire: 0,
            frozenUntil: 0,
            vx: 0,
            vy: 0
        };
    }
    console.log(`Spawned ${count} AI tanks`);
}

generateMap();
spawnAITanks(3);

function scheduleEarthquake() {
    const delay = EARTHQUAKE_MIN + Math.random() * (EARTHQUAKE_MAX - EARTHQUAKE_MIN);
    earthquakeTimer = setTimeout(() => {
        triggerEarthquake();
    }, delay);
}

function triggerEarthquake() {
    let movedCount = 0;
    for (let i = 0; i < walls.length; i++) {
        const wall = walls[i];
        if (!wall.destructible) continue;
        const shift = Math.floor(Math.random() * 5) - 2; // -2 to +2
        const shiftY = Math.floor(Math.random() * 5) - 2;
        const newX = wall.x + shift * GRID;
        const newY = wall.y + shiftY * GRID;
        const clampedX = Math.max(0, Math.min(MAP_W - GRID, newX));
        const clampedY = Math.max(0, Math.min(MAP_H - GRID, newY));
        wall.x = clampedX;
        wall.y = clampedY;
        movedCount++;
    }
    console.log(`Earthquake! Moved ${movedCount} walls.`);
    io.emit('earthquake', { walls });
    scheduleEarthquake();
}

scheduleEarthquake();

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

// 勝利邏輯與點位管理擴充
async function handleVictory(username) {
    console.log(`Player ${username} achieved victory!`);
    try {
        const currentStats = await getPlayerStats(username);
        await updatePlayerStats(username, { score: currentStats.score + 500 });

        // 通知客戶端勝利並提供視覺過場時間
        setTimeout(() => {
            io.emit('game:victory', { 
                username, 
                score: currentStats.score + 500,
                message: "恭喜佔領全區！地圖正在重新生成..." 
            });

            transitionToNextMap();
        }, 2000);
    } catch (err) {
        console.error("Error handling victory:", err);
    }
}

function transitionToNextMap() {
    console.log("Transitioning to next map...");
    
    // 重置遊戲狀態
    gameWon = false;
    
    // 分離人類玩家和 AI 玩家
    const humanPlayers = {};
    for (let id in players) {
        if (!players[id].isAI) {
            humanPlayers[id] = players[id];
        }
    }
    
    
    // 切換到下一張地圖
    currentMapTheme = (currentMapTheme + 1) % MAP_THEMES.length;
    const theme = MAP_THEMES[currentMapTheme];
    
    // 重新生成地圖
    generateMap();
    
    // 重新生成所有玩家
    players = {};
    
    // 重新生成人類玩家（找安全位置重生，武器重置為 basic）
    for (let id in humanPlayers) {
        const p = humanPlayers[id];
        const safe = findSafeSpawn();
        players[id] = {
            ...p,
            x: safe.x,
            y: safe.y,
            hp: 100,
            weapon: 'basic',
            targetX: 0,
            targetY: 0,
            isMoving: false,
            lastFire: 0,
            frozenUntil: 0,
            vx: 0,
            vy: 0,
        };
    }
    
    // 重新生成 AI 坦克
    spawnAITanks(3);
    weaponDrops = [];
    
    // 重新分配點位讓下一局不同一點
    capturePoints = [
        { id: 'cp-1', x: Math.random() * (MAP_W - 400) + 200, y: Math.random() * (MAP_H - 400) + 200, radius: CAPTURE_RADIUS, ownerId: null, regionTag: 'dynamic', capturingPlayerId: null, captureStartTime: null },
        { id: 'cp-2', x: Math.random() * (MAP_W - 400) + 200, y: Math.random() * (MAP_H - 400) + 200, radius: CAPTURE_RADIUS, ownerId: null, regionTag: 'dynamic', capturingPlayerId: null, captureStartTime: null },
        { id: 'cp-3', x: Math.random() * (MAP_W - 400) + 200, y: Math.random() * (MAP_H - 400) + 200, radius: CAPTURE_RADIUS, ownerId: null, regionTag: 'dynamic', capturingPlayerId: null, captureStartTime: null },
        { id: 'cp-4', x: Math.random() * (MAP_W - 400) + 200, y: Math.random() * (MAP_H - 400) + 200, radius: CAPTURE_RADIUS, ownerId: null, regionTag: 'dynamic', capturingPlayerId: null, captureStartTime: null },
        { id: 'cp-5', x: Math.random() * (MAP_W - 400) + 200, y: Math.random() * (MAP_H - 400) + 200, radius: CAPTURE_RADIUS * 1.5, ownerId: null, regionTag: 'dynamic', capturingPlayerId: null, captureStartTime: null },
    ];

    io.emit('map:reset', {
        walls: walls,
        capturePoints: capturePoints,
        players: players,
        theme: { name: theme.name, bg: theme.bg, gridColor: theme.gridColor }
    });
}

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
        isMoving: false,
        weapon: 'basic',
        lastFire: 0,
        frozenUntil: 0,
        vx: 0,
        vy: 0
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

    // ---- Auth Helper ----

    async function authenticateSocket(socket, data) {
        const { token } = data || {};
        if (!token) {
            return { success: false, message: 'Authentication required', username: null };
        }

        let username = null;
        try {
            if (redisAvailable) {
                username = await redis.get(`session:${token}`);
            }
        } catch (err) {
            console.error(`Auth error: ${err.message}`);
        }

        if (!username) {
            return { success: false, message: 'Session expired', username: null };
        }

        return { success: true, username };
    }

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
        if (!p || p.hp <= 0) return;

        const now = Date.now();
        const config = WEAPON_CONFIG[p.weapon];
        if (!config) return;
        if (now - p.lastFire < config.fireRate) return;

        p.lastFire = now;

        // Track shots fired stat
        if (loggedInUsername && redisAvailable) {
            getPlayerStats(loggedInUsername).then(stats => {
                updatePlayerStats(loggedInUsername, { shots_fired: stats.shots_fired + 1 });
            });
        }

        // Create bullets based on weapon type
        if (p.weapon === 'shotgun') {
            // Shotgun: fan spread of 5 bullets
            const spread = config.spread; // [-30, 30] degrees
            const count = config.count;  // 5
            for (let i = 0; i < count; i++) {
                const angleDeg = spread[0] + (spread[1] - spread[0]) * (i / (count - 1));
                const angleRad = p.angle + (angleDeg * Math.PI / 180);
                bullets.push({
                    x: p.x + Math.cos(angleRad) * 20,
                    y: p.y + Math.sin(angleRad) * 20,
                    angle: angleRad,
                    ownerId: socket.id,
                    damage: config.damage,
                    speed: config.bulletSpeed,
                    color: config.color,
                    radius: config.radius,
                    isFreeze: false,
                    isAccelerated: false,
                });
            }
        } else {
            // All other weapons: single bullet
            bullets.push({
                x: p.x + Math.cos(p.angle) * 20,
                y: p.y + Math.sin(p.angle) * 20,
                angle: p.angle,
                ownerId: socket.id,
                damage: config.damage,
                speed: config.bulletSpeed,
                color: config.color,
                radius: config.radius,
                isFreeze: config.freeze || false,
                isAccelerated: config.accelerated || false,
            });
        }
    });

    socket.on('disconnect', () => {
        // Reset CPs owned by this player
        for (const cp of capturePoints) {
            if (cp.ownerId === socket.id) {
                cp.ownerId = null;
                cp.capturingPlayerId = null;
                cp.captureStartTime = null;
                console.log(`CP ${cp.id} lost ownership (player ${socket.id} disconnected)`);
            }
        }

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
    const config = WEAPON_CONFIG[aiPlayer.weapon];
    const now = Date.now();
    if (now - aiPlayer.lastFire < config.fireRate) return;

    const angleToTarget = Math.atan2(target.y - aiPlayer.y, target.x - aiPlayer.x);
    let angleDiff = angleToTarget - aiPlayer.angle;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

    if (Math.abs(angleDiff) < 0.3 && Math.random() < 0.06) {
        aiPlayer.lastFire = now;

        if (aiPlayer.weapon === 'shotgun') {
            const spread = config.spread;
            const count = config.count;
            for (let i = 0; i < count; i++) {
                const angleDeg = spread[0] + (spread[1] - spread[0]) * (i / (count - 1));
                const angleRad = aiPlayer.angle + (angleDeg * Math.PI / 180);
                bullets.push({
                    x: aiPlayer.x + Math.cos(angleRad) * 20,
                    y: aiPlayer.y + Math.sin(angleRad) * 20,
                    angle: angleRad,
                    ownerId: aiPlayer.id,
                    damage: config.damage,
                    speed: config.bulletSpeed,
                    color: config.color,
                    radius: config.radius,
                    isFreeze: false,
                    isAccelerated: false,
                });
            }
        } else {
            bullets.push({
                x: aiPlayer.x + Math.cos(aiPlayer.angle) * 20,
                y: aiPlayer.y + Math.sin(aiPlayer.angle) * 20,
                angle: aiPlayer.angle,
                ownerId: aiPlayer.id,
                damage: config.damage,
                speed: config.bulletSpeed,
                color: config.color,
                radius: config.radius,
                isFreeze: config.freeze || false,
                isAccelerated: config.accelerated || false,
            });
        }
    }
}

setInterval(async () => {
    try {
    if (Object.keys(players).length === 0) return;

    for (let id in players) {
        const p = players[id];
        if (!p || p.hp <= 0) continue;

        if (p.isAI) {
            // Check freeze status
            const isFrozen = Date.now() < p.frozenUntil;
            const speedMult = isFrozen ? 0.5 : 1;

            // Check if AI owns a CP — patrol nearby
            const ownedCP = capturePoints.find(cp => cp.ownerId === p.id);
            const nearestEnemyCP = capturePoints
                .filter(cp => cp.ownerId !== null && cp.ownerId !== p.id)
                .map(cp => ({ cp, dist: Math.sqrt((cp.x - p.x) ** 2 + (cp.y - p.y) ** 2) }))
                .sort((a, b) => a.dist - b.dist)[0];

            // If AI owns a CP — patrol around it (not on top, so enemies can challenge)
            if (ownedCP) {
                const distToOwned = Math.sqrt((ownedCP.x - p.x) ** 2 + (ownedCP.y - p.y) ** 2);
                if (distToOwned > ownedCP.radius * 2.5) {
                    // Too far — return to defend
                    p.angle = Math.atan2(ownedCP.y - p.y, ownedCP.x - p.x);
                    p.isMoving = true;
                    moveTank(p, p.angle, speedMult);
                } else if (nearestEnemyCP && nearestEnemyCP.dist < 400) {
                    // Enemy nearby — rush to defend that CP
                    const angleToEnemy = Math.atan2(nearestEnemyCP.cp.y - p.y, nearestEnemyCP.cp.x - p.x);
                    p.angle = angleToEnemy;
                    p.isMoving = true;
                    moveTank(p, p.angle, speedMult);
                    aiFire(p, { x: nearestEnemyCP.cp.x, y: nearestEnemyCP.cp.y });
                } else {
                    // Patrol around the CP in a circle — stays in range but keeps moving
                    const patrolAngle = Date.now() / 1500 + (p.id.charCodeAt(2) || 0);
                    const patrolRadius = ownedCP.radius * 0.7;
                    const tx = ownedCP.x + Math.cos(patrolAngle) * patrolRadius;
                    const ty = ownedCP.y + Math.sin(patrolAngle) * patrolRadius;
                    p.angle = Math.atan2(ty - p.y, tx - p.x);
                    p.isMoving = true;
                    moveTank(p, p.angle, speedMult * 0.6);
                }
            } else {
                // AI has no CP — look for unowned or enemy CPs to capture
                let targetCP = capturePoints.find(cp => cp.ownerId === null);
                if (!targetCP && nearestEnemyCP) {
                    targetCP = nearestEnemyCP.cp;
                }

                if (targetCP) {
                    const distToCP = Math.sqrt((targetCP.x - p.x) ** 2 + (targetCP.y - p.y) ** 2);
                    
                    // If there's a combat target nearby, fight first
                    let combatTarget = getAITarget(p, true);
                    if (combatTarget && Math.sqrt((combatTarget.x - p.x) ** 2 + (combatTarget.y - p.y) ** 2) < 250) {
                        // Engage in combat
                        let target = combatTarget;
                        const distToTarget = Math.sqrt((target.x - p.x) ** 2 + (target.y - p.y) ** 2);
                        if (distToTarget > 300) {
                            p.angle = Math.atan2(target.y - p.y, target.x - p.x);
                            p.isMoving = true;
                            moveTank(p, p.angle, speedMult);
                        } else if (distToTarget > 120) {
                            const angleToTarget = Math.atan2(target.y - p.y, target.x - p.x);
                            p.angle = angleToTarget;
                            const strafeAngle = angleToTarget + (p.strafeDir || 1) * Math.PI / 2.5;
                            p.isMoving = true;
                            moveTank(p, strafeAngle, 0.7 * speedMult);
                        } else {
                            const angleToTarget = Math.atan2(target.y - p.y, target.x - p.x);
                            p.angle = angleToTarget;
                            const backAngle = angleToTarget + Math.PI;
                            p.isMoving = true;
                            moveTank(p, backAngle, speedMult);
                        }
                        aiFire(p, target);
                        if (Math.random() < 0.01) {
                            p.strafeDir = p.strafeDir === 1 ? -1 : 1;
                        }
                    } else if (distToCP > 150) {
                        // Move toward CP
                        p.angle = Math.atan2(targetCP.y - p.y, targetCP.x - p.x);
                        p.isMoving = true;
                        moveTank(p, p.angle, speedMult);
                    } else {
                        // Arrived at CP — stand still to capture
                        p.isMoving = false;
                    }
                } else {
                    // No CPs available — idle
                    p.isMoving = false;
                }
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

        // Track velocity for capture detection
        p.vx = p._prevX !== undefined ? p.x - p._prevX : 0;
        p.vy = p._prevY !== undefined ? p.y - p._prevY : 0;
        p._prevX = p.x;
        p._prevY = p.y;
    }

    // Capture point logic
    updateCapturePoints();

    // Bullet logic
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += Math.cos(b.angle) * b.speed * DT;
        b.y += Math.sin(b.angle) * b.speed * DT;

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
                p.hp -= b.damage;
                explosions.push({ x: b.x, y: b.y, life: 1.0 });
  if (b.isFreeze) {
                    p.frozenUntil = Date.now() + 2000;
                }
                bullets.splice(i, 1);

                const killerSocketId = b.ownerId;
                const victimId = pid;

                if (p.hp <= 0) {
                    // Drop weapon or health pack (50/50)
                    if (Math.random() < 0.5) {
                        const dropType = SPECIAL_WEAPONS[Math.floor(Math.random() * SPECIAL_WEAPONS.length)];
                        weaponDrops.push({
                            x: p.x,
                            y: p.y,
                            type: dropType,
                            color: WEAPON_CONFIG[dropType].color,
                        });
                    } else {
                        weaponDrops.push({
                            x: p.x,
                            y: p.y,
                            type: 'health',
                            color: '#00FF00',
                        });
                    }

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

    // Weapon pickup detection
    for (let pi in players) {
        const player = players[pi];
        if (!player || player.hp <= 0) continue;

        for (let di = weaponDrops.length - 1; di >= 0; di--) {
            const drop = weaponDrops[di];
            const dist = Math.sqrt((player.x - drop.x) ** 2 + (player.y - drop.y) ** 2);

            if (dist < 25) {
                weaponDrops.splice(di, 1);

                if (drop.type === 'health') {
                    player.hp = Math.min(100, player.hp + 30);
                    const socket = io.sockets.sockets.get(pi);
                    if (socket) {
                        socket.emit('weaponPickup', { weapon: 'health', name: '+30 HP' });
                    }
                } else {
                    player.weapon = drop.type;
                    const socket = io.sockets.sockets.get(pi);
                    if (socket) {
                        socket.emit('weaponPickup', { weapon: drop.type, name: WEAPON_NAMES[drop.type] });
                    }
                }
            }
        }
    }

    // Emit gameState with auth info and capture points
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

    // Serialize capture points for client
    const cpData = capturePoints.map(cp => ({
        id: cp.id,
        x: cp.x,
        y: cp.y,
        radius: cp.radius,
        ownerId: cp.ownerId,
        capturingPlayerId: cp.capturingPlayerId,
        captureStartTime: cp.captureStartTime,
        regionTag: cp.regionTag,
    }));

    io.emit('gameState', {
        players,
        bullets,
        walls,
        explosions,
        weaponDrops,
        auth: authInfo,
        capturePoints: cpData,
        theme: MAP_THEMES[currentMapTheme],
    });
    } catch (err) {
        console.error('Game loop error:', err);
    }
}, 16);

server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
