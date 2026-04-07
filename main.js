const { app, BrowserWindow, Tray, Menu, nativeImage, session, ipcMain, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

const APP_NAME = 'The Cloud Market';
const PROTOCOL = 'tcmworkspace';
const CRED_FILE = path.join(app.getPath('userData'), 'tcm-credentials.bin');
const RAGNOVA_BASE = 'https://thecloud.market';

let mainWindow = null;
let tray = null;
let pendingToken = null;
let authedCreds = null; // held in memory for the renderer process

// ---- single-instance lock: second launch forwards the deep link to the first ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', (_event, argv) => {
        const token = extractTokenFromArgv(argv);
        if (token) deliverToken(token);
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

// ---- protocol handler registration ----
if (process.defaultApp) {
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    }
} else {
    app.setAsDefaultProtocolClient(PROTOCOL);
}

// macOS deep link
app.on('open-url', (event, url) => {
    event.preventDefault();
    const token = parseTokenFromUrl(url);
    if (token) deliverToken(token);
});

function extractTokenFromArgv(argv) {
    for (const a of argv || []) {
        if (typeof a === 'string' && a.startsWith(PROTOCOL + '://')) {
            const t = parseTokenFromUrl(a);
            if (t) return t;
        }
    }
    return null;
}

function parseTokenFromUrl(url) {
    try {
        const u = new URL(url);
        return u.searchParams.get('token');
    } catch {
        return null;
    }
}

function deliverToken(token) {
    pendingToken = token;
    if (mainWindow && !mainWindow.webContents.isLoading()) {
        mainWindow.webContents.send('tcm:setup-token', token);
        pendingToken = null;
    }
}

// ---- encrypted credential storage (Electron safeStorage = DPAPI on Windows) ----
function saveCredentials(creds) {
    try {
        const json = JSON.stringify(creds);
        const buf = safeStorage.isEncryptionAvailable()
            ? safeStorage.encryptString(json)
            : Buffer.from(json, 'utf8');
        fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true });
        fs.writeFileSync(CRED_FILE, buf);
    } catch (e) {
        console.error('saveCredentials failed:', e);
    }
}

function loadCredentials() {
    try {
        if (!fs.existsSync(CRED_FILE)) return null;
        const buf = fs.readFileSync(CRED_FILE);
        const json = safeStorage.isEncryptionAvailable()
            ? safeStorage.decryptString(buf)
            : buf.toString('utf8');
        return JSON.parse(json);
    } catch (e) {
        console.error('loadCredentials failed:', e);
        return null;
    }
}

function clearCredentials() {
    try { fs.unlinkSync(CRED_FILE); } catch {}
    authedCreds = null;
}

// ---- Nextcloud auth: inject Basic Auth header for all requests to the NC host ----
function installNcAuth(creds) {
    if (!creds || !creds.nc_url || !creds.nc_user || !creds.nc_app_password) return;
    const ncHost = new URL(creds.nc_url).host;
    const basic = 'Basic ' + Buffer.from(`${creds.nc_user}:${creds.nc_app_password}`).toString('base64');

    const sess = session.fromPartition('persist:tcm');
    sess.webRequest.onBeforeSendHeaders((details, cb) => {
        try {
            if (new URL(details.url).host === ncHost) {
                details.requestHeaders['Authorization'] = basic;
            }
        } catch {}
        cb({ requestHeaders: details.requestHeaders });
    });
}

// ---- IPC bridge to renderer ----
ipcMain.handle('tcm:get-state', () => {
    return {
        authed: !!authedCreds,
        creds: authedCreds ? {
            nc_url: authedCreds.nc_url,
            nc_user: authedCreds.nc_user,
            display_name: authedCreds.display_name || authedCreds.nc_user,
            email: authedCreds.email || authedCreds.nc_user,
        } : null,
    };
});

