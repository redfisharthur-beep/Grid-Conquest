# Grid Conquest

2–3 人即時數學搶地盤對戰。

## 技術
- Cloudflare Worker
- Durable Objects
- 原生 HTML / CSS / JavaScript
- 不使用前端框架

## 遊戲規則
- 3×3 棋盤
- 共 5 回合
- 每回合 60 秒
- 簡答題，輸入整數答案
- 答對後可佔領空格或對手未鎖定格
- 答錯該回合不能佔領
- 形成直、橫、斜二連線時，可吃掉該線上的對手格
- 上下左右形成包圍時，可吃掉被包圍格
- 中央 2 分，其餘 1 分
- 牧師擁有中央格時，中央改計 5 分

## 題目難度
- 基本：20 以內加減
- 進階：正整數四則運算
- 挑戰：-20～20 範圍四則運算，答案維持 -20～20

## 職業
- 戰士：前 2 次答對所佔領的格子鎖定
- 法師：連線吃掉對手格時，再隨機多佔領 1 格
- 弓手：第 3 次答對可一次佔領 2 格
- 牧師：中央格計 5 分

## 自製圖檔
把圖檔放進 `public/assets/` 後即可替換目前的文字預留區。建議檔名：
- home.png
- fight.png
- warrior.png
- mage.png
- archer.png
- priest.png

目前刻意不綁定圖片，方便後續直接換成自製素材。

## 本機
```bash
npm install
npm run dev
```

## Cloudflare
```bash
npm run deploy
```

第一次部署會建立 `GameHub` Durable Object migration。
