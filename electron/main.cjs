// Electron 主进程：内嵌 server.js（纯 node:http，零依赖），窗口加载本地服务。
// 数据目录：开发态用项目 data/；打包后用 %APPDATA%/创作工作台/data（见下方 setPath——
// v1.x 的 productName 叫「创作工作台」，改名「拍案」后显式钉回旧目录，老用户数据无缝延续）。
const { app, BrowserWindow, Menu, shell, dialog, Tray, nativeImage, ipcMain, clipboard } = require('electron');
const path = require('node:path');
const net = require('node:net');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const BOOT_AT = Date.now(); // 启动计时起点：冒烟摘要里带「启动 Xms」，慢了看得见

// 数据目录兼容：Electron 默认把 userData 放在 %APPDATA%/<productName>，改名会带着数据一起搬家。
// 这里在 ready 之前钉回旧名，保证从「创作工作台」升级上来的用户看不到任何数据丢失。
if (app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), '创作工作台'));
}

const DEV = !app.isPackaged;

// GPU 兼容开关：个别环境（虚拟显卡 / 远程桌面 / 旧驱动）硬件加速会导致白屏或闪退。
// 触发方式（任选其一）：命令行加 --disable-gpu；或设环境变量 WB_DISABLE_GPU=1。
// 必须在 app ready 之前调用才生效。
const gpuOff =
  process.env.WB_DISABLE_GPU === '1' ||
  app.commandLine.hasSwitch('disable-gpu') ||
  app.commandLine.hasSwitch('disable-hardware-acceleration');
if (gpuOff) app.disableHardwareAcceleration();

// 自检模式：electron . --smoke-test。窗口不可见，加载页面后确认渲染进程已挂载、
// 数据 API 连通即退出（0=通过 / 1=失败）。供自动化回归与打包产物冒烟使用。
const SMOKE = process.argv.includes('--smoke-test');
if (SMOKE) app.disableHardwareAcceleration();

// —— 托盘与关闭保护 ——
// 用户点窗口右上角 X 时，默认「最小化到系统托盘」而不是退出：写作工作台是长驻工具，
// 误关会中断会话、让人以为数据丢了（实际有自动保存）。真正退出走托盘右键菜单。
// 关闭保护在自检模式下不启用（自检需要干净退出路径）。
let isQuitting = false; // 显式退出（托盘菜单/崩溃恢复选关闭/系统关机）时放行窗口关闭
let tray = null;

function trayIcon() {
  // 打包后 build/icon.ico 会随 files 进入 asar；开发态在项目根 build/ 下
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');
  try {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) return img;
  } catch {
    // 继续走空图标兜底
  }
  return nativeImage.createEmpty();
}

