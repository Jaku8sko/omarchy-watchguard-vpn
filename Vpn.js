// Vpn.js — pure OpenVPN/NetworkManager logic.
// Passwords/secrets are never accepted by argv builders.
var DEPS = ["openvpn", "networkmanager-openvpn"];
var PASSWORD_FLAGS_VALUE = "password-flags=2";

function shellQuote(value) { return "'" + String(value || "").replace(/'/g, "'\\''") + "'"; }
function isValidConnectionName(name) {
  var s = String(name || "").trim();
  return s !== "" && s.length <= 128 && s.indexOf("\n") === -1 && s.indexOf("\0") === -1;
}
function isValidUsername(name) {
  var s = String(name || "").trim();
  return s !== "" && s.length <= 256 && !/[\n\0]/.test(s);
}
function isOvpnPath(path) { return /\.ovpn$/i.test(String(path || "").trim()); }
function depsCheckArgv() { return ["omarchy-pkg-present"].concat(DEPS); }
function importArgv(path) { return ["nmcli","connection","import","type","openvpn","file",String(path)]; }
function setUsernameArgv(connection, username) { return ["nmcli","connection","modify",String(connection),"vpn.user-name",String(username)]; }
function setPasswordFlagsArgv(connection) { return ["nmcli","connection","modify",String(connection),"+vpn.data",PASSWORD_FLAGS_VALUE]; }
function showVpnArgv(connection) { return ["nmcli","-f","vpn.user-name,vpn.data","connection","show",String(connection)]; }
function listArgv() { return ["nmcli","-t","-e","no","-f","NAME,UUID,TYPE,TIMESTAMP","connection","show"]; }
function activeArgv() { return ["nmcli","-t","-e","no","-f","NAME,UUID,TYPE,TIMESTAMP","connection","show","--active"]; }
function downArgv(connection) { return ["nmcli","connection","down",String(connection)]; }
function deleteArgv(connection) { return ["nmcli","connection","delete",String(connection)]; }
function connectTerminalCommand(connection) { return "nmcli --ask connection up " + shellQuote(connection); }
function connectTerminalArgv(connection) { return ["omarchy-launch-floating-terminal-with-presentation",connectTerminalCommand(connection)]; }

// -e no disables nmcli's terse escaping. UUID/type/timestamp contain no
// colons, so splitting from the right preserves colons in NAME.
function parseConnectionList(raw) {
  var out=[], lines=String(raw||"").split("\n");
  for (var i=0;i<lines.length;i++) {
    var line=lines[i].replace(/\r$/,""); if (!line.trim()) continue;
    var parts=line.split(":"); if (parts.length<3) continue;
    var entry={name:"",uuid:"",type:"",timestamp:0}, tail=parts[parts.length-1];
    if (/^\d+$/.test(tail) && parts.length>=4) { entry.timestamp=parseInt(tail,10); parts.pop(); }
    entry.type=parts.pop(); entry.uuid=parts.pop(); entry.name=parts.join(":");
    if (entry.uuid && entry.type) out.push(entry);
  }
  return out;
}
function detectImported(before,after) {
  var seen={}; for(var i=0;i<before.length;i++) seen[before[i].uuid]=true;
  for(var j=0;j<after.length;j++) if(!seen[after[j].uuid]) return after[j];
  return null;
}
function parseImportStdout(raw) {
  var m=String(raw||"").match(/Connection\s+'([^']+)'\s+\(([0-9a-fA-F-]{36})\)\s+successfully added/);
  return m ? {name:m[1],uuid:m[2]} : null;
}
function parseVpnShow(raw) {
  var username="",data={},lines=String(raw||"").split("\n");
  for(var i=0;i<lines.length;i++) {
    var line=lines[i],m=line.match(/^\s*vpn\.user-name:\s*(.*?)\s*$/);
    if(m){username=m[1]==="--"?"":m[1].trim();continue;}
    var d=line.match(/^\s*vpn\.data:\s*(.*)$/); if(!d) continue;
    var rest=d[1].trim(); if(!rest||rest==="--") continue;
    var items=rest.replace(/\\,/g,"\u0000").split(/,\s*/);
    for(var k=0;k<items.length;k++){var item=items[k].replace(/\u0000/g,",").trim(),eq=item.indexOf("=");if(eq===-1){if(item)data[item]="";}else data[item.slice(0,eq).trim()]=item.slice(eq+1).trim();}
  }
  return {username:username,data:data};
}
function hasPasswordFlags2(data){return String((data||{})["password-flags"]||"").trim()==="2";}
function settingsPick(settings){var s=settings||{};return {connectionName:isValidConnectionName(s.connectionName)?String(s.connectionName):""};}
function findByName(list,name){var out=[],want=String(name||"");for(var i=0;i<(list||[]).length;i++)if(list[i]&&list[i].name===want)out.push(list[i]);return out;}
function resolveTarget(list,activeUuids,name){
  var matches=findByName(list,name); if(!matches.length)return {entry:null,duplicates:false};
  var pool=[];for(var i=0;i<matches.length;i++)if((activeUuids||[]).indexOf(matches[i].uuid)!==-1)pool.push(matches[i]);
  if(!pool.length)pool=matches;var best=pool[0];
  for(var k=1;k<pool.length;k++)if(Number(pool[k].timestamp||0)>Number(best.timestamp||0))best=pool[k];
  return {entry:best,duplicates:matches.length>1};
}
function stateFor(connectionName,activeNames,lastErrorKey){if(!isValidConnectionName(connectionName))return "missing";if((activeNames||[]).indexOf(connectionName)!==-1)return "connected";if(lastErrorKey==="connecting")return "connecting";return lastErrorKey?"failed":"disconnected";}
function stateForUuid(hasTarget,uuid,activeUuids,lastErrorKey){if(!hasTarget)return "missing";if((activeUuids||[]).indexOf(uuid)!==-1)return "connected";if(lastErrorKey==="connecting")return "connecting";return lastErrorKey?"failed":"disconnected";}
function classifyError(stderr,exitCode){
  var text=String(stderr||"");
  if(/No valid secrets/i.test(text))return "no-valid-secrets";
  if(/already exists|already added|duplicate/i.test(text))return "already-exists";
  if(/Unknown connection|No such connection|not found/i.test(text))return "not-found";
  if(/NetworkManager is not running|NetworkManager unavailable|Could not connect.*NetworkManager/i.test(text))return "nm-unavailable";
  if(/openvpn.*(missing|not installed|not available)|plugin.*missing|vpn.*service.*(missing|failed)/i.test(text))return "plugin-missing";
  if(/Hint: use .*password.*|Secrets were required|ask.*secret|secret.*(requ|ask)/i.test(text))return "no-valid-secrets";
  if(/Login failed|authentication failed|AUTH_FAILED|auth failed/i.test(text))return "auth-failed";
  if(/Error:.*import|invalid.*profile|could not.*read|No such file/i.test(text))return "import-failed";
  return Number(exitCode)!==0?"failed":"";
}
var ERROR_MESSAGES={
 "no-valid-secrets":"Connection needs secrets: the VPN password was not provided. Re-apply “password-flags=2” so NetworkManager asks every time, then Connect again in the terminal.",
 "already-exists":"A connection with this name already exists. Rename or delete the existing one, or pick a different profile name.",
 "not-found":"Connection not found in NetworkManager. Import the .ovpn profile again.",
 "nm-unavailable":"NetworkManager is unavailable. Check that NetworkManager.service is running.",
 "plugin-missing":"NetworkManager OpenVPN support is missing. Install “openvpn” and “networkmanager-openvpn”.",
 "auth-failed":"Authentication failed. Check username/password, then approve the AuthPoint push. No passwords were stored or logged.",
 "import-failed":"Import failed. Check the .ovpn file is readable, valid, and its referenced certificates/keys exist.",
 "failed":"Operation failed. See details, without any passwords, in the panel log line."
};
function errorMessage(key){return ERROR_MESSAGES[String(key||"")]||"";}
function elideStatus(text){var value=String(text||"").replace(/\s+/g," ").trim();return value.length>140?value.substring(0,137)+"…":value;}
if(typeof module!=="undefined"&&module.exports){module.exports={DEPS,PASSWORD_FLAGS_VALUE,shellQuote,isValidConnectionName,isValidUsername,isOvpnPath,depsCheckArgv,importArgv,setUsernameArgv,setPasswordFlagsArgv,showVpnArgv,listArgv,activeArgv,downArgv,deleteArgv,connectTerminalCommand,connectTerminalArgv,parseConnectionList,detectImported,parseImportStdout,parseVpnShow,hasPasswordFlags2,settingsPick,stateFor,stateForUuid,findByName,resolveTarget,classifyError,errorMessage,elideStatus};}
