# lorentz-boost

`lorentz-boost` is a 1+1D spacetime arena prototype inspired by Slither-like risk loops, built as a stepping stone toward a Unity multi-platform game (mobile/web/desktop).

## Core Loop

- You steer a rocket worldline in compactified 1+1D spacetime.
- Every worldline segment is lethal, including your own past trace (paradox kill).
- Tail-killing an opponent rescues/converts that rocket into your fleet (team).
- Spacetime events and dead-worldline drops extend your trace lifetime.
- Space flips your time direction (`+t` <-> `-t`) for aggressive reversals and traps.

## Current Ruleset

- 16 players total (1 player + 15 bots)
- Minkowski-sphere style wrap/phase mapping
- No gravity wells (removed for cleaner motion and readability)
- Doppler-shifted rocket audio + CC0 retro-space background music
- In-game audio sliders for master/music/thruster mix
- Relativistic visual treatment

## Controls

- `A` / `D`: Lorentz steering
- `Left` / `Right`: alternate steering keys
- `Space`: time-direction flip
- `P`: pause/resume
- `T`: cycle team colors/flag

## Tech

- React + Vite
- Pure JS gameplay simulation/render pipeline

## Run

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```
