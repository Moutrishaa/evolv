// The app sandbox on Windows: the environment variables libuv would otherwise copy in.
// Constants only: no imports, no logic.

export const WINDOWS_REQUIRED_VAR = 'SYSTEMROOT';

export const WINDOWS_LIBUV_VARS = [
  'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT',
  'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR',
];
