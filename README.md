# flappy-bird-and-angry-birds
<<<<<<< HEAD
mashup of flappy bird and angry birds

Open `index.html` in a browser. Flap with Space/click/tap; use your bird's ability with X/Shift/right-click or the on-screen button.
You start with Red and unlock the next bird every 15 pipes (based on your best score): Red, Chuck, Blues, Bomb, Matilda, Terence, Silver.
=======

A mashup of Flappy Bird and Angry Birds. Fling a bird from the slingshot, then **flap in mid-air** to
thread it through Flappy-style pipes and pop every pig. Touch a pipe and the bird drops out of the sky.

## Play

No build step and no dependencies. Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000   # then visit http://localhost:8000
```

### Controls

| Action | Mouse / touch | Keyboard |
| --- | --- | --- |
| Aim and launch | Drag the bird back, release | |
| Flap (5 per bird) | Click / tap | `Space`, `Up`, `W` |
| Continue / retry | Click / tap | `Space`, `Enter` |
| Restart level | | `R` |

Each pig is worth 1000 points and every unused bird at the end of a level adds 500.

## Project layout

- `index.html`: page and canvas
- `src/core.js`: physics and rules (no DOM, also runs in Node)
- `src/levels.js`: level data (pipes, pigs, bird count)
- `src/game.js`: rendering, input and the game loop
- `tools/check-levels.js`: brute-force solver proving every level can be cleared

## Adding a level

Add an entry to `src/levels.js`, then run `node tools/check-levels.js`. It searches launch angles, power and
flap timings and fails if a pig is unreachable or the level needs more birds than it grants.
>>>>>>> origin/main
