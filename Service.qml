import QtQuick
import Quickshell
import Quickshell.Io
import "Vpn.js" as Vpn

// Headless NetworkManager OpenVPN backend for user-name.watchguard-vpn.
//
// All nmcli invocations use discrete argv arrays built by Vpn.js — never
// shell string concatenation. The VPN password is never handled here at
// all: connect launches `nmcli --ask` in a floating terminal where the user
// types the password (and the AuthPoint "p" answer) directly. Auth-command
// output is therefore never captured, logged, or stored.
//
// The single managed profile is identified by connectionName, initialised
// from the widget's shell.json settings by BarWidget and persisted back
// through BarWidget.persistConnectionName(). Only that name is stored.

Item {
  id: root

  property var settings: ({})

  // --- managed profile + live state ---
  property string connectionName: ""
  property bool installed: false        // openvpn + networkmanager-openvpn present
  property bool nmAvailable: true
  property string vpnState: "missing"   // missing | disconnected | connecting | connected | failed
  property string username: ""
  property bool hasPasswordFlags2: false
  property int vpnDataKeys: 0
  property string lastErrorKey: ""
  property string lastError: ""
  property string actionStatus: ""
  property bool refreshing: false

  readonly property int refreshIntervalSec: {
    var raw = settings && settings.refreshIntervalSec !== undefined ? settings.refreshIntervalSec : 5;
    var v = parseInt(String(raw), 10);
    if (!isFinite(v)) v = 5;
    return Math.max(2, Math.min(60, v));
  }
  readonly property bool busy: importProc.running || modifyProc.running || flagsProc.running
    || showProc.running || listProc.running || downProc.running || deleteProc.running
    || pickProc.running || depsProc.running
  readonly property bool ready: installed && nmAvailable

  signal connectionChanged(string name)
  signal profileUpdated()

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  function initFromSettings() {
    var picked = Vpn.settingsPick(settings)
    connectionName = picked.connectionName
    lastErrorKey = ""
    lastError = ""
    refresh()
  }

  function elide(text) {
    return Vpn.elideStatus(text)
  }

  function fail(key, detail) {
    lastErrorKey = key
    var msg = Vpn.errorMessage(key)
    if (msg === "") msg = Vpn.errorMessage("failed")
    lastError = detail ? msg + " (" + elide(detail) + ")" : msg
    if (connectionName !== "" && (activeNames.indexOf(connectionName) === -1))
      vpnState = "failed"
  }

  function clearError() {
    lastErrorKey = ""
    lastError = ""
  }

  // --- polling ---

  property var activeNames: []
  property var _preImport: []

  function refresh() {
    if (depsProc.running) return
    refreshing = true
    depsProc.command = Vpn.depsCheckArgv()
    depsProc.running = true
  }

  function refreshLists() {
    if (listProc.running) return
    listProc.mode = "poll"
    listProc.command = Vpn.listArgv()
    listProc.running = true
  }

  function refreshActive() {
    if (activeProc.running) return
    activeProc.command = Vpn.activeArgv()
    activeProc.running = true
  }

  function refreshVpnDetail() {
    if (connectionName === "" || showProc.running) {
      updateState()
      return
    }
    showProc.command = Vpn.showVpnArgv(connectionName)
    showProc.running = true
  }

  function updateState() {
    vpnState = Vpn.stateFor(connectionName, activeNames,
      lastErrorKey === "" ? "" : (lastErrorKey === "connecting" ? "connecting" : lastErrorKey))
    // A clean poll with no error clears a stale "failed".
    if (lastErrorKey !== "" && lastErrorKey !== "connecting"
        && activeNames.indexOf(connectionName) !== -1) {
      lastErrorKey = ""
      lastError = ""
      vpnState = "connected"
    }
    if (lastErrorKey === "" && connectionName !== "")
      vpnState = activeNames.indexOf(connectionName) !== -1 ? "connected" : "disconnected"
    if (connectionName === "") vpnState = "missing"
    refreshing = false
  }

  // --- actions ---

  function installDeps() {
    actionStatus = "Installing OpenVPN packages…"
    // Terminal owns the sudo prompt; argv stays literal via execArgv-style
    // single pre-quoted command (no secrets involved).
    Quickshell.execDetached(["omarchy-launch-floating-terminal-with-presentation",
      "omarchy-pkg-add openvpn networkmanager-openvpn"])
  }

  function pickProfile() {
    if (pickProc.running) return
    clearError()
    actionStatus = "Select an .ovpn profile…"
    pickProc.command = ["omarchy-file-select", "--title", "Select OpenVPN profile",
      "--extensions", "ovpn"]
    pickProc.running = true
  }

  function importProfile(ovpnPath) {
    var path = String(ovpnPath || "").trim()
    if (path === "") return
    if (!Vpn.isOvpnPath(path)) {
      fail("import-failed", "not an .ovpn file")
      return
    }
    if (listProc.running || importProc.running) return
    clearError()
    actionStatus = "Importing profile…"
    // Snapshot before/after so the created connection is detected by UUID
    // even when nmcli renames or sanitises the profile name.
    _preImport = knownConnections
    listProc.mode = "pre-import"
    listProc.pendingPath = path
    listProc.command = Vpn.listArgv()
    listProc.running = true
  }

  function setUsername(name) {
    var user = String(name || "").trim()
    if (connectionName === "" || !Vpn.isValidUsername(user) || modifyProc.running) return
    clearError()
    actionStatus = "Saving username…"
    modifyProc.pendingUser = user
    modifyProc.command = Vpn.setUsernameArgv(connectionName, user)
    modifyProc.running = true
  }

  function applyPasswordFlags() {
    if (connectionName === "" || flagsProc.running) return
    flagsProc.command = Vpn.setPasswordFlagsArgv(connectionName)
    flagsProc.running = true
  }

  function connect() {
    if (connectionName === "") return
    clearError()
    lastErrorKey = "connecting"
    vpnState = "connecting"
    actionStatus = "Opening terminal for password + AuthPoint MFA…"
    // Foreground terminal: user types the VPN password, then "p" for the
    // AuthPoint push, then approves on their phone. The plugin never sees
    // either secret.
    Quickshell.execDetached(Vpn.connectTerminalArgv(connectionName))
    connectWatchdog.restart()
  }

  function disconnect() {
    if (connectionName === "" || downProc.running) return
    clearError()
    actionStatus = "Disconnecting…"
    downProc.command = Vpn.downArgv(connectionName)
    downProc.running = true
  }

  function removeProfile() {
    if (connectionName === "" || deleteProc.running) return
    clearError()
    actionStatus = "Removing VPN profile…"
    deleteProc.command = Vpn.deleteArgv(connectionName)
    deleteProc.running = true
  }

  function adoptConnection(name) {
    var clean = String(name || "").trim()
    if (!Vpn.isValidConnectionName(clean)) return
    connectionName = clean
    clearError()
    connectionChanged(clean)
    refreshVpnDetail()
  }

  // --- derived data ---

  property var knownConnections: []   // [{name, uuid, type}] vpn entries
  property int knownVpnCount: 0

  function ingestList(raw) {
    var all = Vpn.parseConnectionList(raw)
    var vpns = []
    for (var i = 0; i < all.length; i++)
      if (all[i].type === "vpn") vpns.push(all[i])
    knownConnections = vpns
    knownVpnCount = vpns.length
  }

  Timer {
    id: pollTimer
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Timer {
    // After launching the interactive terminal, re-poll so a successful
    // auth flips the widget to Connected without waiting a full interval.
    // The terminal itself is the password/MFA surface; we only watch state.
    id: connectWatchdog
    interval: 8000
    repeat: true
    onTriggered: {
      root.refreshActive()
      if (root.vpnState === "connected") {
        connectWatchdog.stop()
        root.lastErrorKey = ""
        root.actionStatus = ""
      }
    }
    onRunningChanged: if (!running) root.updateState()
  }

  Timer {
    id: statusClear
    interval: 4000
    repeat: false
    onTriggered: if (root.lastErrorKey === "") root.actionStatus = ""
  }

  // --- processes (stdout captured only for non-secret nmcli queries) ---

  Process {
    id: depsProc
    command: []
    stdout: StdioCollector { id: depsOut; waitForEnd: true }
    stderr: StdioCollector { id: depsErr; waitForEnd: true }
    onExited: function(code) {
      root.installed = code === 0
      if (!root.installed) {
        root.nmAvailable = true
        root.refreshing = false
        return
      }
      root.refreshLists()
    }
  }

  Process {
    id: listProc
    property string mode: "poll"      // poll | pre-import | post-import
    property string pendingPath: ""
    property string pendingStdout: ""
    command: []
    stdout: StdioCollector { id: listOut; waitForEnd: true }
    stderr: StdioCollector { id: listErr; waitForEnd: true }
    onExited: function(code) {
      var out = String(listOut.text || "")
      if (code !== 0) {
        root.nmAvailable = false
        root.fail("nm-unavailable", String(listErr.text || ""))
        return
      }
      root.nmAvailable = true
      if (listProc.mode === "pre-import") {
        root._preImport = Vpn.parseConnectionList(out)
        listProc.mode = "do-import"
        importProc.pendingPath = listProc.pendingPath
        importProc.command = Vpn.importArgv(listProc.pendingPath)
        importProc.running = true
        return
      }
      if (listProc.mode === "post-import") {
        var after = Vpn.parseConnectionList(out)
        var found = Vpn.detectImported(root._preImport, after)
        var viaStdout = Vpn.parseImportStdout(importProc.captured)
        var name = found ? found.name : (viaStdout ? viaStdout.name : "")
        if (name !== "") {
          root.connectionName = name
          root.connectionChanged(name)
          root.actionStatus = "Profile imported. Applying always-ask password…"
          root.applyPasswordFlags()
        } else {
          root.fail("import-failed", "imported connection not found")
        }
        listProc.mode = "poll"
        root.refreshActive()
        return
      }
      root.ingestList(out)
      root.refreshActive()
    }
  }

  Process {
    id: importProc
    property string pendingPath: ""
    property string captured: ""
    command: []
    stdout: StdioCollector { id: importOut; waitForEnd: true }
    stderr: StdioCollector { id: importErr; waitForEnd: true }
    onExited: function(code) {
      importProc.captured = String(importOut.text || "")
      if (code !== 0) {
        listProc.mode = "poll"
        var errText = String(importErr.text || importProc.captured || "")
        root.fail(Vpn.classifyError(errText, code) || "import-failed", errText)
        return
      }
      listProc.mode = "post-import"
      listProc.command = Vpn.listArgv()
      listProc.running = true
    }
  }

  Process {
    id: activeProc
    command: []
    stdout: StdioCollector { id: activeOut; waitForEnd: true }
    onExited: function(code) {
      if (code === 0) {
        var all = Vpn.parseConnectionList(String(activeOut.text || ""))
        var names = []
        for (var i = 0; i < all.length; i++) names.push(all[i].name)
        root.activeNames = names
      }
      root.refreshVpnDetail()
    }
  }

  Process {
    id: showProc
    command: []
    stdout: StdioCollector { id: showOut; waitForEnd: true }
    stderr: StdioCollector { id: showErr; waitForEnd: true }
    onExited: function(code) {
      if (code !== 0) {
        var errText = String(showErr.text || "")
        var key = Vpn.classifyError(errText, code)
        if (key === "not-found") root.fail(key, "")
        root.updateState()
        return
      }
      var parsed = Vpn.parseVpnShow(String(showOut.text || ""))
      root.username = parsed.username
      root.hasPasswordFlags2 = Vpn.hasPasswordFlags2(parsed.data)
      root.vpnDataKeys = Object.keys(parsed.data).length
      if (!root.hasPasswordFlags2 && root.connectionName !== "")
        root.fail("no-valid-secrets", "")
      else if (root.lastErrorKey === "no-valid-secrets") {
        root.lastErrorKey = ""
        root.lastError = ""
      }
      root.updateState()
    }
  }

  Process {
    id: modifyProc
    property string pendingUser: ""
    command: []
    stdout: StdioCollector { id: modifyOut; waitForEnd: true }
    stderr: StdioCollector { id: modifyErr; waitForEnd: true }
    onExited: function(code) {
      if (code !== 0) {
        root.fail(Vpn.classifyError(String(modifyErr.text || ""), code), String(modifyErr.text || ""))
        return
      }
      root.username = modifyProc.pendingUser
      root.actionStatus = "Username saved."
      root.statusClear.restart()
      root.profileUpdated()
      root.refreshVpnDetail()
    }
  }

  Process {
    id: flagsProc
    command: []
    stdout: StdioCollector { id: flagsOut; waitForEnd: true }
    stderr: StdioCollector { id: flagsErr; waitForEnd: true }
    onExited: function(code) {
      if (code !== 0) {
        root.fail(Vpn.classifyError(String(flagsErr.text || ""), code), String(flagsErr.text || ""))
        return
      }
      root.actionStatus = "Always-ask password enabled."
      root.statusClear.restart()
      root.profileUpdated()
      root.refreshVpnDetail()
    }
  }

  Process {
    id: downProc
    command: []
    stdout: StdioCollector { id: downOut; waitForEnd: true }
    stderr: StdioCollector { id: downErr; waitForEnd: true }
    onExited: function(code) {
      if (code !== 0) {
        root.fail(Vpn.classifyError(String(downErr.text || ""), code), String(downErr.text || ""))
        return
      }
      root.actionStatus = "Disconnected."
      root.statusClear.restart()
      root.refreshActive()
    }
  }

  Process {
    id: deleteProc
    command: []
    stdout: StdioCollector { id: deleteOut; waitForEnd: true }
    stderr: StdioCollector { id: deleteErr; waitForEnd: true }
    onExited: function(code) {
      if (code !== 0) {
        root.fail(Vpn.classifyError(String(deleteErr.text || ""), code), String(deleteErr.text || ""))
        return
      }
      root.connectionName = ""
      root.username = ""
      root.hasPasswordFlags2 = false
      root.actionStatus = "VPN profile removed."
      root.connectionChanged("")
      root.statusClear.restart()
      root.refreshLists()
    }
  }

  Process {
    id: pickProc
    command: []
    stdout: StdioCollector { id: pickOut; waitForEnd: true }
    stderr: StdioCollector { id: pickErr; waitForEnd: true }
    onExited: function(code) {
      var picked = String(pickOut.text || "").trim()
      if (code !== 0 || picked === "") {
        root.actionStatus = ""
        return
      }
      root.importProfile(picked.split("\n")[0])
    }
  }
}
