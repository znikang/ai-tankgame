# 領土擴張系統 (Territorial Expansion) Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Implement a 5-point capture system where players and AI tanks can occupy CPs by standing still within range, with visual territory overlay showing control.

**Architecture:** Server-authoritative capture logic in `server.js` game loop; client-side rendering of CPs and territory overlay in `client.js`. All CP state broadcast via existing `gameState` event.

**Tech Stack:** Node.js, Express, Socket.IO, Canvas 2D API

---

## Task 1: Update CP data structures and positions (server)

**Objective:** Replace the 6 CPs with 5 CPs using the new data structure from the spec.

**Files:**
- Modify: `server.js:86-90` (constants and `initCapturePoints`)

**Step 1: Replace CP constants and initialization**

Replace lines 86-90 with:

```js
const CAPTURE_TIME = 5000; // 佔領所需時間 (ms)
const CAPTURE_RADIUS = 80; // 點位交互範圍

let capturePoints = [];

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
```

**Step 2: Verify**

Run: `node server.js` (from `/Users/kk/tank-multiplayer`)
Expected: Server starts without errors, console shows "Map generated: ..." and "Spawned 3 AI tanks"

**Step 3: Commit**

```bash
cd /Users/kk/tank-multiplayer
git add server.js
git commit -m "chore: update CP data structures to 5 points with new schema"
```

---

## Task 2: Implement capture point logic in game loop (server)

**Objective:** Add `updateCapturePoints()` function and integrate it into the 60fps game loop.

**Files:**
- Modify: `server.js` (add function, integrate into loop)

**Step 1: Add `updateCapturePoints()` function**

Add this function right after `initCapturePoints()` call (after line 90):

```js
function updateCapturePoints() {
    const now = Date.now();

    for (const cp of capturePoints) {
        // Check which players are in range and stationary
        const stationaryPlayers = [];

        for (const id in players) {
            const p = players[id];
            if (!p || p.hp <= 0) continue;

            const dist = Math.sqrt((p.x - cp.x) ** 2 + (p.y - cp.y) ** 2);
            if (dist < cp.radius) {
                // Calculate speed: use distance from last position
                const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 0;
                if (speed < 2) {
                    stationaryPlayers.push(p);
                }
            }
        }

        // If no stationary players, reset capture state
        if (stationaryPlayers.length === 0) {
            if (cp.capturingPlayerId !== null && cp.ownerId === null) {
                cp.capturingPlayerId = null;
                cp.captureStartTime = null;
            }
            continue;
        }

        // Handle capture logic
        if (cp.ownerId !== null) {
            // CP is already owned
            const owner = stationaryPlayers.find(p => p.id === cp.ownerId);
            if (owner) {
                // Owner is still there — no action needed
                continue;
            }
            // Enemy player is here — start enemy capture
            const enemy = stationaryPlayers.find(p => p.id !== cp.ownerId);
            if (enemy) {
                cp.capturingPlayerId = enemy.id;
                cp.captureStartTime = now;
            }
        } else {
            // CP is unowned
            if (cp.capturingPlayerId === null) {
                // No one is capturing yet — first player starts
                cp.capturingPlayerId = stationaryPlayers[0].id;
                cp.captureStartTime = now;
            } else {
                // Someone is already capturing — check if a different player entered
                const currentCapture = stationaryPlayers.find(p => p.id === cp.capturingPlayerId);
                if (!currentCapture) {
                    // Original capturer left — new player starts capture
                    cp.captureStartTime = now;
                    cp.capturingPlayerId = stationaryPlayers[0].id;
                }
                // If original capturer is still there, continue their timer
            }
        }

        // Check if capture completed
        if (cp.capturingPlayerId !== null && cp.captureStartTime !== null) {
            if (now - cp.captureStartTime >= CAPTURE_TIME) {
                // Capture complete!
                cp.ownerId = cp.capturingPlayerId;
                cp.capturingPlayerId = null;
                cp.captureStartTime = null;
                console.log(`CP ${cp.id} captured by ${cp.ownerId}`);
            }
        }
    }
}
```

**Step 2: Update player movement to track velocity**

