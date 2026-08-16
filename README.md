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
   formats).
4. Adding `?mml=<URL>` opens the page with the MML/song file at that URL
   already loaded. Pointing it at a ZIP/LZH archive extracts the contents so
   you can pick a song from inside (loading only — it won't autoplay, since
   browsers require a user gesture before audio can play, so press play
   yourself).
5. Keyboard shortcuts: `⌘/Ctrl+Enter` to compile & play, `Esc` to stop.

## What it can't do (important)

The player currently has a few honest limitations worth stating up front.

- **It can't load external files referenced by `#voice`, or by `#pcm` other
  than the bundled default bank.** `#pcm mucompcm.bin` (the standard ADPCM
  bank) is bundled and plays normally; any other `#voice`/`#pcm` filename
  falls back to default voices and silent ADPCM. If a loaded MML references
  a file that can't be resolved this way, the UI shows a notice (that the
  voices and drums differ from the original).
- **The rhythm part plays through substitute samples that differ from a real
  YM2608.** The bundled sound core doesn't carry the real chip's ROM-derived
  PCM, so it plays free substitute drum samples instead
  (`html/rhythm/2608_*.WAV`; see `NOTICE.md` for the source). The author of
  the original driver has stated plainly that these substitutes are
  "fundamentally different in waveform from the real YM2608's rhythm sound,"
  and this project inherits that same caveat. (The UI used to show a notice
  about this, same as it does for `#voice`/`#pcm`, but as of 2026-08-16 it no
  longer does: rhythm went from "silent" to "audible but different," which
  is a smaller gap than a completely missing part, so it's no longer called
  out on every screen. The limitation itself is unchanged.)
- **The PMD compiler (this project's own MML→binary converter) only
  supports the v1 basic command set** — PPZ8, LFO, portamento, and similar
  are out of scope. See `docs/pmd-compiler-spec.md` for details.
- **Phones and tablets are not supported.**

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
