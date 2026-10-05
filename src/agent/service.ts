/**
 * Installs the agent as a system service, so a GPU machine contributes to the
 * pool whenever it is powered on — not only when someone remembered to leave a
 * terminal open.
 *
 * Deliberately shells out to each platform's native supervisor instead of
 * depending on a wrapper package: fewer moving parts, and the user can inspect
 * and remove what we installed with tools they already know.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVICE_NAME = 'gpupool-agent';

export interface InstallOptions {
  manifestPath: string;
  /** Render the service definition without registering anything. */
  dryRun?: boolean;
  /** Install machine-wide (needs admin/root) rather than for this user only. */
  system: boolean;
  gpupoolHome?: string;
}

function configDir(): string {
  return process.env.GPUPOOL_HOME ?? join(homedir(), '.gpupool');
}

/** Set to true by esbuild when bundling the single-file executable. */
declare const __GPUPOOL_SEA__: boolean | undefined;

/**
 * How to relaunch ourselves. A single-file build is its own executable; a
 * normal install needs node plus the script path.
 *
 * The flag is baked in at bundle time rather than probed at runtime: a
 * `node:sea` lookup has to work in both ESM and CJS output, and getting that
 * wrong silently registers a service pointing at a script that is not there.
 */
function launcher(): { exe: string; preArgs: string[] } {
  if (typeof __GPUPOOL_SEA__ !== 'undefined' && __GPUPOOL_SEA__) {
    return { exe: process.execPath, preArgs: [] };
  }
  const script = resolve(fileURLToPath(import.meta.url), '..', 'index.js');
  return { exe: process.execPath, preArgs: [script] };
}

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// ---------------------------------------------------------------- Windows

/**
 * Task Scheduler XML rather than plain `schtasks` flags, because the defaults
 * are wrong for this job: tasks normally refuse to start on battery, stop when
 * a laptop unplugs, and give up after a crash.
 */
