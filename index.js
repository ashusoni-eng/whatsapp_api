require("dotenv").config();
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());

const port = process.env.PORT || 3000;
// WhatsApp logs out clients running a stale web version, which shows up as a
// scan-then-immediately-LOGOUT loop that survives wiping .wwebjs_auth. The
// previously pinned 2.2412.54 (Dec 2024) was eventually deleted upstream and
// its remotePath started 404ing. Upstream prunes old builds steadily, so any
// hard-coded pin rots; default to whatever WhatsApp itself serves, and set
// WWEB_VERSION only to hold back a specific build from wppconnect-team/
// wa-version if a future WhatsApp change breaks this library version.
const wwebVersion = process.env.WWEB_VERSION || null;
const QUEUE_FILE = path.join(__dirname, "queue.json");

// If "authenticated" fires but "ready" does not within this window, the client
// is stuck (the classic puppeteer sync hang). We exit so PM2 restarts clean.
// Kept generous: on a CPU-throttled host the initial WhatsApp Web sync is slow,
// and a too-eager restart just burns more CPU booting Chromium again.
const READY_TIMEOUT_MS = (Number(process.env.READY_TIMEOUT_SEC) || 360) * 1000;
const DISK_CACHE_BYTES = 100 * 1024 * 1024; // cap Chromium's disk caches
const PROTOCOL_TIMEOUT_MS = 240 * 1000; // puppeteer default is 180s
const FLUSH_INTERVAL_MS = 30 * 1000; // periodically retry pending messages
const MAX_ATTEMPTS = 5;
// One sick send costs up to PROTOCOL_TIMEOUT_MS. Without a budget a single
// flush pass walks the whole backlog at that price - 19 pending messages meant
// 76 minutes of grinding during which nothing else could send, and every one
// of those minutes was CPU this host does not have. Cap the pass and stop
// early once it is clear the browser, not the recipient, is the problem.
const FLUSH_BUDGET_MS = 5 * 60 * 1000;
// WhatsApp Web mirrors chat history into the browser's IndexedDB, and that
// store is what grows without bound - 236MB here, which is what pushed this
// host into swap. Nothing in this service reads stored history (inbound
// messages are handled live on the `message` event), so the local copy is
// pure cost. Wipe it on a schedule and the store stays flat forever.
// CHAT_KEEP_HOURS=0 keeps nothing, which is the point; set it higher to
// retain recent chats instead.
const CHAT_SWEEP_INTERVAL_MS =
  (Number(process.env.CHAT_SWEEP_HOURS) || 24) * 60 * 60 * 1000;
const CHAT_KEEP_MS = (Number(process.env.CHAT_KEEP_HOURS) || 0) * 60 * 60 * 1000;
const CHAT_SWEEP_DELAY_MS = 15 * 60 * 1000; // let the client settle after boot
const CHAT_SWEEP_PAUSE_MS = 250; // breathe between deletions
// A browser parked on a login screen still costs a browser. Nobody is going to
// scan a QR at 4am, so don't hold one open all night - exit 0 and let PM2 stop
// the app (see stop_exit_codes in ecosystem.config.js) until someone is there
// to scan. On a host this starved, idling is how the CPU budget recovers.
const QR_IDLE_MS = (Number(process.env.QR_IDLE_MINUTES) || 20) * 60 * 1000;
// A first sweep against a large backlog can run for a long time on a slow
// host. Bound it so it can never overlap its own next cycle or monopolise the
// browser, and let the remainder fall to the following pass - the work is
// idempotent, so stopping early simply means finishing later.
const CHAT_SWEEP_BUDGET_MS = 30 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 3;

// Terminal entries are history, not work. Keep them long enough to be useful
// then drop them: queue.json is rewritten on every send, so its size is a
// running I/O cost, and nothing ever removed failed entries before.
const SENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

// AI insights bot: inbound messages are forwarded to our backend, which decides
// if the sender is a registered clinic user and returns a reply to send back.
const INSIGHTS_URL = process.env.INSIGHTS_URL; // e.g. http://127.0.0.1:3000
const INSIGHTS_API_KEY = process.env.INSIGHTS_API_KEY;

