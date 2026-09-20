import assert from "node:assert/strict";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { execFileSync, execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const directory=mkdtempSync(join(tmpdir(),"subly-package-"));
let transport;
let diagnosticsServer;
try {
  const osEnv=Object.fromEntries(["PATH","SystemRoot","WINDIR","ComSpec","PATHEXT","TEMP","TMP","TMPDIR"].flatMap(name=>{
    const key=Object.keys(process.env).find(key=>key.toLowerCase()===name.toLowerCase());
    return key && process.env[key]!==undefined ? [[name,process.env[key]]] : [];
  }));
  const childBaseEnv={...osEnv,HOME:directory,USERPROFILE:directory};
  assert(process.env.npm_execpath,"Run this smoke check with npm run test:package");
  const npm=(args,options)=>execFileSync(process.execPath,[process.env.npm_execpath,...args],{...options,env:childBaseEnv});
  // prepack must discard artifacts from older builds, even inside the allowed dist directory.
  mkdirSync(resolve("packages/pay/dist"),{recursive:true});
  writeFileSync(resolve("packages/pay/dist/stale-release-artifact.txt"),"must-not-be-published\n");
  const pack=JSON.parse(npm(["pack","--json","--pack-destination",directory],{cwd:resolve("packages/pay"),encoding:"utf8"}));
  assert(pack[0].files.every(f=> /^(dist\/[a-z-]+\.js$|README\.md$|LICENSE$|package\.json$)/.test(f.path)),"Unexpected package contents, including stale build artifacts");
  assert(pack[0].files.some(f=>f.path==="dist/status.js"),"Missing status command bundle");
  assert(pack[0].files.some(f=>f.path==="dist/owner.js"),"Missing owner management command bundle");
  npm(["init","-y"],{cwd:directory,stdio:"ignore"});
  npm(["install","--ignore-scripts","--no-audit","--no-fund",join(directory,pack[0].filename)],{cwd:directory,stdio:"inherit"});
  const cli=join(directory,"node_modules/@subly_fi/pay/dist/cli.js");
  const env={...childBaseEnv,SUBLY_RELAYER_URL:"http://127.0.0.1:1",SOLANA_RPC_URL:"http://127.0.0.1:1",SUBLY_MCP_STATE_PATH:join(directory,"pending.json")};
  const run=(args)=>execFileSync(process.execPath,[cli,...args],{cwd:directory,env,encoding:"utf8",timeout:15000});
  const version=JSON.parse(readFileSync(resolve("packages/pay/package.json"),"utf8")).version;
  assert.equal(run(["--version"]).trim(),version);
  assert.match(run(["--help"]),/doctor/);
  assert.match(run(["deposit","--help"]),/rawUSDC/);
  assert.match(run(["status","--help"]),/status <dep_\.\.\.\|wdr_\.\.\.>/);
  assert.match(run(["owner-link","--help"]),/omitted values are preserved/);
  assert.equal(JSON.parse(run(["vaults"])).version,1);
  assert.throws(()=>run(["toString"]));
  const keyPath=join(directory,"agent.json");
  const agentKey=nacl.sign.keyPair();
  writeFileSync(keyPath,JSON.stringify(Array.from(agentKey.secretKey)),{mode:0o600});
  const catalogue=JSON.parse(run(["vaults"]));
  const intentId=`wdr_${"a".repeat(32)}`;
  const statusRequests=[];
  const ownerRequests=[];
  const ownerSessionId=`st_${"b".repeat(32)}`;
  const unexpectedFinancialRequests=[];
  let statusFixtureState="submitted";
  let rpcGenesisHash="5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  let readinessStatus=200;
  diagnosticsServer=createServer(async (request,response)=>{
    response.setHeader("content-type","application/json");
    if(/\/(prepare|submit|sync|budget|agent)(\?|$)/.test(request.url??"")){
      unexpectedFinancialRequests.push(request.url);response.statusCode=500;
      response.end(JSON.stringify({error:{message:"Status must not invoke another operation"}}));return;
    }
    if (/\/(owner-sessions|mandate)(\/|\?|$)/.test(request.url??"")) {
      let body="";
      for await (const chunk of request) body+=chunk;
      const signedAt=String(request.headers["x-subly-signed-at"]??"");
      const message=new TextEncoder().encode(`subly-api:${request.method}:${request.url}:${createHash("sha256").update(body).digest("hex")}:${signedAt}`);
      let valid=false;
      try { valid=request.headers["x-subly-wallet"]===bs58.encode(agentKey.publicKey) &&
        Math.abs(Date.now()-Number(signedAt))<300000 && nacl.sign.detached.verify(message,bs58.decode(String(request.headers["x-subly-signature"])),agentKey.publicKey); } catch {}
      if(!valid){response.statusCode=401;response.end(JSON.stringify({error:{message:"Invalid owner authentication"}}));return;}
      ownerRequests.push({method:request.method,path:request.url,body:body?JSON.parse(body):null});
      const ownerBase={wallet:bs58.encode(agentKey.publicKey),vault:catalogue.defaultVault};
      if(request.url.endsWith("/owner-sessions")) {
        response.end(JSON.stringify({...ownerBase,sessionId:ownerSessionId,ownerUrl:`http://127.0.0.1/owner/${ownerSessionId}`}));return;
      }
      if(request.url===`/v1/owner-sessions/${ownerSessionId}`) {
        response.end(JSON.stringify({...ownerBase,sessionId:ownerSessionId,status:"completed",action:"update"}));return;
      }
      if(request.url.includes("/recovery-revoke?")) {
        response.end(JSON.stringify({...ownerBase,status:"recovery_pending",recoveryAtMs:Date.now()+72*3600000}));return;
      }
      response.end(JSON.stringify({...ownerBase,status:"active",effectiveStatus:"active",mandateHash:"hash",
        recoveryAtMs:null,revokedAtMs:null,mandate:{vault:catalogue.defaultVault,policy:{perPaymentCapRawUsdc:"10000"},expiresAtMs:Date.now()+86400000,
          ownerSignature:"must-not-leak-owner-signature"}}));return;
    }
    if(request.url===`/v1/withdrawals/${intentId}?resubmit=false`){
      statusRequests.push({method:request.method,path:request.url});
      const signedAt=String(request.headers["x-subly-signed-at"]??"");
      const message=new TextEncoder().encode(`subly-api:GET:${request.url}:${createHash("sha256").update("").digest("hex")}:${signedAt}`);
      let valid=false;
      try{valid=request.method==="GET" && request.headers["x-subly-wallet"]===bs58.encode(agentKey.publicKey) &&
        Math.abs(Date.now()-Number(signedAt))<300000 && nacl.sign.detached.verify(message,bs58.decode(String(request.headers["x-subly-signature"])),agentKey.publicKey);}catch{}
      if(!valid){response.statusCode=401;response.end(JSON.stringify({error:{code:"invalid_auth",message:"Invalid status authentication"}}));return;}
      response.end(JSON.stringify({withdrawalId:intentId,wallet:bs58.encode(agentKey.publicKey),vault:catalogue.defaultVault,
        requestedWithdrawRawUsdc:"10000",actualWithdrawRawUsdc:statusFixtureState==="confirmed"?"10000":null,
        txSignature:"original-signature",status:statusFixtureState,errorCode:null,
        serializedTransaction:"must-not-leak-transaction",submittedSerializedTransaction:"must-not-leak-signed-transaction"}));
      return;
    }
    if(request.url === "/readyz") response.statusCode=readinessStatus;
    response.end(JSON.stringify(request.method === "POST" ? {jsonrpc:"2.0",id:1,result:rpcGenesisHash} : request.url === "/v1/vaults" ? catalogue : {ok:response.statusCode===200}));
  });
  await new Promise(resolve=>diagnosticsServer.listen(0,"127.0.0.1",resolve));
  const diagnosticUrl=`http://127.0.0.1:${diagnosticsServer.address().port}`;
  const statusEnv={...env,SUBLY_RELAYER_URL:diagnosticUrl,SUBLY_DEMO_AGENT_KEYPAIR_PATH:keyPath};
  const runOwner=async args=>JSON.parse((await promisify(execFile)(process.execPath,[cli,...args],{cwd:directory,env:statusEnv,timeout:15000})).stdout);
  assert.equal((await runOwner(["owner-link","--per-payment-cap","10000"])).sessionId,ownerSessionId);
  assert.equal((await runOwner(["owner-status",ownerSessionId])).status,"completed");
  assert.equal((await runOwner(["recovery-start"])).status,"recovery_pending");
  const ownerStatus=await runOwner(["recovery-status"]);
  assert.equal(ownerStatus.effectiveStatus,"active");assert(!JSON.stringify(ownerStatus).includes("must-not-leak"));
  assert.deepEqual(ownerRequests.map(r=>r.method),["POST","GET","POST","GET"]);
  assert.deepEqual(ownerRequests[0].body,{policy:{perPaymentCapRawUsdc:"10000"},vault:catalogue.defaultVault});
  assert(ownerRequests[2].path.endsWith(`?vault=${catalogue.defaultVault}`));
  await assert.rejects(promisify(execFile)(process.execPath,[cli,"owner-status","st_../../prepare"],{cwd:directory,env:statusEnv,timeout:15000}));
  assert.equal(ownerRequests.length,4);
  const firstStatus=await promisify(execFile)(process.execPath,[cli,"status",intentId],{cwd:directory,env:statusEnv,timeout:15000});
  assert.equal(JSON.parse(firstStatus.stdout).status,"submitted");
  assert.equal(JSON.parse(firstStatus.stdout).nextAction,"check_again");
  assert(!firstStatus.stdout.includes("must-not-leak"));
  statusFixtureState="confirmed";
  const finalStatus=await promisify(execFile)(process.execPath,[cli,"status",intentId],{cwd:directory,env:statusEnv,timeout:15000});
  assert.equal(JSON.parse(finalStatus.stdout).status,"confirmed");
  assert.equal(JSON.parse(finalStatus.stdout).actualAmountRawUsdc,"10000");
  await assert.rejects(promisify(execFile)(process.execPath,[cli,"status","wdr_../../prepare"],{cwd:directory,env:statusEnv,timeout:15000}));
  assert.equal(statusRequests.length,2);
  const diagnostic=await promisify(execFile)(process.execPath,[cli,"doctor"],{cwd:directory,env:{...env,SUBLY_RELAYER_URL:diagnosticUrl,SOLANA_RPC_URL:diagnosticUrl,SUBLY_DEMO_AGENT_KEYPAIR_PATH:keyPath},timeout:15000});
  assert.equal(JSON.parse(diagnostic.stdout).ok,true);
  for(const invalidGenesis of ["5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "GH7ome3EiwEr7tu9JuTh2dpYWBJK3z69Xm1ZE3MEE6JC"]) {
    rpcGenesisHash=invalidGenesis;
    await assert.rejects(promisify(execFile)(process.execPath,[cli,"doctor"],{cwd:directory,env:{...env,SUBLY_RELAYER_URL:diagnosticUrl,SOLANA_RPC_URL:diagnosticUrl,SUBLY_DEMO_AGENT_KEYPAIR_PATH:keyPath},timeout:15000}), error=>{
      assert.equal(error.code,1);
      assert.equal(JSON.parse(error.stdout).checks.find(c=>c.name==="Solana RPC").ok,false);
      return true;
    });
  }
  rpcGenesisHash="5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  readinessStatus=503;
  await assert.rejects(promisify(execFile)(process.execPath,[cli,"doctor"],{cwd:directory,env:{...env,SUBLY_RELAYER_URL:diagnosticUrl,SOLANA_RPC_URL:diagnosticUrl,SUBLY_DEMO_AGENT_KEYPAIR_PATH:keyPath},timeout:15000}), error=>{
    assert.equal(error.code,1);
    assert.equal(JSON.parse(error.stdout).checks.find(c=>c.name==="relayer and vault").ok,false);
    return true;
  });
  transport=new StdioClientTransport({command:process.execPath,args:[cli,"mcp"],cwd:directory,env:statusEnv,stderr:"pipe"});
  const client=new Client({name:"package-smoke",version:"1.0.0"});
  await client.connect(transport, {timeout:15000});
  const result=await client.listTools({}, {timeout:15000});
  const names=result.tools.map(t=>t.name);
  for(const name of ["list_subly_vaults","select_subly_vault","create_subly_setup_link","check_subly_setup","check_subly_vault_operation","deposit_to_subly_vault","get_subly_yield_budget","withdraw_from_subly_vault","fetch_with_subly_payment","create_subly_owner_link","check_subly_owner_session","get_subly_owner_status","start_subly_owner_recovery"])assert(names.includes(name),`Missing ${name}`);
  for(const [name,args] of [["create_subly_owner_link",{}],["check_subly_owner_session",{sessionId:ownerSessionId}],["get_subly_owner_status",{}],["start_subly_owner_recovery",{}]]) {
    const ownerResult=await client.callTool({name,arguments:args},undefined,{timeout:15000});
    assert(!ownerResult.isError);assert(!JSON.stringify(ownerResult).includes("must-not-leak"));
  }
  assert.equal(ownerRequests.length,8);
  const operationStatus=await client.callTool({name:"check_subly_vault_operation",arguments:{intentId}},undefined,{timeout:15000});
  assert.equal(JSON.parse(operationStatus.content[0].text).status,"confirmed");
  assert(!operationStatus.content[0].text.includes("must-not-leak"));
  assert.deepEqual(statusRequests,Array.from({length:3},()=>({method:"GET",path:`/v1/withdrawals/${intentId}?resubmit=false`})));
  assert.deepEqual(unexpectedFinancialRequests,[]);
  await client.close();
  console.log(`Installed @subly_fi/pay@${version}: CLI and ${names.length} MCP tools verified with local fixtures and no chain transactions.`);
} finally {
  await transport?.close();
  if(diagnosticsServer)await new Promise(resolve=>diagnosticsServer.close(resolve));
  rmSync(directory,{recursive:true,force:true});
}