In the player creation (line ~413-426), add `vx` and `vy` fields:

Find the player creation block around line 413:
```js
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
```

And in AI tank creation (line ~248-263), add `vx: 0, vy: 0` to the AI player object.

**Step 3: Track velocity in game loop**

In the game loop (line 876+), right before movement happens for each player, add velocity tracking. In the movement section (around lines 879-933), after `moveTank()` is called, add:

```js
// Track velocity for capture detection
p.vx = p._prevX ? p.x - p._prevX : 0;
p.vy = p._prevY ? p.y - p._prevY : 0;
p._prevX = p.x;
p._prevY = p.y;
```

Add this tracking inside the `for (let id in players)` loop, after the movement code but before the closing brace of the player iteration.

**Step 4: Integrate `updateCapturePoints()` into game loop**

In the game loop (line 876+), add the call right after the player movement section (after line 933, before bullet logic at line 935):

```js
    // Capture point logic
    updateCapturePoints();
```

**Step 5: Verify**

Run: `node server.js`
Expected: Server starts without errors, no new errors in console

**Step 6: Commit**

```bash
cd /Users/kk/tank-multiplayer
git add server.js
git commit -m "feat: add capture point logic with velocity tracking and game loop integration"
```

---

## Task 3: Broadcast CP state in gameState (server)

**Objective:** Include capture points data in the `gameState` broadcast sent to all clients.

**Files:**
- Modify: `server.js:1072-1084` (gameState broadcast section)

**Step 1: Add CP data to gameState**

Replace the gameState broadcast section (lines 1072-1084):

```js
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
    });
```

**Step 2: Verify**

Run: `node server.js`
Expected: Server starts without errors

**Step 3: Commit**

```bash
cd /Users/kk/tank-multiplayer
git add server.js
git commit -m "feat: broadcast capture point state in gameState"
```

---

## Task 4: Client-side CP rendering (drawCapturePoints)

**Objective:** Add `drawCapturePoints()` function to client.js that renders CPs with correct visual states.

**Files:**
- Modify: `public/client.js` (add function, call in draw loop)

**Step 1: Add `drawCapturePoints()` function**

Add this function before the `gameLoop()` call (around line 566, after `draw()` function):

```js
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
            // Owned CP: solid border, thicker
            const owner = state.players[cp.ownerId];
            ctx.strokeStyle = owner ? owner.color : '#888';
            ctx.lineWidth = 3;
            ctx.setLineDash([]);
        } else if (isCapturing) {
            // Capturing: solid border, same color as capturer
            const capturer = state.players[cp.capturingPlayerId];
            ctx.strokeStyle = capturer ? capturer.color : '#888';
            ctx.lineWidth = 2;
            ctx.setLineDash([]);
        } else {
            // Unowned: gray dashed border
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
            // Flag icon for owned
            ctx.fillText('🏁', cp.x, cp.y);
        } else if (isCapturing) {
            // Clock icon for capturing
            ctx.fillText('⏳', cp.x, cp.y);
        } else {
            // Plus icon for unowned
            ctx.fillText('+', cp.x, cp.y);
        }
        ctx.restore();
    }
}
```

**Step 2: Add `drawTerritoryOverlay()` function**

Add this function right after `drawCapturePoints()` (territory overlay should be drawn BEFORE CPs so CPs appear on top):

```js
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
```

**Step 3: Add CAPTURE_TIME constant to client**

Add near the top of client.js with other constants (after line 8, after `MAP_H = 1200`):

```js
const CAPTURE_TIME = 5000;
```

**Step 4: Call draw functions in `draw()`**

In the `draw()` function, find the right place to insert territory rendering. The render order should be:
1. Grid
2. Territory overlay
3. Walls
4. Players
5. CPs (on top)

Insert `drawTerritoryOverlay(ctx)` right after the grid drawing (after line 381, before "Walls" comment at line 383):

```js
    // Territory overlay
    drawTerritoryOverlay(ctx);
```

Insert `drawCapturePoints(ctx)` right after the muzzle flash section (after line 539, before `ctx.restore()` at line 541):

