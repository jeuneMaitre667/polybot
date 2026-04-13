module.exports = {
  apps: [
    {
      name: 'polymarket-bot',
      script: 'index.js',
      cwd: '/home/ubuntu/bot-24-7',
      env: {
        NODE_ENV: 'production',
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      error_file: '/home/ubuntu/.pm2/logs/polymarket-bot-error.log',
      out_file: '/home/ubuntu/.pm2/logs/polymarket-bot-out.log',
      merge_logs: true,
    },
    {
      name: 'status-server',
      script: 'status-server.js',
      cwd: '/home/ubuntu/bot-24-7',
      env: {
        NODE_ENV: 'production',
        PORT: 3001
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      error_file: '/home/ubuntu/.pm2/logs/status-server-error.log',
      out_file: '/home/ubuntu/.pm2/logs/status-server-out.log',
      merge_logs: true,
    }
  ]
};
