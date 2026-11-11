import {defineConfig} from '@playwright/test';

const baseURL=process.env.BASE_URL||'http://127.0.0.1:4189';
process.env.BASE_URL=baseURL;
export default defineConfig({
  testDir:'./tests/browser',
  timeout:30000,
  workers:1,
  use:{baseURL,viewport:{width:1440,height:1000},timezoneId:'Asia/Shanghai',
    launchOptions:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}},
  webServer:{command:'node scripts/preview-server.mjs',url:baseURL,env:{PORT:'4189'},reuseExistingServer:false},
});
