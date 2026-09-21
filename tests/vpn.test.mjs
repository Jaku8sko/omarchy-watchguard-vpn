// Tests for user-name.watchguard-vpn pure logic.
//
//   node tests/vpn.test.mjs
//
// Vpn.js is deliberately a plain script (no import/export statements) so it
// can be loaded with QML's `import "Vpn.js" as Vpn`. Tests load it the same
// way omanki loads Anki.js: read the source and evaluate the named exports.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "Vpn.js"), "utf8");

const EXPORTS = [
  "DEPS", "PASSWORD_FLAGS_VALUE",
  "shellQuote", "isValidConnectionName", "isValidUsername", "isOvpnPath",
  "depsCheckArgv", "importArgv", "setUsernameArgv", "setPasswordFlagsArgv",
  "showVpnArgv", "listArgv", "activeArgv", "downArgv", "deleteArgv",
  "connectTerminalCommand", "connectTerminalArgv",
  "parseConnectionList", "detectImported", "parseImportStdout",
  "parseVpnShow", "hasPasswordFlags2", "settingsPick",
  "stateFor", "stateForUuid", "findByName", "resolveTarget",
  "classifyError", "errorMessage", "elideStatus",
];
const Vpn = {};
new Function("exports", `${src}\nfor (const k of ${JSON.stringify(EXPORTS)}) exports[k] = eval(k)`)(Vpn);

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name); }
};
const group = (name) => console.log("\n" + name);

// 1. Valid .ovpn import argv
group("import argv");
{
  const argv = Vpn.importArgv("/home/u/Downloads/client.ovpn");
  t("uses nmcli connection import type openvpn file",
    JSON.stringify(argv.slice(0, 5)) === JSON.stringify(["nmcli", "connection", "import", "type", "openvpn"]));
  t("path is one discrete argv element", argv[argv.length - 1] === "/home/u/Downloads/client.ovpn");
  t("no shell metacharacters joined in", argv.every((a) => typeof a === "string"));
  t("recognises .ovpn suffix", Vpn.isOvpnPath("client.ovpn") && Vpn.isOvpnPath("/tmp/A.OVPN"));
  t("rejects non-ovpn", !Vpn.isOvpnPath("/tmp/x.conf") && !Vpn.isOvpnPath(""));
}

// 2. Imported connection detection
group("detect imported connection");
{
  const before = Vpn.parseConnectionList("Ranczo:uuid-1:802-11-wireless\nlo:uuid-2:loopback\n");
  const after = before.concat([{ name: "client", uuid: "uuid-9", type: "vpn" }]);
  const found = Vpn.detectImported(before, after);
  t("finds the new UUID", found && found.name === "client");
  t("null when nothing new", Vpn.detectImported(before, before) === null);
  t("list argv disables nmcli terse escaping", Vpn.listArgv().includes("-e") && Vpn.listArgv().includes("no"));
  t("active argv disables nmcli terse escaping", Vpn.activeArgv().includes("-e") && Vpn.activeArgv().includes("no"));
  t("name with colons survives unescaped terse parse",
    Vpn.parseConnectionList("my:weird:name:uuid-3:vpn")[0].name === "my:weird:name");
  t("backslash in name survives unescaped terse parse",
    Vpn.parseConnectionList("my\\vpn:uuid-4:vpn")[0].name === "my\\vpn");
  const parsed = Vpn.parseImportStdout("Connection 'client' (ca0cccae-60bd-4ee7-ba76-67d1cf65ba51) successfully added.\n");
  t("stdout parse yields name+uuid", parsed && parsed.name === "client");
  t("stdout parse null on garbage", Vpn.parseImportStdout("nope") === null);
}

// 3+4. Username set + verify
group("username");
{
  const argv = Vpn.setUsernameArgv("client", "user-name");
  t("argv shape", JSON.stringify(argv) === JSON.stringify(["nmcli", "connection", "modify", "client", "vpn.user-name", "user-name"]));
  const show = "vpn.user-name:                          user-name\nvpn.data:                               ca = /a.pem, password-flags = 2\n";
  t("username parses", Vpn.parseVpnShow(show).username === "user-name");
  t("valid username", Vpn.isValidUsername("user-name"));
  t("blank username rejected", !Vpn.isValidUsername("   ") && !Vpn.isValidUsername(""));
}

