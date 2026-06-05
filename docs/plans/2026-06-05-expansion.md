# 遊戲內容擴展 Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 為 tank-multiplayer 添加 4 個新內容：動態地震地圖、Web Audio 音效、視覺特效（粒子 + 飄字）、血量補給掉落。

**Architecture:** 地震和血量補給在服務端計算，粒子/飄字/音效在客戶端渲染。地震服務端觸發並廣播，客戶端顯示閃紅效果。血量補給服務端處理拾取和 HP 更新。音效和視覺特效純客戶端。

**Tech Stack:** Node.js + Express + Socket.IO + Canvas 2D + Web Audio API

---

## Task 1: 地震計時器 + 處理函數（服務端）

**Objective:** 在 server.js 添加地震計時器和處理函數。

**Files:**
- Modify: `server.js:112-113`（添加地震相關變量）
- Modify: `server.js:266-267`（在 generateMap/spawnAITanks 後啟動地震計時器）
- Modify: `server.js:1036-1037`（gameState 廣播後重新啟動計時器）

**Step 1: 添加地震變量（第 112 行 `let weaponDrops = [];` 之後）**

插入：
```js
let earthquakeTimer = null;
const EARTHQUAKE_MIN = 30000; // 30 seconds
const EARTHQUAKE_MAX = 90000; // 90 seconds
```

**Step 2: 在 generateMap/spawnAITanks 之後（第 267 行後）添加地震計時器啟動**

插入：
```js
function scheduleEarthquake() {
    const delay = EARTHQUAKE_MIN + Math.random() * (EARTHQUAKE_MAX - EARTHQUAKE_MIN);
    earthquakeTimer = setTimeout(() => {
        triggerEarthquake();
    }, delay);
}

function triggerEarthquake() {
    // Move all destructible walls randomly by ±1 or ±2 grid cells
    let movedCount = 0;
    for (let i = 0; i < walls.length; i++) {
        const wall = walls[i];
        if (!wall.destructible) continue;

        const shift = Math.floor(Math.random() * 5) - 2; // -2 to +2
        const shiftY = Math.floor(Math.random() * 5) - 2;
        const newX = wall.x + shift * GRID;
        const newY = wall.y + shiftY * GRID;

        // Clamp to map bounds
        const clampedX = Math.max(0, Math.min(MAP_W - GRID, newX));
        const clampedY = Math.max(0, Math.min(MAP_H - GRID, newY));

        wall.x = clampedX;
        wall.y = clampedY;
        movedCount++;
    }

    console.log(`Earthquake! Moved ${movedCount} walls.`);

    // Broadcast to all clients
    io.emit('earthquake', { walls });

    // Reschedule
    scheduleEarthquake();
}

// Start earthquake timer
scheduleEarthquake();
```

**Step 3: 驗證**

```bash
cd /Users/kk/tank-multiplayer && node -c server.js
```
Expected: 無輸出

**Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add earthquake timer and wall displacement system"
```

---

## Task 2: 修改死亡處理 — 50% 武器 / 50% 血量補給

**Objective:** 修改服務端死亡處理邏輯，50% 機率掉武器，50% 機率掉血量補給。

**Files:**
- Modify: `server.js` — 找到死亡處理中的武器掉落邏輯（約第 951-957 行）

**Step 1: 找到當前死亡掉落邏輯**

搜索 `// Drop a random weapon at death position`，找到以下代碼：
```js
                    // Drop a random weapon at death position
                    const dropType = SPECIAL_WEAPONS[Math.floor(Math.random() * SPECIAL_WEAPONS.length)];
                    weaponDrops.push({
                        x: p.x,
                        y: p.y,
                        type: dropType,
                        color: WEAPON_CONFIG[dropType].color,
                    });
```

**Step 2: 替換為 50/50 邏輯**

替換為：
```js
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
```

**Step 3: 驗證**

```bash
cd /Users/kk/tank-multiplayer && node -c server.js
```
Expected: 無輸出

**Step 4: Commit**

```bash
git add server.js
git commit -m "feat: 50/50 weapon or health drop on enemy death"
```

---

## Task 3: 拾取檢測支持血量補給

**Objective:** 在拾取檢測中，如果拾取到血量補給，增加玩家 HP 30（上限 100）。

