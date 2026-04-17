module.exports = {
  apps: [{
    name: 'cortex-cloud',
    script: 'src/server.ts',
    interpreter: '/root/mem-ria/cloud/node_modules/.bin/tsx',
    cwd: '/root/mem-ria/cloud',
    env: {
      NODE_ENV: 'production',
      CORTEX_PORT: '3335',
      CORTEX_DB: '/data/cortex/cortex.db',
      GEMINI_API_KEY: 'AIzaSyCAuwwbV2E4Bwd8AJttrKtaj-UXZ77xJt4',
    },
    max_memory_restart: '256M',
    error_file: '/var/log/cortex-cloud-error.log',
    out_file: '/var/log/cortex-cloud-out.log',
    merge_logs: true,
    time: true,
  }]
}
