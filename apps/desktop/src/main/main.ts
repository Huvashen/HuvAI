import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, protocol, shell, Tray } from 'electron';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { DesktopService } from './desktop-service.ts';
import { DesktopStore } from '../../../../src/storage/desktop-store.ts';
import { WindowsVault } from '../../../../src/storage/windows-vault.ts';
import { validateDesktopRequest } from '../../../../src/security/desktop-requests.ts';
import { JarvisError } from '../../../../src/shared/errors.ts';
import type { DesktopReply } from '../../../../src/shared/desktop-contracts.ts';

protocol.registerSchemesAsPrivileged([{ scheme: 'jarvis', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const projectRoot = app.getAppPath();
if (!app.isPackaged) {
  const dataPath = resolve(projectRoot, '.jarvis/desktop');
  mkdirSync(dataPath, { recursive: true }); app.setPath('userData', dataPath);
}
app.setAppUserModelId('com.huvi.jarvis');
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let service: DesktopService | undefined;
let store: DesktopStore | undefined;
let quitting = false;
let shutdownComplete = false;
const rendererRoot = resolve(projectRoot, 'dist/renderer/browser');
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'self'; form-action 'none'; frame-src 'none'";
function showWindow() { if (window) { window.show(); window.focus(); service?.publish(); } }

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('window-all-closed', () => {});
  app.on('activate', showWindow);
  app.on('before-quit', event => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void (async () => {
      await service?.shutdown(); store?.close(); tray?.destroy();
      shutdownComplete = true; app.quit();
    })();
  });
  void app.whenReady().then(async () => {
    protocol.handle('jarvis', async request => {
      try {
        const url = new URL(request.url);
        if (url.host !== 'app' || request.method !== 'GET') return new Response('', { status: 403 });
        const path = resolve(rendererRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
        const child = relative(rendererRoot, path);
        if (child.startsWith('..') || isAbsolute(child)) return new Response('', { status: 403 });
        const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
          '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
        return new Response(new Uint8Array(await readFile(path)), { headers: {
          'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
          'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff',
        } });
      } catch { return new Response('Resource unavailable', { status: 404 }); }
    });
    store = new DesktopStore(resolve(app.getPath('userData'), 'history.sqlite'));
    // Development and CLI probes share one protected session/host ID, avoiding cloned rotating tokens.
    const credentialPath = app.isPackaged ? resolve(app.getPath('userData'), 'credentials') : resolve(projectRoot, '.jarvis');
    service = new DesktopService(store, new WindowsVault(credentialPath),
      app.isPackaged, event => { if (window && !window.isDestroyed()) window.webContents.send('jarvis:event', event); },
      async url => {
        if (new URL(url).origin !== 'https://auth.openai.com') throw new JarvisError('URL_BLOCKED', 'Sign-in URL rejected.');
        await shell.openExternal(url);
      }, message => { if (Notification.isSupported()) { try { new Notification({ title: 'JARVIS', body: message }).show(); } catch {} } });
    await service.initialize();
    window = new BrowserWindow({ width: 1180, height: 800, minWidth: 800, minHeight: 600, show: false,
      backgroundColor: '#10151d', title: 'JARVIS', icon: resolve(projectRoot, 'dist/desktop/icon.png'),
      webPreferences: { preload: resolve(projectRoot, 'dist/desktop/preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false } });
    window.removeMenu();
    window.on('close', event => { if (!quitting) { event.preventDefault(); window?.hide(); } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    ipcMain.handle('jarvis:request', async (event, payload): Promise<DesktopReply> => {
      const owner = window;
      if (!owner || !event.senderFrame || event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame
        || event.senderFrame.url !== 'jarvis://app/') return { ok: false, message: 'Untrusted desktop request.' };
      try {
        const request = validateDesktopRequest(payload);
        if (service!.snapshot().locked && !['snapshot', 'cancel'].includes(request.action)) throw new JarvisError('LOCKED', 'Unlock Windows to continue.');
        switch (request.action) {
          case 'snapshot': service!.publish(); break;
          case 'send': await service!.send(request.text); break;
          case 'cancel': service!.cancel(); break;
          case 'login': await service!.login(); break;
          case 'newConversation': service!.newConversation(); break;
          case 'selectConversation': service!.selectConversation(request.id); break;
          case 'clearHistory': {
            if (service!.snapshot().busy) throw new JarvisError('BUSY', 'Finish or cancel the current task first.');
            const answer = await dialog.showMessageBox(owner, { type: 'warning', buttons: ['Cancel', 'Delete history'],
              defaultId: 0, cancelId: 0, message: 'Delete all local conversations?', detail: 'This cannot be undone.' });
            if (answer.response === 1) service!.clearHistory();
            break;
          }
          case 'openUsage': await shell.openExternal('https://chatgpt.com/settings/usage'); break;
          case 'settings': {
            if (service!.snapshot().busy) throw new JarvisError('BUSY', 'Finish or cancel the current task first.');
            const previous = service!.snapshot().settings;
            if (previous.startAtLogin !== request.settings.startAtLogin) {
              if (!app.isPackaged) throw new JarvisError('INSTALL_REQUIRED', 'Start at login becomes available after installation.');
              app.setLoginItemSettings({ openAtLogin: request.settings.startAtLogin, args: ['--hidden'] });
            }
            service!.saveSettings(request.settings); break;
          }
        }
        return { ok: true };
      } catch (error) { return { ok: false, message: service!.report(error) }; }
    });
    tray = new Tray(nativeImage.createFromPath(resolve(projectRoot, 'dist/desktop/icon.png')));
    tray.setToolTip('JARVIS');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open JARVIS', click: showWindow },
      { type: 'separator' }, { label: 'Quit JARVIS', click: () => app.quit() }]));
    tray.on('click', showWindow);
    powerMonitor.on('lock-screen', () => service?.setLocked(true));
    powerMonitor.on('unlock-screen', () => service?.setLocked(false));
    powerMonitor.on('suspend', () => service?.cancel());
    await window.loadURL('jarvis://app/');
    if (!process.argv.includes('--hidden')) showWindow();
  }).catch(() => {
    if (Notification.isSupported()) new Notification({ title: 'JARVIS could not start', body: 'Run npm run build and check the desktop runtime dependencies.' }).show();
    app.quit();
  });
}
