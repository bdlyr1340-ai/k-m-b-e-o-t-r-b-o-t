/*
==========================================================
Telegram Browser Control Bot - Clean Minimal Edition
==========================================================
What this version keeps:
- Browser control only
- Admin-only direct computer mode
- Non-admin request -> admin approve/reject
- Browser buttons:
  1) Open URL
  2) Refresh Screen
  3) Enter
  4) Type Text
  5) Mouse Grid
  6) Search Text And Click
  7) Save And End Session
- ADMIN_ID is read from environment variables
- Detailed English TXT script is generated at session end

Required environment variables:
- BOT_TOKEN
- ADMIN_ID
Optional:
- PORT
- HEADLESS=true|false
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
// 1) Environment
// --------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || '').trim();
const PORT = Number(process.env.PORT || 3000);
const HEADLESS = String(process.env.HEADLESS || 'true').toLowerCase() !== 'false';

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in environment variables.');
  process.exit(1);
}

if (!ADMIN_ID) {
  console.error('Missing ADMIN_ID in environment variables.');
  process.exit(1);
}

// --------------------------------------------------
// 2) Keep-alive server (useful on Railway / similar)
// --------------------------------------------------
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Telegram Browser Control Bot is running.');
}).listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
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
/*
sessions[chatId] = {
  browser,
  context,
  page,
  step, // Current interaction step (e.g., awaiting_url, awaiting_text_to_type)
  lastGrid,
  recorder,
  approvedByAdmin,
  waitTimerStartedAt,
  waitTimerPageUrl,
  expectingVerificationCode // NEW: To handle 2FA/OTP screens
}
*/
const sessions = {};
const pendingComputerRequests = {}; // by requester chatId
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
      // --- إضافة جديدة: حالة لمعالجة كود التحقق ---
      expectingVerificationCode: false
      // ------------------------------------------
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

function safeUsername(msg) {
  return msg?.from?.username ? '@' + msg.from.username : 'No username';
}

function sanitizeFileName(name) {
  return String(name || 'session')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80);
}

function createKeyboard(isAdminUser) {
  const keyboard = [
    [{ text: 'فتح الرابط', callback_data: 'browser_open_url' }],
    [{ text: 'تحديث الشاشة', callback_data: 'browser_refresh' }],
    [{ text: 'انتر', callback_data: 'browser_enter' }],
    [{ text: 'كتابة نص', callback_data: 'browser_type_text' }],
    [{ text: 'حذف نص', callback_data: 'browser_delete_text' }],
    [{ text: 'نزول بسيط', callback_data: 'browser_scroll_down_small' }, { text: 'صعود بسيط', callback_data: 'browser_scroll_up_small' }],
    [{ text: 'نزول للنهاية', callback_data: 'browser_scroll_down_end' }, { text: 'صعود للنهاية', callback_data: 'browser_scroll_up_end' }],
    [{ text: 'شبكة الماوس', callback_data: 'browser_mouse_grid' }],
    [{ text: 'البحث عن النص والضغط عليه', callback_data: 'browser_find_text_click' }],
    // --- إضافة جديدة: زر لاكتشاف كود التحقق ---
    [{ text: 'اكتشاف كود التحقق', callback_data: 'browser_detect_verification_code' }],
    // ------------------------------------------
    [{ text: 'تسجيل الوقت', callback_data: 'browser_toggle_timer' }],
    [{ text: 'حفظ وانهاء الجلسة', callback_data: 'browser_save_end' }]
  ];

  return { inline_keyboard: keyboard };
}

function createHomeKeyboard(isAdminUser, chatId = '') {
  if (isAdminUser || approvedUsers[String(chatId)]) {
    return {
      inline_keyboard: [
        [{ text: 'وضع الكمبيوتر', callback_data: 'start_computer_mode' }]
      ]
    };
  }

  return {
    inline_keyboard: [
      [{ text: 'طلب وضع الكمبيوتر', callback_data: 'request_computer_mode' }]
    ]
  };
}

// --------------------------------------------------
// 6) Recorder
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
    this.lines.push('DETAILED BROWSER SESSION REPORT');
    this.lines.push('========================================');
    this.lines.push(`Started at: ${this.startedAt}`);
    this.lines.push(`Owner chat id: ${this.ownerChatId}`);
    this.lines.push('');
    this.lines.push('This file records the browser actions executed from the Telegram bot.');
    this.lines.push('All notes below are intentionally written in English and in a concise audit style.');
    this.lines.push('');
  }

  add(title, details = []) {
    const number = this.step++;
    this.lines.push(`STEP ${number}: ${title}`);
    for (const detail of details) {
      this.lines.push(`- ${detail}`);
    }
    this.lines.push('');
  }

  finalize() {
    this.lines.push('SESSION END');
    this.lines.push('========================================');
    this.lines.push(`Ended at: ${nowIso()}`);
    this.lines.push('');
    return this.lines.join('\n');
  }
}

// --------------------------------------------------
// 7) Browser session helpers
// --------------------------------------------------

