# WatchGuard VPN — Omarchy bar plugin for OpenVPN profiles

Import and manage OpenVPN profiles (primary target: **WatchGuard Firebox
Mobile VPN with SSL + AuthPoint MFA push**) through NetworkManager, from the
Omarchy bar.

## What it does

- **Import** an existing `.ovpn` profile (`nmcli connection import`), detect
  the created NetworkManager connection, and show it in the panel.
- **Edit the VPN username** (`vpn.user-name`) independently of the password.
- **Always ask for the password** (`+vpn.data password-flags=2`, additive —
  every other imported setting is preserved).
- **Connect** by opening a terminal running `nmcli --ask connection up`,
  where you type the password and then `p` for the AuthPoint push.
- **Disconnect / Remove** the profile.
- Show state in the bar: `VPN off` · `VPN…` · `VPN on` · `VPN failed` · `VPN setup`.

## What it never does

- Never stores, logs, or displays the VPN password — there is no password
  field anywhere. `settingsPick()` persists **only** `connectionName`.
- Never rewrites `vpn.data` wholesale (always `+vpn.data`).
- Never copies certificates/keys anywhere; never modifies the `.ovpn` file.
- Never uploads or transmits profile contents or credentials.

## Install

Prerequisites are checked live in the panel; if `openvpn` or
`networkmanager-openvpn` are missing you get an install button that runs:

```bash
omarchy-pkg-add openvpn networkmanager-openvpn
```

(Omarchy's own package helper — never `pacman -Syu`.)

As a git plugin (recommended):

```bash
omarchy plugin add https://github.com/Jaku8sko/omarchy-watchguard-vpn.git --enable
```

By hand:

1. Copy this directory to `~/.config/omarchy/plugins/user-name.watchguard-vpn/`.
2. `omarchy-shell shell rescanPlugins`
3. `omarchy plugin enable user-name.watchguard-vpn`

Validate any copy with:

```bash
omarchy-plugin-validate ~/.config/omarchy/plugins/user-name.watchguard-vpn
```

## Uninstall

If you installed the plugin with Omarchy, disable it and remove the plugin directory:

```bash
omarchy plugin disable user-name.watchguard-vpn
rm -rf ~/.config/omarchy/plugins/user-name.watchguard-vpn
omarchy-shell shell rescanPlugins
```

If you installed it by hand, remove the same directory and rescan plugins:

```bash
rm -rf ~/.config/omarchy/plugins/user-name.watchguard-vpn
omarchy-shell shell rescanPlugins
```

**Note:** uninstalling the plugin does not remove the NetworkManager VPN profile or the OpenVPN packages. To remove a VPN profile separately, use NetworkManager with its connection UUID or name:

```bash
nmcli connection show
nmcli connection delete "<connection-name-or-uuid>"
```

Do not delete the VPN profile if you still want to use it outside the plugin. The plugin itself persists only its connection name in its settings.

## Import a WatchGuard `.ovpn` profile

1. Open the panel (click the `VPN off` pill, or `omarchy-shell shell summon`
   / IPC `toggle` on target `user-name.watchguard-vpn`).
2. **Import OpenVPN Profile** → pick `client.ovpn` in the file chooser.
3. The panel shows the detected connection name (e.g. `client`).
4. Type the VPN username (e.g. `user-name`) → **Save**.
5. The plugin applies `password-flags=2` automatically and verifies the rest
   of `vpn.data` (CA, cert, key, remote, TLS, routes) is intact.

Equivalent backend operations:

```bash
nmcli connection import type openvpn file ~/Downloads/client.ovpn
nmcli connection modify "client" vpn.user-name "user-name"
nmcli connection modify "client" +vpn.data "password-flags=2"
nmcli -f vpn.user-name,vpn.data connection show "client"
```

## Username / password behavior

- **Username** is stored in NetworkManager (`vpn.user-name`) and shown in
  the panel. Editing it never touches the password setting.
- **Password** is never stored. `password-flags=2` forces NetworkManager to
  request it on every activation. If activation ever reports
  `No valid secrets`, the panel tells you to re-apply always-ask and connect
  again — use the **Re-apply always-ask password** button.

## Connect (WatchGuard / AuthPoint)

1. Press **Connect**. A terminal opens.
2. Enter username/password when asked.
3. When asked for the MFA method, enter `p` and approve the AuthPoint push
   on your phone.
4. The bar pill flips to `VPN on`.

The plugin does not auto-answer `p` — the normal OpenVPN/WatchGuard
challenge exchange runs untouched in the terminal.

```bash
nmcli --ask connection up "client"
```

## Menu integration (optional)

Add to `~/.config/omarchy/extensions/omarchy-menu.jsonc` (see
`menu-extension.jsonc` in this repo for a ready snippet):

```jsonc
"setup.network.watchguard-vpn": { "icon": "", "label": "WatchGuard VPN" },
"setup.network.watchguard-vpn.open": {
  "icon": "",
  "label": "Open VPN Panel",
  "action": "omarchy-shell shell toggle user-name.watchguard-vpn '{}'"
},
"setup.network.watchguard-vpn.connect": {
  "icon": "󰈹",
  "label": "Connect",
  "action": "omarchy-shell user-name.watchguard-vpn connect"
},
"setup.network.watchguard-vpn.disconnect": {
  "icon": "󰒃",
  "label": "Disconnect",
  "action": "omarchy-shell user-name.watchguard-vpn disconnect"
},
```

(Full copy in `menu-extension.jsonc`, which also sets the submenu icons.)

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `No valid secrets` on connect | Password not set to ask. Press **Re-apply always-ask password**, then Connect. |
| Import says connection exists | A profile with that name is already imported. Either **adopt it** (the panel lists known VPN profiles when none is managed) or remove/rename first. NetworkManager allows duplicate names — the plugin pins the managed profile by UUID (preferring the active, else most recently used entry) and warns when duplicates exist. |
| `NetworkManager unavailable` | `systemctl status NetworkManager` — the daemon is down. |
| OpenVPN support missing | Install via the panel button (`omarchy-pkg-add openvpn networkmanager-openvpn`). |
| `.ovpn` won't import | File unreadable/invalid, or referenced certs/keys missing. Re-export from the Firebox. |
| Auth fails, no push | Wrong password, or the account isn't AuthPoint-enabled. Passwords are never logged — check the Firebox logs. |
| Connection attempt times out | The interactive terminal did not produce an active VPN connection within 64 seconds. Check its authentication/MFA output and try Connect again. |
| Widget shows `VPN setup` | No profile adopted yet — import one, or set `connectionName` in the widget settings. |

## Tests

Pure-logic tests (no shell needed):

```bash
node tests/vpn.test.mjs
```

They cover import argv, connection detection, username set/verify,
additive `password-flags`, vpn.data preservation, connect/disconnect argv,
error classification, state derivation, and no-password-persistence
(including a source scan asserting no secret literals in argv builders).
