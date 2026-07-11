import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PROXY_BYPASS_MAC = ['127.0.0.1', 'localhost', '*.local', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
const PROXY_BYPASS_WIN = 'localhost;127.*;10.*;172.16.*;192.168.*;<local>';

async function listMacNetworkServices(): Promise<string[]> {
  const { stdout } = await execFileAsync('networksetup', ['-listallnetworkservices']);
  return stdout
    .split('\n')
    .slice(1) // first line is an explanatory header
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('*'));
}

async function setMacProxy(enabled: boolean, host: string, port: number): Promise<void> {
  const services = await listMacNetworkServices();
  for (const service of services) {
    if (enabled) {
      await execFileAsync('networksetup', ['-setwebproxy', service, host, String(port)]);
      await execFileAsync('networksetup', ['-setsecurewebproxy', service, host, String(port)]);
      await execFileAsync('networksetup', ['-setsocksfirewallproxy', service, host, String(port)]);
      await execFileAsync('networksetup', ['-setproxybypassdomains', service, ...PROXY_BYPASS_MAC]);
    } else {
      await execFileAsync('networksetup', ['-setwebproxystate', service, 'off']);
      await execFileAsync('networksetup', ['-setsecurewebproxystate', service, 'off']);
      await execFileAsync('networksetup', ['-setsocksfirewallproxystate', service, 'off']);
    }
  }
}

async function setWindowsProxy(enabled: boolean, host: string, port: number): Promise<void> {
  const base = ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/f', '/v'];
  if (enabled) {
    await execFileAsync('reg', [...base, 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1']);
    await execFileAsync('reg', [...base, 'ProxyServer', '/t', 'REG_SZ', '/d', `${host}:${port}`]);
    await execFileAsync('reg', [...base, 'ProxyOverride', '/t', 'REG_SZ', '/d', PROXY_BYPASS_WIN]);
  } else {
    await execFileAsync('reg', [...base, 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0']);
  }
}

async function setLinuxProxy(enabled: boolean, host: string, port: number): Promise<void> {
  if (enabled) {
    await execFileAsync('gsettings', ['set', 'org.gnome.system.proxy', 'mode', 'manual']);
    for (const protocol of ['http', 'https', 'socks']) {
      await execFileAsync('gsettings', ['set', `org.gnome.system.proxy.${protocol}`, 'host', host]);
      await execFileAsync('gsettings', ['set', `org.gnome.system.proxy.${protocol}`, 'port', String(port)]);
    }
  } else {
    await execFileAsync('gsettings', ['set', 'org.gnome.system.proxy', 'mode', 'none']);
  }
}

export interface SystemProxySnapshot {
  enabled: boolean;
  host?: string;
  port?: number;
}

export async function readSystemProxy(): Promise<SystemProxySnapshot | null> {
  if (process.platform === 'darwin') {
    const services = await listMacNetworkServices();
    for (const service of services) {
      const { stdout } = await execFileAsync('networksetup', ['-getwebproxy', service]);
      const enabled = /^Enabled:\s*Yes/m.test(stdout);
      if (enabled) {
        return {
          enabled: true,
          host: stdout.match(/^Server:\s*(.+)$/m)?.[1]?.trim(),
          port: Number(stdout.match(/^Port:\s*(\d+)$/m)?.[1]),
        };
      }
    }
    return { enabled: false };
  }

  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('reg', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyEnable',
      ]);
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/.test(stdout);
      if (!enabled) return { enabled: false };
      const { stdout: serverOut } = await execFileAsync('reg', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyServer',
      ]);
      const server = serverOut.match(/ProxyServer\s+REG_SZ\s+(\S+)/)?.[1];
      const [host, port] = server?.split(':') ?? [];
      return { enabled: true, host, port: Number(port) };
    } catch {
      return null;
    }
  }

  return null;
}

export async function applySystemProxy(enabled: boolean, port: number, host = '127.0.0.1'): Promise<void> {
  if (process.platform === 'darwin') {
    await setMacProxy(enabled, host, port);
    return;
  }
  if (process.platform === 'win32') {
    await setWindowsProxy(enabled, host, port);
    return;
  }
  await setLinuxProxy(enabled, host, port);
}
