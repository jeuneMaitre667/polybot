module.exports = {
  apps: [
    {
      name: "poly-engine",
      script: "C:\\Users\\cedpa\\polymarket-dashboard\\bot-24-7\\index.js",
      cwd: "C:\\Users\\cedpa\\polymarket-dashboard\\bot-24-7",
      watch: false,
      env: {
        NODE_ENV: "production",
      }
    },
    {
      name: "poly-api",
      script: "C:\\Users\\cedpa\\polymarket-dashboard\\bot-24-7\\status-server.js",
      cwd: "C:\\Users\\cedpa\\polymarket-dashboard\\bot-24-7",
      watch: false,
      env: {
        PORT: 3001
      }
    },
    {
      name: "poly-ui",
      script: "C:\\Users\\cedpa\\polymarket-dashboard\\node_modules\\vite\\bin\\vite.js",
      args: "--port 5175 --host",
      cwd: "C:\\Users\\cedpa\\polymarket-dashboard",
      watch: false,
    }
  ]
};
