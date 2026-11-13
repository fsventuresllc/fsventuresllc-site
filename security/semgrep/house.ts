// tw-028: fixture for security/semgrep/house.yml, checked by `semgrep --test security/semgrep`
// (each annotated line below must or must not be flagged). Never imported; outside every scanned path.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

export async function routes(app: any) {
  app.post("/api/v1/seed", async (request: any, reply: any) => {
    // ruleid: house-dynamic-code-execution, house-fastify-request-to-dangerous-sink
    const out = eval(request.body);
    const q = request.query as { cmd: string; file: string };
    // ruleid: house-fastify-request-to-dangerous-sink
    execSync(`ls ${q.cmd}`);
    // ruleid: house-fastify-request-to-dangerous-sink
    readFileSync(q.file);
    // ok: house-fastify-request-to-dangerous-sink
    readFileSync("/etc/hostname");
    return reply.send({ out });
  });
}

export function other(code: string) {
  // ruleid: house-dynamic-code-execution
  new Function(code);
  // ruleid: house-dynamic-code-execution
  setTimeout("tick()", 10);
  // ok: house-dynamic-code-execution
  setTimeout(() => code, 10);
  // ok: house-dynamic-code-execution
  eval("1 + 1");
}