// --- إضافة جديدة: معالجة شريط الكوكيز (Cookie Banner) ---
async function handleCookieBanner(page) {
  try {
    const acceptButtons = [
      'Accept all cookies',
      'Accept Cookies',
      'Accept',
      'Agree',
      'موافق', // Arabic
      'قبول', // Arabic
      'Got it',
      'Continue',
      'I understand',
      'Alle Cookies zulassen' // German
    ];

    for (const btnText of acceptButtons) {
      // Find buttons by text, case-insensitive, and ensure they are visible
      const button = page.locator(`button:has-text("${btnText}" i), a:has-text("${btnText}" i)`).first();
      
      // Check if button is visible and enabled
      if (await button.isVisible() && await button.isEnabled()) {
        console.log(`[Bot] Attempting to click cookie button: "${btnText}"`);
        await button.click({ timeout: 5000 }); // Click with a short timeout
        await sleep(1500); // Give time for banner to disappear
        return true;
      }
    }
    // Check for common "X" or "Close" buttons for banners
    const closeButton = page.locator('button[aria-label*="Close" i], button[title*="Close" i], [aria-label*="Close" i] svg').first();
    if (await closeButton.isVisible() && await closeButton.isEnabled()) {
        console.log("[Bot] Attempting to close cookie banner with 'X' button.");
        await closeButton.click({ timeout: 5000 });
        await sleep(1500);
        return true;
    }

  } catch (error) {
    // console.log(`[Bot] No cookie banner or failed to click: ${error.message}`);
  }
  return false;
}
// ----------------------------------------------------------

async function ensureBrowserSession(chatId) {
  const session = getSession(chatId);

  if (session.browser && session.context && session.page) {
    try {
      await session.page.title().catch(() => null);
      return session;
    } catch (_) {}
  }

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--lang=en-US,en', // Set language to English (or your preferred language)
      // '--proxy-server=http://your_proxy_ip:port' // Uncomment and configure if you need a proxy
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US' // Set context locale
  });

  const page = await context.newPage();
  await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 45000 }); // Changed to Google for a cleaner start

  // --- إضافة جديدة: معالجة شريط الكوكيز عند فتح المتصفح لأول مرة ---
  await handleCookieBanner(page);
  // ---------------------------------------------------------------

  session.browser = browser;
  session.context = context;
  session.page = page;
  session.step = null;
  session.lastGrid = null;
  session.recorder = new ScriptRecorder(chatId);
  session.waitTimerStartedAt = null;
  session.waitTimerPageUrl = null;
  session.expectingVerificationCode = false; // Reset state

  session.recorder.add('Browser session started', [
    `Initial URL opened: ${page.url()}`,
    `Viewport: 1440 x 900`,
    `Headless mode: ${HEADLESS}`
  ]);

  return session;
}

async function sendBrowserMenu(chatId, text = 'تم فتح وضع الكمبيوتر.') {
  return bot.sendMessage(chatId, text, {
    reply_markup: createKeyboard(isAdmin(chatId))
  });
}

