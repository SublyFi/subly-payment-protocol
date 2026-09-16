import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.md"], {encoding:"utf8"}).trim().split("\n").filter(f=>f && existsSync(f));
let errors=0;
for (const file of files) {
  const text=readFileSync(file,"utf8").replace(/```[\s\S]*?```/g, "");
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let target=match[1].trim().replace(/^<|>$/g, "").split(/\s+"/)[0];
    if (/^(https?:|mailto:|data:|app:)/.test(target)) continue;
    const [path, anchor]=target.split("#");
    const dest=path ? resolve(dirname(file),decodeURIComponent(path)) : resolve(file);
    if (!existsSync(dest)) {console.error(`${file}: missing ${target}`);errors++;continue;}
    if (anchor && statSync(dest).isFile() && dest.endsWith(".md")) {
      const headings=[...readFileSync(dest,"utf8").matchAll(/^#{1,6} (.+)$/gm)].map(m=>m[1].toLowerCase().replace(/[^\p{L}\p{N}_ \-]/gu, "").replace(/ /g,"-"));
      if (!headings.includes(decodeURIComponent(anchor))) {console.error(`${file}: missing anchor ${target}`);errors++;}
    }
  }
}
if(errors)process.exitCode=1;else console.log(`Documentation links checked (${files.length} Markdown files).`);
