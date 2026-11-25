#!/usr/bin/env bash

# As PID 1 bash ignores SIGTERM unless it traps it; without this a pod waiting for MongoDB cannot be stopped
trap 'exit 0' TERM INT

# The server waits for MongoDB by itself, with the retries that `mongo.*` sets
exec node --max-http-header-size=16384 dist/main
