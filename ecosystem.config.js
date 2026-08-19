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

      // Clean managed daily restart at 4:00 AM — replaces the OS stop/start.
      // PM2 brings the process straight back up with the saved session.
      cron_restart: "0 4 * * *",

      // Restart if memory leaks (puppeteer/chromium can grow over days)
      max_memory_restart: "600M",

      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