function windowsTaskXml(opts: InstallOptions): string {
  const { exe, preArgs } = launcher();
  const args = [...preArgs, 'serve', '--manifest', resolve(opts.manifestPath)]
    .map((a) => (a.includes(' ') ? `"${a}"` : a))
    .join(' ');
  const user = `${userInfo().username}`;
  const trigger = opts.system
    ? '<BootTrigger><Enabled>true</Enabled></BootTrigger>'
    : `<LogonTrigger><Enabled>true</Enabled><UserId>${user}</UserId></LogonTrigger>`;
  // Task Scheduler requires the plural <Principals> wrapper, and rejects the
  // whole document if the child elements appear out of schema order.
  const principal = opts.system
    ? '<Principals><Principal id="p"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>'
    : `<Principals><Principal id="p"><UserId>${user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`;

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>gpupool agent - exposes local ports to the gpupool broker</Description>
  </RegistrationInfo>
  <Triggers>
    ${trigger}
  </Triggers>
  ${principal}
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="p">
    <Exec>
      <Command>${exe}</Command>
      <Arguments>${args.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</Arguments>
      <WorkingDirectory>${dirname(resolve(opts.manifestPath))}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
}

function installWindows(opts: InstallOptions): string[] {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const xmlPath = join(dir, 'task.xml');
  // schtasks reads task XML as UTF-16LE; a UTF-8 file is rejected as malformed.
  writeFileSync(xmlPath, Buffer.from('﻿' + windowsTaskXml(opts), 'utf16le'));
  run('schtasks', ['/create', '/tn', SERVICE_NAME, '/xml', xmlPath, '/f']);
  run('schtasks', ['/run', '/tn', SERVICE_NAME]);
  return [
    `registered scheduled task "${SERVICE_NAME}"`,
    opts.system ? 'starts at boot (SYSTEM)' : 'starts at logon for this user',
    'restarts every minute if it dies; runs on battery',
    '',
    `  status:  schtasks /query /tn ${SERVICE_NAME}`,
    `  stop:    schtasks /end /tn ${SERVICE_NAME}`,
    `  remove:  gpupool service uninstall`,
  ];
}

function uninstallWindows(): string[] {
  try {
    run('schtasks', ['/end', '/tn', SERVICE_NAME]);
  } catch {
    // Not running is fine; we only care that the task is gone.
  }
  run('schtasks', ['/delete', '/tn', SERVICE_NAME, '/f']);
  const xmlPath = join(configDir(), 'task.xml');
  if (existsSync(xmlPath)) unlinkSync(xmlPath);
  return [`removed scheduled task "${SERVICE_NAME}"`];
}

function statusWindows(): string {
  try {
    return run('schtasks', ['/query', '/tn', SERVICE_NAME, '/v', '/fo', 'list'])
      .split('\n')
      .filter((l) => /Status|Last Run|Next Run|Last Result|Task To Run/i.test(l))
      .map((l) => '  ' + l.trim())
      .join('\n');
  } catch {
    return '  not installed';
  }
}

// ---------------------------------------------------------------- systemd

function systemdUnit(opts: InstallOptions): string {
  const { exe, preArgs } = launcher();
  const args = [...preArgs, 'serve', '--manifest', resolve(opts.manifestPath)].join(' ');
  const home = opts.gpupoolHome ?? process.env.GPUPOOL_HOME;
  return `[Unit]
Description=gpupool agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exe} ${args}
WorkingDirectory=${dirname(resolve(opts.manifestPath))}
Restart=always
RestartSec=5
${home ? `Environment=GPUPOOL_HOME=${home}\n` : ''}StandardOutput=journal
StandardError=journal

[Install]
WantedBy=${opts.system ? 'multi-user.target' : 'default.target'}
`;
}

function installSystemd(opts: InstallOptions): string[] {
  const unit = systemdUnit(opts);
  const name = `${SERVICE_NAME}.service`;
  const notes: string[] = [];

  if (opts.system) {
    writeFileSync(join('/etc/systemd/system', name), unit);
    run('systemctl', ['daemon-reload']);
    run('systemctl', ['enable', '--now', name]);
  } else {
    const dir = join(homedir(), '.config', 'systemd', 'user');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), unit);
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', name]);
    // Without lingering, a user service stops the moment the user logs out.
    notes.push('', 'run this so it survives logout:', `  sudo loginctl enable-linger ${userInfo().username}`);
  }

  const sc = opts.system ? 'systemctl' : 'systemctl --user';
  return [
    `installed ${name}`,
    'restarts on failure after 5s; starts at boot',
    '',
    `  status:  ${sc} status ${name}`,
    `  logs:    journalctl ${opts.system ? '' : '--user '}-u ${name} -f`,
    `  remove:  gpupool service uninstall${opts.system ? ' --system' : ''}`,
    ...notes,
  ];
}

function uninstallSystemd(system: boolean): string[] {
  const name = `${SERVICE_NAME}.service`;
  const base = system ? ['systemctl'] : ['systemctl', '--user'];
  try {
    run(base[0], [...base.slice(1), 'disable', '--now', name]);
  } catch {
    // Already stopped or never enabled.
  }
  const path = system
    ? join('/etc/systemd/system', name)
    : join(homedir(), '.config', 'systemd', 'user', name);
  if (existsSync(path)) unlinkSync(path);
  run(base[0], [...base.slice(1), 'daemon-reload']);
  return [`removed ${name}`];
}

// ---------------------------------------------------------------- launchd

