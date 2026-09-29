// 桌面版预加载脚本：只暴露两件事——「我在 Electron 里」和「把标题栏颜色切成这个主题」。
// 不开 nodeIntegration，contextIsolation 保持开启；页面拿不到任何 Node 能力。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wb', {
  desktop: true,
  titleBarTheme: (dark) => ipcRenderer.send('wb:titlebar-theme', dark ? 'dark' : 'light'),
  // 让系统把这篇笔记交给 Obsidian 打开；URI 由主进程拼，页面只能给路径片段
  openVault: (v) => ipcRenderer.invoke('wb:open-vault', v),
});
