# 武器系统 Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 为 tank-multiplayer 添加混合武器系统：基础武器 + 击杀掉落特殊武器，拾取即换，一次一把。

**Architecture:** 服务端权威计算（武器配置、射击冷却、冰冻效果、掉落生成、拾取检测），客户端渲染差异化（子弹颜色/大小、掉落物、UI 提示、冰冻视觉）。所有武器逻辑在服务端，客户端仅渲染。

**Tech Stack:** Node.js + Express + Socket.IO + Canvas 2D

---

## Task 1: 添加武器常量

**Objective:** 在 server.js 添加武器类型枚举和配置常量。

**Files:**
- Modify: `server.js:79-86` (after existing game constants)

**Step 1: 在 Game Constants 区域（第 86 行后）添加武器常量**

在 `const GRID = 40;` 之后（第 86 行），插入：

```js
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
```

**Step 2: 验证**

```bash
cd /Users/kk/tank-multiplayer && node -c server.js
```
Expected: 无输出（语法正确）

**Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add weapon system constants"
```

---

## Task 2: 扩展 Player 对象和 AI 对象

**Objective:** 为所有玩家对象添加 weapon、lastFire、frozenUntil 字段。

**Files:**
- Modify: `server.js:220-232` (AI spawn — 添加 weapon, lastFire, frozenUntil)
- Modify: `server.js:353-363` (human player spawn — 添加 weapon, lastFire)

**Step 1: AI 玩家扩展（第 220-232 行）**

将 AI 玩家对象从：
```js
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
```
改为：
```js
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
};
```

**Step 2: 人类玩家扩展（第 353-363 行）**

将人类玩家对象从：
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
    isMoving: false
};
```
改为：
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
};
```

**Step 3: 验证**

```bash
cd /Users/kk/tank-multiplayer && node -c server.js
```
Expected: 无输出

**Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add weapon fields to player objects"
```

---

## Task 3: 修改 fire 事件处理 — 按武器类型发射子弹

**Objective:** 替换 server.js 第 668-684 行的简单 fire 事件，改为按武器配置发射对应子弹。

**Files:**
- Modify: `server.js:668-684`

**Step 1: 替换 fire 事件处理**

将第 668-684 行整个替换为：

```js
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
        const baseAngle = p.angle;
        const spreadRad = (spread[1] - spread[0]) / (count - 1); // angle step in radians
        for (let i = 0; i < count; i++) {
            const angleDeg = spread[0] + spread[1] * (i / (count - 1));
            const angleRad = baseAngle + (angleDeg * Math.PI / 180);
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
```

**Step 2: 验证**

```bash
cd /Users/kk/tank-multiplayer && node -c server.js
```
Expected: 无输出

**Step 3: Commit**

```bash
git add server.js
git commit -m "feat: weapon-based fire handling with cooldown and spread"
```

---

## Task 4: 修改 AI 射击逻辑 — 按武器类型射击

**Objective:** 替换 aiFire 函数（第 726-740 行），让 AI 按自己的武器类型射击。

**Files:**
- Modify: `server.js:726-740`

**Step 1: 替换 aiFire 函数**

将第 726-740 行整个替换为：

```js
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
                const angleDeg = spread[0] + spread[1] * (i / (count - 1));
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
```

**Step 2: 验证**

```bash
cd /Users/kk/tank-multiplayer && node -c server.js
```
Expected: 无输出

**Step 3: Commit**

```bash
git add server.js
git commit -m "feat: AI fires with weapon-based bullets"
```

---

## Task 5: 修改子弹运动逻辑 — 使用武器速度

**Objective:** 将游戏循环中子弹运动（第 800-801 行）从固定 BULLET_SPEED 改为使用子弹自身的 speed 属性。

**Files:**
- Modify: `server.js:798-806`

**Step 1: 替换子弹运动代码**

将第 798-801 行从：
```js
b.x += Math.cos(b.angle) * BULLET_SPEED * DT;
b.y += Math.sin(b.angle) * BULLET_SPEED * DT;
```
改为：
```js
b.x += Math.cos(b.angle) * b.speed * DT;
b.y += Math.sin(b.angle) * b.speed * DT;
```

**Step 2: 验证**

```bash
cd /Users/kk/tank-multiplayer && node -c server.js
```
Expected: 无输出

**Step 3: Commit**

```bash
git add server.js
git commit -m "feat: bullets use per-weapon speed"
```

---

## Task 6: 修改玩家碰撞伤害 — 使用子弹伤害值

**Objective:** 将碰撞伤害从硬编码 35 改为使用 b.damage。

**Files:**
- Modify: `server.js:831-832`