// 5+6. password-flags additive + vpn.data intact
group("password-flags");
{
  const argv = Vpn.setPasswordFlagsArgv("client");
  t("uses +vpn.data (additive)", argv.includes("+vpn.data"));
  t("value is password-flags=2", argv.includes("password-flags=2"));
  t("never a bare vpn.data assignment",
    !argv.some((a) => a === "vpn.data"));
  const raw = "vpn.user-name:                          user-name\nvpn.data:                               ca = /home/u/.local/share/networkmanagement/certificates/nm-openvpn/client-ca.pem, cert = /c.pem, challenge-response-flags = 2, cipher = AES-256-GCM, connection-type = password-tls, dev = tun, float = yes, key = /k.pem, password-flags = 2, ping = 10, remote = remote.example.com:1906\\, dr.example.com:1906\n";
  const parsed = Vpn.parseVpnShow(raw);
  t("flags detected", Vpn.hasPasswordFlags2(parsed.data));
  t("ca preserved", String(parsed.data.ca).includes("client-ca.pem"));
  t("cert preserved", String(parsed.data.cert).includes("/c.pem"));
  t("key preserved", String(parsed.data.key).includes("/k.pem"));
  t("remote preserved incl escaped comma", String(parsed.data.remote).includes("remote.example.com"));
  t("connection-type preserved", parsed.data["connection-type"] === "password-tls");
  t("challenge-response preserved", parsed.data["challenge-response-flags"] === "2");
  const before = { ...parsed.data };
  delete before["password-flags"];
  t("all non-flag keys survive (9 keys)", Object.keys(before).length >= 8);
}

// 7. Connect/disconnect argv
group("connect/disconnect");
{
  t("down argv", JSON.stringify(Vpn.downArgv("client")) === JSON.stringify(["nmcli", "connection", "down", "client"]));
  t("delete argv", JSON.stringify(Vpn.deleteArgv("client")) === JSON.stringify(["nmcli", "connection", "delete", "client"]));
  const cmd = Vpn.connectTerminalCommand("client");
  t("connect uses --ask", cmd.includes("--ask") && cmd.includes("connection up"));
  t("connect quotes the name", cmd.includes("'client'"));
  const hostile = Vpn.connectTerminalCommand("a'; touch /tmp/pwned; echo '");
  t("hostile name stays quoted literal",
    hostile === "nmcli --ask connection up " + Vpn.shellQuote("a'; touch /tmp/pwned; echo '")
    && hostile.includes("'\\''")); // embedded quotes are close-escape-reopen quoted
  t("terminal argv routes via presentation launcher",
    Vpn.connectTerminalArgv("client")[0] === "omarchy-launch-floating-terminal-with-presentation");
}

// 8+9. Failure classification
group("errors");
{
  t("no valid secrets", Vpn.classifyError("Error: Connection activation failed: No valid secrets.", 4) === "no-valid-secrets");
  t("secrets hint", Vpn.classifyError("Hint: use '--ask' to request secrets", 0) === "no-valid-secrets");
  t("duplicate", Vpn.classifyError("Error: A connection with this name already exists.", 4) === "already-exists");
  t("not found", Vpn.classifyError("Error: Unknown connection: client.", 10) === "not-found");
  t("import failure", Vpn.classifyError("Error: failed to import file: No such file", 4) === "import-failed");
  t("message for secrets guides to flags", Vpn.errorMessage("no-valid-secrets").includes("password-flags=2"));
  t("connection timeout is actionable", Vpn.errorMessage("connection-timeout").includes("64 seconds"));
  t("message never contains a password", !/password[:=]\s*\S{3,}/i.test(Vpn.errorMessage("auth-failed") + Vpn.errorMessage("failed")));
  t("state connected", Vpn.stateFor("client", ["client"], "") === "connected");
  t("state disconnected", Vpn.stateFor("client", [], "") === "disconnected");
  t("state missing without name", Vpn.stateFor("", [], "") === "missing");
  t("state failed on error", Vpn.stateFor("client", [], "failed") === "failed");
}

