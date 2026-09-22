import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isIP } from "node:net";
import { randomBytes, createHash } from "node:crypto";
import { TeamError } from "./errors";

export interface TeamConfig {
  port: number;
  bindHost: string;
  publicOrigin: string;
  trustedProxyIps: readonly string[];
  dataDir: string;
  bootstrapCode?: string;
}

export function normalizedAddress(raw: string): string {
  const address = raw.toLowerCase();
  if (address.startsWith("::ffff:") && isIP(address.slice(7)) === 4) return address.slice(7);
  return address;
}

export function loopbackAddress(raw: string): boolean {
  const address = normalizedAddress(raw);
  return address === "::1" || isIP(address) === 4 && address.startsWith("127.");
}

export function validateTeamConfig(config: TeamConfig): TeamConfig {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new TeamError("invalid_request", "Team port must be between 1 and 65535");
  if (!isIP(config.bindHost)) throw new TeamError("invalid_request", "Team bind host must be an IP address");
  let origin: URL;
  try { origin = new URL(config.publicOrigin); } catch { throw new TeamError("invalid_request", "Team public origin is invalid"); }
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new TeamError("invalid_request", "Team public origin must be a plain HTTP or HTTPS origin");
  }
  const peers = config.trustedProxyIps.map(normalizedAddress);
  if (peers.some(peer => !isIP(peer)) || peers.length > 32) throw new TeamError("invalid_request", "Team proxy peers must be at most 32 exact IP addresses");
  const originHost = origin.hostname.replace(/^\[|\]$/g, "");
  if (origin.protocol === "http:" && (!loopbackAddress(config.bindHost) || !(loopbackAddress(originHost) || originHost === "localhost"))) {
    throw new TeamError("invalid_request", "Plain HTTP team mode requires a loopback listener and origin");
  }
  if (!loopbackAddress(config.bindHost) && (origin.protocol !== "https:" || !peers.length)) {
    throw new TeamError("invalid_request", "A nonloopback team listener requires HTTPS origin and exact trusted proxy peers");
  }
  if (!config.dataDir || config.dataDir.includes("\0")) throw new TeamError("invalid_request", "Team data directory is invalid");
  if (config.bootstrapCode !== undefined && !/^[A-Za-z0-9_-]{32,160}$/.test(config.bootstrapCode)) throw new TeamError("invalid_request", "Team setup code must be 32 to 160 URL-safe characters");
  return { ...config, dataDir: path.resolve(config.dataDir), publicOrigin: origin.origin, trustedProxyIps: [...new Set(peers)] };
}

export function loadTeamConfig(env: NodeJS.ProcessEnv = process.env): TeamConfig {
  const rawPort = env.RUNPHANTOM_TEAM_PORT ?? "5949";
  if (!/^\d+$/.test(rawPort)) throw new TeamError("invalid_request", "Team port must be between 1 and 65535");
  const port = Number(rawPort);
  const bindHost = env.RUNPHANTOM_TEAM_BIND_HOST?.trim() || "127.0.0.1";
  const originHost = bindHost.includes(":") ? `[${bindHost}]` : bindHost;
  return validateTeamConfig({
    port, bindHost,
    publicOrigin: env.RUNPHANTOM_TEAM_PUBLIC_ORIGIN ?? `http://${originHost}:${port}`,
    trustedProxyIps: env.RUNPHANTOM_TEAM_TRUSTED_PROXY_IPS?.split(",").map(value => value.trim()).filter(Boolean) ?? [],
    dataDir: env.RUNPHANTOM_TEAM_DATA_DIR ?? path.join(os.homedir(), ".runphantom", "team"),
    ...(env.RUNPHANTOM_TEAM_BOOTSTRAP_CODE === undefined ? {} : { bootstrapCode: env.RUNPHANTOM_TEAM_BOOTSTRAP_CODE }),
  });
}

function owner(stats: fs.Stats): void {
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) throw new TeamError("invalid_request", "Team data must be owned by the current account");
}

export function prepareTeamDirectory(directory: string): string {
  // Validate every existing directory before mkdir can follow a user-supplied symlink.
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) { fs.mkdirSync(current, { mode: 0o700 }); continue; }
    const stat = fs.lstatSync(current);
    // Only POSIX ownership can establish a system alias such as /var on macOS.
    // Windows reports uid zero without proving system ownership of a junction.
    if (stat.isSymbolicLink()) {
      if (process.platform === "win32" || stat.uid !== 0 || current === absolute) throw new TeamError("invalid_request", "Team data paths cannot contain user-owned symbolic links");
    } else if (!stat.isDirectory()) throw new TeamError("invalid_request", "Team data path must be a directory");
  }
  const real = fs.realpathSync(absolute);
  const stat = fs.statSync(real); owner(stat);
  if (process.platform !== "win32") fs.chmodSync(real, 0o700);
  return real;
}

/** Only the operator-readable file carries the bootstrap secret; the DB receives a digest. */
export function loadBootstrapHash(config: TeamConfig): { hash: string; file: string | null } {
  if (config.bootstrapCode !== undefined) return { hash: createHash("sha256").update(config.bootstrapCode).digest("hex"), file: null };
  const file = path.join(config.dataDir, "bootstrap.code");
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    try {
      fs.writeFileSync(fd, `rp_team_setup_${randomBytes(32).toString("base64url")}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new TeamError("invalid_request", "Cannot create the private team setup file");
  }
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow); }
  catch { throw new TeamError("invalid_request", "Cannot safely open the team setup file"); }
  try {
    const stat = fs.fstatSync(fd); owner(stat);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 || process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
      throw new TeamError("invalid_request", "Team setup file must be a private regular file");
    }
    const code = fs.readFileSync(fd, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{32,160}$/.test(code)) throw new TeamError("invalid_request", "Team setup file is invalid");
    return { hash: createHash("sha256").update(code).digest("hex"), file };
  } finally { fs.closeSync(fd); }
}
