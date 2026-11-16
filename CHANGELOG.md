# Changelog

Each release's notes on GitHub are the bullet list for its version below.

## 1.3.1

- Fixed: the Speedtest CLI download failed on webOS 5 and left the app stuck at "Busy".
- Fixed: on webOS 5 the screen was squeezed into the top-left corner with no spacing between buttons.
- A download that fails to start no longer blocks later tests.
- The service is now tested on Node.js 8.12 (webOS 4/5) before every release.

## 1.3.0

- Start downloads the Speedtest CLI automatically when it isn't installed.
- When Ookla's terms are already accepted, the test starts straight after the download.
- Added a Homebrew Channel repository, updated with every release.

## 1.2.0

- The app elevates its service through Homebrew Channel before downloading the CLI.
- Ookla's terms open automatically after the CLI is installed.

## 1.1.0

- Added in-app download of the official Speedtest CLI, checked against a pinned SHA-256.
- Added in-app acceptance of Ookla's licence and privacy terms.
- Unreachable Ookla servers are reported as a network error.
- New app icon.

## 1.0.0

- First version: runs the Ookla Speedtest CLI with live terminal output, Start and Cancel, and a results screen with charts.
