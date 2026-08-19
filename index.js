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
const wwebVersion = "2.2412.54"; // pin a known-good WhatsApp Web version
const QUEUE_FILE = path.join(__dirname, "queue.json");

// If "authenticated" fires but "ready" does not within this window, the client
// is stuck (the classic puppeteer sync hang). We exit so PM2 restarts clean.
const READY_TIMEOUT_MS = 90 * 1000;
const FLUSH_INTERVAL_MS = 30 * 1000; // periodically retry pending messages
const MAX_ATTEMPTS = 5;

// AI insights bot: inbound messages are forwarded to our backend, which decides
// if the sender is a registered clinic user and returns a reply to send back.
const INSIGHTS_URL = process.env.INSIGHTS_URL; // e.g. http://127.0.0.1:3000
const INSIGHTS_API_KEY = process.env.INSIGHTS_API_KEY;

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true, // IMPORTANT: never depend on a display (DISPLAY=:0) on a server
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  },
  // Pinning the web version makes the `ready` event fire reliably after restarts.
  webVersionCache: {
    type: "remote",
    remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${wwebVersion}.html`,
  },
});

/* ------------------- PERSISTENT QUEUE ------------------- */
// Each entry: { id, type:'text'|'media', formatnum, groupName, message, fileUrl,
//               pdfName, status:'pending'|'sent'|'failed', attempts, createdAt,
//               sentAt, error }
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

const enqueue = (entry) => {
  const item = {
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    status: "pending",
    attempts: 0,
    createdAt: new Date().toISOString(),
    sentAt: null,
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
      item.error = "Not registered on WhatsApp";
      return false;
    }
  }

  if (item.type === "media" && item.fileUrl) {
    const media = await MessageMedia.fromUrl(item.fileUrl);
    if (item.fileUrl.endsWith(".pdf")) {
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
    for (const item of pending) {
      if (!client.isReady) break; // client died mid-flush; stop, retry later
      item.attempts += 1;
      try {
        const ok = await sendEntry(item);
        if (ok) {
          item.status = "sent";
          item.sentAt = new Date().toISOString();
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
          console.error(`Giving up on ${item.id} after ${item.attempts} tries:`, err.message);
        } else {
          console.warn(`Send failed for ${item.id} (attempt ${item.attempts}), will retry:`, err.message);
        }
      }
      saveQueue();
    }
    // Prune sent entries older than 24h to keep the file small.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const before = queue.length;
    queue = queue.filter(
      (q) => q.status !== "sent" || new Date(q.sentAt).getTime() > cutoff
    );
    if (queue.length !== before) saveQueue();
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
client.on("qr", (qr) => {
  console.log("Client QR Code:");
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => {
  console.log("Client authenticated!");
  armWatchdog(); // start the stuck-detection timer
});

client.on("ready", () => {
  console.log("Client is ready!");
  client.isReady = true;
  clearTimeout(readyWatchdog);
  flushQueue();
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

app.listen(port, () => console.log("Server is Live on port " + port));
initializeClient();

// Don't let an unexpected error leave a zombie process — restart clean.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception, exiting for restart:", err);
  process.exit(1);
});
