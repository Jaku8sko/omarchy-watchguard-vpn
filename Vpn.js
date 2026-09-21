// Vpn.js — pure OpenVPN/NetworkManager logic for user-name.watchguard-vpn.
//
// Deliberately free of QML imports so it runs under plain node for tests:
//   node tests/vpn.test.mjs
//
// Security rules enforced here:
// - Passwords are NEVER built into argv, settings, logs, or files.
// - vpn.data is only ever modified additively ("+vpn.data password-flags=2").
// - Untrusted names/paths travel as discrete argv elements, never
//   shell-concatenated. shellQuote() exists only for the single case where a
//   command must be rendered as one terminal string (floating-terminal
//   connect), mirroring qs.Commons.Util.shellQuote.

var DEPS = ["openvpn", "networkmanager-openvpn"];
var PASSWORD_FLAGS_VALUE = "password-flags=2";

function shellQuote(value) {
  return "'" + String(value || "").replace(/'/g, "'\\''") + "'";
}

function isValidConnectionName(name) {
  var s = String(name || "").trim();
  if (s === "" || s.length > 128) return false;
  if (s.indexOf("\n") !== -1 || s.indexOf("\0") !== -1) return false;
  return true;
}

function isValidUsername(name) {
  var s = String(name || "").trim();
  if (s === "" || s.length > 256) return false;
  if (/[\n\0]/.test(s)) return false;
  return true;
}

function isOvpnPath(path) {
  return /\.ovpn$/i.test(String(path || "").trim());
}

// --- argv builders (each returns an argv array; no shell involved) ---

function depsCheckArgv() {
  return ["omarchy-pkg-present"].concat(DEPS);
}

function importArgv(ovpnPath) {
  return ["nmcli", "connection", "import", "type", "openvpn", "file", String(ovpnPath)];
}

function setUsernameArgv(connection, username) {
  return ["nmcli", "connection", "modify", String(connection), "vpn.user-name", String(username)];
}

// ADDITIVE only: the leading "+" preserves every other vpn.data key
// (CA, cert, key, remote, TLS, routes...). A bare "vpn.data" would wipe them.
function setPasswordFlagsArgv(connection) {
  return ["nmcli", "connection", "modify", String(connection), "+vpn.data", PASSWORD_FLAGS_VALUE];
}

function showVpnArgv(connection) {
  return ["nmcli", "-f", "vpn.user-name,vpn.data", "connection", "show", String(connection)];
}

function listArgv() {
  // TIMESTAMP lets resolveTarget prefer the most recently used profile when
  // several share one name. nmcli -t separates fields with ":"; names may
  // contain ":" so parseConnectionList splits from the right.
  return ["nmcli", "-t", "-e", "no", "-f", "NAME,UUID,TYPE,TIMESTAMP", "connection", "show"];
}

function activeArgv() {
  return ["nmcli", "-t", "-e", "no", "-f", "NAME,UUID,TYPE,TIMESTAMP", "connection", "show", "--active"];
}

function downArgv(connection) {
  return ["nmcli", "connection", "down", String(connection)];
}

function deleteArgv(connection) {
  return ["nmcli", "connection", "delete", String(connection)];
}

// Rendered terminal command for the interactive connect step. The password
// and the AuthPoint "p" answer are typed by the user inside this terminal;
// this string carries neither. Quoted with shellQuote so hostile connection
// names stay literal.
function connectTerminalCommand(connection) {
  return "nmcli --ask connection up " + shellQuote(connection);
}

// The floating-terminal launcher takes the command as trailing words joined
// with $*; pass the pre-quoted single string through untouched.
function connectTerminalArgv(connection) {
  return ["omarchy-launch-floating-terminal-with-presentation", connectTerminalCommand(connection)];
}

// --- parsers ---

function parseConnectionList(raw) {
  // `-e no` disables nmcli's terse escaping. UUID/type/timestamp contain no
  // colons, so split from the right and preserve colons in NAME.
  // Three-field lines (no TIMESTAMP) are accepted with timestamp 0.
  var out = [];
  var lines = String(raw || "").split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\r$/, "");
    if (line.trim() === "") continue;
    var parts = line.split(":");
    if (parts.length < 3) continue;
    var entry = { name: "", uuid: "", type: "", timestamp: 0 };
    var tail = parts[parts.length - 1];
    if (/^\d+$/.test(tail) && parts.length >= 4) {
      entry.timestamp = parseInt(tail, 10);
      parts.pop();
    }
    entry.type = parts.pop();
    entry.uuid = parts.pop();
    entry.name = parts.join(":");
    if (entry.uuid === "" || entry.type === "") continue;
    out.push(entry);
  }
  return out;
}

