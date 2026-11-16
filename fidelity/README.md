# Fidelity harness

Replays the human-input recorder page (`record_human_input.html` from the
Camoufox repo) with myuri driving Firefox, so its events can be compared with
recordings of people doing the same tasks.

    xvfb-run -a -s "-screen 0 1400x1100x24" node fidelity/replay.mjs RECORDER.html OUT_DIR --firefox FIREFOX
    python3 fidelity/compare.py HUMAN_DIR [HUMAN_DIR ...] OUT_DIR

Recordings of people are private and are not kept in this repo. Timing is
sensitive to machine load: run on an idle machine.