```js
    // Capture points
    drawCapturePoints(ctx);
```

**Step 5: Store capturePoints in state variable**

Add a `state` variable near the top of client.js (after line 17, after `let DT = 1 / 60;`):

```js
let state = {
    players: {},
    bullets: [],
    walls: [],
    explosions: [],
    weaponDrops: [],
    auth: {},
    capturePoints: [],
};
```

**Step 6: Update gameState handler to use state**

Replace the existing `gameState` handler (lines 222-273) with:

```js
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
```

**Step 7: Update `initMap` handler**

Replace line 275:

```js
socket.on('initMap', (serverWalls) => { walls = serverWalls; });
```

Keep as-is (walls is a reference to `state.walls` indirectly).

**Step 8: Verify**

Run: `node server.js` then open `http://localhost:3000` in browser
Expected:
- 5 CPs visible on map (dashed gray circles with + icons)
- No console errors
- CPs show correctly with camera movement

**Step 9: Commit**

```bash
cd /Users/kk/tank-multiplayer
git add public/client.js
git commit -m "feat: add client-side CP rendering with territory overlay"
```

---

## Task 5: Handle disconnect — reset player-owned CPs

**Objective:** When a player disconnects, reset any CPs they owned.

**Files:**
- Modify: `server.js` (disconnect handler)

**Step 1: Add CP reset to disconnect handler**

Find the disconnect handler at line 787-790:

```js
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
```

**Step 2: Verify**

Run: `node server.js`
Expected: Server starts without errors

**Step 3: Commit**

```bash
cd /Users/kk/tank-multiplayer
git add server.js
git commit -m "feat: reset player-owned CPs on disconnect"
```

---

## Task 6: End-to-end testing

**Objective:** Verify the full system works: capture, ownership change, territory overlay.

**Step 1: Start server**

```bash
cd /Users/kk/tank-multiplayer
node server.js
```

Expected output:
```
Map generated: X walls (Y destructible, Z solid)
Spawned 3 AI tanks
Redis connected
Server running at http://localhost:3000
```

**Step 2: Open browser**

Open `http://localhost:3000` in your browser.

**Step 3: Verify CPs visible**

- 5 CPs should be visible: 4 corners + 1 center
- Center CP should be larger (radius 120 vs 80)
- All should have dashed gray borders with "+" in center

**Step 4: Test capture**

- Move your tank to a CP (e.g., center at 800, 600)
- Stop moving (hold still for ~5 seconds)
- Verify: CP border changes to your tank color, progress ring fills clockwise, center shows ⏳
- After 5 seconds: border becomes thicker, center shows 🏁

**Step 5: Test enemy capture**

- If another player (or AI) enters the same CP while you're capturing
- Verify: progress ring resets, new capturer's color shows

**Step 6: Verify territory overlay**

- When CP is owned, verify semi-transparent color fills a large area around the CP
- Multiple owned CPs should show overlapping colored areas

**Step 7: Verify AI capture**

- AI tanks should also be able to capture CPs
- Check console for "CP X captured by ai-Y" messages

**Step 8: Verify disconnect**

- Disconnect a player who owns a CP
- CP should revert to unowned (dashed gray border, + icon)

---

## Summary of Changes

| File | Lines Changed | Description |
|------|---------------|-------------|
| `server.js:86-90` | ~5 lines | CP data structure + 5 positions |
| `server.js:~91` | ~50 lines | `updateCapturePoints()` function |
| `server.js:~413-426` | +2 fields | Player `vx`, `vy` tracking |
| `server.js:~248-263` | +2 fields | AI player `vx`, `vy` tracking |
| `server.js:~879-933` | ~6 lines | Velocity tracking in game loop |
| `server.js:~935` | 1 line | `updateCapturePoints()` call |
| `server.js:1072-1084` | ~15 lines | CP data in gameState broadcast |
| `server.js:787-790` | ~8 lines | CP reset on disconnect |
| `public/client.js` | ~100 lines | CP rendering + territory overlay |

## Design Doc Reference

`/Users/kk/tank-multiplayer/docs/superpowers/2026-06-08-territorial-expansion-design.md`