ipcMain.handle('tcm:consume-token', async (_e, token) => {
    try {
        const resp = await postJson(`${RAGNOVA_BASE}/api/setup/consume`, { token });
        if (!resp || !resp.ok) return { ok: false, error: resp?.error || 'Setup link is invalid or expired.' };
        const creds = resp.creds;
        saveCredentials(creds);
        authedCreds = creds;
        installNcAuth(creds);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message || String(e) };
    }
});

ipcMain.handle('tcm:reissue', async (_e, email) => {
    try {
        const resp = await postJson(`${RAGNOVA_BASE}/api/setup/reissue`, { email });
        return resp || { ok: false, error: 'No response' };
    } catch (e) {
        return { ok: false, error: e.message || String(e) };
    }
});

// ---- NC Login Flow v2 (passwordless OIDC login) ----
// 1. POST /login/v2 → {poll: {token, endpoint}, login: URL}
// 2. Open login URL in system browser → user authenticates via OIDC
// 3. Poll endpoint until NC returns {server, loginName, appPassword}
// This is the same flow the official NC desktop client uses.

let loginFlowPollTimer = null;

ipcMain.handle('tcm:login-flow-start', async (_e, serverUrl) => {
    try {
        const base = serverUrl.replace(/\/$/, '');
        const url = `${base}/index.php/login/v2`;

        // Step 1: initiate the flow
        const initResp = await postJson(url, {});
        if (!initResp || !initResp.poll || !initResp.login) {
            return { ok: false, error: 'Server did not return a login flow. Check the workspace URL.' };
        }

        // Step 2: open login page in system browser
        shell.openExternal(initResp.login);

        // Step 3: start polling (return immediately, poll in background)
        const pollToken = initResp.poll.token;
        const pollEndpoint = initResp.poll.endpoint;

        return { ok: true, pollToken, pollEndpoint, base };
    } catch (e) {
        return { ok: false, error: e.message || String(e) };
    }
});

ipcMain.handle('tcm:login-flow-poll', async (_e, { pollEndpoint, pollToken, base }) => {
    try {
        const resp = await postJson(pollEndpoint, { token: pollToken });
        if (resp && resp.appPassword && resp.loginName) {
            // Success! Store credentials
            const creds = {
                nc_url: (resp.server || base).replace(/\/$/, ''),
                nc_user: resp.loginName,
                nc_app_password: resp.appPassword,
                display_name: resp.loginName.split('@')[0],
                email: resp.loginName,
            };
            saveCredentials(creds);
            authedCreds = creds;
            installNcAuth(creds);
            return { ok: true, done: true };
        }
        // Not ready yet (NC returns 404 while user hasn't logged in)
        return { ok: true, done: false };
    } catch (e) {
        // 404 means "not yet" — keep polling
        if (String(e).includes('404') || String(e).includes('Not Found')) {
            return { ok: true, done: false };
        }
        return { ok: false, error: e.message || String(e) };
    }
});

// Keep manual login as fallback for edge cases
ipcMain.handle('tcm:manual-login', async (_e, { nc_url, nc_user, nc_pass }) => {
    try {
        const creds = {
            nc_url: nc_url.replace(/\/$/, ''),
            nc_user: nc_user,
            nc_app_password: nc_pass,
            display_name: nc_user.split('@')[0],
            email: nc_user,
        };
        saveCredentials(creds);
        authedCreds = creds;
        installNcAuth(creds);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message || String(e) };
    }
});

// Auto-sync email: called by the renderer when NC Mail tab shows empty.
// Posts to ragnova with the user's workspace info so the server can run
// occ mail:account:create on their behalf. No browser session needed.
ipcMain.handle('tcm:resync-mail', async () => {
    if (!authedCreds) return { ok: false, error: 'Not signed in' };
    try {
        const resp = await postJson(`${RAGNOVA_BASE}/api/setup/resync-mail-app`, {
            subdomain: new URL(authedCreds.nc_url).host,
            email: authedCreds.nc_user || authedCreds.email,
        });
        return resp || { ok: false, error: 'No response' };
    } catch (e) {
        return { ok: false, error: e.message || String(e) };
    }
});