// Nothing in this browser is ever looked at by a human - it exists only to
// drive WhatsApp Web's send path. Decoding avatars and thumbnails, running
// translate/sync/telemetry and spreading across renderer processes is all
// waste, and on a 1GB box that waste is what pushes Chromium into swap. The
// swapping is in turn what burns the CPU budget. Set LEAN_BROWSER=0 to opt
// back into a stock browser if something here ever proves load-bearing.
const LEAN_BROWSER = process.env.LEAN_BROWSER !== "0";

const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  // Chromium's on-disk caches are uncapped by default. Left alone they grew
  // to 1.4GB here, and managing that much cache on a 1GB box thrashes into
  // swap until operations exceed protocolTimeout and the client never
  // reaches `ready`. Cap them so the working set stays small.
  `--disk-cache-size=${DISK_CACHE_BYTES}`,
  `--media-cache-size=${DISK_CACHE_BYTES}`,
];

if (LEAN_BROWSER) {
  BROWSER_ARGS.push(
    // NOT included here: --blink-settings=imagesEnabled=false. It was the
    // biggest memory saving on paper and it broke sending outright. WhatsApp
    // Web builds a thumbnail for outgoing media by decoding it through an
    // Image element; with decoding disabled that load event never fires, the
    // page-side promise never settles, and every media send dies on
    // protocolTimeout - which reads exactly like the CPU starvation we were
    // chasing, while the CPU sits idle. Keep images on.
    "--renderer-process-limit=1",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-client-side-phishing-detection",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-translate",
    "--disable-accelerated-2d-canvas",
    "--disable-software-rasterizer",
    "--disable-breakpad",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check"
  );
}

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true, // IMPORTANT: never depend on a display (DISPLAY=:0) on a server
    // Chromium's on-disk caches are uncapped by default. Left alone they grew
    // to 1.4GB here, and managing that much cache on a 1GB box thrashes into
    // swap until operations exceed protocolTimeout and the client never
    // reaches `ready`. Cap them so the working set stays small.
    args: BROWSER_ARGS,
    // A swapping browser can take minutes to answer. Fail slower than the
    // default so a brief stall doesn't kill an otherwise healthy send; the
    // ready-timeout and liveness probe below still catch a truly dead tab.
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
  },
  ...(wwebVersion
    ? {
        webVersionCache: {
          type: "remote",
          remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${wwebVersion}.html`,
        },
      }
    : {}),
});

/* ------------------- PERSISTENT QUEUE ------------------- */
// Each entry: { id, type:'text'|'media', formatnum, groupName, message, fileUrl,
//               pdfName, status:'pending'|'sent'|'failed', attempts, createdAt,
//               sentAt, failedAt, error }
//
// `formatnum` is the WhatsApp chat id: "91XXXXXXXXXX@c.us" for a person,
// "1234567890-1234567890@g.us" or "1203630XXXXXXXXXX@g.us" for a group. When a
// group is addressed by name instead, `groupName` is set and `formatnum` stays
// null until the name is resolved at send time — resolving needs a live client,
// which is exactly what the queue exists to wait for.
let queue = [];

const loadQueue = () => {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      queue = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8")) || [];
    }
  } catch (err) {
    console.error("Failed to read queue file, starting empty:", err);
    queue = [];
  }
};

const saveQueue = () => {
  try {
    const tmp = QUEUE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(queue, null, 2));
    fs.renameSync(tmp, QUEUE_FILE); // atomic write
  } catch (err) {
    console.error("Failed to write queue file:", err);
  }
};

// A terminal entry ages from the moment it reached that state. Entries written
// before `failedAt` existed only have `createdAt`, so fall back to it.
const terminalAt = (item) =>
  Date.parse(item.failedAt || item.sentAt || item.createdAt);

// Pending entries are the work still to do and are never pruned. Sent and
// failed entries are dropped once past their retention window.
const pruneQueue = () => {
  const now = Date.now();
  const before = queue.length;
  queue = queue.filter((item) => {
    if (item.status === "pending") return true;
    const retention =
      item.status === "failed" ? FAILED_RETENTION_MS : SENT_RETENTION_MS;
    const at = terminalAt(item);
    // An entry with an unparseable timestamp can never age out, so drop it
    // rather than let it accumulate forever.
    return Number.isFinite(at) && now - at < retention;
  });
  const dropped = before - queue.length;
  if (dropped) {
    saveQueue();
    console.log(`Pruned ${dropped} old queue entries, ${queue.length} remain`);
  }
  return dropped;
};

const enqueue = (entry) => {
  const item = {
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    status: "pending",
    attempts: 0,
    createdAt: new Date().toISOString(),
    sentAt: null,
    failedAt: null,
    error: null,
    ...entry,
  };
  queue.push(item);
  saveQueue();
  return item;
};

/* ------------------- GROUPS ------------------- */
const isGroupId = (chatId = "") => chatId.endsWith("@g.us");

// Group ids never change, but `getChats()` walks every conversation, so a
// resolved name is cached for the life of the process. Key is the lowercased
// group subject.
const groupIdByName = new Map();

// Groups read straight out of WhatsApp's in-page chat collection.
//
// `client.getChats()` (window.WWebJS.getChats) builds a full model for *every*
// conversation, and for each group it awaits `Store.GroupMetadata.update()` and
// walks `groupMetadata.participants._models`. Any one of those throwing kills
// the whole call — which is where the bare minified "r" comes from. Reading the
// collection and filtering on `id.server === 'g.us'` skips all of it.
//
// Returns { groups, diag }. `diag` describes what was actually found on the
// page, so a failure reports facts instead of a guess.
const listGroupsFromStore = async () => {
  if (!client.pupPage) throw new Error("Browser page not available");

  return client.pupPage.evaluate(() => {
    const diag = {
      hasStore: typeof window.Store,
      hasWWebJS: typeof window.WWebJS,
      storeKeyCount: window.Store ? Object.keys(window.Store).length : 0,
      // Which of the plausible chat collections are actually present.
      candidates: {},
      pageUrl: location.href,
      error: null,
    };

    // The modern store, the legacy (moduleRaid) store, and the raw module, in
    // the order they're worth trying.
    const sources = {
      "Store.Chat": window.Store && window.Store.Chat,
      "Store.Conn.chats": window.Store && window.Store.Conn && window.Store.Conn.chats,
      "WWebJS.Chat": window.WWebJS && window.WWebJS.Chat,
    };

    let models = null;
    let usedSource = null;

    for (const [label, collection] of Object.entries(sources)) {
      if (!collection) {
        diag.candidates[label] = "missing";
        continue;
      }
      try {
        const arr =
          typeof collection.getModelsArray === "function"
            ? collection.getModelsArray()
            : collection.models || null;
        diag.candidates[label] = Array.isArray(arr) ? `${arr.length} models` : typeof arr;
        if (Array.isArray(arr) && !models) {
          models = arr;
          usedSource = label;
        }
      } catch (e) {
        diag.candidates[label] = `threw: ${String((e && e.message) || e)}`;
      }
    }

    if (!models) return { groups: null, diag };

    diag.source = usedSource;
    diag.totalChats = models.length;

    try {
      const groups = models
        .filter((m) => {
          const id = m && m.id;
          if (!id) return false;
          // Cover both the object id and the "…@g.us" string form.
          return id.server === "g.us" || String(id._serialized || id).endsWith("@g.us");
        })
        .map((m) => {
          let participants = null;
          try {
            const p = m.groupMetadata && m.groupMetadata.participants;
            participants = p ? p.length || (p._models && p._models.length) || null : null;
          } catch (_) {
            participants = null;
          }
          return {
            id: String(m.id._serialized || m.id),
            name: m.name || m.formattedTitle || m.subject || "(unnamed group)",
            participants,
          };
        });
      return { groups, diag };
    } catch (e) {
      diag.error = String((e && e.message) || e);
      return { groups: null, diag };
    }
  });
};

// All group chats this account is a member of. Tries the library's own call
// first and falls back to the raw collection when it blows up.
//
// Throws a `diag`-carrying error when neither works, so the route can show what
// was on the page rather than a bare message.
const listGroups = async () => {
  try {
    const chats = await client.getChats();
    return chats
      .filter((chat) => chat.isGroup)
      .map((chat) => ({
        id: chat.id._serialized,
        name: chat.name,
        participants: chat.participants ? chat.participants.length : null,
      }));
  } catch (err) {
    console.warn(
      `getChats() failed (${err.message}) — reading groups from the chat collection instead`
    );
    const { groups, diag } = await listGroupsFromStore();
    if (!groups) {
      const error = new Error("Could not read the chat collection");
      error.diag = diag;
      throw error;
    }
    console.log(
      `Read ${groups.length} group(s) from ${diag.source} (${diag.totalChats} chats total)`
    );
    return groups;
  }
};

// Group name -> chat id. Names aren't unique on WhatsApp; if two groups share a
// subject this takes the first, which is why the id is the preferred input and
// /groups exists to look it up once.
const resolveGroupId = async (name) => {
  const key = (name || "").trim().toLowerCase();
  if (!key) return null;
  if (groupIdByName.has(key)) return groupIdByName.get(key);

  const groups = await listGroups();
  for (const group of groups) {
    groupIdByName.set((group.name || "").toLowerCase(), group.id);
  }
  return groupIdByName.get(key) || null;
};

// Build the actual WhatsApp payload for an entry and send it.
const sendEntry = async (item) => {
  // A group addressed by name is resolved here rather than at enqueue time —
  // the lookup needs a ready client, and the queue is what waits for one.
  if (!item.formatnum && item.groupName) {
    const groupId = await resolveGroupId(item.groupName);
    if (!groupId) {
      item.status = "failed";
      item.failedAt = new Date().toISOString();
      item.error = `Group not found: ${item.groupName}`;
      return false;
    }
    item.formatnum = groupId;
  }

  // `isRegisteredUser` only answers for phone numbers — asking it about a group
  // id returns false and would drop every group message as "not registered".
  if (!isGroupId(item.formatnum)) {
    const isRegistered = await client.isRegisteredUser(item.formatnum);
    if (!isRegistered) {
      item.status = "failed";
      item.failedAt = new Date().toISOString();
      item.error = "Not registered on WhatsApp";
      return false;
    }
  }

  if (item.type === "media" && item.fileUrl) {
    const media = await MessageMedia.fromUrl(item.fileUrl);

    // A single-page app answers a missing asset with its own index.html and a
    // 200, so the download "succeeds" and hands back markup. The override
    // below judges type by file extension, so that HTML gets relabelled as a
    // PNG and sent - and WhatsApp rejects it with an error minified to "t",
    // five retries and one undelivered message later. The text is the part
    // that carries the information, so send it rather than nothing.
    if (/^text\/html/i.test(media.mimetype || "")) {
      console.warn(
        `${item.id}: ${item.fileUrl} served HTML, not a file - sending text only`
      );
      if (item.message) {
        await client.sendMessage(item.formatnum, item.message);
        return true;
      }
      item.status = "failed";
      item.failedAt = new Date().toISOString();
      item.error = `fileUrl served text/html, not a file: ${item.fileUrl}`;
      return false;
    }

    // Judge the type by the file path, not the whole URL: Healthixio links are
    // signed and end in ?exp=...&sig=..., so endsWith(".pdf") on the URL failed
    // and every PDF went out labelled as an image (WhatsApp rejected it).
    let filePath = item.fileUrl;
    try { filePath = new URL(item.fileUrl).pathname; } catch (_) {}
    if (filePath.toLowerCase().endsWith(".pdf") || media.mimetype === "application/pdf") {
      media.mimetype = "application/pdf";
      media.filename = item.pdfName || "document.pdf";
    } else {
      media.mimetype = "image/png";
      media.filename = "media.jpg";
    }
    await client.sendMessage(item.formatnum, media, { caption: item.message });
  } else {
    await client.sendMessage(item.formatnum, item.message);
  }
  return true;
};

// A detached frame / closed page means the underlying Chromium tab is dead.
// No amount of retrying recovers it — only a fresh process does. We detect
// these strings and exit so PM2 restarts clean.
const isFatalBrowserError = (msg = "") =>
  /detached Frame|Session closed|Target closed|Protocol error|Execution context was destroyed/i.test(
    msg
  );

let flushing = false;
const flushQueue = async () => {
  if (flushing || !client.isReady) return;
  flushing = true;
  try {
    const pending = queue.filter((q) => q.status === "pending");
    const startedAt = Date.now();
    let consecutiveFailures = 0;
    for (const item of pending) {
      if (!client.isReady) break; // client died mid-flush; stop, retry later
      if (Date.now() - startedAt > FLUSH_BUDGET_MS) {
        console.warn(
          `Flush budget spent; leaving the rest pending for the next pass`
        );
        break;
      }
      item.attempts += 1;
      try {
        const ok = await sendEntry(item);
        if (ok) {
          item.status = "sent";
          item.sentAt = new Date().toISOString();
          consecutiveFailures = 0;
          console.log(`Sent queued message ${item.id} to ${item.formatnum}`);
        } else {
          console.log(`Dropping ${item.id}: ${item.error}`);
        }
      } catch (err) {
        item.error = err.message;
        if (isFatalBrowserError(err.message)) {
          // The browser tab is gone. Don't waste retries — keep this message
          // pending (roll back the attempt) and exit so PM2 restarts fresh.
          item.attempts -= 1;
          saveQueue();
          console.error("Fatal browser error, exiting for clean restart:", err.message);
          process.exit(1);
        }
        if (item.attempts >= MAX_ATTEMPTS) {
          item.status = "failed";
          item.failedAt = new Date().toISOString();
          console.error(`Giving up on ${item.id} after ${item.attempts} tries:`, err.message);
        } else {
          console.warn(`Send failed for ${item.id} (attempt ${item.attempts}), will retry:`, err.message);
        }
        // A bad number fails on its own; the browser being unwell fails every
        // message in a row. Treat a run of failures as the latter and stop,
        // rather than paying the timeout again for each message behind it.
        if ((consecutiveFailures += 1) >= MAX_CONSECUTIVE_FAILURES) {
          saveQueue();
          console.error(
            `${consecutiveFailures} sends failed in a row; pausing this flush pass`
          );
          break;
        }
      }
      saveQueue();
    }
    pruneQueue();
  } finally {
    flushing = false;
  }
};

/* ------------------- READY WATCHDOG ------------------- */
let readyWatchdog = null;
const armWatchdog = () => {
  clearTimeout(readyWatchdog);
  readyWatchdog = setTimeout(() => {
    if (!client.isReady) {
      console.error(
        `Authenticated but NOT ready after ${READY_TIMEOUT_MS / 1000}s. Exiting for clean restart.`
      );
      process.exit(1); // PM2 restarts a fresh process
    }
  }, READY_TIMEOUT_MS);
};

/* ------------------- CLIENT EVENT HANDLERS ------------------- */
/* ------------------- CHAT / MEDIA RETENTION ------------------- */
// Deliberately not client.getChats(): that serializes every chat in full
// (contacts, last message, labels) across the CDP bridge, which is exactly the
// kind of work this host cannot afford. Read the three fields we need straight
// off the in-page collection instead.
const listChatsLite = () =>
  client.pupPage.evaluate(() => {
    const chats = window.require("WAWebCollections").Chat.getModelsArray();
    return chats
      .map((c) => ({
        id: c.id && c.id._serialized,
        t: c.t || 0,
        isGroup: !!c.isGroup,
      }))
      .filter((c) => c.id);
  });

// Both of these are local-only - the same as "Clear chat" / "Delete chat" in
// the app. The recipient keeps their copy, so clearing our side never costs
// anyone the report we sent them.
let sweeping = false;
const sweepChats = async () => {
  // The cycle timer and the manual endpoint can both land here. Two sweeps
  // walking the same chat list at once is pure duplicated work, and on this
  // host duplicated work is what the whole exercise is trying to avoid.
  if (sweeping || !client.isReady) return 0;
  sweeping = true;
  try {
    return await runChatSweep();
  } finally {
    sweeping = false;
  }
};

const runChatSweep = async () => {
  let chats;
  try {
    chats = await listChatsLite();
  } catch (err) {
    console.warn("Chat sweep: could not list chats:", err.message);
    return 0;
  }

  const cutoff = CHAT_KEEP_MS
    ? Math.floor((Date.now() - CHAT_KEEP_MS) / 1000)
    : Infinity;
  const stale = chats.filter((c) => c.t < cutoff);
  if (!stale.length) {
    console.log(`Chat sweep: nothing to clear (${chats.length} chats)`);
    return 0;
  }

  let swept = 0;
  const startedAt = Date.now();
  for (const chat of stale) {
    if (!client.isReady) break; // don't fight a dying browser
    if (Date.now() - startedAt > CHAT_SWEEP_BUDGET_MS) {
      console.warn(
        `Chat sweep: budget spent after ${swept}/${stale.length}; resuming next cycle`
      );
      break;
    }
    // Sending is the product; clearing old chats is housekeeping. A sweep
    // holds the browser long enough to time a send out, so the moment real
    // work shows up, stand down. The unswept chats keep until the next cycle;
    // a late report does not keep.
    const waiting = queue.filter((q) => q.status === "pending").length;
    if (waiting) {
      console.log(
        `Chat sweep: yielding to ${waiting} pending message(s) after ${swept}/${stale.length}`
      );
      break;
    }
    try {
      await client.pupPage.evaluate(
        (id, isGroup) =>
          // Deleting a group chat would drop us out of a group we still need
          // to send to, so groups get their messages cleared instead.
          isGroup
            ? window.WWebJS.sendClearChat(id)
            : window.WWebJS.sendDeleteChat(id),
        chat.id,
        chat.isGroup
      );
      swept += 1;
    } catch (err) {
      console.warn(`Chat sweep: ${chat.id} failed:`, err.message);
    }
    await new Promise((r) => setTimeout(r, CHAT_SWEEP_PAUSE_MS));
  }

  console.log(`Chat sweep: cleared ${swept}/${stale.length} chats`);
  return swept;
};

let qrIdleTimer = null;
client.on("qr", (qr) => {
  console.log("Client QR Code:");
  qrcode.generate(qr, { small: true });
  // The QR rotates every ~50s and this fires each time; arm the deadline once,
  // on the first one, so it measures how long nobody has scanned rather than
  // how long since the last refresh.
  if (!qrIdleTimer) {
    qrIdleTimer = setTimeout(() => {
      console.error(
        `No scan after ${QR_IDLE_MS / 60000} minutes. Stopping rather than ` +
          `holding a browser open on a login screen. Start again when ready to scan.`
      );
      process.exit(0);
    }, QR_IDLE_MS);
  }
});

client.on("authenticated", () => {
  console.log("Client authenticated!");
  clearTimeout(qrIdleTimer);
  armWatchdog(); // start the stuck-detection timer
});

let chatSweepTimer = null;
client.on("ready", () => {
  console.log("Client is ready!");
  client.isReady = true;
  clearTimeout(readyWatchdog);
  flushQueue();
  // Sweep shortly after boot, then on a cycle. The delay keeps this off the
  // CPU while WhatsApp Web is still doing its initial sync.
  if (!chatSweepTimer) {
    setTimeout(() => {
      sweepChats().catch((e) => console.warn("Chat sweep failed:", e.message));
      chatSweepTimer = setInterval(
        () => sweepChats().catch((e) => console.warn("Chat sweep failed:", e.message)),
        CHAT_SWEEP_INTERVAL_MS
      );
    }, CHAT_SWEEP_DELAY_MS);
  }
});

client.on("auth_failure", (msg) => {
  console.error("Client authentication failed:", msg);
  process.exit(1); // restart clean
});

client.on("disconnected", (reason) => {
  console.log("Client disconnected:", reason);
  client.isReady = false;
  process.exit(1); // let PM2 bring up a fresh, clean session
});

/* ------------------- GROUP ID DISCOVERY ------------------- */
// Every message carries the id of the chat it belongs to, and that needs no
// access to WhatsApp's in-page store — which is exactly what `/groups` depends
// on and what currently isn't injected on this build.
//
// So: post any message in the group and its id shows up in the logs.
//   pm2 logs wpapi | grep GROUP
//
// `message_create` rather than `message` so a message you send yourself counts.
client.on("message_create", async (msg) => {
  try {
    if (!msg.from || !msg.from.endsWith("@g.us")) return;
    // Best-effort: naming the chat needs the store, so it usually won't resolve.
    // The id is the part that matters and it is already in hand.
    const chat = await msg.getChat().catch(() => null);
    console.log(`[GROUP] id=${msg.from} name=${chat ? chat.name : "(name unavailable)"}`);
  } catch (err) {
    console.warn("Group id discovery failed:", err.message);
  }
});

/* ------------------- AI INSIGHTS BOT (inbound) ------------------- */
// On each inbound message, ask the backend whether this sender is a registered
// clinic user. If so, send back the AI-generated reply. If not (or the bot is
// not configured), we stay silent and normal behaviour is unchanged.
client.on("message", async (msg) => {
  try {
    if (!INSIGHTS_URL || !INSIGHTS_API_KEY) return; // bot not configured
    if (msg.fromMe) return;
    if (!msg.from || !msg.from.endsWith("@c.us")) return; // skip groups/status/broadcasts
    const mobile = msg.from.replace(/\D/g, ""); // e.g. "919876543210"
    const message = (msg.body || "").trim();

    const url = `${INSIGHTS_URL.replace(/\/$/, "")}/insights/whatsapp?api=${encodeURIComponent(INSIGHTS_API_KEY)}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mobile, message }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    // Not a registered active user → do nothing (normal flow).
    if (data && data.handled && data.reply) {
      await client.sendMessage(msg.from, String(data.reply));
    }
  } catch (err) {
    console.error("Insights inbound failed:", err.message);
  }
});

