import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { createConnection } from "node:net";
import { createTeamServer } from "../src/team/server";
import { loadTeamConfig } from "../src/team/config";
import { TEAM_LIMITS as L } from "../src/team/protocol";

interface Identity { cookie: string; csrf: string }
async function fixture() {
  const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"team-http-"));
  const setupCode="rp_team_setup_"+"s".repeat(43);
  const config={...loadTeamConfig({}),dataDir:directory,bootstrapCode:setupCode};
  const handle=await createTeamServer(config,{uiDir:directory});
  await new Promise<void>(resolve=>handle.server.listen(0,"127.0.0.1",resolve));
  const address=handle.server.address();
  if(!address||typeof address==="string")throw new Error("Missing test listener");
  const url=`http://127.0.0.1:${address.port}`;
  async function call(method:string,endpoint:string,body?:unknown,identity?:Identity,extra:Record<string,string>={}) {
    const headers:Record<string,string>={Host:new URL(config.publicOrigin).host,...extra};
    if(method!=="GET")headers.Origin=config.publicOrigin;
    if(identity){headers.Cookie=identity.cookie;headers["X-RunPhantom-CSRF"]=identity.csrf;}
    let data:BodyInit|undefined;
    if(body!==undefined){headers["Content-Type"]="application/json";data=JSON.stringify(body);}
    Object.assign(headers,extra);
    const response=await fetch(url+endpoint,{method,headers,body:data,redirect:"manual"});
    const text=await response.text();
    let json:Record<string,any>={};try{json=JSON.parse(text);}catch{/* Static/error transport assertions use raw text. */}
    return {status:response.status,headers:response.headers,json,text};
  }
  function identity(response:Awaited<ReturnType<typeof call>>):Identity {
    const session=response.json.authenticated?response.json:response.json.session;
    return {cookie:response.headers.get("set-cookie")!.split(";")[0],csrf:session.csrfToken};
  }
  const setup=()=>call("POST","/api/team/setup",{setupCode,email:"owner@example.test",password:"correct horse battery"});
  return {handle,url,config,setupCode,directory,call,identity,setup,close:async()=>{await handle.close();fs.rmSync(directory,{recursive:true,force:true});}};
}

