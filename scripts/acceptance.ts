import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Isolated Compose project and volume, so acceptance never touches a running personal budget.
const project = `bucketeer-acceptance-${process.pid}`;
let port = 3000;
function compose(...args: string[]): string {
  return execFileSync("docker", ["compose", "-p", project, "-f", "compose.yaml", "-f", "-", ...args], {
    encoding: "utf8",
    input: JSON.stringify({ services: { bucketeer: { environment: { PORT: String(port) } } } }),
    env: { ...process.env, BUCKETEER_PORT: "0", BUCKETEER_BIND: "127.0.0.1" },
    timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}
function cli(...args: string[]): string {
  return compose("exec", "-T", "bucketeer", "bucketeer", "--url", `http://127.0.0.1:${port}`, ...args);
}

try {
  console.log("Building and starting an isolated Docker deployment...");
  compose("up", "-d", "--build", "--wait", "--wait-timeout", "60");
  assert.equal(cli("status"), "ok");
  assert.deepEqual(JSON.parse(cli("status", "--json")), { status: "ok" });
  assert.deepEqual(JSON.parse(cli("budget", "list", "--json")), []);
  const saved = JSON.parse(cli("budget", "save", "--name", "Household", "--json"));
  assert.equal(saved.name, "Household");
  assert.deepEqual(JSON.parse(cli("budget", "open", saved.id, "--json")), saved);
  const updated = JSON.parse(cli("budget", "save", "--id", saved.id, "--name", "Family budget", "--json"));
  assert.equal(updated.id, saved.id);
  assert.equal(updated.createdAt, saved.createdAt);
  assert.equal(updated.name, "Family budget");
  console.log("Budget saved and updated. Recreating with the same volume and a non-default port...");
  port = 4317;
  compose("up", "-d", "--force-recreate", "--wait", "--wait-timeout", "60");
  assert.deepEqual(JSON.parse(cli("budget", "open", saved.id, "--json")), updated);
  assert.deepEqual(JSON.parse(cli("budget", "list", "--json")), [updated]);
  assert.throws(() => cli("budget", "open", "missing", "--json"), (error: unknown) => {
    assert.ok(error && typeof error === "object" && "status" in error && "stdout" in error);
    assert.equal(error.status, 1);
    assert.equal(JSON.parse(String(error.stdout)).error.code, "not_found");
    return true;
  }, "Missing budgets must produce a nonzero exit code.");
  compose("exec", "-T", "bucketeer", "node", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    for (const path of ['/', '/ui/app.js', '/ui/styles.css', '/client.js']) {
      const response = await fetch('http://localhost:${port}' + path);
      assert.equal(response.status, 200, path);
      assert.ok((await response.text()).length > 0, path);
    }
  `);
  console.log("PASS: Docker health on default and custom ports, CLI save/list/open/update, container recreation, persistence, errors, and UI assets.");
} finally {
  compose("down", "--volumes", "--remove-orphans", "--rmi", "local");
}