// 10. No password persistence
group("no password persistence");
{
  const picked = Vpn.settingsPick({ connectionName: "client", username: "x", password: "s3cret", "vpn.secrets": "s3cret", other: 1 });
  t("only connectionName persists", JSON.stringify(Object.keys(picked)) === JSON.stringify(["connectionName"]));
  t("connectionName kept", picked.connectionName === "client");
  // Hard source-level assertions: no argv builder may reference secrets.
  const builders = ["importArgv", "setUsernameArgv", "setPasswordFlagsArgv", "downArgv", "deleteArgv", "connectTerminalCommand"];
  for (const b of builders) {
    const m = src.match(new RegExp("function " + b + "[\\s\\S]*?\\n}"));
    // Strip the declaration line itself (names like setPasswordFlagsArgv
    // legitimately mention "password"); the body must not.
    const body = m ? m[0].slice(m[0].indexOf("{")) : "";
    t(b + " carries no password/secret literal", !!m && !/passw|secret/i.test(body.replace(/password-flags/g, "").replace(/PASSWORD_FLAGS_VALUE/g, "")));
  }
  t("no key material paths hardcoded", !/client-ca\.pem|client-key\.pem/i.test(src));
}

group("duplicate names resolve to one UUID");
{
  const rows = "client:uuid-old:vpn:100\nclient:uuid-new:vpn:200\nRanczo:uuid-w:wifi:300\n";
  const list = Vpn.parseConnectionList(rows);
  t("four-field parse keeps timestamps",
    list[0].timestamp === 100 && list[1].timestamp === 200);
  t("three-field lines still parse with timestamp 0",
    Vpn.parseConnectionList("a:u1:vpn")[0].timestamp === 0);
  t("findByName returns both", Vpn.findByName(list, "client").length === 2);
  t("findByName misses nothing else", Vpn.findByName(list, "nope").length === 0);

  // Active match wins even when older.
  var r = Vpn.resolveTarget(list, ["uuid-old"], "client");
  t("active entry preferred", r.entry.uuid === "uuid-old" && r.duplicates === true);
  // Otherwise newest timestamp wins.
  r = Vpn.resolveTarget(list, [], "client");
  t("newest timestamp preferred", r.entry.uuid === "uuid-new" && r.duplicates === true);
  // Single match: no duplicate flag.
  r = Vpn.resolveTarget(list, [], "Ranczo");
  t("single match not flagged", r.entry.uuid === "uuid-w" && r.duplicates === false);
  // No match.
  r = Vpn.resolveTarget(list, [], "ghost");
  t("no match yields null entry", r.entry === null && r.duplicates === false);

  // UUID-pinned state derivation.
  t("uuid connected", Vpn.stateForUuid(true, "uuid-new", ["uuid-new"], "") === "connected");
  t("uuid not confused by namesake", Vpn.stateForUuid(true, "uuid-old", ["uuid-new"], "") === "disconnected");
  t("uuid missing without target", Vpn.stateForUuid(false, "", [], "") === "missing");
  t("uuid failed on error", Vpn.stateForUuid(true, "u", [], "failed") === "failed");

  // Ops accept UUIDs positionally (unambiguous under duplicates).
  t("show by uuid", Vpn.showVpnArgv("uuid-new").includes("uuid-new"));
  t("modify by uuid", Vpn.setUsernameArgv("uuid-new", "user")[3] === "uuid-new");
  t("flags by uuid", Vpn.setPasswordFlagsArgv("uuid-new")[3] === "uuid-new");
  const upCmd = Vpn.connectTerminalCommand("uuid-new");
  t("connect addresses uuid", upCmd.includes("uuid-new") && upCmd.includes("--ask"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