test("team HTTP bootstrap is atomic and local controls remain absent",async()=>{
  const f=await fixture();
  try {
    const attempts=await Promise.all([f.setup(),f.setup()]);
    expect(attempts.map(item=>item.status).sort()).toEqual([201,409]);
    const successful=attempts.find(item=>item.status===201)!;
    const account=f.identity(successful);
    expect(successful.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    expect(successful.json).not.toHaveProperty("passwordHash");
    expect(successful.text).not.toContain(f.setupCode);
    for(const endpoint of ["/api/secrets","/api/workspace","/api/runs","/api/replay","/ws","/api/team/unknown"]){
      const result=await f.call("GET",endpoint,undefined,account);expect(result.status).toBe(404);expect(result.headers.get("content-type")).toContain("application/json");
    }
    expect((await f.setup()).status).toBe(409);
    expect((await f.call("GET","/api/team/session",undefined,account)).json.authenticated).toBe(true);
  } finally {await f.close();}
});

test("team HTTP rejects Host, Origin, CSRF and duplicate query overrides",async()=>{
  const f=await fixture();
  try {
    const owner=f.identity(await f.setup());
    expect((await f.call("POST","/api/team/projects",{name:"denied"},owner,{Origin:"https://evil.example"})).status).toBe(403);
    expect((await f.call("POST","/api/team/projects",{name:"denied"},owner,{"X-RunPhantom-CSRF":"x".repeat(43)})).status).toBe(403);
    expect((await f.call("GET","/api/team/session",undefined,owner,{Host:"evil.example","X-Forwarded-Host":new URL(f.config.publicOrigin).host})).status).toBe(403);
    expect((await f.call("GET","/api/team/session",undefined,owner,{"Sec-Fetch-Site":"cross-site"})).status).toBe(403);
    expect((await f.call("GET","/api/team/projects?limit=1&limit=2",undefined,owner)).status).toBe(400);
    expect((await f.call("POST","/api/team/projects?projectId=forged",{name:"denied"},owner)).status).toBe(400);
    expect((await f.call("POST","/api/team/projects",{name:"allowed"},owner)).status).toBe(201);
  } finally {await f.close();}
});

test("wrong credentials preserve a valid cookie; password rotation revokes old sessions",async()=>{
  const f=await fixture();
  try {
    const owner=f.identity(await f.setup());
    const badLogin=await f.call("POST","/api/team/login",{email:"owner@example.test",password:"incorrect long password"},owner);
    expect(badLogin.status).toBe(401);expect(badLogin.headers.get("set-cookie")).toBeNull();
    const typo=await f.call("POST","/api/team/password",{currentPassword:"incorrect long password",newPassword:"a different good password"},owner);
    expect(typo.status).toBe(400);expect(typo.headers.get("set-cookie")).toBeNull();
    expect((await f.call("GET","/api/team/session",undefined,owner)).json.authenticated).toBe(true);
    const second=f.identity(await f.call("POST","/api/team/login",{email:"owner@example.test",password:"correct horse battery"}));
    const changed=await f.call("POST","/api/team/password",{currentPassword:"correct horse battery",newPassword:"  new exact password  "},owner);
    expect(changed.status).toBe(200);
    const fresh=f.identity(changed);expect(fresh.cookie).not.toBe(owner.cookie);expect(fresh.csrf).not.toBe(owner.csrf);
    expect((await f.call("GET","/api/team/session",undefined,owner)).json.authenticated).toBe(false);
    expect((await f.call("GET","/api/team/session",undefined,second)).json.authenticated).toBe(false);
    expect((await f.call("POST","/api/team/projects",{name:"new project"},fresh)).status).toBe(201);
    expect((await f.call("POST","/api/team/login",{email:"owner@example.test",password:"new exact password"})).status).toBe(401);
    expect((await f.call("POST","/api/team/login",{email:"owner@example.test",password:"  new exact password  "})).status).toBe(200);
  } finally {await f.close();}
});

test("HTTP invitation signup cannot overwrite another account and revoked members lose access",async()=>{
  const f=await fixture();
  try {
    const owner=f.identity(await f.setup());
    const project=(await f.call("POST","/api/team/projects",{name:"team"},owner)).json;
    const p=`/api/team/projects/${project.id}`;
    const invitation=await f.call("POST",`${p}/invites`,{email:"viewer@example.test",role:"viewer"},owner);
    expect(invitation.status).toBe(201);
    const accepted=await f.call("POST","/api/team/invites/accept",{token:invitation.json.token,email:"viewer@example.test",password:"viewer good password"});
    expect(accepted.status).toBe(201);
    const viewer=f.identity(accepted);
    expect((await f.call("GET",p,undefined,viewer)).status).toBe(200);
    expect((await f.call("POST",`${p}/keys`,{label:"not allowed"},viewer)).status).toBe(403);
    expect((await f.call("GET",`${p}/invites`,undefined,viewer)).status).toBe(403);
    expect((await f.call("POST","/api/team/invites/accept",{token:invitation.json.token,email:"viewer@example.test",password:"replacement password"})).status).toBe(400);
    expect((await f.call("POST","/api/team/login",{email:"viewer@example.test",password:"viewer good password"})).status).toBe(200);
    expect((await f.call("DELETE",`${p}/members/${accepted.json.session.user.id}`,undefined,owner)).status).toBe(204);
    expect((await f.call("GET",p,undefined,viewer)).status).toBe(404);
    expect((await f.call("GET","/api/team/session",undefined,viewer)).json.authenticated).toBe(true);
  } finally {await f.close();}
});

test("team HTTP bounds raw numbers and gzip before persistence",async()=>{
  const f=await fixture();
  try {
    const owner=f.identity(await f.setup());
    const project=(await f.call("POST","/api/team/projects",{name:"team"},owner)).json;
    const p=`/api/team/projects/${project.id}`;
    const raw='{"name":"rounded","referenceRunId":"'+'a'.repeat(32)+'","candidateRunIds":["'+'b'.repeat(32)+'"],"rules":[{"kind":"jsonPath","path":"id","equals":9007199254740993}]}';
    const rejected=await fetch(f.url+`${p}/checks`,{method:"POST",headers:{Host:new URL(f.config.publicOrigin).host,Origin:f.config.publicOrigin,Cookie:owner.cookie,"X-RunPhantom-CSRF":owner.csrf,"Content-Type":"application/json"},body:raw});
    expect(rejected.status).toBe(400);expect(await rejected.text()).not.toContain("9007199254740993");
    const key=(await f.call("POST",`${p}/keys`,{label:"SDK"},owner)).json.token;
    const ingest=(body:Uint8Array,extra:Record<string,string>={})=>fetch(f.url+"/api/team/ingest/v1/traces",{method:"POST",headers:{Host:new URL(f.config.publicOrigin).host,Authorization:`Bearer ${key}`,"Content-Type":"application/json","Content-Encoding":"gzip",...extra},body});
    const bomb=await ingest(gzipSync(Buffer.from("x".repeat(L.INGEST_EXPANDED_BYTES+1))));expect(bomb.status).toBe(413);await bomb.text();
    const truncated=await ingest(gzipSync(Buffer.from('{"resourceSpans":[]}')).subarray(0,12));expect(truncated.status).toBe(400);await truncated.text();
    const empty=await ingest(gzipSync(Buffer.from('{"resourceSpans":[]}')));expect(empty.status).toBe(200);expect(await empty.json()).toEqual({});
    const encodedCookie=await f.call("POST","/api/team/ingest/v1/traces",{resourceSpans:[]},owner);expect(encodedCookie.status).toBe(401);expect(encodedCookie.headers.get("set-cookie")).toBeNull();
  } finally {await f.close();}
});

test("team server refuses a dangling database symlink before opening SQLite",async()=>{
  const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"team-db-symlink-"));
  const outside=path.join(directory,"outside.sqlite"),data=path.join(directory,"data");fs.mkdirSync(data);fs.symlinkSync(outside,path.join(data,"team.sqlite"));
  try {
    await createTeamServer({...loadTeamConfig({}),dataDir:data},{uiDir:directory}).then(() => { throw new Error("Expected symlink rejection"); }, error => expect(error.message).toContain("regular private files"));
    expect(fs.existsSync(outside)).toBe(false);
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});

