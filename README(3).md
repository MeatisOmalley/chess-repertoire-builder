# Chess Repertoire Builder v2.7.0

A Chromium extension for creating, editing, exporting, and studying named White and Black repertoires on **Chess.com and Lichess**.

The same locally cached repertoire library is available on both sites. Build a line on one site, then continue editing or studying it on the other.

## Site support

### Chess.com

The builder, Study mode, and Live Practice work on supported analysis, explorer, computer/bot, and correspondence-style boards.

On real Daily/correspondence game pages, the builder may observe and record moves, but all extension-driven board control is disabled. Candidate Play buttons, Study mode, autoplay, and chapter navigation cannot move a piece. Open the position in Analysis to use those controls safely.

The extension is blocked on real-time play routes, including `/play/online` and live-game routes. It is not rendered there.

### Lichess

Full builder and Study functionality is available on:

- Analysis Board
- Lichess Studies
- analysis boards opened from correspondence games

The builder can also observe and record moves on BOT and correspondence round pages. Study autoplay is deliberately disabled on the actual round page so the extension can never submit an automatic move in a real game. Open that position in Lichess Analysis to study it.

The same correspondence safety boundary applies on both sites: actual correspondence game pages are observation-only, while analysis boards opened from those games retain normal controls.

Ordinary live human round pages are blocked. The extension is initialized only after the page is positively identified as Analysis/Study, BOT, or correspondence.

## Repertoire building

- Create any number of named White or Black repertoires.
- **Include line** adds every missing move from the starting position through the current move.
- Mark your own move as **Preferred**.
- Mark an opponent move as **Mainline**. This is the same internal flag with context-appropriate UI wording.
- Add comments and `$1`–`$6` annotations: `!`, `?`, `!!`, `??`, `!?`, and `?!`.
- Delete an included branch or an entire repertoire.
- Import branching PGN files as new repertoires and export the selected repertoire. Imported names are made unique with `(2)`, `(3)`, and so on. Chapters round-trip as visible `Chapter: Name` lines inside ordinary PGN comments.
- Shared positions and transpositions are stored position-centrically.
- Continuations are ordered by longest stored line, with expandable nested alternatives.

## Practice: Study and Live Practice

- The top-level **Practice** tab has separate **Study** and **Live Practice** setup views. Switching views never starts a session.
- Study prompts for your repertoire moves.
- Automatically plays included opponent responses.
- **Live Practice** is separate from ordinary lesson Study. Click **Connect Lichess** once to authorize its opening-explorer access with OAuth PKCE; the locally stored token is used only for explorer requests and can be revoked with **Disconnect**. Its single **Rating** setting applies to both the Lichess opening explorer and Maia. Explorer requests pool the three nearest Lichess rating brackets (for example, 600 uses 400, 1000, and 1200), then sample replies by their combined game frequencies.
- By default the live opponent may choose any legal explorer move. **Restrict bot to repertoire moves** limits it to saved replies when such replies exist; if none exist it reverts to explorer moves.
- Explorer data is considered viable at 200 games. Below that threshold (or if the explorer cannot be reached), restricted play uses a weighted/random saved reply when one exists; otherwise bundled Maia selects a legal move locally at the chosen fallback rating.
- Maia inference runs locally in a background worker. It is not loaded or queried while viable explorer data is available.
- Uses balanced autoplay pacing: opponent moves appear after about 275 ms, and ordinary correct moves advance after about 350 ms.
- Accepts every included move as correct.
- When you choose a non-preferred accepted move, offers:
  - **Study preferred line**
  - **Continue current line**
- Shows comments without revealing candidate-move comments before the answer.
- Study mode includes a remembered **Auto-continue comments** option. When enabled, comments remain visible for a brief length-adjusted pause and then the line advances automatically; the Continue button remains available.
- After a wrong move, offers **Retry with context** and **Show answer**. Contextual retry rewinds up to four plies, then replays the opponent move that recreated the missed decision before asking for the correction.
- Reintroduces missed positions and stores progress separately from the PGN.
- New study material advances root-first from the selected scope: shallower unintroduced decision branches are selected before deeper targets.
- The scheduler selects an individual decision for priority, but presents a complete saved route from the lesson start through a repertoire leaf.
- Lessons begin at the deepest named or manual chapter on that route whose incoming user decisions have been mastered and are not due. If earlier material becomes due, the scheduler automatically backs up to an earlier chapter or the study root.
- Study decisions use persistent review due dates. Two consecutive correct presentations establish initial mastery; subsequent correct reviews expand the interval.
- Manual backward/forward navigation pauses and resynchronizes Study mode instead of grading navigation as a move.
- **Skip to next line** is available throughout a study line, including while awaiting a move, showing feedback, or navigating.
- **Next line** excludes the entire route just presented before selecting another target, preventing different positions on the same line from causing immediate repetition.
- Choose **All chapters** or a specific automatic/manual chapter from the Chapters dropdown. Selecting a chapter also moves the analysis board to its root position; chapter study trains only its descendants.
- **Study from current position** remains available independently of the chapter dropdown.