function launchdPlist(opts: InstallOptions): string {
  const { exe, preArgs } = launcher();
  const args = [exe, ...preArgs, 'serve', '--manifest', resolve(opts.manifestPath)];
  const home = opts.gpupoolHome ?? process.env.GPUPOOL_HOME;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.gpupool.agent</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${a}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>${dirname(resolve(opts.manifestPath))}</string>
${home ? `  <key>EnvironmentVariables</key><dict><key>GPUPOOL_HOME</key><string>${home}</string></dict>\n` : ''}  <key>StandardOutPath</key><string>${join(configDir(), 'agent.log')}</string>
  <key>StandardErrorPath</key><string>${join(configDir(), 'agent.err.log')}</string>
</dict>
</plist>
`;
}

function launchdPath(system: boolean): string {
  return system
    ? '/Library/LaunchDaemons/dev.gpupool.agent.plist'
    : join(homedir(), 'Library', 'LaunchAgents', 'dev.gpupool.agent.plist');
}

function installLaunchd(opts: InstallOptions): string[] {
  const path = launchdPath(opts.system);
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(path, launchdPlist(opts));
  try {
    run('launchctl', ['unload', path]);
  } catch {
    // Not loaded yet.
  }
  run('launchctl', ['load', '-w', path]);
  return [
    `installed ${path}`,
    'KeepAlive is on, so launchd restarts it if it exits',
    '',
    `  status:  launchctl list | grep gpupool`,
    `  logs:    tail -f ${join(configDir(), 'agent.log')}`,
    `  remove:  gpupool service uninstall${opts.system ? ' --system' : ''}`,
  ];
}

function uninstallLaunchd(system: boolean): string[] {
  const path = launchdPath(system);
  try {
    run('launchctl', ['unload', '-w', path]);
  } catch {
    // Already unloaded.
  }
  if (existsSync(path)) unlinkSync(path);
  return [`removed ${path}`];
}

// ---------------------------------------------------------------- dispatch

/**
 * The exact service definition that would be registered. Worth being able to
 * see before touching the system: these files are easy to get subtly wrong and
 * annoying to debug once a supervisor owns them.
 */
export function renderServiceDefinition(opts: InstallOptions): { path: string; body: string } {
  switch (platform()) {
    case 'win32':
      return { path: join(configDir(), 'task.xml'), body: windowsTaskXml(opts) };
    case 'linux':
      return {
        path: opts.system
          ? join('/etc/systemd/system', `${SERVICE_NAME}.service`)
          : join(homedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`),
        body: systemdUnit(opts),
      };
    case 'darwin':
      return { path: launchdPath(opts.system), body: launchdPlist(opts) };
    default:
      throw new Error(`unsupported platform ${platform()}`);
  }
}

export function installService(opts: InstallOptions): string[] {
  switch (platform()) {
    case 'win32':
      return installWindows(opts);
    case 'linux':
      return installSystemd(opts);
    case 'darwin':
      return installLaunchd(opts);
    default:
      throw new Error(`service install is not supported on ${platform()}`);
  }
}

export function uninstallService(system: boolean): string[] {
  switch (platform()) {
    case 'win32':
      return uninstallWindows();
    case 'linux':
      return uninstallSystemd(system);
    case 'darwin':
      return uninstallLaunchd(system);
    default:
      throw new Error(`service uninstall is not supported on ${platform()}`);
  }
}

export function serviceStatus(system: boolean): string {
  switch (platform()) {
    case 'win32':
      return statusWindows();
    case 'linux':
      try {
        const base = system ? ['status'] : ['--user', 'status'];
        return run('systemctl', [...base, `${SERVICE_NAME}.service`, '--no-pager']);
      } catch (err) {
        return '  not installed or not running';
      }
    case 'darwin':
      try {
        const out = run('launchctl', ['list']);
        const line = out.split('\n').find((l) => l.includes('dev.gpupool.agent'));
        return line ? '  ' + line.trim() : '  not installed';
      } catch {
        return '  not installed';
      }
    default:
      return `  unsupported platform ${platform()}`;
  }
}

/** True when we can install machine-wide without being refused. */
export function isElevated(): boolean {
  if (platform() === 'win32') {
    try {
      // Only an elevated process can query the SYSTEM account's tasks.
      run('net', ['session']);
      return true;
    } catch {
      return false;
    }
  }
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** Warn if the manifest will be unreadable from the service's context. */
export function checkManifestReadable(manifestPath: string): string | null {
  const p = resolve(manifestPath);
  if (!existsSync(p)) return `manifest not found at ${p}`;
  try {
    readFileSync(p, 'utf8');
    return null;
  } catch (err) {
    return `manifest at ${p} is not readable: ${(err as Error).message}`;
  }
}