async function sendPageScreenshot(chatId, page, caption = 'Current screen') {
  const filePath = path.join(os.tmpdir(), `screen_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
  await page.screenshot({ path: filePath, fullPage: false });
  await bot.sendPhoto(chatId, filePath, { caption });
  fs.unlinkSync(filePath);
}

async function sendScreenAndMenu(chatId, page, caption = 'Current screen', menuText = 'تم تنفيذ الأمر.') {
  await sendPageScreenshot(chatId, page, caption);
  return sendBrowserMenu(chatId, menuText);
}

async function closeBrowserSession(chatId) {
  const session = getSession(chatId);

  try { if (session.page) await session.page.close().catch(() => {}); } catch (_) {}
  try { if (session.context) await session.context.close().catch(() => {}); } catch (_) {}
  try { if (session.browser) await session.browser.close().catch(() => {}); } catch (_) {}

  session.browser = null;
  session.context = null;
  session.page = null;
  session.step = null;
  session.lastGrid = null;
  session.waitTimerStartedAt = null;
  session.waitTimerPageUrl = null;
  session.expectingVerificationCode = false; // Reset state
}

// --------------------------------------------------
// 8) Human-like actions
// --------------------------------------------------
async function typeLikeHuman(page, text) {
  for (const ch of String(text)) {
    await page.keyboard.type(ch, { delay: 60 + Math.floor(Math.random() * 70) });
    await sleep(20 + Math.floor(Math.random() * 60));
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

async function renderMouseGridAndScreenshot(page, outputPath, cols = 25, rows = 40) {
  const info = await getVisibleViewportSize(page);

  await page.evaluate(({ cols, rows }) => {
    const old = document.getElementById('__tg_mouse_grid_overlay__');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = '__tg_mouse_grid_overlay__';
    overlay.style.position = 'fixed';
    overlay.style.left = '0';
    overlay.style.top = '0';
    overlay.style.width = '100vw';
    overlay.style.height = '100vh';
    overlay.style.zIndex = '2147483647';
    overlay.style.pointerEvents = 'none';
    overlay.style.background = 'transparent';

    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const cellW = viewportW / cols;
    const cellH = viewportH / rows;

    let counter = 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = document.createElement('div');
        cell.style.position = 'absolute';
        cell.style.left = `${c * cellW}px`;
        cell.style.top = `${r * cellH}px`;
        cell.style.width = `${cellW}px`;
        cell.style.height = `${cellH}px`;
        cell.style.boxSizing = 'border-box';
        cell.style.border = '1px solid rgba(110, 110, 110, 0.45)';
        cell.style.background = 'rgba(140, 140, 140, 0.06)';

        const label = document.createElement('div');
        label.textContent = String(counter);
        label.style.position = 'absolute';
        label.style.left = '1px';
        label.style.top = '1px';
        label.style.padding = '0px 2px';
        label.style.fontSize = '8px';
        label.style.fontWeight = '700';
        label.style.color = '#2b2b2b';
        label.style.background = 'rgba(235, 235, 235, 0.45)';
        label.style.border = '1px solid rgba(80, 80, 80, 0.22)';
        label.style.borderRadius = '2px';
        label.style.lineHeight = '1.1';

        cell.appendChild(label);
        overlay.appendChild(cell);
        counter++;
      }
    }

    document.documentElement.appendChild(overlay);
  }, { cols, rows });

  await page.screenshot({ path: outputPath, fullPage: false });

  await page.evaluate(() => {
    const old = document.getElementById('__tg_mouse_grid_overlay__');
    if (old) old.remove();
  });

  return {
    cols,
    rows,
    viewportWidth: info.width,
    viewportHeight: info.height,
    scrollX: info.scrollX,
    scrollY: info.scrollY,
    totalCells: cols * rows
  };
}

function getCellCenter(grid, cellNumber) {
  const index = Number(cellNumber) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= grid.totalCells) {
    return null;
  }

  const col = index % grid.cols;
  const row = Math.floor(index / grid.cols);

  const cellWidth = grid.viewportWidth / grid.cols;
  const cellHeight = grid.viewportHeight / grid.rows;

  const x = col * cellWidth + cellWidth / 2;
  const y = row * cellHeight + cellHeight / 2;

  return {
    cellNumber: Number(cellNumber),
    col: col + 1,
    row: row + 1,
    x,
    y,
    absoluteX: grid.scrollX + x,
    absoluteY: grid.scrollY + y
  };
}

async function moveMouseLikeHuman(page, targetX, targetY) {
  const size = await getVisibleViewportSize(page);
  const startX = Math.max(8, Math.min(size.width - 8, size.width / 2));
  const startY = Math.max(8, Math.min(size.height - 8, size.height - 12));

  const steps = 28 + Math.floor(Math.random() * 18);

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const curve = t * t * (3 - 2 * t);
    const wobbleX = (Math.random() - 0.5) * 6;
    const wobbleY = (Math.random() - 0.5) * 6;

    const x = startX + (targetX - startX) * curve + wobbleX;
    const y = startY + (targetY - startY) * curve + wobbleY;

    await page.mouse.move(x, y);
    await sleep(8 + Math.floor(Math.random() * 22));
  }

  await page.mouse.move(targetX, targetY);
}

async function clickGridCell(page, grid, cellNumber) {
  const target = getCellCenter(grid, cellNumber);
  if (!target) {
    throw new Error(`Invalid grid cell number. Allowed range: 1 to ${grid.totalCells}`);
  }

  await moveMouseLikeHuman(page, target.x, target.y);
  await sleep(80 + Math.floor(Math.random() * 160));
  await page.mouse.click(target.x, target.y, { delay: 40 + Math.floor(Math.random() * 120) });
  return target;
}

async function findTextAndClick(page, searchText) {
  // Try Playwright's built-in text locators first, as they are robust
  const locators = [
    page.getByText(searchText, { exact: true }).first(),
    page.getByText(searchText).first(),
    page.locator(`text="${searchText}"`).first(), // Fallback to raw text selector
  ];

  for (const locator of locators) {
    try {
      // Ensure element is visible and enabled
      if (await locator.isVisible({ timeout: 2000 }) && await locator.isEnabled({ timeout: 2000 })) {
        await locator.scrollIntoViewIfNeeded().catch(() => {});
        await sleep(350);

        const box = await locator.boundingBox();
        if (!box) continue; // If no box, it's not truly visible/interactive

        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;

        await moveMouseLikeHuman(page, centerX, centerY);
        await sleep(100 + Math.floor(Math.random() * 150));
        await page.mouse.click(centerX, centerY, { delay: 40 + Math.floor(Math.random() * 120) });

        return {
          ok: true,
          text: searchText,
          x: centerX,
          y: centerY,
          width: box.width,
          height: box.height
        };
      }
    } catch (_) { /* continue to next locator or fallback */ }
  }

  // Fallback to a more generic DOM search (less reliable but covers more cases)
  const fallback = await page.evaluate((needle) => {
    const allElements = Array.from(document.querySelectorAll('button, a, span, div, p, li, input, textarea, label'));
    for (const el of allElements) {
      const textContent = (el.innerText || el.value || el.textContent || '').trim();
      const rect = el.getBoundingClientRect();
      
      // Check if text matches and element is reasonably visible/sized
      if (textContent && textContent.toLowerCase().includes(String(needle).toLowerCase()) && rect.width > 0 && rect.height > 0) {
        // Try to scroll into view if not already
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const scrolledRect = el.getBoundingClientRect(); // Get updated rect after scroll
        return {
          x: scrolledRect.left + scrolledRect.width / 2,
          y: scrolledRect.top + scrolledRect.height / 2,
          width: scrolledRect.width,
          height: scrolledRect.height
        };
      }
    }
    return null;
  }, searchText);

  if (!fallback) {
    return { ok: false };
  }

  await moveMouseLikeHuman(page, fallback.x, fallback.y);
  await sleep(100 + Math.floor(Math.random() * 150));
  await page.mouse.click(fallback.x, fallback.y, { delay: 50 + Math.floor(Math.random() * 120) });

  return {
    ok: true,
    text: searchText,
    x: fallback.x,
    y: fallback.y,
    width: fallback.width,
    height: fallback.height
  };
}

// --- إضافة جديدة: دالة لتعبئة حقول الإدخال بناءً على النص المجاور أو الـ placeholder ---
async function fillInputByLabelOrPlaceholder(page, identifyingText, valueToType) {
  // First, try by placeholder
  try {
    const inputByPlaceholder = page.locator(`input[placeholder*="${identifyingText}" i]`).first();
    if (await inputByPlaceholder.isVisible({ timeout: 1000 })) {
      await inputByPlaceholder.focus();
      await inputByPlaceholder.fill(''); // Clear existing value
      await typeLikeHuman(page, valueToType);
      return { ok: true, type: 'placeholder', locator: inputByPlaceholder };
    }
  } catch (e) {}

  // Then, try by associated label or parent text (more robust)
  try {
    const locator = page.locator(`input[aria-label*="${identifyingText}" i], input[id=(//label[contains(., "${identifyingText}") or contains(@for, "${identifyingText}") or contains(@for, "code") or contains(@for, "otp")]/@for)], input:has( + label:has-text("${identifyingText}" i)), input:below(label:has-text("${identifyingText}" i))`).first();
    if (await locator.isVisible({ timeout: 1000 })) {
      await locator.focus();
      await locator.fill('');
      await typeLikeHuman(page, valueToType);
      return { ok: true, type: 'label/parent', locator: locator };
    }
  } catch (e) {}

  // Generic input field near "code" text
  try {
    const locator = page.locator(`input[type="text"], input[type="number"], input[type="password"]`)
                       .filter({ hasText: /code|otp|رمز/i }) // Check if any nearby text contains these
                       .first();
    if (await locator.isVisible({ timeout: 1000 })) {
      await locator.focus();
      await locator.fill('');
      await typeLikeHuman(page, valueToType);
      return { ok: true, type: 'generic_nearby', locator: locator };
    }
  } catch (e) {}

  return { ok: false };
}
// -----------------------------------------------------------------------------------


async function deleteTextLikeHuman(page, count) {
  const total = Math.max(1, Number(count) || 1);
  for (let i = 0; i < total; i++) {
    await sleep(35 + Math.floor(Math.random() * 90));
    await page.keyboard.press('Backspace');
    await sleep(25 + Math.floor(Math.random() * 85));
  }
  return total;
}

async function scrollHumanSimple(page, deltaY) {
  const parts = 3 + Math.floor(Math.random() * 3);
  const base = deltaY / parts;
  for (let i = 0; i < parts; i++) {
    const delta = base + (Math.random() - 0.5) * 60;
    await page.mouse.wheel(0, delta);
    await sleep(90 + Math.floor(Math.random() * 160));
  }
}

async function scrollToExtreme(page, direction) {
  const down = direction === 'down';
  for (let i = 0; i < 18; i++) {
    await page.mouse.wheel(0, down ? 1200 : -1200);
    await sleep(100 + Math.floor(Math.random() * 120));
  }

  await page.evaluate((dir) => {
    if (dir === 'down') {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, direction).catch(() => {});
  await sleep(600);
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

// --------------------------------------------------
// 9) Start command
// --------------------------------------------------
bot.onText(/\/start/, async (msg) => {
  const chatId = String(msg.chat.id);
  await bot.sendMessage(chatId, 'اختر الخدمة:', {
    reply_markup: createHomeKeyboard(isAdmin(chatId), chatId)
  });
});

// --------------------------------------------------
// 10) Callback query handler
// --------------------------------------------------
bot.on('callback_query', async (query) => {
  const chatId = String(query.message.chat.id);
  const data = query.data;
  const session = getSession(chatId);

  await bot.answerCallbackQuery(query.id).catch(() => {});

  try {
    if (data === 'start_computer_mode') {
      if (!isAdmin(chatId) && !approvedUsers[String(chatId)]) {
        return bot.sendMessage(chatId, 'هذا الخيار يحتاج موافقة الأدمن أول مرة فقط.');
      }

      await ensureBrowserSession(chatId);
      return sendScreenAndMenu(chatId, session.page, 'Browser started successfully.', 'تم فتح وضع الكمبيوتر.');
    }

    if (data === 'request_computer_mode') {
      if (isAdmin(chatId) || approvedUsers[String(chatId)]) {
        await ensureBrowserSession(chatId);
        return sendScreenAndMenu(chatId, session.page, 'Browser started successfully.', 'تم فتح وضع الكمبيوتر.');
      }

      if (pendingComputerRequests[chatId]) {
        return bot.sendMessage(chatId, 'تم إرسال طلبك مسبقًا وهو بانتظار رد الأدمن.');
      }

      pendingComputerRequests[chatId] = {
        requesterChatId: chatId,
        name: `${query.from?.first_name || ''} ${query.from?.last_name || ''}`.trim() || 'Unknown',
        username: query.from?.username ? '@' + query.from.username : 'No username',
        createdAt: nowIso()
      };

      await bot.sendMessage(chatId, 'تم إرسال طلبك إلى الأدمن.');

      return bot.sendMessage(ADMIN_ID, [
        'شخصا طلب وضع الكمبيوتر!',
        `اسمه: ${pendingComputerRequests[chatId].name}`,
        `ايديه: ${chatId}`,
        `معرفه التليجرام: ${pendingComputerRequests[chatId].username}`
      ].join('\n'), {
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'موافقة', callback_data: `approve_computer_${chatId}` },
              { text: 'رفض', callback_data: `reject_computer_${chatId}` }
            ]
          ]
        }
      });
    }

    if (data.startsWith('approve_computer_')) {
      if (!isAdmin(chatId)) return;

      const requesterChatId = data.replace('approve_computer_', '');
      const request = pendingComputerRequests[requesterChatId];
      if (!request) {
        return bot.sendMessage(chatId, 'الطلب لم يعد موجودًا.');
      }

      const requesterSession = getSession(requesterChatId);
      requesterSession.approvedByAdmin = true;
      approvedUsers[String(requesterChatId)] = {
        approved: true,
        approvedAt: nowIso(),
        approvedBy: String(chatId)
      };
      saveApprovedUsers(approvedUsers);

      await ensureBrowserSession(requesterChatId);
      delete pendingComputerRequests[requesterChatId];

      await bot.sendMessage(requesterChatId, 'تمت الموافقة على طلبك لفتح وضع الكمبيوتر.');
      await sendScreenAndMenu(requesterChatId, requesterSession.page, 'Browser started after admin approval.', 'تم فتح وضع الكمبيوتر.');

      return bot.sendMessage(chatId, `تمت الموافقة على الطلب للمستخدم ${requesterChatId}.`);
    }

    if (data.startsWith('reject_computer_')) {
      if (!isAdmin(chatId)) return;

      const requesterChatId = data.replace('reject_computer_', '');
      if (pendingComputerRequests[requesterChatId]) {
        delete pendingComputerRequests[requesterChatId];
      }

      await bot.sendMessage(requesterChatId, 'تم رفض طلب وضع الكمبيوتر.');
      return bot.sendMessage(chatId, `تم رفض الطلب للمستخدم ${requesterChatId}.`);
    }

    // Guard: all browser actions require active page
    if (!session.page) {
      return bot.sendMessage(chatId, 'لا توجد جلسة متصفح فعالة. ابدأ وضع الكمبيوتر أولاً.');
    }

    if (data === 'browser_open_url') {
      session.step = 'awaiting_url';
      // --- إضافة جديدة: إعادة ضبط حالة انتظار الكود عند تغيير الرابط ---
      session.expectingVerificationCode = false; 
      // -------------------------------------------------------------
      return bot.sendMessage(chatId, 'أرسل الرابط الآن.');
    }

    if (data === 'browser_refresh') {
      session.recorder.add('Screen refreshed', [
        `Screenshot captured from URL: ${session.page.url()}`
      ]);
      return sendScreenAndMenu(chatId, session.page, 'Current browser screen', 'تم تحديث الشاشة.');
    }

    if (data === 'browser_enter') {
      await session.page.keyboard.press('Enter');
      session.recorder.add('Enter key pressed', [
        `Action executed on URL: ${session.page.url()}`
      ]);
      return sendScreenAndMenu(chatId, session.page, 'After pressing Enter', 'تم ضغط Enter.');
    }

    if (data === 'browser_type_text') {
      session.step = 'awaiting_text_to_type';
      return bot.sendMessage(chatId, 'أرسل النص الذي تريد كتابته حرفًا حرفًا.');
    }

    if (data === 'browser_delete_text') {
      session.step = 'awaiting_delete_text_count';
      return bot.sendMessage(chatId, 'أرسل عدد الأحرف التي تريد حذفها. مثال: 6');
    }

    if (data === 'browser_scroll_down_small') {
      await scrollHumanSimple(session.page, 700);
      session.recorder.add('Scrolled down slightly', [
        `Scroll direction: down`,
        `Scroll style: slight human-like scroll`,
        `Current URL: ${session.page.url()}`
      ]);
      return sendScreenAndMenu(chatId, session.page, 'After slight scroll down', 'تم النزول البسيط.');
    }

    if (data === 'browser_scroll_up_small') {
      await scrollHumanSimple(session.page, -700);
      session.recorder.add('Scrolled up slightly', [
        `Scroll direction: up`,
        `Scroll style: slight human-like scroll`,
        `Current URL: ${session.page.url()}`
      ]);
      return sendScreenAndMenu(chatId, session.page, 'After slight scroll up', 'تم الصعود البسيط.');
    }

    if (data === 'browser_scroll_down_end') {
      await scrollToExtreme(session.page, 'down');
      session.recorder.add('Scrolled to page bottom', [
        `Scroll direction: down`,
        `Scroll target: page bottom`,
        `Current URL: ${session.page.url()}`
      ]);
      return sendScreenAndMenu(chatId, session.page, 'Reached page bottom', 'تم النزول للنهاية.');
    }

    if (data === 'browser_scroll_up_end') {
      await scrollToExtreme(session.page, 'up');
      session.recorder.add('Scrolled to page top', [
        `Scroll direction: up`,
        `Scroll target: page top`,
        `Current URL: ${session.page.url()}`
      ]);
      return sendScreenAndMenu(chatId, session.page, 'Reached page top', 'تم الصعود للنهاية.');
    }

    if (data === 'browser_mouse_grid') {
      const imagePath = path.join(os.tmpdir(), `grid_${Date.now()}.png`);
      session.lastGrid = await renderMouseGridAndScreenshot(session.page, imagePath, 25, 40);
      await bot.sendPhoto(chatId, imagePath, {
        caption: `هذه شبكة الماوس.\nأرسل رقم المربع من 1 إلى ${session.lastGrid.totalCells} ليتم الضغط عليه.`
      });
      fs.unlinkSync(imagePath);
      session.step = 'awaiting_grid_cell_number';
      return;
    }

    if (data === 'browser_find_text_click') {
      session.step = 'awaiting_search_text';
      return bot.sendMessage(chatId, 'أرسل النص الذي تريد البحث عنه والضغط عليه.');
    }

    // --- إضافة جديدة: معالجة اكتشاف كود التحقق ---
    if (data === 'browser_detect_verification_code') {
      if (!session.page) {
        return bot.sendMessage(chatId, 'لا توجد جلسة متصفح فعالة.');
      }
      
      const pageContent = await session.page.content();
      const keywords = ['code', 'otp', 'verification', 'رمز', 'تحقق'];
      const foundKeyword = keywords.some(keyword => pageContent.toLowerCase().includes(keyword));

      if (foundKeyword) {
        session.expectingVerificationCode = true;
        session.step = null; // Clear any other step
        return bot.sendMessage(chatId, '✅ تم اكتشاف كلمات مفتاحية تشير إلى كود التحقق.\nالآن، أرسل لي الكود الذي وصلك عبر البريد الإلكتروني أو الرسائل النصية، وسأحاول إدخاله.');
      } else {
        return bot.sendMessage(chatId, '❌ لم يتم اكتشاف كلمات مفتاحية تشير إلى كود التحقق في الصفحة الحالية.');
      }
    }
    // ------------------------------------------

    if (data === 'browser_toggle_timer') {
      if (!session.page) {
        return bot.sendMessage(chatId, 'لا توجد جلسة متصفح فعالة.');
      }

      if (!session.waitTimerStartedAt) {
        session.waitTimerStartedAt = Date.now();
        session.waitTimerPageUrl = session.page.url();
        return sendScreenAndMenu(chatId, session.page, 'Timer started on current page', 'بدأ تسجيل الوقت لهذه الصفحة. اضغط الزر مرة ثانية عند انتهاء الانتظار.');
      }

      const endedAt = Date.now();
      const durationMs = endedAt - session.waitTimerStartedAt;
      const startedIso = new Date(session.waitTimerStartedAt).toISOString();
      const endedIso = new Date(endedAt).toISOString();
      const startUrl = session.waitTimerPageUrl || session.page.url();
      const endUrl = session.page.url();

      session.recorder.add('Manual waiting time recorded', [
        `Waiting started at: ${startedIso}`,
        `Waiting ended at: ${endedIso}`,
        `Total waiting duration: ${formatDuration(durationMs)}`,
        `URL at timer start: ${startUrl}`,
        `URL at timer stop: ${endUrl}`
      ]);

      session.waitTimerStartedAt = null;
      session.waitTimerPageUrl = null;

      return sendScreenAndMenu(chatId, session.page, 'Timer stopped on current page', `تم حفظ مدة الانتظار داخل السكربت: ${formatDuration(durationMs)}`);
    }

    if (data === 'browser_save_end') {
      if (session.recorder && session.waitTimerStartedAt) {
        const endedAt = Date.now();
        const durationMs = endedAt - session.waitTimerStartedAt;
        const startedIso = new Date(session.waitTimerStartedAt).toISOString();
        const endedIso = new Date(endedAt).toISOString();
        const startUrl = session.waitTimerPageUrl || (session.page ? session.page.url() : '');
        const endUrl = session.page ? session.page.url() : '';

        session.recorder.add('Manual waiting time recorded automatically at session end', [
          `Waiting started at: ${startedIso}`,
          `Waiting ended at: ${endedIso}`,
          `Total waiting duration: ${formatDuration(durationMs)}`,
          `URL at timer start: ${startUrl}`,
          `URL at timer stop: ${endUrl}`
        ]);

        session.waitTimerStartedAt = null;
        session.waitTimerPageUrl = null;
      }

      const report = session.recorder ? session.recorder.finalize() : 'No session report.';
      const fileName = `browser_session_${sanitizeFileName(chatId)}_${Date.now()}.txt`;
      const filePath = path.join(os.tmpdir(), fileName);
      fs.writeFileSync(filePath, report, 'utf8');

      await closeBrowserSession(chatId);
      await bot.sendDocument(chatId, filePath, {}, {
        filename: fileName,
        contentType: 'text/plain'
      });
      fs.unlinkSync(filePath);

      return bot.sendMessage(chatId, 'تم حفظ التقرير وإنهاء الجلسة.', {
        reply_markup: createHomeKeyboard(isAdmin(chatId), chatId)
      });
    }
  } catch (error) {
    console.error(`Error in callback query for chat ${chatId}:`, error);
    // Ensure the step is cleared on error
    if (session) {
      session.step = null;
      session.expectingVerificationCode = false;
    }
    return bot.sendMessage(chatId, `حدث خطأ: ${error.message}`);
  }
});

// --------------------------------------------------
// 11) Text message handler
// --------------------------------------------------
bot.on('message', async (msg) => {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  if (!text || text.startsWith('/')) {
    // If it's a command, let the command handler deal with it.
    // If it's empty, ignore.
    return;
  }

  const session = getSession(chatId);

  try {
    // --- إضافة جديدة: معالجة إدخال كود التحقق ---
    if (session.expectingVerificationCode) {
      if (!session.page) {
        session.expectingVerificationCode = false;
        return bot.sendMessage(chatId, 'لا توجد جلسة متصفح فعالة لإدخال الكود.');
      }

      const verificationCode = text;
      session.expectingVerificationCode = false; // Reset state immediately

      const fillResult = await fillInputByLabelOrPlaceholder(session.page, 'code', verificationCode);
      
      let clickResult = { ok: false };
      if (fillResult.ok) {
        // Try to click a "Continue", "Submit", "Verify" button after filling
        clickResult = await findTextAndClick(session.page, 'Continue');
        if (!clickResult.ok) { // Try other common submit texts
            clickResult = await findTextAndClick(session.page, 'Submit');
        }
        if (!clickResult.ok) {
            clickResult = await findTextAndClick(session.page, 'Verify');
        }
        if (!clickResult.ok) { // Arabic buttons
            clickResult = await findTextAndClick(session.page, 'متابعة');
        }
        if (!clickResult.ok) {
            clickResult = await findTextAndClick(session.page, 'إرسال');
        }
        if (!clickResult.ok) {
            clickResult = await findTextAndClick(session.page, 'تأكيد');
        }
      }

      if (fillResult.ok && clickResult.ok) {
        session.recorder.add('Verification code entered and submitted', [
          `Code entered: ${JSON.stringify(verificationCode)}`,
          `Submit button clicked: ${clickResult.text}`,
          `URL: ${session.page.url()}`
        ]);
        return sendScreenAndMenu(chatId, session.page, 'After code submission', 'تم إدخال الكود والضغط على زر المتابعة.');
      } else if (fillResult.ok) {
        session.recorder.add('Verification code entered, but submit button not clicked', [
          `Code entered: ${JSON.stringify(verificationCode)}`,
          `URL: ${session.page.url()}`
        ]);
        return sendScreenAndMenu(chatId, session.page, 'After code input', 'تم إدخال الكود بنجاح، ولكن لم يتم العثور على زر المتابعة. يرجى الضغط عليه يدوياً أو استخدام شبكة الماوس.');
      } else {
        session.recorder.add('Failed to enter verification code', [
          `Code attempted: ${JSON.stringify(verificationCode)}`,
          `URL: ${session.page.url()}`
        ]);
        return sendScreenAndMenu(chatId, session.page, 'Error inputting code', 'فشل في العثور على حقل إدخال الكود. يرجى المحاولة باستخدام شبكة الماوس أو تحديد الحقل يدوياً.');
      }
    }
    // -----------------------------------------------------

    if (session.step === 'awaiting_url') {
      if (!session.page) {
        session.step = null;
        return bot.sendMessage(chatId, 'لا توجد جلسة متصفح فعالة.');
      }

      session.step = null;
      const url = /^(https?:\/\/)/i.test(text) ? text : `https://${text}`;
      await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); // Increased timeout
      // --- إضافة جديدة: معالجة شريط الكوكيز بعد الانتقال إلى رابط جديد ---
      await handleCookieBanner(session.page);
      // ---------------------------------------------------------------
      session.recorder.add('URL opened', [
        `Requested URL: ${url}`,
        `Final loaded URL: ${session.page.url()}`
      ]);
      await sendPageScreenshot(chatId, session.page, `Opened URL:\n${session.page.url()}`);
      return sendBrowserMenu(chatId, 'تم فتح الرابط.');
    }

    if (session.step === 'awaiting_text_to_type') {
      if (!session.page) {
        session.step = null;
        return bot.sendMessage(chatId, 'لا توجد جلسة متصفح فعالة.');
      }

      session.step = null;
      await typeLikeHuman(session.page, text);
      session.recorder.add('Text typed like a human', [
        `Typed text: ${JSON.stringify(text)}`,
        'Typing mode: character by character',
        `Current URL: ${session.page.url()}`
      ]);
      return sendScreenAndMenu(chatId, session.page, 'After human-like typing', 'تمت الكتابة بشكل بشري حرفًا حرفًا.');
    }

    if (session.step === 'awaiting_search_text') {
      if (!session.page) {
        session.step = null;
        return bot.sendMessage(chatId, 'لا توجد جلسة متصفح فعالة.');
      }

      session.step = null;
      const result = await findTextAndClick(session.page, text);
      if (!result.ok) {
        session.recorder.add('Text search failed', [
          `Requested text: ${JSON.stringify(text)}`,
          `Current URL: ${session.page.url()}`
        ]);
        return sendScreenAndMenu(chatId, session.page, 'Text search failed on current screen', 'لم أجد النص المطلوب على الشاشة الحالية.');
      }

      session.recorder.add('Text searched and clicked', [
        `Requested text: ${JSON.stringify(text)}`,
        `Clicked center coordinates: (${result.x.toFixed(2)}, ${result.y.toFixed(2)})`,
        `Element size: ${result.width.toFixed(2)} x ${result.height.toFixed(2)}`,
        `Current URL: ${session.page.url()}`
      ]);

      return sendScreenAndMenu(chatId, session.page, `Clicked: ${text}`, `تم العثور على النص والضغط عليه:\n${text}`);
    }
    
    if (session.step === 'awaiting_delete_text_count') {
      if (!session.page) {
        session.step = null;
        return bot.sendMessage(chatId, 'لا توجد جلسة متصفح فعالة.');
      }
      const count = Number(text);
      if (isNaN(count) || count <= 0) {
        return bot.sendMessage(chatId, 'الرجاء إرسال عدد صحيح موجب.');
      }
      session.step = null;
      await deleteTextLikeHuman(session.page, count);
      session.recorder.add('Text deleted like a human', [
        `Number of characters deleted: ${count}`,
        `Current URL: ${session.page.url()}`
      ]);
      return sendScreenAndMenu(chatId, session.page, 'After deleting text', `تم حذف ${count} حرفًا.`);
    }

    if (session.step === 'awaiting_grid_cell_number') {
      if (!session.page || !session.lastGrid) {
        session.step = null;
        return bot.sendMessage(chatId, 'لا توجد شبكة نشطة الآن.');
      }

      const num = Number(String(text).replace(/[^\d]/g, ''));
      if (!num || num < 1 || num > session.lastGrid.totalCells) {
        return bot.sendMessage(chatId, `أرسل رقم مربع صحيح بين 1 و ${session.lastGrid.totalCells}.`);
      }

      session.step = null;
      const clickInfo = await clickGridCell(session.page, session.lastGrid, num);

      session.recorder.add('Mouse grid cell clicked', [
        `Selected grid cell number: ${clickInfo.cellNumber}`,
        `Grid row: ${clickInfo.row}`,
        `Grid column: ${clickInfo.col}`,
        `Viewport coordinates clicked: (${clickInfo.x.toFixed(2)}, ${clickInfo.y.toFixed(2)})`,
        `Absolute screen coordinates relative to page viewport and scroll: (${clickInfo.absoluteX.toFixed(2)}, ${clickInfo.absoluteY.toFixed(2)})`,
        `Grid layout: ${session.lastGrid.cols} columns x ${session.lastGrid.rows} rows`,
        `Current URL: ${session.page.url()}`
      ]);

      return sendScreenAndMenu(
        chatId,
        session.page,
        `Clicked grid cell ${clickInfo.cellNumber}`,
        [
          'تم الضغط على المربع بنجاح.',
          `رقم المربع: ${clickInfo.cellNumber}`,
          `الإحداثيات داخل الشاشة: (${Math.round(clickInfo.x)}, ${Math.round(clickInfo.y)})`
        ].join('\n')
      );
    }

    // --- إذا لم يطابق أي من الحالات أعلاه، فقد تكون رسالة عادية لا تتطلب تفاعلاً خاصاً ---
    // يمكنك إضافة منطق للتعامل مع الرسائل العادية هنا إذا لزم الأمر
    // For now, if no step is active, just ignore.
    if (!session.step && !session.expectingVerificationCode) {
      console.log(`[Bot] Received unhandled message from ${chatId}: "${text}"`);
      // Optionally, send a message back:
      // return bot.sendMessage(chatId, 'لم أفهم طلبك. الرجاء استخدام الأزرار أو بدء مهمة محددة.', {
      //   reply_markup: createKeyboard(isAdmin(chatId))
      // });
    }
    // ---------------------------------------------------------------------------------

  } catch (error) {
    console.error(`Error in message handler for chat ${chatId}:`, error);
    // Ensure step and verification state are cleared on error
    if (session) {
      session.step = null;
      session.expectingVerificationCode = false;
    }
    return bot.sendMessage(chatId, `حدث خطأ: ${error.message}`);
  }
});

// --------------------------------------------------
// 12) Clean shutdown
// --------------------------------------------------
async function closeAllSessions() {
  const ids = Object.keys(sessions);
  for (const id of ids) {
    try {
      await closeBrowserSession(id);
    } catch (_) {}
  }
}

process.on('SIGINT', async () => {
  console.log('SIGINT received. Closing all browser sessions...');
  await closeAllSessions();
  console.log('All sessions closed. Exiting.');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Closing all browser sessions...');
  await closeAllSessions();
  console.log('All sessions closed. Exiting.');
  process.exit(0);
});

process.on('uncaughtException', async (err) => {
  console.error('uncaughtException:', err);
  // Optionally, try to close sessions even on uncaught exceptions
  // await closeAllSessions();
  // process.exit(1);
});

process.on('unhandledRejection', async (err) => {
  console.error('unhandledRejection:', err);
});
