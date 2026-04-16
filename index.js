/*
==========================================================
Telegram Browser Control Bot - Anti-Detect Edition
==========================================================
Features:
- Advanced Chromium stealth (anti-bot detection)
- WebRTC IP leak prevention
- Residential Proxy support (HTTP/HTTPS/SOCKS5)
- Cookie banner auto-handler
- 2FA/OTP Code support
- Admin approval system
- Detailed session logging

Required environment variables:
- BOT_TOKEN
- ADMIN_ID

Optional:
- PORT (default: 3000)
- HEADLESS (true/false, default: true)
- PROXY_SERVER (e.g., http://user:pass@ip:port or socks5://ip:port)
- PROXY_USERNAME (if not in URL)
- PROXY_PASSWORD (if not in URL)
*/

const TelegramBot = require('node-telegram-bot-api');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

chromium.use(stealth);

// --------------------------------------------------
// 1) Environment & Configuration
// --------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || '').trim();
const PORT = Number(process.env.PORT || 3000);
const HEADLESS = String(process.env.HEADLESS || 'true').toLowerCase() !== 'false';

// Proxy Configuration
const PROXY_SERVER = process.env.PROXY_SERVER || '';
const PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';

if (!BOT_TOKEN) {
  console.error('❌ Missing BOT_TOKEN in environment variables.');
  process.exit(1);
}

if (!ADMIN_ID) {
  console.error('❌ Missing ADMIN_ID in environment variables.');
  process.exit(1);
}

// --------------------------------------------------
// 2) Keep-alive server
// --------------------------------------------------
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Anti-Detect Browser Bot is running.');
}).listen(PORT, () => {
  console.log(`✅ HTTP server listening on port ${PORT}`);
  if (PROXY_SERVER) console.log(`🌐 Using Proxy: ${PROXY_SERVER}`);
});

// --------------------------------------------------
// 3) Telegram bot
// --------------------------------------------------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function isAdmin(chatId) {
  return String(chatId) === ADMIN_ID;
}

// --------------------------------------------------
// 4) In-memory state
// --------------------------------------------------
const sessions = {};
const pendingComputerRequests = {};
const approvedUsersFile = path.join(process.cwd(), 'approved_users.json');