function detectImported(before, after) {
  var seen = {};
  for (var i = 0; i < before.length; i++) seen[before[i].uuid] = true;
  for (var j = 0; j < after.length; j++) {
    if (!seen[after[j].uuid]) return after[j];
  }
  return null;
}

// nmcli import prints: Connection 'NAME' (UUID) successfully added.
function parseImportStdout(raw) {
  var m = String(raw || "").match(/Connection\s+'([^']+)'\s+\(([0-9a-fA-F-]{36})\)\s+successfully added/);
  if (!m) return null;
  return { name: m[1], uuid: m[2] };
}

// Parse `nmcli -f vpn.user-name,vpn.data connection show <conn>`.
// Returns { username, data } where data is a {key: value} dict.
function parseVpnShow(raw) {
  var username = "";
  var data = {};
  var lines = String(raw || "").split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var m = line.match(/^\s*vpn\.user-name:\s*(.*?)\s*$/);
    if (m) { username = (m[1] === "--" ? "" : m[1].trim()); continue; }
    var d = line.match(/^\s*vpn\.data:\s*(.*)$/);
    if (d) {
      var rest = d[1].trim();
      if (rest === "" || rest === "--") continue;
      // Split on ", " but honour "\," escapes nmcli uses inside values.
      var items = rest.replace(/\\,/g, "\u0000").split(/,\s*/);
      for (var k = 0; k < items.length; k++) {
        var item = items[k].replace(/\u0000/g, ",").trim();
        var eq = item.indexOf("=");
        if (eq === -1) {
          var bare = item.trim();
          if (bare !== "") data[bare] = "";
        } else {
          data[item.slice(0, eq).trim()] = item.slice(eq + 1).trim();
        }
      }
    }
  }
  return { username: username, data: data };
}

function hasPasswordFlags2(data) {
  return String((data || {})["password-flags"] || "").trim() === "2";
}

// Only username + connectionName may persist. Anything resembling a secret
// key is dropped; callers pass the whole settings object through this.
function settingsPick(settings) {
  var s = settings || {};
  var out = {};
  if (isValidConnectionName(s.connectionName)) out.connectionName = String(s.connectionName);
  else out.connectionName = "";
  return out;
}

// All matches for a name. NetworkManager permits duplicate names, and every
// per-connection query by bare name is then ambiguous (nmcli may answer with
// several profiles concatenated). Callers pin one UUID via resolveTarget and
// use THAT for every subsequent operation.
function findByName(list, name) {
  var out = [];
  var want = String(name || "");
  for (var i = 0; i < (list || []).length; i++) {
    if (list[i] && list[i].name === want) out.push(list[i]);
  }
  return out;
}

// Pick the single entry to manage: the active one wins, otherwise the most
// recently used (highest TIMESTAMP). activeUuids are UUIDs from the --active
// poll (names would be ambiguous exactly when this matters). Returns
// { entry, duplicates } where entry is null when nothing matches.
function resolveTarget(list, activeUuids, name) {
  var matches = findByName(list, name);
  if (matches.length === 0) return { entry: null, duplicates: false };
  var pool = [];
  for (var i = 0; i < matches.length; i++) {
    if ((activeUuids || []).indexOf(matches[i].uuid) !== -1) pool.push(matches[i]);
  }
  if (pool.length === 0) pool = matches;
  var best = pool[0];
  for (var k = 1; k < pool.length; k++) {
    if (Number(pool[k].timestamp || 0) > Number(best.timestamp || 0)) best = pool[k];
  }
  return { entry: best, duplicates: matches.length > 1 };
}

function stateFor(connectionName, activeNames, lastErrorKey) {
  if (!isValidConnectionName(connectionName)) return "missing";
  if ((activeNames || []).indexOf(connectionName) !== -1) return "connected";
  if (lastErrorKey === "connecting") return "connecting";
  if (lastErrorKey && lastErrorKey !== "") return "failed";
  return "disconnected";
}

