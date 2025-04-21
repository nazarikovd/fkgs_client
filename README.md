# 🏗️

```javascript
let fkgs_client = require("fkgs_client.js");
let FC = new fkgsclient();

FC.connect();      // ██████████ 100% Подключено (надеемся, что сервер не сдох)

FC.initHistoryAndSub();  // 📜 Загружаем историю голосований (спойлер: в наличии есть уже благоустроенные)

FC.subscribe(console.log) // 📝 Подписочка (можно отправлять ивенты о новых голосах в реалтайм, но зачем?)

FC.currentData // Узнаем сколько голосов не хватает, а то еще демонтаж устроят