**Step 1: 替换伤害代码**

将第 832 行从：
```js
p.hp -= 35;
```
改为：
```js
p.hp -= b.damage;
```

**Step 2: 验证**

```bash
cd /Users/kk/tank-multiplayer && node -c server.js
```
Expected: 无输出

**Step 3: Commit**

```bash
git add server.js
git commit -m "feat: bullet damage from weapon config"
```

---

## Task 7: 添加冰冻效果应用

**Objective:** 在子弹碰撞检测中，如果子弹有冰冻属性，给目标设置 frozenUntil。

**Files:**
- Modify: `server.js:827-875` (player collision section)

**Step 1: 在碰撞检测中（第 831 行后）添加冰冻逻辑**

在第 831 行 `if (dist < 20) {` 之后，第 832 行 `p.hp -= b.damage;` 之前，插入：

```js
// Apply freeze effect
if (b.isFreeze && !p.isAI === false || (b.isFreeze && p.isAI)) {
    p.frozenUntil = now || Date.now();
    // Store for later use — we need to capture now
}
```

实际上更简洁的做法是：在碰撞检测块内（第 831 行 `if (dist < 20)` 内部），在 `p.hp -= b.damage;` 之后插入：

```js
if (b.isFreeze && p.isAI) {
    p.frozenUntil = Date.now() + 2000;
}
```

完整插入位置：在 `explosions.push({ x: b.x, y: b.y, life: 1.0 });` 和 `bullets.splice(i, 1);` 之间。

即第 833 行后插入：
```js
if (b.isFreeze && p.isAI) {
    p.frozenUntil = Date.now() + 2000;
}
```

**Step 2: 验证**

```bash
cd /Users/kk/tank-multiplayer && node -c server.js
```
Expected: 无输出

**Step 3: Commit**

```bash
git add server.js
git commit -m "feat: apply freeze effect on bullet hit"
```

---

## Task 8: AI 移动加入冰冻减速

**Objective:** 在 AI 移动逻辑中检查 frozenUntil，减速时应用 0.5 倍速度。

**Files:**
- Modify: `server.js:742-794` (game loop AI movement section)

**Step 1: 在 AI 移动逻辑开始时添加冰冻检查**

在第 749 行 `if (p.isAI) {` 之后，第 750 行之前，插入：

```js
// Check freeze status
const isFrozen = Date.now() < p.frozenUntil;
const speedMult = isFrozen ? 0.5 : 1;
```

**Step 2: 将所有 moveTank 调用改为使用 speedMult**

将第 759 行 `moveTank(p, p.angle, 1);` 改为 `moveTank(p, p.angle, speedMult);`
将第 765 行 `moveTank(p, strafeAngle, 0.7);` 改为 `moveTank(p, strafeAngle, 0.7 * speedMult);`
将第 771 行 `moveTank(p, backAngle, 1);` 改为 `moveTank(p, backAngle, speedMult);`

**Step 3: 验证**

```bash
cd /Users/kk/tank-multiplayer && node -c server.js
```
Expected: 无输出

**Step 4: Commit**

```bash
git add server.js
git commit -m "feat: AI movement slowed when frozen"
```

---

## Task 9: 敌人死亡时掉落武器

**Objective:** 在玩家死亡重生逻辑中（第 839-873 行），添加武器掉落生成。

**Files:**
- Modify: `server.js:839-873` (death handling section)

**Step 1: 在死亡处理中（第 839 行 `if (p.hp <= 0)` 内部，在 `p.hp = 100;` 之前）添加掉落逻辑**

在第 839 行 `if (p.hp <= 0) {` 之后，第 840 行 `p.hp = 100;` 之前，插入：

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

**Step 2: 验证**

```bash
cd /Users/kk/tank-multiplayer && node -c server.js
```
Expected: 无输出

**Step 3: Commit**

```bash
git add server.js
git commit -m "feat: drop random weapon on enemy death"
```

---

## Task 10: 添加拾取检测逻辑

**Objective:** 在游戏循环末尾（爆炸逻辑之后、广播之前）添加武器拾取检测。

**Files:**
- Modify: `server.js:879-897` (after explosion logic, before gameState emit)

**Step 1: 在爆炸逻辑之后（第 883 行后）、广播之前（第 885 行前）插入拾取检测**

在第 883 行 `}` 之后插入：

```js
// Weapon pickup detection
const now = Date.now();
for (let pi in players) {
    const player = players[pi];
    if (!player || player.hp <= 0) continue;

    for (let di = weaponDrops.length - 1; di >= 0; di--) {
        const drop = weaponDrops[di];
        const dist = Math.sqrt((player.x - drop.x) ** 2 + (player.y - drop.y) ** 2);
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
    }
}
```

