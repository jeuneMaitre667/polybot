module.exports = {
  apps: [
    {
      name: "poly-engine",
      script: "./bot-24-7/index.js",
      cwd: "./",
      watch: false,
      env: {
        NODE_ENV: "production",
      }
    },
    {
      name: "poly-api",
      script: "./bot-24-7/status-server.js",
      cwd: "./",
      watch: false,
    },
    {
      name: "poly-ui",
      script: "./node_modules/vite/bin/vite.js",
      args: "--port 5175 --host",
      cwd: "./",
      watch: false,
    }
  ]
};
