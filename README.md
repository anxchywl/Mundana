# Mundana

**Hear what fractals sound like.** Press any point of a fractal and listen to it.

**[Open Mundana](https://mundana.anxchywl.dev/)** It runs in your browser, nothing to install. Headphones help.

## What it is

A fractal is drawn by taking every point on the screen and feeding it into a formula, again and again. Each point
traces a path as it goes, called its *orbit*. Mundana turns that path into sound: its sideways motion goes to your
left speaker, its up-and-down motion to your right.

What you hear depends on where you press:

- **A steady note** when the orbit settles into a loop. Each bulb of the Mandelbrot set is a different loop, so each
  one is a different note.
- **Noise, buzz or growl** when the orbit never repeats.
- **A single click** when the orbit flies away. Its path turns red.

The name comes from *musica mundana*, the music of the world: the old belief that the planets make music as they
move along their orbits, music no one can hear. Here you can.

## How to use it

1. **Press and hold** anywhere on the picture. Drag to glide from sound to sound.
2. **Zoom in** with the scroll wheel or a pinch. The most interesting sounds live near the edges.
3. **Try another fractal** from the gallery, or press the round button in the middle to land somewhere random.

On a computer you can also use the keyboard: `G` gallery, `X` random, `J` Julia set, `C` colours, `W` save the sound,
`R` reset the view.

## What's inside

- **24 fractals in four families:** the Mandelbrot set and its cousins, the burning ship family, chaotic maps from
  physics, and strange attractors
- **Smooth morphing** between fractals: every frame of the change is a real fractal in between
- **Julia sets**, three colour styles, and a pitch control
- **Save the sound** as a WAV file, **save the picture**, or **copy a link** that opens the exact same view and point
- **Works on phones:** one finger plays, two fingers move and zoom

## Run it yourself

There is nothing to build and nothing to install. You only need a recent browser and any way to serve the folder over
http, for example:

```bash
git clone https://github.com/anxchywl/Mundana.git
cd Mundana
python3 -m http.server 5178
```

Then open http://localhost:5178. Opening `index.html` directly as a file will not work, because browsers only allow
the audio engine on pages served over http or https.

The tests need Node 22 or newer and nothing else:

```bash
node --test tests/*.test.mjs
```

## How it works

Everything happens in your browser, in plain JavaScript with no libraries.

| File | What it does |
|---|---|
| [`src/fractals.js`](src/fractals.js) | Every fractal's formula, written twice: once for the sound and once for the picture |
| [`src/renderer.js`](src/renderer.js) | Draws the picture on your graphics card with WebGL2 |
| [`src/voice.js`](src/voice.js) | The instrument: steps the orbit 4,400 times a second and draws a smooth curve through it |
| [`src/synth-worklet.js`](src/synth-worklet.js) | Runs the instrument on the browser's audio thread |
| [`src/main.js`](src/main.js) | Everything you touch: zoom, gallery, random, saving and links |
| [`src/spots.js`](src/spots.js) | Points known to sound good, found by [`tools/find-spots.mjs`](tools/find-spots.mjs) |
| [`src/cantus/points.js`](src/cantus/points.js) | Loads the point library: stable points for every note of every fractal, built by [`tools/build-points.mjs`](tools/build-points.mjs) |

Want to add a fractal? Add it to `src/fractals.js` with both formulas, then run `node tools/find-spots.mjs` and copy
its spots into `src/spots.js`. After any change to a formula or to `src/voice.js`, run `node tools/build-points.mjs`
to rebuild the point library; the tests say when it is out of date.

## Privacy and safety

- **No accounts, no tracking, no server.** Nothing you do leaves your device, apart from loading the fonts.
- **Shared links are checked** before use, and the page only runs its own scripts.
- **It recovers by itself** if your graphics card resets, and heavy fractals are capped so slow devices keep up.

Found a way to break it? Please [open an issue](https://github.com/anxchywl/Mundana/issues).

## Limits

- **Zoom stops at about 1/50,000** of the starting view, because browsers draw in single precision.
- **Older or weak devices** may draw the heavier fractals slowly.
- **Phones in silent mode** may mute the sound.