**Step 2: 修改 gameState 广播（第 897 行）**

将第 897 行从：
```js
io.emit('gameState', { players, bullets, walls, explosions, auth: authInfo });
```
改为：
```js
io.emit('gameState', { players, bullets, walls, explosions, weaponDrops, auth: authInfo });
```

**Step 3: 验证**

```bash
cd /Users/kk/tank-multiplayer && node -c server.js
```
Expected: 无输出

**Step 4: Commit**

```bash
git add server.js
git commit -m "feat: weapon pickup detection and gameState broadcast"
```

---

## Task 11: 客户端 — 渲染武器掉落物

**Objective:** 在 client.js 的 draw() 函数中添加武器掉落物渲染（子弹渲染之后，爆炸之前）。

**Files:**
- Modify: `public/client.js:11` (添加 weaponDrops 变量)
- Modify: `public/client.js:214-224` (gameState 监听中解析 weaponDrops)
- Modify: `public/client.js:320-329` (子弹渲染之后添加掉落物渲染)

**Step 1: 添加 weaponDrops 变量（第 11 行 bullets 后）**

将第 11 行 `let bullets = [];` 后插入新行：
```js
let weaponDrops = [];
```

完整变量块变为：
```js
let players = {};
let bullets = [];
let weaponDrops = [];
let walls = [];
let explosions = [];
```

**Step 2: 在 gameState 监听中解析 weaponDrops（第 214-224 行）**

将第 214-218 行从：
```js
socket.on('gameState', (state) => {
    players = state.players;
    bullets = state.bullets;
    walls = state.walls;
    explosions = state.explosions;
```
改为：
```js
socket.on('gameState', (state) => {
    players = state.players;
    bullets = state.bullets;
    walls = state.walls;
    explosions = state.explosions;
    weaponDrops = state.weaponDrops || [];
```

**Step 3: 在 draw() 中添加掉落物渲染**

在第 329 行 `ctx.shadowBlur = 0;`（子弹渲染结束）之后、第 331 行 `// Explosions` 之前，插入：

```js
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

        // Weapon name text
        ctx.fillStyle = '#fff';
        ctx.font = '9px monospace';
        ctx.textAlign = 'center';
        const nameMap = { shotgun: '散弹枪', sniper: '狙击枪', freeze: '冰冻枪', accel: '加速弹' };
        ctx.fillText(nameMap[drop.type] || drop.type, drop.x, drop.y - 14);
        ctx.textAlign = 'start';
    });
```

**Step 4: 验证**

```bash
cd /Users/kk/tank-multiplayer && node -c public/client.js
```
Expected: 无输出

**Step 5: Commit**

```bash
git add public/client.js
git commit -m "feat: render weapon drops on ground"
```

---

## Task 12: 客户端 — 子弹按武器类型差异化渲染

**Objective:** 将 client.js 中统一的黄色子弹渲染改为按武器类型使用不同颜色和大小。

**Files:**
- Modify: `public/client.js:320-329`

**Step 1: 替换子弹渲染代码**

将第 320-328 行从：
```js
    // Bullets
    ctx.shadowBlur = 15;
    ctx.shadowColor = 'yellow';
    ctx.fillStyle = '#ffff00';
    bullets.forEach(b => {
        ctx.beginPath();
        ctx.arc(b.x, b.y, 4, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.shadowBlur = 0;
```
改为：
```js
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
```

**Step 2: 验证**

```bash
cd /Users/kk/tank-multiplayer && node -c public/client.js
```
Expected: 无输出

**Step 3: Commit**

```bash
git add public/client.js
git commit -m "feat: bullets rendered with weapon-specific color and size"
```

---

## Task 13: 客户端 — 冰冻效果视觉

**Objective:** 在玩家渲染中，如果玩家被冰冻，绘制蓝色半透明覆盖层。

**Files:**
- Modify: `public/client.js:340-373`（玩家渲染循环）

**Step 1: 在玩家渲染中（第 360 行 `ctx.restore();` 之后、HP Bar 之前）添加冰冻效果**

在第 360 行 `ctx.restore();` 之后插入：

```js
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
```

**Step 2: 验证**

```bash
cd /Users/kk/tank-multiplayer && node -c public/client.js
```
Expected: 无输出

**Step 3: Commit**

```bash
git add public/client.js
git commit -m "feat: freeze visual effect on frozen players"
```

---

## Task 14: 客户端 — 添加武器 UI（左下角 + 拾取提示）

