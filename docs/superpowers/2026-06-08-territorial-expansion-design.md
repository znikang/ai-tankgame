# 設計規格：領土擴張系統 (Territorial Expansion System)

**Date:** 2026-06-08
**Status:** Approved

## 1. 功能概述

建立一個區域控制與佔領機制，允許玩家和 AI 坦克透過在特定地點（Capture Points, CPs）採取「駐守行為」來改變地圖的視覺屬性。系統將衡量權力的平衡，從單純的互殺戰轉變為爭奪陣營主導權的策略對局。

## 2. 技術規格

### A. 資料結構 (Data Structures)

#### CapturePoint (CP)

```js
{
  id: string,           // 唯一 ID (cp-1 ~ cp-5)
  x: number,            // 世界座標 X
  y: number,            // 世界座標 Y
  radius: number,       // 交互範圍 (80px)
  ownerId: string|null, // 當前控制者玩家 ID，null = 無主
  regionTag: string,    // 地理區域標記 (corner-nw, corner-se, center 等)
  capturingPlayerId: string|null, // 正在佔領的玩家 ID，null = 未開始佔領
  captureStartTime: number|null   // 佔倒數開始時間戳 (Date.now())，null = 無倒數
}
```

#### 陣營顏色映射

陣營顏色由所有 CP 中佔領數量最多的 CP 的 `ownerId` 決定。每個玩家的坦克顏色來自其註冊時系統分配的顏色（或預設值）。無主 CP 的區域不顯示顏色。

### B. 地圖佈局

5 個 CP，經典十字佈局（1600×1200 地圖）：

| ID | X | Y | Radius | Region Tag |
|----|---|---|--------|------------|
| cp-1 | 200 | 200 | 80 | corner-nw |
| cp-2 | 1400 | 200 | 80 | corner-ne |
| cp-3 | 200 | 1000 | 80 | corner-sw |
| cp-4 | 1400 | 1000 | 80 | corner-se |
| cp-5 | 800 | 600 | 120 | center |

中心 CP 半徑較大（120px vs 80px），象徵其戰略價值。

### C. 核心邏輯 (Core Logic)

#### 佔領機制 (Capture Mechanism)

1. **判定條件**：玩家坦克進入 CP 範圍（距離 < CP.radius）且速度 < 2 px/frame。
2. **倒數計時**：
   - 若 CP 為無主狀態（`ownerId === null`）且當前無人在佔領（`capturingPlayerId === null`）：第一個符合條件的玩家開始佔領倒數（5 秒）。
   - 若同一玩家持續駐守：倒數繼續。
   - 若該玩家離開 CP 範圍或速度 >= 2 px/frame：倒數中斷，`capturingPlayerId` 和 `captureStartTime` 重置為 null。
3. **敵對介入**：
   - 若敵對玩家（非當前 `capturingPlayerId`）進入 CP 範圍：倒數立即重設，敵對玩家成為新的 `capturingPlayerId`。
   - 若原佔領者返回：倒數重設，原佔領者重新開始。
4. **佔領成功**：倒數滿 5 秒且無他人干預 → `ownerId` 設為當前 `capturingPlayerId`，`capturingPlayerId` 和 `captureStartTime` 重置為 null。
5. **AI 參與**：AI 坦克同樣適用以上規則，會駐守並佔領 CP。

#### 控制權丟失

- **玩家離線**：`ownerId` 立即重置為 null，其他玩家可以搶佔。
- **玩家重新登入**：和其他玩家一樣，需要重新佔領。

#### 陣營顏色計算

每次 `gameState` 廣播前，伺服器計算每個 CP 的陣營顏色：
- 若 `ownerId !== null`：取該玩家的坦克顏色
- 若 `ownerId === null`：無顏色（透明）

### D. 網路同步與發放

- **Heartbeat Sync**：伺服器 60fps `gameState` 廣播中包含所有 CP 的狀態（`ownerId`, `capturingPlayerId`, `captureProgress`）。
- **Real-time Updates**：當 `ownerId` 變動時（佔領成功），在 `gameState` 中標記 `territoryChanged: true`，客戶端檢測到此旗標後觸發地圖覆蓋層重繪。

### E. 前端呈現

#### CP 視覺元素

1. **無主 CP**：
   - 灰色虛線圓圈邊框
   - 中心顯示 "+" 符號

2. **佔領中的 CP**：
   - 實線圓圈邊框（顏色 = 佔領者坦克顏色）
   - 順時針圓形進度條（從 12 點方向開始填充）
   - 中心顯示佔領者頭像縮圖或首字母

3. **已佔領的 CP**：
   - 實線圓圈邊框（顏色 = 陣營顏色，較粗）
   - 中心顯示陣營標記（如旗幟圖標）

#### 地圖覆蓋層 (Territory Overlay)

- 在 Canvas 渲染循環中，於所有實體（牆壁、坦克、彈藥）之後繪製
- 以每個佔領的 CP 為圓心，繪製半透明色塊圓形（`globalAlpha: 0.15`）
- 色塊半徑 = CP.radius × 3（覆蓋範圍比 CP 本身大）
- 多個色塊疊加時顏色加深

### F. 伺服器端實現位置

所有邏輯在 `server.js` 的遊戲循環（60fps，`setInterval 16ms`）中實現：

1. 在現有玩家移動邏輯之後，新增 `updateCapturePoints()` 函數
2. 在 `gameState` 建構時加入 `capturePoints` 陣列
3. 佔領成功時檢查 `territoryChanged` 旗標

### G. 前端實現位置

所有繪製邏輯在 `public/client.js` 的渲染循環中實現：

1. 新增 `drawCapturePoints(ctx)` 函數
2. 新增 `drawTerritoryOverlay(ctx)` 函數
3. 在 `gameState` 收到時解析 `capturePoints` 數據

## 3. 非功能性要求

- **權威伺服器**：所有 `capturingPlayerId`、`captureStartTime` 的計時與判定必須在伺服器端執行。客戶端不執行任何佔領邏輯。
- **效能**：CP 狀態數據包極小（5 個點 × ~100 bytes），無需額外壓縮。
- **容錯**：客戶端斷線重連後，從 `gameState` 獲取最新 CP 狀態，無需特殊處理。
- **可擴展性**：CP 陣列為可配置，未來可透過配置檔或 Redis 動態調整位置和數量。

## 4. 不涵蓋的範圍 (Out of Scope)

- CP 控制權不影響遊戲數值（無射速加成、回血等）
- 不記錄 CP 控制歷史或統計
- 不支援自訂 CP 位置（硬編碼在遊戲中）
- 不支援陣營切換（一旦佔領 CP，顏色即固定）
