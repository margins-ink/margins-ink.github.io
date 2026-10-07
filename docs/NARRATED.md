# NARRATED: every article as a film you can also read, grab and listen to

Status: design, 2026-10-07. No code written or run for this document. Builds on `docs/MUSEUM.md` (exhibits, Flecs vocabulary, fixed clock), `docs/BOOK.md` and `world/src/book.rs` (the book-open choreography), `docs/READING_GPU.md` (the reader is our WebGPU renderer, DOM = head tags and a canvas), `docs/TEXTFX.md`, `docs/AUDIO.md` and `.claude/skills/flecs-scene/SKILL.md`. Facts are marked **read** (from a primary text this session), **reported** (secondary source or memory) or **unverified** (a spike settles it). Web facts were fetched 2026-10-07; the TTS lane stores the bytes and a `SOURCE.md` under `docs/upstream/film-tts/` before the first line of pipeline code.

## 0. Interpretation, and what the film is

Andrew: "remake things: the book should actually be an animation, described in Flecs script, with captions, and in the future spoken in the style of a Veritasium video; something you can also listen to in the background without watching." Then: "you can do anything you want, it's just that reading text is not really that fun."

So each article gets a second mode next to the continuous reader: a **film**, a timeline of scenes declared in `thoughts/<slug>/film.flecs` (hot reloadable). A scene is NOT a slide with a caption. It is a small Flecs entity tree of anything the GPU can draw: 3D props, a camera rig, particle and shader effects, kinetic type, running exhibits, a flight through the real room. Narration drives it beat by beat. The viewer can pause at any instant and play with what is on screen (grab the Turing machine, drag a slider, pick which lambda redex to contract), then resume. Plain text on screen is the exception: captions and an occasional key phrase.

The film is one of three views of one article model (reader, film, listen). They share the `Article` entity, the exhibits and the section ids, so switching view keeps your place (section 7).

Everything is built to be composed: one shared library of prefabs and scene templates, one small file per film (section 15).

The film does not replace the reader. The reader stays the place for precise reading, selection, find and links; the film is the place for intuition and for listening.

## 1. The model in two sentences

A film is a Flecs entity tree (`Film > Scene > {props, rig, effects, mounts, say lines, beats}`) in which every beat is an entity that sets a component, fires an event on another entity, or drives an exhibit, at a time anchored to a narrated word. Rust holds only a pure, seekable player (`state = f(script, t)`: fixed clock, analytic tweens, closed-form particles, replayed beats) plus the generic drawers; the script holds all content, so a new scene needs no Rust and a new kind of effect is one Rust file, as with exhibit families.

## 2. The Flecs model

### 2.1 Where things live

```
world/scene/70-film.flecs                     the vocabulary: prefabs and plain relation entities (scene script "film")
world/src/film/{mod,model,clock,beats,tween,snapshot,pack}.rs   FilmModule: components, loader, player, packing
world/src/film/{stage,rig,fx,type_,mount}.rs  one interpreter per scene-content family (section 2.5)
src/routes/(site)/thoughts/<slug>/film.flecs  one file per article, authored next to the article
src/routes/(site)/thoughts/<slug>/film.align.json   word timings (generated, committed, section 4.4)
static/film/<slug>/voice.<hash8>.m4a, listen.<hash8>.m4a   generated audio (section 4.5)
```

Same world and same module pattern as `ExhibitModule` (MUSEUM 2.2): a `film` module imported next to `ReadingModule` in `reading::setup`, scenes loaded as children of the article entity so the cascade delete removes them, hot reload through a dry run in a scratch `World` (`scene::reload`, read in the skill) with the clock position kept. `film_inspect` is the only source of film metadata for the build (the museum rule: the build never regexes a `.flecs`).

Script constraints that shape the vocabulary (all **read** in the flecs-scene skill or in `turing.flecs`): one term per line, every nested entity a block, no forward references (declare targets before the things that point at them), no systems or observers in script, no `{` inside a string, script entity names share the root namespace with Rust components. Names already taken: `Caption`, `Label`, `Title`, `Place`, `Order`, `Layer`, `Extent`, `Clock`, `Backdrop`, `Center`, `Half`, `Euler`, `Albedo`, `Frame`, `Timeline`, `Line`. The film vocabulary uses `Subtitle` (not `Caption`), `FilmClock` (not `Clock`: the exhibit lint forbids `Clock` in exhibit text), and no module-scope trick that is not proven (a spike checks `module film`).

### 2.2 One scene is an arbitrary entity tree

A scene is a prefab instance whose children are whatever it needs. The film module knows a closed set of **content families** (section 2.5) by the prefab a child `IsA`; it does not know block types. Anything declared with the room's own vocabulary (`Center`, `Half`, `Euler`, `Albedo`, `Rests`) also works: a scene can instance `Lamp`, `Armchair` or `Magazine` from `12-decor.flecs` unchanged, so the shelf, the elevator cab and the book are available as film props without a copy.

