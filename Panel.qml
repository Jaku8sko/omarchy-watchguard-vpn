import QtQuick
import QtQuick.Layouts
import Quickshell
import qs.Ui
import qs.Commons

// Management panel for user-name.watchguard-vpn.
//
// Import an .ovpn profile, edit the (non-secret) username, and
// connect/disconnect through NetworkManager. There is deliberately NO
// password field: `password-flags=2` makes NetworkManager ask every time,
// and Connect opens a terminal where the user types the password plus the
// AuthPoint "p" answer directly.
Panel {
  id: root
  moduleName: "user-name.watchguard-vpn"

  property var anchorItem: null
  property var hostWidget: null
  property var vpnService: null

  readonly property var service: vpnService
  readonly property string connName: service ? service.connectionName : ""
  readonly property string vpnState: service ? service.vpnState : "missing"
  readonly property bool installed: service ? service.installed : false
  readonly property bool busy: service ? service.busy : false
  readonly property string stateText: {
    switch (root.vpnState) {
    case "connected": return "CONNECTED"
    case "connecting": return "CONNECTING…"
    case "failed": return "CONNECTION FAILED"
    case "missing": return "NO PROFILE"
    default: return "DISCONNECTED"
    }
  }
  readonly property color stateColor: {
    if (root.vpnState === "connected") return bar ? bar.foreground : Color.foreground
    if (root.vpnState === "failed") return bar ? bar.urgent : Color.urgent
    if (root.vpnState === "connecting") return bar ? bar.accent : Color.accent
    return root.dim
  }
  readonly property color contentForeground: bar ? bar.foreground : Color.foreground
  readonly property string contentFontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color dim: Qt.darker(root.contentForeground, 1.4)

  function open() { root.controller.show() }
  function close() { root.controller.hide() }
  function toggle() { if (root.opened) root.close(); else root.open() }
  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.hostWidget || root, direction)
    return false
  }

  function seedUsername() {
    if (service && !usernameField.activeFocus)
      usernameField.text = service.username || ""
  }

  onOpenedChanged: if (opened) seedUsername()

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // Invisible anchor host: the visible bar button lives in BarWidget.qml;
  // this entry point only owns the popup + lifecycle.
  Item {
    id: button
    anchors.fill: parent
    implicitWidth: 1
    implicitHeight: 1
  }

  Connections {
    target: root.service
    function onUsernameChanged() { root.seedUsername() }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.hostWidget || root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (!root.service) return
        if (t === "c" || t === "C") root.service.connect()
        else if (t === "d" || t === "D") root.service.disconnect()
        else if (t === "i" || t === "I") root.service.pickProfile()
        else if (t === "r" || t === "R") root.service.refresh()
      }
      onMoveRequested: function(dx, dy) {
        if (panelFlick.contentHeight > panelFlick.height)
          panelFlick.contentY = Math.max(0, Math.min(panelFlick.contentHeight - panelFlick.height, panelFlick.contentY + dy * Style.space(24)))
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        Column {
          id: column
          width: panelFlick.width
          spacing: Style.space(12)

          PanelHero {
            width: parent.width
            title: root.connName !== "" ? root.connName : "WatchGuard VPN"
            detail: root.stateText
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
          }

          // Status / error lines. Auth output is never shown: services only
          // surface exit codes plus elided, secret-free diagnostics.
          Text {
            visible: service && (service.actionStatus !== "" || service.lastError !== "")
            width: parent.width
            text: service ? (service.actionStatus !== "" ? service.actionStatus : service.lastError) : ""
            color: service && service.lastError !== "" && service.actionStatus === ""
              ? (bar ? bar.urgent : Color.urgent) : root.stateColor
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          Text {
            visible: service && service.busy
            width: parent.width
            text: "Working…"
            color: root.dim
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }

          // --- missing dependencies ---
          Column {
            visible: service && !service.installed
            width: parent.width
            spacing: Style.space(8)
            Text {
              width: parent.width
              text: "OpenVPN support is not installed (needs “openvpn” and “networkmanager-openvpn”)."
              color: root.dim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
            }
            Button {
              text: "Install OpenVPN packages"
              foreground: root.contentForeground
              fontFamily: root.contentFontFamily
              onClicked: if (root.service) root.service.installDeps()
            }
          }

          // --- no profile yet ---
          Column {
            visible: service && service.installed && root.connName === ""
            width: parent.width
            spacing: Style.space(8)
            Text {
              width: parent.width
              text: "Import a WatchGuard .ovpn profile (Mobile VPN with SSL) to begin."
              color: root.dim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
            }
            Button {
              text: "Import OpenVPN Profile"
              foreground: root.contentForeground
              fontFamily: root.contentFontFamily
              onClicked: if (root.service) root.service.pickProfile()
            }
            Text {
              visible: service && service.knownVpnCount > 0
              width: parent.width
              text: "Or manage a profile that is already imported:"
              color: root.dim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
            Repeater {
              model: service ? service.knownConnections : []
              Button {
                required property var modelData
                width: panelFlick.width
                leftAlign: true
                text: modelData.name
                foreground: root.contentForeground
                fontFamily: root.contentFontFamily
                onClicked: if (root.service) root.service.adoptConnection(modelData.name)
              }
            }
          }

          // --- managed profile ---
          Column {
            visible: service && service.installed && root.connName !== ""
            width: parent.width
            spacing: Style.space(10)

            PanelSectionHeader {
              text: "USERNAME (STORED, NOT A SECRET)"
              foreground: root.contentForeground
              fontFamily: root.contentFontFamily
            }
            RowLayout {
              width: parent.width
              spacing: Style.space(8)
              TextField {
                id: usernameField
                Layout.fillWidth: true
                foreground: root.contentForeground
                placeholderText: "vpn username"
                onAccepted: if (root.service) root.service.setUsername(text)
              }
              Button {
                text: "Save"
                foreground: root.contentForeground
                fontFamily: root.contentFontFamily
                onClicked: if (root.service) root.service.setUsername(usernameField.text)
              }
            }

            PanelSectionHeader {
              text: "CONNECTION"
              foreground: root.contentForeground
              fontFamily: root.contentFontFamily
            }
            Text {
              width: parent.width
              text: service
                ? (service.hasPasswordFlags2
                  ? "Password is requested every connect — never stored."
                  : "Password mode needs repair — re-apply always-ask below.")
                : ""
              color: service && !service.hasPasswordFlags2
                ? (bar ? bar.urgent : Color.urgent) : root.dim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
            Text {
              visible: service && service.duplicateWarning
              width: parent.width
              text: "Several profiles share this name — the most recently used one is managed (pinned by ID). Consider removing the spare."
              color: bar ? bar.urgent : Color.urgent
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            RowLayout {
              width: parent.width
              spacing: Style.space(8)
              Button {
                text: "Connect"
                foreground: root.contentForeground
                fontFamily: root.contentFontFamily
                onClicked: {
                  if (root.service) {
                    root.service.connect()
                    root.close()
                  }
                }
              }
              Button {
                text: "Disconnect"
                foreground: root.contentForeground
                fontFamily: root.contentFontFamily
                onClicked: if (root.service) root.service.disconnect()
              }
            }
            RowLayout {
              width: parent.width
              spacing: Style.space(8)
              Button {
                text: "Import OpenVPN Profile"
                foreground: root.contentForeground
                fontFamily: root.contentFontFamily
                onClicked: if (root.service) root.service.pickProfile()
              }
              Button {
                text: "Remove VPN Profile"
                foreground: root.contentForeground
                fontFamily: root.contentFontFamily
                onClicked: if (root.service) root.service.removeProfile()
              }
            }
            Button {
              visible: service && !service.hasPasswordFlags2
              text: "Re-apply always-ask password"
              foreground: root.contentForeground
              fontFamily: root.contentFontFamily
              onClicked: if (root.service) root.service.applyPasswordFlags()
            }

            PanelSeparator { foreground: root.contentForeground }

            Text {
              width: parent.width
              text: "Connect opens a terminal: enter username/password, then “p” for the AuthPoint push and approve on your phone."
              color: root.dim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
            Text {
              width: parent.width
              text: "Keys: C connect · D disconnect · I import · R refresh"
              color: root.dim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
            }
          }
        }
      }
    }
  }
}
