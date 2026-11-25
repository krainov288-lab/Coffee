'use strict';
const { createApp } = require('./lib/app');
const app = createApp();
const srv = app.createServer();
const port = +process.env.QC_PORT || 8080, host = process.env.QC_HOST || '127.0.0.1';
srv.listen(port, host, () => {
  console.log('QUIET COFFEE server: http://' + host + ':' + port);
  if (!process.env.QC_ADMIN_PHONE) console.warn('[setup] QC_ADMIN_PHONE is not set: nobody will get administrator rights.');
  if (process.env.QC_DEV_SMS === '1') console.warn('[dev] QC_DEV_SMS=1: SMS codes are returned in API responses. NEVER use this in production.');
});
const stop = () => { srv.close(() => { app.close(); process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