/* ------------------- EXPRESS ROUTES ------------------- */
const authOk = (req) => req.query.api == process.env.API;

// Plain text message
const handleText = (req, res) => {
  if (!authOk(req)) return res.send("Invalid Api");
  const formatnum = "91" + req.query.mobile + "@c.us";
  const item = enqueue({ type: "text", formatnum, message: req.query.message });
  // Try to send immediately; if not ready it stays queued and is flushed later.
  flushQueue();
  res.send(client.isReady ? "Send" : "Client not ready, message queued.");
  void item;
};

app.get("/msg", handleText);
app.post("/message-text", handleText);

// Every group this account is in, with its chat id. Call it once to find the id
// of a group ("Team Healthixio"), then address that group by id from then on —
// ids survive a rename, names don't.
app.get("/groups", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Invalid Api");
  if (!client.isReady) return res.status(503).json({ error: "Client not ready" });
  try {
    res.json({ groups: await listGroups() });
  } catch (err) {
    // Errors thrown inside the WhatsApp page are minified to single letters, so
    // `diag` — what was actually found on the page — is the useful part.
    console.error("Failed to list groups:", err.message, JSON.stringify(err.diag ?? null));
    res.status(500).json({ error: err.message, diag: err.diag ?? null });
  }
});

// Text message to a group. `group` is either the chat id ("...@g.us") or the
// group's exact name — the id is preferred, a name costs one chat scan on the
// first send and is then cached.
const handleGroupText = (req, res) => {
  if (!authOk(req)) return res.send("Invalid Api");
  const group = (req.query.group || "").trim();
  if (!group) return res.status(400).send("Missing group");

  enqueue(
    isGroupId(group)
      ? { type: "text", formatnum: group, message: req.query.message }
      : { type: "text", formatnum: null, groupName: group, message: req.query.message }
  );
  flushQueue();
  res.send(client.isReady ? "Send" : "Client not ready, message queued.");
};

