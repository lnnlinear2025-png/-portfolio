# Folio

一个 Chrome 新标签页效率产品，把散落的标签页、收藏和待办收进同一张桌面。

## 功能

- **Tab 管理** — 按域名聚合当前打开的标签页，一键关闭重复 tab
- **Saved（Alt+S）** — 在任意网页按 Alt+S，当前页面存入 Saved 列表
- **Pin → Todo** — 右键保存的内容可 Pin 到 Todo，与日程以超链接互联
- **City Map** — 收藏常用网址，快速导航

## 安装

1. 打开 Chrome，地址栏输入 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择 `extension/` 文件夹

## 技术栈

Chrome Extension Manifest V3 · Service Worker · chrome.storage · Chrome Commands API

## 动机

每天看到好内容存进收藏夹，然后再不打开。  
Folio 的逻辑是：看到就存，存了就提醒，提醒了就行动。

---

Made with Vibe Coding · Figma → Claude Code → VS Code
