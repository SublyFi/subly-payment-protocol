import assert from "node:assert/strict";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import nacl from "tweetnacl";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const directory=mkdtempSync(join(tmpdir(),"subly-package-"));
let transport;
let diagnosticsServer;
try {
  const pack=JSON.parse(execFileSync("npm",["pack","--json","--pack-destination",directory],{cwd:resolve("packages/pay"),encoding:"utf8"}));
  assert(pack[0].files.every(f=> /^(dist\/|README\.md$|LICENSE$|package\.json$)/.test(f.path)),"Unexpected package contents");
  execFileSync("npm",["init","-y"],{cwd:directory,stdio:"ignore"});
  execFileSync("npm",["install","--ignore-scripts","--no-audit","--no-fund",join(directory,pack[0].filename)],{cwd:directory,stdio:"inherit"});
  const cli=join(directory,"node_modules/@subly_fi/pay/dist/cli.js");
  const env={PATH:process.env.PATH,HOME:directory,SUBLY_RELAYER_URL:"http://127.0.0.1:1",SOLANA_RPC_URL:"http://127.0.0.1:1",SUBLY_MCP_STATE_PATH:join(directory,"pending.json")};
  const run=(args)=>execFileSync(process.execPath,[cli,...args],{cwd:directory,env,encoding:"utf8",timeout:15000});
  const version=JSON.parse(execFileSync(process.execPath,["-p","JSON.stringify(require('./packages/pay/package.json').version)"],{encoding:"utf8"}));
  assert.equal(run(["--version"]).trim(),version);
  assert.match(run(["--help"]),/doctor/);
  assert.match(run(["deposit","--help"]),/rawUSDC/);
  assert.equal(JSON.parse(run(["vaults"])).version,1);
  assert.throws(()=>run(["toString"]));
  const keyPath=join(directory,"agent.json");
  writeFileSync(keyPath,JSON.stringify(Array.from(nacl.sign.keyPair().secretKey)),{mode:0o600});
  const catalogue=JSON.parse(run(["vaults"]));
  let rpcGenesisHash="5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  let readinessStatus=200;
  diagnosticsServer=createServer((request,response)=>{
    response.setHeader("content-type","application/json");
    if(request.url === "/readyz") response.statusCode=readinessStatus;
    response.end(JSON.stringify(request.method === "POST" ? {jsonrpc:"2.0",id:1,result:rpcGenesisHash} : request.url === "/v1/vaults" ? catalogue : {ok:response.statusCode===200}));
  });
  await new Promise(resolve=>diagnosticsServer.listen(0,"127.0.0.1",resolve));
  const diagnosticUrl=`http://127.0.0.1:${diagnosticsServer.address().port}`;
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
  transport=new StdioClientTransport({command:process.execPath,args:[cli,"mcp"],cwd:directory,env:{...env,SUBLY_DEMO_AGENT_KEYPAIR_PATH:keyPath},stderr:"pipe"});
  const client=new Client({name:"package-smoke",version:"1.0.0"});
  await client.connect(transport, {timeout:15000});
  const result=await client.listTools({}, {timeout:15000});
  const names=result.tools.map(t=>t.name);
  for(const name of ["list_subly_vaults","select_subly_vault","create_subly_setup_link","check_subly_setup","deposit_to_subly_vault","get_subly_yield_budget","withdraw_from_subly_vault","fetch_with_subly_payment"])assert(names.includes(name),`Missing ${name}`);
  await client.close();
  console.log(`Installed @subly_fi/pay@${version}: CLI and ${names.length} MCP tools verified with local fixtures and no chain transactions.`);
} finally {
  await transport?.close();
  if(diagnosticsServer)await new Promise(resolve=>diagnosticsServer.close(resolve));
  rmSync(directory,{recursive:true,force:true});
}
