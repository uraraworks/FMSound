# FMSound

[日本語](README.ja.md)

A browser-only player and editor for MML played through two FM sound driver
engines — **PMD** (PC-9801) and **MUCOM88** (PC-8801). It runs on prebuilt
wasm and a shared web UI; no server is required.

### ▶ <https://uraraworks.github.io/FMSound/>

No install needed — try it straight in your browser.
([Open with PMD](https://uraraworks.github.io/FMSound/?driver=pmd) /
[Open with MUCOM88](https://uraraworks.github.io/FMSound/?driver=mucom))

**What sets this repository apart** is that it doesn't just play sound — it
draws a [FMDSP](https://github.com/myon98/98fmplayer)-style screen that
**renders each part's playback state (voice, pitch, gate, volume) in real
time.** The spectrum analyzer and level meters are also driven live from the
real driver's output.

## Usage

1. Opening the page loads a bundled sample by default (the opening of
   "Für Elise"). Just press play to hear it.
2. The "Sound driver" dropdown in the header switches between PMD (PC-9801)
   and MUCOM88 (PC-8801) (also selectable via the `?driver=pmd` /
   `?driver=mucom` URL query).
3. The toolbar icons let you "Open a song" (a local `.M`/`.m`/`.muc` file, or
   drag & drop), "Switch to editor mode" (write and play MML directly), and
   "Download" (MML source / compiled binary / asm `db` array — three
   formats). Opening a file or dropping one also accepts a ZIP/LZH archive
   (including one holding a `.d88` disk image) — the contents are extracted
   so you can pick a song from inside, same as loading an archive by URL
   below.
4. Adding `?mml=<URL>` opens the page with the MML/song file at that URL
   already loaded. Pointing it at a ZIP/LZH archive extracts the contents so
   you can pick a song from inside (loading only — it won't autoplay, since
   browsers require a user gesture before audio can play, so press play
   yourself). For a PMD song that needs PCM (one using `.PPC`/`.PZI`/`.PVI`),
   there's no way to supply a PCM file alongside a standalone song file, so
   pack the song and its PCM files together into one archive (ZIP/LZH) and
   point the URL at that (PCM loading follows the same conditions described
   under "Usage" below). Dropbox share links can be pasted as-is — no need to
   rewrite them with `dl=1`; the app rewrites the host automatically (only
   per-file share links have been verified this way; folder shares and
   password-protected links haven't been tested). Google Drive links only
   work through the relay server, so they won't load on a build where no
   relay server URL is configured (see "Publishing to GitHub Pages" below for
   how the relay is configured).
5. Keyboard shortcuts: `⌘/Ctrl+Enter` to compile & play, `Esc` to stop.
6. Click a part's row on the FMDSP screen to mute just that part (click again
   to unmute — there's no solo function). A muted row keeps its original
   color but dims it, and its keyboard highlight dims the same way. The
   rhythm part has no row of its own, so mute it by clicking the RHY column
   in the level meters on the right; the FM1–SSG3/ADPCM columns there mirror
   the same mute state as their part rows (the PPZ columns don't support
   muting). Hovering anything mutable (a part row or a level-meter column)
   draws an outline around it before you click. Parts are shown in three
   brightness levels — normal, muted (half brightness), and "unused by this
   song" (quarter brightness, only available when the MML was compiled in
   this app rather than loaded as an already-compiled `.M`/`.m` file).
   Reloading a song clears all mutes. This only works with mouse/touch
   clicks; keyboard control isn't supported yet.
7. The "language" button in the header switches the UI between Japanese and
   English (its label shows the language it will switch *to*). The choice is
   remembered in the browser and takes priority over `?lang=ja`/`?lang=en`;
   without either, it falls back to the browser's language.
8. The header's help icon opens `html/help.html`, a step-by-step usage guide
   with screenshots (also available in Japanese/English).
9. The toolbar's "Copy link" button copies a shareable URL for the MML you're
   currently editing (nothing is uploaded — the song data is packed into the
   URL's fragment (`#s1=...`), which browsers never send to a server, so it
   works on static hosting like GitHub Pages with no server-side storage).
   Next to the button, a counter (e.g. `2344 / 4000`) with a gauge always
   shows the current link's length; it's tallied when you compile & play (not
   on every keystroke), reads "not counted yet" while you have unsaved edits,
   and is recalculated the moment you press the button. If the link would
   exceed **4,000 characters**, the button is disabled and shows exactly how
   many characters you're over — the limit exists because sites like X don't
   treat a longer URL as a real link (see `net/share-link.js` for how this
   number was measured). If the clipboard copy fails, a read-only text field
   with the link appears so you can copy it manually. For MUCOM88, if the
   song uses a disk-specific external voice bank (`#voice` resolved from a
   paired system disk rather than written in the MML itself), sharing shows
   a one-time warning: whoever opens the link won't have that disk, so the
   instrument sounds will change to the defaults.

## What it can't do (important)

The player currently has a few honest limitations worth stating up front.

- **It can't load external files referenced by `#voice`, or by `#pcm` other
  than the bundled default bank.** `#pcm mucompcm.bin` (the standard ADPCM
  bank) is bundled and plays normally; any other `#voice` filename falls
  back to default voices. An unresolved `#pcm` doesn't go silent, though —
  the standard ADPCM bank stays loaded and plays instead, so the drums
  (ADPCM) sound different from the original. If a loaded MML references
  a file that can't be resolved this way, the UI shows a notice (that the
  voices and drums differ from the original).
- **The rhythm part plays through substitute samples that differ from a real
  YM2608.** The bundled sound core doesn't carry the real chip's ROM-derived
  PCM, so it plays free substitute drum samples instead
  (`html/rhythm/2608_*.WAV`; see `NOTICE.md` for the source; **no real chip
  ROM is used anywhere**). The author of the original driver has stated
  plainly that these substitutes are "fundamentally different in waveform
  from the real YM2608's rhythm sound," and this project inherits that same
  caveat. (The UI used to show a notice about this, same as it does for
  `#voice`/`#pcm`, but as of 2026-08-16 it no longer does: rhythm went from
  "silent" to "audible but different," which is a smaller gap than a
  completely missing part, so it's no longer called out on every screen. The
  limitation itself is unchanged.) PMD now plays the same substitute samples
  too (it used to be silent). PMD's sound core, however, requires rhythm
  samples in the real chip's fixed-capacity ROM format, so unlike MUCOM88 —
  which plays the WAV files as-is — the samples had to be trimmed to fit
  during conversion. **So even though both engines share the same source
  material, the rhythm doesn't sound identical between MUCOM88 and PMD.**
- **MUCOM88 compile error messages are always in Japanese, regardless of the
  page's language setting.** They come from a Japanese error table built
  into the wasm module, so even with the UI set to English, the error text
  itself stays in Japanese.
- **The PMD compiler (this project's own MML→binary converter) only
  supports the v1 basic command set** — PPZ8, LFO, portamento, and similar
  are out of scope. See `docs/pmd-compiler-spec.md` for details.
- **On MUCOM88's K (ADPCM) part, setting the volume command to `v255` (the
  maximum) makes it go nearly silent instead.** Volume rises normally up to
  around `v200`, but the maximum value `v255` drops it sharply — avoid using
  the maximum.
- **The right-pane FMDSP counters CPU POWER COUNT, VOLUME DOWN, and PGM
  NUMBER can't show a value** (shown dimmed instead of a live number).
  CPU POWER COUNT is permanently unobtainable — browsers have no API for a
  process/tab's CPU usage. VOLUME DOWN and PGM NUMBER aren't a wasm-export
  gap: the upstream FMDSP drawing code never had logic to render a value for
  them, and no data field for either exists in the shared driver interface
  it reads from. FRAMES PER SECOND, by contrast, *is* implemented — it just
  counts the host draw loop's own frequency, no driver data needed. See
  `docs/right-pane-data.md` §8 for the source-level detail.
- **The rightmost 8 columns of the level meter (PPZ8 1-8) only light up when
  a PMD song actually uses a PPZ8 bank (`.PZI`/`.PVI`, up to two banks).**
  PPZ8 is PMD's 8-channel PCM engine. Loading a song together with its bank
  file from the same archive (zip, etc.) makes the used channels light up;
  they stay dark if no bank was supplied, or if the song doesn't use PPZ8 at
  all. **MUCOM88 has no concept of PPZ8 at all, so these columns always stay
  dark there** (unlike PMD, this never changes for MUCOM88). **The PPZ
  columns still don't support muting**, on either engine. See
  `fmdsp/channel-mask.js` `unusedColumnsFromChannels()` and
  `docs/pmd-pcm-support.md` for the source-level detail.
- **PMD's PCM (`.PPC` = ADPCM, `.PZI`/`.PVI` = PPZ8 banks) only loads when
  you open the song from the same archive (zip/lzh/etc.) as its PCM
  files.** Dropping a standalone `.M`/`.m` file gives no way to supply a PCM
  file alongside it, so PCM never loads in that case. If a song references
  PCM that can't be found, the UI shows a notice naming the missing file.
  **`.P86` (PMD86) and `.PPS` (PPSDRV) aren't supported** — the upstream
  sound core doesn't implement them, so neither does this web build (if the
  archive happens to bundle the matching file anyway, the missing-PCM notice
  is suppressed to avoid a misleading warning).
- **The screen isn't optimized for phones yet, and phone support is planned.** Tablets haven't been checked or optimized for at this time.
- **Sharing a MUCOM88 song that depends on a disk-specific external voice bank
  changes its sound for the recipient.** The share link (`?driver=` +
  `#s1=...`) only carries the MML text, not the paired system disk's
  `voice.dat`; whoever opens it will hear the song with default voices
  instead. The UI warns about this at share time when it applies (see
  Usage above).

## ⚠ MML differences between drivers (`t`/`T`/`C` are swapped)

Between PMD and MUCOM88, **the meaning of `t` and `T` is reversed.** This is
a trap that was hit twice during development, so please double-check it.

| | `t` (lowercase) | `T` (uppercase) |
|---|---|---|
| **PMD** | Tempo (absolute value based on a **half note**; **half** the value of a typical BPM) | Raw TimerB value |
| **MUCOM88** | Raw TimerB value | Tempo (equivalent to BPM) |

In addition, **MUCOM88's `C` is not tempo.** It specifies the clock count per
whole note (resolution), defaulting to 128. Use `T` to change the tempo.

## Roadmap

- Support for loading `#voice`/`#pcm`
- Phone support (both playback and editing)
- Data exchange between apps (e.g. sharing song data)

## License and credits

**FMSound is provided under
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)
(Attribution-NonCommercial-ShareAlike 4.0 International).** See
[`LICENSE`](./LICENSE) for the full text.

This isn't a condition chosen by this project — it's inherited because the
bundled **MUCOM88 carries CC BY-NC-SA 4.0 with a ShareAlike clause**, and
incorporating it brings FMSound as a whole under the same terms. The PMD
side's implementation (98fmplayer) is licensed BSD 2-Clause, so **if you
want to use just the PMD part under permissive terms, refer to 98fmplayer or
the original PMD directly instead of FMSound.**

The sound driver implementations are ports of the following upstream
projects to wasm. The provenance and full license text for generated
artifacts derived from third-party works are collected in
**[`NOTICE.md`](./NOTICE.md)**.

- **PMD**: [98fmplayer](https://github.com/myon98/98fmplayer) (BSD 2-Clause)
- **MUCOM88**: [OPEN MUCOM88](https://github.com/onitama/mucom88) /
  [MUCOM88 on Web](https://github.com/aosoft/MucomWeb)
  ([CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) —
  carries **NonCommercial and ShareAlike** terms)

The bundled sample song (the opening of "Für Elise," composed by Beethoven,
public domain) MML arrangement is this project's own work. See `NOTICE.md`
for details.

No ROM images (PC-98 firmware, etc.) or commercial software data are
included in this repository.

## Build instructions

This repository does **not** track `upstream/` (the external repositories it
references, 79MB) — see `.gitignore`. As a result, cloning alone won't let
you build; fetch them with the steps below.

The fetch locations and pinned revisions are centralized in
[`upstream-revisions.env`](./upstream-revisions.env) (the GitHub Actions
build also reads this file; see the comments in the file for why revisions
are pinned).

```bash
set -a; source upstream-revisions.env; set +a

mkdir -p upstream
git clone "$UPSTREAM_98FMPLAYER_REPO" upstream/98fmplayer
git -C upstream/98fmplayer checkout --detach "$UPSTREAM_98FMPLAYER_REV"

git clone "$UPSTREAM_MUCOMWEB_REPO" upstream/MucomWeb
git -C upstream/MucomWeb checkout --detach "$UPSTREAM_MUCOMWEB_REV"
git -C upstream/MucomWeb submodule update --init --recursive
```

The toolchain is shared via `PC98/emsdk` (the emscripten SDK), linked in as
the `emsdk` symlink. If the link target is missing, obtain the emscripten SDK
separately and repoint `emsdk` at a valid path.

```bash
# Run from the repository root (the directory containing this README.md)

# MUCOM88
cd mucomweb
source ../emsdk/emsdk_env.sh
emcmake cmake -S . -B build-web -DWEB_BROWSER=1 -DCMAKE_BUILD_TYPE=Release && cmake --build build-web -j4

# PMD
cd ../pmdweb
emcmake cmake -S . -B build-web -DCMAKE_BUILD_TYPE=Release && cmake --build build-web -j4

# Assemble both drivers into one directory (for local ?driver= switching checks and to inspect what gets shipped)
cd ..
tools/build_dist.sh
```

`dist/` is the assembled distribution directory (GitHub Pages is expected to
serve this). To check it locally, serve `dist/` with a static server and
open it in a browser (e.g. `python3 -m http.server 8000 --directory dist`).

The screenshots on the usage page (`html/help.html`) are generated
reproducibly by `tools/gen_help_shots.mjs` (macOS only — it drives a local
Google Chrome headlessly over the DevTools Protocol, no npm dependency
added). Run it after `tools/build_dist.sh` so `dist/` is current:

```bash
node tools/gen_help_shots.mjs
```

It serves `dist/` on port 8790 and writes `html/help/<name>.<lang>.png`.
There's no need to re-run this unless the screens it captures actually
changed.

When `mucomweb` is configured, patches under `mucomweb/patches/` (three of
them: exposing accessors, level meters, and the rhythm part's `rhythmpath`)
are automatically applied to `upstream/MucomWeb/mucom88`. The upstream
working tree itself is left unmodified, so no tracking or committing is
needed.

### Publishing to GitHub Pages (CI)

A push to `master` runs
[`.github/workflows/pages.yml`](./.github/workflows/pages.yml), which
performs the same steps as above (fetch upstream → set up emsdk → build both
drivers → generate `net/config.js` → `tools/build_dist.sh`) and deploys
`dist/` to GitHub Pages. The relay server URL is injected from the
repository variable `DISK_PROXY_URL` (Settings → Secrets and variables →
Actions → Variables). Build and publishing succeed even if it's unset (the
app simply runs without relaying — this default lets forks publish without
having to set the variable).

### Development notes

The results of analyzing upstream, the reasoning behind design decisions,
and driver characteristics discovered through measurement are collected in
[`docs/development-notes.md`](./docs/development-notes.md) (Japanese only —
useful reference if you're modifying or porting this project).
