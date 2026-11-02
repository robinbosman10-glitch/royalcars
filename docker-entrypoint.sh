#!/bin/sh
set -eu
# Railway mounts a fresh volume as root, hiding ownership set during the build.
# Initialize its ownership before dropping privileges for the application process.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown -R node:node /data
  exec su-exec node "$@"
fi
exec "$@"
