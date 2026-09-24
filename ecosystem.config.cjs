module.exports = {
  apps: [
    {
      name: "gitbot-api",
      script: "./dist/server.js",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
    },
  ],
};