ipcMain.handle('tcm:logout', async () => {
    clearCredentials();
    try {
        await session.fromPartition('persist:tcm').clearStorageData();
    } catch {}
    app.relaunch();
    app.exit(0);
});

function postJson(url, body) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(url); } catch (e) { return reject(e); }
        const data = JSON.stringify(body);
        const req = https.request({
            method: 'POST',
            hostname: u.hostname,
            port: u.port || 443,
            path: u.pathname + u.search,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                'User-Agent': 'TCMWorkspace/1.0',
            },
        }, res => {
            let chunks = '';
            res.on('data', c => chunks += c);
            res.on('end', () => {
                try { resolve(JSON.parse(chunks)); }
                catch { resolve({ ok: false, error: `HTTP ${res.statusCode}` }); }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

// ---- window & tray ----
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        title: APP_NAME,
        icon: path.join(__dirname, 'icon.ico'),
        backgroundColor: '#0f1629',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: true,
            webSecurity: true,
            zoomFactor: 1.0,
            enableWebSQL: false,
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
            color: '#0f1629',
            symbolColor: '#22c55e',
            height: 36,
        },
    });

    mainWindow.loadFile('index.html');

    mainWindow.webContents.on('did-finish-load', () => {
        if (pendingToken) {
            mainWindow.webContents.send('tcm:setup-token', pendingToken);
            pendingToken = null;
        }
    });

    mainWindow.on('close', (e) => {
        e.preventDefault();
        mainWindow.hide();
    });
}

function createTray() {
    try {
        const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
        tray = new Tray(icon.resize({ width: 16, height: 16 }));
        const menu = Menu.buildFromTemplate([
            { label: 'Open ' + APP_NAME, click: () => mainWindow && mainWindow.show() },
            { type: 'separator' },
            { label: 'Sign out', click: () => mainWindow && mainWindow.webContents.send('tcm:trigger-logout') },
            { label: 'Quit', click: () => app.exit(0) },
        ]);
        tray.setToolTip(APP_NAME);
        tray.setContextMenu(menu);
        tray.on('click', () => mainWindow && mainWindow.show());
    } catch {}
}

// Enable high-DPI rendering and GPU acceleration for crisp text/icons
app.commandLine.appendSwitch('high-dpi-support', '1');
app.commandLine.appendSwitch('enable-gpu-rasterization');

app.whenReady().then(async () => {
    app.userAgentFallback = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    // ---------- reduce server load: aggressive client-side caching ----------
    const sess = session.fromPartition('persist:tcm');

    // The persist:tcm partition automatically uses disk cache under userData.
    // Chromium's HTTP cache is enabled by default — no manual configuration
    // needed. Static assets (JS/CSS/fonts) get cached on first load.

    // Cache service-worker and offline-capable NC resources
    sess.webRequest.onHeadersReceived((details, cb) => {
        const url = details.url || '';
        const headers = { ...details.responseHeaders };
        // For static JS/CSS/font bundles: allow long-term caching (1 day) if
        // the server didn't set a Cache-Control header already.
        const isStatic = /\.(js|css|woff2?|ttf|svg|png|jpg|webp|ico)(\?|$)/i.test(url);
        if (isStatic && !headers['cache-control'] && !headers['Cache-Control']) {
            headers['Cache-Control'] = ['public, max-age=86400, stale-while-revalidate=604800'];
        }
        cb({ responseHeaders: headers });
    });

    // Restore credentials BEFORE the window loads so the webRequest handler is live
    const saved = loadCredentials();
    if (saved) {
        authedCreds = saved;
        installNcAuth(saved);
    }

    // Windows passes the deep-link URL via process.argv on first launch
    const argToken = extractTokenFromArgv(process.argv);
    if (argToken) pendingToken = argToken;

    createWindow();
    createTray();
});

app.on('window-all-closed', () => { /* keep running in tray */ });
app.on('activate', () => { if (mainWindow) mainWindow.show(); });