## Chapters

The Chapters box contains a dropdown with **All chapters** at the top. The dropdown follows the board whenever a chapter root is reached, and selecting a chapter moves the board to that root. Selecting a chapter limits ordinary chapter study to decision positions descending from its root; **Study from current position** remains independent.

- Automatic chapters are created and stored only when a position is first added and exactly matches a named opening position in the bundled `lichess-org/chess-openings` catalog. Deleting one is permanent; revisiting the position does not regenerate it.
- Opening names are nested by actual repertoire-position ancestry, with their shared name prefixes used to produce compact relative labels such as `Sicilian Defense → Najdorf Variation → Poisoned Pawn Variation`.
- **Create chapter** adds a manual chapter rooted at the current saved board position.
- Automatic and manual chapters can be renamed.
- Deleting a manual chapter removes only its label. Deleting an automatic chapter hides only that generated label. Neither action deletes repertoire moves or study statistics.
- Repertoire actions sit directly beneath the repertoire dropdown. Chapters and Study each have their own compact box.

The compact opening-position catalog is generated from `lichess-org/chess-openings`, released under CC0. See `OPENING-DATA-LICENSE.txt`.

## Panel behavior

- Places persistent **Build** and **Study** tabs at the top of the panel. Opening the Study tab shows setup controls but never starts a lesson automatically.
- Repertoire/chapter context and included continuations remain available from either tab outside an active lesson. Build-only editing controls stay in Build.
- Defaults to the **right side** of the screen.
- Drag the header to move it anywhere in the viewport.
- The dragged position and collapsed state persist afterward.
- The panel position remains draggable and persistent.

## Installation/update

1. Extract the ZIP to a permanent folder.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the extracted `chess-repertoire-builder` folder.

To update while preserving cached repertoires, replace the files inside the folder already loaded by the browser, then click **Reload** on the extension card.

## Storage

Repertoires, UI state, and Study progress are stored in `chrome.storage.local`. PGN is generated on export; Study statistics are not embedded into the exported PGN.

The bundled Maia model is approximately 46 MB and ONNX Runtime Web adds approximately 12 MB. These are loaded only when Maia-selected replies are enabled.

## Version 2.7.0

Added the first offline Maia-3 study integration. Study setup now offers rating-conditioned Maia opponent selection, constrained to stored repertoire responses so existing lesson validation and chapter scope remain intact. Model inference runs off the page thread with a bundled ONNX model and automatically falls back to normal repertoire ordering if Maia cannot initialize.


## Version 2.6.3

Replaced the sharp boxed Build/Study buttons with a flat navigation strip, restored the panel's original inherited font, and marked the active tab with a restrained green wash and underline.

## Version 2.6.2

Removed the automatic/manual chapter-count text beneath the chapter selector. Automatic-chapter loading failures remain visible when they occur.

## Version 2.6.1

Moved the Build/Study selector to the top of the panel and simplified it into two large, sharp-edged buttons with larger Helvetica-style text. Repertoire management controls are now Build-only, and `Delete label` is now `Delete chapter label`.

## Version 2.6.0

Added persistent Build and Study tabs beneath the shared repertoire selector and repertoire-level controls. Study now has an explicit setup screen and never starts merely because its tab was selected. Chapter context and candidate continuations remain visible across both tabs, while move and chapter editing controls remain confined to Build.

## Version 2.5.6

Clarified the Chapters controls as `Create chapter`, `Rename`, and `Delete label`.

## Version 2.5.5

Restored the dark bold outline around punctuation glyphs at a slightly refined thickness while retaining full opacity, color coding, and the closer corner placement.

## Version 2.5.4

Restored the bold punctuation glyph to full opacity while retaining the upper-right placement, muted color categories, and shape-free presentation.

## Version 2.5.3

