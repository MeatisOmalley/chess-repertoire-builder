# Chess Repertoire Builder

A Chromium extension for building, organizing, exporting, and practicing chess repertoires directly on Chess.com and Lichess. Your repertoire library is stored locally in the browser, so the same saved lines are available on both supported sites.

## Install (Developer Mode)

1. Download this repository as a ZIP file and extract it.
2. In Chrome, open `chrome://extensions`; in Edge, open `edge://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the extracted `chess-repertoire-builder` folder—the folder containing `manifest.json`.

To update the extension, replace the files in that extracted folder, then click **Reload** on the extension card. Your locally stored repertoires and study progress remain intact.

## What it does

- Build any number of named White and Black repertoires.
- Include complete lines from the current board, designate preferred repertoire moves, and mark opponent mainlines.
- Add comments and standard `!`, `?`, `!!`, `??`, `!?`, and `?!` annotations.
- Import and export branching PGN files, including repetitions and custom starting positions (`SetUp`/`FEN`).
- Create and organize manual or automatic opening chapters using the bundled opening catalog.
- Study saved lines with spaced-review progress, contextual retries, comments, chapter scope, and accepted alternatives.
- Use Live Practice against weighted Lichess opening-explorer replies, saved repertoire replies, or the bundled local Maia model.
- Keep work on real-time games blocked; full board control is limited to supported analysis, study, explorer, and computer-board contexts.

## Site support

Chess.com supports the builder and practice features on supported analysis, explorer, practice, and computer boards. Lichess supports analysis boards and studies. Actual correspondence-game pages are observation-only, and ordinary real-time human games are blocked.

## Storage and privacy

Repertoires, UI settings, and study progress stay in `chrome.storage.local`. PGN files are generated only when you export them. Optional Live Practice explorer access uses Lichess OAuth; the stored token is used only for those explorer requests and can be disconnected from the extension.

## License notices

This repository includes third-party opening data, Maia assets, and ONNX Runtime files. See the included license files for their terms.
