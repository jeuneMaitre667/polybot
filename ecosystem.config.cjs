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
      script: "npm.cmd",
      args: "run dev -- --port 5175 --host",
      cwd: "./",
      interpreter: "none",
      watch: false,
    }
  ]
};
