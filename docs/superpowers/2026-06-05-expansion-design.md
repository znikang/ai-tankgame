# 遊戲內容擴展設計

## 概述

為 tank-multiplayer 添加 4 個新內容：動態地震地圖、Web Audio 音效、視覺特效（粒子 + 飄字）、血量補給掉落。

---

## 1. 動態地圖 — 隨機地震

### 機制
- 每 30-90 秒隨機地震一次
- 地震效果：所有 destructible 牆壁隨機位移 1-2 格
- solid 牆壁不移位
- 地震時屏幕閃紅 0.3 秒作為視覺提示

### 實現
**服務端：**
- 新增 `setEarthquakeTimer()` 函數：隨機 30-90 秒後觸發地震
- 地震處理函數：遍歷 destructible 牆壁，隨機移動 ±1 或 ±2 格（40px 一格）
- 位移後檢查碰撞，如果牆壁移到玩家位置則移除該牆壁
- 地震後重新計時（隨機 30-90 秒）
- 向所有客戶端廣播 `earthquake` 事件

**客戶端：**
- 監聽 `earthquake` 事件
- 地震時屏幕閃紅（CSS 動畫 0.3 秒）
- 牆壁位置更新（gameState 已包含牆壁新位置）

**數據流：**
```
Server: random timer → earthquake() → move walls → io.emit('earthquake')
Client: listen 'earthquake' → flash screen red 0.3s
```

---

## 2. Web Audio 音效

### 音效列表
| 音效 | 觸發時機 | 合成方式 |
|------|---------|---------|
| 開火-基礎 | 基礎武器射擊 | 短促白噪聲脈衝（15ms，800Hz 帶通） |
| 開火-散彈 | 散彈槍射擊 | 寬頻噪聲 bursts（30ms，400-2000Hz） |
| 開火-狙擊 | 狙擊槍射擊 | 高頻掃頻（200ms，1000→4000Hz） |
| 開火-冰�� | 冰���槍射擊 | 低頻嗡鳴（100ms，200Hz 正弦 + 顫音） |
| 開火-加速 | 加速彈射擊 | 快速上升音調（80ms，600→2000Hz 鋸齒波） |
| 爆炸 | 炸牆/擊殺 | 寬頻噪聲 + 低頻衝擊（300ms，20-500Hz） |
| 拾取 | 撿到武器/血量 | 上升音調（150ms，400→800Hz 正弦） |
| 地震 | 地震觸發 | 低頻震動（500ms，30-80Hz 鋸齒波） |

### 實現
**客戶端：**
- 新增 `audio.js` 模塊（或內聯在 client.js 末尾）
- 使用 Web Audio API 的 `AudioContext` + `OscillatorNode` + `GainNode` + `BiquadFilterNode`
- 封裝 `playSound(name)` 函數，根據名稱選擇合成參數
- 每個音效的音量控制在 0.3-0.5 之間，避免過大
- 在對應事件觸發時調用 `playSound()`

**觸發點：**
- `fire` 事件 → `playSound('fire-' + weaponType)`
- 爆炸 → `playSound('explosion')`
- 拾取 → `playSound('pickup')`
- 地震 → `playSound('earthquake')`

---

## 3. 視覺特效

### 3A. 爆炸粒子系統

**機制：**
- 擊殺玩家或炸牆時，在爆炸位置生成 10-20 個小方塊
- 粒子向四周隨機飛散（隨機角度 + 隨機速度 50-200 px/s）
- 粒子逐漸縮小並淡出（0.5 秒內消失）
- 粒子顏色：橙色（擊殺）或棕色（炸牆）

**實現：**
**服務端：** 不需要服務端參與，所有粒子邏輯在客戶端。
**客戶端：**
- 新增 `particles = []` 數組
- 爆炸時（現有 explosions 邏輯旁）生成粒子：
  ```js
  for (let i = 0; i < 15; i++) {
    particles.push({
      x: ex.x, y: ex.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1.0,
      color: '#ff8800',
      size: 3 + Math.random() * 3,
    });
  }
  ```
- 在 gameLoop 中更新粒子位置 + 生命值
- 在 draw() 中渲染粒子（在爆炸之前）

### 3B. 擊殺飄字

**機制：**
- 擊殺敵人時，在死亡位置顯示 "+5" 或 "KILL!" 文字
- 文字向上移動（每秒 60px）
- 同時逐漸淡出（1.5 秒內消失）
- 文字顏色：金色（+5）或紅色（KILL!）

**實現：**
**服務端：** 不需要服務端參與，飄字邏輯在客戶端。
**客戶端：**
- 新增 `floatingTexts = []` 數組
- 擊殺時（gameState 監聽中檢測到 HP 變化）生成飄字：
  ```js
  floatingTexts.push({
    x: player.x, y: player.y,
    text: '+5',
    life: 1.0,
    color: '#FFD700',
  });
  ```
- 在 gameLoop 中更新飄字位置（y -= 60 * DT）和生命值
- 在 draw() 中渲染飄字（在玩家之上）

---

## 4. 血量補給掉落

### 機制
- 敵人死亡時：50% 機率掉武器，50% 機率掉血量補給
- 血量補給：+30 HP，綠色十字標識
- 拾取方式同武器（距離 < 25px 自動拾取）
- 拾取後血量補給消失，玩家 HP 增加 30（上限 100）

### 實現
**服務端：**
- 修改死亡處理邏輯（第 949-959 行附近）
- 將 `weaponDrops.push(...)` 替換為：
  ```js
  if (Math.random() < 0.5) {
    // Drop weapon
    const dropType = SPECIAL_WEAPONS[Math.floor(Math.random() * SPECIAL_WEAPONS.length)];
    weaponDrops.push({
      x: p.x, y: p.y,
      type: dropType,
      color: WEAPON_CONFIG[dropType].color,
    });
  } else {
    // Drop health pack
    weaponDrops.push({
      x: p.x, y: p.y,
      type: 'health',
      color: '#00FF00',
    });
  }
  ```
- 拾取檢測中，如果 `drop.type === 'health'`：
  - 計算 `player.hp = Math.min(100, player.hp + 30)`
  - 移除掉落物
  - 播放拾取音效
- 擴展 `WEAPON_NAMES` 和 `WEAPON_COLORS` 以支持 'health' 類型

**客戶端：**
- 血量補給渲染：綠色十字（在圓圈內畫 + 號）
- 拾取提示：顯示 "+30 HP" 而不是武器名稱

---

## 文件變更清單

### server.js
- 新增地震計時器邏輯（隨機 30-90 秒觸發）
- 新增地震處理函數（牆壁位移）
- 修改死亡處理：50% 武器 / 50% 血量補給
- 修改拾取檢測：支持血量補拾取
- 新增地震廣播事件
- 修改 gameState 廣播（已包含 weaponDrops）

### public/client.js
- 新增 Web Audio 音效模塊
- 新增粒子系統（渲染 + 更新）
- 新增擊殺飄字系統（渲染 + 更新）
- 修改爆炸邏輯：生成粒子
- 修改 gameState 監聽：檢測擊殺生成飄字
- 修改掉落物渲染：支持血量補給（綠色十字）
- 修改 weaponPickup 監聽：支持血量補給
- 新增地震視覺效果（屏幕閃紅）

### public/index.html
- 新增地震閃紅 CSS 動畫
- 可選：添加音效控制按鈕（靜音/取消靜音）

---

## YAGNI 檢查
- 不實現隊友協同 AI
- 不實現多張地圖切換
- 不實現技能系統
- 不實現 FFAs / 團隊模式
- 音效只合成，不載入外部文件
