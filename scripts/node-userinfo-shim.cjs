// Avoid sporadic uv_os_get_passwd failures on Windows before tsx starts.
// This is loaded by the start script before tsx evaluates os.userInfo().
const os = require('node:os')

os.userInfo = () => ({
  uid: -1,
  gid: -1,
  username: process.env.USERNAME || 'ASUS',
  homedir: process.env.USERPROFILE || process.cwd(),
  shell: null,
})