function loadApprovedUsers() {
  try {
    if (!fs.existsSync(approvedUsersFile)) return {};
    const raw = fs.readFileSync(approvedUsersFile, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (_) {
    return {};
  }
}

function saveApprovedUsers(data) {
  try {
    fs.writeFileSync(approvedUsersFile, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save approved users:', err);
  }
}

const approvedUsers = loadApprovedUsers();

function getSession(chatId) {
  const id = String(chatId);
  if (!sessions[id]) {
    sessions[id] = {
      browser: null,
      context: null,
      page: null,
      step: null,
      lastGrid: null,
      recorder: null,
      approvedByAdmin: false,
      waitTimerStartedAt: null,
      waitTimerPageUrl: null,
      expectingVerificationCode: false,
      userDataDir: path.join(os.tmpdir(), `browser_profile_${id}_${Date.now()}`)
    };
  }
  return sessions[id];
}

// --------------------------------------------------
// 5) Utilities
// --------------------------------------------------
function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeFileName(name) {
  return String(name || 'session')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80);
}

function createKeyboard(isAdminUser) {
  const keyboard = [
    [{ text: '🌐 فتح الرابط', callback_data: 'browser_open_url' }],
    [{ text: '🔄 تحديث الشاشة', callback_data: 'browser_refresh' }],
    [{ text: '⌨️ انتر', callback_data: 'browser_enter' }],
    [{ text: '📝 كتابة نص', callback_data: 'browser_type_text' }],
    [{ text: '⌫ حذف نص', callback_data: 'browser_delete_text' }],
    [{ text: '⬇️ نزول بسيط', callback_data: 'browser_scroll_down_small' }, { text: '⬆️ صعود بسيط', callback_data: 'browser_scroll_up_small' }],
    [{ text: '⏬ نزول للنهاية', callback_data: 'browser_scroll_down_end' }, { text: '⏫ صعود للنهاية', callback_data: 'browser_scroll_up_end' }],
    [{ text: '#️⃣ شبكة الماوس', callback_data: 'browser_mouse_grid' }],
    [{ text: '🔍 البحث والضغط', callback_data: 'browser_find_text_click' }],
    [{ text: '🔐 إدخال كود التحقق', callback_data: 'browser_detect_verification_code' }],
    [{ text: '⏱️ تسجيل الوقت', callback_data: 'browser_toggle_timer' }],
    [{ text: '💾 حفظ وإنهاء', callback_data: 'browser_save_end' }]
  ];
  return { inline_keyboard: keyboard };
}

function createHomeKeyboard(isAdminUser, chatId = '') {
  if (isAdminUser || approvedUsers[String(chatId)]) {
    return {
      inline_keyboard: [[{ text: '💻 وضع الكمبيوتر', callback_data: 'start_computer_mode' }]]
    };
  }
  return {
    inline_keyboard: [[{ text: '📟 طلب وضع الكمبيوتر', callback_data: 'request_computer_mode' }]]
  };
}

// --------------------------------------------------
// 6) Recorder Class
// --------------------------------------------------
class ScriptRecorder {
  constructor(ownerChatId) {
    this.ownerChatId = String(ownerChatId);
    this.startedAt = nowIso();
    this.lines = [];
    this.step = 1;
    this.writeHeader();
  }

  writeHeader() {
    this.lines.push('ANTI-DETECT BROWSER SESSION REPORT');
    this.lines.push('========================================');
    this.lines.push(`Started at: ${this.startedAt}`);
    this.lines.push(`Owner chat id: ${this.ownerChatId}`);
    this.lines.push('');
  }

  add(title, details = []) {
    const number = this.step++;
    this.lines.push(`STEP ${number}: ${title}`);
    details.forEach(detail => this.lines.push(`- ${detail}`));
    this.lines.push('');
  }

  finalize() {
    this.lines.push('SESSION END');
    this.lines.push('========================================');
    this.lines.push(`Ended at: ${nowIso()}`);
    return this.lines.join('\n');
  }
}

// --------------------------------------------------
// 7) Anti-Detect Browser Helpers
// --------------------------------------------------

// Advanced args to prevent detection
const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-site-isolation-trials',
  '--disable-web-security',
  '--disable-features=BlockInsecurePrivateNetworkRequests',
  '--disable-webrtc', // Disable WebRTC to prevent IP leak
  '--force-webrtc-ip-handling-policy=default_public_interface_only',
  '--disable-features=WebRtcHideLocalIpsWithMdns',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--disable-gpu',
  '--window-size=1920,1080',
  '--start-maximized',
  '--hide-scrollbars',
  '--disable-notifications',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-features=TranslateUI',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--force-color-profile=srgb',
  '--metrics-recording-only',
  '--safebrowsing-disable-auto-update',
  '--enable-automation', // Sometimes hiding this is worse, keep it but control other flags
  '--password-store=basic',
  '--use-mock-keychain',
  '--lang=en-US,en',
  '--disable-infobars',
  '--disable-features=PrivacySandboxSettings4'
];

async function handleCookieBanner(page) {
  const acceptTexts = [
    'Accept all cookies', 'Accept Cookies', 'Accept', 'Agree', 'Got it',
    'Continue', 'I understand', 'موافق', 'قبول', 'Alle akzeptieren',
    'Aceptar', 'J\'accepte', 'Accetta'
  ];
  
  for (const text of acceptTexts) {
    try {
      const btn = page.getByRole('button', { name: new RegExp(text, 'i') }).first();
      if (await btn.isVisible({ timeout: 1000 }) && await btn.isEnabled()) {
        await btn.click();
        await sleep(1000);
        return true;
      }
    } catch (_) {}
    
    try {
      const generic = page.locator(`button:has-text("${text}")`).first();
      if (await generic.isVisible({ timeout: 500 }) && await generic.isEnabled()) {
        await generic.click();
        await sleep(1000);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function ensureBrowserSession(chatId) {
  const session = getSession(chatId);

  if (session.browser && session.context && session.page) {
    try {
      await session.page.evaluate(() => document.title);
      return session;
    } catch (_) {}
  }

  // Launch options
  const launchOptions = {
    headless: HEADLESS,
    args: STEALTH_ARGS,
    ignoreDefaultArgs: ['--enable-automation'], // Remove automation flag
    userDataDir: session.userDataDir // Persistent profile for cookies/localStorage
  };

  // Add proxy if configured
  if (PROXY_SERVER) {
    launchOptions.proxy = {
      server: PROXY_SERVER,
      username: PROXY_USERNAME || undefined,
      password: PROXY_PASSWORD || undefined
    };
  }

  const browser = await chromium.launch(launchOptions);

  // Context with anti-fingerprint settings
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    screen: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York', // Change based on your proxy location
    geolocation: { latitude: 40.7128, longitude: -74.0060 }, // NYC coords (change to match proxy)
    permissions: ['geolocation'],
    colorScheme: 'light',
    bypassCSP: true,
    ignoreHTTPSErrors: true
  });

  // Hide webdriver property
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();
  
  // Handle WebRTC leak via CDP (Chrome DevTools Protocol)
  try {
    const client = await page.context().newCDPSession(page);
    await client.send('Network.setBypassServiceWorker', { bypass: true });
  } catch (_) {}

  await page.goto('https://www.google.com', { waitUntil: 'networkidle', timeout: 60000 });
  await handleCookieBanner(page);

  session.browser = browser;
  session.context = context;
  session.page = page;
  session.step = null;
  session.lastGrid = null;
  session.recorder = new ScriptRecorder(chatId);
  session.waitTimerStartedAt = null;
  session.waitTimerPageUrl = null;
  session.expectingVerificationCode = false;

  session.recorder.add('Browser session started (Anti-Detect Mode)', [
    `Initial URL: ${page.url()}`,
    `Viewport: 1920x1080`,
    `Headless: ${HEADLESS}`,
    `Proxy: ${PROXY_SERVER ? 'Enabled' : 'None'}`,
    `User Agent: ${await page.evaluate(() => navigator.userAgent)}`
  ]);

  return session;
}

async function sendBrowserMenu(chatId, text = 'تم فتح وضع الكمبيوتر.') {
  return bot.sendMessage(chatId, text, { reply_markup: createKeyboard(isAdmin(chatId)) });
}

async function sendPageScreenshot(chatId, page, caption = 'Current screen') {
  const filePath = path.join(os.tmpdir(), `screen_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
  await page.screenshot({ path: filePath, fullPage: false });
  await bot.sendPhoto(chatId, filePath, { caption });
  fs.unlinkSync(filePath);
}

async function sendScreenAndMenu(chatId, page, caption, menuText = 'تم تنفيذ الأمر.') {
  await sendPageScreenshot(chatId, page, caption);
  return sendBrowserMenu(chatId, menuText);
}

async function closeBrowserSession(chatId) {
  const session = getSession(chatId);
  try { if (session.page) await session.page.close().catch(() => {}); } catch (_) {}
  try { if (session.context) await session.context.close().catch(() => {}); } catch (_) {}
  try { if (session.browser) await session.browser.close().catch(() => {}); } catch (_) {}
  
  // Cleanup user data dir
  try {
    if (fs.existsSync(session.userDataDir)) {
      fs.rmSync(session.userDataDir, { recursive: true, force: true });
    }
  } catch (_) {}

  session.browser = null;
  session.context = null;
  session.page = null;
  session.step = null;
  session.lastGrid = null;
  session.waitTimerStartedAt = null;
  session.waitTimerPageUrl = null;
  session.expectingVerificationCode = false;
}

// --------------------------------------------------
// 8) Human-like Actions
// --------------------------------------------------
async function typeLikeHuman(page, text) {
  for (const ch of String(text)) {
    await page.keyboard.type(ch, { delay: 50 + Math.floor(Math.random() * 100) });
    await sleep(10 + Math.floor(Math.random() * 50));
  }
}

async function getVisibleViewportSize(page) {
  return await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY
  }));
}

async function renderMouseGridAndScreenshot(page, outputPath, cols = 20, rows = 15) {
  const info = await getVisibleViewportSize(page);
  await page.evaluate(({ cols, rows }) => {
    const old = document.getElementById('__tg_mouse_grid_overlay__');
    if (old) old.remove();
    
    const overlay = document.createElement('div');
    overlay.id = '__tg_mouse_grid_overlay__';
    overlay.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483647;pointer-events:none;background:transparent;';
    
    const cellW = window.innerWidth / cols;
    const cellH = window.innerHeight / rows;
    let counter = 1;
    
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = document.createElement('div');
        cell.style.cssText = `position:absolute;left:${c*cellW}px;top:${r*cellH}px;width:${cellW}px;height:${cellH}px;box-sizing:border-box;border:1px solid rgba(255,0,0,0.6);background:rgba(255,0,0,0.1);`;
        const label = document.createElement('div');
        label.textContent = String(counter);
        label.style.cssText = 'position:absolute;left:2px;top:2px;font-size:10px;font-weight:bold;color:red;background:rgba(255,255,255,0.8);padding:1px 3px;border-radius:2px;';
        cell.appendChild(label);
        overlay.appendChild(cell);
        counter++;
      }
    }
    document.body.appendChild(overlay);
  }, { cols, rows });
  
  await page.screenshot({ path: outputPath, fullPage: false });
  await page.evaluate(() => {
    const old = document.getElementById('__tg_mouse_grid_overlay__');
    if (old) old.remove();
  });
  
  return { cols, rows, viewportWidth: info.width, viewportHeight: info.height, totalCells: cols * rows };
}

function getCellCenter(grid, cellNumber) {
  const index = Number(cellNumber) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= grid.totalCells) return null;
  
  const col = index % grid.cols;
  const row = Math.floor(index / grid.cols);
  const cellW = grid.viewportWidth / grid.cols;
  const cellH = grid.viewportHeight / grid.rows;
  
  return {
    cellNumber: Number(cellNumber),
    col: col + 1,
    row: row + 1,
    x: col * cellW + cellW / 2,
    y: row * cellH + cellH / 2,
    absoluteX: grid.scrollX + (col * cellW + cellW / 2),
    absoluteY: grid.scrollY + (row * cellH + cellH / 2)
  };
}

async function moveMouseLikeHuman(page, targetX, targetY) {
  const size = await getVisibleViewportSize(page);
  const startX = size.width / 2;
  const startY = size.height / 2;
  const steps = 20 + Math.floor(Math.random() * 15);
  
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const curve = t * t * (3 - 2 * t); // Smoothstep
    const x = startX + (targetX - startX) * curve + (Math.random() - 0.5) * 5;
    const y = startY + (targetY - startY) * curve + (Math.random() - 0.5) * 5;
    await page.mouse.move(x, y);
    await sleep(5 + Math.floor(Math.random() * 15));
  }
  await page.mouse.move(targetX, targetY);
}

async function clickGridCell(page, grid, cellNumber) {
  const target = getCellCenter(grid, cellNumber);
  if (!target) throw new Error(`Invalid grid cell: ${cellNumber}`);
  await moveMouseLikeHuman(page, target.x, target.y);
  await sleep(100 + Math.floor(Math.random() * 100));
  await page.mouse.click(target.x, target.y);
  return target;
}

async function findTextAndClick(page, searchText) {
  const locators = [
    page.getByRole('button', { name: searchText, exact: false }).first(),
    page.getByText(searchText, { exact: false }).first(),
    page.locator(`text="${searchText}"`).first()
  ];
  
  for (const locator of locators) {
    try {
      if (await locator.isVisible({ timeout: 2000 }) && await locator.isEnabled()) {
        await locator.scrollIntoViewIfNeeded();
        const box = await locator.boundingBox();
        if (!box) continue;
        await moveMouseLikeHuman(page, box.x + box.width/2, box.y + box.height/2);
        await sleep(200);
        await locator.click({ delay: 50 });
        return { ok: true, text: searchText, x: box.x + box.width/2, y: box.y + box.height/2 };
      }
    } catch (_) {}
  }
  return { ok: false };
}

async function fillInputByLabelOrPlaceholder(page, valueToType) {
  // Try common 2FA input selectors
  const selectors = [
    'input[type="text"][inputmode="numeric"]',
    'input[type="number"]',
    'input[placeholder*="code" i]',
    'input[placeholder*="رمز" i]',
    'input[name*="code" i]',
    'input[name*="otp" i]',
    'input[id*="code" i]',
    'input[autocomplete="one-time-code"]'
  ];
  
  for (const selector of selectors) {
    try {
      const input = page.locator(selector).first();
      if (await input.isVisible({ timeout: 1000 })) {
        await input.click();
        await input.fill(''); // Clear
        await typeLikeHuman(page, valueToType);
        return { ok: true, selector };
      }
    } catch (_) {}
  }
  return { ok: false };
}

async function deleteTextLikeHuman(page, count) {
  for (let i = 0; i < count; i++) {
    await sleep(30 + Math.random() * 70);
    await page.keyboard.press('Backspace');
  }
}

async function scrollHumanSimple(page, deltaY) {
  const steps = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, deltaY / steps);
    await sleep(100 + Math.random() * 100);
  }
}

async function scrollToExtreme(page, direction) {
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, direction === 'down' ? 1000 : -1000);
    await sleep(100);
  }
  await page.evaluate(dir => window.scrollTo({ top: dir === 'down' ? document.body.scrollHeight : 0, behavior: 'smooth' }), direction);
  await sleep(500);
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m ${s%60}s`;
}

// --------------------------------------------------
// 9) Bot Commands & Handlers
// --------------------------------------------------
bot.onText(/\/start/, async (msg) => {
  const chatId = String(msg.chat.id);
  await bot.sendMessage(chatId, 'اختر الخدمة:', { reply_markup: createHomeKeyboard(isAdmin(chatId), chatId) });
});

bot.on('callback_query', async (query) => {
  const chatId = String(query.message.chat.id);
  const data = query.data;
  const session = getSession(chatId);
  
  await bot.answerCallbackQuery(query.id).catch(() => {});
  
  try {
    // Mode switching
    if (data === 'start_computer_mode') {
      if (!isAdmin(chatId) && !approvedUsers[chatId]) {
        return bot.sendMessage(chatId, '⚠️ يحتاج لموافقة الأدمن.');
      }
      await ensureBrowserSession(chatId);
      return sendScreenAndMenu(chatId, session.page, 'Browser Ready', '✅ تم فتح المتصفح (وضع التخفي)');
    }
    
    if (data === 'request_computer_mode') {
      if (isAdmin(chatId) || approvedUsers[chatId]) {
        await ensureBrowserSession(chatId);
        return sendScreenAndMenu(chatId, session.page, 'Browser Ready', '✅ تم فتح المتصفح');
      }
      if (pendingComputerRequests[chatId]) {
        return bot.sendMessage(chatId, '⏳ الطلب قيد الانتظار.');
      }
      pendingComputerRequests[chatId] = {
        requesterChatId: chatId,
        name: `${query.from?.first_name || ''} ${query.from?.last_name || ''}`.trim() || 'Unknown',
        username: query.from?.username || 'No username',
        createdAt: nowIso()
      };
      await bot.sendMessage(chatId, '✉️ تم إرسال الطلب للأدمن.');
      return bot.sendMessage(ADMIN_ID, `🖥️ طلب وضع كمبيوتر جديد!\n👤 الاسم: ${pendingComputerRequests[chatId].name}\n🆔 الايدي: ${chatId}\n📱 المعرف: @${pendingComputerRequests[chatId].username}`, {
        reply_markup: { inline_keyboard: [
          [{ text: '✅ موافقة', callback_data: `approve_${chatId}` }, { text: '❌ رفض', callback_data: `reject_${chatId}` }]
        ]}
      });
    }
    
    if (data.startsWith('approve_')) {
      const reqId = data.replace('approve_', '');
      if (!isAdmin(chatId)) return;
      if (!pendingComputerRequests[reqId]) return bot.sendMessage(chatId, 'الطلب غير موجود.');
      
      approvedUsers[reqId] = { approved: true, at: nowIso() };
      saveApprovedUsers(approvedUsers);
      delete pendingComputerRequests[reqId];
      
      await bot.sendMessage(reqId, '✅ تمت الموافقة! اضغط على "وضع الكمبيوتر" الآن.');
      return bot.sendMessage(chatId, `✅ تمت الموافقة للمستخدم ${reqId}`);
    }
    
    if (data.startsWith('reject_')) {
      const reqId = data.replace('reject_', '');
      if (!isAdmin(chatId)) return;
      delete pendingComputerRequests[reqId];
      await bot.sendMessage(reqId, '❌ تم رفض طلبك.');
      return bot.sendMessage(chatId, `❌ تم الرفض للمستخدم ${reqId}`);
    }
    
    // Browser Actions
    if (!session.page) return bot.sendMessage(chatId, '❌ لا توجد جلسة متصفح. ابدأ "وضع الكمبيوتر" أولاً.');
    
    if (data === 'browser_open_url') {
      session.step = 'awaiting_url';
      session.expectingVerificationCode = false;
      return bot.sendMessage(chatId, '🌐 أرسل الرابط الآن (مثال: google.com):');
    }
    
    if (data === 'browser_refresh') {
      await session.page.reload({ waitUntil: 'networkidle' });
      await handleCookieBanner(session.page);
      session.recorder.add('Page refreshed', [`URL: ${session.page.url()}`]);
      return sendScreenAndMenu(chatId, session.page, 'Refreshed', '🔄 تم التحديث');
    }
    
    if (data === 'browser_enter') {
      await session.page.keyboard.press('Enter');
      await sleep(1000);
      session.recorder.add('Pressed Enter', [`URL: ${session.page.url()}`]);
      return sendScreenAndMenu(chatId, session.page, 'After Enter', '⌨️ تم الضغط على Enter');
    }
    
    if (data === 'browser_type_text') {
      session.step = 'awaiting_text';
      return bot.sendMessage(chatId, '📝 أرسل النص للكتابة:');
    }
    
    if (data === 'browser_delete_text') {
      session.step = 'awaiting_delete_count';
      return bot.sendMessage(chatId, '🔢 أرسل عدد الأحرف للحذف (رقم):');
    }
    
    if (data === 'browser_scroll_down_small') {
      await scrollHumanSimple(session.page, 800);
      return sendScreenAndMenu(chatId, session.page, 'Scrolled Down', '⬇️ تم التمرير للأسفل');
    }
    
    if (data === 'browser_scroll_up_small') {
      await scrollHumanSimple(session.page, -800);
      return sendScreenAndMenu(chatId, session.page, 'Scrolled Up', '⬆️ تم التمرير للأعلى');
    }
    
    if (data === 'browser_scroll_down_end') {
      await scrollToExtreme(session.page, 'down');
      return sendScreenAndMenu(chatId, session.page, 'End of Page', '⏬ تم الذهاب للنهاية');
    }
    
    if (data === 'browser_scroll_up_end') {
      await scrollToExtreme(session.page, 'up');
      return sendScreenAndMenu(chatId, session.page, 'Top of Page', '⏫ تم الذهاب للبداية');
    }
    
    if (data === 'browser_mouse_grid') {
      const imgPath = path.join(os.tmpdir(), `grid_${Date.now()}.png`);
      session.lastGrid = await renderMouseGridAndScreenshot(session.page, imgPath, 20, 15);
      await bot.sendPhoto(chatId, imgPath, { caption: `🔢 شبكة الماوس جاهزة.\nأرسل رقم المربع (1-${session.lastGrid.totalCells}):` });
      fs.unlinkSync(imgPath);
      session.step = 'awaiting_grid_number';
      return;
    }
    
    if (data === 'browser_find_text_click') {
      session.step = 'awaiting_search_text';
      return bot.sendMessage(chatId, '🔍 أرسل النص للبحث والضغط عليه:');
    }
    
    if (data === 'browser_detect_verification_code') {
      session.expectingVerificationCode = true;
      session.step = null;
      return bot.sendMessage(chatId, '🔐 تم تفعيل وضع إدخال الكود.\nأرسل الكود الآن (الأرقام فقط):');
    }
    
    if (data === 'browser_toggle_timer') {
      if (!session.waitTimerStartedAt) {
        session.waitTimerStartedAt = Date.now();
        session.waitTimerPageUrl = session.page.url();
        return bot.sendMessage(chatId, '⏱️ تم بدء العداد.\nاضغط مرة أخرى للإيقاف.');
      } else {
        const duration = Date.now() - session.waitTimerStartedAt;
        session.recorder.add('Timer recorded', [
          `Duration: ${formatDuration(duration)}`,
          `Start URL: ${session.waitTimerPageUrl}`,
          `End URL: ${session.page.url()}`
        ]);
        session.waitTimerStartedAt = null;
        return bot.sendMessage(chatId, `⏱️ الوقت المسجل: ${formatDuration(duration)}`);
      }
    }
    
    if (data === 'browser_save_end') {
      const report = session.recorder ? session.recorder.finalize() : 'No report';
      const fileName = `session_${sanitizeFileName(chatId)}_${Date.now()}.txt`;
      const filePath = path.join(os.tmpdir(), fileName);
      fs.writeFileSync(filePath, report, 'utf8');
      
      await closeBrowserSession(chatId);
      await bot.sendDocument(chatId, filePath, {}, { filename: fileName, contentType: 'text/plain' });
      fs.unlinkSync(filePath);
      return bot.sendMessage(chatId, '💾 تم الحفظ والإنهاء.', { reply_markup: createHomeKeyboard(isAdmin(chatId), chatId) });
    }
    
  } catch (error) {
    console.error(error);
    return bot.sendMessage(chatId, `❌ خطأ: ${error.message}`);
  }
});

// --------------------------------------------------
// 10) Text Message Handler
// --------------------------------------------------
bot.on('message', async (msg) => {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  if (!text || text.startsWith('/')) return;
  
  const session = getSession(chatId);
  if (!session.page && !session.step && !session.expectingVerificationCode) return;
  
  try {
    // 2FA Code Input
    if (session.expectingVerificationCode) {
      const code = text.replace(/\D/g, ''); // Extract numbers only
      if (!code) return bot.sendMessage(chatId, '❌ أرسل الأرقام فقط.');
      
      const fillResult = await fillInputByLabelOrPlaceholder(session.page, code);
      
      if (fillResult.ok) {
        // Try to click Continue/Submit
        const buttons = ['Continue', 'Submit', 'Verify', 'Confirm', 'تأكيد', 'متابعة', 'تحقق'];
        let clicked = false;
        for (const btn of buttons) {
          const res = await findTextAndClick(session.page, btn);
          if (res.ok) { clicked = true; break; }
        }
        
        session.recorder.add('2FA Code entered', [
          `Code: ${code}`,
          `Submit clicked: ${clicked}`,
          `URL: ${session.page.url()}`
        ]);
        
        session.expectingVerificationCode = false;
        await sleep(2000); // Wait for page transition
        return sendScreenAndMenu(chatId, session.page, clicked ? 'Code Submitted' : 'Code Entered (Manual Submit Required)', 
          clicked ? '✅ تم إدخال الكود والضغط على متابعة' : '⚠️ تم إدخال الكود. يرجى الضغط على زر التأكيد يدوياً.');
      } else {
        return bot.sendMessage(chatId, '❌ لم أجد حقل إدخال الكود. استخدم شبكة الماوس للضغط على الحقل أولاً.');
      }
    }
    
    // URL Input
    if (session.step === 'awaiting_url') {
      session.step = null;
      let url = text;
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      
      await session.page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      await handleCookieBanner(session.page);
      session.recorder.add('Navigated to URL', [`URL: ${url}`, `Final: ${session.page.url()}`]);
      return sendScreenAndMenu(chatId, session.page, `Opened: ${session.page.url()}`, '🌐 تم فتح الرابط');
    }
    
    // Text Typing
    if (session.step === 'awaiting_text') {
      session.step = null;
      await typeLikeHuman(session.page, text);
      session.recorder.add('Typed text', [`Text: ${text}`, `URL: ${session.page.url()}`]);
      return sendScreenAndMenu(chatId, session.page, 'Text Typed', '✍️ تمت الكتابة');
    }
    
    // Delete Text
    if (session.step === 'awaiting_delete_count') {
      const count = parseInt(text);
      if (isNaN(count) || count <= 0) {
        return bot.sendMessage(chatId, '❌ أرسل رقماً صحيحاً.');
      }
      session.step = null;
      await deleteTextLikeHuman(session.page, count);
      session.recorder.add('Deleted text', [`Count: ${count}`]);
      return sendScreenAndMenu(chatId, session.page, 'Text Deleted', `⌫ تم حذف ${count} حرف`);
    }
    
    // Grid Click
    if (session.step === 'awaiting_grid_number') {
      const num = parseInt(text);
      if (!num || !session.lastGrid || num < 1 || num > session.lastGrid.totalCells) {
        return bot.sendMessage(chatId, `❌ أرسل رقماً بين 1 و ${session.lastGrid?.totalCells || '؟'}`);
      }
      session.step = null;
      const clickInfo = await clickGridCell(session.page, session.lastGrid, num);
      session.recorder.add('Grid click', [`Cell: ${num}`, `Coords: ${Math.round(clickInfo.x)},${Math.round(clickInfo.y)}`]);
      return sendScreenAndMenu(chatId, session.page, `Clicked Cell ${num}`, `✅ تم الضغط على المربع ${num}`);
    }
    
    // Search and Click
    if (session.step === 'awaiting_search_text') {
      session.step = null;
      const result = await findTextAndClick(session.page, text);
      if (result.ok) {
        session.recorder.add('Search & Click', [`Text: ${text}`, `Coords: ${Math.round(result.x)},${Math.round(result.y)}`]);
        return sendScreenAndMenu(chatId, session.page, `Clicked: ${text}`, `🔍 تم الضغط على: ${text}`);
      } else {
        return bot.sendMessage(chatId, '❌ لم أجد النص على الشاشة.');
      }
    }
    
  } catch (error) {
    console.error(error);
    session.step = null;
    session.expectingVerificationCode = false;
    return bot.sendMessage(chatId, `❌ خطأ: ${error.message}`);
  }
});

// --------------------------------------------------
// 11) Shutdown Handlers
// --------------------------------------------------
async function closeAllSessions() {
  for (const id in sessions) {
    try { await closeBrowserSession(id); } catch (_) {}
  }
}

process.on('SIGINT', async () => { await closeAllSessions(); process.exit(0); });
process.on('SIGTERM', async () => { await closeAllSessions(); process.exit(0); });