| Family | Prefab | What a child of it declares |
|---|---|---|
| Prop | `Prop` | a body (`Body {form, w, h, d}`: Box, Sphere, Disc, Capsule, Ribbon) at `Center`, rotated by `Euler`, inked by `Ink` (palette tone) and `Glow`; may `IsA` any room prefab |
| Camera | `Camera` | the camera: `Lens {fov}`, `Center`, `(Looks, prop)`, `Sway {amp, hz}`, `Waypoint` children for flights |
| Fx | `Emitter`, `Post` | `Emitter {rate, life, speed, spread, gravity, seed}` (particles, closed form); `Post {kind, amount}` fullscreen pass (Bloom, Vignette, Grain, Wipe, Ripple, Chroma) |
| Type | `Type` | kinetic type: `Words {text}` plus a `Motion` preset (Rise, Scatter, Gather, Typewriter, Crumble) acting per glyph, drawn by the UI glyph path |
| ExhibitRef | `ExhibitRef` | an exhibit shown in the scene: `Of {"models/turing"}`, `Dock {x, y, w, h}` screen fractions, `Alpha`; the exhibit is the real museum exhibit, grabbable |
| Studio | `Studio` | one per scene: `Void` (flat ground, the film's own stage), or `Room` (the real room, section 8) |
| Audio | `Track` | `Narration`, `Music` or `Sfx` (section 2.4) |
| Subtitle | `Say` | one narrated sentence: `Text`, `Spoken`, `Status`, and word timing (section 3) |

The prefab names here are the base layer of the library in section 15: `Camera`, `Prop`, `Effect` (with variants `Emitter`, `Post`), `ExhibitRef`, `Narrator`, `Theme`, `Transition`, `Cue`, `Beat`, `CaptionLine`; `Say` is a `CaptionLine` that also has a voice. Names that would collide with a Rust component (`Caption`, `Rig`-style names) are avoided.

Draw order and limits: a scene may hold at most 120 props, 4 emitters (65,536 live particles total), 6 `Post` passes, 8192 UI glyphs shared with the transport (MAX_UI_GLYPHS, read in the skill). The build lint counts them from `film_inspect`.

### 2.3 Beats: data that sets components or fires events

A beat is an entity under its scene with a time and exactly one action component. Time is `At {seconds}` from scene start, or a word anchor: `(Anchor, say)` plus `Word {n, lead}` (the beat fires when word `n` of that `Say` starts, shifted by `lead` seconds). With no aligned audio the anchor resolves through the timer estimate (section 3.4), so the film plays identically before and after the real voice exists, only the timings move.

| Action component | Meaning | Target |
|---|---|---|
| `Tween {path, to, dur, ease}` | a component field moves from its value at beat start to `to` | `(Targets, entity)`; `path` a reflection path such as `"Center.y"` or `"Ink.glow"`; validated in a scratch world (fail closed with the entity path) |
| `Show` / `Hide` tags with `Fade {dur}` | an entity becomes visible or not | `(Targets, entity)` |
| `Do {verb, n}` | fires the exhibit verb through the SAME `Activate` event a button press uses (MUSEUM 2.5): `step`, `run`, `load`, `reset` | `(Targets, mount)` |
| `(Triggers, event)` | an `Event` entity from the library (`Burst`, `Crumble`, `Flash`, `Ding`) delivered to the target; Rust families listen | `(Targets, entity)` |
| `Fly {dur, ease}` | the rig travels its `Waypoint` children (Catmull-Rom, aim interpolated) | `(Targets, rig)`, `(Path, waypoint_group)` |
| `Cut` | the active rig changes with no travel | `(Targets, rig)` |
| `Gate {until, n}` | the film clock holds until the viewer acts (section 5.3): `Resume`, `Steps`, `Idle` | none |
| `Sound {name, vel, pan}` | a one-shot of the fundsp synth (`docs/AUDIO.md` kinds, plus new film kinds) | none |

Everything that is not a `Gate` is a pure function of `t`: tweens are evaluated analytically (`value(t) = from + (to - from) * ease((t - t0)/dur)`, `from` captured once by the replay, section 2.6), springs use the exact solution from beat start (the `book.rs` rule), particles are closed form (`position = p0(id, seed) + v0 t + g t^2 / 2`, spawn time from `id / rate`, drawn by a WGSL pass from `FilmClock.t`, no simulation state). Nothing integrates `dt`. That is what makes scrubbing exact.

### 2.4 Tracks, clock and the Rust boundary

`Track` children: `Narration` (the voice file and its `Say` lines), `Music` (a bed with `Duck` under speech, volume tween beats allowed), `Sfx` (named synth events). Narration and music are build artefacts keyed by content hash (section 4.5); sfx are the existing procedural synth, so a film adds sounds only as new fundsp kinds.

`FilmClock` is a singleton `{t, rate, playing, source}`. `source` is `Audio` (t is the `<audio>` element's `currentTime`, pushed in by TypeScript each frame) or `Timer` (no voice yet, t advances by `dt * rate`). Rust never reads a wall clock. The ABI is five calls: `film_load(slug)`, `film_set_time(t, rate, playing, source)`, `film_input(kind, ...)` (pointer and key for mounts and transport), `film_pack()` (the draw list), `film_events()` (the ring: `sceneChanged`, `gateOpened`, `gateClosed`, `sound`, `ended`).

Division of labour, as decided for exhibits: **the script holds data and relations; Rust holds stepping logic.** The player (`clock.rs`, `beats.rs`) is about 400 lines and knows nothing about content; each family file (about 150 to 300 lines) draws or simulates one kind of child.

### 2.5 Components, tags and relations (the vocabulary)

| Kind | Name | Fields or meaning |
|---|---|---|
| Component | `Film` data | `Title`, `Dek` strings (reuse article frontmatter), `Voice {id, rev}` (the pinned TTS voice and model revision), `Look` always the one house palette |
| Component | `Scene` data | `Name`, `Dur {seconds}` (optional; else last beat or narration end plus tail), `Poster {t}` (frame for the shelf and the scrub tick) |
| Component | `Body` | `{form, w, h, d}`; `form` enum Box, Sphere, Disc, Capsule, Ribbon |
| Component | `Center`, `Half`, `Euler`, `Albedo` | the room's existing names and meanings, so room prefabs work |
| Component | `Ink`, `Glow` | `Ink` a palette `Tone` name (never RGB); `Glow {amount}` HDR gain on an extended canvas |
| Component | `Lens`, `Sway`, `Waypoint` | rig fields; `Waypoint {t}` orders a flight, aim target comes from `(Looks, x)` |
| Component | `Emitter`, `Post`, `Words`, `Motion` | effect and type fields (2.2) |
| Component | `Of`, `Dock`, `Alpha` | mount: exhibit id, screen rect fractions, opacity |
| Component | `Say` | `{Text, Spoken, Status}`, see 3.2; `Status` enum draft, approved, voiced |
| Component | `At`, `Word`, `Tween`, `Do`, `Fly`, `Gate`, `Sound`, `Fade` | beat fields (2.3) |
| Component | `FilmClock` | singleton `{t, rate, playing, source}` |
| Component | `Order` | tie-break for beats at the same time (the lint requires it; entity ids are not declaration order after a reload, read in the skill) |
| Tag | `Placeholder` | on every `Say` and `Track` until real audio is built; the build and the UI show it (section 3.5) |
| Tag | `Grabbable`, `Holding`, `Visible`, `Poster` | the viewer may take over this mount or prop; the scene is paused for play; currently drawn; poster frame |
| Prefab | `Film`, `Scene`, `Prop`, `Camera`, `Emitter`, `Post`, `Type`, `ExhibitRef`, `Studio`, `Track`, `Say`, `Beat`, `Waypoint` | the family prefabs |
| Relation | `ChildOf` | scene content under the scene, scenes under the film |
| Relation | `Targets` | a beat's target entity (exclusive) |
| Relation | `Anchor` | a beat to a `Say`: the narrated line it is anchored to (exclusive) |
| Relation | `Looks` | a rig to the prop it aims at (exclusive) |
| Relation | `Path` | a `Fly` beat to the group of waypoints it follows |
| Relation | `Covers` | a scene to the article section id it narrates (mode switch, 7.2) |
| Relation | `Drives` | reused from the museum: a mount to the exhibit it runs |
| Relation | `Refers` | reused from TEXTFX: a spoken word to a figure part, so a word lights its referent |

Traits in the module: `Exclusive` on `Targets`, `Anchor`, `Looks`; `(OnDeleteTarget, Delete)` on `Targets` so a beat dies with its target (a dry run reports it).

### 2.6 Player semantics: seek equals play

State at time `t` is defined as: rebuild the active scene from its pristine tree (destroy and recreate under the same name, about 1 ms, as `exhibit_reload` does), then apply every beat with resolved time at most `t` in `(time, Order)` order, evaluating tweens at `t`. Playing forward applies the same beats as the clock crosses them. Property (tested, section 9): `state(seek(t))` equals `state(play from scene start to t)` for every `t`, at any frame rate. Exhibits keep their own fixed 1/60 s clock (read in the skill); the film never advances an exhibit with its clock. It sends `Do` verbs, and a seek replays them as `load` then N `step`s through a batched `exhibit_advance(n)` (the per-frame cap of 64 steps does not apply to a seek). An exhibit's state depends on step count only, so replay is exact. Scene boundaries are the seek checkpoints: a seek never replays earlier scenes, only the target scene from its start (a scene is at most about 60 s).

## 3. Captions and the transcript

### 3.1 Drawing

Captions are UI glyphs: `ui/text.ts` shapes the line at run time into `UiGlyph {x, y, glyphId, font, size, r, g, b, a}` and the page pass draws them after the overlays (READING_GPU, read). Word highlighting is therefore per-glyph colour and alpha, with no new shader: the active word is the single amber accent (`THEME.accent`), spoken words ease to the secondary ink, upcoming words to the tertiary ramp (all at least 4.5:1 on the ground, checked by the existing contrast test over a planted frame). Karaoke fill within a word is a left-to-right mask by `(t - start)/(end - start)` on the word's glyph run (a per-glyph alpha ramp, still no shader).

Layout: two lines at most, centred, 62% of the viewport width, bottom 14% (above the transport bar), `Subtitle` lines broken at clause boundaries by the build (`Text` is authored whole; the breaker uses Knuth-Plass from `mag-layout`/`typeset.ts` with a 38-character target). A caption enters with the 12 px rise of TEXTFX and leaves on the next line; reduced motion removes the rise.

Glyph coverage: the UI tables hold fixed ranges, so `build.ts uiTexts` adds every `film.flecs` source (the same fix exhibits needed, read in the skill: "Exhibit text needs UI glyphs").

### 3.2 `Text` versus `Spoken`

Captions show what is written; the voice says what a person says. The two differ for code, symbols and numbers: `Text: {"The λ calculus has no tape."}` and `Spoken: {"The lambda calculus has no tape."}`. Inline form for a single word: `[λ|lambda]` inside either string (square brackets, no braces). Forced alignment (4.4) runs on `Spoken`; the build maps each spoken word back to a caption word through the bracket pairs, and any unmapped word fails the build. When `Spoken` is omitted it equals `Text`.

### 3.3 Transcript view

A panel toggled by `T` (and a transport button): the full narration as a scrolling column, current word in amber, every sentence a hit target that seeks the film (`film_set_time`). It is drawn as GPU text in the reader's own pass, reusing the reader's block layout for plain paragraphs (the transcript is the `Say` lines laid out as one article-like column by the same typesetter), so selection and copy work like the reader. Section headings in the transcript are the scene names with their `Covers` section titles.

### 3.4 Caption-only mode

`C` cycles: captions on (default), captions off, captions only (no stage: the film draws the dim ground, the captions large and the transport; the stage pass is not recorded, so it costs about nothing). Caption-only is also what the hidden-tab and listen views fall back to. Timing before audio exists is the **timer estimate**: words at 2.6 per second (156 wpm, a Veritasium-like pace, **reported** as typical explainer speech 150 to 180 wpm), plus 0.18 s after a comma, 0.45 s after a full stop, 0.7 s before a scene's first line. The estimate lives in `scripts/film/estimate.ts` and is the only place that constant exists.

### 3.5 Placeholder markers

Every `Say` carries `Status`: `draft` (a Sonnet lane wrote it), `approved` (Andrew approved the text), `voiced` (audio built and the hash matches). The build and the player enforce:
- `film.flecs` may not ship with a `voiced` line whose `sha256(Spoken + voice id + model rev)` differs from the one in `film.align.json` (fail closed).
- Any `draft` line is rendered by the player with a small amber dot in the transport and a "no voice yet" caption in the transcript header; production builds warn, they do not fail (the film must still play on the timer).
- The tag `Placeholder` on a `Say` or `Track` is removed by the build only when audio exists. An article with any `Placeholder` is excluded from the listen queue.

## 4. Narration: TTS plan

### 4.1 Requirements

Expressive long-form English, a voice that stays the same across 9 minutes and across articles, word timings we can trust, permissive licence for model and weights (house rule: never GPL or AGPL), an ongoing cost near zero, the site stays static (no runtime API), regeneration of one sentence cheap, and an optional route to Andrew's own voice later.

### 4.2 Candidates (state of the art as of 2026-10-07)

| Candidate | Licence (what I read) | Fit |
|---|---|---|
| **Qwen3-TTS** (Qwen team), `Qwen3-TTS-12Hz-1.7B-VoiceDesign`, `-1.7B-Base`, `-0.6B-Base` | Code: "Apache-2.0 license", **read** on https://github.com/QwenLM/Qwen3-TTS. Weights: the model card of the 1.7B VoiceDesign shows `License: Apache 2.0`, **read** on https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign. The GitHub page states no weights licence, so the lane reads the LICENSE file at the pinned revision of each repo we download | VoiceDesign makes a voice from a plain description of emotion, timbre and prosody; Base clones from a 3 s clip; streaming; 10 languages; no timestamp output (alignment is separate); maximum length not documented, so we synthesise per `Say` |
| Chatterbox (Resemble AI), Turbo 350M, Multilingual V3 500M | `MIT`, **read** on https://github.com/resemble-ai/chatterbox | `[laugh]`, `[chuckle]` tags (Turbo, English only); every output carries an imperceptible Perth watermark (read; acceptable, disclosed); voice cloning; strong second candidate |
| Kokoro-82M | Apache-2.0, **reported** (search summary) | tiny and fast, flat delivery; the CPU fallback and the draft-listen voice, not the final one |
| VibeVoice (Microsoft) | MIT, **reported** | built for 90 minute multi-speaker audio; not evaluated: the lane checks that the repo and weights are currently published before considering it |
| Dia (Nari Labs) | Apache-2.0, **reported** | dialogue-first; not a single narrator |
| ElevenLabs v3 API | proprietary terms, output licence by plan, **unverified** | likely the best expressive quality; $0.10 per 1,000 characters for v3/Multilingual v2, **reported** (https://developer.puter.com/tutorials/elevenlabs-api-pricing/); returns character timestamps (reported) |
| OpenAI `gpt-4o-mini-tts` | proprietary | about 1.5 cents per minute, **reported**; style by instructions; no timestamps |
| Google Gemini TTS | proprietary | $10 per 1M audio tokens (2.5 Flash) at 25 audio tokens per second, **reported**: about $0.15 per 10 minutes |
| F5-TTS, XTTS-v2, Fish Speech / OpenAudio | code permissive but weights non-commercial (CC BY-NC family, CPML), **reported from memory** | excluded until their LICENSE text for the exact release says otherwise |

Cross-check (2026-10-07): another lane already fetched and ran several of these into `docs/upstream/tts/` (SOURCE.md, samples, scripts; not mine, uncommitted when read). It confirms Qwen3-TTS-12Hz-1.7B (Apache-2.0 card and repo LICENSE, read), runs it on this Mac through an MLX port (port licence text not read), rejects F5-TTS weights (CC BY-NC 4.0, read) and Fish Audio S2 Pro (research licence), reads ElevenLabs v3 at $0.08 per 1,000 characters on the vendor page (a third-party page says $0.10), and used `stable-ts` (MIT, read) for forced alignment. The TTS lane starts from that directory instead of refetching, and may use `stable-ts` where MFA gives no gain (4.4).

### 4.3 Pick

**Qwen3-TTS-12Hz-1.7B (CustomVoice, preset speaker Aiden), run locally on this Mac through mlx-audio.** Free: no hosted API, no rented GPU, no per-article cost. Apache-2.0 code and model card, MIT mlx-audio 0.5.8, MIT stable-ts 2.19.1 and Whisper (all read; `docs/upstream/tts/`). Measured: real-time factor 0.61 at machine load about 16 (a 524 s film in about 5.5 minutes). No voice cloning and no VoiceDesign step: the speaker is one preset name, held in one Flecs value (`Narrator`), so changing the voice is one edit and a rebuild. Per-line style goes through punctuation, the `Spoken` text and `[pause]` markers. Names the model mispronounces are mapped in the `pronounce` table of `scripts/film/say.ts` (Kleene to "Klay-nee").

Hosted engines (ElevenLabs v3, Gemini TTS, OpenAI) and the paid blind A/B are dropped. The engine stays one function (`synth(spoken, voice) -> wav` in `scripts/film/narrate.py`), so a different local model is a swap, not a redesign.

Cost per article: zero dollars; about 6 minutes of Mac time for a 9 minute film. A retake of one sentence is seconds. The wall-clock cost is the review loop.


### 4.4 Word timings: forced alignment on the known text

The text is known, so this is forced alignment, not transcription. Pick **Montreal Forced Aligner** (MIT, **reported**; its acoustic and dictionary models are CC BY 4.0, **reported**, the lane reads the model licence text for the pinned version). Runs on CPU in seconds per article. Not whisper-timestamped (AGPL-3.0, reported: excluded by house rule). Fallback if MFA handles the voice badly: WhisperX alignment (BSD-2, reported; its wav2vec2 weights' licence read first). Output `film.align.json`:

```json
{ "voice": "hosted-id-or-qwen-ref-hash", "rev": "<model revision>", "lines": {
  "s1": { "hash": "<sha256 of spoken+voice+rev>", "clip": "s1.<hash8>.opus", "dur": 6.42,
          "words": [ ["The", 0.08, 0.21], ["lambda", 0.21, 0.66] ] } } }
```

Word times are per clip (seconds from clip start); the build lays clips on the scene timeline with a fixed 120 ms gap plus any authored `Pause` beat, so `Anchor` relations resolve to scene time. Words the aligner cannot place fail the build with the line id.

### 4.5 Pipeline: script text to audio files, static site

```
film.flecs --film_inspect--> Say list (Spoken, Text, Status, Order)
   for each Say: key = sha256(Spoken + voice + rev)
       cache hit in /Volumes/Projects/tmp/film-cache/<key>.wav ?  skip
       miss: synth on the GPU host -> wav (24 kHz)
   MFA align all clips (CPU) -> words
   lay out clips + gaps -> voice.<hash8>.m4a (AAC mono 64 kbps, about 4.3 MB per 9 min) and film.align.json
   listen.<hash8>.m4a = voice + music bed + ambience, -16 LUFS, one file for background listening (section 6)
```

Static: the committed artefacts are `film.align.json`, `voice.<hash8>.m4a`, `listen.<hash8>.m4a` (about 9 MB per article, tracked with git LFS or in-repo at Andrew's choice, decision D4) plus the voice reference. The per-line wav cache is not committed (derived, keyed by hash). The site fetches only the files it needs, on first play of that article. Regeneration: edit a `Say`, run `bun scripts/film/build.ts <slug>`; only changed lines are synthesised; `bun scripts/film/build.ts --check` fails when any `voiced` line's hash is stale. M4A (AAC) rather than only Opus because iOS lock-screen playback needs a codec Safari plays everywhere; an Opus-in-WebM copy is optional later.

### 4.6 The voice and the writing

Narration is re-voiced, not read from the article: a 1,800 word article becomes about 1,400 spoken words in the shape of a curious explainer episode. Each scene follows hook, question, demo, reveal, takeaway: (1) a concrete surprise in the first sentence; (2) the question the viewer now wants answered; (3) a demo the viewer can see or touch before any definition; (4) the reveal that names the idea; (5) one quotable takeaway that the next scene can use. The site's writing rules bind the narration too: no restating, no em dashes, no "X, not Y", absolutes cited (the film carries the `Refers` link to the numbered reference, shown as a small source chip while the sentence plays). The narration lives in the `Say` children of each scene, with the scene's beats, in one file, so the author sees voice and picture together.

Authoring flow: a Sonnet writing lane drafts all `Say` lines from the article plus the storyboard in section 11 (Status `draft`, tag `Placeholder`); Andrew approves per scene (Status `approved`); the TTS lane voices approved lines only. A scene with no approved line plays on the timer with captions.

## 5. Playing with the picture

### 5.1 What "grab" means

A `ExhibitRef` or a `Prop` with the tag `Grabbable` can be taken by the viewer at any time (pointer down on it, or the key `G` to focus the nearest). Taking it sets `Holding` on the scene: the film clock stops (audio pauses, music ducks to 20%, ambience stays), the camera freezes, the exhibit takes the pointer and key events through the museum router (`exhibit_pointer`, `exhibit_key`), and everything else stays on screen. A 90 second idle on a held scene fades the transport hint "press Space to continue".

### 5.2 Resume policy, per scene

A scene says what resume does with the viewer's changes: `Resume {mode}`.
- `Snap` (default): the exhibit is restored from the snapshot taken when the hold began (the museum snapshot, `snapshot.rs`), and the film continues as authored. The viewer's experiments are not preserved; the film stays seekable and pure.
- `Continue`: the exhibit keeps the viewer's state; later `Do load` beats resync it. Used when the next narration refers to what they did ("you got stuck in a loop, good").
- `Rewind`: the scene restarts from its start after the hold.

State taken by the viewer is never persisted in the film position (`film:pos` stores scene and `t` only).

### 5.3 Gates: the film invites you to play

A `Gate` beat holds the clock until the viewer acts: `Gate {until: Resume}` (Space), `Gate {until: Steps, n: 3}` (the viewer pressed step three times on the mount), `Gate {until: Idle, n: 8}` (8 seconds with no input after the first touch). Narration around a gate: "Go ahead, step it yourself. I will wait." A gate shows a pulsing ring on the mount (an overlay ring, same shape as the focus ring) and a pill "Space to continue". Listen mode and the hidden tab ignore gates (no pointer exists): gates auto-open after the line that introduces them finishes, plus 1.5 s. Gates never loop the audio.

## 6. Background listening (a plain media session)

Goal: start the film, lock the phone or switch tabs, and keep listening; resume later where you stopped.

Design (all of it TypeScript, `src/lib/film/`):
- **An `HTMLAudioElement`** created with `new Audio()` and never attached to the document (the DOM rule: head tags and canvases only; a detached element has no text and no layout, and the e2e check's text-node scan passes it, the lane adds a planted control). It plays `listen.<hash8>.m4a` in listen mode and `voice.<hash8>.m4a` in film mode. Using a media element rather than WebAudio only is what makes the OS treat it as media: lock-screen controls, Bluetooth buttons, and continuation with the tab hidden (browser behaviour **reported**, verified per browser in the test plan section 9).
- **Media Session API**: `navigator.mediaSession.metadata = {title, artist: "Andrew Gazelka", album: "Thoughts", artwork: [the shelf cover as 96/256/512 PNG]}` and handlers `play`, `pause`, `seekbackward` (15 s), `seekforward` (15 s), `seekto`, `previoustrack`, `nexttrack`, plus `setPositionState({duration, playbackRate, position})` every second. The metadata is the one place the OS shows text about the article; this is the whole accessible surface of listen mode and is stated as such below.
- **Hidden tab**: on `visibilitychange` to hidden the page stops its frame loop (no stage, no captions drawn) and the clock source stays `Audio`, so nothing drifts; on visible, `film_set_time(audio.currentTime)` re-seeks the scene (exact, section 2.6). In `Timer` mode (no voice) the film pauses when hidden: there is nothing to listen to.
- **Queue across articles**: `localStorage["film:queue"]` = ordered slugs (defaults to "this article, then the next on the shelf that has audio"); on `ended` the next file loads and `nexttrack` skips; the queue is edited in the transport (add, remove, next). Only articles with no `Placeholder` enter the queue.
- **Speed**: 0.75, 1, 1.25, 1.5, 1.75, 2 via `audio.playbackRate` with `preservesPitch = true`; `FilmClock.rate` follows the element; captions and beats track media time, so all stay in sync at any speed. Timer mode multiplies `dt`.
- **Resume**: `localStorage["film:pos:<slug>"] = {t, scene, rate, view}` written at most every 2 s, on `pause`, on `visibilitychange` and on `pagehide`; restored on open, with a toast "Resume at 4:12" and the key `0` to restart.
- **Autoplay**: never. The first sound follows a user gesture (the click on the book or the play glyph). Browsers that block `play()` leave the transport showing paused.
- **Audio graph**: the fundsp worklet (sfx, ambience in film mode) is not what keeps playing in the background; listen mode uses the baked `listen.m4a` (ambience and music in the file) so the OS-visible track carries the whole mix. Film mode uses the dry voice plus live synth, which the hidden tab does not need.

Accepted accessibility trade-offs (explicit, as the DOM-text rule already cost screen readers the page): the page still has no DOM text, so listen mode is the first path that serves someone who cannot see the canvas, but its only text is the Media Session metadata and the OS lock screen; there is no screen-reader transcript. Captions are canvas text and are on by default. A transcript for assistive tech is a separate decision (it would break the no-DOM-text rule) and is not added. Keyboard: Space play and pause, left and right 5 s, J and L 10 s, `[` `]` speed, `C` captions, `T` transcript, `N` next, `R` reader, Esc closes. Reduced motion (`prefers-reduced-motion`): `Fly` becomes `Cut`, emitters and `Motion` presets off, `Post` flicker off, scenes still play and scrub. A lint forbids any `Post` or `Fade` pattern that flashes more than 3 times per second.

## 7. The playback UI (drawn in the GPU reader and world)

One amber accent (`THEME.accent`), the single dark look, nothing from the DOM. It is the reader's chrome (`ui/widgets.ts` immediate mode: `buildChrome` returns overlays, uiText, hits, cursor) with a new `filmChrome(state, input)`.

### 7.1 Transport bar

A 52 px bar at the bottom, opaque ground, hairline top, visible while paused or for 2.5 s after pointer movement (the stage runs under it); the wake rule of the reader. Left to right: play/pause (a glyph, not text), back 15, forward 15, the time `4:12 / 9:08`, the scrubber, speed pill (`1x`), captions `CC`, transcript, view switch (film, listen, reader), queue next. Chapter name of the current scene above the scrubber while hovering.

### 7.2 Scrubber with scene ticks

A 4 px track growing to 8 px on hover (the scrollbar spring, 120 ms). Played part in ink, the playhead a 10 px amber dot. One tick per scene start (1 px hairline, 8 px tall); hover shows a tooltip card with the scene name and its `Poster` frame (rendered once at that scene's `Poster {t}`, cached as a small texture). Drag scrubs `film_set_time` with the audio paused while dragging and resumed on release. Keyboard focusable like the scrollbar. Gate positions appear as small amber ticks under the track ("you can play here").

### 7.3 The three views and keeping your place

`R` switches to the reader at the section the current scene `Covers`; from the reader, the film button starts at the first scene whose `Covers` is at or above the section at the reading line. A scene that covers no section (an intro) maps to the top. The scrub position is therefore the same place in both views to the section, which is as exact as the mapping needs to be.

### 7.4 Entry from the book

The book on the shelf opens as today (lift, carry, open: `book.rs` phases, `docs/BOOK.md`), and the open animation is the arrival. On the open cover (Reading phase, before the first spread), a play glyph (bottom left of the right page) opens the film: a new tag `WantFilm` (beside `WantOpen`) moves the existing `Backdrop` and camera dolly onward into the first scene's rig, so the book's final pose is the film's first frame when the scene is `Studio: Room` (the opening scene always is). Clicking anywhere else, or `Enter`, opens the reader as now. Which one is the default click for an article with a `film.flecs` is decision D2; the recommendation is the film, the reader one key away.

## 8. Relation to exhibits, the book and the world floors

- **Exhibits**: the film runs the same exhibits as the reader, through `ExhibitRef`, not a copy. `turing.flecs` is unchanged; a scene sends it `Do` verbs, the viewer can grab it, a held mount returns the exhibit to the reader's state on exit (the museum snapshot). Figures (the `Timeline` exhibits) play in a mount as before; their scrub control follows the film clock when mounted `Driven` (a tag: `Clock.t = FilmClock.t - start`).
- **Scrubbing**: figure and exhibit scrubbing stay local (the reader's own); a mount's scrub control scrubs the exhibit only. The film scrubber scrubs the film. Two scrubbers on screen never share a drag.
- **The book**: the open animation is the arrival (7.4); closing the film plays the close choreography back (`book.rs` mirrored phase), returning the book to the shelf.
- **Does the camera in the 3D world ever play the film? Yes, in `Studio: Room` scenes only, and by a bounded rule.** The room is where the book lives, so continuity (the book opens into the world, the last scene returns to the shelf) is worth the one exception, and the Archive floor props (Jacquard card, rotor) are real objects the camera can fly to. Every other scene uses `Studio: Void`, drawn by the film's own stage pass: the room renderer is a baked-lightmap, boxes-and-spheres path with progressive accumulation that ghosts a moving camera (the skill notes the moving "view" path while busy), it has no particles, post or kinetic type, and tying every scene to a floor would make the film depend on the room's layout. So: the room plays the first scene and the last, and any scene that wants a floor (`Studio: Room` plus `(Looks, shelf_prop)`) uses the elevator rig, its sounds and its camera; the rest is the stage pass.
- **Renderer**: a new **stage pass** (`src/lib/film/stage.ts`, `stage.wgsl`) on the same device: instanced primitives (box, sphere, disc, capsule, ribbon) with analytic shading from one key light and the amber accent, closed-form particles, post chain, composited under the page pass's UI and caption draws. It is not a second renderer for the room; the room remains `src/lib/gpu/room`. Budget: 2 ms per frame at 1440 x 900 DSF 2 on this Mac (measure with background load reported, per the house benchmark rule).

## 9. Test strategy

A few strong tests first.

1. **Seek equals play (the central property).** For a fixture film, for 200 random times `t`: `hash(state after film_set_time(t) from cold)` equals `hash(state after stepping from 0 to t at 60 fps)` equals the same stepped at 30 fps and at 144 fps with irregular frame times. The hash covers every component the film mutates, every particle's closed-form seed table, and the draw-list bytes. Property tests with hegel over `(t sequence, frame times)`.
2. **Golden timeline.** `tests/golden/models.film.json` records, at every 0.25 s of the first two scenes of the models film: `t`, scene, active caption line and word index, the state hash, the rig pose, and the exhibit's step count. Changing script, vocabulary or player must change it on purpose.
3. **Planted-bug controls (each must fail the test it targets).** (a) A tween integrating `dt` instead of evaluating `value(t)`: fails test 1 at 30 vs 60 fps. (b) `Gate` that ignores `Holding` (the clock runs during a hold): fails a scripted grab test. (c) A `Say` edited without regenerating audio: fails `build --check` (the hash gate). (d) Alignment shifted 300 ms: fails the onset check below. (e) A beat anchored to a word index past the line's last word: fails the lint with the entity path. Clean twins pass.
4. **Caption sync check against audio durations.** For every `Say`: aligned words are monotone and non-overlapping, each at least 40 ms, the last word ends no later than the clip duration plus 20 ms, the first starts no earlier than 0; the sum of clips plus gaps equals the scene's declared or derived duration within 50 ms; the clip's first sample above -40 dBFS is within 150 ms of word 1's start and the last audible sample within 250 ms of the last word's end (catches a global shift); decoded m4a duration equals `dur` within one AAC frame (23 ms). Audio is decoded in the test with ffprobe/ffmpeg on the dev host.
5. **Timer estimate.** `estimate.ts` against the first two scenes' real timings, once audio exists: the estimate's total within 15% (not a gate on the film, a check that the placeholder is honest).
6. **Script lint (pure over `film_inspect`)**: every rule with a fixture that fails exactly one rule plus a clean control (the museum approach): beats with equal time lack `Order`; unknown path or target; an exhibit id that is not in the article; emitters over budget; more than 120 props; `Spoken` words unmapped to `Text`; flicker rate; a `Gate` inside a scene with no `ExhibitRef`.
7. **Media session and hidden tab (e2e, headless Chrome on its own CDP port, never Andrew's browser).** Metadata and handlers set (`navigator.mediaSession.metadata` read back); `seekto` moves `audio.currentTime` and the film; `Emulation` of a hidden page keeps `currentTime` advancing and the frame loop stopped (draw counter flat, per the idle check in the skill); resume position round trips. What CDP cannot prove: iOS lock screen, Bluetooth buttons, and background throttling on real devices. These need a device pass and are listed as unverified until Andrew has played it on a phone.
8. **No DOM text**: the existing e2e section 4 still passes with the detached `Audio` element (planted `<p>` control stays).
9. **Visual**: dark screenshots at 1440, 820 and 390 of the first two scenes at four times each, with and without the extended float16 canvas (the skill's HDR trap), plus transport at rest and hovered.

## 10. First deliverable: the models post, scenes 1 and 2

Note: `docs/film/models.md` (commit 39fb0f4) is the content authority for the models film and starts with the `mkTuple` cold open, not the tape. Section 15.7 maps it; the first deliverable is its scenes 1 to 3 as template instances. The expanded script below shows what such instances generate and the mechanism in full (a Studio Room scene, beats on words, a gate); its scene texts are an alternative storyboard, not the shooting script.

Scenes follow the article's argument: a hook that poses the strange fact, then the tape demo with a real, grabbable Turing machine. Narration text below is **placeholder** (`draft`, tag `Placeholder`) written to fit the voice rules; the real narration is drafted by the writing lane and approved by Andrew.

### 10.1 `thoughts/models/film.flecs` (first two scenes; syntax follows `turing.flecs` and `60-museum.flecs`: one term per line, targets declared before use)

```flecs
// Film for "When you pay for computation". Data only; the player is world/src/film. Vocabulary: world/scene/70-film.flecs.
// Every Say is a PLACEHOLDER until voice.<hash>.m4a exists: Status draft, tag Placeholder (docs/NARRATED.md 3.5).

models : Film {
  Voice: {"qwen3-vd-warm-science", "r0"}

  // ---------------------------------------------------------- scene 1: the strange fact (Studio Room: the book opens into it)
  hook : Scene {
    Name: {"Two ideas of a computer"}
    Dur: {26.0}
    Poster: {14.0}
    (Covers, intro)

    room : Studio {
      Mode: {Room}
    }

    rig : Camera {
      Lens: {42}
      Center: {0.0, 1.55, 3.2}
      Sway: {0.015, 0.2}
    }
    shelf_book : Prop {
      Center: {0.0, 1.45, 0.0}
      (IsA, Magazine)
    }
    (Looks, shelf_book)
    tape : Prop {
      Body: {Ribbon, 14.0, 0.05, 0.9}
      Center: {-9.0, 1.0, -0.4}
      Ink: {Ink}
      Alpha: {0}
    }
    head : Prop {
      Body: {Box, 0.5, 0.5, 0.5}
      Center: {0.0, 1.2, -0.4}
      Ink: {Accent}
      Alpha: {0}
    }
    fall : Emitter {
      Rate: {40}
      Life: {2.4}
      Speed: {0.6}
      Spread: {0.9}
      Gravity: {-0.5}
      Seed: {7}
      Ink: {Ink}
      Alpha: {0}
    }
    glow : Post {
      Kind: {Bloom}
      Amount: {0.0}
    }

    s1 : Say {
      Status: {"draft"}
      Placeholder
      Text: {"Here is a strange fact. In 1936, two people wrote down two completely different ideas of what a computer is."}
    }
    s2 : Say {
      Status: {"draft"}
      Placeholder
      Text: {"One of them is a machine with a paper tape. The other has no machine at all, only functions."}
    }
    s3 : Say {
      Status: {"draft"}
      Placeholder
      Text: {"So which one is right? It turns out they compute exactly the same things, and the reason is hiding in a tape."}
      Spoken: {"So which one is right? It turns out they compute exactly the same things, and the reason is hiding in a tape."}
    }

    // the camera drifts toward the shelf book, then the tape unspools out of the book into the dark
    b_dolly : Beat {
      Order: {0}
      At: {0.0}
      Tween: {"Center.z", 1.1, 7.0, InOut}
      (Targets, rig)
    }
    b_tape_in : Beat {
      Order: {1}
      (Anchor, s1)
      Word: {8, -0.3}
      Show
      Fade: {1.2}
      (Targets, tape)
    }
    b_tape_run : Beat {
      Order: {2}
      (Anchor, s1)
      Word: {8, -0.3}
      Tween: {"Center.x", 9.0, 9.0, Linear}
      (Targets, tape)
    }
    b_head : Beat {
      Order: {3}
      (Anchor, s2)
      Word: {1, 0.0}
      Show
      Fade: {0.6}
      (Targets, head)
    }
    b_bloom : Beat {
      Order: {4}
      (Anchor, s2)
      Word: {1, 0.0}
      Tween: {"Amount", 0.6, 3.0, InOut}
      (Targets, glow)
    }
    b_fn : Beat {
      Order: {5}
      (Anchor, s2)
      Word: {12, -0.1}
      (Triggers, Burst)
      (Targets, fall)
    }
    b_ding : Beat {
      Order: {6}
      (Anchor, s3)
      Word: {0, 0.0}
      Sound: {"ding", 0.4, 0.0}
    }
    b_close : Beat {
      Order: {7}
      (Anchor, s3)
      Word: {12, 0.0}
      Fly: {3.0, InOut}
      (Targets, rig)
    }
  }

  // ---------------------------------------------------------- scene 2: the tape, handed to the viewer (Studio Void)
  tapes : Scene {
    Name: {"Watch it add one"}
    Dur: {48.0}
    Poster: {20.0}
    (Covers, two_models)

    ground : Studio {
      Mode: {Void}
    }

    rig2 : Camera {
      Lens: {34}
      Center: {0.0, 0.8, 6.0}
    }
    machine : ExhibitRef {
      Of: {"models/turing"}
      Dock: {0.08, 0.14, 0.84, 0.62}
      Alpha: {0}
      Grabbable
      Resume: {Snap}
    }
    bits : Type {
      Words: {"1 0 1 1"}
      Motion: {Rise}
      Center: {0.0, 0.5, 0.0}
      Alpha: {0}
    }
    pulse : Emitter {
      Rate: {20}
      Life: {1.2}
      Speed: {0.3}
      Spread: {0.4}
      Gravity: {0.0}
      Seed: {11}
      Ink: {Accent}
      Alpha: {0}
    }

    s4 : Say {
      Status: {"draft"}
      Placeholder
      Text: {"Start with the tape. A head reads a cell, writes a cell, and moves. That is the whole machine."}
    }
    s5 : Say {
      Status: {"draft"}
      Placeholder
      Text: {"Watch it add one to a binary number: one, zero, one, one. The head runs to the right end, then carries back to the left."}
      Spoken: {"Watch it add one to a binary number: one, zero, one, one. The head runs to the right end, then carries back to the left."}
    }
    s6 : Say {
      Status: {"draft"}
      Placeholder
      Text: {"Now you try. Press step. I will wait."}
    }
    s7 : Say {
      Status: {"draft"}
      Placeholder
      Text: {"Eight steps, and eleven became twelve. Notice what the machine never said: where the carry went. The tape remembered it."}
    }

    b_in : Beat {
      Order: {0}
      At: {0.0}
      Show
      Fade: {1.0}
      (Targets, bits)
    }
    b_mount : Beat {
      Order: {1}
      (Anchor, s4)
      Word: {2, 0.0}
      Show
      Fade: {0.8}
      (Targets, machine)
    }
    b_load : Beat {
      Order: {2}
      (Anchor, s4)
      Word: {2, 0.0}
      Do: {"load", 0}
      (Targets, machine)
    }
    b_step_1 : Beat {
      Order: {3}
      (Anchor, s5)
      Word: {12, 0.0}
      Do: {"step", 1}
      (Targets, machine)
    }
    b_run : Beat {
      Order: {4}
      (Anchor, s5)
      Word: {16, 0.0}
      Do: {"run", 8}
      (Targets, machine)
    }
    b_pulse : Beat {
      Order: {5}
      (Anchor, s5)
      Word: {20, 0.0}
      (Triggers, Burst)
      (Targets, pulse)
    }
    b_reset : Beat {
      Order: {6}
      (Anchor, s6)
      Word: {0, 0.0}
      Do: {"reset", 0}
      (Targets, machine)
    }
    b_gate : Beat {
      Order: {7}
      (Anchor, s6)
      Word: {7, 0.4}
      Gate: {Steps, 3}
    }
    b_finish : Beat {
      Order: {8}
      (Anchor, s7)
      Word: {0, 0.0}
      Do: {"run", 8}
      (Targets, machine)
    }
  }
}
```

Notes on the script: `Ink: {Ink}`, `{Accent}`, `Alpha: {0}` and the enum constants (`Ribbon`, `InOut`, `Room`, `Burst`) are defined in `70-film.flecs`; `(IsA, Magazine)` reuses the room's magazine prefab; `(Covers, intro)` and `(Covers, two_models)` name section ids the build already emits (`flow.ts`); `b_load` and `b_run` hit the same `Activate` path the Run and Load buttons use; the `Gate: {Steps, 3}` counts presses on the mount named by the gate's scene. A `Beat` with no `(Targets, ...)` (a `Gate`, a `Sound`) is scene-wide. The exact enum and string-pair syntax is settled by spike F0 (one line each, in the vocabulary file); everything uses forms already proven in `turing.flecs` and `60-museum.flecs`.

### 10.2 Component and relation table for this deliverable

| Used in the script | Registered as | Family file |
|---|---|---|
| `Film`, `Voice` | reflected component on the film entity | `model.rs` |
| `Scene`, `Name`, `Dur`, `Poster`, `(Covers, x)` | scene data and relation | `model.rs` |
| `Studio {Mode}` | Void or Room | `stage.rs` |
| `Camera`, `Lens`, `Center`, `Sway`, `(Looks, p)`, `Fly` | camera | `rig.rs` |
| `Prop`, `Body`, `Ink`, `Alpha`, `(IsA, Magazine)` | primitives and room prefabs | `stage.rs` |
| `Emitter`, `Post` | closed-form particles, bloom | `fx.rs` |
| `Type`, `Words`, `Motion` | kinetic type | `type_.rs` |
| `ExhibitRef`, `Of`, `Dock`, `Grabbable`, `Resume` | exhibit in scene | `mount.rs` |
| `Say`, `Text`, `Spoken`, `Status`, `Placeholder` | narration line | `model.rs` |
| `Beat`, `Order`, `At`, `(Anchor, say)`, `Word`, `(Targets, e)` | timeline | `beats.rs` |
| `Tween`, `Show`, `Fade`, `Do`, `Gate`, `Sound`, `Cut` | actions | `beats.rs`, `tween.rs` |
| `FilmClock` | singleton | `clock.rs` |

## 11. Visual language: concrete scenes for the models post and the IFD post

Rules every scene obeys: plain text is the exception (captions, a key phrase, one kinetic word at most per scene); each scene teaches ONE idea by something that moves and can be touched; the only accent is amber and it means "what happens next or what is active"; every scene has a poster frame; each scene reuses an existing exhibit where one exists. These are the briefs the writing and storyboard lanes expand into `Say` and `Beat` entities.

**Models post**

1. **The tape that unspools out of the book (hook, scene 1).** The shelf book glows in the dark room; the camera slides toward the spine and a paper tape slides out of the pages like a ribbon from a magician's sleeve, printed with 1s and 0s, running left to right under an amber lamp across the whole room. A small brass head waits above it. Behind it, in the dark, a second, fainter shape: a single lowercase lambda drawn as a long thin shadow cast across the shelves by the same lamp. Two shadows of one thing; the camera flies between them to the shelf, the book closes. Kinetic type: nothing; the picture is the claim.
2. **Add one, and the viewer's hands (scene 2).** The real Turing exhibit rises from the floor of the void as a glass console, the head ticks with a click, the carry bit pulses amber in the tape as it walks left. The narrator stops at "now you try" and the console pulses a ring; the film waits until the viewer has pressed step three times, then continues from where the viewer left it or snaps back to the scripted state (`Resume`). Eight steps, a soft ding on halt.
3. **Contraction: arguments pour in (lambda).** The number 3 is drawn as three nested glass spheres, each one holding a smaller one: `f(f(f(x)))`. A substitution is a visible act: the argument leaves its place as a drift of amber particles, travels along a curve into the hole where the variable was, and the binder shell dissolves behind it. The viewer can grab a redex (an amber-ringed shell) to pick which one to contract; the console shows normal order and applicative order side by side.
4. **`ignore omega`: the term that eats the camera.** Applicative order contracts omega, which rebuilds itself bigger every step: the camera pulls back as a growing lattice of identical shells fills the void, the music rises by a semitone per contraction, a counter ticks (one kinetic number), the pull-back never stops. Normal order never opens the shell: omega is dropped into the dark as one unopened sphere and the soundtrack drops to silence in one beat. The silence is the punchline.
5. **do-notation: the bead and the conveyor.** A glowing bead (the state) is passed through three arches in a row, each arch a lambda that takes it and hands a bigger bead on: `modify (+1)` three times, 0 becoming 3. Then the camera lifts: the arches are the cells of a tape, the bead's path is the head's walk, and the nested arch chain unspools into the paper tape of scene 1, flat and printed. The viewer can tap an arch to swap `modify` for `get`.
6. **The type checker is a program (`mkTuple 3`).** A stack of glass slabs recedes along the z axis, each stamped with a type (`Tuple 3`, `Tuple 2`, `Tuple 1`, `Unit`); the camera flies down the stack through each slab, the slab lighting amber as it is checked, and at `Unit` the stack folds back toward the viewer, each slab becoming one component of the tuple `(2, 1, 0, ())`. A slider on the mount changes n and the stack grows or shrinks live (the type-level count is the length of the flight).
7. **Inference is paid on every read (coins).** A shop till. Each time a file is opened, a coin of amber drops from above into a glass jar and the jar's counter ticks; the same file opened five times piles five coins. Then the author writes the signature once: a stamp lands on the file, and later opens drop no coin at all. The viewer clicks "open file" and watches the jar; the reveal is the jar staying empty.
8. **A text file is not the unit (Merkle rain).** Hash tiles fall from the dark and land in a DAG, each tile finding its slot with a spring; the viewer picks one leaf (the real `merkle` exhibit) and edits it: a wave of amber runs up the parents and only those tiles re-colour and re-fall, every other tile stays still. Camera slowly orbits so the shared subtrees read as shared. Ends with the room's last scene: the book closing onto the shelf.

**IFD post**

1. **The corridor and the locked door.** A first-person flight down a long corridor of thunks (grey doors) with a walker (the evaluator) in front of the camera. At a door marked `${drv}` the walker stops dead; the ambience drops to a hush; far away, through the glass wall, a furnace (the build) lights slowly and a gauge counts idle seconds in the walker's dim lamp. The camera is held there for as long as the narrator holds the breath. This is CppNix blocking.
2. **Snix leaves a token (yield).** The same corridor, the walker reaches the door, drops a glowing token, and walks on past; the camera follows the walker, the furnace burns behind it at the same time, and later the token falls out of the door as the finished file and the walker picks it up. Split screen, one frame each, with the idle gauge frozen in the second one. The viewer drags a slider to shorten the build and watches the first corridor wait while the second does not.
3. **The graph grows like a crystal.** The real `graph` exhibit becomes a 3D crystal: eval and build nodes appear as faceted cells as the evaluator discovers them; the viewer edits a source file (click a node) and only its dependents flash amber, the rest stay dim. The camera slowly orbits; "a thunk nobody forces is a derivation nobody builds" is the one phrase on screen, spoken and written, as the unforced cells never light.

(Those are 8 and 3 scenes, 11 in total; the first two models scenes are specified in section 10, the other 9 are designs only and get their own beats in later waves.)

## 12. Staging for one wave

One pass, all lanes at once, delete nothing old (this is new surface), merge, build once. Lanes write and commit code in their own worktree branch and run nothing (the house round rule); the root merges, runs `bun run build:world` once, builds the magazine once, runs the tests once, renders one batch.

| Lane | Model | Files | Cost (est.) |
|---|---|---|---|
| A. Film module (Rust) | Opus (the player and seek semantics are the hard part) | `world/src/film/*`, `world/scene/70-film.flecs`, `world/src/lib.rs` exports, `world/src/scene.rs` SCRIPTS, `world/src/book.rs` (`WantFilm`), tests in `world/` | 1 to 2 days |
| B. Stage pass (GPU) | Sonnet | `src/lib/film/stage.ts`, `stage.wgsl`, `fx.wgsl` (closed-form particles, post chain), `src/lib/film/compose.ts` (stage under page pass), planted-frame screenshot fixtures | 1.5 days |
| C. Player, captions, UI | Sonnet | `src/lib/film/{player,captions,transport,transcript,keys,resume,queue,mediasession}.ts`, `src/lib/reading/ui/widgets.ts` (`filmChrome`), `src/lib/reading/reader.ts` (view switch), `src/lib/reading/ui/` tests | 1.5 days |
| D. Narration pipeline | Sonnet | `scripts/film/{build,synth,align,layout,estimate,lint}.ts`, `scripts/film/voice/` Python (uv project for Qwen3-TTS and MFA), `scripts/magazine/film.ts` (reads `film_inspect`), `docs/upstream/film-tts/{SOURCE.md,LICENSE-*}` | 1.5 days; free, local on the Mac (section 4.3, 16) |
| E. Writing | Sonnet | `thoughts/models/film.flecs` (the `Say` lines and the storyboard beats for all 8 scenes; the first two exactly as in section 10), then `thoughts/ifd/film.flecs` storyboards | 1 day, no compute |
| F. Tests and fixtures | Sonnet | `scripts/film/tests/*`, `world` golden test, `tests/golden/models.film.json`, e2e `tests/e2e/film/*` (headless Chrome on its own CDP port) | 1 day |
| Root | Fable or Opus review | merges, build, integrates `Reader.svelte`/`World.svelte` hooks (the film entry from the book), runs the tests once, reads the render batch, approves the narration with Andrew | half a day |

Order inside the wave: every lane starts at once against the contracts in this file (the ABI of 2.4, the vocabulary of 2.5, the JSON of 4.4, the transport of 7.1). The seams that broke the museum lanes (the Rust and TypeScript `inspect` shapes written separately) are prevented by writing `FilmInspect` (JSON) and the `film_events` ring layout into section 13 below before lanes start; they are the only shared types.

## 13. Contract between lanes

`FilmInspect` (from `film_inspect`, the only metadata source): `{ film: {title, voice: {id, rev}}, scenes: [{ id, name, dur, poster, covers, studio, counts: {props, emitters, posts, glyphs}, says: [{id, text, spoken, status, placeholder}], beats: [{id, order, at | {cue, word, lead}, action, target, args}], mounts: [{id, of, grabbable, resume}], tracks: [...] }] }`. `film_events` ring entries `[kind u32, a u32, b u32, f f32]`: 1 sceneChanged (scene index), 2 gateOpened, 3 gateClosed, 4 sound (id << 8 | velocity), 5 ended. Draw lists: the stage pass reads `film_pack` records `{kind, a..f}` in the exact form `docs/MUSEUM.md` "Built contract" uses for exhibits, and UI glyph runs go to the existing `PageFrame.uiText`.

## 14. What needs Andrew

Top decisions, with my pick first:

- **D1. The voice.** Done and free: Qwen3-TTS 1.7B preset Aiden, local. Listen to `static/film/models/voice.15322f48.m4a` and say whether the voice, pacing and name pronunciations are acceptable; a different preset is one `Narrator` edit plus `scripts/film/say.ts` and `narrate.py`.
- **D2. Default click on a book.** Pick: film first for any article that has a film, the reader one key (`R`) or button away. The other choice is the reader first with a play glyph on the cover; this one costs nothing to change later.
- **D3. Your own voice.** Whether to clone your voice (Qwen3-TTS Base clones from a 3 second clip; Chatterbox does too). Default: no, the designed voice. If yes: a 30 second clean recording, your explicit consent in writing in the repo, a note that cloned speech is labelled (Chatterbox watermarks; Qwen3 does not, as far as read), and the voice never leaves the repo.
- **D4. Audio in git.** About 9 MB per article (voice and listen files), committed in-repo or in git LFS. Pick: in-repo until about 100 MB, then LFS.
- **D5. Narration approval.** You approve each scene's `Say` lines (`Status: approved`) before any audio is generated: the first two scenes now, the rest as the writing lane delivers them.
- **D6. Accessibility cost.** You decide whether listen mode's only text being the OS lock screen is acceptable (it is the minimum the existing no-DOM-text rule allows). A transcript for assistive technology is deliberately not added.

Open spikes (each one is a one-line test in lane A or D before it is relied on): F0 Flecs script enum and string-pair syntax for the film vocabulary and whether `module film` works; F1 reflection-path `Tween` through flecs meta cursors in `flecs_ecs`; F2 an exhibit `ExhibitRef` rendered to an offscreen texture on a 3D quad (v1 is a screen-space dock only); P1 Qwen3-TTS voice consistency through VoiceDesign then Base conditioning, its real-time factor and per-call length; P2 MFA on that voice; P3 whether a detached `Audio` element keeps the Media Session on iOS Safari and Android Chrome with the tab hidden.

## 15. Composability: a library, not copies

Andrew: "make sure you have the proper prefabs and relations to make everything composable for future videos." The rule: **a film is a short file of instances and overrides over a shared library; it never copies library content.** Sections 2 and 10 are the mechanism; this section is the contract that keeps the second film cheap. (The scene excerpt in 10.1 is the expanded, no-template form of what 15.4 writes in 14 lines.)

### 15.1 Two layers, because Flecs script has two tools (read in the flecs-scene skill and `docs/MUSEUM.md` 2.3)

| Tool | Good for | Limit that decides the split |
|---|---|---|
| **Prefab with `IsA`** | one entity or a small fixed tree: a kind of beat, a camera shot, an effect, a narrator, a theme | **you cannot override a child of a prefab from a variant, or add children to an inherited child** (skill, "Decor prefabs"). A variant restates only the root's components |
| **Script `template` with `prop`** (read: MUSEUM 2.3: `template`, `prop`, `const`, `for`, `if`, `"name_$i"` interpolation) | a multi-entity scene pattern whose children depend on parameters: the exhibit, the captions, the dock rect | the instance generates fresh entities, so every child can take a parameter; cost: the body is script, no Rust |

So: leaf types are prefabs, scene patterns are templates. A scene template instantiates leaf prefabs inside its body and passes its props into their overrides.

### 15.2 The library (prefabs, relations, directory)

```
world/scene/film/vocab.flecs               relations, enums, events (plain entities); one place for every name
world/scene/film/lib/prefabs.flecs         Film, Scene, Beat, Cue, CaptionLine, Say, Track, Camera, Prop, Effect, ExhibitRef, Transition, Narrator, Theme and their stock variants
world/scene/film/lib/narrators.flecs       Narrator variants (a voice id, pace, persona text)
world/scene/film/lib/themes.flecs          Theme variants (stage, light, caption size, bloom: never hue; there is one palette)
world/scene/film/lib/kits.flecs            Prop kits: CodeEditor, Terminal, Tape, Till, Shelf, SourceCards, Gauge
world/scene/film/lib/effects.flecs         Effect variants: Burst, Crumble, Bloom, Vignette, Wipe, Rain
world/scene/film/lib/transitions.flecs     Transition variants: Cut, DipToGround, WipeAmber, MatchPose
world/scene/film/lib/templates/*.flecs     one scene template per file: cold-open, misconception-test, demo-pause, reveal, callback, outro (+ equivalence, edge-cases, 15.7)
thoughts/<slug>/film.flecs                 the film: header, instances, the order. Nothing else
thoughts/<slug>/exhibits/*.flecs           exhibits (unchanged; any film may use any exhibit)
```

Load order (as the skill says for `12-decor`): vocab, lib, a generated `exhibits.index.flecs`, then the film. The library is embedded in `world.wasm` like the other scene scripts and hot reloads like them; the film file hot reloads alone (about 30 ms to pixels, state kept).

Prefabs (every one is an IsA base; a film makes variants, `name : Base { overrides }`):

| Prefab | Fields | Stock variants |
|---|---|---|
| `Film` | `Title`, `Dek`, `(Speaks, narrator)`, `(Themed, theme)`, `(Plays, scene)` repeated | none: a film is an instance |
| `Scene` | `Name`, `Dur`, `Poster`, `(Covers, section)`, `(Follows, scene)`, `(Via, transition)` | the six templates below create Scene instances |
| `Beat` | `At` or `After`/`Anchor`, `Order`, one action | `Reveal : Beat`, `Hold : Beat` (a `Gate`), `Pulse : Beat` (a Triggers), `Step3 : Beat` (`Do step 3`) |
| `Cue` | a named sync point: `Word {n, lead}` on a `(Anchor, say)`; beats follow it with `(After, cue)` | none |
| `CaptionLine` | `Text`, `Hold` seconds (no voice); `Say : CaptionLine` adds `Spoken`, `Status`, `(Speaks, narrator)` | `Hook`, `Question`, `Reveal`, `Takeaway` (a `Say` with the narrator's stock style hint) |
| `Track` | `Narration`, `Music`, `Sfx` children | `Bed`, `Duck` |
| `Camera` | `Lens`, `Center`, `(Looks, prop)`, `Sway`, `Waypoint` children | `Wide`, `Push`, `OrbitSlow`, `TopDown`, `RoomRig` (Studio Room) |
| `Prop` | `Body`, `Center`, `Euler`, `Ink`, `Glow`, `Alpha` | the kits: a `CodeEditor` (typed text, caret, error block) is one prefab tree with a `Type` child |
| `Effect` | `Rate`, `Amount`, `Seed`; base of `Emitter` and `Post` | `Burst`, `Rain`, `Bloom`, `Vignette`, `Crumble`, `Gauge` |
| `ExhibitRef` | `(Uses, exhibit)`, `Dock`, `Alpha`, `Resume`, `Grabbable`, `Preset` | `Docked`, `Floating`, `Fullscreen` |
| `Transition` | `Kind`, `Dur` | `Cut`, `DipToGround`, `WipeAmber`, `MatchPose` |
| `Narrator` | `Voice {id, rev}`, `Pace {wps}`, `Persona {text}` | `warm-science` (the default of 4.3), later `andrew` (D3) |
| `Theme` | `Stage {ground, light dir, floor}`, `Caption {size, lines}`, `Post` defaults | `Dark` only; a variant may change geometry and bloom amount, never hue (CLAUDE.md "one colour, one accent") |

Relations (declared once in `vocab.flecs`, each with its meaning and cardinality; the lint rejects any other relation inside a film):

| Relation | Meaning | Traits |
|---|---|---|
| `ChildOf` | ownership and lifetime: a scene owns its props; deleting a scene deletes them | built in |
| `IsA` | variant: `ThoughtHold : Hold`, `Wide : Camera` | built in |
| `(Plays, scene)` | the film's playlist: which scenes run. A scene may live in the library, another film or this one | many per film |
| `(Follows, scene)` | scene order (the previous scene); a scene with no `Follows` is first | exclusive |
| `(After, beat_or_cue)` | this beat starts when that one ends, plus `Delay`; chains a sequence with no absolute times | exclusive, acyclic (no forward refs, so a cycle cannot be written) |
| `(Anchor, say)` | a beat or cue is pinned to word `n` of a narrated line | exclusive |
| `(Targets, entity)` | what a beat acts on | exclusive; `(OnDeleteTarget, Delete)` |
| `(Uses, exhibit)` | an `ExhibitRef` names an exhibit (a generated registry entity `ex_<slug>_<id>`); one exhibit may be used by any number of films and by the reader at once, each use being its own loaded scope with its own state | many |
| `(Speaks, narrator)` | the voice of a `Say` (default: the scene's, then the film's) | exclusive |
| `(Shows, prop)` | a scene displays a prop it does not own (a film-level kit, the previous scene's prop set, a library kit): the loader instantiates it fresh at the scene start | many |
| `(Triggers, event)` | a beat delivers an `Event` entity (`Burst`, `Crumble`, `Flash`, `Ding`) to its target | exclusive |
| `(Via, transition)` | the cut into a scene | exclusive |
| `(Themed, theme)` | film or scene theme | exclusive |

Purity rule (so the seek equals play test of 2.6 survives composition): nothing carries state across scenes. `(Shows, prop)` and a callback restate the pose by re-instancing the prop from its prefab at scene start; they never read what an earlier scene did to it.

### 15.3 Scene templates (parameterised, reusable across films)

Each template is a Flecs script `template` with `prop`s and a body of library prefabs, beats and `Say` lines. It owns the choreography (camera, timing, effects, gates, sound); the film supplies the content (which exhibit, the sentences, the doc section). A film cannot reach inside a template; it passes props, or it writes a new scene by hand.

| Template | Pattern (the Veritasium beat it carries) | Props (the parameters) |
|---|---|---|
| `ColdOpen` | the puzzle or odd fact, then a thought hold: black, one prop kit types itself, an error or surprise lands, a `Gate Idle` ring | `kit`, `line1..3`, `puzzle`, `hold_secs`, `covers` |
| `MisconceptionTest` | the common picture is shown, put under strain, and a wall or label breaks | `exhibit`, `claim`, `strain`, `title_card`, `covers` |
| `DemoPause` | say what it does, hand it over, wait for the viewer, then say what was visible | `exhibit`, `preset`, `intro`, `prompt`, `after`, `gate_steps`, `dock`, `covers` |
| `Reveal` | the idea named: camera pulls back, one prop kit or exhibit animates the answer, one quotable line | `kit_or_exhibit`, `line1..3`, `quote`, `covers` |
| `Callback` | return to the opening scene's props and settle the question | `of_scene` (a `(Shows, ...)` set), `resolution`, `quote`, `covers` |
| `Outro` | the thesis strip across everything shown, the last line, the book closes (Studio Room) | `strip_exhibit`, `line1..2`, `queue_next`, `covers` |

Templates are the unit of reuse; a library scene changed once changes every film that uses it, which is the point and the risk, so the golden timeline of every film that instantiates a changed template is regenerated and reviewed in the same commit (the test of section 9 runs over all films).

### 15.4 Worked example: one `demo-pause`, two films

The template (`world/scene/film/lib/templates/demo-pause.flecs`; written in the form of the Flecs manual, with the exact `template` and instantiation syntax confirmed by spike F0):

```flecs
template DemoPause {
  prop name = string: "Try it"
  prop ex = flecs.meta.entity
  prop preset = u32: 0
  prop intro = string: ""
  prop prompt = string: "Now you try. I will wait."
  prop after = string: ""
  prop gate_steps = u32: 3
  prop dock_x = f32: 0.08
  prop dock_w = f32: 0.84
  prop covers = flecs.meta.entity

  Name: {$name}
  (Covers, $covers)

  ground : Studio {
    Mode: {Void}
  }
  cam : Wide {}
  box : Docked {
    (Uses, $ex)
    Dock: {$dock_x, 0.14, $dock_w, 0.62}
    Grabbable
    Resume: {Snap}
  }
  pulse : Burst {
    (Targets, box)
  }
  s_intro : Hook {
    Text: {$intro}
  }
  s_prompt : Question {
    Text: {$prompt}
  }
  s_after : Takeaway {
    Text: {$after}
  }
  b_show : Reveal {
    (Anchor, s_intro)
    Word: {2, 0.0}
    (Targets, box)
  }
  b_load : Step3 {
    (After, b_show)
    Do: {"load", $preset}
    (Targets, box)
  }
  b_gate : Hold {
    (Anchor, s_prompt)
    Word: {-1, 0.4}
    Gate: {Steps, $gate_steps}
    (Targets, box)
  }
  b_ring : Pulse {
    (After, b_gate)
    (Triggers, Ring)
    (Targets, box)
  }
  b_run : Step3 {
    (Anchor, s_after)
    Word: {0, 0.0}
    Do: {"run", 8}
    (Targets, box)
  }
}
```

Film A, `thoughts/models/film.flecs` (the Turing demo, shooting script scene 3):

```flecs
tape : DemoPause(
  name = "A tape that remembers everything",
  ex = ex_models_turing,
  preset = 0,
  intro = "Start with a Turing machine. A head sits over a tape. Each step it reads a cell, writes a cell, moves, and changes state.",
  prompt = "Press step. Watch the tape. This one adds one to a binary number.",
  after = "Notice what the program never says. It never says what to carry forward. The tape remembers everything.",
  covers = sec_two_models
)
```

Film B, `thoughts/ifd/film.flecs` (the action graph, a different post, a different exhibit, different captions, a wider dock and one gate step):

```flecs
rebuild : DemoPause(
  name = "Edit a file, see what rebuilds",
  ex = ex_ifd_graph,
  preset = 1,
  intro = "Here is a build graph. Every node is keyed by a hash of its inputs.",
  prompt = "Click a source file to edit it. Then watch which nodes light up.",
  after = "Only the dependents rebuilt. The rest were already in the cache.",
  gate_steps = 1,
  dock_x = 0.04,
  dock_w = 0.92,
  covers = sec_static_graph
)
```

Both are 9 to 12 lines; the choreography (a dock rise at word 2 of the intro, the load, the gate after the prompt, the ring, the final run) is written once. The generated tree for each is a normal `Scene` with its own `box`, `Say` lines and beats, so the seek-equals-play test, the golden timeline and `film_inspect` see them like hand-written scenes. A film that needs one different beat writes that scene by hand (10.1) instead of bending the template.

### 15.5 One timeline, many consumers

The timeline is data before it is pixels. `film_inspect` (section 13) returns the resolved timeline: scenes in `Follows` order with absolute scene times, every beat resolved through `At`, `After` and `Anchor` to seconds, every `Say` with word times, every `Uses`, `Covers` and `Gate`. Consumers that read only that JSON:

- the **player** (`film_set_time`): the live film;
- the **audio build**: the `Say` list and the gaps;
- the **transcript** and **chapters** (scene names and starts for the scrubber, the Media Session, and a video description);
- the **reader link map** (`Covers`);
- a **video export** (`scripts/film/export.ts`): the pure seek lets a headless Chrome step `film_set_time(k / 60)` per frame, capture the canvas, and encode with ffmpeg beside the voice file (a gate is skipped with its authored hold time; the Hold scenes render their `Resnap` frame); the export is the proof that nothing depends on wall clock, and it is how a film reaches a platform that is not this site, with the captions burnt in or as a sidecar `.vtt` made from the same word times;
- another **film**: a film may `(Plays, scene)` a scene owned by another film or the library (a recap video, a trailer made from the best scenes).

### 15.6 What a new film costs after this exists

| Item | Cost |
|---|---|
| Files | 1 authored file, `thoughts/<slug>/film.flecs`; 0 Rust files; 0 library files if every scene fits a template; generated and committed: `film.align.json`, 2 audio files |
| Lines | header about 12 lines (`Film`, narrator, theme, `Plays` and `Follows`); each template instance 10 to 14 lines; a 9-scene film is about 110 to 130 lines, of which about two thirds is the narration text and the rest is wiring. The hand-written scenes of 10.1 are about 95 lines each, which is what a template removes |
| New exhibit | +1 `.flecs` file of about 100 to 250 lines (see `turing.flecs`) when the picture does not exist; a catalogue of reusable families keeps this to data (MUSEUM 2.5) |
| New template | +1 file of 60 to 120 lines, written once, for a pattern not yet in the library (15.7) |
| New effect or kit | a variant prefab in `lib/` (5 to 20 lines) if it composes existing families; a new family is one Rust file of 150 to 300 lines |
| Voice and audio | `scripts/film/say.ts` then `scripts/film/narrate.py`: free, local on this Mac (4.3, 16); no authored lines |

These are estimates. The measure that decides success: the second film (ifd) needs no change to `world/` and fewer than 150 authored lines for its first six scenes; if it needs a Rust change, the library is missing a family and that is written back here.

### 15.7 The models shooting script maps onto the library

`docs/film/models.md` (commit 39fb0f4, 11 scenes, 520 s on screen, about 1,044 spoken words) is the content authority for the models film; it supersedes the scene content of sections 10.1 and 11 (those are the mechanism and an alternative storyboard). The `[PLAY]` markers become `Gate`, `[pause]` becomes a `Pause` beat, `[emphasis]` a `*word*` mark in `Spoken` (a stress hint for the TTS), `[sourced: ...]` a `Refers` link to the numbered reference, and `[needs source]` a build warning on the `Say`. First deliverable stays two scenes: shooting-script scenes 1 and 2 (`ColdOpen`, `MisconceptionTest`) plus scene 3 (`DemoPause`, the example above), about 45 authored lines.

| Shooting scene | Template (library) | Needs |
|---|---|---|
| 1 Cold open (mkTuple, delete the signature) | `ColdOpen` | kit `CodeEditor` (new prop kit: typed code, caret, error block; item 6 of the script's list, a real Lean capture or a WebGPU mock); the thought hold is the template's `Gate Idle` |
| 2 The question and the misconception | `MisconceptionTest` | exhibit `two-machines` (exists) |
| 3 A tape that remembers everything | `DemoPause` | exhibit `turing` (exists); a floating label "carried forward: ?" is an `after` beat with a `Type` prop |
| 4 No tape, an order you can feel | `DemoPause` twice (succ 2 with the redex click; ignore omega with the order toggle) | exhibit `lambda` (exists); two instances with different `preset` and `gate_steps` |
| 5 Two machines, one set of functions | `Reveal` | `two-machines` with the arrows effect; `SourceCards` kit for the 1936 card |
| 6 The wall has a door: do-notation | **new template `Equivalence`** (two code blocks, linked lines, a verifier tick: "are these the same? rfl") | do-notation unroller exhibit (script item 2, 3 d); `SourceCards` for Moggi and Wadler |
| 7 The compiler is a computer too | `Reveal` (terminal kit, three source cards, a climbing gauge to 128 then the error) | kits `Terminal` and `Gauge`; trait-solver stepper (script item 3, 3 d) |
| 8 Back to the hook | `Callback` (`of_scene = tape-less hook`: re-instances the editor with `(Shows, ...)`, resolves, the dial turns to 3) | `mkTuple` exhibit (script item 1, 4 d); `SourceCards` for Dowek |
| 9 Who pays for the inference | three instances: `Reveal` (the hover and the hash split), `DemoPause` (`merkle`, edit config, util, rename), `Reveal` (the three quote chips over the graph) | exhibit `merkle` (exists); hash-shipping exhibit (script item 5, optional); `SourceCards` |
| 10 Effects and where the picture breaks | **new template `EdgeCases`** (cards, each with a case and a one-line mini-demo; the site's edge-case rule makes this a standing pattern) | `Reveal` could carry it once, but every post has an edge-cases section, so it is a template |
| 11 The reveal and the close | `Outro` (the "when does it run" strip) then `Callback` (type the line back) | timeline exhibit (script item 4, 4 d) |

Result: 9 of the 11 scenes (1, 2, 3, 4, 5, 7, 8, 9, 11) are instances of the six existing templates (a scene of the script may be several instances: 4 and 9); 2 need a new template (6 `Equivalence`, 10 `EdgeCases`). Kits and effects to add to the library for this film, not templates: `CodeEditor`, `Terminal`, `Gauge`, `SourceCards`. Exhibits to build for it are the script's items 1 to 5, a separate lane per the museum (about 16 lane-days, unchanged by this design). Estimated authored film lines after the library exists: about 11 scenes at 12 lines plus the narration text plus about 12 header lines, near 150 to 190 lines for the whole video, against about 1,000 lines if every scene were hand-written as in 10.1.

### 15.8 Lane additions for the wave

Lane A (Opus) adds `world/scene/film/{vocab.flecs,lib/*.flecs,lib/templates/*.flecs}`, the `exhibits.index.flecs` generator in `scripts/magazine/film.ts`, and the lint rule "no relation or prefab outside the library vocabulary inside a film". Lane E writes `thoughts/models/film.flecs` as instances only (scenes 1, 2, 3), asserts in review that it contains no hand-written scene, and writes `thoughts/ifd/film.flecs` scene 1 as the second-film proof (`DemoPause` with `ex_ifd_graph`). Lane F adds the all-films golden run and a planted control: a template edited so one film's timing changes must fail that film's golden test. Spikes: F0 now also checks that a template prop can be an entity (`$ex` into `(Uses, $ex)`) and that a template body can name its own children in `(After, b_show)`; if props cannot be entities, the fallback is a string `ex` id resolved to `(Uses, e)` by the loader with the same fail-closed error, and the film file reads the same.


## 16. Built contract (2026-10-07)

What exists, as built; where it differs from the sections above, this section wins.

- **Engine.** `world/src/film/{model,timeline,pack,mod}.rs` and the `film_*` exports in `world/src/lib.rs`. State is a pure function of (definition, alignment, t): `film_pack(t)` returns the draw list (stride 8 floats, strings, a 64 float meta row) and is order independent (seek equals play, tested). `film_info` returns the scenes, says, gates, cmds and mounts JSON. Alpha rides in XD item flags bits 16..23 (0 = opaque).
- **Vendored patches** (marked "PATCH (site)" / `move_swap`): flecs.c zeroes and constructs typed template prop storage; flecs_ecs gets a `move` hook (`move_swap`) for Rust types, because the memcpy fallback double-freed `String` components.
- **Script traps.** A template is instantiated as a component (`Demo: {a: "..."}`); props need defaults; no prop named `name`; a template must not share a name with a Rust component; `\{` escapes a brace; an instance can only reference lines declared above it.
- **Host.** `src/lib/film/{abi,core,audio,film,source}.ts`. A film is a mode of the reader (`filmMode`): R leaves to the reader (`?read=1`), F returns, Esc closes (or closes the transcript), resume position in `localStorage` `film:<slug>`. The clock is the voice element's `currentTime` while it is playing; if the browser refuses `play()` (no gesture) the film runs on the wall clock. Gates stop the clock; Continue (or the hold running out) jumps to gate time plus hold, because the audio holds that silence.
- **Audio.** `static/film/<slug>/voice.<hash>.{opus,m4a}` plus `align.json` and `report.json`, committed, content hashed. Opus first, AAC fallback, both -16.2 LUFS. Pipeline: `scripts/film/say.ts` writes `say.json`, `scripts/film/narrate.py` synthesises and aligns (stable-ts); `--check` reports staleness.
- **Dev.** `scripts/film/vite-plugin.ts` hot-reloads `film.flecs` (`film:reload`). `scripts/film/engine.ts` runs the wasm under bun for tests (`FILM_WASM` overrides the path).
- **Tests.** `src/lib/film/film.test.ts`: transport and gates, seek equals play, golden timeline (`tests/golden/models.film.json`, `UPDATE_GOLDEN=1` regenerates), lint fixtures, caption sync against `align.json` with planted-bug controls.
- **Known gaps.** Stage items draw above mounted exhibits (no backing plate under a mount); some scenes overlap authored text with an exhibit's own text (cold open Lean panel); exhibit `models/two-machines` may log "cannot set value of Timeline"; glyph coverage in the UI font for a few symbols is unchecked; ears-only verification of the voice is still owed by Andrew.