**Files:**
- Modify: `server.js` — 找到拾取檢測邏輯（約第 1004-1022 行）

**Step 1: 找到拾取檢測代碼**

搜索 `player.weapon = drop.type;`，找到拾取檢測循環。

**Step 2: 在拾取檢測中（`player.weapon = drop.type;` 那一行）替換為血量/武器分支**

將：
```js
                if (dist < 25) {
                    // Pick up the weapon
                    player.weapon = drop.type;
                    weaponDrops.splice(di, 1);

                    // Notify client
                    const socket = io.sockets.sockets.get(pi);
                    if (socket) {
                        socket.emit('weaponPickup', { weapon: drop.type, name: WEAPON_NAMES[drop.type] });
                    }
                }
```
替換為：
```js
                if (dist < 25) {
                    weaponDrops.splice(di, 1);

                    if (drop.type === 'health') {
                        // Health pack: restore 30 HP (max 100)
                        player.hp = Math.min(100, player.hp + 30);

                        // Notify client
                        const socket = io.sockets.sockets.get(pi);
                        if (socket) {
                            socket.emit('weaponPickup', { weapon: 'health', name: '+30 HP' });
                        }
                    } else {
                        // Weapon: replace current weapon
                        player.weapon = drop.type;

                        // Notify client
                        const socket = io.sockets.sockets.get(pi);
                        if (socket) {
                            socket.emit('weaponPickup', { weapon: drop.type, name: WEAPON_NAMES[drop.type] });
                        }
                    }
                }
```

**Step 3: 驗證**

```bash
cd /Users/kk/tank-multiplayer && node -c server.js
```
Expected: 無輸出

**Step 4: Commit**

```bash
git add server.js
git commit -m "feat: support health pack pickup (+30 HP, max 100)"
```

---

## Task 4: 客戶端 — 地震視覺效果 + 血量補給渲染

**Objective:** 客戶端監聽地震事件顯示閃紅效果，並渲染血量補給（綠色十字）。

**Files:**
- Modify: `public/index.html`（添加地震閃紅 CSS）
- Modify: `public/client.js`（地震事件監聽 + 血量補給渲染）

**Step 1: 在 index.html 的 `<style>` 區域（第 147 行 `#toast.visible { opacity: 1; }` 之後）添加地震閃紅 CSS**

插入：
```css
        /* ── Earthquake flash ── */
        #earthquakeFlash {
            position: fixed; inset: 0;
            background: rgba(255, 0, 0, 0.3);
            z-index: 1500;
            pointer-events: none;
            opacity: 0;
        }
        #earthquakeFlash.active {
            animation: quakeFlash 0.3s ease-out forwards;
        }
        @keyframes quakeFlash {
            0% { opacity: 1; }
            100% { opacity: 0; }
        }
```

**Step 2: 在 index.html 的 `<body>` 中（第 150 行 `<body>` 之後）添加閃紅 div**

插入：
```html
    <!-- Earthquake flash overlay -->
    <div id="earthquakeFlash"></div>
```

**Step 3: 在 client.js 中添加地震事件監聽**

在第 256 行 `}, 2000);`（weaponPickup 監聽的 setTimeout 結束）之後插入：
```js
// Earthquake visual effect
socket.on('earthquake', () => {
    const flash = document.getElementById('earthquakeFlash');
    flash.classList.remove('active');
    void flash.offsetWidth; // force reflow
    flash.classList.add('active');
    setTimeout(() => flash.classList.remove('active'), 300);
});
```

**Step 4: 在 client.js 的掉落物渲染中（約第 360-378 行），修改為支持血量補給渲染**

將掉落物渲染代碼中的文字部分從：
```js
        const nameMap = { shotgun: '散弹枪', sniper: '狙击枪', freeze: '冰冻枪', accel: '加速弹' };
        ctx.fillText(nameMap[drop.type] || drop.type, drop.x, drop.y - 14);
```
替換為：
```js
        // Draw health cross or weapon name
        if (drop.type === 'health') {
            // Green cross in circle
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
```

**Step 5: 驗證**

```bash
cd /Users/kk/tank-multiplayer && node -c public/client.js
```
Expected: 無輸出

