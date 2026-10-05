---
name: motion-explainer
description: Use when the user asks for a motion graphic, animated explainer, or explainer video of a pull request, or of how something works ("make a video explaining X"). Renders it with Kit Langton's psychopomp engine and publishes the MP4 privately to files.wovn.org.
metadata:
  platforms: [darwin]
  requires: "the psychopomp checkout at ~/.local/share/psychopomp (shipped by apps/psychopomp in the skills repo), ffmpeg, ImageMagick, uv, bun, gh, and the wovn CLI"
---

# Motion explainer

Make a 1080p60 motion graphic that explains one pull request or one mechanism,
in the style of Kit Langton's PR explainers (a dark stage of cards, wires,
packets, and a particle orb; the bug plays, rewinds, and replays fixed; it ends
on an annotated diff). Then publish it to Wovn.

## The engine

[Psychopomp](https://github.com/kitlangton/psychopomp) is Kit's Rust motion
graphics engine. A Ship clones it to `~/.local/share/psychopomp` at a pinned
commit and builds it (`apps/psychopomp` in the skills repo).

```sh
PP=~/.local/share/psychopomp
PSY=$PP/target/release/psychopomp
```

- If `$PSY` does not exist, tell the user to run `pnpm ship:machine` in the
  skills repo. Do not clone or build it yourself.
- The checkout is read-only. Do not edit, commit to, pull, or check out
  anything in it. If the engine cannot do something, work within it and tell the
  user what was missing.
- `$PSY` has no `--help`: an unknown argument renders a demo video to a file
  with that name. `$PSY plan` with no arguments prints the usage.

## Read Kit's guidance first

Kit's skills are the authoring manual. Read them before writing a scene, and
follow them except where the overrides below say otherwise:

- `$PP/.agents/skills/psychopomp/SKILL.md` and `STORY.md`: the workflow and how
  to tell the story.
- `$PP/.agents/skills/explainer-motion/SKILL.md` and `TECHNIQUES.md`: motion
  rules. Apply them to every beat.
- `$PP/SCENE_PLANS.md` (the "Make A Narrated Explainer Reel" section, and "Author
  With The Score DSL" under "Author With Typed Handles") and `$PP/CONTEXT.md`: the
  API and its terms.
- `$PP/scenes/pr-walkthrough/src/stop_stage.rs`: the #50042 film this style comes
  from. Copy its shape; do not start from a blank crate. It leans on helpers in
  the same crate (`Pr`, `span`, `header`, `code_with`, and `code_film` in
  `film.rs`; `PRS` and `diffs` in `lib.rs`), so copy those into your crate too.

## Overrides

| Kit's skill says | Do this instead |
| --- | --- |
| Author in `$PP/scenes/<name>`, add it to the workspace, `cargo run -p` | A standalone crate in `~/.local/share/psychopomp-scenes/<slug>` (step 3) |
| Add missing features to the engine | Work within the engine; report the gap |
| Commit the scene and engine changes | Commit nothing; publish to Wovn (step 7) |
| Narrate with Fish Audio, ElevenLabs, or `say` | ElevenLabs or `say` as in step 4; Fish Audio is not set up |

## Steps

1. **Establish the facts.**
   - Pull request: run `gh pr view <pr> --json number,title,body,url` and
     `gh pr diff <pr>` (add `-R owner/repo` outside its repo). Write one sentence
     each for the broken behavior, the fixed behavior, and the change.
   - Prompt: investigate the code it asks about until you can state the
     mechanism in three to five steps, each backed by a `file:line`.
   - Keep anything you could not verify out of the script.

2. **Storyboard one idea, 30 to 60 seconds.**
   - Pull request: before (the failure plays), rewind, after (the fix replays in
     the same space), then the change as an annotated diff.
   - Mechanism with no fix: setup, the mechanism step by step, the payoff, then
     the code that does it.
   - Slug: `<repo>-pr-<number>` or a kebab-case topic, such as
     `skills-pr-57` or `wovn-token-rotation`. It is also the crate name, so use
     only lowercase letters, digits, and hyphens, starting with a letter
     (`next.js` becomes `nextjs-pr-12`).

3. **Create the scene crate.**

   ```sh
   S=~/.local/share/psychopomp-scenes/<slug>
   mkdir -p "$S/src" && cp "$PP/Cargo.lock" "$S/"
   ```

   `$S/Cargo.toml`:

   ```toml
   [package]
   name = "<slug>"
   version = "0.1.0"
   edition = "2024"

   [workspace]

   [dependencies]
   anyhow = "1.0"
   psychopomp = { path = "../../psychopomp/crates/psychopomp" }
   serde_json = "1.0"
   ```

   The empty `[workspace]` keeps the crate out of Kit's workspace, and the copied
   lockfile keeps every dependency at the engine's version. Have `main.rs` write
   the reel to `$S/<slug>.reel.json` (build paths from
   `env!("CARGO_MANIFEST_DIR")`). Media paths in a plan resolve relative to the
   plan file, so keep `narration/` in `$S` next to it.

   Kit's sound effects (`sfx::*`) are named `../../assets/...`, which only
   resolves for a scene inside `$PP/scenes`. Re-root them before writing the
   reel, or `plan render` fails with an ffmpeg `No such file or directory` that
   names no file (`plan validate` and contact sheets do not catch it):

   ```rust
   let assets = root.join("../../psychopomp/assets").canonicalize()?;
   for segment in &mut reel.segments {
       for media in &mut segment.plan.media {
           if let Ok(relative) = media.path.strip_prefix("../../assets") {
               media.path = assets.join(relative);
           }
       }
   }
   ```

4. **Narrate.** Kit's films time every beat to a spoken word. Write
   `$S/narration/script.json` as his skill describes, then voice it with
   `cd "$PP"` first (narrate.ts writes the clips next to the script):
   - **ElevenLabs**, the default. The key is in the login keychain, copied
     from 1Password, so reading it never prompts. Kit's `narrate.ts` asks for
     192 kbps audio, which this ElevenLabs plan rejects
     (`HTTP 403: output_format_not_allowed`), so run a copy that asks for
     128 kbps:
     ```sh
     mkdir -p "$S/scripts"
     sed 's/mp3_44100_192/mp3_44100_128/' "$PP/scripts/narrate.ts" > "$S/scripts/narrate.ts"
     ELEVENLABS_API_KEY="$(security find-generic-password -s elevenlabs -a api-key -w)" \
       bun "$S/scripts/narrate.ts" "$S/narration/script.json"
     ```
     If the item is missing, ask the user to run
     `security add-generic-password -U -s elevenlabs -a api-key -w "$(op read 'op://Personal/ElevenLabs API Key/credential')"`
     (the same line updates it after a key rotation) rather than falling back
     to the draft voice. Unless the user names another voice, start the script
     with
     `"engine": "elevenlabs", "model": "eleven_v4", "voice": "Vep3bcB7LhKa3wfjMiI6", "settings": { "stability": 0.5, "similarity": 0.7 }`.
   - **Draft**, when the user asks for a quick draft or ElevenLabs is
     unavailable: `bun scripts/narrate.ts "$S/narration/script.json" --draft`.
     It speaks with macOS `say` (`SAY_VOICE`, default Samantha) and times words
     with a local Whisper through `uvx mlx-whisper` (the first run downloads the
     model). The draft voice is slower, so 60 to 75 seconds is fine. Tell the
     user the video uses the draft voice.
   - **No voice**, only when the user asks: time beats in seconds instead of
     phrases, as `$PP/scenes/hello` does.

   Anchors match Whisper's transcript, not the script: it writes numbers as
   digits ("58") and splits brand names ("Eleven Labs"). Check the
   `.words.json` files, or anchor with alternatives such as
   `.at_any(&["237", "two hundred"])`.

   Build the reel only once narration exists, and rebuild it after every
   narration or scene change, so its timings match the audio:

   ```sh
   cargo run --release --manifest-path "$S/Cargo.toml"
   $PSY plan validate "$S/<slug>.reel.json"
   ```

5. **Review before rendering.** Get segment spans from
   `$PSY plan inspect "$S/<slug>.reel.json"`, then make contact sheets at each
   segment's before, switch, after, and code beats:

   ```sh
   cd "$PP" && bun scripts/sheet.ts "$S/<slug>.reel.json" t1,t2,... --theme neutral --shutter --out "$S/output/sheet.jpg"
   ```

   `sheet.ts` rebuilds the engine and writes frames to `$PP/output`, which is
   gitignored; that is the one expected write inside the checkout. Read the
   sheet and fix, then rebuild and check again:
   - text that overlaps, clips, or reads against the wrong chip, such as packet
     labels on a vertical wire against an orb name placed above the orb (put
     the name below), or a callout that lands on the orb
   - file paths cut off in the editor tab
   - footers that finish typing just as a cut hides them
   - wires left showing after a rewind removes their card (reset the beam's
     `draw` to 0; do not fade it)

   A Zoom transition looks unfinished in a mid-zoom frame by design. Then
   render one segment
   (`$PSY plan render "$S/<slug>.reel.json" "$S/output/cue.mp4" --cue <scene-id> --theme neutral`;
   it includes the transition into the next segment) and pull frames with
   ffmpeg at the packet, impact, and halo beats, where the stage looks
   different from the still sheets.

6. **Render.**

   ```sh
   $PSY plan render "$S/<slug>.reel.json" "$S/output/<slug>.mp4" --theme neutral
   ```

   This takes about 4 seconds of render per second of video on an M5 Max. Done
   when `ffprobe` shows 1920x1080, 60 fps, AAC audio, and the duration that
   `plan inspect` reports, and
   `ffmpeg -i <mp4> -af ebur128=peak=true -f null -` shows loudness near
   -16 LUFS with peaks under -1 dBFS.

7. **Publish to Wovn**, privately, with a poster frame for links:

   ```sh
   $PSY plan frame "$S/<slug>.reel.json" <seconds> "$S/output/<slug>-poster.png" --theme neutral --shutter
   wovn put --at videos/<slug>.mp4 "$S/output/<slug>.mp4"
   wovn put --at videos/<slug>-poster.png "$S/output/<slug>-poster.png"
   ```

   Add `--force` when you re-render a slug that is already published; the
   files keep their current visibility, so one the user made public stays
   public. Use `--public` only when the user asks. GitHub plays only videos uploaded to its
   own CDN, so a public video goes into a PR as a link, with the poster as an
   image.

   Report the video URL, the poster URL, the local path, the length, and the
   narration engine.