**Objective:** 在 index.html 中添加武器 UI 元素，在 client.js 中添加武器显示和拾取提示逻辑。

**Files:**
- Modify: `public/index.html`（添加 CSS 和 HTML 元素）
- Modify: `public/client.js`（添加武器 UI 逻辑和 weaponPickup 监听）

**Step 1: 在 index.html 的 `<style>` 区域（第 147 行 `#toast.visible { opacity: 1; }` 之后）添加 CSS**

插入：
```css
        /* ── Weapon HUD ── */
        #weaponHUD {
            position: fixed; bottom: 20px; left: 20px;
            background: rgba(10, 10, 12, 0.85);
            padding: 10px 16px; border-radius: 6px;
            border: 1px solid #333; z-index: 500;
            font-size: 14px; color: #fff;
            display: flex; align-items: center; gap: 8px;
        }
        #weaponHUD .weapon-icon {
            width: 16px; height: 16px; border-radius: 50%;
            display: inline-block;
        }
        #weaponPickupToast {
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: rgba(10, 10, 12, 0.9);
            padding: 14px 28px; border-radius: 8px;
            border: 1px solid #00aa00; color: #fff;
            font-size: 18px; font-weight: 600;
            z-index: 2000; opacity: 0; transition: opacity 0.3s;
            pointer-events: none;
        }
        #weaponPickupToast.visible { opacity: 1; }
```

**Step 2: 在 index.html 的 `<body>` 中（第 151 行 `<div id="status">` 之前）添加 HTML 元素**

在第 150 行 `<body>` 之后插入：
```html
    <!-- Weapon HUD -->
    <div id="weaponHUD">
        <span class="weapon-icon" id="weaponIcon"></span>
        <span id="weaponName">基础武器</span>
    </div>
    <!-- Weapon pickup toast -->
    <div id="weaponPickupToast"></div>
```

**Step 3: 在 client.js 中添加 DOM 引用和逻辑**

在第 34 行 `const toast = document.getElementById('toast');` 之后插入：
```js
const weaponHUD       = document.getElementById('weaponHUD');
const weaponIcon      = document.getElementById('weaponIcon');
const weaponName      = document.getElementById('weaponName');
const weaponPickupToast = document.getElementById('weaponPickupToast');
```

**Step 4: 在 client.js 中添加武器名称映射和 weaponPickup 监听**

在第 228 行 `socket.on('playerLeft', ...)` 之后插入：

```js
const WEAPON_NAMES = { basic: '基础武器', shotgun: '散弹枪', sniper: '狙击枪', freeze: '冰冻枪', accel: '加速弹' };
const WEAPON_COLORS = { basic: '#FFFF00', shotgun: '#FF8800', sniper: '#FF0000', freeze: '#00FFFF', accel: '#00FF00' };

function updateWeaponUI(weaponType) {
    weaponName.textContent = WEAPON_NAMES[weaponType] || weaponType;
    weaponIcon.style.backgroundColor = WEAPON_COLORS[weaponType] || '#fff';
}

socket.on('weaponPickup', (data) => {
    updateWeaponUI(data.weapon);
    weaponPickupToast.textContent = '🎯 获得：' + data.name;
    weaponPickupToast.classList.add('visible');
    clearTimeout(weaponPickupToast._timer);
    weaponPickupToast._timer = setTimeout(() => {
        weaponPickupToast.classList.remove('visible');
    }, 2000);
});
```

**Step 5: 在 gameState 监听中更新武器 UI**

在第 218 行 `weaponDrops = state.weaponDrops || [];` 之后插入：

```js
    // Update weapon UI for my player
    if (myId && players[myId]) {
        updateWeaponUI(players[myId].weapon || 'basic');
    }
```

**Step 6: 验证**

```bash
cd /Users/kk/tank-multiplayer && node -c public/client.js
```
Expected: 无输出

**Step 7: Commit**

```bash
git add public/index.html public/client.js
git commit -m "feat: weapon HUD and pickup notification UI"
```

---

## Task 15: 最终验证

**Objective:** 确保服务器能正常启动，所有改动无语法错误。

**Step 1: 语法检查**

```bash
cd /Users/kk/tank-multiplayer && node -c server.js && node -c public/client.js
```
Expected: 无输出

**Step 2: 启动服务器测试**

```bash
cd /Users/kk/tank-multiplayer && timeout 5 node server.js || true
```
Expected: 输出包含 "Server running at http://localhost:3000" 和 "Map generated: ..." 和 "Spawned 3 AI tanks"

**Step 3: 提交**

```bash
git add -A
git commit -m "feat: complete weapon system — drops, pickup, 5 weapon types, freeze, UI"
```
