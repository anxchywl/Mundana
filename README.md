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

## Play a song

Mundana can also play a song. Press the music note button next to the round button (bottom left on a phone) and
choose a MIDI file. Fractals play every part of it: each note is a point whose orbit loops at that pitch, and you see
every orbit as it sounds, in blue. The drums are sounds rather than notes: a kick is an orbit that flies away (a click,
drawn in red), a snare or a hat is a point whose orbit never repeats, brighter for a hat. Play, pause, seek and stop
from the bar at the bottom. Pressing the picture, switching fractal or hiding the tab pauses the song; press play to
carry on where it stopped.

The panel lists every track of the file with the part it plays (melody, bass, chords or drums), and you can change
it. Below that you choose how many voices play at once, and for each part its fractal, the loop length it prefers
(its period) and whether it plays at all. By default the melody and the chords play on the Mandelbrot set, the bass on
the Multibrot, and the drums on the fractal on screen. The file is read in your browser and never leaves your device.

Fractals: by default the whole song plays on one fractal. You can also give each section of the song its own
fractal, from a list you can change (it starts with the Mandelbrot set, the Multibrot, the Burning ship, the
logistic set and the inverted Mandelbrot set), or change fractal every few bars, 4 to 32. Mundana finds the sections
itself: where the time signature or the tempo changes, and where the notes and how busy they are change, in sections
of at least 8 bars; a section that comes back gets the same letter. The picture morphs from one fractal into the next
and lands on the first beat of the bar. With a list, every part plays on the fractal on screen. The camera follows
the music phrase by phrase: it frames the notes that are sounding, holds each framing for at least a second and a
half, and glides to the next. With reduced motion turned on in your system, it cuts instead of gliding or morphing.

Voices: the melody always has one to itself. The bass, the chords and the drums share the others, 3 by default and up
to 5. When a chord needs more voices than are free, it keeps its lowest note, then its top note, its third and its
seventh; a note that loses its voice to a newer one comes back when a voice is free again. The panel says how many
notes were left out.

Limits: MIDI files up to 4 MB, songs up to 10 minutes and 20,000 notes, at most 6 voices (4 by default), at most 16
sections. Notes shorter than 40 ms are joined to the next or dropped, and notes too high or too low move by whole
octaves; the panel says how many. If the picture cannot keep up, it draws with less detail for a while; the sound
is never touched.

To see how smoothly a song plays on your device, add `#debug=1` to the address. A line at the top then shows the
frames a second, the slowest frame times, the picture's detail, and how far the picture is from the sound, in
milliseconds.

## What's inside

- **24 fractals in four families:** the Mandelbrot set and its cousins, the burning ship family, chaotic maps from
  physics, and strange attractors
- **Smooth morphing** between fractals: every frame of the change is a real fractal in between
- **Julia sets**, three colour styles, and a pitch control
- **Save the sound** as a WAV file, **save the picture**, or **copy a link** that opens the exact same view and point
- **Play a song** from a MIDI file, melody, chords, bass and drums, on up to six voices at once, with a camera that
  follows the music and a new fractal for each section if you like
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

The small MIDI files the tests read are written by `node tools/make-midi-fixtures.mjs`.

## How it works

Everything happens in your browser, in plain JavaScript with no libraries.

| File | What it does |
|---|---|
| [`src/fractals.js`](src/fractals.js) | Every fractal's formula, written twice: once for the sound and once for the picture |
| [`src/renderer.js`](src/renderer.js) | Draws the picture on your graphics card with WebGL2 |
| [`src/voice.js`](src/voice.js) | The instrument: steps the orbit 4,400 times a second and draws a smooth curve through it, and the master path the voices are mixed through |
| [`src/synth-worklet.js`](src/synth-worklet.js) | Runs up to six voices on the browser's audio thread, each note starting on its exact sample |
| [`src/main.js`](src/main.js) | Everything you touch: zoom, gallery, random, saving and links |
| [`src/spots.js`](src/spots.js) | Points known to sound good, found by [`tools/find-spots.mjs`](tools/find-spots.mjs) |
| [`src/cantus/points.js`](src/cantus/points.js) | Loads the point library: stable points for every note of every fractal, built by [`tools/build-points.mjs`](tools/build-points.mjs) |
| [`src/cantus/midi.js`](src/cantus/midi.js) | Reads MIDI files: notes, tempo, time signatures, and which track plays which part |
| [`src/cantus/timeline.js`](src/cantus/timeline.js) | The song as notes in time, with its checks and limits, and the sections it falls into |
| [`src/cantus/mapper.js`](src/cantus/mapper.js) | Gives every note a point and a speed that play it, and a voice to play it on; picks the drum sounds; plans which fractal is on screen, the morphs and the camera |
| [`src/cantus/scheduler.js`](src/cantus/scheduler.js) | Sends each note to the audio thread just ahead of time, on the audio clock: play, pause, seek, loop |
| [`src/cantus/show.js`](src/cantus/show.js) | The song panel, the play bar, and the picture during a song, which keeps time with the sound |

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
