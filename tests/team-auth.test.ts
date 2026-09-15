import { test, expect, describe } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { hashPassword, verifyPassword, passwordValue, emailValue, sessionSecret, tokenHash, csrfFor, RateBuckets } from "../src/team/auth";
import { loadTeamConfig, validateTeamConfig, loadBootstrapHash, prepareTeamDirectory } from "../src/team/config";
import { TEAM_LIMITS as L } from "../src/team/protocol";

describe("team configuration and credentials", () => {
  test("defaults are isolated and broad listeners require real proxy admission", () => {
    const config = loadTeamConfig({});
    expect(config.port).toBe(5949);
    expect(config.bindHost).toBe("127.0.0.1");
    expect(config.dataDir.endsWith("/.runphantom/team")).toBe(true);
    expect(() => loadTeamConfig({RUNPHANTOM_TEAM_PORT:"5949junk"})).toThrow();
    expect(() => validateTeamConfig({...config,bindHost:"0.0.0.0"})).toThrow();
    expect(() => validateTeamConfig({...config,bindHost:"0.0.0.0",publicOrigin:"https://team.example"})).toThrow();
    const proxy = validateTeamConfig({...config,bindHost:"0.0.0.0",publicOrigin:"https://team.example",trustedProxyIps:["127.0.0.1"]});
    expect(proxy.publicOrigin).toBe("https://team.example");
    expect(() => validateTeamConfig({...proxy,trustedProxyIps:["127.0.0.0/8"]})).toThrow();
    expect(() => validateTeamConfig({...config,publicOrigin:"http://team.example"})).toThrow();
    expect(() => validateTeamConfig({...config,publicOrigin:"https://team.example/path"})).toThrow();
  });

  test("bootstrap file is private, stable and symlink-safe", () => {
    const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"team-auth-"));
    try {
      const directory = prepareTeamDirectory(path.join(temp,"data"));
      const config = {...loadTeamConfig({}),dataDir:directory};
      const first = loadBootstrapHash(config), second = loadBootstrapHash(config);
      const code = fs.readFileSync(first.file!,"utf8").trim();
      expect(code).toMatch(/^rp_team_setup_[A-Za-z0-9_-]{43}$/);
      expect(first.hash).toBe(createHash("sha256").update(code).digest("hex"));
      expect(second.hash).toBe(first.hash);
      if (process.platform!=="win32") {
        expect(fs.statSync(directory).mode&0o777).toBe(0o700);
        expect(fs.statSync(first.file!).mode&0o777).toBe(0o600);
      }
      fs.unlinkSync(first.file!);
      const target = path.join(temp,"outside");
      fs.writeFileSync(target,"do not overwrite"); fs.symlinkSync(target,first.file!);
      expect(()=>loadBootstrapHash(config)).toThrow();
      expect(fs.readFileSync(target,"utf8")).toBe("do not overwrite");
      const link = path.join(temp,"linked-data"); fs.symlinkSync(directory,link);
      expect(()=>prepareTeamDirectory(link)).toThrow();
    } finally { fs.rmSync(temp,{recursive:true,force:true}); }
  });

  test("password and identifier boundaries retain exact bytes", () => {
    expect(emailValue(" User@Example.COM ")).toBe("user@example.com");
    expect(()=>emailValue("person\n@example.com")).toThrow();
    expect(passwordValue("  exact password  ")).toBe("  exact password  ");
    expect(passwordValue("🦊".repeat(128))).toBe("🦊".repeat(128));
    expect(()=>passwordValue("x".repeat(11))).toThrow();
    expect(()=>passwordValue("🦊".repeat(129))).toThrow();
    const first=sessionSecret(),second=sessionSecret();
    expect(first).not.toBe(second); expect(tokenHash(first)).toHaveLength(64);
    expect(csrfFor(first)).toHaveLength(43); expect(csrfFor(first)).not.toBe(csrfFor(second));
    expect(csrfFor(first)).not.toContain(first);
  });

  test("native hashing is bounded and preserves password spaces", async () => {
    const first=hashPassword("  exact password  "),second=hashPassword("different password");
    await hashPassword("third password").then(() => { throw new Error("Expected hash admission rejection"); }, error => expect(error.message).toContain("busy"));
    const [hash]=await Promise.all([first,second]);
    expect(hash).toStartWith("$argon2id$v=19$m=65536,t=2,");
    expect(await verifyPassword("  exact password  ",hash)).toBe(true);
    expect(await verifyPassword("exact password",hash)).toBe(false);
    expect(await verifyPassword("runphantom-fixed-dummy-not-a-user-password",null)).toBe(false);
    expect(await hashPassword("admission recovered")).toStartWith("$argon2id$");
  });

  test("rate maps cannot churn active identities to renew allowance", () => {
    let now=1000;
    const buckets=new RateBuckets(2,()=>now);
    buckets.take("a",1); buckets.take("b",1);
    expect(()=>buckets.take("a",1)).toThrow("limit");
    expect(()=>buckets.take("c",1)).toThrow("capacity");
    expect(buckets.size).toBe(2);
    now+=L.RATE_WINDOW_MS;
    buckets.take("c",1); expect(buckets.size).toBe(1);
    buckets.clear(); expect(buckets.size).toBe(0);
  });
});