function setupTray(win, dataDir) {
  if (SMOKE || process.platform !== 'win32' || tray) return;
  const today = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const todayWords = () => {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dataDir, 'stats.json'), 'utf-8'));
      return s.daily?.[today()] ?? 0;
    } catch {
      return 0;
    }
  };
  try {
    tray = new Tray(trayIcon());
    // 唤回主窗口：托盘菜单与单击图标共用（上一版重写时把定义弄丢，菜单一构建就 ReferenceError → 托盘整体失效）
    const showMain = () => {
      if (win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    };
    const rebuild = () => {
      if (!tray) return;
      tray.setToolTip(`拍案 · 今日 ${todayWords()} 字`);
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: `今日已写 ${todayWords()} 字`, enabled: false },
          { type: 'separator' },
          { label: '打开拍案', click: showMain },
          { label: '隐藏窗口', click: () => win.hide() },
          { type: 'separator' },
          { label: '打开数据文件夹', click: () => shell.openPath(dataDir) },
          {
            label: '兼容模式重启（关闭硬件加速）',
            click: () => {
              app.relaunch({ args: process.argv.slice(1).concat(['--disable-gpu']) });
              isQuitting = true;
              app.exit(0);
            },
          },
          { type: 'separator' },
          {
            label: '退出',
            click: () => {
              isQuitting = true;
              app.quit();
            },
          },
        ]),
      );
    };
    rebuild();
    setInterval(rebuild, 60 * 1000); // 今日字数边写边涨，菜单一分钟刷一次
    tray.on('click', showMain); // Windows 下单击托盘图标也能唤回
  } catch {
    tray = null; // 个别环境（无托盘服务）建失败不能拖垮主窗口
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitReady(base, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(base + '/api/data');
      if (res.ok) return;
    } catch {
      // 服务未就绪，继续等
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('本地服务启动超时');
}

// 自检：轮询渲染进程直到 React 挂载完成（#root 有子节点），再让页面自己 fetch 一次
// /api/data 验证「渲染进程 → 本地服务」的真实数据通道。返回摘要文本，失败抛错。
async function smokeCheck(win, base, timeoutMs = 25000) {
  const t0 = Date.now();
  let lastText = '';
  while (Date.now() - t0 < timeoutMs) {
    try {
      const info = await win.webContents.executeJavaScript(`(() => {
        const root = document.getElementById('root');
        return {
          rootOk: Boolean(root && root.children.length > 0),
          overlay: Boolean(document.querySelector('vite-error-overlay')),
          text: (document.body.innerText || '').slice(0, 200).replace(/\\s+/g, ' '),
        };
      })()`);
      if (info.rootOk && !info.overlay) {
        const apiOk = await win.webContents.executeJavaScript(
          `fetch('/api/data').then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then((j) => ({ ok: true, projects: (j.projects || []).length })).catch((e) => ({ ok: false, reason: String(e) }))`
        );
        if (!apiOk.ok) throw new Error('页面内 /api/data 请求失败：' + apiOk.reason);
        return `渲染进程已挂载，数据通道正常（${apiOk.projects} 个项目可见），启动 ${Date.now() - BOOT_AT}ms`;
      }
      lastText = info.overlay ? 'vite 错误覆盖层出现' : info.text;
    } catch {
      // 页面尚未就绪或正在切换，继续等
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('渲染进程未在超时内挂载' + (lastText ? `（页面文本：${lastText}）` : ''));
}

// 自检/托盘探测模式不抢单实例锁（可能正开着正式版），只读/隔离验证互不干扰
const gotLock = SMOKE || process.env.WB_TRAY_PROBE ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show(); // 可能正隐藏在托盘里，第二次启动要唤回主窗口
      win.focus();
    }
  });

  // 系统关机/注销、托盘「退出」、崩溃对话框「关闭」等都会走 before-quit
  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.whenReady().then(async () => {
    const port = await getFreePort();
    // WB_DATA_DIR：UI 冒烟用隔离目录，避免动到真实数据
    let dataDir = process.env.WB_DATA_DIR
      ? path.resolve(process.env.WB_DATA_DIR)
      : DEV
        ? path.join(__dirname, '..', 'data')
        : path.join(app.getPath('userData'), 'data');
    process.env.PORT = String(port);
    process.env.DATA_DIR = dataDir;
    // 数据位置指向文件：设置里「更改位置」写入后，这里优先用它（显式 WB_DATA_DIR 仍最高）
    if (!process.env.WB_DATA_DIR && !DEV) {
      try {
        const ptr = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'data-dir.json'), 'utf-8'));
        if (ptr.dataDir && fs.existsSync(ptr.dataDir)) dataDir = ptr.dataDir;
      } catch {}
    }

    await import(pathToFileURL(path.join(__dirname, '..', 'server.js')).href);
    const base = `http://127.0.0.1:${port}`;
    await waitReady(base);

    Menu.setApplicationMenu(null);
    // 标题栏与页面同色：系统那条白边和米色正文之间有一道硬分界，藏掉它，
    // 窗口按钮用原生 overlay 画在页面右上角（贴边吸附、Win11 布局都还在）。
    const TITLEBAR = { height: 40, width: 138 };
    const titleBarColors = (dark) =>
      dark ? { color: '#131720', symbolColor: '#eef1f6' } : { color: '#f9f5ea', symbolColor: '#1e2433' };
    const win = new BrowserWindow({
      width: 1320,
      height: 860,
      minWidth: 960,
      minHeight: 640,
      title: '拍案 · 创作工作台',
      show: false, // 一律先隐藏，等首帧渲染好再显示（见 ready-to-show），避免闪一帧浅色底色
      backgroundColor: '#f9f5ea',
      autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: { ...TITLEBAR, ...titleBarColors(false) },
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        spellcheck: false,
        preload: path.join(__dirname, 'preload.cjs'),
      },
    });
    ipcMain.on('wb:titlebar-theme', (_e, mode) => {
      if (win.isDestroyed()) return;
      win.setTitleBarOverlay({ ...TITLEBAR, ...titleBarColors(mode === 'dark') });
    });
    // 「读剪贴板」：走主进程拿系统剪贴板。渲染进程那套 navigator.clipboard 要求文档处于焦点，
    // 窗口在后面或刚切回来时会直接抛 NotAllowedError——这里没这个限制
    ipcMain.handle('wb:pick-dir', async () => {
      const r = await dialog.showOpenDialog(win, {
        title: '选择新的数据文件夹',
        properties: ['openDirectory', 'createDirectory'],
      });
      return r.canceled ? '' : r.filePaths[0] || '';
    });
    ipcMain.handle("wb:move-data", async (_e, target) => {
      try {
        const to = path.resolve(String(target || ''));
        const from = path.resolve(dataDir);
        if (!to || to === from) return { ok: false, error: '新位置和当前位置一样。' };
        if (to.startsWith(from + path.sep) || from.startsWith(to + path.sep)) return { ok: false, error: '新位置不能在当前数据目录里面（或反过来，嵌套会互相吞）。' };
        fs.mkdirSync(to, { recursive: true });
        const hasExisting = fs.existsSync(path.join(to, 'projects.json'));
        if (!hasExisting) {
          // 搬家：全部 JSON + 备份目录拷过去（目标已有数据则只切换、不覆盖）
          for (const f of ['projects.json', 'versions.json', 'ideas.json', 'stats.json', 'chat.json', 'gacha.json', 'cards.json', 'ai.json', 'app.json', 'benchmarks.json', 'obsidian.json', 'obsidian-sync.json']) {
            const src = path.join(from, f);
            if (fs.existsSync(src)) fs.copyFileSync(src, path.join(to, f));
          }
          const bSrc = path.join(from, 'backups');
          if (fs.existsSync(bSrc)) fs.cpSync(bSrc, path.join(to, "backups"), { recursive: true });
          // 迁移完自检：目标 projects.json 必须能解析，坏了就不切
          JSON.parse(fs.readFileSync(path.join(to, "projects.json"), "utf-8"));
        }
        fs.writeFileSync(path.join(app.getPath('userData'), 'data-dir.json'), JSON.stringify({ dataDir: to }, null, 2), 'utf-8');
        setTimeout(() => { app.relaunch(); app.exit(0); }, 1200);
        return { ok: true, switched: hasExisting, restarting: true };
      } catch (err) {
        return { ok: false, error: (err && err.message) || String(err) };
      }
    });
    ipcMain.handle('wb:clipboard-read', () => clipboard.readText());
    // 「在 Obsidian 里打开」：URI 一律由这里拼，页面只给路径片段；没装 Obsidian 就退回打开文件夹
    ipcMain.handle('wb:open-vault', async (_e, v) => {
      const vaultPath = typeof v?.vaultPath === 'string' ? v.vaultPath : '';
      const vaultName = typeof v?.vaultName === 'string' ? v.vaultName : '';
      const file = typeof v?.file === 'string' ? v.file.replace(/^[/\\]+/, '') : '';
      const qs = [`vault=${encodeURIComponent(vaultName || vaultPath)}`];
      if (file) qs.push(`file=${encodeURIComponent(file)}`);
      try {
        await shell.openExternal(`obsidian://open?${qs.join('&')}`);
        return { ok: true };
      } catch {
        if (vaultPath) {
          const err = await shell.openPath(vaultPath);
          if (!err) return { ok: true, folder: true };
          return { ok: false, error: '没找到 Obsidian，打开库目录也失败了：' + err };
        }
        return { ok: false, error: '尚未配置 Obsidian 库路径' };
      }
    });
    // 外部链接一律交给系统浏览器
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http')) shell.openExternal(url);
      return { action: 'deny' };
    });

    // 首帧画好（主题已由 index.html 内联脚本写进 DOM）才亮出来，避免暗色下闪白屏。
    const reveal = () => {
      if (SMOKE || win.isDestroyed()) return; // 自检模式窗口必须保持隐藏
      win.show();
    };
    win.once('ready-to-show', reveal);
    // 本地服务加载失败也要亮窗，否则用户只剩一个永远看不见的主窗口
    win.webContents.on('did-fail-load', reveal);
    // 兜底：首帧迟迟不来（脚本出错/白屏）时也要亮窗，不能让人找不到窗口
    setTimeout(reveal, 3000);

    // 崩溃自愈：渲染进程 / GPU 进程异常退出时，给「以兼容模式重启」的机会。
    // 已在兼容模式下不再弹窗（避免死循环）；仅打包后联网不可用场景也适用，本地服务重启即可。
    let crashed = false;
  // 崩溃留痕：渲染/GPU 进程异常退出都记一行进 data/logs/crash.log，拿得出来才诊断得了
  const logCrash = (label, details) => {
    try {
      const dir = path.join(dataDir, "logs");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, "crash.log"),
        `${new Date().toISOString()} ${label} reason=${details.reason} exitCode=${details.exitCode ?? ""}\n`,
      );
    } catch {
      // 日志写不进去不能比崩溃本身更糟：吞掉
    }
  };
    const offerCompatRestart = async (label, details) => {
    logCrash(label, details);
      if (SMOKE) {
        console.error(`[smoke] FAIL ${label}异常退出（${details.reason}${details.exitCode ? `，退出码 ${details.exitCode}` : ''}）`);
        app.exit(1);
        return;
      }
      if (crashed) return;
      crashed = true;
      if (app.commandLine.hasSwitch('disable-gpu') || app.commandLine.hasSwitch('disable-hardware-acceleration')) {
        crashed = false;
        return;
      }
      const { response } = await dialog.showMessageBox(win, {
        type: 'error',
        title: '拍案 · 创作工作台',
        message: `${label}异常退出`,
        detail:
          `原因：${details.reason}${details.exitCode ? `（退出码 ${details.exitCode}）` : ''}\n\n` +
          '若反复出现此问题，通常是显卡/硬件加速不兼容导致——点「兼容模式重启」关闭硬件加速（改用软件渲染）后再试。',
        buttons: ['以兼容模式重启', '重新加载', '关闭'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (response === 0) {
        app.relaunch({ args: process.argv.slice(1).concat(['--disable-gpu']) });
        app.exit(0);
      } else if (response === 1) {
        win.webContents.reload();
        crashed = false;
      } else {
        app.quit();
      }
    };
    win.webContents.on('render-process-gone', (_e, d) => {
      if (d.reason !== 'clean-exit' && d.reason !== 'killed') offerCompatRestart('界面渲染进程', d);
    });
    win.webContents.on('child-process-gone', (_e, d) => {
    win.webContents.on('unresponsive', () => logCrash('界面无响应', { reason: 'unresponsive', exitCode: 0 }));
      if (d.type === 'GPU' && d.reason !== 'clean-exit' && d.reason !== 'killed') offerCompatRestart('GPU 进程', d);
    });

    await win.loadURL(base);
    setupTray(win, dataDir);

    // 关闭保护：点 X 不退出，最小化到托盘（仅当托盘确实建起来了）。
    // 托盘缺失（受限环境）或显式退出（托盘菜单/崩溃对话框已置 isQuitting）时放行真实关闭。
    win.on('close', (e) => {
      let closeToTray = true;
      try {
        closeToTray = JSON.parse(fs.readFileSync(path.join(dataDir, "app.json"), "utf-8")).closeToTray !== false;
      } catch {}
      if (!closeToTray) return; // 设置里选了「退出程序」：直接走真实关闭
      if (!tray) return;
      if (SMOKE || isQuitting || !tray) return;
      e.preventDefault();
      win.hide();
    });

    if (SMOKE) {
      try {
        const summary = await smokeCheck(win, base);
        let extra = '';
        // WB_SMOKE_SCRIPT：可选，指向一段在渲染进程里执行的 UI 主路径脚本（返回 {ok, ...}）
        if (process.env.WB_SMOKE_SCRIPT) {
          const script = fs.readFileSync(process.env.WB_SMOKE_SCRIPT, 'utf-8');
          const result = await win.webContents.executeJavaScript(script);
          if (!result || result.ok !== true) throw new Error('UI 主路径失败：' + JSON.stringify(result).slice(0, 800));
          extra = `｜UI 主路径：${result.summary}`;
        }
        console.log(`[smoke] OK ${summary}${extra}`);
        app.exit(0);
      } catch (err) {
        console.error(`[smoke] FAIL ${err?.message || err}`);
        app.exit(1);
      }
    }

    // 关闭保护探测（WB_TRAY_PROBE=1，供自动化回归）：模拟点 X → 断言被拦截成隐藏而非退出。
    // 与自检模式互斥（SMOKE 分支在上面已 return/exit）。无桌面 shell 时托盘建不起来，
    // 用哑对象让逻辑走「托盘已存在」分支，验证的是拦截机制本身。
    if (process.env.WB_TRAY_PROBE && !SMOKE) {
      setTimeout(async () => {
        if (process.platform === 'win32' && !tray) tray = { __probeOnly: true };
        const before = { tray: !!tray, quitting: isQuitting, destroyed: win.isDestroyed(), visible: win.isVisible() };
        // 守卫先注册，我们先看到结果：defaultPrevented 直接说明「点 X 就隐藏」那条有没有跑
        let prevented = false;
        win.once('close', (e) => { prevented = e.defaultPrevented; });
        win.close();
        await new Promise((r) => setTimeout(r, 1000));
        const hidden = !win.isDestroyed() && !win.isVisible();
        const why = JSON.stringify({ ...before, prevented, after: { destroyed: win.isDestroyed(), visible: win.isVisible(), quitting: isQuitting } });
        console.log(hidden ? '[tray-probe] OK 关闭被拦截：窗口已隐藏、进程存活 · ' + why : '[tray-probe] FAIL 窗口未隐藏或已销毁 ' + why);
        app.exit(hidden ? 0 : 1);
      }, 1500);
    }
  });

  app.on('window-all-closed', () => app.quit());
}
