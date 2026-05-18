You are a principal Unity gameplay/engine engineer and technical game design writer.
Your task is to produce a single, complete, self-contained PDF-ready build manual for this game so a solo developer can rebuild it from scratch in Unity with no other resources.

Output requirements:
1. Write in clear technical English.
2. Be exhaustive and implementation-level, not conceptual only.
3. Include exact Unity menu paths, project settings, code files, class names, methods, inspector values, input bindings, audio setup, rendering pipeline setup, build settings, and test checklists.
4. Include copy-paste-ready C# code snippets for all required scripts.
5. Include diagrams (ASCII or Mermaid) for architecture, data flow, and scene hierarchy.
6. Include platform-specific notes for WebGL, iOS, and Android.
7. Include a debugging section for common failure modes.
8. Include a final “Done Definition” checklist with pass/fail criteria.
9. Do not skip steps.
10. If an implementation detail is not explicit, make a best-practice assumption and label it “Assumption”.

Document title:
`LORENTZ BOOST - Complete Unity Rebuild Manual (Web + iOS + Android)`

Target game specification (must be implemented exactly):

Core concept:
- Multiplayer-ready (bots now, real multiplayer later) relativistic combat-racer/battle game.
- 1+1D spacetime gameplay mapped onto a compact “Minkowski sphere” presentation.
- Players move as spacetime rockets with worldlines; collision with worldlines is lethal.
- Pixel-art neon “Tron in space with relativity” style.

Gameplay rules:
- Arena uses wrapped spatial coordinate `x` and periodic temporal phase `t`.
- Player and bots continuously create past worldline traces.
- All worldlines are lethal, including your own (paradox risk), with short grace windows for specific actions.
- No lasers/weapons in current phase.
- Main combat = kills by intersecting opponent trails/worldlines.
- Time reversal action flips temporal direction (`+t` <-> `-t`) and should not instantly trigger unfair self-death.
- Defeating opponents grants fleet growth (abstract capture token, no ownership linkage to defeated entity after respawn).
- Fleet affects visuals (triangular formation behind lead) and gameplay (larger effective hitbox / survivability model).
- Fleet loss is consumed before full death; respawn only when all fleet is exhausted.
- Respawn has cooldown; player returns after cooldown.
- Energy events and dead-worldline remnants are collectible and increase resources.
- Collectibles increase fuel/boost budget, speed, and worldline extension potential.
- Leaderboard shows kills/deaths/fleet context.

Input and controls:
- Desktop:
  - Mouse movement: move right => steer right, move left => steer left (never inverted).
  - Left click: time reversal pulse.
  - Keyboard fallback: `A/D` and `Left/Right` steer.
  - `Space` time reversal pulse.
  - Zoom: `W/S`, `Up/Down`, and mouse wheel (`wheel up` zoom in, `wheel down` zoom out).
  - `P` pause.
- Mobile:
  - Steering by device tilt only (continuous while tilted, stop when device straight).
  - No inverted steering.
  - Tap screen triggers time reversal pulse.
  - Pinch zoom in/out.
  - Mobile pause button.
- Ship/fleet visuals must always face true movement direction (never mirrored).

Camera/zoom behavior:
- Zoom out minimum must show the whole sphere cleanly.
- Zoom in maximum must feel locally Euclidean/flat.
- Zoom transitions must be stable and non-glitchy.
- Pixel-art should remain polished at all zoom levels (avoid extreme chunky artifacts by adaptive rendering strategy).

Rendering and style:
- Retro pixel-art presentation.
- Neon spacetime grid/light-cone aesthetic.
- Doppler redshift/blueshift color behavior.
- Length contraction and time-dilation visual layers (toggleable debug options).
- Minimap as a sphere projection, readable on mobile and desktop.
- UI responsive in desktop + mobile portrait + mobile landscape.
- Game aspect should remain stable (no distortion stretching).

Audio:
- Background retro-space track.
- Thruster audio for player and opponents.
- Doppler-shifted thruster perception that sounds good (not harsh).
- Ship gain and ship loss SFX cues.
- Volume control channels (master/music/thrusters) where relevant.

Bot behavior:
- Bots should use same core movement/collision rules as players.
- Same worldline lethality model.
- Same collectible interaction model.
- Respawn and fleet behavior consistent with player rules.

Technical architecture required in manual:
- Unity version recommendation and package list.
- URP vs Built-in decision and exact setup.
- Scene graph and prefab architecture.
- Script architecture:
  - Game bootstrap / world state
  - Entity model (player, bot, fleet state)
  - Relativistic motion integrator
  - Worldline/trail system
  - Collision resolver (including self-trail grace windows)
  - Time reversal system
  - Event spawning/collection system
  - Camera + zoom controller
  - Input abstraction layer (desktop/mobile unified)
  - Audio manager with Doppler treatment
  - UI/HUD/leaderboard/minimap controllers
  - Bot AI controller
- Data-oriented structures for performance.
- Object pooling strategy for trails/events/effects.
- Determinism and fixed timestep recommendations.
- Mobile performance budgets and profiling workflow.

Math section (must include equations and implementation notes):
- Coordinate wrapping for `x`.
- Temporal phase wrapping and seam handling.
- Mapping from wrapped spacetime coordinates to sphere surface for rendering/minimap.
- Movement integration with relativistic speed cap (`beta`, `gamma` references).
- Doppler shift mapping to visuals/audio.
- Time reversal transform logic and safeguards.
- Collision distance checks between moving segments in spacetime.

Networking readiness (future multiplayer):
- Even though multiplayer is not implemented now, include a chapter that prepares architecture for authoritative multiplayer.
- Define what state should be server-authoritative.
- Define client prediction/reconciliation boundaries.
- Explain which current systems must become deterministic or replicated.

Build/deploy section:
- WebGL build configuration.
- iOS build configuration.
- Android build configuration.
- Input permissions (motion sensors) and platform caveats.
- Asset compression and memory tuning by platform.
- QA checklist per platform.

Testing section:
- Unit tests for math helpers.
- Playmode tests for collisions, respawn, fleet accounting, and time reversal.
- Manual test scripts for:
  - steering direction correctness
  - non-inverted controls
  - zoom limits
  - mobile tilt behavior
  - time reversal fairness
  - fleet gain/loss accounting
  - respawn cooldown correctness
  - UI responsiveness in all orientations

Acceptance criteria (must include):
- Steering is never inverted on any platform.
- Ship always visually faces movement direction.
- Mobile tilt continuously steers while device remains tilted.
- Tapping on mobile triggers reversal without input glitches.
- Zoom-out shows full sphere; zoom-in provides local flat-like view.
- Pixel-art remains visually polished across zoom range.
- Fleet count logic is consistent with kills/deaths and loss absorption.
- Respawn only occurs after full fleet depletion and respects cooldown.

Required format of your output:
1. Executive summary.
2. Prerequisites.
3. Full implementation chapters (ordered build path).
4. Complete script listings by file path.
5. Inspector/setup tables.
6. Debugging and troubleshooting.
7. Platform build playbooks.
8. Final validation checklist.

Important writing rule:
- This manual must be enough for a competent developer to rebuild the game end-to-end without searching external docs.
