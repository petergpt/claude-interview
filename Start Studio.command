#!/bin/sh
# Double-click on macOS: start the backend and open the browser room.
cd -- "$(dirname -- "$0")" && ./interview up && open "http://127.0.0.1:${INTERVIEW_PORT:-4747}"
