Title: Add Speedtest CLI to TV utilities

## Summary

Adds **Speedtest CLI** to **TV utilities**. It's a Homebrew app that runs the official Ookla Speedtest CLI on the TV and shows its real terminal output live, then a results screen with download, upload, latency and throughput charts.

## Resource details (for additions)

- **Project:** Speedtest CLI
- **Canonical URL:** https://github.com/danzig666/webos-speedtest (release with the .ipk: https://github.com/danzig666/webos-speedtest/releases/tag/v1.2.0)
- **Category:** TV utilities. It's an on-TV tool like the VPN clients and the system monitor in that section, not a remote-control or remapping tool.
- **Why is it useful?** It measures the TV's own connection, not a phone's or PC's, using Ookla's official CLI. The app downloads the official build itself from install.speedtest.net, installs it only if the pinned SHA-256 matches, and shows Ookla's licence and privacy terms for the user to accept. Navigation works with the D-pad, OK and Back as well as the Magic Remote pointer.
- **Compatibility / root requirements:** Requires root and the Homebrew Channel. The app elevates its service through Homebrew Channel before downloading the CLI. Tested on an LG C3 (O22N) running webOS 10.2.2. Other models aren't claimed.
- **Original source or attribution:** I'm the author. It was developed with AI assistance, as the entry says.

## Checklist

- [x] The resource is relevant to LG webOS TVs.
- [x] I checked the link and project documentation.
- [x] The entry is not a duplicate and belongs in the selected category.
- [x] The description is factual, concise, and follows the README format.
- [x] Compatibility and root claims are supported by evidence or marked unknown.
- [x] Source attribution is accurate and does not imply authorship.
- [x] I checked the rendered Markdown and spelling.