// UUID-pinned variant used by the live service: with duplicate names a
// name-based "connected" check is ambiguous, so the service tracks the
// resolved UUID and the active UUID set instead.
function stateForUuid(hasTarget, uuid, activeUuids, lastErrorKey) {
  if (!hasTarget) return "missing";
  if ((activeUuids || []).indexOf(uuid) !== -1) return "connected";
  if (lastErrorKey === "connecting") return "connecting";
  if (lastErrorKey && lastErrorKey !== "") return "failed";
  return "disconnected";
}

function classifyError(stderr, exitCode) {
  var text = String(stderr || "");
  if (/No valid secrets/i.test(text)) return "no-valid-secrets";
  if (/already exists|already added|duplicate/i.test(text)) return "already-exists";
  if (/Unknown connection|No such connection|not found/i.test(text)) return "not-found";
  if (/NetworkManager is not running|NetworkManager unavailable|Could not connect.*NetworkManager/i.test(text)) return "nm-unavailable";
  if (/openvpn.*(missing|not installed|not available)|plugin.*missing|vpn.*service.*(missing|failed)/i.test(text)) return "plugin-missing";
  if (/Hint: use .*password.*|Secrets were required|ask.*secret|secret.*(requ|ask)/i.test(text)) return "no-valid-secrets";
  if (/Login failed|authentication failed|AUTH_FAILED|auth failed|No valid secrets/i.test(text)) return "auth-failed";
  if (/Error:.*import|invalid.*profile|could not.*read|No such file/i.test(text)) return "import-failed";
  if (Number(exitCode) !== 0 && text.trim() === "") return "failed";
  if (Number(exitCode) !== 0) return "failed";
  return "";
}

var ERROR_MESSAGES = {
  "no-valid-secrets": "Connection needs secrets: the VPN password was not provided. Re-apply “password-flags=2” so NetworkManager asks every time, then Connect again in the terminal.",
  "already-exists": "A connection with this name already exists. Rename or delete the existing one, or pick a different profile name.",
  "not-found": "Connection not found in NetworkManager. Import the .ovpn profile again.",
  "nm-unavailable": "NetworkManager is unavailable. Check that NetworkManager.service is running.",
  "plugin-missing": "NetworkManager OpenVPN support is missing. Install “openvpn” and “networkmanager-openvpn”.",
  "auth-failed": "Authentication failed. Check username/password, then approve the AuthPoint push. No passwords were stored or logged.",
  "import-failed": "Import failed. Check the .ovpn file is readable, valid, and its referenced certificates/keys exist.",
  "connection-timeout": "Connection did not become active within 64 seconds. Check the terminal for authentication/MFA errors and try again.",
  "failed": "Operation failed. See details, without any passwords, in the panel log line."
};

function errorMessage(key) {
  return ERROR_MESSAGES[String(key || "")] || "";
}

// Elide to one line ≤140 chars for display; never called with secrets:
// callers pass stderr only, and auth commands' stdout is never captured.
function elideStatus(text) {
  var value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length > 140) return value.substring(0, 137) + "…";
  return value;
}

// Node export seam (QML's JS engine has no `module`, so this is skipped there).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DEPS: DEPS,
    PASSWORD_FLAGS_VALUE: PASSWORD_FLAGS_VALUE,
    shellQuote: shellQuote,
    isValidConnectionName: isValidConnectionName,
    isValidUsername: isValidUsername,
    isOvpnPath: isOvpnPath,
    depsCheckArgv: depsCheckArgv,
    importArgv: importArgv,
    setUsernameArgv: setUsernameArgv,
    setPasswordFlagsArgv: setPasswordFlagsArgv,
    showVpnArgv: showVpnArgv,
    listArgv: listArgv,
    activeArgv: activeArgv,
    downArgv: downArgv,
    deleteArgv: deleteArgv,
    connectTerminalCommand: connectTerminalCommand,
    connectTerminalArgv: connectTerminalArgv,
    parseConnectionList: parseConnectionList,
    detectImported: detectImported,
    parseImportStdout: parseImportStdout,
    parseVpnShow: parseVpnShow,
    hasPasswordFlags2: hasPasswordFlags2,
    settingsPick: settingsPick,
    stateFor: stateFor,
    stateForUuid: stateForUuid,
    findByName: findByName,
    resolveTarget: resolveTarget,
    classifyError: classifyError,
    errorMessage: errorMessage,
    elideStatus: elideStatus
  };
}