Unified correspondence safety across Chess.com and Lichess. Actual correspondence game pages remain observable, but candidate Play controls, Study mode, autoplay, chapter setup, and every programmatic move path are disabled. Analysis boards opened from correspondence games remain fully usable. Removed the rounded punctuation backing, retaining the bold upper-right color-coded glyph.

## Version 2.5.2

Refined last-move punctuation into a quieter upper-right badge with a translucent backing and muted green, red, or amber coloring while retaining the existing glyph size.

## Version 2.5.1

Removed the candidate-move arrow overlay and its toggle. The last-move punctuation overlay remains.

## Version 2.5.0

Added a non-interactive SVG board overlay. Stored punctuation for the last included move is shown on both supported sites.

## Version 2.4.4

PGN import now asks whether to create automatic opening chapters for catalog-matched positions. Explicit `Chapter: Name` comments are imported regardless of that choice.

## Version 2.4.3

Corrected final chapter edge cases: catalog positions with the same opening name can each receive a chapter; an explicit imported `Chapter: Name` overrides an automatically detected chapter at that position; and schema migrations now save immediately.

## Version 2.4.2

Cleaned up the persisted chapter model into schema version 4: removed obsolete dynamic-chapter state, deduplicated legacy chapter roots during migration, and preserved root-position comments on export. PGN import now removes only real header lines, preserving square-bracketed annotation text inside ordinary comments.

## Version 2.4.1

Enforced one chapter per repertoire position. PGN import recognizes only the first leading `Chapter: Name` line at a position; subsequent chapter-like lines remain ordinary comment text. Removed support for the parenthesized `Chapter: (Name)` variant.

## Version 2.4.0

Chapters now round-trip through standards-compatible, human-readable `Chapter: Name` lines in PGN comments. Preferred repertoire moves and opponent mainlines are exported as the native PGN main continuation before alternatives. Automatic chapters are persisted only when a position is first created, so deleting one remains permanent. Fixed loading of the bundled opening catalog by correcting its packaged path and extension resource declaration.

## Version 2.3.1

PGN import now always creates and selects a new repertoire instead of merging into the currently selected repertoire. The PGN `Event` name is retained when available; filename and color-aware defaults are used as fallbacks. Name collisions receive incrementing suffixes such as `(2)` and `(3)`.

## Version 2.3.0

Rebuilt Study scheduling around coherent full lines. The scheduler still introduces branches root-first, but now extends the selected target to a saved leaf instead of ending at the scheduled decision. Arbitrary ply-based focused starts were removed: lessons may start only at named/manual chapter checkpoints whose incoming route has been mastered and is not due for review. Persistent due dates determine when an earlier chapter must be replayed. Wrong answers now offer a contextual retry that rewinds up to four plies, replays the opponent move that created the critical position, and asks for the missed move again before continuing the line.


## Version 2.2.2

Reorganized the panel: repertoire actions are bundled directly with the repertoire dropdown, followed by a Chapters box and then a Study box. The chapter dropdown now follows exact chapter positions on the board, and selecting a chapter navigates the board to its root. New study targets are scheduled breadth-first from the selected root before deeper sidelines.

## Version 2.2.1

- Repertoire management now appears above the study and chapter-management controls.
- Automatic chapters are nested using actual repertoire-position ancestry, with opening-name prefixes used only to choose the most meaningful ancestor.
- Prefixes without punctuation now nest correctly (for example, `Danish Gambit Accepted` beneath `Danish Gambit`).
- A partially named branch retains the missing branch text in its label (for example, `Declined: Sörensen Defense`) rather than appearing beneath the preceding sibling.

## Version 2.2.0

Added automatic and manual chapters, a nested chapter dropdown with **All chapters** at the top, chapter-scoped study with automatic board setup, **Create chapter here**, rename/delete chapter controls, and separate Study, Chapters, and Repertoire management sections. Automatic labels come from the bundled CC0 opening-position catalog.

## Version 2.1.6

Based on v2.1.5. Added **Study from here**, which uses the current stored board position as the study root. Only decision positions reachable after that point are scheduled, and every new/repeated line resets to that selected position rather than move one. Full-repertoire study remains available as **Study all**.

## Version 2.1.5

Based on v2.1.4. Study mode now excludes the complete just-presented route when choosing the next target, so multiple decision positions on one branch no longer replay the same line consecutively. A **Skip to next line** control is now available throughout active study.

## Version 2.1.4

Based directly on v2.1.2. Study mode now treats a move beyond a terminal repertoire position as ungraded and remains in Line complete state, so additional moves are also ignored until another line is started.
