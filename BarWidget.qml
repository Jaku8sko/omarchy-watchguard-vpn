import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui
import qs.Commons

// Bar widget for user-name.watchguard-vpn: compact VPN state pill.
// Click toggles the management panel; middle/right click refreshes state.
// The headless Service.qml singleton (same plugin, kind "service") owns all
// nmcli traffic; this widget only reads its properties.
BarWidget {
  id: root
  moduleName: "user-name.watchguard-vpn"

  readonly property var service: bar && bar.shell ? bar.shell.serviceFor("user-name.watchguard-vpn") : null

  readonly property string vpnState: service ? service.vpnState : "missing"
  readonly property string connName: service ? service.connectionName : setting("connectionName", "")
  readonly property string stateLabel: {
    if (!service) return "VPN …"
    if (!service.installed) return "VPN setup"
    switch (root.vpnState) {
    case "connected": return "VPN on"
    case "connecting": return "VPN…"
    case "failed": return "VPN failed"
    case "missing": return "VPN setup"
    default: return "VPN off"
    }
  }
  readonly property string glyph: "󰖂"
  readonly property color glyphColor: {
    if (!service || !bar) return Color.foreground
    if (root.vpnState === "connected") return bar.foreground
    if (root.vpnState === "failed") return bar.urgent
    return Qt.darker(bar.foreground, 1.55)
  }
  readonly property string tooltip: {
    if (!service) return "WatchGuard VPN is loading"
    if (!service.installed) return "OpenVPN support is not installed — open to install"
    if (root.connName === "") return "No VPN profile — open to import an .ovpn file"
    var tip = root.connName + ": " + root.vpnState
    if (service.lastError !== "") tip += "\n" + service.lastError
    else if (service.hasPasswordFlags2) tip += "\nPassword is requested every connect (never stored)"
    return tip
  }

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function togglePanel() { if (panelLoader.item) panelLoader.item.toggle() }
  function doRefreshLocal() { if (root.service) root.service.refresh() }

  // Persist the managed connection name inline on this widget's shell.json
  // entry (the sanctioned settings store). Only the name — never secrets.
  function persistConnectionName(name) {
    if (!root.bar || !root.bar.shell || typeof root.bar.shell.updateEntryInline !== "function") return
    var entry = { id: root.moduleName }
    for (var key in settings) if (key !== "id") entry[key] = settings[key]
    entry.connectionName = String(name || "")
    root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
    if ("vpnService" in target) target.vpnService = root.service
  }

  // Widget settings (shell.json bar entry) are the authority for which
  // connection this widget manages. Push them into a fresh service after
  // every (re)load; the service alone cannot recover the name because the
  // host injects it with empty settings on hot-reload.
  function syncServiceName() {
    if (!root.service) return
    var want = root.setting("connectionName", "")
    if (want !== "" && want !== root.service.connectionName)
      root.service.adoptConnection(want)
    else if (want === "")
      root.service.initFromSettings()
    else
      root.service.refresh()
  }

  onServiceChanged: {
    if (root.service) {
      root.syncServiceName()
      root.service.connectionChanged.connect(persistFromService)
    }
    injectPanel()
  }
  function persistFromService(name) { root.persistConnectionName(name) }

  onBarChanged: { root.syncServiceName(); injectPanel() }
  onSettingsChanged: {
    root.syncServiceName()
    injectPanel()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  IpcHandler {
    target: "user-name.watchguard-vpn"

    function status(): string {
      if (!root.service) return "WatchGuard VPN service is not running"
      var lines = ["connection: " + (root.connName || "(none)"),
        "state: " + root.vpnState,
        "username: " + (root.service.username || "(unset)"),
        "always-ask password: " + (root.service.hasPasswordFlags2 ? "yes" : "no")]
      if (root.service.duplicateWarning) lines.push("note: duplicate profile names — managing by ID")
      if (root.service.lastError !== "") lines.push("error: " + root.service.lastError)
      return lines.join("\n")
    }
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.togglePanel() }
    function refresh(): string {
      if (!root.service) return "service_unavailable"
      root.broadcast("doRefreshLocal")
      return "ok"
    }
    function connect(): string {
      if (!root.service) return "service_unavailable"
      root.service.connect()
      return "ok"
    }
    function disconnect(): string {
      if (!root.service) return "service_unavailable"
      root.service.disconnect()
      return "ok"
    }
    function adopt(name: string): string {
      if (!root.service) return "service_unavailable"
      root.service.adoptConnection(name)
      return "ok"
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    labelVisible: false
    hasVisualContent: true
    fixedWidth: root.vertical ? -1 : horizontalContent.implicitWidth + scaledHorizontalMargin * 2
    fixedHeight: root.vertical ? Style.bar.iconSlot * 2 : -1
    horizontalMargin: 8.5
    tooltipText: root.tooltip
    active: root.vpnState === "connected"
    onPressed: function(b) {
      if (b === Qt.MiddleButton || b === Qt.RightButton) {
        root.broadcast("doRefreshLocal")
        return
      }
      root.togglePanel()
    }

    Row {
      id: horizontalContent
      visible: !root.vertical
      anchors.centerIn: parent
      spacing: Style.space(5)

      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: root.glyph
        color: root.glyphColor
        font.family: button.fontFamily
        font.pixelSize: button.fontSize
      }
      Text {
        text: root.stateLabel
        color: button.foreground
        font.family: button.fontFamily
        font.pixelSize: button.fontSize
        renderType: Text.NativeRendering
      }
    }

    Column {
      visible: root.vertical
      anchors.fill: parent
      Text {
        width: button.width
        height: Style.bar.iconSlot
        text: root.glyph
        color: root.glyphColor
        font.family: button.fontFamily
        font.pixelSize: button.fontSize
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
      }
      Text {
        width: button.width
        height: Style.bar.iconSlot
        text: root.vpnState === "connected" ? "on" : "off"
        color: button.foreground
        font.family: button.fontFamily
        font.pixelSize: Style.font.caption
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
      }
    }
  }
}
