#!/usr/bin/env node
const assert = require("node:assert/strict");
const http = require("node:http");
const {
  installDevelopmentResponseSanitizer,
  sanitizeDevelopmentPayload,
} = require("../daemon/development-gateway-safe.cjs");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathname }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        raw: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
  });
}

async function main() {
  const marker = "SENSITIVE_MARKER_123";
  const payload = {
    success: true,
    session: {
      id: "ses-test",
      commands: { build: `build-tool --credential ${marker}` },
      jobs: [{ jobId: "job-test", commandPreview: `deploy-tool ${marker}` }],
    },
    job: {
      id: "job-test",
      commandPreview: `deploy-tool ${marker}`,
      env: { INTERNAL_VALUE: marker },
    },
    diff: "const commandPreview = 'this is source code, not metadata';",
  };

  const direct = sanitizeDevelopmentPayload(payload);
  assert.equal(direct.session.commands.build, "[REDACTED]");
  assert.deepEqual(direct.session.commandActions, ["build"]);
  assert.equal(direct.session.jobs[0].commandPreview, "[REDACTED]");
  assert.equal(direct.job.commandPreview, "[REDACTED]");
  assert.equal(direct.job.env, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(direct), new RegExp(marker));
  assert.equal(direct.diff, payload.diff);

  const server = http.createServer((req, res) => {
    const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": body.length,
    });
    res.end(body);
  });
  installDevelopmentResponseSanitizer(server);

  const port = await listen(server);
  try {
    const response = await request(port, "/api/dev/sessions/ses-test");
    assert.equal(response.status, 200);
    assert.equal(Number(response.headers["content-length"]), Buffer.byteLength(response.raw));
    assert.doesNotMatch(response.raw, new RegExp(marker));
    const parsed = JSON.parse(response.raw);
    assert.equal(parsed.session.commands.build, "[REDACTED]");
    assert.equal(parsed.session.jobs[0].commandPreview, "[REDACTED]");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log("PASS daemon development response command redaction");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
