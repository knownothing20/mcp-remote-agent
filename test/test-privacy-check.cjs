const assert = require("assert");
const { isForbiddenPath, scanContent } = require("../scripts/check-privacy.cjs");

function content(value) {
  return Buffer.from(value, "utf8");
}

assert.equal(isForbiddenPath("local/connections.json"), true);
assert.equal(isForbiddenPath("daemon/.env.example"), false);
assert.equal(isForbiddenPath("docs/example.pem"), true);
assert.deepEqual(scanContent(content("Server: 192" + ".168.1.20")), ["private-network-address"]);
assert.deepEqual(scanContent(content("Path: /home/" + "le" + "on/project")), ["machine-specific-linux-home"]);
assert.deepEqual(scanContent(content("Host: " + "le" + "on" + "@example")), ["machine-specific-ssh-user"]);
assert.deepEqual(scanContent(content("Example: 192.0.2.10 and /home/YOUR_USER")), []);

console.log("PASS privacy check rules");
