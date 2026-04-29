module.exports = {
  apps: [
    {
      name: 'poly-engine',
      script: 'index.js',
      cwd: '/home/ubuntu/polybot/bot-24-7',
      env: {
        NODE_ENV: 'production',
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      error_file: '/home/ubuntu/.pm2/logs/polybot-v2-error.log',
      out_file: '/home/ubuntu/.pm2/logs/polybot-v2-out.log',
      merge_logs: true,
    },
    {
      name: 'bot-status-server',
      script: 'status-server.js',
      cwd: '/home/ubuntu/polybot/bot-24-7',
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
