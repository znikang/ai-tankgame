# 設計規格：領土擴張系統 (Territorial Expansion System)
**Date:** 2026-06-08
**Status:** Approved

## 1. 功能概述
建立一個區域控制與佔領機制，允許玩家透過在特定地點（Capture Points, CPs）採取「駐守行為」來改變地圖的屬性。系統將衡量權力的平衡，從單純的互殺戰轉變為爭奪陣營主導權的策略對局。

## 2. 技術規格

### A. 資料結構 (Data Structures)
- **CapturePoint (CP)**:
  - `id`: string (Unique ID)
  - `x`, `y`: number (World coordinates)
  - `radius`: number (Interaction range)
  - `progress`: number (0.0 - 1.0, current ownership progress)
  - `ownerId`: string | null (ID of the player who currently owns the point)
  - `regionTag`: string (Identifier for geographical zone)

### B. 核心邏輯 (Core Logic)
|- **佔領機制 (Capture Mechanism)**:
  - **判定條件**：玩家坦克進入 CP 範圍並停止移動（速度 < 2 px/frame）。
  - **計時與驗證**：觸發後開始 5 秒倒數計時。若在 5 秒內的任何時刻有其他坦克進入該點位範圍，計時重設；若滿 5 秒且無其他人干預，則判定為佔領成功。
  - **轉權重點**：一旦驗證通過，控制權立即移交給目標玩家（無需進度條累積）。

### C. 網路同步與發放
- **Heartbeat Sync**：伺服器每秒維護一次所有 CP 的狀態並廣播給全體客戶端。
- **Real-time Updates**：當 `ownerId` 或區域顏色變動時，驅動一個全局事件告知前端繪製層更新地圖填色。

### D. 前端呈現
- **視覺 UI**：在點位上顯示圓形邊框與進度條。
- **地圖覆蓋 (Layer System)**：使用 Canvas 疊加層（Overlay Layer），根據區域權力自動刷出對應陣營的半透明顏色濾鏡。

## 3. 非功能性要求
- **權威伺服器**：所有 `progress` 的計時與判定必須在 servidor 端執行。
- **效能**：點位數據包需壓縮，避免頻繁的網路封包造成延遲。
