module.exports = {
  apps: [
    {
      name: "gitbot-api",
      script: "./dist/server.js",
      cwd: __dirname,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      // PORT, DB_PATH, ADMIN_SECRET and the rest come from .env next to this file.
    },
  ],
  deploy: {
    uat: {
      user: "root",
      host: "64.227.149.33",
      ref: "origin/main",
      repo: "git@github.com:gitbot-hq/gitbot-api.git",
      path: "/var/www/gitbot/api",
      "post-deploy": "bash run.sh",
    },
  },
};
