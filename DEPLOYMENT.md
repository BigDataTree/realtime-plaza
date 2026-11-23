# 即時方塊廣場 v2 — 專用即時服務

本版是待部署的 Node.js WebSocket 服務，不是目前正式網站。維持 960×600、28px 方塊、210px/s、80 人上限。每秒廣播 20 次，位置保存在單一服務實例的記憶體；移動不查資料庫。

## 部署

使用單一 Node.js 22+ 實例，安裝依賴後執行 npm start，並設定：

- PLAZA_SHARED_SECRET：至少 32 字元的隨機高熵密鑰，只存於網站與服務的環境變數，不放進 Git 或瀏覽器。
- CLASSROOM_ORIGIN：https://ultimate-code-classroom.bigdatatree.chatgpt.site
- PORT：由主機提供。

健康檢查 GET /health。WebSocket 路徑 /plaza。正式部署必須使用 HTTPS/WSS。

## 教學網站整合契約（待接入）

1. 同源票券端點沿用 gameVisitor、requireExamGameAccess、requireGameEnabled，驗證 Google 帳號、考試鎖、開放狀態。使用 HMAC-SHA256 簽發票券：base64url(JSON({sub,exp,jti}))+'.'+base64url(HMAC(secret,前一段))。sub 使用伺服器端產生的不可逆帳號代碼；exp 為毫秒時間，期限不超過 20 秒，jti 隨機且單次使用。
2. 瀏覽器透過 WSS 連線，第一個訊息發送 {type:'auth',ticket}。每 10 秒向網站重新申請票券並發送 auth 以更新存活期限；權限撤回即停止。不要將 Google 信箱或原始 Google token 傳給即時服務。
3. 按鍵改變立即送 {type:'input',dx,dy,seq}；每 250ms 重送當前方向並增加 seq，失焦送零方向。伺服器在輸入停止 1 秒後自動停止移動。
4. welcome 回傳 id 等繪製參數；state 的 players 是 [id,x,y,colorSlot,dx,dy,seq]。使用本地預測與遠端插值，維持 60 FPS 畫面；離開廣場關閉 socket。
5. 使用 ping/pong 測量 RTT。正式上架前以不同實際帳號與學校網路驗證，再逐步切換。

此目錄未含真實密鑰或正式網域以外的帳號資訊。單一實例部署是刻意設計，不應直接放大成多個彼此不共享狀態的實例。

本地測試：npm install && npm test。
