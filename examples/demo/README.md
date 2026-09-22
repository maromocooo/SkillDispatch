# Offline mock demo

From a built checkout (or the installed package directory):

```sh
node examples/demo/run.mjs
```

Four original synthetic skills, three fixed recommendations. The script runs the
real CLI in a temporary project with an isolated user config and no API key. It
cleans up only its temporary directory. It does not register host hooks or change
your skills. Fixed mock probabilities are not a Jev quality measurement.