test("incomplete HTTP bodies and duplicate cookies cannot commit writes",async()=>{
  const f=await fixture();
  try {
    const owner=f.identity(await f.setup());
    async function raw(message:string):Promise<string> {
      return new Promise(resolve=>{
        let received="",done=false;
        const socket=createConnection({host:"127.0.0.1",port:Number(new URL(f.url).port)});
        const finish=()=>{if(!done){done=true;socket.destroy();resolve(received);}};
        socket.setTimeout(1000,finish);socket.once("error",finish);socket.once("close",finish);
        socket.on("data",chunk=>{received+=chunk.toString();if(received.length>8192)finish();});
        socket.once("connect",()=>socket.end(message));
      });
    }
    const body='{"name":"must not persist"}';
    const headers=`Host: ${new URL(f.config.publicOrigin).host}\r\nOrigin: ${f.config.publicOrigin}\r\nCookie: ${owner.cookie}\r\nX-RunPhantom-CSRF: ${owner.csrf}\r\nContent-Type: application/json\r\nConnection: close\r\n`;
    const incomplete=await raw(`POST /api/team/projects HTTP/1.1\r\n${headers}Content-Length: ${Buffer.byteLength(body)+10}\r\n\r\n${body}`);
    expect(incomplete).not.toMatch(/^HTTP\/1\.[01] 20/);
    const duplicate=await raw(`POST /api/team/projects HTTP/1.1\r\n${headers}Cookie: ${owner.cookie}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    expect(duplicate).not.toMatch(/^HTTP\/1\.[01] 20/);expect(duplicate).not.toContain(owner.cookie);
    expect((await f.call("GET","/api/team/projects",undefined,owner)).json.items).toHaveLength(0);
  } finally {await f.close();}
});