**Step 6: Commit**

```bash
git add public/index.html public/client.js
git commit -m "feat: earthquake flash effect and health pack rendering"
```

---

## Task 5: 粒子系統

**Objective:** 在客戶端添加爆炸粒子系統。

**Files:**
- Modify: `public/client.js`（添加 particles 數組 + 更新 + 渲染）

**Step 1: 添加 particles 數組**

在第 13 行 `let explosions = [];` 之後插入：
```js
let particles = [];
```

**Step 2: 在 gameState 監聽中，當 explosions 更新時生成粒子**

在第 218 行 `explosions = state.explosions;` 之後插入：
```js
    // Generate particles for new explosions
    const newExplosions = explosions.filter(ex => ex.life > 0.5);
    for (const ex of newExplosions) {
        for (let i = 0; i < 15; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 50 + Math.random() * 150;
            particles.push({
                x: ex.x,
                y: ex.y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 1.0,
                color: '#ff8800',
                size: 3 + Math.random() * 3,
            });
        }
    }
```

**Step 3: 在 draw() 中渲染粒子（在牆壁之後、爆炸之前，約第 319 行後）**

在第 319 行 `ctx.shadowBlur = 0;`（wall 渲染結束）之後插入：
```js
    // Particles
    particles.forEach(p => {
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.life;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    });
    ctx.globalAlpha = 1;
```

**Step 4: 在 gameLoop 中更新粒子（在 draw() 之前的遊戲循環中）**

在 `function gameLoop() {` 之前插入粒子更新函數：
```js
function updateParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx * DT;
        p.y += p.vy * DT;
        p.life -= DT * 2; // 0.5s lifetime
        if (p.life <= 0) {
            particles.splice(i, 1);
        }
    }
}
```

在 `function gameLoop() {` 內部，`draw();` 之前插入：
```js
    updateParticles();
```

**Step 5: 驗證**

```bash
cd /Users/kk/tank-multiplayer && node -c public/client.js
```
Expected: 無輸出

**Step 6: Commit**

```bash
git add public/client.js
git commit -m "feat: add explosion particle system"
```

---

## Task 6: 擊殺飄字系統

**Objective:** 在客戶端添加擊殺飄字系統。

**Files:**
- Modify: `public/client.js`（添加 floatingTexts 數組 + 更新 + 渲染）

**Step 1: 添加 floatingTexts 數組**

在第 14 行 `let particles = [];` 之後插入：
```js
let floatingTexts = [];
```

**Step 2: 在 gameState 監聽中檢測擊殺並生成飄字**

在第 226 行 `let aiCount = 0;` 之前插入：
```js
    // Detect kills and spawn floating text
    for (let id in state.players) {
        const newP = state.players[id];
        const oldP = players[id];
        if (oldP && oldP.hp > 0 && newP.hp <= 0 && newP.hp === 100) {
            // This player just died — spawn floating text for the killer
            const killerId = bullets.length > 0 ? null : null;
            // We'll spawn text at death position
            floatingTexts.push({
                x: newP.x,
                y: newP.y,
                text: '💀',
                life: 1.0,
                color: '#FF4444',
            });
        }
    }
```

更簡單的做法：直接在 gameState 監聽末尾，檢測所有玩家 HP 變化：

在第 223 行 `statusDiv.innerText = ...` 之前插入：
```js
    // Spawn floating text for player deaths
    for (let id in state.players) {
        const newP = state.players[id];
        const oldP = players[id];
        if (oldP && oldP.hp > 0 && newP.hp <= 0) {
            floatingTexts.push({
                x: newP.x,
                y: newP.y,
                text: '💀',
                life: 1.0,
                color: '#FF4444',
            });
        }
    }
```

**Step 3: 在 draw() 中渲染飄字（在玩家渲染之後，約第 373 行後）**

在第 373 行 `}`（玩家渲染循環結束）之後插入：
```js
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
```

**Step 4: 在 gameLoop 中更新飄字**

在 `updateParticles();` 之後插入：
```js
    // Update floating texts
    for (let i = floatingTexts.length - 1; i >= 0; i--) {
        const ft = floatingTexts[i];
        ft.life -= DT; // 1s lifetime
        if (ft.life <= 0) {
            floatingTexts.splice(i, 1);
        }
    }
```

