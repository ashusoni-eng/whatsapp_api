module.exports = {
  apps: [
    {
      name: "wpapi",
      script: "index.js",
      // Restart automatically on any crash/exit (our code exits on stuck/disconnect)
      autorestart: true,
      max_restarts: 50, // allow many self-heal restarts
      min_uptime: "20s", // a process must live 20s to count as "started"
      restart_delay: 5000, // wait 5s between restarts
      exp_backoff_restart_delay: 2000, // back off if it keeps crashing fast

      // No daily cron_restart. A Chromium cold boot plus WhatsApp Web's initial
      // sync is the single most expensive thing this service does, and on a
      // burstable host paid for in CPU credits, spending that every night buys
      // nothing: max_memory_restart below already catches a leaking browser,
      // and the chat sweep now keeps the IndexedDB store from growing at all,
      // which is what the nightly restart was really papering over.

      // Our code exits 1 when it wants a fresh process. Exit 0 means the
      // opposite - it has decided there is no point running (nobody scanned
      // the QR) - so treat that as a stop, not a restart loop.
      stop_exit_codes: [0],

      // Restart if memory leaks (puppeteer/chromium can grow over days)
      max_memory_restart: "600M",

      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