app.get("/group-msg", handleGroupText);
app.post("/message-group", handleGroupText);

// Media (image / PDF) message
app.post("/message", (req, res) => {
  if (!authOk(req)) return res.send("Invalid API");
  const formatnum = "91" + req.query.mobile + "@c.us";
  enqueue({
    type: "media",
    formatnum,
    message: req.query.message,
    fileUrl: req.query.imgUrl,
    pdfName: req.query.pdfName || "document.pdf",
  });
  flushQueue();
  res.send(client.isReady ? "File queued/sent." : "Client not ready, message queued.");
});

// Health / status endpoint for monitoring (requires API key)
// Manual trigger for the retention sweep, so it can be run and watched on
// demand rather than only on its cycle.
app.get("/sweep-chats", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Invalid Api");
  if (!client.isReady) return res.status(503).json({ error: "client not ready" });
  try {
    const swept = await sweepChats();
    res.json({ swept });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => {
  if (!authOk(req)) return res.status(401).send("Invalid Api");
  res.json({
    ready: !!client.isReady,
    pending: queue.filter((q) => q.status === "pending").length,
    failed: queue.filter((q) => q.status === "failed").length,
    uptime: process.uptime(),
  });
});

/* ------------------- INITIALIZE ------------------- */
loadQueue();
// Prune on startup and on a timer, not only after a flush: flushQueue returns
// early unless the client is ready, so an outage would otherwise leave nothing
// trimming the queue for as long as it lasted.
pruneQueue();
setInterval(pruneQueue, PRUNE_INTERVAL_MS);
setInterval(flushQueue, FLUSH_INTERVAL_MS); // retry pending messages periodically

// Liveness probe: even with no messages in flight, the browser tab can die
// silently (detached frame) without a `disconnected` event. Poll the client
// state; if the call throws or the session is gone, exit so PM2 restarts clean.
const HEALTHCHECK_INTERVAL_MS = 60 * 1000;
setInterval(async () => {
  if (!client.isReady) return;
  try {
    const state = await client.getState(); // talks to the live browser page
    if (state !== "CONNECTED") {
      console.error(`Health check: state is ${state}, exiting for clean restart.`);
      process.exit(1);
    }
  } catch (err) {
    console.error("Health check failed (browser likely dead), exiting:", err.message);
    process.exit(1);
  }
}, HEALTHCHECK_INTERVAL_MS);

const initializeClient = async (retries = 3) => {
  try {
    await client.initialize();
    console.log("Client initialized successfully");
  } catch (err) {
    if (retries > 0) {
      console.warn(`Retrying init, attempts left: ${retries}`, err.message);
      setTimeout(() => initializeClient(retries - 1), 5000);
    } else {
      console.error("Failed to initialize client, exiting for restart:", err);
      process.exit(1);
    }
  }
};

// Chromium regenerates these from scratch, but nothing ever removes them, and
// `Code Cache` in particular is not governed by --disk-cache-size. Sweep them
// when they get large so the daily PM2 restart keeps the session directory
// bounded. The session itself lives in IndexedDB / Local Storage / Cookies and
// is never touched here, so this never costs a QR re-scan.
const DISPOSABLE_CACHE_DIRS = ["Cache", "Code Cache", "GPUCache"];
const CACHE_SWEEP_THRESHOLD = 150 * 1024 * 1024;

const dirSize = (dir) => {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    try {
      total += e.isDirectory() ? dirSize(full) : fs.statSync(full).size;
    } catch {
      // a file Chromium removed mid-walk; it contributes nothing
    }
  }
  return total;
};

const sweepBrowserCaches = () => {
  const base = path.join(__dirname, ".wwebjs_auth", "session", "Default");
  if (!fs.existsSync(base)) return;
  for (const name of DISPOSABLE_CACHE_DIRS) {
    const dir = path.join(base, name);
    try {
      if (!fs.existsSync(dir)) continue;
      const size = dirSize(dir);
      if (size < CACHE_SWEEP_THRESHOLD) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`Swept ${name}, freed ${Math.round(size / 1048576)}MB`);
    } catch (err) {
      console.warn(`Could not sweep ${name}:`, err.message);
    }
  }
};

app.listen(port, () => console.log("Server is Live on port " + port));
sweepBrowserCaches(); // must run before Chromium launches
initializeClient();

// Don't let an unexpected error leave a zombie process — restart clean.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception, exiting for restart:", err);
  process.exit(1);
});