**Step 5: 驗證**

```bash
cd /Users/kk/tank-multiplayer && node -c public/client.js
```
Expected: 無輸出

**Step 6: Commit**

```bash
git add public/client.js
git commit -m "feat: add kill floating text effect"
```

---

## Task 7: Web Audio 音效系統

**Objective:** 在客戶端添加 Web Audio 音效模塊。

**Files:**
- Modify: `public/client.js`（在文件末尾添加音效模塊）

**Step 1: 在 client.js 末尾（第 397 行 `gameLoop();` 之後）添加音效模塊**

插入：
```js
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
            filter.type = 'bandpass';
            filter.frequency.value = 800;
            filter.Q.value = 2;
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(200, now);
            osc.frequency.exponentialRampToValueAtTime(100, now + 0.05);
            gain.gain.setValueAtTime(0.3, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
            osc.connect(filter);
            filter.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start(now);
            osc.stop(now + 0.08);
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
            filter.type = 'bandpass';
            filter.frequency.value = 1200;
            filter.Q.value = 0.5;
            gain.gain.setValueAtTime(0.4, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
            noise.connect(filter);
            filter.connect(gain);
            gain.connect(audioCtx.destination);
            noise.start(now);
            noise.stop(now + 0.12);
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
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start(now);
            osc.stop(now + 0.25);
            break;
        }
        case 'fire-freeze': {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            const lfo = audioCtx.createOscillator();
            const lfoGain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.value = 200;
            lfo.frequency.value = 8;
            lfoGain.gain.value = 30;
            lfo.connect(lfoGain);
            lfoGain.connect(osc.frequency);
            gain.gain.setValueAtTime(0.25, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start(now);
            lfo.start(now);
            osc.stop(now + 0.12);
            lfo.stop(now + 0.12);
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
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start(now);
            osc.stop(now + 0.08);
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
            noise.connect(filter);
            filter.connect(gain);
            gain.connect(audioCtx.destination);
            noise.start(now);
            noise.stop(now + 0.3);
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
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start(now);
            osc.stop(now + 0.15);
            break;
        }
        case 'earthquake': {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sawtooth';
            osc.frequency.value = 50;
            gain.gain.setValueAtTime(0.3, now);
            gain.gain.setValueAtTime(0.3, now + 0.3);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start(now);
            osc.stop(now + 0.5);
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
```

**Step 2: 在 fire 事件觸發時播放音效**

在第 240 行 `socket.emit('fire');` 之後插入：
```js
        playSound('fire-' + (players[myId]?.weapon || 'basic'));
```

**Step 3: 在 gameState 監聽中爆炸時播放音效**

在第 218 行 `explosions = state.explosions;` 之後插入：
```js
    // Play explosion sound for new explosions
    if (explosions.length > 0) {
        playSound('explosion');
    }
```

**Step 4: 在 weaponPickup 監聽中播放拾取音效**

在第 253 行 `weaponPickupToast.textContent = '🎯 获得：' + data.name;` 之後插入：
```js
    playSound('pickup');
```

**Step 5: 在地震事件監聽中播放地震音效**

在第 264 行 `setTimeout(() => flash.classList.remove('active'), 300);` 之後插入：
```js
    playSound('earthquake');
```

**Step 6: 驗證**

```bash
cd /Users/kk/tank-multiplayer && node -c public/client.js
```
Expected: 無輸出

**Step 7: Commit**

```bash
git add public/client.js
git commit -m "feat: add Web Audio sound effects for all game events"
```

---

## Task 8: 最終驗證

**Objective:** 確保所有改動無語法錯誤，服務器能正常啟動。

**Step 1: 語法檢查**

```bash
cd /Users/kk/tank-multiplayer && node -c server.js && node -c public/client.js
```
Expected: 無輸出

**Step 2: 啟動測試**

```bash
cd /Users/kk/tank-multiplayer && timeout 5 node server.js || true
```
Expected: 輸出包含 "Server running at http://localhost:3000" 和 "Earthquake!" 相關信息

**Step 3: 提交**

```bash
git add -A
git commit -m "feat: complete game expansion — earthquake, audio, VFX, health packs"
```
