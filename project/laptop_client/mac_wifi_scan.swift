// One Wi-Fi scan with CoreWLAN. Prints one line per network: ssid<TAB>bssid<TAB>rssi_dbm<TAB>channel
// Usage: mac_wifi_scan [ssid ...]   (no args = scan everything; with args = targeted scan per exact SSID)
// macOS hides ssid/bssid (prints empty fields) unless this app has Location Services permission.
import CoreWLAN
import Foundation

guard let iface = CWWiFiClient.shared().interface() else {
    FileHandle.standardError.write("no wifi interface\n".data(using: .utf8)!)
    exit(1)
}
var seen = Set<String>()
func emit(_ nets: Set<CWNetwork>) {
    for n in nets {
        let line = "\(n.ssid ?? "")\t\(n.bssid ?? "")\t\(n.rssiValue)\t\(n.wlanChannel?.channelNumber ?? 0)"
        if seen.insert(line).inserted { print(line) }
    }
}
do {
    let targets = Array(CommandLine.arguments.dropFirst())
    if targets.isEmpty {
        emit(try iface.scanForNetworks(withSSID: nil))
    } else {
        for t in targets { emit(try iface.scanForNetworks(withSSID: t.data(using: .utf8))) }
    }
} catch {
    FileHandle.standardError.write("scan error: \(error)\n".data(using: .utf8)!)
    exit(2)
}
