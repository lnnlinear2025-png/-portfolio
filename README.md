# Folio

**把散落的标签页、收藏和待办，收进同一张桌面。**

每天在各个平台看到有价值的内容，存进收藏夹，然后再不打开。Folio 的逻辑是：看到就存，存了就提醒，提醒了就行动。一个 Chrome 新标签页，解决从"发现"到"完成"的完整链路。

---

## 功能

### Tab 管理
打开的标签页按域名自动聚合分组，同一个网站的所有 tab 归在一起，一键关闭重复标签页。再多的窗口也一目了然，不用逐个翻找。

### Saved — Alt+S 一键保存
在任意网页按下 `Alt+S`，当前页面立即存入 Saved 列表，无需打开插件、无需操作鼠标。通过 Chrome Commands API 在 Service Worker 层注册全局快捷键，任何页面都能触发，零摩擦收藏。

### Pin → Todo & Schedule 双向互链
右键 Saved 列表中的条目，可将其固定至 Todo 列表，同时在 Schedule 日历自动生成对应事项。Todo 与 Schedule 以超链接双向关联，点击任意一侧都能直接跳转原始页面。收藏的内容自动变成有时间节点的待办事项。

### City Map
以九宫格卡片形式收藏常用网址，配置一次，新标签页即是个人工作台。不再每次手动输入网址，常用工具触手可及。

---

## 安装

> 当前为开发者版本，需手动加载。

1. 点击右上角 **Code → Download ZIP**，下载并解压到本地
2. 打开 Chrome，地址栏输入 `chrome://extensions/`
3. 开启右上角 **开发者模式**
4. 点击 **加载已解压的扩展程序**，选择解压后的文件夹
5. 打开一个新标签页，即可看到 Folio

---

## 技术实现

| 模块 | 技术 |
|---|---|
| 扩展架构 | Chrome Extension Manifest V3 |
| 全局快捷键 | Chrome Commands API + Service Worker |
| 数据存储 | chrome.storage.sync（Pin/Todo 跨设备同步）· chrome.storage.local（Saved 列表） |
| 后台运行 | Service Worker（持久化监听快捷键事件） |
| 页面替换 | chrome_url_overrides 接管新标签页 |

---

## 设计理念

**收藏不是终点，行动才是。**

Folio 不试图替代所有生产力工具，只做一件事：让你在浏览器里看到的东西，真正进入你的工作流，而不是沉入收藏夹再也不见。

---

## 开发

工具链：Figma 产品设计 → Claude Code 辅助编码 → VS Code 调试

欢迎提 Issue 反馈问题或功能建议。
