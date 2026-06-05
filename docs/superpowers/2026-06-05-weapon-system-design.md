# 武器系统设计

## 概述

为 tank-multiplayer 项目添加混合武器系统：基础单发武器 + 击杀敌人后随机掉落的特殊武器。玩家通过走近拾取（距离 < 25px）获得武器，一次只能装备一把。

## 核心机制

### 掉落机制
- 敌人死亡时，在死亡位置生成一个武器掉落物
- 4 种特殊武器等概率随机掉落（各 25%）
- 地面掉落物无上限
- 掉落物视觉：彩色圆圈 + 武器名称文字

### 拾取机制
- 玩家走近掉落物（距离 < 25px）自动拾取
- 拾取后替换当前武器
- 拾取后地上掉落物立即消失
- 死亡后重置为基本武器

### UI
- 左下角显示当前装备的武器名称
- 拾取时屏幕中央弹出提示文字（持续 2 秒）

## 武器列表

| 武器 | 单发伤害 | 射速 | 弹道 | 特殊效果 |
|------|---------|------|------|---------|
| 基础武器 | 35 | 0.4秒 | 直线 | 无 |
| 散弹枪 | 20 × 5发 | 0.8秒 | 扇形 spread（-30°~+30°） | 近距离爆发 |
| 狙击枪 | 50 | 0.8秒 | 直线 | 高伤害远距离 |
| 冰冻枪 | 10 | 0.4秒 | 直线 | 减速敌人移动 50% 持续 2 秒 |
| 加速弹 | 15 | 0.4秒 | 直线 | 子弹速度翻倍（450→900 px/s） |

## 架构设计

### 服务端

#### 新增常量
```js
const WEAPON_TYPES = ['basic', 'shotgun', 'sniper', 'freeze', 'accel'];

const WEAPON_CONFIG = {
  basic:    { damage: 35, fireRate: 400, bulletSpeed: 450, color: '#FFFF00' },
  shotgun:  { damage: 20, fireRate: 800, bulletSpeed: 400, color: '#FF8800', count: 5, spread: [-30, 30] },
  sniper:   { damage: 50, fireRate: 800, bulletSpeed: 500, color: '#FF0000' },
  freeze:   { damage: 10, fireRate: 400, bulletSpeed: 450, color: '#00FFFF', freeze: true },
  accel:    { damage: 15, fireRate: 400, bulletSpeed: 900, color: '#00FF00', accelerated: true },
};
```

#### Player 对象扩展
```js
{
  // 现有字段...
  weapon: 'basic',        // 当前武器类型
  lastFire: 0,            // 上次射击时间戳（毫秒）
}
```

#### 武器掉落物对象
```js
{
  x: enemy.x,             // 敌人死亡位置
  y: enemy.y,
  type: 'shotgun',        // 武器类型
  color: '#FF8800',       // 按武器类型着色
}
```

#### 子弹对象扩展
```js
{
  // 现有字段...
  damage: 20,             // 按武器配置设置
  speed: 400,             // 按武器配置设置
  isFreeze: false,        // 冰冻属性
  isAccelerated: false,   // 加速属性
  count: 1,               // 散弹枪为 5
  spread: [-30, 30],      // 散弹扇形范围（度）
}
```

#### AI 状态扩展
```js
{
  // 现有字段...
  frozenUntil: 0,         // 冰冻解除时间戳（毫秒）
}
```

#### 关键逻辑变更

**1. 射击逻辑（fire 事件处理）**
- 检查 `Date.now() - player.lastFire >= WEAPON_CONFIG[player.weapon].fireRate`
- 根据武器类型创建对应子弹（散弹枪创建多颗）
- 更新 `player.lastFire`

**2. 子弹创建（散弹枪特殊处理）**
- 遍历 spread 角度范围，均匀发射 count 颗子弹
- 每颗子弹携带独立的 damage、speed、isFreeze、isAccelerated

**3. 冰冻效果应用**
- 子弹命中玩家时，设置 `player.frozenUntil = Date.now() + 2000`
- AI 移动逻辑中检查：`if (Date.now() < ai.frozenUntil) effectiveSpeed *= 0.5`

**4. 敌人死亡掉落**
- 在 `killPlayer` 或死亡处理逻辑中：
  ```js
  const randomWeapon = WEAPON_TYPES[1 + Math.floor(Math.random() * 4)]; // 排除 basic
  weaponDrops.push({
    x: player.x,
    y: player.y,
    type: randomWeapon,
    color: WEAPON_CONFIG[randomWeapon].color,
  });
  ```

**5. 拾取检测**
- 游戏循环中每帧检测玩家与所有掉落物的距离
- `distance(player, drop) < 25` 时触发拾取
- 设置 `player.weapon = drop.type`
- 从 `weaponDrops` 数组移除该掉落物
- 向客户端广播武器切换事件

### 客户端

#### 新增渲染
1. **武器掉落物** — 彩色圆圈（半径 8）+ 武器名称文字
2. **子弹差异化** — 按武器类型改变子弹颜色和大小
3. **冰冻效果** — 被减速的 AI 显示蓝色半透明覆盖层
4. **左下角武器 UI** — 显示当前武器名称
5. **拾取提示** — 屏幕中央弹出 2 秒提示文字

#### Socket.IO 事件
- 现有 `fire` 事件不变
- 新增 `weaponPickup` 事件（Server → Client）：`{ weapon: 'shotgun' }`
- `gameState` 广播中增加 `weaponDrops` 数组

#### 状态广播扩展
```js
io.emit('gameState', {
  players,
  bullets,
  walls,
  explosions,
  weaponDrops,       // 新增
  auth: authInfo,
});
```

## 数据流

```
Client: fire event → Server: 检查射速 → 创建子弹 → 发射
Client: gameState → 渲染武器状态 + 掉落物
Server: 碰撞检测 → 冰冻/加速效果应用
Server: 敌人死亡 → 随机生成掉落物 → io.emit 广播
Server: 拾取检测 → 更新玩家武器 → 广播 weaponPickup
```

## 文件变更清单

### server.js
- 添加 WEAPON_TYPES 和 WEAPON_CONFIG 常量
- 扩展 Player 对象（weapon, lastFire）
- 添加 weaponDrops 全局数组
- 修改 fire 事件处理（按武器类型发射）
- 修改子弹创建逻辑（支持散弹、冰冻、加速）
- 添加冰冻效果应用逻辑
- 添加敌人死亡时掉落武器逻辑
- 添加拾取检测逻辑
- 扩展 gameState 广播（增加 weaponDrops）
- AI 移动逻辑增加冰冻减速检查

### public/client.js
- 添加武器掉落物渲染
- 修改子弹渲染（按武器类型差异化）
- 添加冰冻效果视觉
- 添加左下角武器 UI
- 添加拾取提示系统
- 监听 weaponPickup 事件
- gameState 中处理 weaponDrops

### public/index.html
- 添加武器 UI 元素（左下角显示 + 拾取提示）

## YAGNI 检查

- 不实现弹药系统（玩家无限弹药）
- 不实现武器升级/合成
- 不实现背包系统（一次只带一把）
- 不实现武器切换键（捡起即换）
- 不实现追踪导弹
