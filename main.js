const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');

let mainWindow;
let tray;

const WORKSPACE_URL = 'https://cyberollie.thecloud.market';
const MAIL_URL = 'https://mail.thecloud.market';
const APP_NAME = 'The Cloud Market';

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        title: APP_NAME,
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webviewTag: true,
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
            color: '#0f1629',
            symbolColor: '#22c55e',
            height: 36,
        },
    });

    mainWindow.loadFile('index.html');

    mainWindow.on('close', (event) => {
        event.preventDefault();
        mainWindow.hide();
    });
}

function createTray() {
    try {
        const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
        tray = new Tray(icon.resize({ width: 16, height: 16 }));
    } catch (e) {
        // Tray icon optional
        return;
    }

    const contextMenu = Menu.buildFromTemplate([
        { label: 'Open The Cloud Market', click: () => mainWindow.show() },
        { type: 'separator' },
        { label: 'Email', click: () => { mainWindow.show(); mainWindow.webContents.send('switch-tab', 'email'); } },
        { label: 'Files', click: () => { mainWindow.show(); mainWindow.webContents.send('switch-tab', 'files'); } },
        { label: 'Calendar', click: () => { mainWindow.show(); mainWindow.webContents.send('switch-tab', 'calendar'); } },
        { label: 'Talk', click: () => { mainWindow.show(); mainWindow.webContents.send('switch-tab', 'talk'); } },
        { type: 'separator' },
        { label: 'Quit', click: () => { app.exit(); } },
    ]);

    tray.setToolTip(APP_NAME);
    tray.setContextMenu(contextMenu);
    tray.on('click', () => mainWindow.show());
}

app.whenReady().then(() => {
    createWindow();
    createTray();
});

app.on('window-all-closed', () => {
    // Keep running in tray
});

app.on('activate', () => {
    if (mainWindow) mainWindow.show();
});
